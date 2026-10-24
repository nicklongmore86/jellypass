import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AccessGroup,
  AccessRemovals,
  AppQuotaLedger,
  AppRequestRecord,
  AppRequestStatus,
  GrantRecord,
  GrantState,
  LibraryCatalogItem,
  LibraryJoin,
  RevokeResult,
  SyncStatus,
} from './types.js';

/**
 * The most households (groups) JellyPass supports. Creating another is refused; the household app keeps one cache
 * partition and one TMDB queue per household, sized for this many (see docs/app-design.md, "Shared upstreams").
 */
export const MAX_HOUSEHOLDS = 100;
/**
 * Settled household app "Get this" records (completed, declined or deleted) are kept for this long after they were made
 * (see GrantStore.writeAppRequests); pending records are never pruned, and failed ones are kept this long too.
 */
export const APP_REQUEST_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
/** The most settled "Get this" records kept per household; its own oldest are pruned first. Pending ones are never. */
export const MAX_APP_REQUESTS_PER_HOUSEHOLD = 2000;
/**
 * A pruned virtual request's own creation time is kept (AppQuotaLedger `entries`) for this long; older ones are summed.
 * Quota windows up to this long, and lifetime quotas, are therefore counted exactly.
 */
export const APP_QUOTA_HORIZON_MS = 400 * 24 * 60 * 60 * 1000;
/** The most ledger entries kept per member and media type; beyond it the oldest are summed too. */
export const MAX_APP_QUOTA_ENTRIES = 10_000;

const EMPTY_STATE: GrantState = { version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], handledRequestIds: [] };

export class GrantStore {
  readonly #file: string;
  #state: GrantState = structuredClone(EMPTY_STATE);
  /** The latest state-file write, started or queued; writes never overlap. */
  #writing: Promise<void> = Promise.resolve();
  /** A queued write that has not started yet; saves requested meanwhile share it. */
  #queued: Promise<void> | undefined;
  #closed = false;
  /** Each household's epoch (see householdEpoch); memory only. */
  readonly #epochs = new Map<string, number>();
  #nextEpoch = 1;
  /** Seerr requests "Get this" made whose records are not written yet (see holdAppRequest); memory only. */
  readonly #unsettledAppRequests = new Map<string, number>();
  /** "Get this" record IDs by household and by member, rebuilt after each change (see #appIndex). */
  #appIndexCache: { byHousehold: Map<string, string[]>; byUser: Map<string, string[]> } | undefined;

