import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccessGroup, GrantRecord, GrantState, LibraryCatalogItem, MediaClaim, RevokeResult, SyncStatus } from './types.js';

const EMPTY_STATE: GrantState = { version: 5, grants: {}, groups: {}, catalog: { items: {} }, claims: {} };

export class GrantStore {
  readonly #file: string;
  #state: GrantState = structuredClone(EMPTY_STATE);

  public constructor(file: string) {
    this.#file = file;
  }

  public async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as unknown;
      const migrated = migrateState(parsed);
      this.#state = migrated.state;
      if (migrated.changed) await this.#save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.#save();
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

  public getGroup(groupId: string): AccessGroup | undefined {
    const group = this.#state.groups[normalizeId(groupId)];
    return group ? clone(group) : undefined;
  }

  public getCatalog(): { lastSyncedAt?: string; items: LibraryCatalogItem[] } {
    return {
      ...(this.#state.catalog.lastSyncedAt ? { lastSyncedAt: this.#state.catalog.lastSyncedAt } : {}),
      items: Object.values(this.#state.catalog.items).map(clone),
    };
  }

  public getClaim(mediaType: 'movie' | 'tv', tmdbId: number): MediaClaim | undefined {
    const claim = this.#state.claims[claimKey(mediaType, tmdbId)];
    return claim ? clone(claim) : undefined;
  }

  public listClaims(userId?: string): MediaClaim[] {
    const normalizedUserId = userId ? normalizeId(userId) : undefined;
    return Object.values(this.#state.claims)
      .filter((claim) => !normalizedUserId || claim.userIds.includes(normalizedUserId))
      .map(clone);
  }

  public async addClaim(input: {
    mediaType: 'movie' | 'tv';
    tmdbId: number;
    userId: string;
    jellyfinItemId?: string;
  }): Promise<MediaClaim> {
    const key = claimKey(input.mediaType, input.tmdbId);
    const previous = this.#state.claims[key];
    const claim: MediaClaim = {
      mediaType: input.mediaType,
      tmdbId: input.tmdbId,
      userIds: [...new Set([...(previous?.userIds ?? []), normalizeId(input.userId)])].sort(),
      ...(input.jellyfinItemId || previous?.jellyfinItemId
        ? { jellyfinItemId: normalizeId(input.jellyfinItemId ?? previous!.jellyfinItemId!) }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    this.#state.claims[key] = claim;
    await this.#save();
    return clone(claim);
  }

  public async replaceCatalog(items: LibraryCatalogItem[]): Promise<{ lastSyncedAt: string; items: LibraryCatalogItem[] }> {
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

  /** Whether two Jellyfin users are the same user or share membership in at least one access group. */
  public shareHousehold(userIdA: string, userIdB: string): boolean {
    const a = normalizeId(userIdA);
    const b = normalizeId(userIdB);
    if (a === b) return true;
    return Object.values(this.#state.groups).some((group) => group.userIds.includes(a) && group.userIds.includes(b));
  }

  public async grant(input: {
    itemId: string;
    mediaType?: string;
    tmdbId?: number;
    requestId: string;
    userId: string;
  }): Promise<GrantRecord> {
    const itemId = normalizeId(input.itemId);
    const userId = normalizeId(input.userId);
    const previous = this.#state.grants[itemId];
    const requests = { ...(previous?.requests ?? {}), [input.requestId]: userId };
    const claim = input.tmdbId !== undefined && (input.mediaType === 'movie' || input.mediaType === 'tv')
      ? this.#state.claims[claimKey(input.mediaType, input.tmdbId)]
      : undefined;
    // Only join in claimants who share a household with the verified requester; an unrelated
    // household's earlier claim for the same title must not silently ride along on this grant.
    const householdClaimants = (claim?.userIds ?? []).filter((claimant) => this.shareHousehold(claimant, userId));
    const manualUserIds = [...new Set([...(previous?.manualUserIds ?? []), ...householdClaimants])].sort();
    const next = this.#makeGrant(itemId, requests, manualUserIds, previous?.groupIds ?? [], previous, input.mediaType);
    this.#state.grants[itemId] = next;
    if (claim) {
      claim.jellyfinItemId = itemId;
      claim.updatedAt = new Date().toISOString();
    }
    await this.#save();
    return clone(next);
  }

  public async revokeRequest(itemIdInput: string, requestId: string): Promise<RevokeResult | undefined> {
    const itemId = normalizeId(itemIdInput);
    const previous = this.#state.grants[itemId];
    if (!previous || !(requestId in previous.requests)) return undefined;
    const requests = { ...previous.requests };
    delete requests[requestId];
    return this.#replaceOrDelete(previous, requests, previous.manualUserIds, previous.groupIds);
  }

  public async setGrantGroups(itemIdInput: string, groupIdsInput: string[]): Promise<RevokeResult> {
    const itemId = normalizeId(itemIdInput);
    const previous = this.#state.grants[itemId];
    if (!previous) throw new Error(`grant not found: ${itemId}`);
    const groupIds = [...new Set(groupIdsInput.map(normalizeId))].sort();
    const missing = groupIds.filter((id) => !this.#state.groups[id]);
    if (missing.length > 0) throw new Error(`group not found: ${missing.join(', ')}`);
    return this.#replaceOrDelete(previous, previous.requests, previous.manualUserIds, groupIds);
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
    const groupId = normalizeId(groupIdInput);
    if (!this.#state.groups[groupId]) return [];
    delete this.#state.groups[groupId];
    const results: RevokeResult[] = [];
    for (const previous of Object.values({ ...this.#state.grants })) {
      if (!previous.groupIds.includes(groupId)) continue;
      results.push(await this.#replaceOrDelete(previous, previous.requests, previous.manualUserIds, previous.groupIds.filter((id) => id !== groupId), false));
    }
    await this.#save();
    return results;
  }

  public async markSyncSuccess(itemIdInput: string): Promise<void> {
    await this.markSyncSuccessBatch([itemIdInput]);
  }

  public async markSyncSuccessBatch(itemIds: string[]): Promise<void> {
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
    const itemId = normalizeId(itemIdInput);
    const grant = this.#state.grants[itemId];
    if (!grant || grant.active) return;
    delete this.#state.grants[itemId];
    await this.#save();
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
    placeholder.owners = this.resolveOwners(placeholder);
    return placeholder;
  }

  async #replaceOrDelete(
    previous: GrantRecord,
    requests: Record<string, string>,
    manualUserIds: string[],
    groupIds: string[],
    save = true,
  ): Promise<RevokeResult> {
    const next = this.#makeGrant(previous.itemId, requests, manualUserIds, groupIds, previous, previous.mediaType);
    this.#state.grants[previous.itemId] = next;
    if (save) await this.#save();
    return { previous: clone(previous), current: clone(next) };
  }

  async #save(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
  }
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function migrateState(value: unknown): { state: GrantState; changed: boolean } {
  if (!value || typeof value !== 'object') throw new Error('state file must be a JSON object');
  const candidate = value as { version?: unknown; grants?: unknown; groups?: unknown; catalog?: unknown; claims?: unknown };
  if (!candidate.grants || typeof candidate.grants !== 'object') throw new Error('state file is missing grants');
  if (candidate.version === 5) {
    if (!candidate.groups || typeof candidate.groups !== 'object') throw new Error('state file is missing groups');
    if (!candidate.catalog || typeof candidate.catalog !== 'object') throw new Error('state file is missing catalog');
    if (!candidate.claims || typeof candidate.claims !== 'object') throw new Error('state file is missing claims');
    return { state: value as GrantState, changed: false };
  }
  if (candidate.version === 4) {
    if (!candidate.groups || typeof candidate.groups !== 'object') throw new Error('state file is missing groups');
    if (!candidate.catalog || typeof candidate.catalog !== 'object') throw new Error('state file is missing catalog');
    return {
      state: {
        version: 5,
        grants: candidate.grants as Record<string, GrantRecord>,
        groups: candidate.groups as Record<string, AccessGroup>,
        catalog: candidate.catalog as GrantState['catalog'],
        claims: {},
      },
      changed: true,
    };
  }
  if (candidate.version === 3) {
    if (!candidate.groups || typeof candidate.groups !== 'object') throw new Error('state file is missing groups');
    return {
      state: {
        version: 5,
        grants: candidate.grants as Record<string, GrantRecord>,
        groups: candidate.groups as Record<string, AccessGroup>,
        catalog: { items: {} },
        claims: {},
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
    return { state: { version: 5, grants, groups: candidate.groups as Record<string, AccessGroup>, catalog: { items: {} }, claims: {} }, changed: true };
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
  return { state: { version: 5, grants, groups: {}, catalog: { items: {} }, claims: {} }, changed: true };
}

function claimKey(mediaType: 'movie' | 'tv', tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}
