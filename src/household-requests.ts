import { createHmac } from 'node:crypto';
import type { HouseholdJoinResult } from './access-service.js';
import { getThisEligibility, managesSeerrRequests, readBlocklist, type MediaType } from './app-api.js';
import type { JellyfinClient } from './jellyfin.js';
import { SeerrError, SeerrUnmappedUserError, type SeerrClient, type SeerrMemberClient, type SeerrTitleRecord } from './seerr.js';
import type { BackgroundTasks } from './shutdown.js';
import type { GrantStore } from './store.js';
import type { AppRequestIntent, AppRequestRecord, AppRequestStatus, AppSafetyTombstone } from './types.js';

/**
 * Household app "Get this" (docs/app-design.md, "Get this"). The answer depends on nothing but the call itself: it is
 * the same `202` once the call is accepted. Everything else runs afterwards, in the background, and its outcome is never
 * part of any answer: first the caller's eligibility, from their own Seerr user and quota only (a caller with a Seerr
 * quota is never eligible: see getThisEligibility); then, serialized per title:
 *
 * - the caller can already see the title (or the seasons asked for): nothing;
 * - Jellyfin already has it: the household joins its grant through the library join rules, never a Seerr request;
 * - Seerr has an active HD request for it from anyone: the household's interest is recorded, and the household joins
 *   the grant when it is created;
 * - otherwise: a real HD Seerr request as the caller, behind a request intent (see AppRequestIntent).
 *
 * A series is decided season by season.
 */

/** "Get this" calls allowed per user, per client address and per household in each window of GET_THIS_WINDOW_MS. */
export const GET_THIS_WINDOW_MS = 10 * 60 * 1000;
export const MAX_GET_THIS_PER_USER = 10;
export const MAX_GET_THIS_PER_CLIENT = 30;
export const MAX_GET_THIS_PER_HOUSEHOLD = 30;
/** How often a record's Seerr request is read again by {@link HouseholdRequests.refresh}, and a joined title's media. */
export const REFRESH_REQUEST_EVERY_MS = 10 * 60 * 1000;
export const REFRESH_MEDIA_EVERY_MS = 6 * 60 * 60 * 1000;
/** Most Seerr reads one refresh makes; the records read longest ago go first. */
export const MAX_REFRESH_READS = 50;
/**
 * A call's records are written no sooner than this after it was accepted, so how soon a title shows as `requested`
 * does not tell the request branch (more Seerr and Jellyfin calls) from the interest branch, while they finish within it.
 */
export const RECORD_DELAY_MS = 2000;
/** Most titles GET /requests lists, newest first. */
export const MAX_LISTED_TITLES = 200;
/** Most of the caller's own Jellyfin views GET /requests reads at once (one per listed title), to tell whether a ready title is theirs to play. */
export const OWN_VIEW_READS = 8;
/**
 * A `submitting` intent whose request Seerr does not list this long after it was written is taken as never made (the
 * request's own timeout is 15 seconds): it gives way to a safety tombstone (see #retire), so a request Seerr made late
 * still follows the join rules.
 */
export const APP_INTENT_TIMEOUT_MS = 2 * 60 * 1000;
/**
 * A request whose settle-time Jellyfin read has not succeeded this long after its intent was written follows the join
 * rules; a `submitting` intent that could not be reconciled (Seerr or Jellyfin unreadable) in that time gives way to a
 * safety tombstone, so it holds up no other member's grant for the title any longer.
 */
export const APP_SETTLE_DEADLINE_MS = 30 * 60 * 1000;
/**
 * How long a member-wide safety tombstone (see AppSafetyTombstone) covers a member's requests for a title, and how long
 * a record awaiting a grant (AppRequestRecord.awaitingGrant) is checked for one.
 */
export const APP_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How much earlier than its intent Seerr's clock may date the request it made, when an intent is recovered. */
const INTENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Seerr request statuses: pending and approved requests are active. */
const ACTIVE_REQUEST_STATUSES = new Set([1, 2]);
const PENDING = 1;
const DECLINED = 3;
const FAILED = 4;
const COMPLETED = 5;

export interface GetThisInput {
  householdId: string;
  /** The caller's Jellyfin user, normalized. */
  callerId: string;
  mediaType: MediaType;
  tmdbId: number;
  /** The seasons asked for, ascending and distinct; empty for a movie. */
  seasons: number[];
  /** What the caller's own Jellyfin view holds of the title, read with their own credentials. */
  ownView: () => Promise<OwnView>;
}

export interface OwnView {
  /** The caller can play the movie or series. */
  visible: boolean;
  /** For a series, the seasons the caller's view has episodes of. */
  seasons: ReadonlySet<number>;
}

/** Coarse request statuses, as the app shows them: `Requested`, `Ready to watch`, `We couldn't get this`. */
export type CoarseStatus = 'requested' | 'ready' | 'failed';

export interface RequestsDto {
  results: Array<{
    /** Opaque: an HMAC of the household and the title, never a Seerr ID. */
    id: string;
    mediaType: MediaType;
    tmdbId: number;
    status: CoarseStatus;
    seasons: Array<{ seasonNumber: number; status: CoarseStatus }>;
    /** Whether the caller made any of this household's records for the title (otherwise someone in the household). */
    byYou: boolean;
    /** Whether the caller may cancel it now (see HouseholdRequests.cancel), from the household's own records only. */
    cancellable: boolean;
    /** The day (UTC, `YYYY-MM-DD`) of the title's latest record: when the household last asked for it. */
    requestedOn: string;
  }>;
}

export interface CancelInput {
  householdId: string;
  /** The caller's Jellyfin user, normalized. */
  callerId: string;
  /** The entry's opaque ID, as GET /requests lists it. */
  id: string;
  /** What the caller's own Jellyfin view holds of a title, read with their own credentials (as for GET /requests). */
  ownView: (mediaType: MediaType, tmdbId: number) => Promise<OwnView>;
}

/** The background branch work was refused because shutdown has begun. */
export class GetThisRefusedError extends Error {
  public constructor() {
    super('shutting down');
    this.name = 'GetThisRefusedError';
  }
}

export interface HouseholdRequestsOptions {
  store: Pick<GrantStore,
    | 'listAppRequests' | 'listAppRequestsForHousehold' | 'writeAppRequests' | 'getAppIdKey' | 'householdEpoch'
    | 'hasHandledRequest' | 'listAppRequestIntents' | 'addAppRequestIntent' | 'isAppRequestIntentDurable' | 'getGroup'
    | 'hasAppRequestIntent' | 'listAppWithdrawals' | 'getAppRequest' | 'listAppTitleHolds'>;
  /** Jellyfin with JellyPass's own key: the decision input for "Jellyfin already has it". */
  jellyfin: Pick<JellyfinClient, 'findItemsByTmdbId' | 'existingItems' | 'findItemsByName' | 'seasonsWithEpisodes'>;
  /** Seerr with the admin key: the blocklist, a title's requests, and the status of requests JellyPass recorded. */
  seerr: Pick<SeerrClient, 'blocklist' | 'titleRequests' | 'requestState'>;
  /** The caller's own Seerr user, confirmed before every call (a `SeerrUserMap`). */
  members: { member(jellyfinUserId: string): Pick<SeerrMemberClient, 'ownUser' | 'quota' | 'confirmRequester' | 'cancelRequest'> | undefined };
  /** The library join rules (AccessService.joinHousehold), and the webhooks deferred for an intent (AccessService.retryDeferredRequests). */
  joins: {
    joinHousehold(
      input: { itemIds: string[]; userId: string; householdId: string; householdEpoch?: number; recordId?: string },
      options: { signal?: AbortSignal },
    ): Promise<HouseholdJoinResult>;
    retryDeferredRequests(options: { signal?: AbortSignal }): Promise<void>;
    /** Grants the arrivals of titles whose withdrawn request Seerr lost, held for no household (AccessService.applyTitleHolds). */
    applyTitleHolds(options: { signal?: AbortSignal }): Promise<void>;
    /** Runs `work` in the queue grants are decided in (AccessService.serialized), for a cancel's withdrawal. */
    serialized<T>(work: () => Promise<T>): Promise<T>;
  };
  /** Runs the branches after the answer; shutdown aborts its signal and waits for them. */
  background: Pick<BackgroundTasks, 'run'>;
  /** Counts each call's eligibility (`error`: it could not be read), and each branch run; never by title. */
  record?: (result: 'accepted' | 'ineligible' | 'error') => void;
  recordBranch?: (branch: string) => void;
  now?: () => number;
  /** See {@link RECORD_DELAY_MS} (for tests). */
  recordDelayMs?: number;
}

/** A record's new status (see HouseholdRequests.refresh). */
type RecordChange = { status: AppRequestStatus; itemIds?: string[]; readySeasons?: number[]; awaitingGrant?: boolean };

/** A request "Get this" made and settled as genuine (see GrantStore.writeAppRequests `exempt`). */
type Exemption = { mediaType: MediaType; tmdbId: number; jellyfinUserId: string; requestId: string };