  public constructor(file: string) {
    this.#file = file;
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

  public resolveOwners(grant: Pick<GrantRecord, 'requests' | 'manualUserIds' | 'groupIds'>): string[] {
    const groupUsers = grant.groupIds.flatMap((id) => this.#state.groups[id]?.userIds ?? []);
    return [...new Set([...Object.values(grant.requests), ...grant.manualUserIds, ...groupUsers].map(normalizeId))].sort();
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
    await this.#save();
    return clone(next);
  }

  public async revokeRequest(itemIdInput: string, requestId: string): Promise<RevokeResult | undefined> {
    this.#assertOpen();
    const result = this.#revokeRequest(itemIdInput, requestId);
    if (result) await this.#save();
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
    if (!previous && this.countGroups() >= MAX_HOUSEHOLDS) throw new Error(`groups must be at most ${MAX_HOUSEHOLDS}`);
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
    this.#epochs.delete(groupId);
    this.#appIndexCache = undefined;
    // A group created later under the same ID is a different household and starts unmarked.
    for (const [itemId, removals] of Object.entries(this.#state.removedAccess ?? {})) {
      if (removals.groupIds?.includes(groupId)) this.#setRemovals(itemId, { ...removals, groupIds: removals.groupIds.filter((id) => id !== groupId) });
    }
    // Its "Get this" records stay counted towards their members' quotas, but no household sees or joins them again.
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

  /**
   * One household's "Get this" records (detached ones included), from an index: the work depends on that household's
   * own records only, never on how many other households have.
   */
  public listAppRequestsForHousehold(householdId: string): Array<[string, AppRequestRecord]> {
    return this.#indexed(this.#appIndex().byHousehold.get(normalizeId(householdId)));
  }

  /** One member's "Get this" records, in every household (detached ones included), from an index. */
  public listAppRequestsForUser(userId: string): Array<[string, AppRequestRecord]> {
    return this.#indexed(this.#appIndex().byUser.get(normalizeId(userId)));
  }

  /**
   * The units of a member's pruned virtual requests for `mediaType` made after `windowStart` (ms since the epoch;
   * -Infinity for a lifetime quota), from their AppQuotaLedger: exact for the entries; the summed older ones count in
   * full unless the window starts after the newest of them (a window that starts among them counts them all: stricter,
   * never looser, and only for windows longer than APP_QUOTA_HORIZON_MS).
   */
  public prunedAppQuotaUnits(userId: string, mediaType: 'movie' | 'tv', windowStart: number): number {
    const ledger = this.#state.appQuotaLedger?.[normalizeId(userId)]?.[mediaType];
    if (!ledger) return 0;
    let units = 0;
    for (const [createdAt, count] of ledger.entries) if (createdAt > windowStart) units += count;
    if (ledger.older && ledger.older.newest > windowStart) units += ledger.older.units;
    return units;
  }

  /** The key the household app derives opaque IDs from, or undefined before the first "Get this" record. */
  public getAppIdKey(): string | undefined {
    return this.#state.appIdKey;
  }

  /**
   * A number that identifies this household for as long as it exists: a household deleted and created again under the
   * same ID has another. Undefined when there is no such household. Memory only: a "Get this" never outlives the
   * process, and a household deleted while JellyPass was down detached its records in the same write.
   */
  public householdEpoch(householdId: string): number | undefined {
    const id = normalizeId(householdId);
    if (!this.#state.groups[id]) return undefined;
    let epoch = this.#epochs.get(id);
    if (epoch === undefined) {
      epoch = this.#nextEpoch++;
      this.#epochs.set(id, epoch);
    }
    return epoch;
  }

  /**
   * Notes that "Get this" made Seerr request `requestId` and has not written its record yet, until the matching
   * releaseAppRequest: a grant for it meanwhile follows the library join rules (see GrantStore.isAppRequestUnsettled).
   */
  public holdAppRequest(requestId: string): void {
    this.#unsettledAppRequests.set(requestId, (this.#unsettledAppRequests.get(requestId) ?? 0) + 1);
  }

  public releaseAppRequest(requestId: string): void {
    const count = (this.#unsettledAppRequests.get(requestId) ?? 0) - 1;
    if (count > 0) this.#unsettledAppRequests.set(requestId, count);
    else this.#unsettledAppRequests.delete(requestId);
  }

  /** Whether "Get this" made `requestId` and has not written its record yet (see holdAppRequest). */
  public isAppRequestUnsettled(requestId: string): boolean {
    return this.#unsettledAppRequests.has(requestId);
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
   * Adds household app "Get this" records and changes the status (and joined items or ready seasons) of existing ones,
   * in one write. Records added with a `householdEpoch` other than their household's current one (it was deleted, or
   * deleted and created again, while the call ran) are added detached. Then settled records are pruned (see
   * pruneAppRequests): never a pending one, and a counted one only into its member's AppQuotaLedger, so no quota count
   * changes. The state changes before this returns its promise, so a caller can update what it keeps in memory in the
   * same turn. Resolves with the IDs of the added records.
   */
  public async writeAppRequests(input: {
    add?: AppRequestRecord[];
    householdEpoch?: number;
    update?: Array<{ id: string; status: AppRequestStatus; itemIds?: string[]; readySeasons?: number[] }>;
  }): Promise<string[]> {
    this.#assertOpen();
    const now = new Date().toISOString();
    const records = { ...this.#state.appRequests };
    const added = (input.add ?? []).map((record) => {
      const id = randomUUID();
      const stale = input.householdEpoch !== undefined && this.householdEpoch(record.householdId) !== input.householdEpoch;
      records[id] = stale ? { ...clone(record), detached: true } : clone(record);
      return id;
    });
    for (const change of input.update ?? []) {
      const record = records[change.id];
      if (!record) continue;
      records[change.id] = {
        ...record,
        status: change.status,
        updatedAt: now,
        ...(change.itemIds ? { itemIds: [...new Set([...(record.itemIds ?? []), ...change.itemIds.map(normalizeId)])].sort() } : {}),
        ...(change.readySeasons ? { readySeasons: [...new Set(change.readySeasons)].sort((left, right) => left - right) } : {}),
      };
    }
    const ledger = clone(this.#state.appQuotaLedger ?? {});
    this.#state.appRequests = pruneAppRequests(records, ledger, Date.now());
    if (Object.keys(ledger).length > 0) this.#state.appQuotaLedger = ledger;
    this.#state.appIdKey ??= randomBytes(32).toString('hex');
    this.#appIndexCache = undefined;
    await this.#save();
    return added;
  }

  #indexed(ids: string[] | undefined): Array<[string, AppRequestRecord]> {
    const records = this.#state.appRequests ?? {};
    return (ids ?? []).flatMap((id) => records[id] ? [[id, clone(records[id])] as [string, AppRequestRecord]] : []);
  }

  #appIndex(): { byHousehold: Map<string, string[]>; byUser: Map<string, string[]> } {
    if (this.#appIndexCache) return this.#appIndexCache;
    const index = { byHousehold: new Map<string, string[]>(), byUser: new Map<string, string[]>() };
    for (const [id, record] of Object.entries(this.#state.appRequests ?? {})) {
      index.byHousehold.set(record.householdId, [...index.byHousehold.get(record.householdId) ?? [], id]);
      index.byUser.set(record.jellyfinUserId, [...index.byUser.get(record.jellyfinUserId) ?? [], id]);
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
    try {
      await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#file);
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
 * See GrantStore.writeAppRequests. A pending record is never pruned (it is still being followed), nor a failed one
 * younger than APP_REQUEST_RETENTION_MS (a failed request can be retried). Settled records (completed, declined,
 * deleted) are kept for APP_REQUEST_RETENTION_MS, at most MAX_APP_REQUESTS_PER_HOUSEHOLD of them per household (its own
 * newest; one household's volume never prunes another's); failed ones past the retention go too. A pruned record that
 * still counts as a virtual request (a join or interest neither declined nor deleted) moves its creation time and units
 * to its member's ledger, so every quota count stays the same. Changes `ledger` in place.
 */
function pruneAppRequests(
  records: Record<string, AppRequestRecord>,
  ledger: Record<string, AppQuotaLedger>,
  now: number,
): Record<string, AppRequestRecord> {
  const kept: Array<[string, AppRequestRecord]> = [];
  const settled: Array<[string, AppRequestRecord]> = [];
  for (const entry of Object.entries(records)) {
    const [, record] = entry;
    const old = now - Date.parse(record.createdAt) > APP_REQUEST_RETENTION_MS;
    if (record.status === 'pending' || (record.status === 'failed' && !old)) kept.push(entry);
    else settled.push(entry);
  }
  const perHousehold = new Map<string, number>();
  settled.sort(([, left], [, right]) => right.createdAt.localeCompare(left.createdAt));
  for (const entry of settled) {
    const [, record] = entry;
    const count = (perHousehold.get(record.householdId) ?? 0) + 1;
    perHousehold.set(record.householdId, count);
    const old = now - Date.parse(record.createdAt) > APP_REQUEST_RETENTION_MS;
    if (record.status !== 'failed' && !old && count <= MAX_APP_REQUESTS_PER_HOUSEHOLD) {
      kept.push(entry);
      continue;
    }
    if (record.branch !== 'request' && record.status !== 'declined' && record.status !== 'deleted') {
      const userLedger = ledger[record.jellyfinUserId] ??= {};
      const media = userLedger[record.mediaType] ??= { entries: [] };
      media.entries.push([Date.parse(record.createdAt), record.mediaType === 'movie' ? 1 : record.seasons.length]);
    }
  }
  for (const userLedger of Object.values(ledger)) {
    for (const media of Object.values(userLedger)) {
      media.entries.sort(([left], [right]) => left - right);
      // Summed once past the horizon, and beyond the entry cap (the oldest first).
      let cut = media.entries.findIndex(([createdAt]) => now - createdAt <= APP_QUOTA_HORIZON_MS);
      if (cut < 0) cut = media.entries.length;
      cut = Math.max(cut, media.entries.length - MAX_APP_QUOTA_ENTRIES);
      for (const [createdAt, units] of media.entries.splice(0, cut)) {
        media.older = media.older
          ? { units: media.older.units + units, oldest: Math.min(media.older.oldest, createdAt), newest: Math.max(media.older.newest, createdAt) }
          : { units, oldest: createdAt, newest: createdAt };
      }
    }
  }
  return Object.fromEntries(kept);
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
