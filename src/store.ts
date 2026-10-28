import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AccessGroup,
  AccessRemovals,
  AppRequestIntent,
  AppRequestRecord,
  AppRequestStatus,
  AppSafetyTombstone,
  AppWithdrawal,
  GrantRecord,
  GrantState,
  LibraryCatalogItem,
  LibraryJoin,
  RevokeResult,
  SeerrWebhook,
  SyncStatus,
} from './types.js';

/**
 * The most households (groups) the household app supports. With the app enabled, creating another is refused; the app
 * keeps one cache partition and one TMDB queue per household, sized for this many (see docs/app-design.md, "Shared
 * upstreams"). With the app off there is no limit, as before 2.3.0.
 */
export const MAX_HOUSEHOLDS = 100;
/**
 * Settled household app "Get this" records (completed, declined, deleted or failed) are kept for this long after they
 * were made (see GrantStore.writeAppRequests); pending records are never pruned.
 */
export const APP_REQUEST_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
/** The most settled "Get this" records kept per household; its own oldest are pruned first. Pending ones are never. */
export const MAX_APP_REQUESTS_PER_HOUSEHOLD = 2000;
/** The most deferred webhooks remembered (see GrantStore.deferWebhook); beyond it the oldest are left to the backfill. */
export const MAX_DEFERRED_REQUESTS = 1000;

const EMPTY_STATE: GrantState = { version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], handledRequestIds: [] };

export class GrantStore {
  readonly #file: string;
  #state: GrantState = structuredClone(EMPTY_STATE);
  /** The latest state-file write, started or queued; writes never overlap. */
  #writing: Promise<void> = Promise.resolve();
  /** A queued write that has not started yet; saves requested meanwhile share it. */
  #queued: Promise<void> | undefined;
  #closed = false;
  /**
   * The request intents the state file on disk holds: those it was loaded with, then those of the last completed write.
   * See isAppRequestIntentDurable.
   */
  #durableIntents = new Set<string>();
  /** "Get this" record IDs by household, rebuilt after each change (see #appIndex). */
  #appIndexCache: Map<string, string[]> | undefined;
  readonly #limitHouseholds: boolean;

  /** `limitHouseholds` (set when the household app is enabled) refuses new groups beyond {@link MAX_HOUSEHOLDS}. */
  public constructor(file: string, options: { limitHouseholds?: boolean } = {}) {
    this.#file = file;
    this.#limitHouseholds = options.limitHouseholds ?? false;
  }

  /** True once close() was called; every later change is refused. */
  public get closed(): boolean {
    return this.#closed;
  }