/** What the branches of one call did, to be written together; filled as they go, so what was done is written. */
interface Outcome {
  records: AppRequestRecord[];
  /** Intents whose request is recorded but not settled (see AppRequestIntent `settling`). */
  settleIntents: Array<{ id: string; seerrRequestId: string }>;
  /** Intents resolved: recorded and settled, or no request was made. */
  removeIntents: string[];
  /** Intents this call wrote, which reconciliation leaves to it until its records are written. */
  intents: string[];
  /** Requests whose grant follows the join rules (see AppSafetyTombstone). */
  tombstones: AppSafetyTombstone[];
  exempt: Exemption[];
}

/** One title of a household's list (see HouseholdRequests.list). */
interface ListedTitle {
  mediaType: MediaType;
  tmdbId: number;
  latest: string;
  byYou: boolean;
  seasons: Map<number, CoarseStatus>;
  /** Whether the caller made one of its records that is waiting or ready (pending or completed): theirs to cancel. */
  own: boolean;
}

/** What Jellyfin holds of a title (see #presence). */
interface Presence {
  /** Its HD movie or series items. */
  itemIds: string[];
  /** The seasons (`0` for a movie) those items have: a movie's item, or a series' episodes. */
  seasons: Set<number>;
  /**
   * Jellyfin's items by name could not all be read (see JellyfinClient.findItemsByName): the title may be there, so
   * every season counts as present (see holds).
   */
  unknown: boolean;
}

/** How a request just made settles (see #settle): a genuine request (`absent`), or the join rule its grant follows. */
type Settled = 'absent' | 'present-at-settle' | 'existing-series';

export class HouseholdRequests {
  readonly #store: HouseholdRequestsOptions['store'];
  readonly #jellyfin: HouseholdRequestsOptions['jellyfin'];
  readonly #seerr: HouseholdRequestsOptions['seerr'];
  readonly #members: HouseholdRequestsOptions['members'];
  readonly #joins: HouseholdRequestsOptions['joins'];
  readonly #background: HouseholdRequestsOptions['background'];
  readonly #record: NonNullable<HouseholdRequestsOptions['record']>;
  readonly #recordBranch: NonNullable<HouseholdRequestsOptions['recordBranch']>;
  readonly #now: () => number;
  readonly #recordDelayMs: number;
  readonly #titleLocks = new Map<string, Promise<unknown>>();
  /** Intents claimed by calls still running (see Outcome.intents), from before they are in memory; memory only. */
  readonly #live = new Set<string>();
  /** When each record was last read from Seerr by refresh(), by record ID; memory only. */
  readonly #checkedAt = new Map<string, number>();
  /** The checkTitleHolds run under way, if any. */
  #holdCheck: Promise<void> | undefined;

  public constructor(options: HouseholdRequestsOptions) {
    this.#store = options.store;
    this.#jellyfin = options.jellyfin;
    this.#seerr = options.seerr;
    this.#members = options.members;
    this.#joins = options.joins;
    this.#background = options.background;
    this.#record = options.record ?? (() => undefined);
    this.#recordBranch = options.recordBranch ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#recordDelayMs = options.recordDelayMs ?? RECORD_DELAY_MS;
  }

  /**
   * Accepts a "Get this" call: starts its work in the background and returns, before anything about the caller or the
   * title is read, so the caller's answer is the same whatever happens next (see #run). Throws GetThisRefusedError
   * during shutdown.
   */
  public async submit(input: GetThisInput): Promise<void> {
    const acceptedAt = performance.now();
    const epoch = this.#store.householdEpoch(input.householdId);
    const started = this.#background.run((signal) => this.#run(input, epoch, acceptedAt, signal));
    if (!started) throw new GetThisRefusedError();
  }

  /**
   * Accepts a cancel of the caller's own request (docs/app-design.md, "Cancelling (step 2c)"): starts its work in the
   * background and returns before anything about the entry is read, so the caller's answer is the same whatever happens
   * next, an ID the household does not list included (see #cancel). Throws GetThisRefusedError during shutdown.
   */
  public async cancel(input: CancelInput): Promise<void> {
    const epoch = this.#store.householdEpoch(input.householdId);
    const started = this.#background.run((signal) => this.#cancel(input, epoch, signal));
    if (!started) throw new GetThisRefusedError();
  }

