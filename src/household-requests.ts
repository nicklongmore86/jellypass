import { createHmac } from 'node:crypto';
import type { HouseholdJoinResult } from './access-service.js';
import { readBlocklist, seerrPermissions, type MediaType } from './app-api.js';
import type { JellyfinClient } from './jellyfin.js';
import { SeerrError, SeerrUnmappedUserError, type SeerrClient, type SeerrMemberClient, type SeerrTitleRecord } from './seerr.js';
import type { BackgroundTasks } from './shutdown.js';
import type { GrantStore } from './store.js';
import type { AppRequestRecord, AppRequestStatus } from './types.js';

/**
 * Household app "Get this" (docs/app-design.md, "Get this"). The answer depends on nothing but the call itself: it is
 * the same `202` once the call is accepted. Everything else runs afterwards, in the background, and its outcome is never
 * part of any answer: first the caller's request permission and quota eligibility, checked under a per-user lock against
 * Seerr's own count of their requests plus the virtual requests JellyPass recorded for them (the same lock every Seerr
 * request made as the caller is sent under, so a quota read never overlaps one); then, serialized per title:
 *
 * - the caller can already see the title (or the seasons asked for): nothing;
 * - Jellyfin already has it: the household joins its grant through the library join rules, never a Seerr request;
 * - Seerr has an active HD request for it from anyone: the household's interest is recorded, and the household joins
 *   the grant when it is created;
 * - otherwise: a real HD Seerr request as the caller.
 *
 * A series is decided season by season. Join and interest are counted as virtual requests, one unit per movie or per
 * season, exactly as Seerr would count the caller's own request (see {@link AppRequestRecord}).
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
 * does not tell the request branch (one more Seerr call) from the interest branch, while Seerr answers within it.
 */