  public async load(): Promise<void> {
    this.#assertOpen();
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#assertOpen();
      await this.#save();
      return;
    }
    // close() may have been called while the file was being read; state must not change after it.
    this.#assertOpen();
    const migrated = migrateState(JSON.parse(text) as unknown);
    this.#state = migrated.state;
    this.#durableIntents = new Set(Object.keys(this.#state.appRequestIntents ?? {}));
    // Written only by unreleased builds of "Get this" that counted quotas; dropped with the next write.
    delete (this.#state as { appQuotaLedger?: unknown }).appQuotaLedger;
    this.#appIndexCache = undefined;
    const lifted = liftRemovals(this.#state);
    // Requests already on grants (including ones recorded before handledRequestIds existed)
    // count as handled, so the backfill never re-imports one an administrator later removed.
    const handled = new Set(this.#state.handledRequestIds ?? []);
    const before = handled.size;
    for (const grant of Object.values(this.#state.grants)) Object.keys(grant.requests).forEach((id) => handled.add(id));
    const seeded = this.#state.handledRequestIds === undefined || handled.size !== before;
    if (seeded) this.#state.handledRequestIds = [...handled];
    if (migrated.changed || lifted || seeded) await this.#save();
    if (this.#limitHouseholds && this.countGroups() > MAX_HOUSEHOLDS) {
      console.warn(JSON.stringify({
        level: 'warn',
        message: `the household app supports at most ${MAX_HOUSEHOLDS} households; no new group can be created until there are fewer, and the app caches nothing while there are more`,
        groups: this.countGroups(),
      }));
    }
  }

  public list(): GrantRecord[] {
    return Object.values(this.#state.grants).map(clone);
  }

  public get(itemId: string): GrantRecord | undefined {
    const grant = this.#state.grants[normalizeId(itemId)];
    return grant ? clone(grant) : undefined;
  }

  public listGroups(): AccessGroup[] {
    return Object.values(this.#state.groups).map(clone);
  }

  public countGroups(): number {
    return Object.keys(this.#state.groups).length;
  }

  public getGroup(groupId: string): AccessGroup | undefined {
    const group = this.#state.groups[normalizeId(groupId)];
    return group ? clone(group) : undefined;
  }

  public listPasswordlessUserIds(): string[] {
    return [...this.#state.passwordlessUserIds];
  }

  public async setUserPasswordless(userIdInput: string, passwordless: boolean): Promise<string[]> {
    this.#assertOpen();
    const userId = normalizeId(userIdInput);
    const current = new Set(this.#state.passwordlessUserIds);
    if (passwordless) current.add(userId);
    else current.delete(userId);
    this.#state.passwordlessUserIds = [...current].sort();
    await this.#save();
    return [...this.#state.passwordlessUserIds];
  }

  public getCatalog(): { lastSyncedAt?: string; items: LibraryCatalogItem[] } {
    return {
      ...(this.#state.catalog.lastSyncedAt ? { lastSyncedAt: this.#state.catalog.lastSyncedAt } : {}),
      items: Object.values(this.#state.catalog.items).map(clone),
    };
  }

  public async replaceCatalog(items: LibraryCatalogItem[]): Promise<{ lastSyncedAt: string; items: LibraryCatalogItem[] }> {
    this.#assertOpen();
    const lastSyncedAt = new Date().toISOString();
    this.#state.catalog = {
      lastSyncedAt,
      items: Object.fromEntries(items.map((item) => [normalizeId(item.id), clone(item)])),
    };
    await this.#save();
    return { lastSyncedAt, items: items.map(clone) };
  }

  /**
   * The users a grant gives access to: each request's requester (except a requester who withdrew the request, see
   * AppWithdrawal), its manual users and the members of its groups.
   */
  public resolveOwners(grant: Pick<GrantRecord, 'requests' | 'manualUserIds' | 'groupIds'>): string[] {
    const withdrawals = this.#state.appWithdrawals ?? {};
    const requesters = Object.entries(grant.requests).filter(([requestId]) => !withdrawals[requestId]?.requester).map(([, userId]) => userId);
    const groupUsers = grant.groupIds.flatMap((id) => this.#state.groups[id]?.userIds ?? []);
    return [...new Set([...requesters, ...grant.manualUserIds, ...groupUsers].map(normalizeId))].sort();
  }

  public listGroupIdsForUser(userIdInput: string): string[] {
    const userId = normalizeId(userIdInput);
    return Object.values(this.#state.groups)
      .filter((group) => group.userIds.includes(userId))
      .map((group) => group.id)
      .sort();
  }

  public hasHandledRequest(requestId: string): boolean {
    return (this.#state.handledRequestIds ?? []).includes(requestId);
  }

  /** Whether an administrator revoked the request from that item (see GrantState.revokedRequests). */
  public isRequestRevoked(requestId: string, itemId: string): boolean {
    return this.#state.revokedRequests?.[requestId]?.includes(normalizeId(itemId)) ?? false;
  }

  /** Whether an administrator removed the user or group from that item (see GrantState.removedAccess). */
  public isAccessRemoved(itemId: string, kind: keyof AccessRemovals, id: string): boolean {
    return this.#state.removedAccess?.[normalizeId(itemId)]?.[kind]?.includes(normalizeId(id)) ?? false;
  }

  /** The users and groups an administrator removed from that item (see GrantState.removedAccess). */
  public getRemovals(itemId: string): AccessRemovals {
    return clone(this.#state.removedAccess?.[normalizeId(itemId)] ?? {});
  }

  /** The grant that currently records a request, if any. */
  public findGrantForRequest(requestId: string): GrantRecord | undefined {
    const grant = Object.values(this.#state.grants).find((entry) => requestId in entry.requests);
    return grant ? clone(grant) : undefined;
  }

  /**
   * Adds a request to an item's grant. `groupIds` (the requester's households) are merged
   * into the grant's existing groups; groups and manual users already on the grant are kept.
   * A request an administrator revoked from the item is never recorded on it again (see
   * GrantState.revokedRequests); it still counts as handled. A new request is a new grant
   * decision, so it adds its requester's households even if an administrator removed them
   * earlier; replays of handled requests never reach here (see processWebhook).
   */
  public async grant(input: {
    itemId: string;
    mediaType?: string;
    requestId: string;
    userId: string;
    groupIds?: string[];
  }): Promise<GrantRecord> {
    this.#assertOpen();
    const itemId = normalizeId(input.itemId);
    const userId = normalizeId(input.userId);
    const previous = this.#state.grants[itemId];
    const requests = this.isRequestRevoked(input.requestId, itemId)
      ? { ...(previous?.requests ?? {}) }
      : { ...(previous?.requests ?? {}), [input.requestId]: userId };
    const manualUserIds = previous?.manualUserIds ?? [];
    const requesterGroupIds = (input.groupIds ?? []).map(normalizeId).filter((id) => this.#state.groups[id]);
    const groupIds = [...new Set([...(previous?.groupIds ?? []), ...requesterGroupIds])].sort();
    const next = this.#makeGrant(itemId, requests, manualUserIds, groupIds, previous, input.mediaType);
    this.#state.grants[itemId] = next;
    this.#state.handledRequestIds = [...new Set([...(this.#state.handledRequestIds ?? []), input.requestId])];
    const withdrawal = this.#state.appWithdrawals?.[input.requestId];
    if (withdrawal) withdrawal.grantedAt ??= new Date().toISOString();
    this.#pruneWithdrawals();
    await this.#save();
    return clone(next);
  }

  public async revokeRequest(itemIdInput: string, requestId: string): Promise<RevokeResult | undefined> {
    this.#assertOpen();
    const result = this.#revokeRequest(itemIdInput, requestId);
    if (!result) return result;
    this.#pruneWithdrawals();
    await this.#save();
    return result;
  }

  /** What revokeRequest would store, without storing anything (see #preview). */
  public previewRevokeRequest(itemIdInput: string, requestId: string): RevokeResult | undefined {
    return this.#preview(() => this.#revokeRequest(itemIdInput, requestId));
  }

  #revokeRequest(itemIdInput: string, requestId: string): RevokeResult | undefined {
    const itemId = normalizeId(itemIdInput);
    const previous = this.#state.grants[itemId];
    if (!previous || !(requestId in previous.requests)) return undefined;
    const requests = { ...previous.requests };
    const requester = requests[requestId] as string;
    delete requests[requestId];
    const result = this.#replaceGrant(previous, requests, previous.manualUserIds, previous.groupIds);
    // Only this item: a copy of the request on another grant (a move's source or target) keeps its own access.
    const revokedFrom = this.#state.revokedRequests?.[requestId] ?? [];
    this.#state.revokedRequests = { ...this.#state.revokedRequests, [requestId]: [...new Set([...revokedFrom, itemId])].sort() };
    // Revoking a user's request removes that user's access; a household join must not quietly restore it.
    if (!Object.values(requests).includes(requester) && !previous.manualUserIds.includes(requester)) {
      const removals = this.#state.removedAccess?.[itemId] ?? {};
      this.#setRemovals(itemId, { ...removals, userIds: [...(removals.userIds ?? []), requester] });
    }
    return result;
  }

  public async setGrantGroups(itemIdInput: string, groupIdsInput: string[]): Promise<RevokeResult> {
    this.#assertOpen();
    const result = this.#setGrantGroups(itemIdInput, groupIdsInput);
    await this.#save();
    return result;
  }

  /** What setGrantGroups would store, without storing anything (see #preview). */
  public previewGrantGroups(itemIdInput: string, groupIdsInput: string[]): RevokeResult {
    return this.#preview(() => this.#setGrantGroups(itemIdInput, groupIdsInput));
  }

  #setGrantGroups(itemIdInput: string, groupIdsInput: string[]): RevokeResult {
    const itemId = normalizeId(itemIdInput);
    const previous = this.#state.grants[itemId];
    if (!previous) throw new Error(`grant not found: ${itemId}`);
    const groupIds = [...new Set(groupIdsInput.map(normalizeId))].sort();
    const missing = groupIds.filter((id) => !this.#state.groups[id]);
    if (missing.length > 0) throw new Error(`group not found: ${missing.join(', ')}`);
    const result = this.#replaceGrant(previous, previous.requests, previous.manualUserIds, groupIds);
    this.#recordAdministratorChange(itemId, previous, previous.manualUserIds, groupIds);
    return result;
  }

  public async setManualAccess(input: {
    itemId: string;
    mediaType?: string;
    userIds: string[];
    groupIds: string[];
  }): Promise<{ previous?: GrantRecord; current: GrantRecord }> {
    return (await this.setManualAccessBatch([input]))[0] as { previous?: GrantRecord; current: GrantRecord };
  }

  public async setManualAccessBatch(inputs: Array<{
    itemId: string;
    mediaType?: string;
    userIds: string[];
    groupIds: string[];
  }>): Promise<Array<{ previous?: GrantRecord; current: GrantRecord }>> {
    this.#assertOpen();
    const results = this.#atomically(() => this.#setManualAccessBatch(inputs));
    await this.#save();
    return results;
  }

  /** What setManualAccessBatch would store, without storing anything (see #preview). */
  public previewManualAccessBatch(inputs: Array<{
    itemId: string;
    mediaType?: string;
    userIds: string[];
    groupIds: string[];
  }>): Array<{ previous?: GrantRecord; current: GrantRecord }> {
    return this.#preview(() => this.#setManualAccessBatch(inputs));
  }

  #setManualAccessBatch(inputs: Array<{
    itemId: string;
    mediaType?: string;
    userIds: string[];
    groupIds: string[];
  }>): Array<{ previous?: GrantRecord; current: GrantRecord }> {
    const results: Array<{ previous?: GrantRecord; current: GrantRecord }> = [];
    for (const input of inputs) {
      const itemId = normalizeId(input.itemId);
      const previous = this.#state.grants[itemId];
      const manualUserIds = [...new Set(input.userIds.map(normalizeId))].sort();
      const groupIds = [...new Set(input.groupIds.map(normalizeId))].sort();
      const missing = groupIds.filter((id) => !this.#state.groups[id]);
      if (missing.length > 0) throw new Error(`group not found: ${missing.join(', ')}`);
      const current = this.#makeGrant(itemId, previous?.requests ?? {}, manualUserIds, groupIds, previous, input.mediaType);
      this.#state.grants[itemId] = current;
      this.#recordAdministratorChange(itemId, previous, manualUserIds, groupIds);
      results.push({ ...(previous ? { previous: clone(previous) } : {}), current: clone(current) });
    }
    return results;
  }

  public async upsertGroup(input: { id: string; name: string; userIds: string[] }): Promise<AccessGroup> {
    this.#assertOpen();
    const id = normalizeId(input.id);
    const now = new Date().toISOString();
    const previous = this.#state.groups[id];
    if (this.#limitHouseholds && !previous && this.countGroups() >= MAX_HOUSEHOLDS) throw new Error(`groups must be at most ${MAX_HOUSEHOLDS}`);
    const group: AccessGroup = {
      id,
      name: input.name.trim(),
      userIds: [...new Set(input.userIds.map(normalizeId))].sort(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.#state.groups[id] = group;
    for (const grant of Object.values(this.#state.grants)) {
      if (grant.groupIds.includes(id)) {
        grant.owners = this.resolveOwners(grant);
        grant.updatedAt = now;
        grant.sync = pendingSync(grant.sync);
      }
    }
    await this.#save();
    return clone(group);
  }

  public async deleteGroup(groupIdInput: string): Promise<RevokeResult[]> {
    this.#assertOpen();
    const groupId = normalizeId(groupIdInput);
    if (!this.#state.groups[groupId]) return [];
    delete this.#state.groups[groupId];
    // A group created later under the same ID is a different household, with a new epoch.
    const { [groupId]: _, ...epochs } = this.#state.householdEpochs ?? {};
    if (Object.keys(epochs).length > 0) this.#state.householdEpochs = epochs;
    else delete this.#state.householdEpochs;
    this.#appIndexCache = undefined;
    // A group created later under the same ID is a different household and starts unmarked.
    for (const [itemId, removals] of Object.entries(this.#state.removedAccess ?? {})) {
      if (removals.groupIds?.includes(groupId)) this.#setRemovals(itemId, { ...removals, groupIds: removals.groupIds.filter((id) => id !== groupId) });
    }
    // Its "Get this" records are kept (a request's grant still follows its record), but no household sees or joins them again.
    for (const record of Object.values(this.#state.appRequests ?? {})) {
      if (record.householdId === groupId) record.detached = true;
    }
    const results: RevokeResult[] = [];
    for (const previous of Object.values({ ...this.#state.grants })) {
      if (!previous.groupIds.includes(groupId)) continue;
      results.push(this.#replaceGrant(previous, previous.requests, previous.manualUserIds, previous.groupIds.filter((id) => id !== groupId)));
    }
    await this.#save();
    return results;
  }

  /**
   * Household "Add to my library": adds the caller's households (`groupIds`), or the caller as a manual user when they
   * belong to none, to the grant of `itemId`. Only an active grant that records at least one request is joined, the
   * same grants the request backfill adds requests to; manual-only grants and items without a grant are left alone, and
   * so is a grant left behind on a deleted item (orphaned, or carrying a `remap` note) for an administrator to resolve.
   * Nothing is ever removed, and a join never undoes an administrator's removal (GrantState.removedAccess for the item,
   * including removals that followed the grant from a deleted item it was moved off):
   *
   * - a marked caller (an administrator's change took their access) joins nothing at all, whichever household they
   *   belong to now;
   * - a marked household is never added; the caller's other households still are;
   * - a caller in no household is added as a user, unless they are marked.
   *
   * A mark is personal: it does not stop another member of the caller's household from joining it, which then gives
   * the whole household, the marked caller included, access. Removing the household itself is what blocks that.
   * Returns undefined, without writing, when nothing changes.
   */
  public async joinGrant(input: { itemId: string; userId: string; groupIds: string[] }): Promise<RevokeResult | undefined> {
    this.#assertOpen();
    const planned = this.#planJoin(input);
    if (!planned) return undefined;
    const { previous, join } = planned;
    const result = this.#replaceGrant(
      previous,
      previous.requests,
      join.userAdded ? [...previous.manualUserIds, join.userId].sort() : previous.manualUserIds,
      [...previous.groupIds, ...join.groupIds].sort(),
      { joins: [...(previous.joins ?? []), join] },
    );
    await this.#save();
    return result;
  }

  /** Whether joinGrant would change the grant now; it reads only, so it needs no turn in the write queue. */
  public wouldJoin(input: { itemId: string; userId: string; groupIds: string[] }): boolean {
    return Boolean(this.#planJoin(input));
  }

  #planJoin(input: { itemId: string; userId: string; groupIds: string[] }): { previous: GrantRecord; join: LibraryJoin } | undefined {
    const itemId = normalizeId(input.itemId);
    const userId = normalizeId(input.userId);
    const previous = this.#state.grants[itemId];
    if (!previous?.active || Object.keys(previous.requests).length === 0) return undefined;
    if (previous.sync.state === 'orphaned' || previous.remap) return undefined;
    if (this.isAccessRemoved(itemId, 'userIds', userId)) return undefined;
    const households = [...new Set(input.groupIds.map(normalizeId))].filter((id) => this.#state.groups[id]);
    const addedGroupIds = households
      .filter((id) => !previous.groupIds.includes(id) && !this.isAccessRemoved(itemId, 'groupIds', id))
      .sort();
    const userAdded = households.length === 0 && !this.resolveOwners(previous).includes(userId);
    if (addedGroupIds.length === 0 && !userAdded) return undefined;
    return { previous, join: { userId, groupIds: addedGroupIds, userAdded, joinedAt: new Date().toISOString() } };
  }

  public async markSyncSuccess(itemIdInput: string): Promise<void> {
    await this.markSyncSuccessBatch([itemIdInput]);
  }

  public async markSyncSuccessBatch(itemIds: string[]): Promise<void> {
    this.#assertOpen();
    const now = new Date().toISOString();
    // Every ID is normalized before any grant changes, so a bad one throws with the state untouched.
    const normalized = itemIds.map(normalizeId);
    let changed = false;
    for (const itemId of normalized) {
      const grant = this.#state.grants[itemId];
      if (!grant) continue;
      grant.sync = { state: 'synced', attempts: 0, lastAttemptAt: now, lastSuccessAt: now };
      changed = true;
    }
    if (!changed) return;
    await this.#save();
  }

  public async markSyncError(itemIdInput: string, error: string): Promise<void> {
    await this.markSyncErrorBatch([itemIdInput], error);
  }

  public async markSyncErrorBatch(itemIds: string[], error: string): Promise<void> {
    this.#assertOpen();
    const now = new Date();
    // As in markSyncSuccessBatch; a bad `error` already throws on the first grant, before it changes.
    const normalized = itemIds.map(normalizeId);
    let changed = false;
    for (const itemId of normalized) {
      const grant = this.#state.grants[itemId];
      if (!grant) continue;
      const attempts = grant.sync.attempts + 1;
      const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10) * 15);
      grant.sync = {
        state: 'error',
        attempts,
        lastAttemptAt: now.toISOString(),
        nextRetryAt: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
        lastError: error.slice(0, 1000),
        ...(grant.sync.lastSuccessAt ? { lastSuccessAt: grant.sync.lastSuccessAt } : {}),
      };
      changed = true;
    }
    if (!changed) return;
    await this.#save();
  }

  public async purgeInactive(itemIdInput: string): Promise<void> {
    this.#assertOpen();
    const itemId = normalizeId(itemIdInput);
    const grant = this.#state.grants[itemId];
    if (!grant || grant.active) return;
    delete this.#state.grants[itemId];
    await this.#save();
  }

  /** Every household app "Get this" record, with its ID (see AppRequestRecord). */
  public listAppRequests(): Array<[string, AppRequestRecord]> {
    return Object.entries(this.#state.appRequests ?? {}).map(([id, record]) => [id, clone(record)]);
  }

  /** One household app "Get this" record, by ID, as it is now (see AppRequestRecord). */
  public getAppRequest(id: string): AppRequestRecord | undefined {
    const record = this.#state.appRequests?.[id];
    return record ? clone(record) : undefined;
  }

  /**
   * One household's "Get this" records (detached ones included), from an index: the work depends on that household's
   * own records only, never on how many other households have.
   */
  public listAppRequestsForHousehold(householdId: string): Array<[string, AppRequestRecord]> {
    const records = this.#state.appRequests ?? {};
    const epoch = this.#state.householdEpochs?.[normalizeId(householdId)];
    return (this.#appIndex().get(normalizeId(householdId)) ?? []).flatMap((id) => {
      if (!records[id]) return [];
      const record = clone(records[id]);
      // Made for a household since replaced under the same ID.
      if (record.householdEpoch !== undefined && record.householdEpoch !== epoch) record.detached = true;
      return [[id, record] as [string, AppRequestRecord]];
    });
  }

  /** Every "Get this" request intent, with its ID (see AppRequestIntent). */
  public listAppRequestIntents(): Array<[string, AppRequestIntent]> {
    return Object.entries(this.#state.appRequestIntents ?? {}).map(([id, intent]) => [id, clone(intent)]);
  }

  /** Whether an intent names this title (see AppRequestIntent): webhooks and the backfill grant none of its requests. */
  public hasAppRequestIntent(mediaType: string, tmdbId: number): boolean {
    return Object.values(this.#state.appRequestIntents ?? {}).some((intent) => intent.mediaType === mediaType && intent.tmdbId === tmdbId);
  }

  /**
   * Whether the state file on disk holds this request intent: written and renamed into place, not merely in memory.
   * "Get this" checks it immediately before sending the intent's Seerr request (see HouseholdRequests), so a request is
   * never sent before the decision that protects its grant would survive a crash.
   *
   * "On disk" means the atomic write-and-rename completed, not power-loss durability: neither the file nor its directory
   * is fsynced, so an OS crash or power cut right after the rename can still lose the intent (a documented leftover, see
   * docs/app-design.md); a process crash cannot.
   */
  public isAppRequestIntentDurable(id: string): boolean {
    return this.#durableIntents.has(id);
  }

  /** The key the household app derives opaque IDs from, or undefined before the first "Get this" record. */
  public getAppIdKey(): string | undefined {
    return this.#state.appIdKey;
  }

  /**
   * A number that identifies this household for as long as it exists: a household deleted and created again under the
   * same ID has another. Undefined when there is no such household. Kept in the state file (given the first time it is
   * asked for, and written with the next write, such as the intent that names it), so an intent reconciled after a
   * restart tells a household replaced meanwhile from the one it was made for.
   */
  public householdEpoch(householdId: string): number | undefined {
    const id = normalizeId(householdId);
    if (!this.#state.groups[id]) return undefined;
    let epoch = this.#state.householdEpochs?.[id];
    if (epoch === undefined) {
      epoch = Math.max(this.#state.nextHouseholdEpoch ?? 1, ...Object.values(this.#state.householdEpochs ?? {}).map((value) => value + 1));
      this.#state.nextHouseholdEpoch = epoch + 1;
      this.#state.householdEpochs = { ...this.#state.householdEpochs, [id]: epoch };
    }
    return epoch;
  }

  /** Every household app safety tombstone (see AppSafetyTombstone). */
  public listAppSafetyTombstones(): AppSafetyTombstone[] {
    return Object.values(this.#state.appSafetyTombstones ?? {}).map(clone);
  }

  /**
   * The safety tombstones that still decide a grant (see outstandingTombstone), as of `now`: what a version that does
   * not read them would decide differently, so a rollback waits until there are none.
   */
  public listOutstandingAppSafetyTombstones(now = Date.now()): AppSafetyTombstone[] {
    const handled = new Set(this.#state.handledRequestIds ?? []);
    return Object.values(this.#state.appSafetyTombstones ?? {}).filter((tombstone) => outstandingTombstone(tombstone, handled, now)).map(clone);
  }

  /** Every household app withdrawal, by the Seerr request ID it names (see AppWithdrawal). */
  public listAppWithdrawals(): Array<[string, AppWithdrawal]> {
    return Object.entries(this.#state.appWithdrawals ?? {}).map(([id, withdrawal]) => [id, clone(withdrawal)]);
  }

  /** The withdrawal that names this Seerr request, if any (see AppWithdrawal). */
  public getAppWithdrawal(requestId: string): AppWithdrawal | undefined {
    const withdrawal = this.#state.appWithdrawals?.[requestId];
    return withdrawal ? clone(withdrawal) : undefined;
  }

  /**
   * The withdrawals that still decide a grant, as of `now` (see AppWithdrawal): one naming a request not handled yet,
   * and one whose requester withdrew a request a grant records. What a version that does not read them would decide
   * differently, so a rollback waits until there are none (docs/app-design.md, "Cancelling (step 2c)").
   */
  public listOutstandingAppWithdrawals(now = Date.now()): Array<[string, AppWithdrawal]> {
    const handled = new Set(this.#state.handledRequestIds ?? []);
    return Object.entries(this.#state.appWithdrawals ?? {})
      .filter(([id, withdrawal]) => this.#keepsWithdrawal(id, withdrawal, handled, now))
      .map(([id, withdrawal]) => [id, clone(withdrawal)]);
  }

  /**
   * The title holds (see AppWithdrawal `seerrGoneAt`): withdrawals whose requester withdrew a genuine request that Seerr
   * no longer has, by request ID. A hold that granted some of its title's items is still one (its request is handled)
   * until every item has an active grant (`dropTitleHolds` in writeAppRequests).
   */
  public listAppTitleHolds(now = Date.now()): Array<[string, AppWithdrawal & { requesterId: string }]> {
    return this.listOutstandingAppWithdrawals(now).filter((entry): entry is [string, AppWithdrawal & { requesterId: string }] =>
      entry[1].seerrGoneAt !== undefined && entry[1].requesterId !== undefined);
  }

  /** Records requests as handled without granting them (a "Get this" request granted as a join); see hasHandledRequest. */
  public async markRequestsHandled(requestIds: string[]): Promise<void> {
    this.#assertOpen();
    const handled = new Set(this.#state.handledRequestIds ?? []);
    if (requestIds.every((id) => handled.has(id))) return;
    this.#state.handledRequestIds = [...new Set([...handled, ...requestIds])];
    await this.#save();
  }

  /**
   * Writes a "Get this" request intent (see AppRequestIntent) and resolves once the state file has it: only then may
   * the request be sent. Resolves with its ID (see isAppRequestIntentDurable). `claim` is called with the ID before the
   * intent is in memory, so its owner holds it before anything that lists intents can see it.
   */
  public async addAppRequestIntent(intent: AppRequestIntent, claim?: (id: string) => void): Promise<string> {
    this.#assertOpen();
    const id = randomUUID();
    claim?.(id);
    this.#state.appRequestIntents = { ...this.#state.appRequestIntents, [id]: clone(intent) };
    await this.#save();
    return id;
  }

  /**
   * Adds household app "Get this" records, changes the status (and joined items, ready seasons, grant rule or whether
   * it awaits a grant) of existing ones, settles or removes request intents, and adds safety tombstones (see
   * AppSafetyTombstone) and exemptions from them, in one write. Records added with a `householdEpoch` other than their
   * household's current one (it was deleted, or deleted and created again, while the call ran) are added detached.
   * Then settled records are pruned (see pruneAppRequests): never a pending one; and tombstones that can no longer
   * matter (see pruneTombstones), never by how many records there are. The state changes before this returns its
   * promise. Resolves with the IDs of the added records.
   */
  public async writeAppRequests(input: {
    add?: AppRequestRecord[];
    householdEpoch?: number;
    update?: Array<{
      id: string;
      status?: AppRequestStatus;
      itemIds?: string[];
      readySeasons?: number[];
      joinOnGrant?: AppRequestRecord['joinOnGrant'];
      awaitingGrant?: boolean;
      /** Withdrawn by the member who made it (AppRequestRecord.withdrawn); give it `status: 'deleted'` too. */
      withdrawn?: true;
    }>;
    /** Intents now `settling`: their request is recorded, Jellyfin could not be read yet. */
    settleIntents?: Array<{ id: string; seerrRequestId: string }>;
    /** Intents resolved: their request is recorded and settled, or was never made, or a tombstone covers it. */
    removeIntents?: string[];
    tombstones?: AppSafetyTombstone[];
    /** Requests "Get this" made and settled as genuine: no member-wide tombstone for the member and title covers them. */
    exempt?: Array<{ mediaType: 'movie' | 'tv'; tmdbId: number; jellyfinUserId: string; requestId: string }>;
    /** Households withdrawing from Seerr requests (see AppWithdrawal), merged into any withdrawal already kept. */
    withdraw?: Array<{ requestId: string; mediaType: 'movie' | 'tv'; tmdbId: number; householdId: string; requester: boolean; requesterId?: string }>;
    /** Withdrawals no longer needed: the member deleted their pending request, or a title hold found its title granted. */
    forgetWithdrawals?: string[];
    /**
     * Requests Seerr no longer has (an administrator deleted them), not handled: a withdrawal of one with `requesterId`
     * becomes a title hold (AppWithdrawal `seerrGoneAt`), any other is forgotten.
     */
    requestsGone?: string[];
    /**
     * Title holds applied to every item of their title: one whose request is handled stays a withdrawal (it keeps the
     * requester out of the grants that record it) and is no longer a hold; any other is forgotten.
     */
    dropTitleHolds?: string[];
  }): Promise<string[]> {
    this.#assertOpen();
    const now = new Date().toISOString();
    const records = { ...this.#state.appRequests };
    const added = (input.add ?? []).map((record) => {
      const id = randomUUID();
      const stale = input.householdEpoch !== undefined && this.householdEpoch(record.householdId) !== input.householdEpoch;
      records[id] = stale
        ? { ...clone(record), detached: true }
        : { ...clone(record), ...(input.householdEpoch !== undefined ? { householdEpoch: input.householdEpoch } : {}) };
      return id;
    });
    for (const change of input.update ?? []) {
      const record = records[change.id];
      if (!record) continue;
      // A withdrawn record stays withdrawn: no later write (a refresh that read it before the cancel, say) makes it
      // followed, listed or settled again.
      if (record.withdrawn && !change.withdrawn) continue;
      const { awaitingGrant: _, ...rest } = record;
      const awaiting = change.awaitingGrant ?? record.awaitingGrant === true;
      records[change.id] = {
        ...rest,
        updatedAt: now,
        ...(change.status ? { status: change.status } : {}),
        ...(change.itemIds ? { itemIds: [...new Set([...(record.itemIds ?? []), ...change.itemIds.map(normalizeId)])].sort() } : {}),
        ...(change.readySeasons ? { readySeasons: [...new Set(change.readySeasons)].sort((left, right) => left - right) } : {}),
        ...(change.joinOnGrant ? { joinOnGrant: change.joinOnGrant } : {}),
        ...(awaiting ? { awaitingGrant: true as const } : {}),
        ...(change.withdrawn ? { withdrawn: true as const } : {}),
      };
    }
    const tombstones = { ...this.#state.appSafetyTombstones };
    for (const tombstone of input.tombstones ?? []) tombstones[randomUUID()] = clone(tombstone);
    for (const exemption of input.exempt ?? []) {
      for (const [id, tombstone] of Object.entries(tombstones)) {
        if (tombstone.jellyfinUserId !== normalizeId(exemption.jellyfinUserId) || tombstone.mediaType !== exemption.mediaType
          || tombstone.tmdbId !== exemption.tmdbId || tombstone.requestIds.includes(exemption.requestId)) continue;
        tombstones[id] = { ...tombstone, exemptRequestIds: [...new Set([...(tombstone.exemptRequestIds ?? []), exemption.requestId])].sort() };
      }
    }
    const kept = pruneTombstones(tombstones, new Set(this.#state.handledRequestIds ?? []), Date.now());
    if (Object.keys(kept).length > 0) this.#state.appSafetyTombstones = kept;
    else delete this.#state.appSafetyTombstones;
    const intents = { ...this.#state.appRequestIntents };
    for (const { id, seerrRequestId } of input.settleIntents ?? []) {
      const intent = intents[id];
      if (intent) intents[id] = { ...intent, status: 'settling', seerrRequestId };
    }
    for (const id of input.removeIntents ?? []) delete intents[id];
    if (Object.keys(intents).length > 0) this.#state.appRequestIntents = intents;
    else delete this.#state.appRequestIntents;
    this.#state.appRequests = pruneAppRequests(records, Date.now());
    const withdrawals = { ...this.#state.appWithdrawals };
    for (const entry of input.withdraw ?? []) {
      const before = withdrawals[entry.requestId];
      const requesterId = before?.requesterId ?? (entry.requester && entry.requesterId ? normalizeId(entry.requesterId) : undefined);
      withdrawals[entry.requestId] = {
        mediaType: entry.mediaType,
        tmdbId: entry.tmdbId,
        householdIds: [...new Set([...(before?.householdIds ?? []), normalizeId(entry.householdId)])].sort(),
        ...(entry.requester || before?.requester ? { requester: true as const } : {}),
        ...(requesterId ? { requesterId } : {}),
        createdAt: before?.createdAt ?? now,
        ...(before?.grantedAt ? { grantedAt: before.grantedAt } : {}),
        ...(before?.seerrGoneAt ? { seerrGoneAt: before.seerrGoneAt } : {}),
      };
    }
    for (const id of input.forgetWithdrawals ?? []) delete withdrawals[id];
    const handled = new Set(this.#state.handledRequestIds ?? []);
    for (const id of input.requestsGone ?? []) {
      const withdrawal = withdrawals[id];
      if (!withdrawal || handled.has(id)) continue;
      if (withdrawal.requesterId) withdrawals[id] = { ...withdrawal, seerrGoneAt: withdrawal.seerrGoneAt ?? now };
      else delete withdrawals[id];
    }
    for (const id of input.dropTitleHolds ?? []) {
      const withdrawal = withdrawals[id];
      if (!withdrawal) continue;
      if (handled.has(id)) {
        const { seerrGoneAt: _, ...kept } = withdrawal;
        withdrawals[id] = kept;
      } else delete withdrawals[id];
    }
    this.#state.appWithdrawals = withdrawals;
    this.#pruneWithdrawals();
    this.#state.appIdKey ??= randomBytes(32).toString('hex');
    this.#appIndexCache = undefined;
    await this.#save();
    return added;
  }

  /** The webhooks deferred for a "Get this" request intent (see GrantState.deferredWebhooks), oldest first. */
  public listDeferredWebhooks(): SeerrWebhook[] {
    return clone(this.#state.deferredWebhooks ?? []);
  }

  /**
   * Remembers a deferred webhook (only what granting it reads), replacing an earlier one for the same request, at most
   * {@link MAX_DEFERRED_REQUESTS} of them (the oldest are forgotten, left to the backfill).
   */
  public async deferWebhook(event: SeerrWebhook): Promise<void> {
    this.#assertOpen();
    const kept: SeerrWebhook = {
      notificationType: event.notificationType,
      ...(event.media ? { media: {
        ...(event.media.jellyfinMediaId ? { jellyfinMediaId: event.media.jellyfinMediaId } : {}),
        ...(event.media.mediaType ? { mediaType: event.media.mediaType } : {}),
      } } : {}),
      request: {
        id: event.request.id,
        ...(event.request.is4k !== undefined ? { is4k: event.request.is4k } : {}),
        ...(event.request.requestedBy?.jellyfinUserId ? { requestedBy: { jellyfinUserId: event.request.requestedBy.jellyfinUserId } } : {}),
      },
    };
    const deferred = (this.#state.deferredWebhooks ?? []).filter((entry) => entry.request.id !== event.request.id);
    this.#state.deferredWebhooks = [...deferred, kept].slice(-MAX_DEFERRED_REQUESTS);
    await this.#save();
  }

  /** Forgets deferred webhooks that were granted (or need nothing any more), by request ID. */
  public async forgetDeferredWebhooks(requestIds: string[]): Promise<void> {
    this.#assertOpen();
    const forget = new Set(requestIds);
    const before = this.#state.deferredWebhooks ?? [];
    const deferred = before.filter((entry) => !forget.has(entry.request.id));
    if (deferred.length === before.length) return;
    if (deferred.length > 0) this.#state.deferredWebhooks = deferred;
    else delete this.#state.deferredWebhooks;
    await this.#save();
  }

  /** Drops the withdrawals that no longer decide a grant (see listOutstandingAppWithdrawals), and the field once empty. */
  #pruneWithdrawals(): void {
    const handled = new Set(this.#state.handledRequestIds ?? []);
    const now = Date.now();
    const kept = Object.entries(this.#state.appWithdrawals ?? {}).filter(([id, withdrawal]) => this.#keepsWithdrawal(id, withdrawal, handled, now));
    if (kept.length > 0) this.#state.appWithdrawals = Object.fromEntries(kept);
    else delete this.#state.appWithdrawals;
  }

  /**
   * Whether a withdrawal still decides a grant: its request is not handled yet (for at most APP_REQUEST_RETENTION_MS),
   * or its requester withdrew it and a grant records it (that requester is no owner of the grant through it).
   */
  #keepsWithdrawal(requestId: string, withdrawal: AppWithdrawal, handled: ReadonlySet<string>, now: number): boolean {
    if (!handled.has(requestId)) return now - Date.parse(withdrawal.createdAt) <= APP_REQUEST_RETENTION_MS;
    return withdrawal.requester === true && Object.values(this.#state.grants).some((grant) => requestId in grant.requests);
  }

  #appIndex(): Map<string, string[]> {
    if (this.#appIndexCache) return this.#appIndexCache;
    const index = new Map<string, string[]>();
    for (const [id, record] of Object.entries(this.#state.appRequests ?? {})) {
      index.set(record.householdId, [...index.get(record.householdId) ?? [], id]);
    }
    this.#appIndexCache = index;
    return index;
  }

  /** Throws once close() has been called, so a caller can refuse before starting work it could not record. */
  public assertOpen(): void {
    this.#assertOpen();
  }

  /**
   * The grant an item would have after `move` off the grant on `fromItemId` is merged into it, without storing anything
   * (see #preview): requests, manual users and groups are added to whatever grant the item already has (nothing on it
   * is dropped). Groups that no longer exist, requests an administrator revoked from that item and users and groups an
   * administrator removed from it (GrantState.removedAccess) are left out of the moved ones. The source's library joins
   * that go with the move are added as mergeGrants describes.
   */
  public previewMerge(fromItemIdInput: string, move: GrantMove): GrantRecord {
    return this.#preview(() => this.#mergeGrants(fromItemIdInput, [move]))[0] as GrantRecord;
  }

  /**
   * The first step of moving a grant: merges each move into its target item's grant (see previewMerge) in one write,
   * leaving the source grant as it is. A crash before the targets are applied therefore loses nobody: the targets are
   * stored (pending), the source still records everyone, and merging the same move again changes nothing. Moved
   * requests stay handled, so the backfill never re-imports them. Finish with retireMovedGrant once the targets are applied.
   *
   * What an administrator removed from the source item follows the grant to each target, so a move never lets anyone
   * regain access an administrator took (by a later household library join, webhook, backfill or move): the source's
   * removal marks (GrantState.removedAccess) and its revoked requests are recorded for each target too. Marks only ever
   * restrict, so they never give anyone access. A user or group the target's grant already gave access to on its own
   * keeps it, and so does a request it already records: removing access from a stale copy of a grant never takes it
   * from the item that copy was moved to. The source keeps its own marks. The source's library joins (an audit trail,
   * which gives no access) move with the households they added: all of them when the whole audience moves, otherwise
   * those whose households or user moved to that target; the source keeps its own list until it is deleted.
   */
  public async mergeGrants(fromItemIdInput: string, moves: GrantMove[]): Promise<GrantRecord[]> {
    this.#assertOpen();
    const currents = this.#atomically(() => this.#mergeGrants(fromItemIdInput, moves));
    await this.#save();
    return currents;
  }

  #mergeGrants(fromItemIdInput: string, moves: GrantMove[]): GrantRecord[] {
    const fromItemId = normalizeId(fromItemIdInput);
    if (!this.#state.grants[fromItemId]) throw new Error(`grant not found: ${fromItemId}`);
    const targetIds = moves.map((move) => normalizeId(move.itemId));
    if (targetIds.length === 0 || targetIds.includes(fromItemId) || new Set(targetIds).size !== targetIds.length) {
      throw new Error('grant move targets are invalid');
    }
    const source = this.#state.grants[fromItemId] as GrantRecord;
    const currents = moves.map((move) => {
      const before = this.#state.grants[normalizeId(move.itemId)];
      const current = this.#mergedMove(source, move);
      this.#carryRemovals(fromItemId, current.itemId, before);
      return current;
    });
    for (const current of currents) this.#state.grants[current.itemId] = current;
    return currents.map(clone);
  }

  /**
   * Runs one of the synchronous mutations behind a write on a copy of the state and discards the copy, so a dry run
   * returns exactly what the write would store (audit fields, remap notes and sync status included) and cannot drift
   * from it. It stores nothing, so it is allowed after close().
   */
  #preview<T>(mutate: () => T): T {
    const state = this.#state;
    this.#state = clone(state);
    try {
      return clone(mutate());
    } finally {
      this.#state = state;
    }
  }

  /**
   * Runs one of the synchronous mutations behind a write that changes the state in several steps on a copy of the
   * state, and keeps the copy only if it completes: a mutation that throws partway (on a later item of a batch, say)
   * leaves the state exactly as it was, so no later save can store half of it.
   */
  #atomically<T>(mutate: () => T): T {
    const state = this.#state;
    this.#state = clone(state);
    try {
      return mutate();
    } catch (error) {
      this.#state = state;
      throw error;
    }
  }

  /**
   * The last step of moving a grant: deletes the source grant or, given `remainder` (the part of its audience that was
   * not moved), replaces it with that part, records the items the rest went to (`remap.splitTo`) and marks it orphaned
   * with `remainder.reason`. Resolves true only when the grant was newly orphaned.
   */
  public async retireMovedGrant(fromItemIdInput: string, remainder?: GrantRemainder): Promise<boolean> {
    this.#assertOpen();
    const fromItemId = normalizeId(fromItemIdInput);
    const previous = this.#state.grants[fromItemId];
    if (!previous) return false;
    if (!remainder) {
      delete this.#state.grants[fromItemId];
      await this.#save();
      return false;
    }
    const groupIds = [...new Set(remainder.groupIds.map(normalizeId))].filter((id) => this.#state.groups[id]).sort();
    const manualUserIds = [...new Set(remainder.manualUserIds.map(normalizeId))].sort();
    const next = this.#makeGrant(fromItemId, { ...remainder.requests }, manualUserIds, groupIds, previous, previous.mediaType);
    const splitTo = [...new Set([...(previous.remap?.splitTo ?? []), ...remainder.movedTo.map(normalizeId)])].sort();
    next.remap = { ...next.remap, splitTo };
    next.sync = orphanedSync(previous.sync, remainder.reason);
    this.#state.grants[fromItemId] = next;
    await this.#save();
    return previous.sync.state !== 'orphaned';
  }

  /**
   * Records that a grant's item existed again when a move off it to `movedTo` finished (see GrantRemapNote), leaving
   * the grant's audience as it is. It becomes pending, so the next reconciliation applies it to the item again.
   */
  public async markSourceReappeared(itemIdInput: string, movedTo: string[]): Promise<void> {
    this.#assertOpen();
    const grant = this.#state.grants[normalizeId(itemIdInput)];
    if (!grant) return;
    grant.remap = { ...grant.remap, sourceReappeared: { at: new Date().toISOString(), movedTo: movedTo.map(normalizeId).sort() } };
    grant.sync = pendingSync(grant.sync);
    await this.#save();
  }

  /** Marks a grant orphaned (see SyncStatus); resolves true only when it was not orphaned already. */
  public async markOrphaned(itemIdInput: string, reason: string): Promise<boolean> {
    this.#assertOpen();
    const grant = this.#state.grants[normalizeId(itemIdInput)];
    if (!grant) return false;
    const newlyOrphaned = grant.sync.state !== 'orphaned';
    grant.sync = orphanedSync(grant.sync, reason);
    await this.#save();
    return newlyOrphaned;
  }

  /** The target's grant once `move` off `source` is merged into it (see mergeGrants). */
  #mergedMove(source: GrantRecord, move: GrantMove): GrantRecord {
    const itemId = normalizeId(move.itemId);
    const previous = this.#state.grants[itemId];
    const moved = Object.entries(move.requests).filter(([requestId]) => !this.isRequestRevoked(requestId, itemId));
    const requests = { ...(previous?.requests ?? {}), ...Object.fromEntries(moved) };
    const movedUserIds = move.manualUserIds.map(normalizeId).filter((id) => !this.isAccessRemoved(itemId, 'userIds', id));
    const manualUserIds = [...new Set([...(previous?.manualUserIds ?? []), ...movedUserIds])].sort();
    const movedGroupIds = move.groupIds.map(normalizeId)
      .filter((id) => this.#state.groups[id] && !this.isAccessRemoved(itemId, 'groupIds', id));
    const groupIds = [...new Set([...(previous?.groupIds ?? []), ...movedGroupIds])].sort();
    // The same join merged again (a repeated move) is recorded once.
    const allJoins = [...(previous?.joins ?? []), ...this.#movedJoins(source, move)];
    const mergedJoins = allJoins
      .filter((join, index) => allJoins.findIndex((other) => other.userId === join.userId && other.joinedAt === join.joinedAt) === index)
      .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));
    return this.#makeGrant(itemId, requests, manualUserIds, groupIds, previous, previous?.mediaType ?? move.mediaType, {
      joins: mergedJoins,
    });
  }

  /** The source's library joins that go with `move` (see mergeGrants). */
  #movedJoins(source: GrantRecord, move: GrantMove): LibraryJoin[] {
    const groupIds = new Set(move.groupIds.map(normalizeId));
    const manualUserIds = new Set(move.manualUserIds.map(normalizeId));
    const whole = source.groupIds.every((id) => groupIds.has(id)) && source.manualUserIds.every((id) => manualUserIds.has(id));
    return (source.joins ?? []).filter((join) => whole
      || join.groupIds.some((id) => groupIds.has(id))
      || (join.userAdded && manualUserIds.has(join.userId)));
  }

  /**
   * Records the source item's removal marks and revoked requests for a move's target (see mergeGrants), except for what
   * the target's grant before the move (`before`) already gave access to.
   */
  #carryRemovals(fromItemId: string, toItemId: string, before: GrantRecord | undefined): void {
    const source = this.#state.removedAccess?.[fromItemId];
    if (source) {
      const owners = new Set(before ? this.resolveOwners(before) : []);
      const target = this.#state.removedAccess?.[toItemId] ?? {};
      this.#setRemovals(toItemId, {
        userIds: [...(target.userIds ?? []), ...(source.userIds ?? []).filter((id) => !owners.has(id))],
        groupIds: [...(target.groupIds ?? []), ...(source.groupIds ?? []).filter((id) => !before?.groupIds.includes(id))],
      });
    }
    for (const [requestId, itemIds] of Object.entries(this.#state.revokedRequests ?? {})) {
      if (!itemIds.includes(fromItemId) || itemIds.includes(toItemId) || (before && requestId in before.requests)) continue;
      this.#state.revokedRequests = { ...this.#state.revokedRequests, [requestId]: [...itemIds, toItemId].sort() };
    }
  }

  /**
   * Records an administrator setting an item's groups and manual users (see GrantState.removedAccess), from its grant
   * before the change, if any. Whatever they took off is marked: each removed group, each removed manual user, and every
   * user who loses access through the change (such as the members of a removed household), so that user cannot regain
   * it by joining directly or through another household, or through a move. Whatever they assign is unmarked: the
   * groups and manual users they set, and the members of each group they add. Members of a group that merely stays on
   * the grant keep their marks.
   */
  #recordAdministratorChange(itemId: string, previous: GrantRecord | undefined, manualUserIds: string[], groupIds: string[]): void {
    const removals = this.#state.removedAccess?.[itemId] ?? {};
    const before: Pick<GrantRecord, 'requests' | 'manualUserIds' | 'groupIds'> = previous ?? { requests: {}, manualUserIds: [], groupIds: [] };
    const removedGroupIds = [...(removals.groupIds ?? []), ...before.groupIds].filter((id) => !groupIds.includes(id));
    const owners = new Set(this.resolveOwners({ requests: before.requests, manualUserIds, groupIds }));
    const lostAccess = this.resolveOwners(before).filter((id) => !owners.has(id));
    const assigned = new Set([
      ...manualUserIds,
      ...groupIds.filter((id) => !before.groupIds.includes(id)).flatMap((id) => this.#state.groups[id]?.userIds ?? []),
    ]);
    const removedUserIds = [...(removals.userIds ?? []), ...before.manualUserIds, ...lostAccess].filter((id) => !assigned.has(id));
    this.#setRemovals(itemId, { userIds: removedUserIds, groupIds: removedGroupIds });
  }

  #setRemovals(itemId: string, removals: AccessRemovals): void {
    const next: AccessRemovals = {
      ...(removals.userIds?.length ? { userIds: [...new Set(removals.userIds)].sort() } : {}),
      ...(removals.groupIds?.length ? { groupIds: [...new Set(removals.groupIds)].sort() } : {}),
    };
    const { [itemId]: _, ...others } = this.#state.removedAccess ?? {};
    if (next.userIds || next.groupIds) this.#state.removedAccess = { ...others, [itemId]: next };
    else if (Object.keys(others).length > 0) this.#state.removedAccess = others;
    else delete this.#state.removedAccess;
  }

  #makeGrant(
    itemId: string,
    requests: Record<string, string>,
    manualUserIds: string[],
    groupIds: string[],
    previous?: GrantRecord,
    mediaType?: string,
    audit: GrantAudit = {},
  ): GrantRecord {
    const resolvedMediaType = mediaType ?? previous?.mediaType;
    const joins = 'joins' in audit ? audit.joins : previous?.joins;
    const placeholder: GrantRecord = {
      itemId,
      active: Object.keys(requests).length > 0 || manualUserIds.length > 0 || groupIds.length > 0,
      owners: [],
      requests,
      manualUserIds: [...manualUserIds],
      groupIds: [...groupIds],
      ...(joins?.length ? { joins: clone(joins) } : {}),
      sync: pendingSync(previous?.sync),
      updatedAt: new Date().toISOString(),
      ...(resolvedMediaType ? { mediaType: resolvedMediaType } : {}),
    };
    if (previous?.remap) placeholder.remap = clone(previous.remap);
    placeholder.owners = this.resolveOwners(placeholder);
    return placeholder;
  }

  /** Synchronous, so a mutation and the save that persists it are never split by close(). */
  #replaceGrant(
    previous: GrantRecord,
    requests: Record<string, string>,
    manualUserIds: string[],
    groupIds: string[],
    audit: GrantAudit = {},
  ): RevokeResult {
    const next = this.#makeGrant(previous.itemId, requests, manualUserIds, groupIds, previous, previous.mediaType, audit);
    this.#state.grants[previous.itemId] = next;
    return { previous: clone(previous), current: clone(next) };
  }

  /** Every mutator calls this before touching state, so a change refused after close() leaves memory untouched too. */
  #assertOpen(): void {
    if (this.#closed) throw new Error('state store is closed');
  }

  /**
   * Persists the state. One write runs at a time; saves requested while a write is in flight
   * share the next one, which serializes the state when it starts and so includes every change
   * made before it.
   */
  #save(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('state store is closed'));
    if (this.#queued) return this.#queued;
    const queued = this.#writing.catch(() => undefined).then(() => {
      this.#queued = undefined;
      return this.#write();
    });
    this.#queued = queued;
    this.#writing = queued;
    return queued;
  }

  /**
   * Refuses further changes, then waits for the write in flight and any queued behind it, so the state file is complete
   * when the process exits. Rejects if the last write failed: the file on disk is then missing changes.
   */
  public async close(): Promise<void> {
    this.#closed = true;
    await this.#writing;
  }

  async #write(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    // A unique name per write, so a stray concurrent writer can never rename another's file.
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    // The intents this write holds, taken with the state it serializes.
    const intents = Object.keys(this.#state.appRequestIntents ?? {});
    try {
      await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#file);
      this.#durableIntents = new Set(intents);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** Part of a grant moved to another item: merged into that item's grant by GrantStore.mergeGrants. */
export interface GrantMove {
  itemId: string;
  requests: Record<string, string>;
  manualUserIds: string[];
  groupIds: string[];
  mediaType?: string;
}

/** What stays on a moved grant's deleted item, orphaned, because it could not be attributed to a target. */
export interface GrantRemainder {
  requests: Record<string, string>;
  manualUserIds: string[];
  groupIds: string[];
  reason: string;
  /** The items the rest of the grant moved to. */
  movedTo: string[];
}

/** Audit fields to set on a rebuilt grant; a field that is absent is carried over from the previous grant. */
type GrantAudit = Partial<Pick<GrantRecord, 'joins'>>;

export function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function pendingSync(previous?: SyncStatus): SyncStatus {
  return {
    state: 'pending',
    attempts: previous?.attempts ?? 0,
    ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
  };
}

function orphanedSync(previous: SyncStatus, reason: string): SyncStatus {
  return {
    state: 'orphaned',
    attempts: previous.attempts,
    lastAttemptAt: new Date().toISOString(),
    lastError: reason.slice(0, 1000),
    ...(previous.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
  };
}

/**
 * See GrantStore.writeAppRequests. A pending record is never pruned (it is still being followed). Settled records
 * (completed, declined, deleted, failed) are kept for APP_REQUEST_RETENTION_MS, at most MAX_APP_REQUESTS_PER_HOUSEHOLD
 * of them per household (its own newest; one household's volume never prunes another's).
 */
function pruneAppRequests(records: Record<string, AppRequestRecord>, now: number): Record<string, AppRequestRecord> {
  const kept: Array<[string, AppRequestRecord]> = [];
  const settled: Array<[string, AppRequestRecord]> = [];
  for (const entry of Object.entries(records)) (entry[1].status === 'pending' ? kept : settled).push(entry);
  const perHousehold = new Map<string, number>();
  settled.sort(([, left], [, right]) => right.createdAt.localeCompare(left.createdAt));
  for (const entry of settled) {
    const [, record] = entry;
    const count = (perHousehold.get(record.householdId) ?? 0) + 1;
    perHousehold.set(record.householdId, count);
    if (now - Date.parse(record.createdAt) <= APP_REQUEST_RETENTION_MS && count <= MAX_APP_REQUESTS_PER_HOUSEHOLD) kept.push(entry);
  }
  return Object.fromEntries(kept);
}

/**
 * See GrantStore.writeAppRequests. A tombstone is kept until its `expiresAt`, and after it while any of its
 * `requestIds` is not handled yet (once handled, a request is never granted again), at most APP_REQUEST_RETENTION_MS
 * after it was made.
 */
function pruneTombstones(tombstones: Record<string, AppSafetyTombstone>, handled: ReadonlySet<string>, now: number): Record<string, AppSafetyTombstone> {
  return Object.fromEntries(Object.entries(tombstones).filter(([, tombstone]) => now < Date.parse(tombstone.expiresAt)
    || (tombstone.requestIds.some((id) => !handled.has(id)) && now - Date.parse(tombstone.createdAt) <= APP_REQUEST_RETENTION_MS)));
}

/**
 * Whether a tombstone still decides a grant: it names a request not handled yet (until it is pruned, at most
 * APP_REQUEST_RETENTION_MS after it was made), or it is member-wide and before its `expiresAt` (the member's later
 * requests for the title are still joins). One that is neither is kept only until the next write prunes it.
 */
function outstandingTombstone(tombstone: AppSafetyTombstone, handled: ReadonlySet<string>, now: number): boolean {
  return (tombstone.requestIds.some((id) => !handled.has(id)) && now - Date.parse(tombstone.createdAt) <= APP_REQUEST_RETENTION_MS)
    || (tombstone.jellyfinUserId !== undefined && now < Date.parse(tombstone.expiresAt));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Gathers removal records written by earlier development builds into GrantState.removedAccess, keeping every mark:
 * per-grant `removedUserIds` / `removedGroupIds` (household library joins) and the state's `removedManualAccess`
 * (grant moves). Both were keyed by item like removedAccess, with the same meaning per kind. Resolves true when the state
 * changed and must be saved. A 2.1.1 state file has neither and is left as it is.
 */
function liftRemovals(state: GrantState): boolean {
  const legacy = state as GrantState & { removedManualAccess?: Record<string, AccessRemovals> };
  const found: Array<[string, AccessRemovals]> = Object.entries(legacy.removedManualAccess ?? {});
  for (const grant of Object.values(state.grants)) {
    const marked = grant as GrantRecord & { removedUserIds?: string[]; removedGroupIds?: string[] };
    if (!marked.removedUserIds && !marked.removedGroupIds) continue;
    found.push([grant.itemId, { userIds: marked.removedUserIds ?? [], groupIds: marked.removedGroupIds ?? [] }]);
    delete marked.removedUserIds;
    delete marked.removedGroupIds;
  }
  if (!legacy.removedManualAccess && found.length === 0) return false;
  delete legacy.removedManualAccess;
  const removedAccess = { ...state.removedAccess };
  for (const [itemIdInput, removals] of found) {
    const itemId = normalizeId(itemIdInput);
    const userIds = [...new Set([...(removedAccess[itemId]?.userIds ?? []), ...(removals.userIds ?? []).map(normalizeId)])].sort();
    const groupIds = [...new Set([...(removedAccess[itemId]?.groupIds ?? []), ...(removals.groupIds ?? []).map(normalizeId)])].sort();
    if (userIds.length === 0 && groupIds.length === 0) continue;
    removedAccess[itemId] = { ...(userIds.length ? { userIds } : {}), ...(groupIds.length ? { groupIds } : {}) };
  }
  if (Object.keys(removedAccess).length > 0) state.removedAccess = removedAccess;
  return true;
}

function migrateState(value: unknown): { state: GrantState; changed: boolean } {
  if (!value || typeof value !== 'object') throw new Error('state file must be a JSON object');
  const candidate = value as {
    version?: unknown;
    grants?: unknown;
    groups?: unknown;
    catalog?: unknown;
    claims?: unknown;
    passwordlessUserIds?: unknown;
    handledRequestIds?: unknown;
  };
  if (!candidate.grants || typeof candidate.grants !== 'object') throw new Error('state file is missing grants');
  const handled = Array.isArray(candidate.handledRequestIds)
    ? { handledRequestIds: candidate.handledRequestIds as string[] }
    : {};
  if (candidate.version === 7 || candidate.version === 6 || candidate.version === 5) {
    if (!candidate.groups || typeof candidate.groups !== 'object') throw new Error('state file is missing groups');
    if (!candidate.catalog || typeof candidate.catalog !== 'object') throw new Error('state file is missing catalog');
    if (candidate.version === 7) {
      if (!Array.isArray(candidate.passwordlessUserIds)) throw new Error('state file is missing passwordlessUserIds');
      return { state: value as GrantState, changed: false };
    }
    if (candidate.version === 6 && !Array.isArray(candidate.passwordlessUserIds)) {
      throw new Error('state file is missing passwordlessUserIds');
    }
    // v5/v6 held per-user media claims (a missing registry is fine, it is discarded). Claimants
    // that already received access are ordinary manual users on their grants, so dropping the
    // claim registry keeps every grant intact.
    return {
      state: {
        version: 7,
        grants: candidate.grants as Record<string, GrantRecord>,
        groups: candidate.groups as Record<string, AccessGroup>,
        catalog: candidate.catalog as GrantState['catalog'],
        passwordlessUserIds: candidate.version === 6 ? candidate.passwordlessUserIds as string[] : [],
        ...handled,
      },
      changed: true,
    };
  }
  if (candidate.version === 4) {
    if (!candidate.groups || typeof candidate.groups !== 'object') throw new Error('state file is missing groups');
    if (!candidate.catalog || typeof candidate.catalog !== 'object') throw new Error('state file is missing catalog');
    return {
      state: {
        version: 7,
        grants: candidate.grants as Record<string, GrantRecord>,
        groups: candidate.groups as Record<string, AccessGroup>,
        catalog: candidate.catalog as GrantState['catalog'],
        passwordlessUserIds: [],
      },
      changed: true,
    };
  }
  if (candidate.version === 3) {
    if (!candidate.groups || typeof candidate.groups !== 'object') throw new Error('state file is missing groups');
    return {
      state: {
        version: 7,
        grants: candidate.grants as Record<string, GrantRecord>,
        groups: candidate.groups as Record<string, AccessGroup>,
        catalog: { items: {} },
        passwordlessUserIds: [],
      },
      changed: true,
    };
  }
  if (candidate.version === 2) {
    if (!candidate.groups || typeof candidate.groups !== 'object') throw new Error('state file is missing groups');
    const grants = Object.fromEntries(Object.entries(candidate.grants as Record<string, GrantRecord>).map(([itemId, grant]) => [
      itemId,
      { ...grant, manualUserIds: [] },
    ]));
    return { state: { version: 7, grants, groups: candidate.groups as Record<string, AccessGroup>, catalog: { items: {} }, passwordlessUserIds: [] }, changed: true };
  }
  if (candidate.version !== 1) throw new Error('unsupported state schema version');
  const now = new Date().toISOString();
  const grants: Record<string, GrantRecord> = {};
  for (const [itemId, raw] of Object.entries(candidate.grants as Record<string, Omit<GrantRecord, 'groupIds' | 'sync'>>)) {
    grants[itemId] = {
      ...raw,
      active: true,
      manualUserIds: [],
      groupIds: [],
      sync: { state: 'pending', attempts: 0 },
      updatedAt: raw.updatedAt || now,
    };
  }
  return { state: { version: 7, grants, groups: {}, catalog: { items: {} }, passwordlessUserIds: [] }, changed: true };
}
