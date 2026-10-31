import type { LogLevel } from './config.js';
import type { HouseholdAddressEntry } from './household-addresses.js';
import type { JellyfinClient } from './jellyfin.js';
import { Metrics } from './metrics.js';
import { RECENT_REQUESTS_LIMIT, SeerrError, type SeerrClient } from './seerr.js';
import { normalizeId, UNKNOWN_REQUESTER, type GrantMove, type GrantRemainder, type GrantStore, type HiddenTitle, type HideTitleResult } from './store.js';
import type {
  AccessGroup,
  AccessRemovals,
  AppRequestRecord,
  AppRequestStatus,
  AppSafetyTombstone,
  AppWithdrawal,
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

/** What a household app join did: see AccessService.joinHousehold. */
export type HouseholdJoinResult = 'joined' | 'already' | 'refused' | 'ungranted' | 'error' | 'cancelled';

/** Most title holds (see AccessService.applyTitleHolds) read in one run, least recently checked first; the rest wait for the next. */
const MAX_TITLE_HOLD_READS = 50;

/** Most entries {@link AccessService.appOutstanding} lists of each kind, oldest first; the counts are always complete. */
export const MAX_OUTSTANDING_ENTRIES = 200;

/**
 * What "Get this" still has in flight or still protects, for the administrator (admin host only): the safety
 * tombstones that still decide a grant, the request intents not settled yet and the webhooks deferred for them. A
 * version that does not read these (2.3.0, 2.2.1) would grant those requests as ordinary ones, so a rollback waits
 * until every count is 0 (`clear`). Names titles by TMDB ID and intents by household, never a member.
 */
export interface AppOutstanding {
  clear: boolean;
  safetyMarkers: {
    total: number;
    /** `request`: names the requests it covers; `member`: also covers the member's later requests for the title. */
    byKind: { request: number; member: number };
    oldestAgeSeconds: number | null;
    entries: Array<{ kind: 'request' | 'member'; mediaType: string; tmdbId: number; createdAt: string; expiresAt: string }>;
  };
  requestIntents: {
    total: number;
    byKind: { submitting: number; settling: number };
    oldestAgeSeconds: number | null;
    entries: Array<{ kind: 'submitting' | 'settling'; mediaType: string; tmdbId: number; householdId: string; createdAt: string }>;
  };
  /** Kept without a time, so no age. */
  deferredWebhooks: { total: number };
  /**
   * Household app cancels that still decide a grant (see AppWithdrawal): `waiting`, the request is not handled yet;
   * `granted`, a grant records a request its requester withdrew, and gives that requester no access through it.
   */
  withdrawals: {
    total: number;
    byKind: { waiting: number; granted: number };
    /**
     * The title holds: Seerr no longer has the request, and its title's items are held as they arrive until every one is
     * on a grant (see AccessService.applyTitleHolds); `waiting` until the first is held, `granted` after.
     */
    titleHolds: number;
    /** Of `granted`, the titles held for no household (see AccessService.appHeld). */
    held: number;
    oldestAgeSeconds: number | null;
    entries: Array<{ kind: 'waiting' | 'granted'; mediaType: string; tmdbId: number; createdAt: string }>;
  };
}

/**
 * Titles a household app cancel left held for no household (admin host only): the request's requester withdrew it, no
 * household still followed it when it was granted (or none has joined since), and no administrator has given it to
 * anyone yet. The item is private to every user but Jellyfin's administrators until an administrator decides
 * (households or users through the grant tools, or revoking the request to make it public).
 */
export interface AppHeldTitles {
  total: number;
  titles: Array<{ itemId: string; requestId: string; mediaType: string; tmdbId: number; cancelledAt: string; grantedAt?: string }>;
}

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
  /** Each title hold's last turn in #applyTitleHolds (see #holdTurn), so the least recently checked go first. */
  readonly #holdTurns = new Map<string, number>();
  #holdTurn = 0;
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

  public getHouseholdFeatures(groupId: string) {
    const group = this.#store.getGroup(groupId);
    return { appEnabled: group?.appEnabled === true, tvAddonEnabled: group?.tvAddonEnabled === true };
  }

  public setHouseholdFeatures(groupId: string, features: { appEnabled: boolean; tvAddonEnabled: boolean }) {
    return this.#store.setHouseholdFeatures(groupId, features);
  }

  /** The household address map as stored (see GrantStore.getHouseholdAddresses). */
  public getHouseholdAddresses(): Readonly<Record<string, Readonly<HouseholdAddressEntry>>> {
    return this.#store.getHouseholdAddresses();
  }

  /** Stores one household's address entry, or removes it; the caller has checked the whole map. */
  public async setHouseholdAddresses(groupId: string, entry: HouseholdAddressEntry | undefined): Promise<void> {
    await this.#store.setHouseholdAddresses(groupId, entry);
  }

  public getHouseholdMemberIds(groupId: string): string[] | undefined {
    return this.#store.getGroup(groupId)?.userIds;
  }

  /** A member's hidden titles in a household, as keys (see GrantStore.hiddenTitleKeys). */
  public hiddenTitleKeys(householdId: string, userId: string): ReadonlySet<string> {
    return this.#store.hiddenTitleKeys(householdId, userId);
  }

  /** A member's hidden titles in a household, newest first (see GrantStore.listHiddenTitles). */
  public listHiddenTitles(householdId: string, userId: string): HiddenTitle[] {
    return this.#store.listHiddenTitles(householdId, userId);
  }

  /** See GrantStore.hideTitle. */
  public hideTitle(input: { householdId: string; userId: string; mediaType: 'movie' | 'tv'; tmdbId: number; at: string }): Promise<HideTitleResult> {
    return this.#store.hideTitle(input);
  }

  /** See GrantStore.unhideTitle. */
  public unhideTitle(input: { householdId: string; userId: string; mediaType: 'movie' | 'tv'; tmdbId: number }): Promise<'unhidden' | 'not_member'> {
    return this.#store.unhideTitle(input);
  }

  public getHouseholdName(groupId: string): string | undefined {
    return this.#store.getGroup(groupId)?.name;
  }

  /** How many households there are. */
  public getHouseholdTotal(): number {
    return this.#store.countGroups();
  }

  /** Counts a household app API answer by endpoint and outcome. */
  public recordAppRequest(endpoint: string, outcome: string): void {
    this.#metrics.increment('jfa_app_requests_total', { endpoint, outcome });
  }

  /** See {@link AppOutstanding}. */
  public appOutstanding(now = Date.now()): AppOutstanding {
    const age = (times: string[]) => times.length === 0 ? null : Math.max(0, Math.floor((now - Math.min(...times.map(Date.parse))) / 1000));
    const oldestFirst = <T extends { createdAt: string }>(entries: T[]) =>
      [...entries].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(0, MAX_OUTSTANDING_ENTRIES);
    const markers = this.#store.listOutstandingAppSafetyTombstones(now).map((tombstone) => ({
      kind: tombstone.jellyfinUserId === undefined ? 'request' as const : 'member' as const,
      mediaType: tombstone.mediaType,
      tmdbId: tombstone.tmdbId,
      createdAt: tombstone.createdAt,
      expiresAt: tombstone.expiresAt,
    }));
    const intents = this.#store.listAppRequestIntents().map(([, intent]) => ({
      kind: intent.status,
      mediaType: intent.mediaType,
      tmdbId: intent.tmdbId,
      householdId: intent.householdId,
      createdAt: intent.createdAt,
    }));
    const deferred = this.#store.listDeferredWebhooks().length;
    const withdrawals = this.#store.listOutstandingAppWithdrawals(now).map(([requestId, withdrawal]) => ({
      kind: this.#store.hasHandledRequest(requestId) ? 'granted' as const : 'waiting' as const,
      mediaType: withdrawal.mediaType,
      tmdbId: withdrawal.tmdbId,
      createdAt: withdrawal.createdAt,
    }));
    return {
      clear: markers.length === 0 && intents.length === 0 && deferred === 0 && withdrawals.length === 0,
      safetyMarkers: {
        total: markers.length,
        byKind: { request: markers.filter((marker) => marker.kind === 'request').length, member: markers.filter((marker) => marker.kind === 'member').length },
        oldestAgeSeconds: age(markers.map((marker) => marker.createdAt)),
        entries: oldestFirst(markers),
      },
      requestIntents: {
        total: intents.length,
        byKind: { submitting: intents.filter((intent) => intent.kind === 'submitting').length, settling: intents.filter((intent) => intent.kind === 'settling').length },
        oldestAgeSeconds: age(intents.map((intent) => intent.createdAt)),
        entries: oldestFirst(intents),
      },
      deferredWebhooks: { total: deferred },
      withdrawals: {
        total: withdrawals.length,
        byKind: { waiting: withdrawals.filter((entry) => entry.kind === 'waiting').length, granted: withdrawals.filter((entry) => entry.kind === 'granted').length },
        titleHolds: this.#store.listAppTitleHolds(now).length,
        held: this.appHeld().total,
        oldestAgeSeconds: age(withdrawals.map((entry) => entry.createdAt)),
        entries: oldestFirst(withdrawals),
      },
    };
  }

  /** See {@link AppHeldTitles}. */
  public appHeld(): AppHeldTitles {
    const titles = this.#store.listOutstandingAppWithdrawals().flatMap(([requestId, withdrawal]) => {
      if (!withdrawal.requester || !this.#store.hasHandledRequest(requestId)) return [];
      const grant = this.#store.findGrantForRequest(requestId);
      if (!grant?.active || this.#store.resolveOwners(grant).length > 0) return [];
      return [{
        itemId: grant.itemId,
        requestId,
        mediaType: withdrawal.mediaType,
        tmdbId: withdrawal.tmdbId,
        cancelledAt: withdrawal.createdAt,
        ...(withdrawal.grantedAt ? { grantedAt: withdrawal.grantedAt } : {}),
      }];
    }).sort((left, right) => left.cancelledAt.localeCompare(right.cancelledAt));
    return { total: titles.length, titles: titles.slice(0, MAX_OUTSTANDING_ENTRIES) };
  }

  /**
   * Gives a title held for no household (see appHeld) to `groupIds`, added to the households its grant has, and applies
   * it. The check and the write are one turn of the write queue, so of two releases of the same title only the first
   * finds it held: a later one whose households the grant has already is `unchanged`, any other `not_held`.
   */
  public releaseHeld(requestId: string, groupIds: string[]): Promise<{ result: 'released' | 'unchanged'; itemId: string } | { result: 'not_found' } | { result: 'not_held' }> {
    return this.#exclusive(async () => {
      const grant = this.#store.findGrantForRequest(requestId);
      if (!grant?.active) return { result: 'not_found' as const };
      const wanted = groupIds.map(normalizeId);
      const withdrawal = this.#store.getAppWithdrawal(requestId);
      const held = withdrawal?.requester === true && this.#store.hasHandledRequest(requestId) && this.#store.resolveOwners(grant).length === 0;
      if (!held) return wanted.every((id) => grant.groupIds.includes(id)) ? { result: 'unchanged' as const, itemId: grant.itemId } : { result: 'not_held' as const };
      const result = await this.#store.setGrantGroups(grant.itemId, [...new Set([...grant.groupIds, ...wanted])]);
      await this.#reconcileGrant(result.current);
      return { result: 'released' as const, itemId: grant.itemId };
    });
  }

  /**
   * Applies the title holds (docs/app-design.md, "Cancelling (step 2c)"; AppWithdrawal `seerrGoneAt`): a request its
   * requester withdrew and an administrator then deleted in Seerr may still download, and with no request nothing would
   * grant its title, which would arrive public. For each hold, the title's HD items Jellyfin has now (see #heldItems)
   * are decided by the safety markers as they are now, in #grantRule's order (see #holdRule), never by what the cancel
   * captured: while a "Get this" intent names the title, the hold waits; if the request follows the join rules (a
   * record or safety tombstone says so now), it is granted as a join (#grantAsJoin), never privately; otherwise each
   * item no active grant holds is granted to the deleted request with no household and its requester left out (as
   * #grantGroups and GrantStore.resolveOwners do for any request its requester withdrew): held for no household, and
   * listed by appHeld; the households following the title then (an awaiting interest) join as for any grant. A hold is
   * kept until every item has an active grant (or the request was revoked from it), so an item whose grant failed is
   * tried again on the next run, and is then dropped: the title is private. At most {@link MAX_TITLE_HOLD_READS} holds a
   * run, those checked longest ago first, so every hold gets its turn however many there are; a failure is logged and
   * tried again on the next. Run while there are holds by the household app's refresh (each scheduled reconciliation),
   * after each MEDIA_AVAILABLE webhook, and by the backfill, reconcileAll and the library catalog sync, so a title that
   * arrives with no request to scan is held by whichever runs first.
   */
  public applyTitleHolds(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#store.listAppTitleHolds().length === 0) return Promise.resolve();
    return this.#exclusive(() => this.#applyTitleHolds(options.signal));
  }

  /** applyTitleHolds, in the write queue; nothing to do (and no Jellyfin read) while there are no holds. */
  async #applyTitleHolds(signal?: AbortSignal): Promise<void> {
    const holds = this.#store.listAppTitleHolds();
    const known = new Set(holds.map(([requestId]) => requestId));
    for (const requestId of [...this.#holdTurns.keys()]) if (!known.has(requestId)) this.#holdTurns.delete(requestId);
    const due = holds
      .sort(([left], [right]) => (this.#holdTurns.get(left) ?? 0) - (this.#holdTurns.get(right) ?? 0))
      .slice(0, MAX_TITLE_HOLD_READS);
    for (const [requestId, hold] of due) {
      throwIfAborted(signal);
      this.#holdTurns.set(requestId, ++this.#holdTurn);
      try {
        const itemIds = await this.#heldItems(hold.mediaType, hold.tmdbId);
        throwIfAborted(signal);
        if (itemIds.length === 0) continue;
        const rule = this.#holdRule(requestId, hold);
        if (rule === 'defer') continue;
        if (rule === 'join') {
          // Handled once joined, and no grant records it: no longer a hold (GrantStore.listAppTitleHolds).
          for (const itemId of itemIds) {
            throwIfAborted(signal);
            await this.#grantAsJoin(itemId, requestId, signal);
          }
          console.log(JSON.stringify({ level: 'info', message: 'household app title hold granted as a join: a safety marker covers its request', requestId }));
          continue;
        }
        const decided = (itemId: string) => this.#store.get(itemId)?.active === true || this.#store.isRequestRevoked(requestId, itemId);
        for (const itemId of itemIds.filter((entry) => !decided(entry))) {
          throwIfAborted(signal);
          const grant = await this.#store.grant({
            itemId,
            requestId,
            userId: hold.requesterId ?? UNKNOWN_REQUESTER,
            groupIds: this.#grantGroups(requestId, hold.requesterId ?? UNKNOWN_REQUESTER),
            mediaType: hold.mediaType,
          });
          console.log(JSON.stringify({ level: 'info', message: 'household app title held: its cancelled request was deleted in Seerr', requestId, itemId: grant.itemId }));
          await this.#reconcileGrant(grant, signal);
          throwIfAborted(signal);
          await this.#settleAppRequests(grant.itemId, requestId, signal);
        }
        if (itemIds.every(decided)) {
          await this.#store.writeAppRequests({ dropTitleHolds: [requestId] });
          console.log(JSON.stringify({ level: 'info', message: 'household app title hold dropped: every item of its title is on a grant', requestId }));
        }
      } catch (error) {
        rethrowIfCancelled(error, signal);
        console.error(JSON.stringify({
          level: 'error',
          message: 'household app title hold could not be applied',
          requestId,
          detail: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  /**
   * How a title hold is applied now: #grantRule for a request Seerr no longer has, read from the markers as they are at
   * apply time (a tombstone written after the cancel captured `requesterId`, say by a later settle of the request's
   * intent, whose join rule a withdrawn record no longer takes, still wins). `join` when a record or a tombstone names
   * the request, `defer` while a "Get this" intent names the title, `join` when a member-wide tombstone covers the
   * requester's request (it was made no later than the cancel, the most Seerr's lost request still tells), else
   * `grant` (held for no household). A requester whose Jellyfin ID is not known (AppWithdrawal `titleHold`) is no
   * member, so no member-wide tombstone covers them.
   */
  #holdRule(requestId: string, hold: AppWithdrawal): GrantRule {
    const tombstones = this.#store.listAppSafetyTombstones();
    if (this.#grantsAsJoin(requestId) || tombstones.some((tombstone) => tombstone.requestIds.includes(requestId))) return 'join';
    if (this.#store.hasAppRequestIntent(hold.mediaType, hold.tmdbId)) return 'defer';
    if (hold.requesterId === undefined) return 'grant';
    const now = Date.now();
    const request: RequestFacts = { mediaType: hold.mediaType, tmdbId: hold.tmdbId, requester: hold.requesterId, createdAt: Date.parse(hold.createdAt) };
    return tombstones.some((tombstone) => tombstone.jellyfinUserId !== undefined && now < Date.parse(tombstone.expiresAt)
      && covers(tombstone, requestId, request)) ? 'join' : 'grant';
  }

  /**
   * The HD movie or series items Jellyfin holds of a title, read with JellyPass's key: every item with its TMDB ID and
   * Seerr's HD item for it, never the item Seerr links as the 4K one only, and never an item matched by name only.
   * Throws when Jellyfin, or Seerr (with the admin key), cannot be read: a hold is applied only once both are.
   */
  async #heldItems(mediaType: 'movie' | 'tv', tmdbId: number): Promise<string[]> {
    const title = this.#seerr ? await this.#seerr.titleRequests(mediaType, tmdbId) : undefined;
    const hd = title?.jellyfinMediaId ? normalizeId(title.jellyfinMediaId) : undefined;
    const fourK = title?.jellyfinMediaId4k ? normalizeId(title.jellyfinMediaId4k) : undefined;
    const [byTmdb, linked] = await Promise.all([
      this.#jellyfin.findItemsByTmdbId(mediaType, tmdbId),
      hd ? this.#jellyfin.existingItems(mediaType, [hd]) : Promise.resolve([]),
    ]);
    return [...new Set([...byTmdb, ...linked].map(normalizeId))].filter((itemId) => itemId !== fourK || itemId === hd).sort();
  }

  /**
   * Runs `work` in the write queue grants are decided in, so no webhook, replay, backfill or join runs meanwhile: for
   * the household app's cancel, whose withdrawal must be written either wholly before or wholly after a grant of the
   * request is decided (see AppWithdrawal). `work` must not call back into this service.
   */
  public serialized<T>(work: () => Promise<T>): Promise<T> {
    return this.#exclusive(work);
  }

  /** Counts a household app "Get this" call by what its eligibility check decided; never by title. */
  public recordGetThis(result: string): void {
    this.#metrics.increment('jfa_app_get_this_total', { result });
  }

  /** Counts what a "Get this" did in the background, by branch; never by title. */
  public recordGetThisBranch(branch: string): void {
    this.#metrics.increment('jfa_app_get_this_branches_total', { branch });
  }

  /** Every Jellyfin user, as Jellyfin's admin API lists them (hidden and disabled users included). */
  public listJellyfinUsers(): Promise<JellyfinUser[]> {
    return this.#jellyfin.getUsers();
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
      // New items: a title whose request Seerr lost is held as it appears.
      await this.#applyTitleHolds(options.signal);
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

  #lastRemovedWebhookAt: number | null = null;
  #removedWebhookWarnings = new Map<string, number>();

  public webhookStatus(): { lastRemovedFormAt: number | null } {
    return { lastRemovedFormAt: this.#lastRemovedWebhookAt };
  }

  public recordRemovedWebhook(error: string): void {
    const now = Date.now();
    this.#lastRemovedWebhookAt = now;
    this.#metrics.increment('jfa_webhooks_total', { result: 'removed_form' });
    if (now - (this.#removedWebhookWarnings.get(error) ?? -Infinity) >= 60_000) {
      this.#removedWebhookWarnings.set(error, now);
      console.warn(JSON.stringify({ level: 'warn', message: 'Seerr webhook refused: update authorization header and template', error }));
    }
  }

  public recordInvalidWebhook(): void {
    this.#metrics.increment('jfa_webhooks_total', { result: 'invalid' });
  }

  public processWebhook(event: SeerrWebhook | IgnoredWebhook): Promise<GrantRecord | null> {
    return this.#exclusive(async () => {
      this.#lastRemovedWebhookAt = null;
      if (event.notificationType !== 'MEDIA_AVAILABLE' || !('request' in event)) {
        this.#metrics.increment('jfa_webhooks_total', { result: 'ignored' });
        return null;
      }
      try {
        return await this.#grantWebhook(event);
      } finally {
        // Something arrived: a title whose request Seerr lost has no webhook of its own (and one for such a request
        // cannot be granted, Seerr no longer having it), so the holds are applied whether or not this one was granted.
        await this.#applyTitleHolds();
      }
    });
  }

  /** processWebhook for a MEDIA_AVAILABLE event, in the write queue; `known` is its grant rule, if already read. */
  async #grantWebhook(event: SeerrWebhook, known?: GrantRule): Promise<GrantRecord | null> {
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
        const current = this.#store.findGrantForRequest(event.request.id);
        if (current) await this.#settleAppRequests(current.itemId, event.request.id);
        this.#metrics.increment('jfa_webhooks_total', { result: 'granted' });
        return this.#store.findGrantForRequest(event.request.id) ?? existing;
      }
      // A "Get this" request for the title is not settled yet: granted once it is (see retryDeferredRequests).
      const rule = known ?? await this.#grantRule(event.request.id);
      if (rule === 'defer') {
        await this.#store.deferWebhook(event);
        this.#metrics.increment('jfa_webhooks_total', { result: 'deferred' });
        console.log(JSON.stringify({ level: 'info', message: 'webhook deferred for a household app request', requestId: event.request.id }));
        return null;
      }
      const resolved = await this.#resolveWebhook(event);
      if (rule === 'join') {
        const joined = await this.#grantAsJoin(resolved.itemId, event.request.id);
        this.#metrics.increment('jfa_webhooks_total', { result: 'joined' });
        return joined;
      }
      const grant = await this.#store.grant({
        itemId: resolved.itemId,
        requestId: event.request.id,
        userId: resolved.userId,
        groupIds: this.#grantGroups(event.request.id, resolved.userId),
        ...(resolved.mediaType ? { mediaType: resolved.mediaType } : {}),
      });
      await this.#reconcileGrant(grant);
      await this.#settleAppRequests(grant.itemId, event.request.id);
      this.#metrics.increment('jfa_webhooks_total', { result: 'granted' });
      return this.#store.get(grant.itemId) ?? grant;
    } catch (error) {
      this.#metrics.increment('jfa_webhooks_total', { result: 'error' });
      throw error;
    }
  }

  /**
   * Grants the webhooks deferred for a "Get this" request intent (see #grantRule) that need wait no longer, as their
   * first delivery would have been: genuine requests first, as new grants, then those whose grant follows the join
   * rules, so a join replayed with the grant it joins finds it, whatever order they arrived in. One whose request Seerr
   * no longer has, or that is handled already, is forgotten; a failure is logged and tried again on the next run. Run by
   * the household app after an intent is resolved, and with each refresh.
   */
  public retryDeferredRequests(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    if (this.#store.listDeferredWebhooks().length === 0) return Promise.resolve();
    return this.#exclusive(async () => {
      const done: string[] = [];
      const failed = (requestId: string, error: unknown) => {
        rethrowIfCancelled(error, signal);
        if (error instanceof SeerrError && error.status === 404) return void done.push(requestId);
        console.error(JSON.stringify({
          level: 'error',
          message: 'deferred webhook could not be granted',
          requestId,
          detail: error instanceof Error ? error.message : String(error),
        }));
      };
      try {
        const ready: Array<{ event: SeerrWebhook; rule: GrantRule }> = [];
        for (const event of this.#store.listDeferredWebhooks()) {
          throwIfAborted(signal);
          try {
            if (this.#store.hasHandledRequest(event.request.id)) {
              done.push(event.request.id);
              continue;
            }
            const rule = await this.#grantRule(event.request.id);
            if (rule !== 'defer') ready.push({ event, rule });
          } catch (error) {
            failed(event.request.id, error);
          }
        }
        for (const { event, rule } of [...ready.filter((entry) => entry.rule === 'grant'), ...ready.filter((entry) => entry.rule === 'join')]) {
          throwIfAborted(signal);
          try {
            await this.#grantWebhook(event, rule);
            done.push(event.request.id);
          } catch (error) {
            failed(event.request.id, error);
          }
        }
      } finally {
        if (done.length > 0) await this.#store.forgetDeferredWebhooks(done);
      }
    });
  }

  /**
   * How a request may be granted now (docs/app-design.md, "Safety tombstones"):
   *
   * - `defer`: a household app "Get this" request intent (see AppRequestIntent) names its title, or the request's title,
   *   requester or creation time must be known and cannot be read (Seerr, with the admin key, read only while there
   *   are intents or member-wide tombstones), so a request "Get this" may have made is never granted privately before
   *   it is settled;
   * - `join`: "Get this" made it, or may have, and its grant follows the library join rules: a record says so
   *   (AppRequestRecord.joinOnGrant), or a safety tombstone covers it (see AppSafetyTombstone);
   * - `grant`: a new grant, as for any request.
   *
   * Throws the SeerrError of a request Seerr no longer has.
   */
  async #grantRule(requestId: string, known?: SeerrRequest): Promise<GrantRule> {
    const now = Date.now();
    const tombstones = this.#store.listAppSafetyTombstones();
    if (this.#grantsAsJoin(requestId) || tombstones.some((tombstone) => tombstone.requestIds.includes(requestId))) return 'join';
    const intents = this.#store.listAppRequestIntents().length > 0;
    const members = tombstones.filter((tombstone) => tombstone.jellyfinUserId !== undefined && now < Date.parse(tombstone.expiresAt));
    if (!intents && members.length === 0) return 'grant';
    const request = await this.#requestFacts(requestId, known);
    if (!request) return 'defer';
    if (intents && this.#store.hasAppRequestIntent(request.mediaType, request.tmdbId)) return 'defer';
    return members.some((tombstone) => covers(tombstone, requestId, request)) ? 'join' : 'grant';
  }

  /**
   * What #grantRule reads of a request: its title, requester and creation time, from `known` or from Seerr (with the
   * admin key). Undefined when they cannot be read; throws the SeerrError of a request Seerr no longer has.
   */
  async #requestFacts(requestId: string, known?: SeerrRequest): Promise<RequestFacts | undefined> {
    let request = known;
    if (typeof request?.media?.tmdbId !== 'number') {
      if (!this.#seerr) return undefined;
      try {
        request = await this.#seerr.getRequest(requestId);
      } catch (error) {
        if (error instanceof SeerrError && error.status === 404) throw error;
        return undefined;
      }
    }
    const mediaType = request.media?.mediaType ?? request.type;
    const tmdbId = request.media?.tmdbId;
    if (typeof tmdbId !== 'number' || (mediaType !== 'movie' && mediaType !== 'tv')) return undefined;
    const requester = request.requestedBy?.jellyfinUserId;
    const createdAt = Date.parse(request.createdAt ?? '');
    return {
      mediaType,
      tmdbId,
      ...(typeof requester === 'string' && requester !== '' ? { requester: normalizeId(requester) } : {}),
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    };
  }

  /**
   * The household app's join branch of "Get this": adds `householdId` (only the household whose host the call was made
   * on, never the caller's other households, and only while it is the household the call was made for: the same
   * `householdEpoch`; with `recordId`, only while that record is still followed: pending or failed, never withdrawn) to
   * the grant of each of `itemIds` through the library join rules (see
   * GrantStore.joinGrant: only an active grant with a request is joined, an administrator's removal of the household or
   * of the caller sticks, manual-only grants and items without a grant are left alone) and applies each join. Resolves
   * `joined` when a grant changed, `already` when the household was already on one, `ungranted` when none of the items
   * has a grant at all, and `refused` otherwise. It runs in the background, its result must never reach the caller's answer, failures are logged and
   * reported as `error`, and an aborted `signal` (shutdown) stops it before its next step (`cancelled`).
   */
  public async joinHousehold(
    input: { itemIds: string[]; userId: string; householdId: string; householdEpoch?: number; recordId?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<HouseholdJoinResult> {
    const { signal } = options;
    // Once stored, a join is reported as such even if applying it is cut short: it is applied after restart.
    let stored: 'joined' | 'already' | 'refused' | 'ungranted' | undefined;
    try {
      throwIfAborted(signal);
      return await this.#exclusive(async () => {
        throwIfAborted(signal);
        // A household deleted (or deleted and created again) since the call began joins nothing.
        if (input.householdEpoch !== undefined && this.#store.householdEpoch(input.householdId) !== input.householdEpoch) {
          stored = 'refused';
          return stored;
        }
        // The record the join is for (a refresh's) was withdrawn, or settled otherwise, since it was read.
        const record = input.recordId === undefined ? undefined : this.#store.getAppRequest(input.recordId);
        if (input.recordId !== undefined && (!record || record.withdrawn || record.detached || (record.status !== 'pending' && record.status !== 'failed'))) {
          stored = 'refused';
          return stored;
        }
        const { result, joined } = await this.#joinHouseholdNow(input.itemIds, input.userId, input.householdId);
        stored = result;
        for (const grant of joined) {
          throwIfAborted(signal);
          try {
            await this.#reconcileGrant(grant, signal);
          } catch (error) {
            rethrowIfCancelled(error, signal);
            console.error(JSON.stringify({
              level: 'error',
              message: 'household app join reconciliation failed',
              itemId: grant.itemId,
              detail: error instanceof Error ? error.message : String(error),
            }));
          }
        }
        return result;
      });
    } catch (error) {
      if (error instanceof OperationCancelledError || signal?.aborted) return stored ?? 'cancelled';
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app join failed',
        detail: error instanceof Error ? error.message : String(error),
      }));
      return stored ?? 'error';
    }
  }

  /** The joins of joinHousehold, stored but not yet applied; in the write queue. */
  async #joinHouseholdNow(itemIds: string[], userId: string, householdId: string): Promise<{
    result: 'joined' | 'already' | 'refused' | 'ungranted';
    joined: GrantRecord[];
  }> {
    const groupId = normalizeId(householdId);
    if (!this.#store.getGroup(groupId)) return { result: 'refused', joined: [] };
    if (!itemIds.some((itemId) => this.#store.get(itemId))) return { result: 'ungranted', joined: [] };
    let result: 'joined' | 'already' | 'refused' | 'ungranted' = 'refused';
    const joined: GrantRecord[] = [];
    for (const itemId of itemIds) {
      const change = await this.#store.joinGrant({ itemId, userId, groupIds: [groupId] });
      if (change) {
        joined.push(change.current);
        result = 'joined';
        const join = change.current.joins?.at(-1);
        console.log(JSON.stringify({ level: 'info', message: 'household app join', userId, itemId: change.current.itemId, groupIds: join?.groupIds ?? [] }));
        continue;
      }
      const grant = this.#store.get(itemId);
      if (result === 'refused' && grant?.active && grant.groupIds.includes(groupId)) result = 'already';
    }
    return { result, joined };
  }

  /**
   * Settles household app records once `requestId` was granted on `itemId` (a webhook or the backfill), whether as a
   * new grant or as a join (see #grantAsJoin): a request the app made is ready, and each household that registered
   * interest in that request (or, for a movie or an interest that found no request, in the item's title) joins the
   * item's grant through the library join rules, so an administrator's removals stick. A request the app made whose
   * grant follows the join rules (AppRequestRecord.joinOnGrant) joins its household the same way. An interest whose
   * household could not join a grant is `failed` (still counted, as Seerr counts a failed request); one for an item no
   * grant holds (a request granted as a join of a public title) needs no join. A record is `completed` once Jellyfin has
   * episodes of every season it covers (a movie at once); until then its ready seasons are noted and the app's refresh
   * reads it again. Runs in the write queue. A failure here is logged and never fails the grant; the app's scheduled
   * refresh tries again.
   */
  async #settleAppRequests(itemId: string, requestId: string, signal?: AbortSignal): Promise<void> {
    try {
      const records = this.#store.listAppRequests()
        // A withdrawn record is never settled or joined, whatever its status says.
        .filter(([, record]) => !record.detached && !record.withdrawn && (record.status === 'pending' || record.status === 'failed'));
      if (records.length === 0) return;
      let title: { mediaType: 'movie' | 'tv'; tmdbId: number } | undefined | null = null;
      let seasons: Set<number> | undefined;
      const ready = async (record: AppRequestRecord) => {
        if (record.mediaType === 'movie') return { status: 'completed' as const, itemIds: [itemId] };
        seasons ??= new Set(await this.#jellyfin.seasonsWithEpisodes(itemId));
        throwIfAborted(signal);
        const readySeasons = record.seasons.filter((season) => seasons?.has(season));
        return { status: readySeasons.length === record.seasons.length ? 'completed' as const : 'pending' as const, itemIds: [itemId], readySeasons };
      };
      const updates: Array<{ id: string; status: AppRequestStatus; itemIds?: string[]; readySeasons?: number[]; awaitingGrant?: boolean }> = [];
      const joined: GrantRecord[] = [];
      // Its requester cancelled it: the grant gave their households nothing, so a record of theirs made since (asking
      // again) joins like any follower's.
      const requesterWithdrew = this.#store.getAppWithdrawal(requestId)?.requester === true || this.#store.listAppRequests()
        .some(([, record]) => record.withdrawn && record.branch === 'request' && record.seerrRequestId === requestId);
      for (const [id, record] of records) {
        if (record.branch === 'join') continue;
        // A record that found no grant for the item joins the one created now.
        let matches = record.seerrRequestId === requestId || (record.awaitingGrant === true && (record.itemIds ?? []).includes(normalizeId(itemId)));
        if (!matches && record.branch === 'interest' && (record.mediaType === 'movie' || !record.seerrRequestId)) {
          if (title === null) title = await this.#itemTitle(itemId);
          throwIfAborted(signal);
          matches = title?.mediaType === record.mediaType && title.tmdbId === record.tmdbId;
        }
        if (!matches) continue;
        if (record.branch === 'request' && !record.joinOnGrant && !requesterWithdrew) {
          updates.push({ id, ...await ready(record) });
          continue;
        }
        const outcome = await this.#joinHouseholdNow([itemId], record.jellyfinUserId, record.householdId);
        throwIfAborted(signal);
        joined.push(...outcome.joined);
        if (outcome.result === 'refused') updates.push({ id, status: 'failed', itemIds: [itemId] });
        else if (outcome.result === 'ungranted') {
          // No grant to join: the title is public. Never `completed` against it: joined when a grant is created.
          const { readySeasons } = await ready(record);
          updates.push({ id, status: 'pending', itemIds: [itemId], readySeasons: record.mediaType === 'movie' ? [0] : readySeasons ?? [], awaitingGrant: true });
        } else updates.push({ id, ...await ready(record), awaitingGrant: false });
      }
      if (updates.length > 0) await this.#store.writeAppRequests({ update: updates });
      throwIfAborted(signal);
      const latest = joined.at(-1);
      if (latest) await this.#reconcileGrant(this.#store.get(latest.itemId) ?? latest, signal);
    } catch (error) {
      rethrowIfCancelled(error, signal);
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app records could not be settled for a grant',
        requestId,
        itemId,
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * The households a new grant of `requestId` adds (docs/app-design.md, "Cancelling (step 2c)"): its requester's, less
   * any that withdrew from the request; none at all when the requester withdrew it (see AppWithdrawal), so only the
   * households still following it join (#settleAppRequests), and with none the title is held for no household.
   * Checked in the write queue, so a cancel is either wholly before the grant or too late for it.
   */
  #grantGroups(requestId: string, userId: string): string[] {
    const withdrawal = this.#store.getAppWithdrawal(requestId);
    if (withdrawal?.requester) {
      console.log(JSON.stringify({ level: 'info', message: 'household app request granted after its requester cancelled it', requestId }));
      return [];
    }
    return this.#store.listGroupIdsForUser(userId).filter((groupId) => !withdrawal?.householdIds.includes(groupId));
  }

  /**
   * Whether a request is one "Get this" made whose grant must follow the library join rules rather than be a new grant
   * (docs/app-design.md, "Late requests" and "New seasons of a series Jellyfin has"): its record says so
   * (AppRequestRecord.joinOnGrant). A request whose record is not written or not settled yet is never granted at all
   * (see #grantRule).
   */
  #grantsAsJoin(requestId: string): boolean {
    return this.#store.listAppRequests().some(([, record]) => record.branch === 'request' && record.seerrRequestId === requestId && record.joinOnGrant !== undefined);
  }

  /**
   * Grants a request "Get this" made as a join (see #grantsAsJoin): never a new grant and never the requester's
   * households; the request is recorded as handled (so neither a replay nor the backfill grants it later), and
   * #settleAppRequests joins the household the request was made for to the item's grant, if it has one, through the
   * library join rules. A public title stays public. Runs in the write queue.
   */
  async #grantAsJoin(itemId: string, requestId: string, signal?: AbortSignal): Promise<GrantRecord | null> {
    await this.#store.markRequestsHandled([requestId]);
    console.log(JSON.stringify({ level: 'info', message: 'household app request granted as a join', requestId, itemId: normalizeId(itemId) }));
    await this.#settleAppRequests(itemId, requestId, signal);
    return this.#store.get(itemId) ?? null;
  }

  /** The TMDB title of a Jellyfin movie or series item, from its provider IDs, or undefined if it has none. */
  async #itemTitle(itemId: string): Promise<{ mediaType: 'movie' | 'tv'; tmdbId: number } | undefined> {
    const item = await this.#jellyfin.getItem(itemId);
    const mediaType = item.Type === 'Movie' ? 'movie' : item.Type === 'Series' ? 'tv' : undefined;
    const providerIds = item.ProviderIds;
    const tmdb = providerIds && typeof providerIds === 'object'
      ? Object.entries(providerIds).find(([name]) => name.toLowerCase() === 'tmdb')?.[1]
      : undefined;
    const tmdbId = typeof tmdb === 'string' && /^[1-9][0-9]{0,9}$/.test(tmdb) ? Number(tmdb) : undefined;
    return mediaType && tmdbId !== undefined ? { mediaType, tmdbId } : undefined;
  }

  /** Household app "Get this" records (see GrantStore.listAppRequests). */
  public listAppRequests(): Array<[string, AppRequestRecord]> {
    return this.#store.listAppRequests();
  }

  /**
   * Whether the request's requester withdrew it, or an administrator declined or cancelled it (AppWithdrawal
   * `requester`): its grant gives them nothing (GrantStore.resolveOwners), so it needs no Jellyfin ID for them, and
   * one Seerr has none for (a Seerr user no Jellyfin user is linked to) is granted all the same, recording
   * UNKNOWN_REQUESTER: held for no household rather than left public.
   */
  #requesterWithdrew(requestId: string): boolean {
    return this.#store.getAppWithdrawal(requestId)?.requester === true;
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
    if (!userId) {
      if (!this.#requesterWithdrew(event.request.id)) throw new Error(`Seerr request ${event.request.id} is missing a Jellyfin user ID`);
      userId = UNKNOWN_REQUESTER;
    }
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
          const withdrew = this.#requesterWithdrew(requestId);
          const request = requestItemId(listed) && (listed.requestedBy?.jellyfinUserId || withdrew)
            ? listed
            : await seerr.getRequest(requestId);
          throwIfAborted(signal);
          const itemId = requestItemId(request);
          const userId = request.requestedBy?.jellyfinUserId || (withdrew ? UNKNOWN_REQUESTER : undefined);
          const existing = itemId ? this.#store.get(itemId) : undefined;
          if (!itemId || userId === undefined || (existing && (Object.keys(existing.requests).length === 0 || requestId in existing.requests))) {
            result.skipped += 1;
            continue;
          }
          knownUserIds ??= new Set((await this.#jellyfin.getUsers()).map((user) => normalizeId(user.Id)));
          throwIfAborted(signal);
          if (userId !== UNKNOWN_REQUESTER && !knownUserIds.has(normalizeId(userId))) {
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
          // A "Get this" request for the title is not settled yet: the next run tries again.
          const rule = await this.#grantRule(requestId, request);
          throwIfAborted(signal);
          if (rule === 'defer') {
            result.skipped += 1;
            this.#metrics.increment('jfa_request_backfill_total', { result: 'deferred' });
            continue;
          }
          if (rule === 'join') {
            await this.#grantAsJoin(itemId, requestId, signal);
            throwIfAborted(signal);
            result.skipped += 1;
            this.#metrics.increment('jfa_request_backfill_total', { result: 'joined' });
            continue;
          }
          const mediaType = request.media?.mediaType ?? request.type;
          const grant = await this.#store.grant({
            itemId,
            requestId,
            userId,
            groupIds: this.#grantGroups(requestId, userId),
            ...(mediaType ? { mediaType } : {}),
          });
          await this.#reconcileGrant(grant, signal);
          throwIfAborted(signal);
          await this.#settleAppRequests(grant.itemId, requestId, signal);
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
      // A title whose request Seerr lost has no request to scan.
      await this.#applyTitleHolds(signal);
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
      if (!options.dryRun) await this.#applyTitleHolds(options.signal);
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
    // Counts only: the titles and households are in the admin readout (appOutstanding).
    const outstanding = this.appOutstanding();
    for (const [kind, count] of Object.entries(outstanding.safetyMarkers.byKind)) this.#metrics.gauge(`jfa_app_safety_markers{kind="${kind}"}`, count);
    for (const [status, count] of Object.entries(outstanding.requestIntents.byKind)) this.#metrics.gauge(`jfa_app_request_intents{status="${status}"}`, count);
    this.#metrics.gauge('jfa_app_deferred_webhooks', outstanding.deferredWebhooks.total);
    for (const [kind, count] of Object.entries(outstanding.withdrawals.byKind)) this.#metrics.gauge(`jfa_app_withdrawals{kind="${kind}"}`, count);
    this.#metrics.gauge('jfa_app_held_titles', outstanding.withdrawals.held);
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

/** How a request may be granted now: see AccessService.#grantRule. */
type GrantRule = 'defer' | 'join' | 'grant';

/** What a grant decision reads of a Seerr request (see AccessService.#requestFacts). */
interface RequestFacts {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  /** Its requester's Jellyfin user, normalized, if it can be read. */
  requester?: string;
  /** When Seerr made it (milliseconds), if it can be read. */
  createdAt?: number;
}

/**
 * Whether a member-wide safety tombstone covers a request (see AppSafetyTombstone): the title's, by the member or by
 * a requester that cannot be read, made no earlier than the tombstone's `since` (or at a time that cannot be read),
 * and not exempt.
 */
function covers(tombstone: AppSafetyTombstone, requestId: string, request: RequestFacts): boolean {
  if (tombstone.mediaType !== request.mediaType || tombstone.tmdbId !== request.tmdbId) return false;
  if (tombstone.exemptRequestIds?.includes(requestId)) return false;
  if (request.requester !== undefined && request.requester !== tombstone.jellyfinUserId) return false;
  return request.createdAt === undefined || tombstone.since === undefined || request.createdAt >= Date.parse(tombstone.since);
}
