import type { JellyfinClient } from './jellyfin.js';
import { Metrics } from './metrics.js';
import type { SeerrClient } from './seerr.js';
import { normalizeId, type GrantStore } from './store.js';
import type {
  AccessGroup,
  ChangePlan,
  GrantRecord,
  JellyfinItem,
  JellyfinUser,
  LibraryCatalogItem,
  LibraryItemSummary,
  MediaAccessStatus,
  MediaClaim,
  RecentSeerrRequest,
  RevokeResult,
  SeerrWebhook,
} from './types.js';

export const TAG_PREFIX = 'jfa:private:';

interface PlanContext {
  plan: ChangePlan;
  item: JellyfinItem;
  relatedItems: JellyfinItem[];
  users: JellyfinUser[];
}

export class UserProvisioningError extends Error {
  public constructor(
    public readonly user: { id: string; name: string },
    public readonly stage: 'household' | 'jellyseerr',
    public readonly group: AccessGroup | undefined,
    cause: unknown,
  ) {
    super(stage === 'household'
      ? 'Jellyfin user was created, but household assignment did not finish. Refresh the group and review its membership.'
      : 'Jellyfin user was created and assigned to the household, but Jellyseerr import failed. Import the user from Jellyseerr or try again there.');
    this.cause = cause;
  }
}

export class AccessService {
  readonly #jellyfin: JellyfinClient;
  readonly #store: GrantStore;
  readonly #metrics: Metrics;
  readonly #seerr: SeerrClient | undefined;
  #queue: Promise<void> = Promise.resolve();

  public constructor(jellyfin: JellyfinClient, store: GrantStore, metrics = new Metrics(), seerr?: SeerrClient) {
    this.#jellyfin = jellyfin;
    this.#store = store;
    this.#metrics = metrics;
    this.#seerr = seerr;
    this.#refreshGauges();
  }

  public listGrants(): GrantRecord[] {
    return this.#store.list();
  }

  public listGroups(): AccessGroup[] {
    return this.#store.listGroups();
  }

  public getHouseholdMemberIds(groupId: string): string[] | undefined {
    return this.#store.getGroup(groupId)?.userIds;
  }

