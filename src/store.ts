import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccessGroup, GrantRecord, GrantState, LibraryCatalogItem, RevokeResult, SyncStatus } from './types.js';

const EMPTY_STATE: GrantState = { version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], handledRequestIds: [] };

export class GrantStore {
  readonly #file: string;
  #state: GrantState = structuredClone(EMPTY_STATE);
  /** The latest state-file write, started or queued; writes never overlap. */
  #writing: Promise<void> = Promise.resolve();
  /** A queued write that has not started yet; saves requested meanwhile share it. */
  #queued: Promise<void> | undefined;
  #closed = false;

  public constructor(file: string) {
    this.#file = file;
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
    // Requests already on grants (including ones recorded before handledRequestIds existed)
    // count as handled, so the backfill never re-imports one an administrator later removed.
    const handled = new Set(this.#state.handledRequestIds ?? []);
    const before = handled.size;
    for (const grant of Object.values(this.#state.grants)) Object.keys(grant.requests).forEach((id) => handled.add(id));
    const seeded = this.#state.handledRequestIds === undefined || handled.size !== before;
    if (seeded) this.#state.handledRequestIds = [...handled];
    if (migrated.changed || seeded) await this.#save();
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

  public resolveOwners(grant: GrantRecord): string[] {
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

  /** The grant that currently records a request, if any. */
  public findGrantForRequest(requestId: string): GrantRecord | undefined {
    const grant = Object.values(this.#state.grants).find((entry) => requestId in entry.requests);
    return grant ? clone(grant) : undefined;
  }

  /**
   * Adds a request to an item's grant. `groupIds` (the requester's households) are merged
   * into the grant's existing groups; groups and manual users already on the grant are kept.
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
    const requests = { ...(previous?.requests ?? {}), [input.requestId]: userId };
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
    const itemId = normalizeId(itemIdInput);
    const previous = this.#state.grants[itemId];
    if (!previous || !(requestId in previous.requests)) return undefined;
    const requests = { ...previous.requests };
    delete requests[requestId];
    const result = this.#replaceGrant(previous, requests, previous.manualUserIds, previous.groupIds);
    // Only this item: a copy of the request on another grant (a move's source or target) keeps its own access.
    const revokedFrom = this.#state.revokedRequests?.[requestId] ?? [];
    this.#state.revokedRequests = { ...this.#state.revokedRequests, [requestId]: [...new Set([...revokedFrom, itemId])].sort() };
    await this.#save();
    return result;
  }

  public async setGrantGroups(itemIdInput: string, groupIdsInput: string[]): Promise<RevokeResult> {
    this.#assertOpen();
    const itemId = normalizeId(itemIdInput);
    const previous = this.#state.grants[itemId];
    if (!previous) throw new Error(`grant not found: ${itemId}`);
    const groupIds = [...new Set(groupIdsInput.map(normalizeId))].sort();
    const missing = groupIds.filter((id) => !this.#state.groups[id]);
    if (missing.length > 0) throw new Error(`group not found: ${missing.join(', ')}`);
    const result = this.#replaceGrant(previous, previous.requests, previous.manualUserIds, groupIds);
    await this.#save();
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
      results.push({ ...(previous ? { previous: clone(previous) } : {}), current: clone(current) });
    }
    await this.#save();
    return results;
  }

  public async upsertGroup(input: { id: string; name: string; userIds: string[] }): Promise<AccessGroup> {
    this.#assertOpen();
    const id = normalizeId(input.id);
    const now = new Date().toISOString();
    const previous = this.#state.groups[id];
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
    const results: RevokeResult[] = [];
    for (const previous of Object.values({ ...this.#state.grants })) {
      if (!previous.groupIds.includes(groupId)) continue;
      results.push(this.#replaceGrant(previous, previous.requests, previous.manualUserIds, previous.groupIds.filter((id) => id !== groupId)));
    }
    await this.#save();
    return results;
  }

  public async markSyncSuccess(itemIdInput: string): Promise<void> {
    await this.markSyncSuccessBatch([itemIdInput]);
  }

  public async markSyncSuccessBatch(itemIds: string[]): Promise<void> {
    this.#assertOpen();
    const now = new Date().toISOString();
    let changed = false;
    for (const itemId of itemIds) {
      const grant = this.#state.grants[normalizeId(itemId)];
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
    let changed = false;
    for (const itemId of itemIds) {
      const grant = this.#state.grants[normalizeId(itemId)];
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

  /** Throws once close() has been called, so a caller can refuse before starting work it could not record. */
  public assertOpen(): void {
    this.#assertOpen();
  }

  /**
   * The grant an item would have after `move` is merged into it, without storing anything: requests, manual users and
   * groups are added to whatever grant the item already has (nothing on it is dropped). Groups that no longer exist and
   * requests an administrator revoked from that item are left out of the moved ones.
   */
  public previewMerge(move: GrantMove): GrantRecord {
    return clone(this.#mergedGrant(move));
  }

  /**
   * The first step of moving a grant: merges each move into its target item's grant (see previewMerge) in one write,
   * leaving the source grant as it is. A crash before the targets are applied therefore loses nobody: the targets are
   * stored (pending), the source still records everyone, and merging the same move again changes nothing. Moved
   * requests stay handled, so the backfill never re-imports them. Finish with retireMovedGrant once the targets are applied.
   */
  public async mergeGrants(fromItemIdInput: string, moves: GrantMove[]): Promise<GrantRecord[]> {
    this.#assertOpen();
    const fromItemId = normalizeId(fromItemIdInput);
    if (!this.#state.grants[fromItemId]) throw new Error(`grant not found: ${fromItemId}`);
    const targetIds = moves.map((move) => normalizeId(move.itemId));
    if (targetIds.length === 0 || targetIds.includes(fromItemId) || new Set(targetIds).size !== targetIds.length) {
      throw new Error('grant move targets are invalid');
    }
    const currents = moves.map((move) => this.#mergedGrant(move));
    for (const current of currents) this.#state.grants[current.itemId] = current;
    await this.#save();
    return currents.map(clone);
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

  #mergedGrant(move: GrantMove): GrantRecord {
    const itemId = normalizeId(move.itemId);
    const previous = this.#state.grants[itemId];
    const moved = Object.entries(move.requests).filter(([requestId]) => !this.isRequestRevoked(requestId, itemId));
    const requests = { ...(previous?.requests ?? {}), ...Object.fromEntries(moved) };
    const manualUserIds = [...new Set([...(previous?.manualUserIds ?? []), ...move.manualUserIds.map(normalizeId)])].sort();
    const movedGroupIds = move.groupIds.map(normalizeId).filter((id) => this.#state.groups[id]);
    const groupIds = [...new Set([...(previous?.groupIds ?? []), ...movedGroupIds])].sort();
    return this.#makeGrant(itemId, requests, manualUserIds, groupIds, previous, previous?.mediaType ?? move.mediaType);
  }

  #makeGrant(
    itemId: string,
    requests: Record<string, string>,
    manualUserIds: string[],
    groupIds: string[],
    previous?: GrantRecord,
    mediaType?: string,
  ): GrantRecord {
    const resolvedMediaType = mediaType ?? previous?.mediaType;
    const placeholder: GrantRecord = {
      itemId,
      active: Object.keys(requests).length > 0 || manualUserIds.length > 0 || groupIds.length > 0,
      owners: [],
      requests,
      manualUserIds: [...manualUserIds],
      groupIds: [...groupIds],
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
  ): RevokeResult {
    const next = this.#makeGrant(previous.itemId, requests, manualUserIds, groupIds, previous, previous.mediaType);
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

function clone<T>(value: T): T {
  return structuredClone(value);
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