export const RECORD_DELAY_MS = 2000;
/** Most titles GET /requests lists, newest first. */
export const MAX_LISTED_TITLES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Seerr request statuses: pending and approved requests are active. */
const ACTIVE_REQUEST_STATUSES = new Set([1, 2]);
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
  }>;
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
    | 'listAppRequests' | 'listAppRequestsForHousehold' | 'listAppRequestsForUser' | 'prunedAppQuotaUnits' | 'writeAppRequests'
    | 'getAppIdKey' | 'householdEpoch' | 'holdAppRequest' | 'releaseAppRequest' | 'hasHandledRequest'>;
  /** Jellyfin with JellyPass's own key: the decision input for "Jellyfin already has it". */
  jellyfin: Pick<JellyfinClient, 'findItemsByTmdbId' | 'existingItems' | 'seasonsWithEpisodes'>;
  /** Seerr with the admin key: the blocklist, a title's requests, and the status of requests JellyPass recorded. */
  seerr: Pick<SeerrClient, 'blocklist' | 'titleRequests' | 'requestState'>;
  /** The caller's own Seerr user, confirmed before every call (a `SeerrUserMap`). */
  members: { member(jellyfinUserId: string): Pick<SeerrMemberClient, 'ownUser' | 'quota' | 'createRequest'> | undefined };
  /** The library join rules (AccessService.joinHousehold). */
  joins: {
    joinHousehold(
      input: { itemIds: string[]; userId: string; householdId: string; householdEpoch?: number },
      options: { signal?: AbortSignal },
    ): Promise<HouseholdJoinResult>;
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

/**
 * The units an accepted call holds from the moment it was found eligible until its records are written (see
 * #eligible). A Seerr request made as the caller gives its units up the moment Seerr has made it: Seerr counts them
 * from then on, and no quota read of the caller's is in flight then (both run under the caller's lock).
 */
interface Reservation {
  mediaType: MediaType;
  units: number;
}

/** A record's new status (see HouseholdRequests.refresh). */
type RecordChange = { status: AppRequestStatus; itemIds?: string[]; readySeasons?: number[] };

/** What the branches of one call did, to be recorded together; filled as they go, so what was done is recorded. */
interface Outcome {
  records: AppRequestRecord[];
  /** Seerr requests made as the caller, noted in the store until their records are written (GrantStore.holdAppRequest). */
  held: string[];
}

/** What Jellyfin holds of a title (see #presence). */
interface Presence {
  /** Its HD movie or series items. */
  itemIds: string[];
  /** The seasons (`0` for a movie) those items have: a movie's item, or a series' episodes. */
  seasons: Set<number>;
}

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
  readonly #userLocks = new Map<string, Promise<unknown>>();
  readonly #titleLocks = new Map<string, Promise<unknown>>();
  readonly #reservations = new Map<string, Set<Reservation>>();
  /** When each record was last read from Seerr by refresh(), by record ID; memory only. */
  readonly #checkedAt = new Map<string, number>();

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
   * The background part of one call: under the caller's lock, decides their eligibility for the media type from their
   * own Seerr permission and quota, and nothing about the title or other households; if eligible, holds the units the
   * call needs and runs the branches. A failure reading eligibility runs nothing.
   */
  async #run(input: GetThisInput, epoch: number | undefined, acceptedAt: number, signal: AbortSignal): Promise<void> {
    // The answer is written before anything is read.
    await new Promise((resolve) => setImmediate(resolve));
    let reservation: Reservation | undefined;
    try {
      reservation = await this.#withLock(this.#userLocks, input.callerId, async () => {
        checkSignal(signal);
        const units = input.mediaType === 'movie' ? 1 : input.seasons.length;
        if (epoch === undefined || !await this.#eligible(input.callerId, input.mediaType, units)) return undefined;
        checkSignal(signal);
        const held: Reservation = { mediaType: input.mediaType, units };
        this.#reservations.set(input.callerId, (this.#reservations.get(input.callerId) ?? new Set()).add(held));
        return held;
      });
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
    if (!reservation) return void this.#record('ineligible');
    this.#record('accepted');
    await this.#branches(input, epoch as number, reservation, acceptedAt, signal);
  }

  /**
   * Whether the caller may ask for `units` more of `mediaType`: they have Seerr's request permission for it and, when
   * Seerr gives them a quota, Seerr's own count of their requests plus their virtual requests in the same window plus
   * the units held by their calls still running plus `units` is within the limit (Seerr 3.5.1 `User.getQuota`: `days`
   * 0 or unset counts every request ever made). Run under the caller's lock, as is every Seerr request made as them,
   * so each unit is counted exactly once whichever branch is serving it: by the reservation until Seerr has made the
   * request (then by Seerr's `used`) or until the record is written (then by the tally).
   */
  async #eligible(callerId: string, mediaType: MediaType, units: number): Promise<boolean> {
    const member = this.#members.member(callerId);
    if (!member) return false;
    let user: unknown;
    let quota: unknown;
    try {
      [user, quota] = await Promise.all([member.ownUser(), member.quota()]);
    } catch (error) {
      if (error instanceof SeerrUnmappedUserError) return false;
      throw error;
    }
    if (!seerrPermissions(user)[mediaType]) return false;
    const limits = field(quota, mediaType);
    const limit = field(limits, 'limit');
    // No limit, or one the caller bypasses (Seerr then reports 0): Seerr counts nothing, and neither does the tally.
    if (!isCount(limit) || limit === 0) return true;
    const used = field(limits, 'used');
    const days = field(limits, 'days');
    if (!isCount(used)) throw new SeerrError('Seerr GET /api/v1/user/:self/quota returned an unexpected answer', 502);
    const windowStart = isCount(days) && days > 0 ? this.#now() - days * DAY_MS : -Infinity;
    const combined = used + this.#virtualUnits(callerId, mediaType, windowStart) + this.#reservedUnits(callerId, mediaType);
    return combined + units <= limit;
  }

  /**
   * The caller's virtual requests (join and interest records, and those pruned into their ledger) for a media type
   * made after `windowStart`, in units, counted as Seerr counts its own: every status except declined, nothing once
   * deleted. Records of a household since deleted still count: they were the caller's.
   */
  #virtualUnits(callerId: string, mediaType: MediaType, windowStart: number): number {
    let units = this.#store.prunedAppQuotaUnits(callerId, mediaType, windowStart);
    for (const [, record] of this.#store.listAppRequestsForUser(callerId)) {
      if (record.mediaType !== mediaType || !counted(record)) continue;
      if (Date.parse(record.createdAt) <= windowStart) continue;
      units += unitsOf(record);
    }
    return units;
  }

  /** Units held by the caller's calls running now (see Reservation). */
  #reservedUnits(callerId: string, mediaType: MediaType): number {
    let units = 0;
    for (const reservation of this.#reservations.get(callerId) ?? []) if (reservation.mediaType === mediaType) units += reservation.units;
    return units;
  }

  /** Gives up what is left of a call's reservation: its records were just written. */
  #release(callerId: string, reservation: Reservation): void {
    const held = this.#reservations.get(callerId);
    held?.delete(reservation);
    if (held?.size === 0) this.#reservations.delete(callerId);
  }

  /** The branches of one call, in the title's turn, recorded together no sooner than RECORD_DELAY_MS after it was accepted. */
  async #branches(input: GetThisInput, epoch: number, reservation: Reservation, acceptedAt: number, signal: AbortSignal): Promise<void> {
    const recordAfter = acceptedAt + this.#recordDelayMs;
    await this.#withLock(this.#titleLocks, `${input.mediaType}:${input.tmdbId}`, async () => {
      const outcome: Outcome = { records: [], held: [] };
      try {
        await this.#decide(input, epoch, reservation, outcome, signal);
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
      // Recorded even after shutdown began: a Seerr request already made must keep its attribution record. The store
      // detaches them if the household was deleted (or deleted and created again) meanwhile.
      let writing: Promise<unknown> | undefined;
      try {
        writing = outcome.records.length > 0 ? this.#store.writeAppRequests({ add: outcome.records, householdEpoch: epoch }) : undefined;
      } catch (error) {
        writing = Promise.reject(error);
      }
      // In the same turn as the write: the tally counts the records from now on, and the reservation no longer does.
      this.#release(input.callerId, reservation);
      for (const requestId of outcome.held) this.#store.releaseAppRequest(requestId);
      await writing?.catch((error: unknown) => console.error(JSON.stringify({
        level: 'error',
        message: 'household app get this could not be recorded',
        detail: error instanceof Error ? error.message : String(error),
      })));
    });
  }

  /**
   * Decides and runs each branch for the call (see the class comment), adding to `outcome` as it goes. Throws if a
   * lookup fails: what was done until then is still recorded.
   */
  async #decide(input: GetThisInput, epoch: number, reservation: Reservation, outcome: Outcome, signal: AbortSignal): Promise<void> {
    const { mediaType, tmdbId, householdId } = input;
    const stamp = new Date(this.#now()).toISOString();
    const base = { householdId, jellyfinUserId: input.callerId, mediaType, tmdbId, createdAt: stamp, updatedAt: stamp };
    checkSignal(signal);
    // The administrators' blocklist is the same for every household; Seerr would refuse the request, so nothing is counted.
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
    checkSignal(signal);
    const join: number[] = [];
    const interests = new Map<string, number[]>();
    const request: number[] = [];
    for (const season of wanted) {
      if (present.seasons.has(season)) {
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
    if (request.length > 0 && !signal.aborted) await this.#request(input, base, epoch, reservation, title, request, outcome, signal);
    else if (request.length > 0) this.#recordBranch('cancelled');
  }

  /**
   * What Jellyfin holds of a title, read with JellyPass's key whoever may see it: every movie or series item with its
   * TMDB ID, and the items Seerr's media record links to it (which may have no TMDB ID of their own), less the 4K one
   * (see hdItems); for a series, the seasons those items have episodes of.
   */
  async #presence(mediaType: MediaType, tmdbId: number, title: SeerrTitleRecord): Promise<Presence> {
    const linked = [title.jellyfinMediaId, title.jellyfinMediaId4k].filter((itemId): itemId is string => itemId !== undefined);
    const [byTmdb, byLink] = await Promise.all([
      this.#jellyfin.findItemsByTmdbId(mediaType, tmdbId),
      linked.length > 0 ? this.#jellyfin.existingItems(mediaType, linked) : Promise.resolve([]),
    ]);
    const itemIds = hdItems([...new Set([...byTmdb, ...byLink])].sort(), title);
    const seasons = new Set<number>();
    if (mediaType === 'movie' && itemIds.length > 0) seasons.add(0);
    if (mediaType === 'tv') {
      for (const found of await Promise.all(itemIds.map((itemId) => this.#jellyfin.seasonsWithEpisodes(itemId)))) {
        for (const season of found) seasons.add(season);
      }
    }
    return { itemIds, seasons };
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
   * The request branch: a real HD Seerr request as the caller for `seasons` (`[0]` for a movie). Under the caller's
   * lock, Jellyfin is read again (the re-check) and the request sent right after, with nothing else awaited between
   * them: a title (or season) that arrived since the branch's first read is joined instead. What is left is one
   * request's round trip, in which a title arriving would still be requested; its record is then checked once more
   * before it is written (see #settleCheck), so its grant follows the join rules.
   */
  async #request(
    input: GetThisInput,
    base: Omit<AppRequestRecord, 'seasons' | 'branch' | 'status'>,
    epoch: number,
    reservation: Reservation,
    title: SeerrTitleRecord,
    seasons: number[],
    outcome: Outcome,
    signal: AbortSignal,
  ): Promise<void> {
    const member = this.#members.member(input.callerId);
    if (!member) return void this.#recordBranch('request_refused');
    let recheck: Presence = { itemIds: [], seasons: new Set() };
    let checkedAt = '';
    let late: number[] = [];
    let created: unknown;
    let failure: unknown;
    let cancelled = false;
    await this.#withLock(this.#userLocks, input.callerId, async () => {
      if (signal.aborted) {
        cancelled = true;
        return;
      }
      recheck = await this.#presence(input.mediaType, input.tmdbId, title);
      checkedAt = new Date(this.#now()).toISOString();
      late = seasons.filter((season) => recheck.seasons.has(season));
      if (late.length === seasons.length) return;
      try {
        created = await member.createRequest(input.mediaType === 'movie'
          ? { mediaType: 'movie', tmdbId: input.tmdbId }
          : { mediaType: 'tv', tmdbId: input.tmdbId, seasons: seasons.filter((season) => !late.includes(season)) });
      } catch (error) {
        failure = error;
        return;
      }
      const requestId = positiveInteger(field(created, 'id'));
      if (requestId === null) return;
      // Seerr counts the seasons it made the request for from now on; no quota read of the caller's is in flight.
      const createdSeasons = new Set(seasonList(field(created, 'seasons')));
      reservation.units -= input.mediaType === 'movie' ? 1 : seasons.filter((season) => createdSeasons.has(season)).length;
      this.#store.holdAppRequest(String(requestId));
      outcome.held.push(String(requestId));
    }).catch((error: unknown) => {
      failure = error;
    });
    if (cancelled) return void this.#recordBranch('cancelled');
    if (late.length > 0) {
      this.#recordBranch('request_late');
      await this.#join(input, base, epoch, title, recheck.itemIds, late, outcome, signal);
    }
    const requested = seasons.filter((season) => !late.includes(season));
    if (requested.length === 0) return;
    if (failure !== undefined) {
      // Seerr refused it as a duplicate: someone requested it meanwhile, so it is followed instead.
      if (failure instanceof SeerrError && failure.status === 409) return this.#fallBack(input, base, requested, outcome);
      // Refused before anything was recorded (permission, quota, blocklist, or the caller was unlinked): not counted.
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
    if (requestId !== null && covered.length > 0) {
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
      await this.#settleCheck(record, title);
      outcome.records.push(record);
    }
    const rest = requested.filter((season) => !covered.includes(season));
    if (rest.length > 0) await this.#fallBack(input, base, rest, outcome);
  }

  /**
   * Reads Jellyfin once more for a request just made, before its record is written: if the title (or one of its
   * seasons) is there now, it arrived while the request was being made, and the record says its grant must follow the
   * join rules (`present-at-settle`); a series that is there without those seasons is an existing series. A failed
   * read changes nothing: a genuine request keeps its private grant.
   */
  async #settleCheck(record: AppRequestRecord, title: SeerrTitleRecord): Promise<void> {
    if (record.joinOnGrant) return;
    try {
      const present = await this.#presence(record.mediaType, record.tmdbId, title);
      if (present.itemIds.length === 0) return;
      const arrived = record.mediaType === 'movie' || record.seasons.some((season) => present.seasons.has(season));
      record.joinOnGrant = arrived ? 'present-at-settle' : 'existing-series';
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'household app could not check a request it made',
        detail: error instanceof Error ? error.message : String(error),
      }));
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
   * The interest branch for `seasons` covered by `underlying`. The caller's own request (made outside the app) is
   * already counted by Seerr, so it becomes the household's request record rather than a virtual request.
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
   * seasons already ready), or a failed one (Seerr refuses a new request while a failed one stands, and counts none).
   */
  #askedSeasons(householdId: string, mediaType: MediaType, tmdbId: number): Set<number> {
    const seasons = new Set<number>();
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
      if (!isActive(record)) continue;
      keys.add(`${record.mediaType}:${record.tmdbId}`);
      if (record.mediaType === 'tv') for (const season of waitingSeasons(record)) keys.add(`tv:${record.tmdbId}:${season}`);
    }
    return keys;
  }

  /**
   * This household's titles with their coarse status, from its own records only: no Seerr ID, no requester beyond
   * whether it was the caller, no count but the entries listed. A title's latest record decides each season (or the
   * movie); a season Jellyfin already has episodes of for a record still waiting on others is `ready`; a series is
   * `requested` while any season is, otherwise `ready` if any season is. Records whose request or media Seerr deleted are
   * not listed, as Seerr no longer lists such a request either.
   */
  public list(householdId: string, callerId: string): RequestsDto {
    const titles = new Map<string, { mediaType: MediaType; tmdbId: number; latest: string; byYou: boolean; seasons: Map<number, CoarseStatus> }>();
    const records = this.#store.listAppRequestsForHousehold(householdId).map(([, record]) => record)
      .filter((record) => !record.detached && record.status !== 'deleted')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const record of records) {
      const key = `${record.mediaType}:${record.tmdbId}`;
      const entry = titles.get(key) ?? { mediaType: record.mediaType, tmdbId: record.tmdbId, latest: record.createdAt, byYou: false, seasons: new Map() };
      entry.latest = record.createdAt;
      entry.byYou ||= record.jellyfinUserId === callerId;
      const ready = new Set(record.readySeasons ?? []);
      for (const season of record.mediaType === 'movie' ? [0] : record.seasons) {
        entry.seasons.set(season, record.status === 'pending' && ready.has(season) ? 'ready' : coarse(record.status));
      }
      titles.set(key, entry);
    }
    const key = this.#store.getAppIdKey() ?? '';
    return {
      results: [...titles.values()]
        .sort((left, right) => right.latest.localeCompare(left.latest) || left.tmdbId - right.tmdbId)
        .slice(0, MAX_LISTED_TITLES)
        .map((entry) => {
          const statuses = [...entry.seasons.values()];
          const status: CoarseStatus = statuses.includes('requested') ? 'requested' : statuses.includes('ready') ? 'ready' : 'failed';
          return {
            id: createHmac('sha256', key).update(`${householdId}\n${entry.mediaType}\n${entry.tmdbId}`).digest('base64url').slice(0, 22),
            mediaType: entry.mediaType,
            tmdbId: entry.tmdbId,
            status,
            seasons: entry.mediaType === 'movie' ? [] : [...entry.seasons].sort(([left], [right]) => left - right)
              .map(([seasonNumber, seasonStatus]) => ({ seasonNumber, status: seasonStatus })),
            byYou: entry.byYou,
          };
        }),
    };
  }

  /**
   * Brings records up to date with Seerr and Jellyfin, as the member's own request would be (docs/app-design.md,
   * "Quota before branching"): a request or interest follows its Seerr request (pending or approved, declined, failed,
   * or completed for a request made as the caller); a request Seerr deleted is `deleted` if the title's media record went
   * with it, and otherwise frees nothing for an interest (`failed`, the caller's own request would not have been
   * deleted); an interest whose request completed, or that follows none, joins the title's grant once Jellyfin has it; a
   * record is `completed` only once every season it covers has episodes in Jellyfin (until then its ready seasons are
   * noted and it is read again); and a completed record of any branch is `deleted` once the title's Seerr media record
   * is, freeing its unit as Seerr frees its own request's. Reads at most {@link MAX_REFRESH_READS} records a run, those
   * read longest ago first, each at most every {@link REFRESH_REQUEST_EVERY_MS} (a completed record's media every
   * {@link REFRESH_MEDIA_EVERY_MS}). Run by the scheduled reconciliation; an aborted `signal` stops it before its next read.
   */
  public async refresh(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    const now = this.#now();
    const records = this.#store.listAppRequests();
    const due = records.filter(([id, record]) => {
      if (record.status === 'declined' || record.status === 'deleted') return false;
      if (record.status === 'completed' && record.seerrMediaId === undefined) return false;
      if (record.status === 'failed' && !record.seerrRequestId) return false;
      return now - (this.#checkedAt.get(id) ?? 0) >= (record.status === 'completed' ? REFRESH_MEDIA_EVERY_MS : REFRESH_REQUEST_EVERY_MS);
    }).sort(([left], [right]) => (this.#checkedAt.get(left) ?? 0) - (this.#checkedAt.get(right) ?? 0)).slice(0, MAX_REFRESH_READS);
    const known = new Set(records.map(([id]) => id));
    for (const id of [...this.#checkedAt.keys()]) if (!known.has(id)) this.#checkedAt.delete(id);
    for (const [id, record] of due) {
      if (signal?.aborted) return;
      this.#checkedAt.set(id, this.#now());
      try {
        const status = await this.#current(record, signal);
        if (signal?.aborted) return;
        if (status && (status.status !== record.status || !sameSeasons(status.readySeasons, record.readySeasons))) {
          await this.#store.writeAppRequests({ update: [{ id, ...status }] });
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

  /** What a record's status is now (see refresh), or undefined to leave it as it is. */
  async #current(record: AppRequestRecord, signal?: AbortSignal): Promise<RecordChange | undefined> {
    if (record.status === 'completed') return await this.#mediaGone(record) ? { status: 'deleted' } : undefined;
    // Its grant was settled already: it waits for its seasons (and for its media, should Seerr delete it meanwhile).
    if (record.status === 'pending' && record.itemIds?.length) {
      if (await this.#mediaGone(record)) return { status: 'deleted' };
      return this.#readiness(record, record.itemIds);
    }
    if (!record.seerrRequestId) return record.branch === 'interest' ? this.#joinInterest(record, signal) : undefined;
    const state = await this.#seerr.requestState(record.seerrRequestId);
    if (!state) {
      if (await this.#mediaGone(record)) return { status: 'deleted' };
      return { status: record.branch === 'interest' ? 'failed' : 'deleted' };
    }
    if (ACTIVE_REQUEST_STATUSES.has(state.status)) return { status: 'pending' };
    if (state.status === DECLINED) return { status: 'declined' };
    if (state.status === FAILED) return { status: 'failed' };
    if (state.status !== COMPLETED) return undefined;
    if (record.branch === 'interest' || record.joinOnGrant) return this.#joinInterest(record, signal);
    // The caller's own request completed: ready once Jellyfin has every season it covers.
    const title = await this.#seerr.titleRequests(record.mediaType, record.tmdbId);
    if (!title) return undefined;
    const present = await this.#presence(record.mediaType, record.tmdbId, title);
    return present.itemIds.length > 0 ? this.#readiness(record, present.itemIds) : undefined;
  }

  /**
   * An interest whose request completed (or that follows none), or a request of the app's whose grant follows the join
   * rules: the household joins the title's grant, if Jellyfin has it. When no grant holds the title, it waits for one,
   * unless its request was granted as a join (handled, and no grant made: the title stayed public).
   */
  async #joinInterest(record: AppRequestRecord, signal?: AbortSignal): Promise<RecordChange | undefined> {
    if (record.detached) return undefined;
    const title = await this.#seerr.titleRequests(record.mediaType, record.tmdbId);
    const itemIds = title ? (await this.#presence(record.mediaType, record.tmdbId, title)).itemIds : await this.#jellyfin.findItemsByTmdbId(record.mediaType, record.tmdbId);
    if (itemIds.length === 0) return undefined;
    const joined = await this.#joins.joinHousehold({ itemIds, userId: record.jellyfinUserId, householdId: record.householdId }, signal ? { signal } : {});
    if (joined === 'joined' || joined === 'already') return this.#readiness(record, itemIds);
    if (joined === 'ungranted') {
      return record.seerrRequestId && this.#store.hasHandledRequest(record.seerrRequestId) ? this.#readiness(record, itemIds) : undefined;
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

function isActive(record: AppRequestRecord): boolean {
  return !record.detached && record.status === 'pending' && record.branch !== 'join';
}

/** Whether a record is one of its member's virtual requests that Seerr would count: a join or interest neither declined nor deleted. */
function counted(record: AppRequestRecord): boolean {
  return record.branch !== 'request' && record.status !== 'declined' && record.status !== 'deleted';
}

/** The seasons (`0` for a movie) an active record still waits on. */
function waitingSeasons(record: AppRequestRecord): number[] {
  if (record.mediaType === 'movie') return [0];
  const ready = new Set(record.readySeasons ?? []);
  return record.seasons.filter((season) => !ready.has(season));
}

function sameSeasons(left: number[] | undefined, right: number[] | undefined): boolean {
  return (left ?? []).join() === (right ?? []).join();
}

function unitsOf(record: AppRequestRecord): number {
  return record.mediaType === 'movie' ? 1 : record.seasons.length;
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

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