  /**
   * The background part of a cancel, in the title's turn (the same as "Get this"'s, so a cancel never races a call
   * recording a follower). The caller's own view of the title is read first, as GET /requests reads it: if the entry
   * is not one the caller is shown as cancellable (see list), nothing happens. Otherwise the caller's records for the
   * title are withdrawn (see #withdraw), whatever else holds, so the caller sees the same in every case: the entry
   * leaves the list and the title can be asked for again. Then each Seerr request the caller made among them that
   * nobody follows any more is deleted in Seerr as the caller if it is still pending (see #deleteUnfollowed). Nothing
   * else is ever undone: a request someone else made, or one that was approved, stays in Seerr, and a grant already
   * made stays, so no access is ever taken back.
   */
  async #cancel(input: CancelInput, epoch: number | undefined, signal: AbortSignal): Promise<void> {
    // The answer is written before anything is read.
    await new Promise((resolve) => setImmediate(resolve));
    if (epoch === undefined || signal.aborted) return void this.#recordBranch(signal.aborted ? 'cancelled' : 'cancel_none');
    const key = this.#titleOfId(input.householdId, input.id);
    const title = key ? this.#titles(input.householdId).get(key) : undefined;
    if (!key || !title) return void this.#recordBranch('cancel_none');
    try {
      await this.#withLock(this.#titleLocks, key, async () => {
        checkSignal(signal);
        const entry = this.#titles(input.householdId, input.callerId).get(key);
        if (!entry) return void this.#recordBranch('cancel_none');
        this.#shown(entry, await this.#readView(input.ownView, entry));
        checkSignal(signal);
        if (!cancellable(entry)) return void this.#recordBranch('cancel_none');
        const withdrawn = await this.#joins.serialized(() => this.#withdraw(input, epoch, title));
        for (const requestId of withdrawn) {
          checkSignal(signal);
          await this.#deleteUnfollowed(input.callerId, title, requestId, signal);
        }
      });
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) return void this.#recordBranch('cancelled');
      this.#recordBranch('cancel_error');
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app cancel failed',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * Withdraws the caller's records for the title that are waiting or ready (pending or completed: what the caller may
   * be shown as Requested), in one write with a withdrawal (see AppWithdrawal) for each Seerr request among them whose
   * grant is still to come: a pending request or interest whose request is not handled, its grant not settled. Runs in
   * the queue grants are decided in, so a webhook or the backfill grants such a request either before (then it is
   * handled, the household keeps what it was given and no withdrawal is written) or after, by the withdrawal. Resolves
   * with the Seerr requests the caller made among those withdrawn, for #deleteUnfollowed.
   */
  async #withdraw(input: CancelInput, epoch: number, title: { mediaType: MediaType; tmdbId: number }): Promise<string[]> {
    const records = this.#store.householdEpoch(input.householdId) !== epoch ? [] : this.#store.listAppRequestsForHousehold(input.householdId)
      .filter(([, record]) => !record.detached && record.mediaType === title.mediaType && record.tmdbId === title.tmdbId
        && record.jellyfinUserId === input.callerId && (record.status === 'pending' || record.status === 'completed'));
    if (records.length === 0) {
      this.#recordBranch('cancel_none');
      return [];
    }
    const waiting = records.filter(([, record]) => record.status === 'pending' && record.branch !== 'join' && record.seerrRequestId !== undefined
      && !this.#store.hasHandledRequest(record.seerrRequestId) && !record.itemIds?.length && !record.readySeasons?.length && !record.awaitingGrant)
      .map(([, record]) => record);
    await this.#store.writeAppRequests({
      update: records.map(([id]) => ({ id, status: 'deleted', withdrawn: true })),
      withdraw: waiting.map((record) => ({
        requestId: record.seerrRequestId as string,
        mediaType: record.mediaType,
        tmdbId: record.tmdbId,
        householdId: record.householdId,
        requester: record.branch === 'request',
        // A genuine request: should Seerr lose it, its title is held when it arrives (AppWithdrawal `requesterId`).
        ...(record.branch === 'request' && !record.joinOnGrant ? { requesterId: record.jellyfinUserId } : {}),
      })),
    });
    // Too late for the grant: a request of theirs was granted already, and the household keeps what it was given.
    const late = records.some(([, record]) => (record.seerrRequestId !== undefined && this.#store.hasHandledRequest(record.seerrRequestId))
      || record.status === 'completed' || (record.itemIds?.length ?? 0) > 0 || record.awaitingGrant);
    this.#recordBranch(waiting.length === 0 && late ? 'cancel_too_late' : 'cancel_withdrawn');
    return [...new Set(waiting.flatMap((record) => record.branch === 'request' ? [record.seerrRequestId as string] : []))];
  }

  /**
   * Deletes `requestId` in Seerr as the caller, only when nothing else depends on it: no record in any household still
   * follows the title and no "Get this" intent names it (read under the title's lock, so none is being recorded; an
   * intent still settling also keeps its grant deferred), the caller's Seerr user does not manage requests (so Seerr
   * itself refuses anything but the caller's own pending request), and Seerr reads it as pending. Nothing has been sent
   * to Radarr or Sonarr for a pending request, so nothing downloads. Otherwise, or if the delete fails, the request
   * stays and its withdrawal decides its grant.
   */
  async #deleteUnfollowed(callerId: string, title: { mediaType: MediaType; tmdbId: number }, requestId: string, signal: AbortSignal): Promise<void> {
    const followed = this.#store.hasAppRequestIntent(title.mediaType, title.tmdbId) || this.#store.listAppRequests().some(([, record]) =>
      !record.detached && record.status === 'pending' && record.mediaType === title.mediaType && record.tmdbId === title.tmdbId);
    const member = this.#members.member(callerId);
    if (followed || !member) return void this.#recordBranch('cancel_kept');
    try {
      if (managesSeerrRequests(await member.ownUser())) return void this.#recordBranch('cancel_kept');
      checkSignal(signal);
      const state = await this.#seerr.requestState(requestId);
      checkSignal(signal);
      if (state?.status !== PENDING) return void this.#recordBranch('cancel_kept');
      await member.cancelRequest(requestId);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      if (error instanceof SeerrUnmappedUserError || (error instanceof SeerrError && error.status === 401)) return void this.#recordBranch('cancel_kept');
      this.#recordBranch('cancel_delete_failed');
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app could not delete a cancelled request in Seerr',
        detail: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    this.#recordBranch('cancel_deleted');
    // Seerr no longer has the request, so nothing can grant it: its withdrawal is not needed.
    await this.#joins.serialized(() => this.#store.writeAppRequests({ forgetWithdrawals: [requestId] }));
  }

  /** The caller's own view of a listed title; one that fails to read is taken as holding nothing (as in list). */
  async #readView(ownView: CancelInput['ownView'], entry: ListedTitle): Promise<OwnView> {
    try {
      return await ownView(entry.mediaType, entry.tmdbId);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app own view read failed; its ready seasons are listed as requested',
        detail: error instanceof Error ? error.message : String(error),
      }));
      return { visible: false, seasons: new Set() };
    }
  }

  /** Shows `entry` as the caller sees it: a ready season (the movie) their own view does not have is `requested`. */
  #shown(entry: ListedTitle, view: OwnView): void {
    for (const [season, status] of entry.seasons) {
      const visible = entry.mediaType === 'movie' ? view.visible : view.seasons.has(season);
      if (status === 'ready' && !visible) entry.seasons.set(season, 'requested');
    }
  }

  /** The title (`movie:<id>`, `tv:<id>`) of one of the household's listed records whose opaque ID is `id`, if any. */
  #titleOfId(householdId: string, id: string): string | undefined {
    for (const entry of this.#titles(householdId).values()) {
      if (this.#listId(householdId, entry.mediaType, entry.tmdbId) === id) return `${entry.mediaType}:${entry.tmdbId}`;
    }
    return undefined;
  }

  /** An entry's opaque ID: an HMAC of the household and the title (see list). */
  #listId(householdId: string, mediaType: MediaType, tmdbId: number): string {
    const key = this.#store.getAppIdKey() ?? '';
    return createHmac('sha256', key).update(`${householdId}\n${mediaType}\n${tmdbId}`).digest('base64url').slice(0, 22);
  }

  /**
   * The background part of one call: decides the caller's eligibility for the media type from their own Seerr
   * permission and quota, and nothing about the title or other households; if eligible, runs the branches. A failure
   * reading eligibility runs nothing.
   */
  async #run(input: GetThisInput, epoch: number | undefined, acceptedAt: number, signal: AbortSignal): Promise<void> {
    // The answer is written before anything is read.
    await new Promise((resolve) => setImmediate(resolve));
    let eligible: boolean;
    try {
      checkSignal(signal);
      eligible = epoch !== undefined && await this.#eligible(input.callerId, input.mediaType);
      checkSignal(signal);
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) return void this.#recordBranch('cancelled');
      this.#record('error');
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app get this eligibility could not be read',
        detail: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    if (!eligible) return void this.#record('ineligible');
    this.#record('accepted');
    await this.#branches(input, epoch as number, acceptedAt, signal);
  }

  /**
   * Whether the caller may ask "Get this" for `mediaType` (see getThisEligibility): Seerr's request permission for it,
   * and no Seerr quota at all. Read as the caller, never about a title.
   */
  async #eligible(callerId: string, mediaType: MediaType): Promise<boolean> {
    const member = this.#members.member(callerId);
    if (!member) return false;
    try {
      const [user, quota] = await Promise.all([member.ownUser(), member.quota()]);
      return getThisEligibility(user, quota)[mediaType];
    } catch (error) {
      if (error instanceof SeerrUnmappedUserError) return false;
      throw error;
    }
  }

  /** The branches of one call, in the title's turn, written together no sooner than RECORD_DELAY_MS after it was accepted. */
  async #branches(input: GetThisInput, epoch: number, acceptedAt: number, signal: AbortSignal): Promise<void> {
    const recordAfter = acceptedAt + this.#recordDelayMs;
    await this.#withLock(this.#titleLocks, `${input.mediaType}:${input.tmdbId}`, async () => {
      const outcome: Outcome = { records: [], settleIntents: [], removeIntents: [], intents: [], tombstones: [], exempt: [] };
      try {
        await this.#decide(input, epoch, outcome, signal);
        await delay(recordAfter - performance.now(), signal);
      } catch (error) {
        if (error instanceof CancelledError || signal.aborted) this.#recordBranch('cancelled');
        else {
          this.#recordBranch('error');
          console.error(JSON.stringify({
            level: 'error',
            message: 'household app get this failed',
            detail: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      // Written even after shutdown began: a Seerr request already made must keep its attribution record. The store
      // detaches them if the household was deleted (or deleted and created again) meanwhile. An intent this fails to
      // resolve is reconciled later (see #reconcileIntents).
      try {
        if (outcome.records.length > 0 || outcome.settleIntents.length > 0 || outcome.removeIntents.length > 0 || outcome.tombstones.length > 0) {
          await this.#store.writeAppRequests({
            add: outcome.records,
            householdEpoch: epoch,
            settleIntents: outcome.settleIntents,
            removeIntents: outcome.removeIntents,
            tombstones: outcome.tombstones,
            exempt: outcome.exempt,
          });
        }
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          message: 'household app get this could not be recorded',
          detail: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        for (const id of outcome.intents) this.#live.delete(id);
      }
      // A webhook deferred for this call's intent is granted now, by its record's rule.
      if (outcome.removeIntents.length > 0 && !signal.aborted) await this.#retryDeferred(signal);
    });
  }

  /**
   * Decides and runs each branch for the call (see the class comment), adding to `outcome` as it goes. Throws if a
   * lookup fails: what was done until then is still written.
   */
  async #decide(input: GetThisInput, epoch: number, outcome: Outcome, signal: AbortSignal): Promise<void> {
    const { mediaType, tmdbId, householdId } = input;
    const stamp = new Date(this.#now()).toISOString();
    const base = { householdId, jellyfinUserId: input.callerId, mediaType, tmdbId, createdAt: stamp, updatedAt: stamp };
    checkSignal(signal);
    // The administrators' blocklist is the same for every household; Seerr would refuse the request.
    if ((await readBlocklist(this.#seerr)).has(`${mediaType}:${tmdbId}`)) return void this.#recordBranch('refused');
    checkSignal(signal);
    // What the caller can already play, and what their household already asked for, are theirs to know.
    const view = await input.ownView();
    checkSignal(signal);
    const active = this.#askedSeasons(householdId, mediaType, tmdbId);
    const wanted = mediaType === 'movie'
      ? (view.visible || active.has(0) ? [] : [0])
      : input.seasons.filter((season) => !view.seasons.has(season) && !active.has(season));
    if (wanted.length === 0) return void this.#recordBranch('visible');
    const title = await this.#seerr.titleRequests(mediaType, tmdbId);
    checkSignal(signal);
    // A title Seerr cannot find on TMDB cannot be requested by anyone.
    if (!title) return void this.#recordBranch('refused');
    const present = await this.#presence(mediaType, tmdbId, title);
    const observedAt = new Date(this.#now()).toISOString();
    checkSignal(signal);
    const join: number[] = [];
    const interests = new Map<string, number[]>();
    const request: number[] = [];
    for (const season of wanted) {
      if (holds(present, season)) {
        join.push(season);
        continue;
      }
      const covering = activeRequest(title, mediaType, season, false);
      if (covering) interests.set(covering.id, [...interests.get(covering.id) ?? [], season]);
      else request.push(season);
    }
    // Jellyfin already has it: never a Seerr request, which would be a late request (see "Late requests").
    if (join.length > 0) await this.#join(input, base, epoch, title, present.itemIds, join, outcome, signal);
    for (const [requestId, seasons] of interests) {
      const underlying = title.requests.find((entry) => entry.id === requestId) as SeerrTitleRecord['requests'][number];
      outcome.records.push(this.#follow(base, title, underlying, seasons));
    }
    if (request.length > 0 && !signal.aborted) await this.#request(input, base, epoch, title, request, observedAt, outcome, signal);
    else if (request.length > 0) this.#recordBranch('cancelled');
  }

  /**
   * What Jellyfin holds of a title, read with JellyPass's key whoever may see it: every movie or series item with its
   * TMDB ID and the items Seerr's media record links to it (which may have no TMDB ID of their own), or, when there are
   * none, the items that may be the title by name (and year, for a movie: see JellyfinClient.findItemsByName), less
   * the 4K one (see hdItems); for a series, the seasons those items have episodes of. The three lookups run at once. If
   * the items by name could not all be read, the title counts as present (`unknown`), never as absent.
   */
  async #presence(mediaType: MediaType, tmdbId: number, title: SeerrTitleRecord): Promise<Presence> {
    const linked = [title.jellyfinMediaId, title.jellyfinMediaId4k].filter((itemId): itemId is string => itemId !== undefined);
    const [byTmdb, byLink, byName] = await Promise.all([
      this.#jellyfin.findItemsByTmdbId(mediaType, tmdbId),
      linked.length > 0 ? this.#jellyfin.existingItems(mediaType, linked) : Promise.resolve([]),
      title.names.length > 0 ? this.#jellyfin.findItemsByName(mediaType, tmdbId, title.names, title.year) : Promise.resolve({ itemIds: [], complete: true }),
    ]);
    const direct = byTmdb.length > 0 || byLink.length > 0;
    const found = direct ? [...byTmdb, ...byLink] : byName.itemIds;
    const itemIds = hdItems([...new Set(found)].sort(), title);
    const seasons = new Set<number>();
    if (mediaType === 'movie' && itemIds.length > 0) seasons.add(0);
    if (mediaType === 'tv') {
      for (const season of (await Promise.all(itemIds.map((itemId) => this.#jellyfin.seasonsWithEpisodes(itemId)))).flat()) seasons.add(season);
    }
    return { itemIds, seasons, unknown: !direct && !byName.complete };
  }

  /** The join branch for `seasons` (`[0]` for a movie) of items Jellyfin has: a `join` record if the household joined. */
  async #join(
    input: GetThisInput,
    base: Omit<AppRequestRecord, 'seasons' | 'branch' | 'status'>,
    epoch: number,
    title: SeerrTitleRecord,
    itemIds: string[],
    seasons: number[],
    outcome: Outcome,
    signal: AbortSignal,
  ): Promise<void> {
    const joined = await this.#joins.joinHousehold({ itemIds, userId: input.callerId, householdId: input.householdId, householdEpoch: epoch }, { signal });
    this.#recordBranch(`join_${joined}`);
    if (joined !== 'joined' && joined !== 'already') return;
    outcome.records.push({
      ...base,
      seasons: seasonsOf(input.mediaType, seasons),
      branch: 'join',
      status: 'completed',
      itemIds,
      ...(input.mediaType === 'tv' ? { readySeasons: seasonsOf('tv', seasons) } : {}),
      ...(title.mediaId !== undefined ? { seerrMediaId: title.mediaId } : {}),
    });
  }

  /**
   * The request branch: a real HD Seerr request as the caller for `seasons` (`[0]` for a movie), in this order:
   *
   * 1. its intent is written to the state file (see AppRequestIntent), so from then on no webhook or backfill grants a
   *    request for the title, and a restart finds it;
   * 2. the caller's Seerr user is confirmed (SeerrMemberClient.confirmRequester);
   * 3. Jellyfin is read again (the re-check), the last step awaited: the request is sent right after it, with nothing
   *    else awaited in between, and a title (or season) that arrived since the branch's first read is joined instead.
   *
   * The request is sent only if the state file holds the intent then (GrantStore.isAppRequestIntentDurable): otherwise
   * nothing is sent (`request_unsaved`). What is left is the request's own round trip, in which a title arriving would
   * still be requested; the request is settled by reading Jellyfin once more after Seerr answers (see #settle), and its intent stays until it is, so its
   * grant follows the join rules if the title is there or cannot be read. A failure Seerr may have made the request
   * through (no answer, a 5xx) leaves the intent to be reconciled (see #reconcileIntents).
   */
  async #request(
    input: GetThisInput,
    base: Omit<AppRequestRecord, 'seasons' | 'branch' | 'status'>,
    epoch: number,
    title: SeerrTitleRecord,
    seasons: number[],
    observedAt: string,
    outcome: Outcome,
    signal: AbortSignal,
  ): Promise<void> {
    const member = this.#members.member(input.callerId);
    if (!member) return void this.#recordBranch('request_refused');
    // Claimed before the intent is in memory: a reconciliation already running never takes it for an orphan. Released
    // with the call's other intents, however it ends (see #branches).
    const intentId = await this.#store.addAppRequestIntent({
      householdId: input.householdId,
      jellyfinUserId: input.callerId,
      mediaType: input.mediaType,
      tmdbId: input.tmdbId,
      seasons: seasonsOf(input.mediaType, seasons),
      observedAbsentAt: observedAt,
      createdAt: new Date(this.#now()).toISOString(),
      status: 'submitting',
      householdEpoch: epoch,
    }, (id) => {
      this.#live.add(id);
      outcome.intents.push(id);
    });
    let requester: Awaited<ReturnType<typeof member.confirmRequester>>;
    let recheck: Presence;
    try {
      requester = await member.confirmRequester();
      checkSignal(signal);
      recheck = await this.#presence(input.mediaType, input.tmdbId, title);
    } catch (error) {
      // Nothing was sent.
      outcome.removeIntents.push(intentId);
      if (error instanceof SeerrUnmappedUserError) return void this.#recordBranch('request_refused');
      throw error;
    }
    const checkedAt = new Date(this.#now()).toISOString();
    const late = seasons.filter((season) => holds(recheck, season));
    const requested = seasons.filter((season) => !late.includes(season));
    let created: unknown;
    let failure: unknown;
    if (requested.length > 0 && !signal.aborted) {
      // The intent must be in the state file before the request leaves (step 1): checked here, with nothing awaited
      // between this check and the request, so a regression that stops awaiting its write sends nothing.
      if (!this.#store.isAppRequestIntentDurable(intentId)) {
        outcome.removeIntents.push(intentId);
        this.#recordBranch('request_unsaved');
        console.error(JSON.stringify({ level: 'error', message: 'household app request not sent: its intent is not in the state file' }));
        return;
      }
      try {
        created = await requester.createRequest(input.mediaType === 'movie'
          ? { mediaType: 'movie', tmdbId: input.tmdbId }
          : { mediaType: 'tv', tmdbId: input.tmdbId, seasons: requested });
      } catch (error) {
        failure = error;
      }
    }
    if (late.length > 0) {
      this.#recordBranch('request_late');
      await this.#join(input, base, epoch, title, recheck.itemIds, late, outcome, signal);
    }
    if (requested.length === 0 || (signal.aborted && created === undefined && failure === undefined)) {
      outcome.removeIntents.push(intentId);
      if (requested.length > 0) this.#recordBranch('cancelled');
      return;
    }
    if (failure !== undefined) {
      if (!definitelyNotMade(failure)) {
        // Seerr may have made it: the intent stays, and is reconciled against Seerr's own list.
        this.#recordBranch('request_uncertain');
        console.error(JSON.stringify({
          level: 'error',
          message: 'household app request may not have been made',
          detail: failure instanceof Error ? failure.message : String(failure),
        }));
        return;
      }
      outcome.removeIntents.push(intentId);
      // Seerr refused it as a duplicate: someone requested it meanwhile, so it is followed instead.
      if (failure instanceof SeerrError && failure.status === 409) return this.#fallBack(input, base, requested, outcome);
      // Refused before anything was made (permission, quota, blocklist, or the caller was unlinked).
      this.#recordBranch('request_refused');
      if (!(failure instanceof SeerrUnmappedUserError) && !(failure instanceof SeerrError && failure.status === 403)) {
        console.error(JSON.stringify({
          level: 'error',
          message: 'household app request failed',
          detail: failure instanceof Error ? failure.message : String(failure),
        }));
      }
      return;
    }
    const requestId = positiveInteger(field(created, 'id'));
    const createdSeasons = new Set(seasonList(field(created, 'seasons')));
    // Seerr answers 202 without a request when every season was requested or available meanwhile, and leaves out
    // any season that was; those are followed instead.
    const covered = requestId === null ? [] : input.mediaType === 'movie' ? requested : requested.filter((season) => createdSeasons.has(season));
    if (requestId === null || covered.length === 0) outcome.removeIntents.push(intentId);
    else {
      this.#recordBranch('request');
      const mediaId = positiveInteger(field(field(created, 'media'), 'id')) ?? title.mediaId;
      const record: AppRequestRecord = {
        ...base,
        seasons: seasonsOf(input.mediaType, covered),
        branch: 'request',
        status: 'pending',
        seerrRequestId: String(requestId),
        checkedAt,
        // A series Jellyfin already has: the request is for seasons it lacks, and its grant follows the join rules.
        ...(input.mediaType === 'tv' && recheck.itemIds.length > 0 ? { joinOnGrant: 'existing-series' as const } : {}),
        ...(mediaId !== undefined && mediaId !== null ? { seerrMediaId: mediaId } : {}),
      };
      const settled = record.joinOnGrant ? 'existing-series' : await this.#settle(record.mediaType, record.tmdbId, record.seasons, title);
      if (settled === undefined) outcome.settleIntents.push({ id: intentId, seerrRequestId: String(requestId) });
      else {
        if (settled !== 'absent') {
          record.joinOnGrant = settled;
          outcome.tombstones.push(this.#tombstone(record, [String(requestId)]));
        } else outcome.exempt.push({ mediaType: record.mediaType, tmdbId: record.tmdbId, jellyfinUserId: record.jellyfinUserId, requestId: String(requestId) });
        outcome.removeIntents.push(intentId);
      }
      outcome.records.push(record);
    }
    const rest = requested.filter((season) => !covered.includes(season));
    if (rest.length > 0) await this.#fallBack(input, base, rest, outcome);
  }

  /**
   * Reads Jellyfin once more for a request Seerr has made: if the title (or one of the seasons it covers) is there now,
   * it may have arrived while the request was being made, and its grant must follow the join rules
   * (`present-at-settle`); a series that is there without those seasons is an existing series; otherwise the title was
   * not there when the request was made, and the request is genuine (`absent`). Undefined when Jellyfin could not be
   * read: never a genuine request (see AppRequestIntent `settling`).
   */
  async #settle(mediaType: MediaType, tmdbId: number, seasons: number[], title: SeerrTitleRecord): Promise<Settled | undefined> {
    try {
      const present = await this.#presence(mediaType, tmdbId, title);
      if (present.itemIds.length === 0 && !present.unknown) return 'absent';
      return mediaType === 'movie' || seasons.some((season) => holds(present, season)) ? 'present-at-settle' : 'existing-series';
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app could not settle a request it made',
        detail: error instanceof Error ? error.message : String(error),
      }));
      return undefined;
    }
  }

  /** A request Seerr refused because the title was requested meanwhile: the request found is followed (interest). */
  async #fallBack(
    input: GetThisInput,
    base: Omit<AppRequestRecord, 'seasons' | 'branch' | 'status'>,
    seasons: number[],
    outcome: Outcome,
  ): Promise<void> {
    let title: SeerrTitleRecord | undefined;
    try {
      title = await this.#seerr.titleRequests(input.mediaType, input.tmdbId);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app could not read the request it follows',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
    const followed = new Map<string, number[]>();
    const unmatched: number[] = [];
    for (const season of seasons) {
      const covering = title ? activeRequest(title, input.mediaType, season, true) : undefined;
      if (covering) followed.set(covering.id, [...followed.get(covering.id) ?? [], season]);
      else unmatched.push(season);
    }
    for (const [requestId, covered] of followed) {
      const underlying = title?.requests.find((entry) => entry.id === requestId) as SeerrTitleRecord['requests'][number];
      outcome.records.push(this.#follow(base, title as SeerrTitleRecord, underlying, covered));
    }
    if (unmatched.length > 0) {
      // No request to follow (Seerr counts the title as available, Jellyfin does not have it): the interest waits
      // for a grant of the title.
      this.#recordBranch('interest');
      outcome.records.push({
        ...base,
        seasons: seasonsOf(input.mediaType, unmatched),
        branch: 'interest',
        status: 'pending',
        ...(title?.mediaId !== undefined ? { seerrMediaId: title.mediaId } : {}),
      });
    }
  }

  /**
   * The interest branch for `seasons` covered by `underlying`. The caller's own request (made outside the app) becomes
   * the household's request record.
   */
  #follow(
    base: Omit<AppRequestRecord, 'seasons' | 'branch' | 'status'>,
    title: SeerrTitleRecord,
    underlying: SeerrTitleRecord['requests'][number],
    seasons: number[],
  ): AppRequestRecord {
    const own = underlying.requesterJellyfinId === base.jellyfinUserId;
    this.#recordBranch(own ? 'own_request' : 'interest');
    return {
      ...base,
      seasons: seasonsOf(base.mediaType, seasons),
      branch: own ? 'request' : 'interest',
      status: underlying.status === FAILED ? 'failed' : 'pending',
      seerrRequestId: underlying.id,
      ...(title.mediaId !== undefined ? { seerrMediaId: title.mediaId } : {}),
    };
  }

  /**
   * The seasons (`0` for a movie) this household already asked for and is still waiting on: an active record (less its
   * seasons already ready), a failed one (Seerr refuses a new request while a failed one stands), or an intent not yet
   * resolved (its request may have been made).
   */
  #askedSeasons(householdId: string, mediaType: MediaType, tmdbId: number): Set<number> {
    const seasons = new Set<number>();
    for (const [, intent] of this.#store.listAppRequestIntents()) {
      if (intent.householdId !== householdId || intent.mediaType !== mediaType || intent.tmdbId !== tmdbId) continue;
      for (const season of mediaType === 'movie' ? [0] : intent.seasons) seasons.add(season);
    }
    for (const [, record] of this.#store.listAppRequestsForHousehold(householdId)) {
      if (record.mediaType !== mediaType || record.tmdbId !== tmdbId) continue;
      if (isActive(record)) for (const season of waitingSeasons(record)) seasons.add(season);
      else if (record.status === 'failed' && !record.detached) for (const season of mediaType === 'movie' ? [0] : record.seasons) seasons.add(season);
    }
    return seasons;
  }

  /**
   * The titles (`movie:<id>`, `tv:<id>`) and seasons (`tv:<id>:<n>`) this household has an active record for (a series'
   * seasons until each is ready): its own records only, never derived from membership or from Seerr, read from the
   * household's own index. The household app's only source of `requested`.
   */
  public activeKeys(householdId: string): Set<string> {
    const keys = new Set<string>();
    for (const [, record] of this.#store.listAppRequestsForHousehold(householdId)) {
      if (!isActive(record) || waitingSeasons(record).length === 0) continue;
      keys.add(`${record.mediaType}:${record.tmdbId}`);
      if (record.mediaType === 'tv') for (const season of waitingSeasons(record)) keys.add(`tv:${record.tmdbId}:${season}`);
    }
    return keys;
  }

  /**
   * The titles (`movie:<id>`, `tv:<id>`) and seasons (`tv:<id>:<n>`) whose latest record in this household is ready
   * (see #titles). The household app shows them as `requested` unless the caller's own Jellyfin view has them (it
   * decides `in_library` first): "Ready to watch" is never shown to a member who cannot play the title.
   */
  public readyKeys(householdId: string): Set<string> {
    const keys = new Set<string>();
    for (const entry of this.#titles(householdId).values()) {
      for (const [season, status] of entry.seasons) {
        if (status !== 'ready') continue;
        keys.add(`${entry.mediaType}:${entry.tmdbId}`);
        if (entry.mediaType === 'tv') keys.add(`tv:${entry.tmdbId}:${season}`);
      }
    }
    return keys;
  }

  /**
   * This household's titles with their coarse status, from its own records only: no Seerr ID, no requester beyond
   * whether it was the caller, no count but the entries listed. A title's latest record decides each season (or the
   * movie); a season Jellyfin already has episodes of for a record still waiting on others is `ready`; a series is
   * `requested` while any season is, otherwise `ready` if any season is. Records whose request or media Seerr deleted are
   * not listed, as Seerr no longer lists such a request either.
   *
   * `ready` is never optimistic: a movie (or season) is `ready` only when `ownView`, the caller's own Jellyfin view
   * (their library access, parental limits and the household's blocked tags), has it; otherwise it stays `requested`.
   * `ownView` is asked about every listed title, ready or not, at most {@link OWN_VIEW_READS} at a time, and a title it
   * fails for is shown as if the caller's view did not have it (its ready seasons `requested`): which reads the list
   * makes, and how it answers when they fail, depend only on the caller's own view and the household's own listed
   * records, never on whether a title arrived somewhere the caller cannot see. The cost is bounded by
   * {@link MAX_LISTED_TITLES} views (with the caller's library cached, a movie's needs no Jellyfin call and a series'
   * one episode read, only when the caller's own view has the series).
   */
  public async list(householdId: string, callerId: string, ownView: (mediaType: MediaType, tmdbId: number) => Promise<OwnView>): Promise<RequestsDto> {
    const listed = [...this.#titles(householdId, callerId).values()]
      .sort((left, right) => right.latest.localeCompare(left.latest) || left.tmdbId - right.tmdbId)
      .slice(0, MAX_LISTED_TITLES);
    for (let index = 0; index < listed.length; index += OWN_VIEW_READS) {
      await Promise.all(listed.slice(index, index + OWN_VIEW_READS).map(async (entry) => this.#shown(entry, await this.#readView(ownView, entry))));
    }
    return {
      results: listed.map((entry) => {
        const statuses = [...entry.seasons.values()];
        const status: CoarseStatus = statuses.includes('requested') ? 'requested' : statuses.includes('ready') ? 'ready' : 'failed';
        return {
          id: this.#listId(householdId, entry.mediaType, entry.tmdbId),
          mediaType: entry.mediaType,
          tmdbId: entry.tmdbId,
          status,
          seasons: entry.mediaType === 'movie' ? [] : [...entry.seasons].sort(([left], [right]) => left - right)
            .map(([seasonNumber, seasonStatus]) => ({ seasonNumber, status: seasonStatus })),
          byYou: entry.byYou,
          cancellable: cancellable(entry),
          requestedOn: entry.latest.slice(0, 10),
        };
      }),
    };
  }

  /**
   * This household's titles, each season (`0` for a movie) with the coarse status its latest record gives it, from the
   * household's own records only (see list); `byYou` when `callerId` made any of them.
   */
  #titles(householdId: string, callerId?: string): Map<string, ListedTitle> {
    const titles = new Map<string, ListedTitle>();
    const records = this.#store.listAppRequestsForHousehold(householdId).map(([, record]) => record)
      .filter((record) => !record.detached && !record.withdrawn && record.status !== 'deleted')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const record of records) {
      const key = `${record.mediaType}:${record.tmdbId}`;
      const entry = titles.get(key) ?? { mediaType: record.mediaType, tmdbId: record.tmdbId, latest: record.createdAt, byYou: false, seasons: new Map(), own: false };
      entry.latest = record.createdAt;
      entry.byYou ||= record.jellyfinUserId === callerId;
      entry.own ||= record.jellyfinUserId === callerId && (record.status === 'pending' || record.status === 'completed');
      const ready = new Set(record.readySeasons ?? []);
      for (const season of record.mediaType === 'movie' ? [0] : record.seasons) {
        entry.seasons.set(season, record.status === 'pending' && ready.has(season) ? 'ready' : coarse(record.status));
      }
      titles.set(key, entry);
    }
    return titles;
  }

  /**
   * Reconciles request intents (see #reconcileIntents), then brings records up to date with Seerr and Jellyfin: a
   * request or interest follows its Seerr request (pending or approved, declined, failed, or completed for a request
   * made as the caller); a request Seerr deleted is `deleted`, for its requester's record and every interest in it
   * alike, so each household can ask again; an interest whose request completed, or that follows none, joins the title's grant once
   * Jellyfin has it; a record is `completed` only once every season it covers has episodes in Jellyfin (until then its
   * ready seasons are noted and it is read again); and a completed record of any branch is `deleted` once the title's
   * Seerr media record is. Reads at most {@link MAX_REFRESH_READS} records a run, those read longest ago first, each at
   * most every {@link REFRESH_REQUEST_EVERY_MS} (a completed record's media every {@link REFRESH_MEDIA_EVERY_MS}). Then
   * forgets the withdrawals whose request Seerr no longer has (see #refreshWithdrawals). Last, grants the webhooks
   * deferred for intents that are resolved now. Run at startup and by the scheduled reconciliation;
   * an aborted `signal` stops it before its next read.
   */
  public async refresh(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    await this.#reconcileIntents(signal);
    if (signal?.aborted) return;
    await this.#refreshRecords(signal);
    if (signal?.aborted) return;
    await this.#refreshWithdrawals(signal);
    if (signal?.aborted) return;
    await this.#retryDeferred(signal);
  }

  /**
   * Finds the withdrawals (see AppWithdrawal) whose request Seerr no longer has (deleted by an administrator): nothing
   * can grant such a request any more, but its download may go on. A requester's withdrawal of a genuine request
   * becomes a title hold, so its title is held for no household when it arrives rather than public; any other is
   * forgotten, so it no longer holds up a rollback (an administrator's delete sends every household following the
   * request back to Get this, and its arrival follows the ordinary rules). A requester's withdrawal of a genuine request
   * (one that would become a hold) is read every run, since its title would arrive public until it is found gone; any
   * other at most every {@link REFRESH_REQUEST_EVERY_MS}; at most {@link MAX_REFRESH_READS} a run, those read longest
   * ago first. Then the title holds are applied to what Jellyfin has now (AccessService.applyTitleHolds).
   */
  /**
   * #refreshWithdrawals on its own, for the arrival signals between scheduled reconciliations (each MEDIA_AVAILABLE
   * webhook and the library catalog sync): nothing to do, and no Seerr read, while no withdrawal is or could become a
   * title hold; a check already under way is joined rather than repeated. Never rejects.
   */
  public checkTitleHolds(options: { signal?: AbortSignal } = {}): Promise<void> {
    const possible = this.#store.listAppWithdrawals().some(([requestId, withdrawal]) => withdrawal.requesterId !== undefined
      && (withdrawal.seerrGoneAt !== undefined || !this.#store.hasHandledRequest(requestId)));
    if (!possible || options.signal?.aborted) return Promise.resolve();
    this.#holdCheck ??= this.#refreshWithdrawals(options.signal).catch((error: unknown) => {
      if (options.signal?.aborted) return;
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app title holds could not be checked',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }).finally(() => { this.#holdCheck = undefined; });
    return this.#holdCheck;
  }

  async #refreshWithdrawals(signal: AbortSignal | undefined): Promise<void> {
    await this.#findGoneWithdrawals(signal);
    if (signal?.aborted || this.#store.listAppTitleHolds().length === 0) return;
    try {
      await this.#joins.applyTitleHolds(signal ? { signal } : {});
    } catch (error) {
      if (signal?.aborted) return;
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app title holds could not be applied',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async #findGoneWithdrawals(signal: AbortSignal | undefined): Promise<void> {
    const now = this.#now();
    const due = this.#store.listAppWithdrawals()
      .filter(([requestId, withdrawal]) => !withdrawal.seerrGoneAt && !this.#store.hasHandledRequest(requestId)
        && (withdrawal.requesterId !== undefined || now - (this.#checkedAt.get(`withdrawal:${requestId}`) ?? 0) >= REFRESH_REQUEST_EVERY_MS))
      .sort(([left], [right]) => (this.#checkedAt.get(`withdrawal:${left}`) ?? 0) - (this.#checkedAt.get(`withdrawal:${right}`) ?? 0))
      .slice(0, MAX_REFRESH_READS);
    const gone: string[] = [];
    for (const [requestId] of due) {
      if (signal?.aborted) break;
      this.#checkedAt.set(`withdrawal:${requestId}`, this.#now());
      try {
        if (!await this.#seerr.requestState(requestId)) gone.push(requestId);
      } catch (error) {
        if (signal?.aborted) break;
        console.error(JSON.stringify({
          level: 'error',
          message: 'household app withdrawal refresh failed',
          detail: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    if (gone.length === 0) return;
    for (const requestId of gone) this.#checkedAt.delete(`withdrawal:${requestId}`);
    await this.#joins.serialized(() => this.#store.writeAppRequests({ requestsGone: gone }));
  }

  async #refreshRecords(signal: AbortSignal | undefined): Promise<void> {
    const now = this.#now();
    const records = this.#store.listAppRequests();
    const due = records.filter(([id, record]) => {
      if (record.status === 'declined' || record.status === 'deleted') return false;
      if (record.status === 'completed' && record.seerrMediaId === undefined) return false;
      if (record.status === 'failed' && !record.seerrRequestId) return false;
      return now - (this.#checkedAt.get(id) ?? 0) >= (record.status === 'completed' ? REFRESH_MEDIA_EVERY_MS : REFRESH_REQUEST_EVERY_MS);
    }).sort(([left], [right]) => (this.#checkedAt.get(left) ?? 0) - (this.#checkedAt.get(right) ?? 0)).slice(0, MAX_REFRESH_READS);
    const known = new Set([...records.map(([id]) => id), ...this.#store.listAppWithdrawals().map(([requestId]) => `withdrawal:${requestId}`)]);
    for (const id of [...this.#checkedAt.keys()]) if (!known.has(id)) this.#checkedAt.delete(id);
    for (const [id, record] of due) {
      if (signal?.aborted) return;
      this.#checkedAt.set(id, this.#now());
      try {
        const status = await this.#current(id, record, signal);
        if (signal?.aborted) return;
        if (status && (status.status !== record.status || !sameSeasons(status.readySeasons, record.readySeasons)
          || (status.awaitingGrant !== undefined && status.awaitingGrant !== (record.awaitingGrant === true)))) {
          // Written only if the record is still as it was read, in the queue a cancel's withdrawal (and every grant)
          // is written in: a record a cancel withdrew, or a grant settled, while Seerr was read is read again next run,
          // never overwritten by what was decided from the old one.
          await this.#joins.serialized(async () => {
            const current = this.#store.getAppRequest(id);
            if (!current || current.withdrawn || current.updatedAt !== record.updatedAt || current.status !== record.status) return;
            await this.#store.writeAppRequests({ update: [{ id, ...status }] });
          });
        }
      } catch (error) {
        if (signal?.aborted) return;
        console.error(JSON.stringify({
          level: 'error',
          message: 'household app record refresh failed',
          detail: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  /**
   * Resolves the intents no running call holds (see AppRequestIntent): after a restart, after a request Seerr may have
   * made without answering, and while a request's settle-time read keeps failing. A `submitting` intent is looked up in
   * Seerr's own requests for the title: the caller's HD requests made no earlier than the intent (allowing for Seerr's
   * clock) that no record names yet. Attribution is never guessed: only when exactly one such request is found, it is
   * not declined, the household is the one the call was made for (its epoch) and Jellyfin can be read to settle it is it
   * recorded for the household. Every other outcome gives way to a safety tombstone instead (see #retire): several
   * candidates or a declined one at once, a household replaced meanwhile, none found once APP_INTENT_TIMEOUT_MS has
   * passed, or Seerr or Jellyfin still unreadable once APP_SETTLE_DEADLINE_MS has. Until then a failed lookup leaves the
   * intent for the next run. A `settling` intent is settled again; once APP_SETTLE_DEADLINE_MS has passed without a
   * successful read, its request's grant follows the join rules (`unverified`).
   * An intent a running call claims is left alone, checked again right before each write that would remove it.
   */
  async #reconcileIntents(signal: AbortSignal | undefined): Promise<void> {
    for (const [id, intent] of this.#store.listAppRequestIntents()) {
      if (signal?.aborted) return;
      if (this.#live.has(id)) continue;
      try {
        if (intent.status === 'settling') await this.#resettle(id, intent);
        else await this.#recover(id, intent);
      } catch (error) {
        if (signal?.aborted) return;
        console.error(JSON.stringify({
          level: 'error',
          message: 'household app request intent could not be reconciled',
          detail: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  async #recover(id: string, intent: AppRequestIntent): Promise<void> {
    const age = this.#now() - Date.parse(intent.createdAt);
    let title: SeerrTitleRecord | undefined;
    try {
      title = await this.#seerr.titleRequests(intent.mediaType, intent.tmdbId);
    } catch (error) {
      // It holds up every grant for the title only so long.
      if (age < APP_SETTLE_DEADLINE_MS) throw error;
      return this.#retire(id, intent, [], 'intent_abandoned');
    }
    const recorded = this.#genuineRequests(intent);
    const since = Date.parse(intent.createdAt) - INTENT_CLOCK_SKEW_MS;
    const candidates = (title?.requests ?? []).filter((request) => !request.is4k
      && request.requesterJellyfinId === intent.jellyfinUserId
      && !recorded.includes(request.id)
      && (request.createdAt === undefined || request.createdAt >= since)
      && (intent.mediaType === 'movie' || request.seasons.some((season) => intent.seasons.includes(season))));
    if (candidates.length === 0) {
      if (age < APP_INTENT_TIMEOUT_MS) return;
      return this.#retire(id, intent, [], 'intent_cancelled');
    }
    const made = candidates[0] as SeerrTitleRecord['requests'][number];
    const current = intent.householdEpoch !== undefined && this.#store.householdEpoch(intent.householdId) === intent.householdEpoch;
    if (!title || candidates.length > 1 || made.status === DECLINED || !current) {
      return this.#retire(id, intent, candidates.map((request) => request.id), current ? 'intent_ambiguous' : 'intent_detached');
    }
    const seasons = intent.mediaType === 'movie' ? [] : intent.seasons.filter((season) => made.seasons.includes(season));
    const settled = await this.#settle(intent.mediaType, intent.tmdbId, seasons, title);
    if (settled === undefined) {
      if (age < APP_SETTLE_DEADLINE_MS) return;
      return this.#retire(id, intent, [made.id], 'intent_abandoned');
    }
    const stamp = new Date(this.#now()).toISOString();
    const record: AppRequestRecord = {
      householdId: intent.householdId,
      jellyfinUserId: intent.jellyfinUserId,
      mediaType: intent.mediaType,
      tmdbId: intent.tmdbId,
      seasons,
      createdAt: intent.createdAt,
      updatedAt: stamp,
      branch: 'request',
      status: made.status === FAILED ? 'failed' : 'pending',
      seerrRequestId: made.id,
      checkedAt: intent.observedAbsentAt,
      ...(settled !== 'absent' ? { joinOnGrant: settled } : {}),
      ...(title.mediaId !== undefined ? { seerrMediaId: title.mediaId } : {}),
    };
    // The request found may not be the one this intent made (Seerr may make that later): the member's other requests
    // for the title from then on follow the join rules all the same.
    const tombstone = this.#tombstone(intent, settled === 'absent' ? [] : [made.id], intent, settled === 'absent' ? [made.id] : []);
    if (this.#live.has(id)) return;
    await this.#store.writeAppRequests({ add: [record], householdEpoch: intent.householdEpoch as number, removeIntents: [id], tombstones: [tombstone] });
    this.#recordBranch('intent_recovered');
  }

  /**
   * Gives up on telling which request an intent made: the intent is replaced by a safety tombstone covering
   * `requestIds` and every request the member makes for the title from the intent's time on (see AppSafetyTombstone),
   * whichever household asks for it, and nothing is recorded for the household. From then on the intent holds up no
   * other member's grant for the title.
   */
  async #retire(id: string, intent: AppRequestIntent, requestIds: string[], branch: string): Promise<void> {
    if (this.#live.has(id)) return;
    await this.#store.writeAppRequests({ removeIntents: [id], tombstones: [this.#tombstone(intent, requestIds, intent)] });
    this.#recordBranch(branch);
  }

  /**
   * A safety tombstone for `requestIds` on the title, and with `member`, for that member's requests for it from the
   * intent's time on (allowing for Seerr's clock), less those recorded as genuine and `exempt`.
   */
  #tombstone(
    title: { mediaType: MediaType; tmdbId: number },
    requestIds: string[],
    member?: AppRequestIntent,
    exempt: string[] = [],
  ): AppSafetyTombstone {
    const now = this.#now();
    const exemptRequestIds = member ? [...new Set([...this.#genuineRequests(member), ...exempt])].sort() : [];
    return {
      mediaType: title.mediaType,
      tmdbId: title.tmdbId,
      requestIds: [...new Set(requestIds)].sort(),
      ...(member ? {
        jellyfinUserId: member.jellyfinUserId,
        since: new Date(Date.parse(member.createdAt) - INTENT_CLOCK_SKEW_MS).toISOString(),
      } : {}),
      ...(exemptRequestIds.length > 0 ? { exemptRequestIds } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + APP_TOMBSTONE_TTL_MS).toISOString(),
    };
  }

  /** The member's requests for the title that records name as made by "Get this" and genuine (no join rule). */
  #genuineRequests(intent: AppRequestIntent): string[] {
    return this.#store.listAppRequests().flatMap(([, record]) => record.seerrRequestId && record.branch === 'request' && !record.joinOnGrant
      && record.jellyfinUserId === intent.jellyfinUserId && record.mediaType === intent.mediaType && record.tmdbId === intent.tmdbId
      ? [record.seerrRequestId] : []);
  }

  async #resettle(id: string, intent: AppRequestIntent): Promise<void> {
    let settled: Settled | undefined;
    try {
      const title = await this.#seerr.titleRequests(intent.mediaType, intent.tmdbId);
      settled = await this.#settle(intent.mediaType, intent.tmdbId, intent.seasons, title ?? { names: [], requests: [] });
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app could not settle a request it made',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
    if (settled === undefined && this.#now() - Date.parse(intent.createdAt) < APP_SETTLE_DEADLINE_MS) return;
    const rule = settled === undefined ? 'unverified' : settled === 'absent' ? undefined : settled;
    const requestId = intent.seerrRequestId as string;
    const records = this.#store.listAppRequests()
      .filter(([, record]) => record.branch === 'request' && record.seerrRequestId === requestId && !record.joinOnGrant);
    if (this.#live.has(id)) return;
    await this.#store.writeAppRequests({
      update: rule ? records.map(([recordId]) => ({ id: recordId, joinOnGrant: rule })) : [],
      removeIntents: [id],
      ...(rule
        ? { tombstones: [this.#tombstone(intent, [requestId])] }
        : { exempt: [{ mediaType: intent.mediaType, tmdbId: intent.tmdbId, jellyfinUserId: intent.jellyfinUserId, requestId }] }),
    });
    this.#recordBranch(rule === 'unverified' ? 'settle_unverified' : 'settled');
  }

  /** Grants the webhooks deferred for intents that are resolved now (AccessService.retryDeferredRequests). */
  async #retryDeferred(signal: AbortSignal | undefined): Promise<void> {
    try {
      await this.#joins.retryDeferredRequests(signal ? { signal } : {});
    } catch (error) {
      if (signal?.aborted) return;
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app could not grant deferred webhooks',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /** What a record's status is now (see refresh), or undefined to leave it as it is. */
  async #current(id: string, record: AppRequestRecord, signal?: AbortSignal): Promise<RecordChange | undefined> {
    if (record.status === 'completed') return await this.#mediaGone(record) ? { status: 'deleted' } : undefined;
    // There was no grant to join (the title was public): joined once there is one, for so long.
    if (record.status === 'pending' && record.awaitingGrant) {
      if (this.#now() - Date.parse(record.createdAt) > APP_TOMBSTONE_TTL_MS) return { status: 'completed', awaitingGrant: false };
      return this.#joinInterest(id, record, signal);
    }
    // Its grant was settled already: it waits for its seasons (and for its media, should Seerr delete it meanwhile).
    if (record.status === 'pending' && record.itemIds?.length) {
      if (await this.#mediaGone(record)) return { status: 'deleted' };
      return this.#readiness(record, record.itemIds);
    }
    if (!record.seerrRequestId) return record.branch === 'interest' ? this.#joinInterest(id, record, signal) : undefined;
    const state = await this.#seerr.requestState(record.seerrRequestId);
    // Deleted in Seerr (by an administrator): the same for the request and every household following it, which can ask
    // again ("Get this").
    if (!state) return { status: 'deleted' };
    if (ACTIVE_REQUEST_STATUSES.has(state.status)) return { status: 'pending' };
    if (state.status === DECLINED) return { status: 'declined' };
    if (state.status === FAILED) return { status: 'failed' };
    if (state.status !== COMPLETED) return undefined;
    if (record.branch === 'interest' || record.joinOnGrant) return this.#joinInterest(id, record, signal);
    // The caller's own request completed: ready once Jellyfin has every season it covers.
    const title = await this.#seerr.titleRequests(record.mediaType, record.tmdbId);
    if (!title) return undefined;
    const present = await this.#presence(record.mediaType, record.tmdbId, title);
    return present.itemIds.length > 0 ? this.#readiness(record, present.itemIds) : undefined;
  }

  /**
   * An interest whose request completed (or that follows none), or a request of the app's whose grant follows the join
   * rules: the household joins the title's grant, if Jellyfin has it. When no grant holds the title, it waits for one;
   * if its request was granted as a join already (handled, and no grant made: the title stayed public), its seasons
   * are ready but it stays `pending`, awaiting a grant (see AppRequestRecord.awaitingGrant), never `completed` against
   * a public title.
   */
  async #joinInterest(id: string, record: AppRequestRecord, signal?: AbortSignal): Promise<RecordChange | undefined> {
    if (record.detached) return undefined;
    const title = await this.#seerr.titleRequests(record.mediaType, record.tmdbId);
    const itemIds = title ? (await this.#presence(record.mediaType, record.tmdbId, title)).itemIds : await this.#jellyfin.findItemsByTmdbId(record.mediaType, record.tmdbId);
    if (itemIds.length === 0) return undefined;
    // `recordId`: the join is refused if a cancel withdrew the record since it was read (checked in the write queue).
    const joined = await this.#joins.joinHousehold({ itemIds, userId: record.jellyfinUserId, householdId: record.householdId, recordId: id }, signal ? { signal } : {});
    if (joined === 'joined' || joined === 'already') return { ...await this.#readiness(record, itemIds), awaitingGrant: false };
    if (joined === 'ungranted') {
      if (record.awaitingGrant || (record.seerrRequestId && this.#store.hasHandledRequest(record.seerrRequestId))) {
        return awaiting(record, await this.#readiness(record, itemIds));
      }
      return undefined;
    }
    // A grant not created yet (Jellyfin has the title before Seerr's webhook) is tried again on the next run.
    return joined === 'refused' && record.status === 'pending' && record.seerrRequestId ? { status: 'failed', itemIds } : undefined;
  }

  /**
   * A record whose household has (or joined) the grant of `itemIds`: `completed` once every season it covers has
   * episodes in Jellyfin (a movie at once), otherwise still `pending` with the seasons that have.
   */
  async #readiness(record: AppRequestRecord, itemIds: string[]): Promise<RecordChange> {
    if (record.mediaType === 'movie') return { status: 'completed', itemIds };
    const present = new Set((await Promise.all(itemIds.map((itemId) => this.#jellyfin.seasonsWithEpisodes(itemId)))).flat());
    const readySeasons = record.seasons.filter((season) => present.has(season));
    return { status: readySeasons.length === record.seasons.length ? 'completed' : 'pending', itemIds, readySeasons };
  }

  /** Whether the Seerr media record the record was made against is gone (deleting it deletes every request on it). */
  async #mediaGone(record: AppRequestRecord): Promise<boolean> {
    if (record.seerrMediaId === undefined) return false;
    const title = await this.#seerr.titleRequests(record.mediaType, record.tmdbId);
    return !title || title.mediaId !== record.seerrMediaId;
  }

  /** Runs `work` after every earlier call holding `key` in `locks` has settled. */
  #withLock<T>(locks: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }
}

/** Waits `ms` (if positive), or until `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Whether a failed request was certainly not made: Seerr refused it (a 4xx), the caller could not be confirmed, or its
 * input was refused before anything was sent. Anything else (no answer, a 5xx, an answer that could not be read) may
 * have been made.
 */
function definitelyNotMade(error: unknown): boolean {
  if (error instanceof SeerrUnmappedUserError || (error instanceof TypeError && error.cause === undefined)) return true;
  return error instanceof SeerrError && error.status >= 400 && error.status < 500;
}

/** Shutdown aborted a branch before its next step. */
class CancelledError extends Error {}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError('cancelled');
}

/**
 * The HD items among Jellyfin's items for a title: never the item Seerr links as the 4K one only, and only Seerr's HD
 * item when it is among them. An item Seerr does not link is taken as HD, so a title Jellyfin has is never requested again.
 */
function hdItems(items: string[], title: SeerrTitleRecord): string[] {
  // One item Seerr links as both (Jellyfin merged the versions) holds the HD one too.
  const hd = items.filter((itemId) => itemId !== title.jellyfinMediaId4k || itemId === title.jellyfinMediaId);
  return title.jellyfinMediaId && hd.includes(title.jellyfinMediaId) ? [title.jellyfinMediaId] : hd;
}

/**
 * An HD request on the title covering `season` (any request, for a movie) that is active, or with `blocking`, any
 * that would make Seerr refuse a new one (every status but declined). The caller's own comes first.
 */
function activeRequest(title: SeerrTitleRecord, mediaType: MediaType, season: number, blocking: boolean): SeerrTitleRecord['requests'][number] | undefined {
  const candidates = title.requests.filter((request) => !request.is4k
    && (blocking ? request.status !== DECLINED : ACTIVE_REQUEST_STATUSES.has(request.status))
    && (mediaType === 'movie' || request.seasons.includes(season)));
  return candidates.find((request) => ACTIVE_REQUEST_STATUSES.has(request.status)) ?? candidates[0];
}

/**
 * Whether the caller may cancel a listed title, as they are shown it (see HouseholdRequests.list): Requested with
 * nothing of it shown ready to them, and with a record of theirs that is waiting or ready. Decided from the household's
 * own records and the caller's own view only: never from Seerr, other households, intents or arrivals the caller cannot
 * see, so it is the same whichever branch "Get this" took.
 */
function cancellable(entry: ListedTitle): boolean {
  const statuses = [...entry.seasons.values()];
  return entry.own && statuses.includes('requested') && !statuses.includes('ready');
}

function isActive(record: AppRequestRecord): boolean {
  return !record.detached && record.status === 'pending' && record.branch !== 'join';
}

/** The seasons (`0` for a movie) an active record still waits on. */
function waitingSeasons(record: AppRequestRecord): number[] {
  const ready = new Set(record.readySeasons ?? []);
  if (record.mediaType === 'movie') return ready.has(0) ? [] : [0];
  return record.seasons.filter((season) => !ready.has(season));
}

/**
 * A record whose grant follows the join rules (or an interest) that found no grant for `itemIds`: the title is public,
 * so its seasons (`0` for a movie) are ready, and it stays `pending`, awaiting a grant (AppRequestRecord.awaitingGrant).
 */
function awaiting(record: Pick<AppRequestRecord, 'mediaType'>, ready: RecordChange): RecordChange {
  return { status: 'pending', itemIds: ready.itemIds ?? [], readySeasons: record.mediaType === 'movie' ? [0] : ready.readySeasons ?? [], awaitingGrant: true };
}

/** Whether Jellyfin holds `season` (`0` for a movie) of the title, or may (see Presence.unknown). */
function holds(present: Presence, season: number): boolean {
  return present.unknown || present.seasons.has(season);
}

function sameSeasons(left: number[] | undefined, right: number[] | undefined): boolean {
  return (left ?? []).join() === (right ?? []).join();
}

function seasonsOf(mediaType: MediaType, seasons: number[]): number[] {
  return mediaType === 'movie' ? [] : [...seasons].sort((left, right) => left - right);
}

function coarse(status: AppRequestStatus): CoarseStatus {
  return status === 'pending' ? 'requested' : status === 'completed' ? 'ready' : 'failed';
}

function seasonList(value: unknown): number[] {
  return (Array.isArray(value) ? value : []).flatMap((season) => {
    const number = positiveInteger(field(season, 'seasonNumber'));
    return number === null ? [] : [number];
  });
}

function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, name)) return undefined;
  return (value as Record<string, unknown>)[name];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
