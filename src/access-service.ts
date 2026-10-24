import type { LogLevel } from './config.js';
import type { JellyfinClient } from './jellyfin.js';
import { Metrics } from './metrics.js';
import { RECENT_REQUESTS_LIMIT, type SeerrClient } from './seerr.js';
import { normalizeId, type GrantMove, type GrantRemainder, type GrantStore } from './store.js';
import type {
  AccessGroup,
  AccessRemovals,
  ChangePlan,
  GrantRecord,
  IgnoredWebhook,
  JellyfinItem,
  JellyfinUser,
  LibraryCatalogItem,
  LibraryItemSummary,
  RecentSeerrRequest,
  RequestBackfillResult,
  RevokeResult,
  SeerrRequest,
  SeerrWebhook,
} from './types.js';

export const TAG_PREFIX = 'jfa:private:';

// Seerr media statuses: 4 = partially available, 5 = available.
const AVAILABLE_MEDIA_STATUSES = new Set([4, 5]);
// Seerr (v3.5.0) request statuses: 2 = approved, 5 = completed. Pending (1), declined (3) and failed (4) requests are
// listed too, and their media can be available through someone else's request.
const GRANTABLE_REQUEST_STATUSES = new Set([2, 5]);

interface PlanContext {
  plan: ChangePlan;
  item: JellyfinItem;
  relatedItems: JellyfinItem[];
  users: JellyfinUser[];
}

export class UserProvisioningError extends Error {
  public constructor(
    public readonly user: { id: string; name: string },
    public readonly stage: 'household' | 'seerr',
    public readonly group: AccessGroup | undefined,
    cause: unknown,
  ) {
    super(stage === 'household'
      ? 'Jellyfin user was created, but household assignment did not finish. Refresh the group and review its membership.'
      : 'Jellyfin user was created and assigned to the household, but Seerr import failed. Import the user from Seerr or try again there.');
    this.cause = cause;
  }
}

/** A background run stopped because shutdown aborted its signal; it is neither a failure to log nor to count. */
export class OperationCancelledError extends Error {
  public constructor(signal: AbortSignal) {
    super(signal.reason instanceof Error ? signal.reason.message : 'operation cancelled');
    this.name = 'OperationCancelledError';
  }
}

/** A request that conflicts with the current state and must not be applied as asked; served as 409 with `code`. */
export class ConflictError extends Error {
  public constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Jellyfin answered 404 for an active grant's item: it was deleted (for example, removed and re-imported under a new ID). */
class MissingItemError extends Error {
  public readonly status = 404;

  public constructor(public readonly itemId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : `Jellyfin item not found: ${itemId}`);
    this.name = 'MissingItemError';
    this.cause = cause;
  }
}

/** Only a definite 404 means "gone"; network failures and 5xx responses are transient. */
function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | undefined)?.status === 404;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationCancelledError(signal);
}

/** Rethrows cancellation, including an operation that failed because the run was aborted while it was in flight. */
function rethrowIfCancelled(error: unknown, signal: AbortSignal | undefined): void {
  if (error instanceof OperationCancelledError) throw error;
  throwIfAborted(signal);
}

export class AccessService {
  readonly #jellyfin: JellyfinClient;
  readonly #store: GrantStore;
  readonly #metrics: Metrics;
  readonly #seerr: SeerrClient | undefined;
  #queue: Promise<void> = Promise.resolve();
  readonly #backfillMissingItems = new Set<string>();
  readonly #debug: boolean;

  public constructor(
    jellyfin: JellyfinClient,
    store: GrantStore,
    metrics = new Metrics(),
    seerr?: SeerrClient,
    options: { logLevel?: LogLevel } = {},
  ) {
    this.#jellyfin = jellyfin;
    this.#store = store;
    this.#metrics = metrics;
    this.#seerr = seerr;
    this.#debug = options.logLevel === 'debug';
    this.#refreshGauges();
  }

