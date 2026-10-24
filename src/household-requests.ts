import { createHmac } from 'node:crypto';
import type { HouseholdJoinResult } from './access-service.js';
import { readBlocklist, seerrPermissions, type MediaType } from './app-api.js';
import type { JellyfinClient } from './jellyfin.js';
import { SeerrError, SeerrUnmappedUserError, type SeerrClient, type SeerrMemberClient, type SeerrTitleRecord } from './seerr.js';
import type { BackgroundTasks } from './shutdown.js';
import type { GrantStore } from './store.js';
import type { AppRequestRecord, AppRequestStatus } from './types.js';

/**
 * Household app "Get this" (docs/app-design.md, "Get this"). The immediate part depends only on the caller: their
 * request permission and quota eligibility, checked under a per-user lock against Seerr's own count of their requests
 * plus the virtual requests JellyPass recorded for them. Everything that depends on the title runs afterwards, in the
 * background and serialized per title, and its outcome is never part of any answer:
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
  store: Pick<GrantStore, 'listAppRequests' | 'writeAppRequests' | 'getAppIdKey' | 'getGroup'>;
  /** Jellyfin with JellyPass's own key: the decision input for "Jellyfin already has it". */
  jellyfin: Pick<JellyfinClient, 'findItemsByTmdbId' | 'seasonsWithEpisodes'>;
  /** Seerr with the admin key: the blocklist, a title's requests, and the status of requests JellyPass recorded. */
  seerr: Pick<SeerrClient, 'blocklist' | 'titleRequests' | 'requestState'>;
  /** The caller's own Seerr user, confirmed before every call (a `SeerrUserMap`). */
  members: { member(jellyfinUserId: string): Pick<SeerrMemberClient, 'ownUser' | 'quota' | 'createRequest'> | undefined };
  /** The library join rules (AccessService.joinHousehold). */
  joins: { joinHousehold(input: { itemIds: string[]; userId: string; householdId: string }, options: { signal?: AbortSignal }): Promise<HouseholdJoinResult> };
  /** Runs the branches after the answer; shutdown aborts its signal and waits for them. */
  background: Pick<BackgroundTasks, 'run'>;
  /** Counts each call's immediate result, and each branch run; never by title. */
  record?: (result: 'accepted' | 'ineligible') => void;
  recordBranch?: (branch: string) => void;
  now?: () => number;
  /** See {@link RECORD_DELAY_MS} (for tests). */
  recordDelayMs?: number;
}

/** Units the caller's earlier "Get this" calls hold until their branches have been recorded (see #reservedUnits). */
interface Reservation {
  mediaType: MediaType;
  units: number;
  /** Set once the branches were recorded: the units left are those of Seerr requests made as the caller. */
  settledSeq?: number;
}