  public async listUsers(): Promise<Array<{ id: string; name: string; isAdministrator: boolean }>> {
    const users = await this.#jellyfin.getUsers();
    return users
      .map((user) => ({
        id: user.Id,
        name: user.Name,
        isAdministrator: user.Policy.IsAdministrator === true,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public canImportJellyfinUsersToSeerr(): boolean {
    return Boolean(this.#seerr);
  }

  public async hasJellyseerrUser(jellyfinUserId: string): Promise<boolean> {
    if (!this.#seerr) throw new Error('Jellyseerr user lookup is not configured');
    return this.#seerr.hasJellyfinUser(jellyfinUserId);
  }

  public createUserInGroup(input: { username: string; password: string; groupId: string; importToJellyseerr?: boolean }): Promise<{
    user: { id: string; name: string; isAdministrator: false };
    group: AccessGroup;
    jellyseerr: { status: 'not_requested' | 'imported' | 'already_imported'; userId?: number };
  }> {
    return this.#exclusive(async () => {
      if (input.importToJellyseerr && !this.#seerr) throw new Error('Jellyseerr user import is not configured');
      const group = this.#store.getGroup(input.groupId);
      if (!group) throw new Error(`group not found: ${input.groupId}`);
      const users = await this.#jellyfin.getUsers();
      if (users.some((user) => user.Name.localeCompare(input.username, undefined, { sensitivity: 'accent' }) === 0)) {
        throw new Error('username is already in use');
      }

      const created = await this.#jellyfin.createUser(input.username, input.password);
      const user = { id: created.Id, name: created.Name, isAdministrator: false as const };
      if (!created.Id || !created.Name || created.Policy?.IsAdministrator === true) {
        throw new UserProvisioningError(user, 'household', undefined, new Error('Jellyfin returned an invalid non-administrator user'));
      }
      let updatedGroup: AccessGroup;
      try {
        if (created.Policy.IsHidden !== false) {
          created.Policy = { ...created.Policy, IsHidden: false };
          await this.#jellyfin.updatePolicy(created.Id, created.Policy);
        }
        updatedGroup = await this.#store.upsertGroup({
          id: group.id,
          name: group.name,
          userIds: [...group.userIds, created.Id],
        });
        await this.#reconcileReferencingGroup(updatedGroup.id);
      } catch (error) {
        throw new UserProvisioningError(user, 'household', undefined, error);
      }

      if (!input.importToJellyseerr) return { user, group: updatedGroup, jellyseerr: { status: 'not_requested' } };
      try {
        const imported = await this.#seerr!.importJellyfinUser(created.Id);
        return {
          user,
          group: updatedGroup,
          jellyseerr: {
            status: imported.status,
            ...(imported.user?.id !== undefined ? { userId: imported.user.id } : {}),
          },
        };
      } catch (error) {
        throw new UserProvisioningError(user, 'jellyseerr', updatedGroup, error);
      }
    });
  }

  public searchLibrary(query: string): Promise<LibraryItemSummary[]> {
    return this.#jellyfin.searchLibrary(query);
  }

  public listRecentRequests(take = 8): Promise<RecentSeerrRequest[]> {
    const catalogIds = new Set(this.#store.getCatalog().items.map((item) => normalizeId(item.id)));
    return this.#seerr?.getRecentRequests(take, catalogIds) ?? Promise.resolve([]);
  }

  public getMediaAccess(
    userIdInput: string,
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    jellyfinItemId?: string,
  ): MediaAccessStatus {
    const userId = normalizeId(userIdInput);
    const claim = this.#store.getClaim(mediaType, tmdbId);
    const itemId = jellyfinItemId ? normalizeId(jellyfinItemId) : claim?.jellyfinItemId;
    const grant = itemId ? this.#store.get(itemId) : undefined;
    const managed = grant?.active === true;
    return {
      mediaType,
      tmdbId,
      claimed: claim?.userIds.includes(userId) === true,
      managed,
      owned: managed && grant!.owners.includes(userId),
      public: Boolean(itemId) && !managed,
      ...(itemId ? { jellyfinItemId: itemId } : {}),
    };
  }

  public listMediaClaims(userId: string): MediaClaim[] {
    return this.#store.listClaims(userId);
  }

  public claimMediaAccess(
    userIdInput: string,
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    jellyfinItemId?: string,
  ): Promise<MediaAccessStatus> {
    return this.#exclusive(async () => {
      const userId = normalizeId(userIdInput);
      const users = await this.#jellyfin.getUsers();
      if (!users.some((user) => normalizeId(user.Id) === userId && !user.Policy.IsAdministrator)) {
        throw new Error('Jellyfin user is not eligible for self-service access');
      }
      const claim = await this.#store.addClaim({ mediaType, tmdbId, userId, ...(jellyfinItemId ? { jellyfinItemId } : {}) });
      const itemId = jellyfinItemId ? normalizeId(jellyfinItemId) : claim.jellyfinItemId;
      const grant = itemId ? this.#store.get(itemId) : undefined;
      // A claim only auto-joins an already-managed title when the claimant shares a household
      // with an existing owner; otherwise this would let any Jellyfin user unlock media another
      // household privately restricted just by knowing it's already been requested. With no
      // existing owners there is nothing to protect yet, so a first claim is always recorded.
      const eligibleToJoin = grant?.owners.length === 0
        || grant?.owners.some((owner) => this.#store.shareHousehold(userId, owner));
      if (itemId && grant?.active && !grant.owners.includes(userId) && eligibleToJoin) {
        const updated = await this.#store.setManualAccess({
          itemId,
          mediaType: grant.mediaType ?? mediaType,
          userIds: [...grant.manualUserIds, userId],
          groupIds: grant.groupIds,
        });
        await this.#reconcileGrant(updated.current);
      }
      return this.getMediaAccess(userId, mediaType, tmdbId, itemId);
    });
  }

  public getRequestPoster(posterPath: string): Promise<{ body: Uint8Array; contentType: string }> {
    if (!this.#seerr) throw new Error('Seerr lookup is not configured');
    return this.#seerr.getPoster(posterPath);
  }

  public getLibraryPoster(itemId: string): Promise<{ body: Uint8Array; contentType: string }> {
    const exists = this.#store.getCatalog().items.some((item) => normalizeId(item.id) === normalizeId(itemId));
    if (!exists) throw new Error(`catalog item not found: ${normalizeId(itemId)}`);
    return this.#jellyfin.getItemPoster(itemId);
  }

  public getLibraryCatalog(): { lastSyncedAt?: string; items: Array<LibraryCatalogItem & { managed: boolean; managedAt?: string }> } {
    const catalog = this.#store.getCatalog();
    const grants = new Map(this.#store.list().filter((grant) => grant.active).map((grant) => [normalizeId(grant.itemId), grant]));
    return {
      ...(catalog.lastSyncedAt ? { lastSyncedAt: catalog.lastSyncedAt } : {}),
      items: catalog.items.map((item) => {
        const grant = grants.get(normalizeId(item.id));
        return { ...item, managed: Boolean(grant), ...(grant ? { managedAt: grant.updatedAt } : {}) };
      }),
    };
  }

  public syncLibraryCatalog(): Promise<{ lastSyncedAt: string; items: Array<LibraryCatalogItem & { managed: boolean; managedAt?: string }> }> {
    return this.#exclusive(async () => {
      const catalog = await this.#store.replaceCatalog(await this.#jellyfin.fetchLibraryCatalog());
      const grants = new Map(this.#store.list().filter((grant) => grant.active).map((grant) => [normalizeId(grant.itemId), grant]));
      return { ...catalog, items: catalog.items.map((item) => {
        const grant = grants.get(normalizeId(item.id));
        return { ...item, managed: Boolean(grant), ...(grant ? { managedAt: grant.updatedAt } : {}) };
      }) };
    });
  }

  public renderMetrics(): string {
    this.#refreshGauges();
    return this.#metrics.render();
  }

  public processWebhook(event: SeerrWebhook): Promise<GrantRecord | null> {
    return this.#exclusive(async () => {
      if (event.notificationType !== 'MEDIA_AVAILABLE') {
        this.#metrics.increment('jfa_webhooks_total', { result: 'ignored' });
        return null;
      }
      const resolved = await this.#resolveWebhook(event);
      const grant = await this.#store.grant({
        itemId: resolved.itemId,
        requestId: event.request.id,
        userId: resolved.userId,
        ...(resolved.mediaType ? { mediaType: resolved.mediaType } : {}),
        ...(resolved.tmdbId !== undefined ? { tmdbId: resolved.tmdbId } : {}),
      });
      try {
        await this.#reconcileGrant(grant);
        this.#metrics.increment('jfa_webhooks_total', { result: 'granted' });
      } catch (error) {
        this.#metrics.increment('jfa_webhooks_total', { result: 'error' });
        throw error;
      }
      return this.#store.get(grant.itemId) ?? grant;
    });
  }

  async #resolveWebhook(event: SeerrWebhook): Promise<{ itemId: string; userId: string; mediaType?: string; tmdbId?: number }> {
    let itemId = event.media?.jellyfinMediaId;
    let userId = event.request.requestedBy?.jellyfinUserId;
    let mediaType = event.media?.mediaType;
    let tmdbId = event.media?.tmdbId;

    if ((!itemId || !userId || tmdbId === undefined) && this.#seerr) {
      const request = await this.#seerr.getRequest(event.request.id);
      itemId = request.is4k
        ? request.media?.jellyfinMediaId4k ?? request.media?.jellyfinMediaId
        : request.media?.jellyfinMediaId;
      userId = request.requestedBy?.jellyfinUserId;
      mediaType ??= request.media?.mediaType ?? request.type;
      tmdbId ??= request.media?.tmdbId;
    }

    if ((!itemId || !userId) && !this.#seerr) {
      throw new Error('webhook is missing Jellyfin IDs and Seerr lookup is not configured');
    }
    if (!itemId) throw new Error(`Seerr request ${event.request.id} is missing a Jellyfin media ID`);
    if (!userId) throw new Error(`Seerr request ${event.request.id} is missing a Jellyfin user ID`);
    return { itemId, userId, ...(mediaType ? { mediaType } : {}), ...(tmdbId !== undefined ? { tmdbId } : {}) };
  }

  public reconcileAll(options: { dryRun?: boolean; dueOnly?: boolean } = {}): Promise<ChangePlan[]> {
    return this.#exclusive(async () => {
      const plans: ChangePlan[] = [];
      const errors: Error[] = [];
      for (const grant of this.#store.list()) {
        if (options.dueOnly && !isDue(grant)) continue;
        try {
          if (options.dryRun) plans.push((await this.#buildPlan(grant)).plan);
          else {
            const plan = await this.#reconcileGrant(grant);
            plans.push(plan);
          }
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${errors.length} grant reconciliation(s) failed`);
      }
      return plans;
    });
  }

  public planGrant(itemId: string): Promise<ChangePlan> {
    return this.#exclusive(async () => {
      const grant = this.#store.get(itemId);
      if (!grant) throw new Error(`grant not found: ${normalizeId(itemId)}`);
      return (await this.#buildPlan(grant)).plan;
    });
  }

  public revokeRequest(itemId: string, requestId: string, dryRun = false): Promise<RevokeResult & { plan: ChangePlan }> {
    return this.#exclusive(async () => {
      const existing = this.#store.get(itemId);
      if (!existing || !(requestId in existing.requests)) throw new Error('request grant not found');
      if (dryRun) {
        const hypothetical = hypotheticalRevocation(existing, requestId, this.#store);
        return { previous: existing, current: hypothetical, plan: (await this.#buildPlan(hypothetical)).plan };
      }
      const result = await this.#store.revokeRequest(itemId, requestId);
      if (!result) throw new Error('request grant not found');
      const plan = await this.#reconcileGrant(result.current);
      return { ...result, plan };
    });
  }

  public setGrantGroups(itemId: string, groupIds: string[], dryRun = false): Promise<RevokeResult & { plan: ChangePlan }> {
    return this.#exclusive(async () => {
      if (dryRun) {
        const existing = this.#store.get(itemId);
        if (!existing) throw new Error(`grant not found: ${normalizeId(itemId)}`);
        const missing = groupIds.filter((id) => !this.#store.getGroup(id));
        if (missing.length > 0) throw new Error(`group not found: ${missing.join(', ')}`);
        const hypothetical = { ...existing, groupIds: [...new Set(groupIds.map(normalizeId))] };
        hypothetical.owners = this.#store.resolveOwners(hypothetical);
        hypothetical.active = Object.keys(hypothetical.requests).length > 0 || hypothetical.manualUserIds.length > 0 || hypothetical.groupIds.length > 0;
        return { previous: existing, current: hypothetical, plan: (await this.#buildPlan(hypothetical)).plan };
      }
      const result = await this.#store.setGrantGroups(itemId, groupIds);
      const plan = await this.#reconcileGrant(result.current);
      return { ...result, plan };
    });
  }

  public setManualAccess(input: {
    itemId: string;
    mediaType?: string;
    userIds: string[];
    groupIds: string[];
  }, dryRun = false): Promise<{ previous?: GrantRecord; current: GrantRecord; plan: ChangePlan }> {
    return this.#exclusive(async () => {
      const userIds = [...new Set(input.userIds.map(normalizeId))].sort();
      const groupIds = [...new Set(input.groupIds.map(normalizeId))].sort();
      await this.#validateManualAudience(userIds, groupIds);
      const previous = this.#store.get(input.itemId);
      const mediaType = input.mediaType ?? previous?.mediaType;
      const current: GrantRecord = {
        itemId: normalizeId(input.itemId),
        active: Object.keys(previous?.requests ?? {}).length > 0 || userIds.length > 0 || groupIds.length > 0,
        owners: [],
        requests: previous?.requests ?? {},
        manualUserIds: userIds,
        groupIds,
        sync: { state: 'pending', attempts: previous?.sync.attempts ?? 0 },
        updatedAt: new Date().toISOString(),
        ...(mediaType ? { mediaType } : {}),
      };
      current.owners = this.#store.resolveOwners(current);
      const plan = (await this.#buildPlan(current)).plan;
      if (dryRun) return { ...(previous ? { previous } : {}), current, plan };
      const stored = await this.#store.setManualAccess(input);
      const appliedPlan = await this.#reconcileGrant(stored.current);
      return { ...stored, plan: appliedPlan };
    });
  }

  public setBulkManualAccess(input: {
    itemIds: string[];
    userIds: string[];
    groupIds: string[];
  }, dryRun = false): Promise<{ currents: GrantRecord[]; plans: ChangePlan[] }> {
    return this.#exclusive(async () => {
      const itemIds = [...new Set(input.itemIds.map(normalizeId))];
      if (itemIds.length === 0) throw new Error('select at least one library item');
      if (itemIds.length > 500) throw new Error('bulk changes are limited to 500 items');
      const userIds = [...new Set(input.userIds.map(normalizeId))].sort();
      const groupIds = [...new Set(input.groupIds.map(normalizeId))].sort();
      const users = await this.#validateManualAudience(userIds, groupIds);
      const catalogById = new Map(this.#store.getCatalog().items.map((item) => [normalizeId(item.id), item]));
      const missingCatalogItems = itemIds.filter((id) => !catalogById.has(id));
      if (missingCatalogItems.length > 0) throw new Error(`library item not found in catalog: ${missingCatalogItems.join(', ')}`);
      const items = await this.#jellyfin.getItems(itemIds);
      const administrator = users.find((user) => user.Policy.IsAdministrator);
      if (!administrator) throw new Error('Jellyfin administrator user not found');
      const relatedItems = await Promise.all(itemIds.map((itemId) =>
        this.#jellyfin.getLocalTrailers(itemId, administrator.Id)));
      const currents = itemIds.map((itemId) => this.#makeManualGrant(
        itemId,
        catalogById.get(itemId)?.mediaType,
        userIds,
        groupIds,
      ));
      const contexts = currents.map((grant, index) => this.#buildPlanContext(
        grant,
        items[index] as JellyfinItem,
        users,
        relatedItems[index] ?? [],
      ));
      const plans = contexts.map((context) => context.plan);
      if (dryRun) return { currents, plans };

      const stored = await this.#store.setManualAccessBatch(currents.map((grant) => ({
        itemId: grant.itemId,
        userIds: grant.manualUserIds,
        groupIds: grant.groupIds,
        ...(grant.mediaType ? { mediaType: grant.mediaType } : {}),
      })));
      try {
        await this.#applyBatch(contexts, users);
        await this.#store.markSyncSuccessBatch(stored.map((result) => result.current.itemId));
        for (const _ of stored) {
          this.#metrics.increment('jfa_reconciliations_total', { result: 'success' });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#store.markSyncErrorBatch(stored.map((result) => result.current.itemId), message);
        for (const _ of stored) {
          this.#metrics.increment('jfa_reconciliations_total', { result: 'error' });
        }
        throw error;
      } finally {
        this.#refreshGauges();
      }
      return { currents: stored.map((result) => result.current), plans };
    });
  }

  public upsertGroup(input: { id: string; name: string; userIds: string[] }): Promise<AccessGroup> {
    return this.#exclusive(async () => {
      await this.#validateUsers(input.userIds);
      const group = await this.#store.upsertGroup(input);
      await this.#reconcileReferencingGroup(group.id);
      return group;
    });
  }

  public deleteGroup(groupId: string): Promise<{ groupId: string; affectedItems: string[] }> {
    return this.#exclusive(async () => {
      const results = await this.#store.deleteGroup(groupId);
      for (const result of results) await this.#reconcileGrant(result.current);
      return { groupId: normalizeId(groupId), affectedItems: results.map((result) => result.current.itemId) };
    });
  }

  async #reconcileReferencingGroup(groupId: string): Promise<void> {
    for (const grant of this.#store.list().filter((entry) => entry.groupIds.includes(groupId))) {
      await this.#reconcileGrant(grant);
    }
  }

  async #validateUsers(userIds: string[]): Promise<void> {
    const users = await this.#jellyfin.getUsers();
    const known = new Set(users.map((user) => normalizeId(user.Id)));
    const missing = userIds.map(normalizeId).filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error(`Jellyfin user not found: ${missing.join(', ')}`);
  }

  async #validateManualAudience(userIds: string[], groupIds: string[]): Promise<JellyfinUser[]> {
    if (userIds.length === 0 && groupIds.length === 0) throw new Error('select at least one user or group');
    const missingGroups = groupIds.filter((id) => !this.#store.getGroup(id));
    if (missingGroups.length > 0) throw new Error(`group not found: ${missingGroups.join(', ')}`);
    const users = await this.#jellyfin.getUsers();
    const byId = new Map(users.map((user) => [normalizeId(user.Id), user]));
    const missingUsers = userIds.filter((id) => !byId.has(id));
    if (missingUsers.length > 0) throw new Error(`Jellyfin user not found: ${missingUsers.join(', ')}`);
    const administrators = userIds.filter((id) => byId.get(id)?.Policy.IsAdministrator);
    if (administrators.length > 0) throw new Error('Jellyfin administrators already have unrestricted access');
    return users;
  }

  #makeManualGrant(itemId: string, mediaType: string | undefined, userIds: string[], groupIds: string[]): GrantRecord {
    const previous = this.#store.get(itemId);
    const resolvedMediaType = mediaType ?? previous?.mediaType;
    const current: GrantRecord = {
      itemId: normalizeId(itemId),
      active: Object.keys(previous?.requests ?? {}).length > 0 || userIds.length > 0 || groupIds.length > 0,
      owners: [],
      requests: previous?.requests ?? {},
      manualUserIds: userIds,
      groupIds,
      sync: { state: 'pending', attempts: previous?.sync.attempts ?? 0 },
      updatedAt: new Date().toISOString(),
      ...(resolvedMediaType ? { mediaType: resolvedMediaType } : {}),
    };
    current.owners = this.#store.resolveOwners(current);
    return current;
  }

  async #reconcileGrant(grant: GrantRecord): Promise<ChangePlan> {
    try {
      const context = await this.#buildPlan(grant);
      await this.#applyPlan(context);
      await this.#store.markSyncSuccess(grant.itemId);
      if (!grant.active) await this.#store.purgeInactive(grant.itemId);
      this.#metrics.increment('jfa_reconciliations_total', { result: 'success' });
      return context.plan;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.markSyncError(grant.itemId, message);
      this.#metrics.increment('jfa_reconciliations_total', { result: 'error' });
      throw error;
    } finally {
      this.#refreshGauges();
    }
  }

  async #buildPlan(grant: GrantRecord): Promise<PlanContext> {
    const [item, users] = await Promise.all([
      this.#jellyfin.getItem(grant.itemId),
      this.#jellyfin.getUsers(),
    ]);
    const administrator = users.find((user) => user.Policy.IsAdministrator);
    if (!administrator) throw new Error('Jellyfin administrator user not found');
    const relatedItems = await this.#jellyfin.getLocalTrailers(grant.itemId, administrator.Id);
    return this.#buildPlanContext(grant, item, users, relatedItems);
  }

  #buildPlanContext(
    grant: GrantRecord,
    item: JellyfinItem,
    users: JellyfinUser[],
    relatedItems: JellyfinItem[],
  ): PlanContext {
    const owners = grant.active ? this.#store.resolveOwners(grant) : [];
    const knownUserIds = new Set(users.map((user) => normalizeId(user.Id)));
    const missingOwners = owners.filter((owner) => !knownUserIds.has(owner));
    if (missingOwners.length > 0) throw new Error(`Jellyfin user not found: ${missingOwners.join(', ')}`);

    const tag = accessTag(grant.itemId);
    const beforeTags = item.Tags ?? [];
    const afterTags = grant.active
      ? uniqueCaseInsensitive([...beforeTags, tag])
      : beforeTags.filter((entry) => entry.toLowerCase() !== tag.toLowerCase());
    const itemAction = sameStringSet(beforeTags, afterTags) ? 'none' : grant.active ? 'add_tag' : 'remove_tag';
    const relatedItemChanges = relatedItems.map((relatedItem) => {
      const before = relatedItem.Tags ?? [];
      const after = grant.active
        ? uniqueCaseInsensitive([...before, tag])
        : before.filter((entry) => entry.toLowerCase() !== tag.toLowerCase());
      return {
        itemId: relatedItem.Id,
        itemName: relatedItem.Name,
        ...(relatedItem.Type ? { itemType: relatedItem.Type } : {}),
        action: sameStringSet(before, after) ? 'none' as const : grant.active ? 'add_tag' as const : 'remove_tag' as const,
        before,
        after,
      };
    });
    const userChanges = users.map((user) => {
      const before = user.Policy.BlockedTags ?? [];
      const withoutTag = before.filter((entry) => entry.toLowerCase() !== tag.toLowerCase());
      const isOwner = owners.includes(normalizeId(user.Id));
      const shouldBlock = grant.active && !user.Policy.IsAdministrator && !isOwner;
      const after = shouldBlock ? uniqueCaseInsensitive([...withoutTag, tag]) : withoutTag;
      return {
        userId: user.Id,
        userName: user.Name,
        action: sameStringSet(before, after) ? 'none' as const : shouldBlock ? 'block' as const : 'unblock' as const,
        before,
        after,
      };
    });
    return {
      item,
      relatedItems,
      users,
      plan: {
        itemId: grant.itemId,
        itemName: item.Name,
        tag,
        active: grant.active,
        owners,
        item: { action: itemAction, before: beforeTags, after: afterTags },
        relatedItems: relatedItemChanges,
        users: userChanges,
      },
    };
  }

  async #applyPlan(context: PlanContext): Promise<void> {
    if (context.plan.item.action !== 'none') {
      await this.#jellyfin.updateItem({ ...context.item, Tags: context.plan.item.after });
      this.#metrics.increment('jfa_item_updates_total');
    }
    for (const change of context.plan.relatedItems) {
      if (change.action === 'none') continue;
      const relatedItem = context.relatedItems.find((entry) => entry.Id === change.itemId);
      if (!relatedItem) throw new Error(`Jellyfin related item disappeared during reconciliation: ${change.itemId}`);
      await this.#jellyfin.updateItem({ ...relatedItem, Tags: change.after });
      this.#metrics.increment('jfa_item_updates_total');
    }
    for (const change of context.plan.users) {
      if (change.action === 'none') continue;
      const user = context.users.find((entry) => entry.Id === change.userId);
      if (!user) throw new Error(`Jellyfin user disappeared during reconciliation: ${change.userId}`);
      await this.#jellyfin.updatePolicy(user.Id, { ...user.Policy, BlockedTags: change.after });
      this.#metrics.increment('jfa_policy_updates_total');
    }
  }

  async #applyBatch(contexts: PlanContext[], users: JellyfinUser[]): Promise<void> {
    for (const context of contexts) {
      if (context.plan.item.action !== 'none') {
        await this.#jellyfin.updateItem({ ...context.item, Tags: context.plan.item.after });
        this.#metrics.increment('jfa_item_updates_total');
      }
      for (const change of context.plan.relatedItems) {
        if (change.action === 'none') continue;
        const relatedItem = context.relatedItems.find((entry) => entry.Id === change.itemId);
        if (!relatedItem) throw new Error(`Jellyfin related item disappeared during reconciliation: ${change.itemId}`);
        await this.#jellyfin.updateItem({ ...relatedItem, Tags: change.after });
        this.#metrics.increment('jfa_item_updates_total');
      }
    }
    for (const user of users) {
      let after = [...(user.Policy.BlockedTags ?? [])];
      for (const context of contexts) {
        const change = context.plan.users.find((entry) => entry.userId === user.Id);
        if (!change) continue;
        const withoutTag = after.filter((tag) => tag.toLowerCase() !== context.plan.tag.toLowerCase());
        after = change.after.some((tag) => tag.toLowerCase() === context.plan.tag.toLowerCase())
          ? uniqueCaseInsensitive([...withoutTag, context.plan.tag])
          : withoutTag;
      }
      if (sameStringSet(user.Policy.BlockedTags ?? [], after)) continue;
      await this.#jellyfin.updatePolicy(user.Id, { ...user.Policy, BlockedTags: after });
      this.#metrics.increment('jfa_policy_updates_total');
    }
  }

  #refreshGauges(): void {
    const grants = this.#store.list();
    this.#metrics.gauge('jfa_grants', grants.filter((grant) => grant.active).length);
    this.#metrics.gauge('jfa_sync_errors', grants.filter((grant) => grant.sync.state === 'error').length);
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.catch(() => undefined).then(operation);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function accessTag(itemId: string): string {
  return `${TAG_PREFIX}${normalizeId(itemId)}`;
}

export function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalized = new Set(left.map((value) => value.toLowerCase()));
  return right.every((value) => normalized.has(value.toLowerCase()));
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function isDue(grant: GrantRecord): boolean {
  if (grant.sync.state === 'pending') return true;
  if (grant.sync.state === 'synced') return true;
  return !grant.sync.nextRetryAt || Date.parse(grant.sync.nextRetryAt) <= Date.now();
}

function hypotheticalRevocation(grant: GrantRecord, requestId: string, store: GrantStore): GrantRecord {
  const requests = { ...grant.requests };
  delete requests[requestId];
  const next = { ...grant, requests, updatedAt: new Date().toISOString() };
  next.owners = store.resolveOwners(next);
  next.active = Object.keys(requests).length > 0 || next.manualUserIds.length > 0 || next.groupIds.length > 0;
  return next;
}