  /** Each grant, with what an administrator removed from its item (`removed`, see GrantState.removedAccess) if anything. */
  public listGrants(): Array<GrantRecord & { removed?: AccessRemovals }> {
    return this.#store.list().map((grant) => {
      const removed = this.#store.getRemovals(grant.itemId);
      return removed.userIds || removed.groupIds ? { ...grant, removed } : grant;
    });
  }

  public listGroups(): AccessGroup[] {
    return this.#store.listGroups();
  }

  public getHouseholdMemberIds(groupId: string): string[] | undefined {
    return this.#store.getGroup(groupId)?.userIds;
  }

  public isPasswordless(userId: string): boolean {
    return this.#store.listPasswordlessUserIds().includes(userId.toLowerCase());
  }

  public setUserPasswordless(userId: string, passwordless: boolean): Promise<{ id: string; passwordless: boolean }> {
    return this.#exclusive(async () => {
      const users = await this.#jellyfin.getUsers();
      const user = users.find((entry) => entry.Id.toLowerCase() === userId.toLowerCase());
      if (!user) throw new Error(`user not found: ${userId}`);
      if (passwordless && user.Policy.IsAdministrator === true) throw new Error('passwordless sign-in is invalid for administrators');
      await this.#store.setUserPasswordless(user.Id, passwordless);
      return { id: user.Id, passwordless };
    });
  }

  public async listUsers(): Promise<Array<{ id: string; name: string; isAdministrator: boolean; passwordless: boolean }>> {
    const users = await this.#jellyfin.getUsers();
    const passwordless = new Set(this.#store.listPasswordlessUserIds());
    return users
      .map((user) => ({
        id: user.Id,
        name: user.Name,
        isAdministrator: user.Policy.IsAdministrator === true,
        passwordless: user.Policy.IsAdministrator !== true && passwordless.has(user.Id.toLowerCase()),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public canImportJellyfinUsersToSeerr(): boolean {
    return Boolean(this.#seerr);
  }

  public createUserInGroup(input: { username: string; password: string; groupId: string; importToSeerr?: boolean }): Promise<{
    user: { id: string; name: string; isAdministrator: false };
    group: AccessGroup;
    jellyseerr: { status: 'not_requested' | 'imported' | 'already_imported'; userId?: number };
  }> {
    return this.#exclusive(async () => {
      if (input.importToSeerr && !this.#seerr) throw new Error('Seerr user import is not configured');
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
        if (!input.password) await this.#store.setUserPasswordless(created.Id, true);
        updatedGroup = await this.#store.upsertGroup({
          id: group.id,
          name: group.name,
          userIds: [...group.userIds, created.Id],
        });
        await this.#reconcileReferencingGroup(updatedGroup.id);
      } catch (error) {
        throw new UserProvisioningError(user, 'household', undefined, error);
      }

      if (!input.importToSeerr) return { user, group: updatedGroup, jellyseerr: { status: 'not_requested' } };
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
        throw new UserProvisioningError(user, 'seerr', updatedGroup, error);
      }
    });
  }

  public searchLibrary(query: string): Promise<LibraryItemSummary[]> {
    return this.#jellyfin.searchLibrary(query);
  }

  public listRecentRequests(take = RECENT_REQUESTS_LIMIT): Promise<RecentSeerrRequest[]> {
    const catalogIds = new Set(this.#store.getCatalog().items.map((item) => normalizeId(item.id)));
    return this.#seerr?.getRecentRequests(take, catalogIds) ?? Promise.resolve([]);
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

  /** An aborted `signal` (shutdown) rejects with OperationCancelledError and leaves the stored catalog unchanged. */
  public syncLibraryCatalog(options: { signal?: AbortSignal } = {}): Promise<{ lastSyncedAt: string; items: Array<LibraryCatalogItem & { managed: boolean; managedAt?: string }> }> {
    return this.#exclusive(async () => {
      throwIfAborted(options.signal);
      const items = await this.#jellyfin.fetchLibraryCatalog();
      throwIfAborted(options.signal);
      const catalog = await this.#store.replaceCatalog(items);
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

  /** Records that an authenticated webhook call arrived, before its body is parsed. */
  public recordWebhookReceived(): void {
    this.#metrics.gauge('jfa_last_webhook_received_timestamp_seconds', Math.floor(Date.now() / 1000));
  }

  public recordInvalidWebhook(): void {
    this.#metrics.increment('jfa_webhooks_total', { result: 'invalid' });
  }

  public processWebhook(event: SeerrWebhook | IgnoredWebhook): Promise<GrantRecord | null> {
    return this.#exclusive(async () => {
      if (event.notificationType !== 'MEDIA_AVAILABLE' || !('request' in event)) {
        this.#metrics.increment('jfa_webhooks_total', { result: 'ignored' });
        return null;
      }
      // The body is valid from here on (parse failures count as "invalid" in the server), so every
      // failure while resolving, persisting or reconciling counts once as "error".
      try {
        // A request is handled once its grant has been stored (store.grant records both in one
        // write), so a delivery that failed before that is retried as a first delivery. A handled
        // request is never granted again: if its grant still records it, a retry only reconciles
        // that grant as it stands, without re-adding household groups an administrator removed;
        // if an administrator revoked it, the replay is ignored.
        if (this.#store.hasHandledRequest(event.request.id)) {
          const existing = this.#store.findGrantForRequest(event.request.id);
          if (!existing) {
            this.#metrics.increment('jfa_webhooks_total', { result: 'ignored' });
            this.#logDebug('webhook ignored for a request an administrator revoked', { requestId: event.request.id });
            return null;
          }
          await this.#reconcileOrRecover(existing);
          this.#metrics.increment('jfa_webhooks_total', { result: 'granted' });
          return this.#store.findGrantForRequest(event.request.id) ?? existing;
        }
        const resolved = await this.#resolveWebhook(event);
        const grant = await this.#store.grant({
          itemId: resolved.itemId,
          requestId: event.request.id,
          userId: resolved.userId,
          groupIds: this.#store.listGroupIdsForUser(resolved.userId),
          ...(resolved.mediaType ? { mediaType: resolved.mediaType } : {}),
        });
        await this.#reconcileGrant(grant);
        this.#metrics.increment('jfa_webhooks_total', { result: 'granted' });
        return this.#store.get(grant.itemId) ?? grant;
      } catch (error) {
        this.#metrics.increment('jfa_webhooks_total', { result: 'error' });
        throw error;
      }
    });
  }

  /** Whether household "Add to my library" can resolve titles; it needs Seerr lookup. */
  public canJoinLibrary(): boolean {
    return Boolean(this.#seerr);
  }

  /**
   * Household "Add to my library" for a Jellyfin-authenticated user: resolves a TMDB title to its HD Jellyfin item
   * through Seerr, joins that item's request grant (see GrantStore.joinGrant) and applies the join to Jellyfin. It runs
   * as background work after the caller has had their answer. The result is for metrics and tests only; callers must
   * not reveal it, since it tells whether another household holds the title. Every failure is logged and reported as
   * `error`, never thrown; a join that was stored but could not be applied is retried by reconciliation like any other
   * grant. Once `signal` is aborted (shutdown), no further Seerr, Jellyfin or store call is started and the run resolves
   * `cancelled`, logging and counting nothing more: a join stored by then stays pending and is applied after restart.
   */
  public async joinLibrary(input: {
    userId: string;
    isAdministrator: boolean;
    mediaType: 'movie' | 'tv';
    tmdbId: number;
  }, options: { signal?: AbortSignal } = {}): Promise<'joined' | 'unchanged' | 'error' | 'cancelled'> {
    const { signal } = options;
    const fields = { userId: input.userId, mediaType: input.mediaType, tmdbId: input.tmdbId };
    const finish = (result: 'joined' | 'unchanged' | 'error') => {
      this.#metrics.increment('jfa_library_joins_total', { result });
      return result;
    };
    try {
      throwIfAborted(signal);
      if (!this.#seerr) throw new Error('Seerr lookup is not configured');
      // Administrators already see every title, and a grant never lists them.
      if (input.isAdministrator) {
        this.#logDebug('library join ignored for an administrator', fields);
        return finish('unchanged');
      }
      const itemId = await this.#seerr.getJellyfinItemId(input.mediaType, input.tmdbId);
      throwIfAborted(signal);
      if (!itemId) {
        this.#logDebug('library join found no Jellyfin item', fields);
        return finish('unchanged');
      }
      // Classified without the shared write queue, so a join that changes nothing never waits on it or holds it up.
      if (!this.#store.wouldJoin({ itemId, userId: input.userId, groupIds: this.#store.listGroupIdsForUser(input.userId) })) {
        this.#logDebug('library join changed nothing', { ...fields, itemId });
        return finish('unchanged');
      }
      return await this.#exclusive(async () => {
        throwIfAborted(signal);
        // Checked again in the queue: the grant may have changed while this join waited.
        const joined = await this.#store.joinGrant({
          itemId,
          userId: input.userId,
          groupIds: this.#store.listGroupIdsForUser(input.userId),
        });
        if (!joined) {
          throwIfAborted(signal);
          this.#logDebug('library join changed nothing', { ...fields, itemId });
          return finish('unchanged');
        }
        // The join is stored from here on, so it counts even if shutdown stops it being applied now.
        const join = joined.current.joins?.at(-1);
        console.log(JSON.stringify({
          level: 'info',
          message: 'household library join',
          ...fields,
          itemId: joined.current.itemId,
          groupIds: join?.groupIds ?? [],
          userAdded: join?.userAdded ?? false,
        }));
        finish('joined');
        throwIfAborted(signal);
        try {
          await this.#reconcileGrant(joined.current, signal);
        } catch (error) {
          rethrowIfCancelled(error, signal);
          console.error(JSON.stringify({
            level: 'error',
            message: 'library join reconciliation failed',
            itemId: joined.current.itemId,
            detail: error instanceof Error ? error.message : String(error),
          }));
        }
        return 'joined';
      });
    } catch (error) {
      // Includes a store write refused because shutdown closed the store after its grace period.
      if (error instanceof OperationCancelledError || signal?.aborted) return 'cancelled';
      console.error(JSON.stringify({
        level: 'error',
        message: 'library join failed',
        ...fields,
        detail: error instanceof Error ? error.message : String(error),
      }));
      return finish('error');
    }
  }

  /** Counts a household "Add to my library" call that was not started because its budget was used up. */
  public recordLibraryJoinDropped(): void {
    this.#metrics.increment('jfa_library_joins_total', { result: 'dropped' });
  }

  async #resolveWebhook(event: SeerrWebhook): Promise<{ itemId: string; userId: string; mediaType?: string }> {
    let itemId = event.media?.jellyfinMediaId;
    let userId = event.request.requestedBy?.jellyfinUserId;
    let mediaType = event.media?.mediaType;

    // Seerr's {{media_jellyfinMediaId}} is the HD item whenever one exists, and no template variable
    // carries the 4K item. The payload's IDs are therefore trusted only when both are present and
    // the event text shows an HD request; otherwise Seerr's request decides (requestItemId). Without
    // Seerr, a missing, empty, unfilled or unrecognized event is rejected: it may be a 4K request.
    if (!this.#seerr) {
      if (event.request.is4k) throw new Error('webhook is for a 4K request and Seerr lookup is not configured');
      if (!itemId || !userId) throw new Error('webhook is missing Jellyfin IDs and Seerr lookup is not configured');
      if (event.request.is4k !== false) {
        throw new Error('webhook event does not name an HD request and Seerr lookup is not configured');
      }
    }
    let is4k = event.request.is4k === true;
    if ((!itemId || !userId || event.request.is4k !== false) && this.#seerr) {
      const request = await this.#seerr.getRequest(event.request.id);
      itemId = requestItemId(request);
      is4k = request.is4k === true;
      userId = request.requestedBy?.jellyfinUserId;
      mediaType ??= request.media?.mediaType ?? request.type;
    }

    if (!itemId) throw new Error(`Seerr request ${event.request.id} is missing a ${is4k ? '4K ' : ''}Jellyfin media ID`);
    if (!userId) throw new Error(`Seerr request ${event.request.id} is missing a Jellyfin user ID`);
    return { itemId, userId, ...(mediaType ? { mediaType } : {}) };
  }

  /**
   * Pull-based fallback for missed MEDIA_AVAILABLE webhooks: grants approved or completed Seerr
   * requests for available media created at or after `since`. A request for an item with no grant creates one; a request for
   * an item whose grant came from other requests is added to it (additively, with the
   * requester's households). Manual-only grants are left alone. Each request counts as exactly
   * one outcome: granted (stored and reconciled), skipped, or failed (including a grant that was
   * stored but could not be reconciled yet; reconcileAll retries it). Once `signal` is aborted (shutdown), no further
   * request, grant or write is started and the run rejects with OperationCancelledError, counting and logging nothing
   * for the request it was on. A call already in flight is left to finish.
   */
  public backfillRequests(since: Date, options: { signal?: AbortSignal } = {}): Promise<RequestBackfillResult> {
    return this.#exclusive(async () => {
      const { signal } = options;
      throwIfAborted(signal);
      if (!this.#seerr) throw new Error('Seerr lookup is not configured');
      const seerr = this.#seerr;
      // Oldest first, so a grant's first request comes from the original requester.
      const requests = (await seerr.listRequestsSince(since)).reverse();
      throwIfAborted(signal);
      const result: RequestBackfillResult = { scanned: requests.length, granted: [], skipped: 0, failed: 0 };
      let knownUserIds: Set<string> | undefined;
      for (const listed of requests) {
        throwIfAborted(signal);
        const requestId = String(listed.id);
        try {
          if (
            !GRANTABLE_REQUEST_STATUSES.has(listed.status ?? 0)
            || !AVAILABLE_MEDIA_STATUSES.has(requestMediaStatus(listed) ?? 0)
            || this.#store.hasHandledRequest(requestId)
          ) {
            result.skipped += 1;
            continue;
          }
          const request = requestItemId(listed) && listed.requestedBy?.jellyfinUserId
            ? listed
            : await seerr.getRequest(requestId);
          throwIfAborted(signal);
          const itemId = requestItemId(request);
          const userId = request.requestedBy?.jellyfinUserId;
          const existing = itemId ? this.#store.get(itemId) : undefined;
          if (!itemId || !userId || (existing && (Object.keys(existing.requests).length === 0 || requestId in existing.requests))) {
            result.skipped += 1;
            continue;
          }
          knownUserIds ??= new Set((await this.#jellyfin.getUsers()).map((user) => normalizeId(user.Id)));
          throwIfAborted(signal);
          if (!knownUserIds.has(normalizeId(userId))) {
            result.skipped += 1;
            continue;
          }
          try {
            await this.#jellyfin.getItem(itemId);
          } catch (error) {
            rethrowIfCancelled(error, signal);
            if ((error as { status?: unknown }).status !== 404) throw error;
            result.skipped += 1;
            if (!this.#backfillMissingItems.has(requestId)) {
              this.#backfillMissingItems.add(requestId);
              this.#logDebug('request backfill skipped missing Jellyfin item', { requestId, itemId });
            }
            continue;
          }
          throwIfAborted(signal);
          const mediaType = request.media?.mediaType ?? request.type;
          const grant = await this.#store.grant({
            itemId,
            requestId,
            userId,
            groupIds: this.#store.listGroupIdsForUser(userId),
            ...(mediaType ? { mediaType } : {}),
          });
          await this.#reconcileGrant(grant, signal);
          throwIfAborted(signal);
          result.granted.push(grant.itemId);
          this.#metrics.increment('jfa_request_backfill_total', { result: 'granted' });
          console.log(JSON.stringify({ level: 'info', message: 'request backfill granted item', requestId, itemId: grant.itemId, groupIds: grant.groupIds }));
        } catch (error) {
          rethrowIfCancelled(error, signal);
          result.failed += 1;
          this.#metrics.increment('jfa_request_backfill_total', { result: 'error' });
          console.error(JSON.stringify({
            level: 'error',
            message: 'request backfill failed',
            requestId,
            detail: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      this.#metrics.gauge('jfa_request_backfill_last_run_timestamp_seconds', Math.floor(Date.now() / 1000));
      return result;
    });
  }

  /**
   * Once `signal` is aborted (shutdown), no further Jellyfin call or write is started and the run rejects with
   * OperationCancelledError; the grant it was on is neither marked failed nor counted. A call in flight is left to finish.
   * A grant whose Jellyfin item was deleted is moved to the item its Seerr requests now resolve to, or marked orphaned
   * (see #recoverMissingItem). Orphaned grants are skipped by `dueOnly` runs and dry runs; a full run tries them again.
   */
  public reconcileAll(options: { dryRun?: boolean; dueOnly?: boolean; signal?: AbortSignal } = {}): Promise<ChangePlan[]> {
    return this.#exclusive(async () => {
      const plans: ChangePlan[] = [];
      const errors: Error[] = [];
      for (const { itemId } of this.#store.list()) {
        throwIfAborted(options.signal);
        // Re-read: a grant moved earlier in this run may have been deleted, or merged into this one.
        const grant = this.#store.get(itemId);
        if (!grant) continue;
        if (options.dueOnly && !isDue(grant)) continue;
        try {
          if (options.dryRun) {
            if (grant.sync.state !== 'orphaned') plans.push((await this.#buildPlan(grant, options.signal)).plan);
          } else {
            plans.push(...await this.#reconcileOrRecover(grant, options.signal));
          }
        } catch (error) {
          rethrowIfCancelled(error, options.signal);
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
        const planned = this.#store.previewRevokeRequest(itemId, requestId) as RevokeResult;
        return { ...planned, plan: (await this.#buildPlan(planned.current)).plan };
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
        const planned = this.#store.previewGrantGroups(itemId, groupIds);
        return { ...planned, plan: (await this.#buildPlan(planned.current)).plan };
      }
      const result = await this.#store.setGrantGroups(itemId, groupIds);
      const plan = await this.#reconcileGrant(result.current);
      return { ...result, plan };
    });
  }

  /**
   * Moves a grant whose Jellyfin item was deleted to another item, merging it into any grant the target already has
   * (see GrantStore.previewMerge). The target must exist and the source must not: taking the grant off an item that
   * still exists would make that item visible to every household, so it is refused with ConflictError (revoke the grant
   * explicitly instead). A request is never moved onto the other quality's item of its title (4K onto HD or HD onto 4K;
   * see requestItemId). The source grant is removed only after the merged grant has been stored and applied, then its
   * deleted item's tag is cleared from user policies; `plan` and `sourcePlan` describe those two steps. If applying the
   * target fails, the source grant is kept and the move can be repeated. If the source item exists again by then, the
   * source grant is kept intact with its restrictions (see #keepReappearedSource) and the move rejects with ConflictError.
   */
  public remapGrant(fromItemId: string, toItemId: string, dryRun = false): Promise<{
    previous: GrantRecord;
    target?: GrantRecord;
    current: GrantRecord;
    sourcePlan: ChangePlan;
    plan: ChangePlan;
  }> {
    return this.#exclusive(async () => {
      const from = normalizeId(fromItemId);
      const to = normalizeId(toItemId);
      if (from === to) throw new Error('toItemId must be a different item');
      const source = this.#store.get(from);
      if (!source) throw new Error(`grant not found: ${from}`);
      // Refuse during shutdown before calling Jellyfin or Seerr, rather than partway through the move.
      if (!dryRun) this.#store.assertOpen();
      if (!await this.#itemExists(to)) throw new Error(`Jellyfin item not found: ${to}`);
      if (await this.#itemExists(from)) throw sourceExistsError(from);
      await this.#assertSameQuality(source, to);
      const target = this.#store.get(to);
      const move: GrantMove = {
        itemId: to,
        requests: source.requests,
        manualUserIds: source.manualUserIds,
        groupIds: source.groupIds,
        ...(source.mediaType ? { mediaType: source.mediaType } : {}),
      };
      if (dryRun) {
        const current = this.#store.previewMerge(from, move);
        const retired = await this.#retirementPlan(source);
        if (!retired) throw sourceExistsError(from);
        return { previous: source, ...(target ? { target } : {}), current, sourcePlan: retired.plan, plan: (await this.#buildPlan(current)).plan };
      }
      try {
        const [merged] = await this.#store.mergeGrants(from, [move]);
        const plan = await this.#reconcileGrant(merged as GrantRecord);
        const retired = await this.#retirementPlan(source);
        if (!retired) {
          await this.#keepReappearedSource(from, [to], 'admin');
          throw new ConflictError(
            `source item reappeared in Jellyfin while its grant was moved: ${from}; ${to} was granted, but the source grant was kept with its restrictions, so revoke it explicitly`,
            'source_reappeared',
          );
        }
        await this.#applyPlan(retired);
        await this.#store.retireMovedGrant(from);
        this.#metrics.increment('jfa_grant_remaps_total', { result: 'remapped', trigger: 'admin' });
        console.log(JSON.stringify({ level: 'info', message: 'grant remapped', trigger: 'admin', fromItemId: from, toItemId: to }));
        const current = this.#store.get(to) ?? merged as GrantRecord;
        return { previous: source, ...(target ? { target } : {}), current, sourcePlan: retired.plan, plan };
      } finally {
        this.#refreshGauges();
      }
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
      const [planned] = this.#store.previewManualAccessBatch([input]) as [{ previous?: GrantRecord; current: GrantRecord }];
      // Planned before anything is stored, so a failed Jellyfin lookup leaves the grant as it was.
      const plan = (await this.#buildPlan(planned.current)).plan;
      if (dryRun) return { ...planned, plan };
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
      const inputs = itemIds.map((itemId) => {
        const mediaType = catalogById.get(itemId)?.mediaType;
        return { itemId, userIds, groupIds, ...(mediaType ? { mediaType } : {}) };
      });
      // Exactly what setManualAccessBatch stores below, so the plans applied are the plans previewed.
      const currents = this.#store.previewManualAccessBatch(inputs).map((result) => result.current);
      const contexts = currents.map((grant, index) => this.#buildPlanContext(
        grant,
        items[index] as JellyfinItem,
        users,
        relatedItems[index] ?? [],
      ));
      const plans = contexts.map((context) => context.plan);
      if (dryRun) return { currents, plans };

      const stored = await this.#store.setManualAccessBatch(inputs);
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

  /**
   * Reconciles a grant; if its item was deleted, moves it to the item its requests now resolve to, or orphans it.
   * Resolves with the plans applied (none when the grant was orphaned).
   */
  async #reconcileOrRecover(grant: GrantRecord, signal?: AbortSignal): Promise<ChangePlan[]> {
    try {
      return [await this.#reconcileGrant(grant, signal, { recoverMissing: true })];
    } catch (error) {
      if (!(error instanceof MissingItemError)) throw error;
      return this.#recoverMissingItem(grant, signal);
    }
  }

  /**
   * Re-resolves each of the grant's requests through Seerr (HD or 4K item, exactly as requested) and moves the grant
   * as #partitionMove decides. With no new item at all, the grant is marked orphaned and logged once. The targets are
   * stored and applied before the stale grant is removed or reduced to what could not be moved (orphaned), so a crash
   * or failure partway leaves the stale grant in place for the next run, which converges on the same result. Seerr or
   * Jellyfin failures other than 404 reject, so the grant is retried with the usual backoff.
   */
  async #recoverMissingItem(grant: GrantRecord, signal?: AbortSignal): Promise<ChangePlan[]> {
    try {
      const { targets, revoked } = await this.#resolveRequestTargets(grant, signal);
      if (targets.size === 0 && revoked.size === 0) {
        const reason = !this.#seerr
          ? 'Jellyfin item was deleted and Seerr lookup is not configured to find its replacement'
          : Object.keys(grant.requests).length === 0
            ? 'Jellyfin item was deleted and the grant has no Seerr requests to find its replacement'
            : 'Jellyfin item was deleted and none of its Seerr requests resolves to an existing Jellyfin item';
        const newlyOrphaned = await this.#store.markOrphaned(grant.itemId, reason);
        throwIfAborted(signal);
        if (newlyOrphaned) this.#logOrphaned(grant.itemId, reason);
        return [];
      }
      const { moves, remainder } = this.#partitionMove(grant, targets, revoked);
      const currents = moves.length > 0 ? await this.#store.mergeGrants(grant.itemId, moves) : [];
      throwIfAborted(signal);
      const plans: ChangePlan[] = [];
      for (const current of currents) plans.push(await this.#reconcileGrant(current, signal));
      // Only now that every target is applied: clear the deleted item's tag from user policies and drop the grant
      // that records it, or keep what was not moved on it, orphaned. Unless the item exists again: then nothing is
      // cleared or dropped.
      const retired = await this.#retirementPlan(grant, signal);
      if (!retired) {
        await this.#keepReappearedSource(grant.itemId, currents.map((current) => current.itemId), 'auto');
        throwIfAborted(signal);
        return plans;
      }
      if (!remainder) await this.#applyPlan(retired, signal);
      throwIfAborted(signal);
      const newlyOrphaned = await this.#store.retireMovedGrant(grant.itemId, remainder);
      throwIfAborted(signal);
      this.#metrics.increment('jfa_grant_remaps_total', { result: 'remapped', trigger: 'auto' });
      console.log(JSON.stringify({
        level: 'info',
        message: 'grant remapped',
        trigger: 'auto',
        fromItemId: grant.itemId,
        toItemIds: currents.map((current) => current.itemId),
        ...(remainder ? { orphanedRemainder: true } : {}),
      }));
      if (remainder && newlyOrphaned) this.#logOrphaned(grant.itemId, remainder.reason);
      return plans;
    } catch (error) {
      rethrowIfCancelled(error, signal);
      if (!this.#store.get(grant.itemId)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.markSyncError(grant.itemId, message);
      throwIfAborted(signal);
      this.#metrics.increment('jfa_reconciliations_total', { result: 'error' });
      throw error;
    } finally {
      this.#refreshGauges();
    }
  }

  /**
   * Splits a deleted item's grant among the items its requests now resolve to (`targets`). A request goes only to the
   * item it resolves to; one that resolves to no existing item is never assigned to another (no guessing, so a 4K
   * request never lands on an HD item). When every request of the original grant resolves to the same item in one
   * recovery (the usual re-import), the whole audience, manual users and groups included, moves there; never for a
   * grant left over from an earlier split (`remap.splitTo`), whose manual audience is no longer attributable to any one
   * item and stays until an administrator assigns it. Otherwise each item gets its own requests plus those
   * requesters' households (the groups webhooks and the backfill would assign, limited to groups the grant already
   * had), and the rest (unresolved requests, manual users, groups attributable to no moved request, and the unresolved
   * requesters' households) is the `remainder`, kept on the stale grant as orphaned for an administrator to resolve.
   * A request an administrator revoked from the item it resolves to (`revoked`, see GrantState.revokedRequests) goes
   * nowhere: it is dropped from the stale grant, and the whole audience never moves with the others.
   */
  #partitionMove(
    grant: GrantRecord,
    targets: Map<string, Record<string, string>>,
    revoked: Map<string, Record<string, string>>,
  ): { moves: GrantMove[]; remainder?: GrantRemainder } {
    const mediaType = grant.mediaType ? { mediaType: grant.mediaType } : {};
    const settled = new Set([...targets.values(), ...revoked.values()].flatMap((requests) => Object.keys(requests)));
    const unresolved = Object.fromEntries(Object.entries(grant.requests).filter(([requestId]) => !settled.has(requestId)));
    const [only] = targets;
    if (targets.size === 1 && only && Object.keys(unresolved).length === 0 && revoked.size === 0 && !grant.remap?.splitTo) {
      return { moves: [{ itemId: only[0], requests: only[1], manualUserIds: grant.manualUserIds, groupIds: grant.groupIds, ...mediaType }] };
    }
    const households = (requests: Record<string, string>): string[] => [...new Set(Object.values(requests)
      .flatMap((userId) => this.#store.listGroupIdsForUser(userId))
      .filter((groupId) => grant.groupIds.includes(groupId)))].sort();
    const moves: GrantMove[] = [...targets]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([itemId, requests]) => ({ itemId, requests, manualUserIds: [], groupIds: households(requests), ...mediaType }));
    const attributed = new Set(moves.flatMap((move) => move.groupIds));
    const groupIds = [...new Set([...grant.groupIds.filter((groupId) => !attributed.has(groupId)), ...households(unresolved)])].sort();
    if (Object.keys(unresolved).length === 0 && grant.manualUserIds.length === 0 && groupIds.length === 0) return { moves };
    const reason = Object.keys(unresolved).length > 0
      ? 'Jellyfin item was deleted; its requests that resolve to no existing Jellyfin item were kept here, with manual users and groups not attributable to the items its other requests moved to'
      : moves.length > 0
        ? 'Jellyfin item was deleted and its requests moved to other items; manual users and groups not attributable to one of them were kept here'
        : 'Jellyfin item was deleted and its requests were revoked from the items they resolve to; its manual users and groups were kept here';
    const movedTo = [...new Set([...moves.map((move) => move.itemId), ...revoked.keys()])].sort();
    return { moves, remainder: { requests: unresolved, manualUserIds: grant.manualUserIds, groupIds, reason, movedTo } };
  }

  /**
   * The plan that clears a moved grant's deleted item tag from user policies, or undefined when Jellyfin has the item
   * again: then its restrictions must stay.
   */
  async #retirementPlan(grant: GrantRecord, signal?: AbortSignal): Promise<PlanContext | undefined> {
    const [exists, users] = await Promise.all([this.#itemExists(grant.itemId), this.#jellyfin.getUsers()]);
    throwIfAborted(signal);
    if (exists) return undefined;
    return this.#buildPlanContext({ ...grant, active: false }, { Id: grant.itemId, Name: grant.itemId, Tags: [] }, users, []);
  }

  /**
   * The source item exists again after a move's targets were applied: the source grant is kept intact (its tag and
   * every user restriction stay), marked for an administrator (GrantRemapNote.sourceReappeared), logged and counted.
   */
  async #keepReappearedSource(itemId: string, movedTo: string[], trigger: 'auto' | 'admin'): Promise<void> {
    await this.#store.markSourceReappeared(itemId, movedTo);
    this.#metrics.increment('jfa_grant_remaps_total', { result: 'source_reappeared', trigger });
    console.error(JSON.stringify({
      level: 'warn',
      message: 'grant source reappeared',
      trigger,
      itemId,
      movedTo,
      detail: 'the item exists again in Jellyfin; its grant was kept with its restrictions for an administrator to resolve',
    }));
  }

  #logOrphaned(itemId: string, reason: string): void {
    this.#metrics.increment('jfa_grant_remaps_total', { result: 'orphaned', trigger: 'auto' });
    console.error(JSON.stringify({ level: 'warn', message: 'grant orphaned', itemId, detail: reason }));
  }

  /** Refuses to move any of the grant's requests onto the other quality's item of its title (see requestItemId). */
  async #assertSameQuality(grant: GrantRecord, itemId: string): Promise<void> {
    if (!this.#seerr) return;
    for (const requestId of Object.keys(grant.requests)) {
      let request: SeerrRequest;
      try {
        request = await this.#seerr.getRequest(requestId);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      const otherQuality = request.is4k ? request.media?.jellyfinMediaId : request.media?.jellyfinMediaId4k;
      if (otherQuality && normalizeId(otherQuality) === itemId) {
        throw new ConflictError(
          `request ${requestId} is for the ${request.is4k ? '4K' : 'HD'} version and ${itemId} is the ${request.is4k ? 'HD' : '4K'} item; a request never moves between them`,
          'quality_mismatch',
        );
      }
    }
  }

  /**
   * The existing items the grant's requests now resolve to (never its own deleted item), with the requests for each:
   * `targets`, or `revoked` for a request an administrator revoked from that item.
   */
  async #resolveRequestTargets(grant: GrantRecord, signal?: AbortSignal): Promise<{
    targets: Map<string, Record<string, string>>;
    revoked: Map<string, Record<string, string>>;
  }> {
    const targets = new Map<string, Record<string, string>>();
    const revoked = new Map<string, Record<string, string>>();
    if (!this.#seerr) return { targets, revoked };
    const exists = new Map<string, boolean>();
    for (const [requestId, userId] of Object.entries(grant.requests)) {
      throwIfAborted(signal);
      let request: SeerrRequest;
      try {
        request = await this.#seerr.getRequest(requestId);
      } catch (error) {
        rethrowIfCancelled(error, signal);
        if (isNotFound(error)) continue;
        throw error;
      }
      throwIfAborted(signal);
      const resolved = requestItemId(request);
      const itemId = resolved ? normalizeId(resolved) : undefined;
      if (!itemId || itemId === grant.itemId) continue;
      if (this.#store.isRequestRevoked(requestId, itemId)) {
        revoked.set(itemId, { ...revoked.get(itemId), [requestId]: userId });
        continue;
      }
      if (!exists.has(itemId)) {
        exists.set(itemId, await this.#itemExists(itemId));
        throwIfAborted(signal);
      }
      if (exists.get(itemId)) targets.set(itemId, { ...targets.get(itemId), [requestId]: userId });
    }
    return { targets, revoked };
  }

  async #itemExists(itemId: string): Promise<boolean> {
    try {
      await this.#jellyfin.getItem(itemId);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Without `signal` (webhooks, admin requests) a reconciliation always runs to completion or failure. With
   * `recoverMissing`, a deleted item rejects with MissingItemError without recording a failure, for the caller to recover.
   */
  async #reconcileGrant(grant: GrantRecord, signal?: AbortSignal, options: { recoverMissing?: boolean } = {}): Promise<ChangePlan> {
    try {
      throwIfAborted(signal);
      const context = await this.#buildPlan(grant, signal);
      await this.#applyPlan(context, signal);
      // Checked after every await from here on: shutdown can abort while a save is finishing, and nothing after it
      // (purging, counting) may then start. A grant left synced or pending is reconciled again after restart.
      throwIfAborted(signal);
      await this.#store.markSyncSuccess(grant.itemId);
      throwIfAborted(signal);
      if (!grant.active) {
        await this.#store.purgeInactive(grant.itemId);
        throwIfAborted(signal);
      }
      this.#metrics.increment('jfa_reconciliations_total', { result: 'success' });
      return context.plan;
    } catch (error) {
      rethrowIfCancelled(error, signal);
      if (options.recoverMissing && error instanceof MissingItemError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.markSyncError(grant.itemId, message);
      throwIfAborted(signal);
      this.#metrics.increment('jfa_reconciliations_total', { result: 'error' });
      throw error;
    } finally {
      this.#refreshGauges();
    }
  }

  /**
   * An active grant whose item Jellyfin reports deleted (404) rejects with MissingItemError. For an inactive one there
   * is nothing left to untag on the item, so the plan only clears its tag from user policies.
   */
  async #buildPlan(grant: GrantRecord, signal?: AbortSignal): Promise<PlanContext> {
    let missing: unknown;
    const [item, users] = await Promise.all([
      this.#jellyfin.getItem(grant.itemId).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
        missing = error;
        return undefined;
      }),
      this.#jellyfin.getUsers(),
    ]);
    throwIfAborted(signal);
    if (!item) {
      if (grant.active) throw new MissingItemError(grant.itemId, missing);
      return this.#buildPlanContext(grant, { Id: grant.itemId, Name: grant.itemId, Tags: [] }, users, []);
    }
    const administrator = users.find((user) => user.Policy.IsAdministrator);
    if (!administrator) throw new Error('Jellyfin administrator user not found');
    const relatedItems = await this.#jellyfin.getLocalTrailers(grant.itemId, administrator.Id);
    throwIfAborted(signal);
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

  async #applyPlan(context: PlanContext, signal?: AbortSignal): Promise<void> {
    if (context.plan.item.action !== 'none') {
      throwIfAborted(signal);
      await this.#jellyfin.updateItem({ ...context.item, Tags: context.plan.item.after });
      this.#metrics.increment('jfa_item_updates_total');
    }
    for (const change of context.plan.relatedItems) {
      if (change.action === 'none') continue;
      throwIfAborted(signal);
      const relatedItem = context.relatedItems.find((entry) => entry.Id === change.itemId);
      if (!relatedItem) throw new Error(`Jellyfin related item disappeared during reconciliation: ${change.itemId}`);
      await this.#jellyfin.updateItem({ ...relatedItem, Tags: change.after });
      this.#metrics.increment('jfa_item_updates_total');
    }
    for (const change of context.plan.users) {
      if (change.action === 'none') continue;
      throwIfAborted(signal);
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

  #logDebug(message: string, fields: Record<string, unknown>): void {
    if (this.#debug) console.debug(JSON.stringify({ level: 'debug', message, ...fields }));
  }

  #refreshGauges(): void {
    const grants = this.#store.list();
    this.#metrics.gauge('jfa_grants', grants.filter((grant) => grant.active).length);
    this.#metrics.gauge('jfa_sync_errors', grants.filter((grant) => grant.sync.state === 'error').length);
    this.#metrics.gauge('jfa_orphaned_grants', grants.filter((grant) => grant.sync.state === 'orphaned').length);
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

function sourceExistsError(itemId: string): ConflictError {
  return new ConflictError(
    `source item still exists in Jellyfin: ${itemId}; moving its grant would make it visible to every household, so revoke its access explicitly first`,
    'source_item_exists',
  );
}

function isDue(grant: GrantRecord): boolean {
  if (grant.sync.state === 'orphaned') return false;
  if (grant.sync.state === 'pending') return true;
  if (grant.sync.state === 'synced') return true;
  return !grant.sync.nextRetryAt || Date.parse(grant.sync.nextRetryAt) <= Date.now();
}

// A 4K request never falls back to the HD item: it must not privatize an HD title that is public.
function requestItemId(request: SeerrRequest): string | undefined {
  return request.is4k ? request.media?.jellyfinMediaId4k : request.media?.jellyfinMediaId;
}

function requestMediaStatus(request: SeerrRequest): number | undefined {
  return request.is4k ? request.media?.status4k : request.media?.status;
}