/** What the branches of one call decided, to be recorded together. */
interface Outcome {
  records: AppRequestRecord[];
  /** Units now counted by Seerr itself (requests made as the caller, or the caller's own request found). */
  requestUnits: number;
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
  /** Grows each time a call's branches are recorded; see #reservedUnits. */
  #seq = 0;
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
   * The immediate part of "Get this": under the caller's lock, decides their eligibility for the media type from their
   * own Seerr permission and quota, and nothing about the title or other households. If eligible, holds the units the
   * call needs and starts the branches in the background; otherwise nothing runs. Either way the caller gets the same
   * answer, so the result is for metrics only. Throws if Seerr fails, and GetThisRefusedError during shutdown.
   */
  public submit(input: GetThisInput): Promise<'accepted' | 'ineligible'> {
    return this.#withLock(this.#userLocks, input.callerId, async () => {
      const units = input.mediaType === 'movie' ? 1 : input.seasons.length;
      if (!await this.#eligible(input.callerId, input.mediaType, units)) {
        this.#record('ineligible');
        return 'ineligible';
      }
      const reservation: Reservation = { mediaType: input.mediaType, units };
      const held = this.#reservations.get(input.callerId) ?? new Set();
      held.add(reservation);
      this.#reservations.set(input.callerId, held);
      const started = this.#background.run((signal) => this.#branches(input, reservation, signal));
      if (!started) {
        this.#settle(input.callerId, reservation, 0);
        throw new GetThisRefusedError();
      }
      this.#record('accepted');
      return 'accepted';
    });
  }

  /**
   * Whether the caller may ask for `units` more of `mediaType`: they have Seerr's request permission for it and, when
   * Seerr gives them a quota, Seerr's own count of their requests plus their virtual requests in the same window plus
   * the units held by their calls still running plus `units` is within the limit (Seerr 3.5.1 `User.getQuota`).
   */
  async #eligible(callerId: string, mediaType: MediaType, units: number): Promise<boolean> {
    const member = this.#members.member(callerId);
    if (!member) return false;
    const startSeq = this.#seq;
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
    const windowStart = this.#now() - (isCount(days) ? days : 0) * DAY_MS;
    const combined = used + this.#virtualUnits(callerId, mediaType, windowStart) + this.#reservedUnits(callerId, mediaType, startSeq);
    return combined + units <= limit;
  }

  /**
   * The caller's virtual requests (join and interest records) for a media type made after `windowStart`, in units,
   * counted as Seerr counts its own: every status except declined, nothing once deleted. Records of a household since
   * deleted still count: they were the caller's.
   */
  #virtualUnits(callerId: string, mediaType: MediaType, windowStart: number): number {
    let units = 0;
    for (const [, record] of this.#store.listAppRequests()) {
      if (record.jellyfinUserId !== callerId || record.mediaType !== mediaType) continue;
      if (record.branch === 'request' || record.status === 'declined' || record.status === 'deleted') continue;
      if (Date.parse(record.createdAt) <= windowStart) continue;
      units += unitsOf(record);
    }
    return units;
  }

  /**
   * Units held by the caller's earlier calls: all of a call's units until its branches are recorded, then only those of
   * the Seerr requests it made as the caller, until a quota read that started after they were made (and so includes
   * them) has been taken. A request made while a quota read was in flight may be counted twice by that one check, never
   * missed: stricter for that moment, never looser.
   */
  #reservedUnits(callerId: string, mediaType: MediaType, startSeq: number): number {
    const held = this.#reservations.get(callerId);
    if (!held) return 0;
    let units = 0;
    for (const reservation of held) {
      if (reservation.settledSeq !== undefined && reservation.settledSeq <= startSeq) {
        held.delete(reservation);
        continue;
      }
      if (reservation.mediaType === mediaType) units += reservation.units;
    }
    if (held.size === 0) this.#reservations.delete(callerId);
    return units;
  }

  /** Records a call's branches as done: keeps only `requestUnits` of its reservation, until Seerr's count has them. */
  #settle(callerId: string, reservation: Reservation, requestUnits: number): void {
    const held = this.#reservations.get(callerId);
    if (requestUnits > 0) {
      reservation.units = requestUnits;
      reservation.settledSeq = ++this.#seq;
      return;
    }
    held?.delete(reservation);
    if (held?.size === 0) this.#reservations.delete(callerId);
  }

  /** The background part of one call, after its answer, in the title's turn. */
  async #branches(input: GetThisInput, reservation: Reservation, signal: AbortSignal): Promise<void> {
    const recordAfter = performance.now() + this.#recordDelayMs;
    // The answer is written before anything about the title is looked up.
    await new Promise((resolve) => setImmediate(resolve));
    await this.#withLock(this.#titleLocks, `${input.mediaType}:${input.tmdbId}`, async () => {
      let outcome: Outcome = { records: [], requestUnits: 0 };
      try {
        outcome = await this.#decide(input, signal);
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
      // Recorded even after shutdown began: a Seerr request already made must keep its attribution record.
      let writing: Promise<unknown> | undefined;
      try {
        writing = outcome.records.length > 0 ? this.#store.writeAppRequests({ add: outcome.records }) : undefined;
      } catch (error) {
        writing = Promise.reject(error);
      }
      this.#settle(input.callerId, reservation, outcome.requestUnits);
      await writing?.catch((error: unknown) => console.error(JSON.stringify({
        level: 'error',
        message: 'household app get this could not be recorded',
        detail: error instanceof Error ? error.message : String(error),
      })));
    });
  }

  /** Decides and runs each branch for the call (see the class comment). Throws if a lookup fails: nothing is recorded. */
  async #decide(input: GetThisInput, signal: AbortSignal): Promise<Outcome> {
    const { mediaType, tmdbId, callerId, householdId } = input;
    const stamp = new Date(this.#now()).toISOString();
    const base = { householdId, jellyfinUserId: callerId, mediaType, tmdbId, createdAt: stamp, updatedAt: stamp };
    const outcome: Outcome = { records: [], requestUnits: 0 };
    checkSignal(signal);
    // The administrators' blocklist is the same for every household; Seerr would refuse the request, so nothing is counted.
    if ((await readBlocklist(this.#seerr)).has(`${mediaType}:${tmdbId}`)) return this.#nothing(outcome, 'refused');
    checkSignal(signal);
    // What the caller can already play, and what their household already asked for, are theirs to know.
    const view = await input.ownView();
    checkSignal(signal);
    const active = this.#askedSeasons(householdId, mediaType, tmdbId);
    const wanted = mediaType === 'movie'
      ? (view.visible || active.has(0) ? [] : [0])
      : input.seasons.filter((season) => !view.seasons.has(season) && !active.has(season));
    if (wanted.length === 0) return this.#nothing(outcome, 'visible');
    const [items, title] = await Promise.all([
      this.#jellyfin.findItemsByTmdbId(mediaType, tmdbId),
      this.#seerr.titleRequests(mediaType, tmdbId),
    ]);
    checkSignal(signal);
    // A title Seerr cannot find on TMDB cannot be requested by anyone.
    if (!title) return this.#nothing(outcome, 'refused');
    const itemIds = hdItems(items, title);
    const present = new Set<number>();
    if (mediaType === 'movie' && itemIds.length > 0) present.add(0);
    if (mediaType === 'tv') {
      for (const itemId of itemIds) for (const season of await this.#jellyfin.seasonsWithEpisodes(itemId)) present.add(season);
      checkSignal(signal);
    }
    const join: number[] = [];
    const interests = new Map<string, number[]>();
    const request: number[] = [];
    for (const season of wanted) {
      if (present.has(season)) {
        join.push(season);
        continue;
      }
      const covering = activeRequest(title, mediaType, season, false);
      if (covering) interests.set(covering.id, [...interests.get(covering.id) ?? [], season]);
      else request.push(season);
    }
    if (join.length > 0) {
      // Jellyfin already has it: never a Seerr request, which would be a late request (see "Late requests").
      const joined = await this.#joins.joinHousehold({ itemIds, userId: callerId, householdId }, { signal });
      this.#recordBranch(`join_${joined}`);
      if (joined === 'joined' || joined === 'already') {
        outcome.records.push({
          ...base,
          seasons: seasonsOf(mediaType, join),
          branch: 'join',
          status: 'completed',
          itemIds,
          ...(title.mediaId !== undefined ? { seerrMediaId: title.mediaId } : {}),
        });
      }
    }
    for (const [requestId, seasons] of interests) {
      const underlying = title.requests.find((entry) => entry.id === requestId) as SeerrTitleRecord['requests'][number];
      outcome.records.push(this.#follow(base, title, underlying, seasons, outcome));
    }
    // From here on, what was done is recorded whatever happens: a join already stored is counted.
    if (request.length > 0 && !signal.aborted) await this.#request(input, base, title, request, outcome);
    else if (request.length > 0) this.#recordBranch('cancelled');
    return outcome;
  }

  /** The request branch: a real HD Seerr request as the caller for `seasons` (`[0]` for a movie). */
  async #request(
    input: GetThisInput,
    base: Omit<AppRequestRecord, 'seasons' | 'branch' | 'status'>,
    title: SeerrTitleRecord,
    seasons: number[],
    outcome: Outcome,
  ): Promise<void> {
    const member = this.#members.member(input.callerId);
    if (!member) return void this.#recordBranch('request_refused');
    let created: unknown;
    try {
      created = await member.createRequest(input.mediaType === 'movie'
        ? { mediaType: 'movie', tmdbId: input.tmdbId }
        : { mediaType: 'tv', tmdbId: input.tmdbId, seasons });
    } catch (error) {
      // Seerr refused it as a duplicate: someone requested it meanwhile, so it is followed instead.
      if (error instanceof SeerrError && error.status === 409) return this.#fallBack(input, base, seasons, outcome);
      // Refused before anything was recorded (permission, quota, blocklist, or the caller was unlinked): not counted.
      this.#recordBranch('request_refused');
      if (!(error instanceof SeerrUnmappedUserError) && !(error instanceof SeerrError && error.status === 403)) {
        console.error(JSON.stringify({
          level: 'error',
          message: 'household app request failed',
          detail: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }
    const requestId = positiveInteger(field(created, 'id'));
    const createdSeasons = new Set(seasonList(field(created, 'seasons')));
    // Seerr answers 202 without a request when every season was requested or available meanwhile, and leaves out
    // any season that was; those are followed instead.
    const covered = requestId === null ? [] : input.mediaType === 'movie' ? seasons : seasons.filter((season) => createdSeasons.has(season));
    if (requestId !== null && covered.length > 0) {
      this.#recordBranch('request');
      const mediaId = positiveInteger(field(field(created, 'media'), 'id')) ?? title.mediaId;
      outcome.records.push({
        ...base,
        seasons: seasonsOf(input.mediaType, covered),
        branch: 'request',
        status: 'pending',
        seerrRequestId: String(requestId),
        ...(mediaId !== undefined && mediaId !== null ? { seerrMediaId: mediaId } : {}),
      });
      outcome.requestUnits += covered.length;
    }
    const rest = seasons.filter((season) => !covered.includes(season));
    if (rest.length > 0) await this.#fallBack(input, base, rest, outcome);
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
      outcome.records.push(this.#follow(base, title as SeerrTitleRecord, underlying, covered, outcome));
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
    outcome: Outcome,
  ): AppRequestRecord {
    const own = underlying.requesterJellyfinId === base.jellyfinUserId;
    this.#recordBranch(own ? 'own_request' : 'interest');
    if (own) outcome.requestUnits += seasons.length;
    return {
      ...base,
      seasons: seasonsOf(base.mediaType, seasons),
      branch: own ? 'request' : 'interest',
      status: underlying.status === FAILED ? 'failed' : 'pending',
      seerrRequestId: underlying.id,
      ...(title.mediaId !== undefined ? { seerrMediaId: title.mediaId } : {}),
    };
  }

  #nothing(outcome: Outcome, branch: string): Outcome {
    this.#recordBranch(branch);
    return outcome;
  }

  /**
   * The seasons (`0` for a movie) this household already asked for and is still waiting on: an active record, or a
   * failed one (Seerr refuses a new request while a failed one stands, and counts none).
   */
  #askedSeasons(householdId: string, mediaType: MediaType, tmdbId: number): Set<number> {
    const seasons = new Set<number>();
    for (const [, record] of this.#store.listAppRequests()) {
      if (record.householdId !== householdId || record.mediaType !== mediaType || record.tmdbId !== tmdbId) continue;
      if (!isActive(record) && !(record.status === 'failed' && !record.detached)) continue;
      for (const season of mediaType === 'movie' ? [0] : record.seasons) seasons.add(season);
    }
    return seasons;
  }

  /**
   * The titles (`movie:<id>`, `tv:<id>`) and seasons (`tv:<id>:<n>`) this household has an active record for: its
   * own records only, never derived from membership or from Seerr. The household app's only source of `requested`.
   */
  public activeKeys(householdId: string): Set<string> {
    const keys = new Set<string>();
    for (const [, record] of this.#store.listAppRequests()) {
      if (!isActive(record) || record.householdId !== householdId) continue;
      keys.add(`${record.mediaType}:${record.tmdbId}`);
      for (const season of record.seasons) keys.add(`tv:${record.tmdbId}:${season}`);
    }
    return keys;
  }

  /**
   * This household's titles with their coarse status, from its own records only: no Seerr ID, no requester beyond
   * whether it was the caller, no count but the entries listed. A title's latest record decides each season (or the
   * movie); a series is `requested` while any season is, otherwise `ready` if any season is. Records whose request or
   * media Seerr deleted are not listed, as Seerr no longer lists such a request either.
   */
  public list(householdId: string, callerId: string): RequestsDto {
    const titles = new Map<string, { mediaType: MediaType; tmdbId: number; latest: string; byYou: boolean; seasons: Map<number, CoarseStatus> }>();
    const records = this.#store.listAppRequests().map(([, record]) => record)
      .filter((record) => record.householdId === householdId && !record.detached && record.status !== 'deleted')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const record of records) {
      const key = `${record.mediaType}:${record.tmdbId}`;
      const entry = titles.get(key) ?? { mediaType: record.mediaType, tmdbId: record.tmdbId, latest: record.createdAt, byYou: false, seasons: new Map() };
      entry.latest = record.createdAt;
      entry.byYou ||= record.jellyfinUserId === callerId;
      for (const season of record.mediaType === 'movie' ? [0] : record.seasons) entry.seasons.set(season, coarse(record.status));
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
   * Brings records up to date with Seerr, as the member's own request would be (docs/app-design.md, "Quota before
   * branching"): a request or interest follows its Seerr request (pending or approved, declined, failed, or completed
   * for a request made as the caller); a request Seerr deleted is `deleted` if the title's media record went with it,
   * and otherwise frees nothing for an interest (`failed`, the caller's own request would not have been deleted); an
   * interest whose request completed, or that follows none, joins the title's grant once Jellyfin has it; and a join
   * is `deleted` once the title's Seerr media record is. Reads at most {@link MAX_REFRESH_READS} records a run, those
   * read longest ago first, each at most every {@link REFRESH_REQUEST_EVERY_MS} (a join's media every
   * {@link REFRESH_MEDIA_EVERY_MS}). Run by the scheduled reconciliation; an aborted `signal` stops it before its next read.
   */
  public async refresh(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    const now = this.#now();
    const due = this.#store.listAppRequests().filter(([id, record]) => {
      if (record.status === 'declined' || record.status === 'deleted' || record.status === 'completed' && record.branch !== 'join') return false;
      if (record.branch === 'join' && record.seerrMediaId === undefined) return false;
      if (record.status === 'failed' && !record.seerrRequestId) return false;
      return now - (this.#checkedAt.get(id) ?? 0) >= (record.branch === 'join' ? REFRESH_MEDIA_EVERY_MS : REFRESH_REQUEST_EVERY_MS);
    }).sort(([left], [right]) => (this.#checkedAt.get(left) ?? 0) - (this.#checkedAt.get(right) ?? 0)).slice(0, MAX_REFRESH_READS);
    const known = new Set(this.#store.listAppRequests().map(([id]) => id));
    for (const id of [...this.#checkedAt.keys()]) if (!known.has(id)) this.#checkedAt.delete(id);
    for (const [id, record] of due) {
      if (signal?.aborted) return;
      this.#checkedAt.set(id, this.#now());
      try {
        const status = await this.#current(record, signal);
        if (signal?.aborted) return;
        if (status && status.status !== record.status) await this.#store.writeAppRequests({ update: [{ id, ...status }] });
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
  async #current(record: AppRequestRecord, signal?: AbortSignal): Promise<{ status: AppRequestStatus; itemIds?: string[] } | undefined> {
    if (record.branch === 'join') return await this.#mediaGone(record) ? { status: 'deleted' } : undefined;
    if (!record.seerrRequestId) return record.branch === 'interest' ? this.#joinInterest(record, signal) : undefined;
    const state = await this.#seerr.requestState(record.seerrRequestId);
    if (!state) {
      if (await this.#mediaGone(record)) return { status: 'deleted' };
      return { status: record.branch === 'interest' ? 'failed' : 'deleted' };
    }
    if (ACTIVE_REQUEST_STATUSES.has(state.status)) return { status: 'pending' };
    if (state.status === DECLINED) return { status: 'declined' };
    if (state.status === FAILED) return { status: 'failed' };
    if (state.status === COMPLETED) return record.branch === 'request' ? { status: 'completed' } : this.#joinInterest(record, signal);
    return undefined;
  }

  /** An interest whose request completed (or that follows none): the household joins the title's grant, if Jellyfin has it. */
  async #joinInterest(record: AppRequestRecord, signal?: AbortSignal): Promise<{ status: AppRequestStatus; itemIds?: string[] } | undefined> {
    if (record.detached) return undefined;
    const [items, title] = await Promise.all([
      this.#jellyfin.findItemsByTmdbId(record.mediaType, record.tmdbId),
      this.#seerr.titleRequests(record.mediaType, record.tmdbId),
    ]);
    const itemIds = title ? hdItems(items, title) : items;
    if (itemIds.length === 0) return undefined;
    const joined = await this.#joins.joinHousehold({ itemIds, userId: record.jellyfinUserId, householdId: record.householdId }, signal ? { signal } : {});
    if (joined === 'joined' || joined === 'already') return { status: 'completed', itemIds };
    // A grant not created yet (Jellyfin has the title before Seerr's webhook) is tried again on the next run.
    return joined === 'refused' && record.status === 'pending' && record.seerrRequestId ? { status: 'failed', itemIds } : undefined;
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
 * The HD items among Jellyfin's items for a title: never the item Seerr links as the 4K one, and only Seerr's HD item
 * when it is among them. An item Seerr does not link is taken as HD, so a title Jellyfin has is never requested again.
 */
function hdItems(items: string[], title: SeerrTitleRecord): string[] {
  const hd = items.filter((itemId) => itemId !== title.jellyfinMediaId4k);
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
