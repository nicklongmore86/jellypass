import { ConflictError, type AccessService } from './access-service.js';
import type { JellyfinClient } from './jellyfin.js';
import type { HouseholdRequests } from './household-requests.js';
import { AttemptCounter } from './rate-limit.js';
import { SeerrError, type SeerrClient, type SeerrTitleRecord } from './seerr.js';
import { normalizeId, type GrantStore } from './store.js';
import type { AppRequestRecord } from './types.js';

/** Administrator actions allowed in each window of {@link ADMIN_ACTION_WINDOW_MS}, all administrators together. */
export const MAX_ADMIN_ACTIONS = 60;
export const ADMIN_ACTION_WINDOW_MS = 60 * 1000;
/** Most Seerr title reads one listing makes (titles with a waiting request first); the rest are listed unnamed. */
export const MAX_LISTING_TITLE_READS = 100;
/** Settled records (`deleted`, `withdrawn`) are listed for this long after they last changed. */
export const SETTLED_LISTING_MS = 30 * 24 * 60 * 60 * 1000;
const TITLE_READS_AT_ONCE = 4;
const NAME_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_NAMES = 2000;

const PENDING = 1;
const APPROVED = 2;
const DECLINED = 3;
const FAILED = 4;
const SEERR_STATUS: Record<number, AdminSeerrStatus> = { [PENDING]: 'pending', [APPROVED]: 'approved', [DECLINED]: 'declined', [FAILED]: 'failed', 5: 'completed' };

type MediaType = 'movie' | 'tv';
/** A Seerr request's status as the tab shows it: `gone` when Seerr no longer has it, `unknown` when it could not be read. */
export type AdminSeerrStatus = 'pending' | 'approved' | 'declined' | 'failed' | 'completed' | 'gone' | 'unknown';
/** What a row's lead record says: the household's status (`cancelled`: its member withdrew it). */
export type AdminRowStatus = 'requested' | 'ready' | 'failed' | 'declined' | 'deleted' | 'cancelled';

/** One row of `GET /v1/app/requests`: a Seerr request and the households following it, or a record with no request. */
export interface AdminRequestRow {
  /** The Seerr request, or null for a record that follows none (a join, an interest that found none). */
  requestId: string | null;
  mediaType: MediaType;
  tmdbId: number;
  /** TMDB's name for the title (from Seerr), or null when it could not be read. */
  title: string | null;
  year?: number;
  /** The seasons asked for (the union of the records'), ascending; empty for a movie. */
  seasons: number[];
  status: AdminRowStatus;
  seerrStatus: AdminSeerrStatus | null;
  /** The member who asked (the request record's, else the earliest record's), by Jellyfin ID and name. */
  requester: { id: string; name: string };
  householdId: string;
  householdName: string;
  /** The UTC day (`YYYY-MM-DD`) of the earliest record: when it was first asked for. */
  requestedOn: string;
  /** Households other than the requester's whose record still follows the request (pending). */
  followers: number;
  households: Array<{ id: string; name: string; status: AdminRowStatus }>;
  /** A household app cancel (or an administrator's) withdrew it, and its withdrawal still decides its grant. */
  withdrawn: boolean;
  /** Its grant is held for no household (see AccessService.appHeld). */
  held: boolean;
  actions: { approve: boolean; decline: boolean; cancel: boolean; removeFromRadarr: boolean };
}

export interface AdminHeldTitle {
  requestId: string;
  itemId: string;
  mediaType: MediaType;
  tmdbId: number;
  title: string | null;
  year?: number;
  cancelledAt: string;
  grantedAt?: string;
}

export interface AdminRequestsListing {
  /** Whether Seerr has an HD Radarr server: without one, "Also remove from Radarr" is never offered. */
  radarr: boolean;
  requests: AdminRequestRow[];
  held: AdminHeldTitle[];
}

export interface AdminRequestsOptions {
  store: Pick<GrantStore,
    | 'listAppRequests' | 'getGroup' | 'hasHandledRequest' | 'listAppWithdrawals' | 'writeAppRequests' | 'findGrantForRequest'>;
  seerr: Pick<SeerrClient, 'titleRequests' | 'requestState' | 'approveRequest' | 'declineRequest' | 'deleteRequest' | 'removeMovieFromRadarr' | 'radarrConfigured'>;
  jellyfin: Pick<JellyfinClient, 'findItemsByTmdbId' | 'existingItems' | 'getUsers'>;
  service: Pick<AccessService, 'serialized' | 'appHeld' | 'setGrantGroups'>;
  /** The per-title turn "Get this" and cancels take (HouseholdRequests.inTitleTurn). */
  requests: Pick<HouseholdRequests, 'inTitleTurn'>;
  now?: () => number;
}

/** Answered 404 by the server. */
export class AdminRequestNotFoundError extends Error {
  public constructor(what: string) {
    super(`${what} not found`);
    this.name = 'AdminRequestNotFoundError';
  }
}

/** Answered 429 by the server. */
export class AdminActionLimitError extends Error {
  public constructor() {
    super('too_many_requests');
    this.name = 'AdminActionLimitError';
  }
}

/** A Seerr call an action needed failed; answered 502 with a fixed message (the detail is only logged). */
export class AdminSeerrError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AdminSeerrError';
  }
}

/**
 * The administrators' Requests tab (docs/app-design.md, "Administrators' Requests tab"): every household's "Get this"
 * records by Seerr request, and the actions on them, with the admin key. Each action runs in the title's turn (the one
 * "Get this" and cancels take) and writes in AccessService's write queue, so it never races a follower being recorded,
 * a webhook, the backfill or a refresh. Every action is idempotent: repeating one that took effect answers the same
 * outcome and changes nothing more.
 *
 * - approve: a pending request is approved in Seerr. The households keep following it.
 * - decline: a pending request is declined in Seerr, and every record following it is `declined` at once: each
 *   household sees "We couldn't get this".
 * - cancel: every household following the request is sent back to Get this (its records `deleted`), and, in the same
 *   write and before Seerr is asked to forget it, a withdrawal for the request with `requester` (and, for a request
 *   whose title Jellyfin does not have, `requesterId`) is written; then, optionally, the movie is removed from Radarr;
 *   then the request is deleted in Seerr and its withdrawal becomes a title hold. Whatever then arrives is held for no
 *   household, never public.
 * - release: a held title is given to chosen households.
 */
export class AdminRequests {
  readonly #store: AdminRequestsOptions['store'];
  readonly #seerr: AdminRequestsOptions['seerr'];
  readonly #jellyfin: AdminRequestsOptions['jellyfin'];
  readonly #service: AdminRequestsOptions['service'];
  readonly #requests: AdminRequestsOptions['requests'];
  readonly #now: () => number;
  readonly #names = new Map<string, { title: string | null; year?: number; at: number }>();
  readonly #actions: AttemptCounter;

  public constructor(options: AdminRequestsOptions) {
    this.#store = options.store;
    this.#seerr = options.seerr;
    this.#jellyfin = options.jellyfin;
    this.#service = options.service;
    this.#requests = options.requests;
    this.#now = options.now ?? Date.now;
    this.#actions = new AttemptCounter({ windowMs: ADMIN_ACTION_WINDOW_MS, maxKeys: 1, now: this.#now });
  }

  /**
   * Every household's requests, newest first: each Seerr request with the households following it, and each record
   * that follows none; settled ones (deleted, cancelled) only for {@link SETTLED_LISTING_MS}. Seerr is read once per
   * title (the request statuses and the name), at most {@link MAX_LISTING_TITLE_READS} titles a listing.
   */
  public async list(): Promise<AdminRequestsListing> {
    const now = this.#now();
    const records = this.#store.listAppRequests().map(([, record]) => record).filter((record) => !record.detached
      && (record.status !== 'deleted' || now - Date.parse(record.updatedAt) <= SETTLED_LISTING_MS));
    const groups = new Map<string, AppRequestRecord[]>();
    for (const record of records) {
      const key = record.seerrRequestId ?? `${record.householdId}:${record.mediaType}:${record.tmdbId}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    const waiting = new Set([...groups.values()].flatMap((group) => group.some((record) => record.status === 'pending')
      ? [`${group[0]!.mediaType}:${group[0]!.tmdbId}`] : []));
    const held = this.#service.appHeld().titles;
    const titleKeys = [...new Set([...records.map((record) => `${record.mediaType}:${record.tmdbId}`), ...held.map((entry) => `${entry.mediaType}:${entry.tmdbId}`)])];
    // Titles with a waiting request are read for their requests' statuses; the others only for a name not known yet.
    const toRead = [
      ...titleKeys.filter((key) => waiting.has(key)),
      ...titleKeys.filter((key) => !waiting.has(key) && !this.#freshName(key, now)),
    ].slice(0, MAX_LISTING_TITLE_READS);
    const titles = new Map<string, SeerrTitleRecord | undefined>();
    for (let index = 0; index < toRead.length; index += TITLE_READS_AT_ONCE) {
      await Promise.all(toRead.slice(index, index + TITLE_READS_AT_ONCE).map(async (key) => {
        const [mediaType, tmdbId] = splitKey(key);
        try {
          const title = await this.#seerr.titleRequests(mediaType, tmdbId);
          titles.set(key, title);
          this.#remember(key, title, now);
        } catch (error) {
          logError('admin requests: a title could not be read from Seerr', error);
        }
      }));
    }
    const [radarr, users] = await Promise.all([
      this.#seerr.radarrConfigured().catch((error: unknown) => { logError('admin requests: Seerr\'s Radarr settings could not be read', error); return false; }),
      this.#jellyfin.getUsers().then((list) => new Map(list.map((user) => [normalizeId(user.Id), user.Name]))).catch(() => new Map<string, string>()),
    ]);
    const handledHeld = new Set(held.map((entry) => entry.requestId));
    const withdrawals = new Set(this.#store.listAppWithdrawals().map(([requestId]) => requestId));
    const rows: Array<AdminRequestRow & { latest: string }> = [];
    for (const group of groups.values()) {
      const sorted = [...group].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const lead = sorted.find((record) => record.branch === 'request') ?? sorted[0]!;
      const key = `${lead.mediaType}:${lead.tmdbId}`;
      const title = titles.get(key);
      const requestId = lead.seerrRequestId ?? null;
      const seerrStatus: AdminSeerrStatus | null = requestId === null ? null : !titles.has(key) ? 'unknown'
        : seerrStatusOf(title?.requests.find((request) => request.id === requestId)?.status);
      const name = this.#names.get(key);
      const households = new Map<string, AdminRowStatus>();
      for (const record of sorted) households.set(record.householdId, rowStatus(record));
      const handled = requestId !== null && this.#store.hasHandledRequest(requestId);
      const cancel = requestId !== null && !handled && (seerrStatus === 'pending' || seerrStatus === 'approved' || seerrStatus === 'failed');
      const removeFromRadarr = cancel && radarr && lead.mediaType === 'movie' && title !== undefined && await this.#movieAbsent(lead.tmdbId, title);
      rows.push({
        requestId,
        mediaType: lead.mediaType,
        tmdbId: lead.tmdbId,
        title: name?.title ?? null,
        ...(name?.year !== undefined ? { year: name.year } : {}),
        seasons: lead.mediaType === 'movie' ? [] : [...new Set(sorted.flatMap((record) => record.seasons))].sort((left, right) => left - right),
        status: rowStatus(lead),
        seerrStatus,
        requester: { id: lead.jellyfinUserId, name: users.get(lead.jellyfinUserId) ?? 'Unknown user' },
        householdId: lead.householdId,
        householdName: this.#store.getGroup(lead.householdId)?.name ?? lead.householdId,
        requestedOn: sorted[0]!.createdAt.slice(0, 10),
        followers: [...new Set(sorted.filter((record) => record.householdId !== lead.householdId && record.status === 'pending' && !record.withdrawn)
          .map((record) => record.householdId))].length,
        households: [...households].map(([id, status]) => ({ id, name: this.#store.getGroup(id)?.name ?? id, status })),
        withdrawn: requestId !== null && withdrawals.has(requestId),
        held: requestId !== null && handledHeld.has(requestId),
        actions: { approve: seerrStatus === 'pending', decline: seerrStatus === 'pending', cancel, removeFromRadarr },
        latest: sorted.at(-1)!.createdAt,
      });
    }
    rows.sort((left, right) => right.latest.localeCompare(left.latest) || left.tmdbId - right.tmdbId);
    return {
      radarr,
      requests: rows.map(({ latest: _, ...row }) => row),
      held: held.map((entry) => {
        const name = this.#names.get(`${entry.mediaType}:${entry.tmdbId}`);
        return {
          requestId: entry.requestId,
          itemId: entry.itemId,
          mediaType: entry.mediaType as MediaType,
          tmdbId: entry.tmdbId,
          title: name?.title ?? null,
          ...(name?.year !== undefined ? { year: name.year } : {}),
          cancelledAt: entry.cancelledAt,
          ...(entry.grantedAt ? { grantedAt: entry.grantedAt } : {}),
        };
      }),
    };
  }

  /** Approves a pending request in Seerr. Approved (or further) already: nothing to do. */
  public async approve(requestId: string): Promise<{ status: 'approved'; changed: boolean }> {
    const title = this.#titleOf(requestId);
    this.#count();
    return this.#requests.inTitleTurn(title.mediaType, title.tmdbId, async () => {
      const state = await this.#state(requestId);
      if (state.status === PENDING) {
        try {
          await this.#seerr.approveRequest(requestId);
        } catch (error) {
          // Seerr refuses a request that is no longer pending: approved meanwhile is the same outcome.
          if ((await this.#state(requestId)).status !== APPROVED) throw seerrFailure('Seerr could not approve the request', error);
          return { status: 'approved', changed: false };
        }
        log('admin approved a request', requestId);
        return { status: 'approved', changed: true };
      }
      if (state.status === DECLINED) throw new ConflictError('the request was declined', 'request_declined');
      return { status: 'approved', changed: false };
    });
  }

  /**
   * Declines a pending request in Seerr, then marks every record following it `declined` at once (the refresh would in
   * time): each household sees "We couldn't get this". Declined already: the records are brought up to date.
   */
  public async decline(requestId: string): Promise<{ status: 'declined'; changed: boolean }> {
    const title = this.#titleOf(requestId);
    this.#count();
    return this.#requests.inTitleTurn(title.mediaType, title.tmdbId, async () => {
      const state = await this.#state(requestId);
      let changed = false;
      if (state.status === PENDING) {
        try {
          await this.#seerr.declineRequest(requestId);
          changed = true;
        } catch (error) {
          if ((await this.#state(requestId)).status !== DECLINED) throw seerrFailure('Seerr could not decline the request', error);
        }
      } else if (state.status !== DECLINED) throw new ConflictError('only a pending request can be declined', 'request_not_pending');
      await this.#service.serialized(async () => {
        const update = this.#following(requestId).map(([id]) => ({ id, status: 'declined' as const }));
        if (update.length > 0) await this.#store.writeAppRequests({ update });
      });
      if (changed) log('admin declined a request', requestId);
      return { status: 'declined', changed };
    });
  }

  /**
   * Cancels a request for every household (see the class): their records are `deleted` (back to Get this), and a
   * withdrawal is written before Seerr is asked anything, so a grant decided after it gives nobody access, whether the
   * delete then succeeds or not. `removeFromRadarr` (movies only, and only while Jellyfin does not have the movie, and
   * only when Seerr has a Radarr server) has Seerr remove the movie from Radarr before the request is deleted. Refused
   * once the request was granted (the title arrived: revoke access instead) or for a declined or completed request.
   */
  public async cancel(requestId: string, options: { removeFromRadarr?: boolean } = {}): Promise<{ status: 'cancelled'; changed: boolean; titleHold: boolean; removedFromRadarr: boolean }> {
    const title = this.#titleOf(requestId);
    this.#count();
    return this.#requests.inTitleTurn(title.mediaType, title.tmdbId, async () => {
      if (this.#store.hasHandledRequest(requestId)) throw new ConflictError('the request was granted already; revoke its access instead', 'request_granted');
      const state = await this.#seerr.requestState(requestId).catch((error: unknown) => { throw seerrFailure('Seerr could not be read', error); });
      if (!state) {
        // Gone already (cancelled before, or deleted in Seerr): every household is back to Get this.
        const changed = await this.#withdrawAll(requestId, title, undefined, true);
        return { status: 'cancelled', changed, titleHold: this.#isTitleHold(requestId), removedFromRadarr: false };
      }
      if (state.status !== PENDING && state.status !== APPROVED && state.status !== FAILED) {
        throw new ConflictError('only a pending, approved or failed request can be cancelled', 'request_not_cancellable');
      }
      const seerrTitle = await this.#seerr.titleRequests(title.mediaType, title.tmdbId).catch((error: unknown) => { throw seerrFailure('Seerr could not be read', error); });
      if (!seerrTitle) throw new AdminSeerrError('Seerr could not be read');
      const present = (await this.#heldItems(title.mediaType, title.tmdbId, seerrTitle)).length > 0;
      if (options.removeFromRadarr) {
        if (title.mediaType !== 'movie' || present || state.mediaId === undefined || !await this.#seerr.radarrConfigured().catch(() => false)) {
          throw new ConflictError('removing from Radarr is offered only for a movie Jellyfin does not have, with Radarr set up in Seerr', 'radarr_removal_not_offered');
        }
      }
      // The requester whom a title hold records: only for a genuine request (no join rule) whose title Jellyfin does
      // not have now, so that anything of it that appears later is its arrival.
      const records = this.#naming(requestId);
      const asked = records.find(([, record]) => record.branch === 'request')?.[1].jellyfinUserId
        ?? seerrTitle.requests.find((request) => request.id === requestId)?.requesterJellyfinId;
      const genuine = !present && !records.some(([, record]) => record.joinOnGrant !== undefined);
      const requesterId = genuine && asked ? normalizeId(asked) : undefined;
      await this.#withdrawAll(requestId, title, requesterId, false);
      let removedFromRadarr = false;
      if (options.removeFromRadarr) {
        try {
          await this.#seerr.removeMovieFromRadarr(state.mediaId as number);
          removedFromRadarr = true;
        } catch (error) {
          throw seerrFailure('Seerr could not remove the movie from Radarr; the request is kept, and anything that arrives is held for no household', error);
        }
      }
      try {
        await this.#seerr.deleteRequest(requestId);
      } catch (error) {
        throw seerrFailure('Seerr could not delete the request; anything that arrives is held for no household', error);
      }
      await this.#service.serialized(() => this.#store.writeAppRequests({ requestsGone: [requestId] }));
      const titleHold = this.#isTitleHold(requestId);
      console.log(JSON.stringify({ level: 'info', message: 'admin cancelled a request', requestId, removedFromRadarr, titleHold }));
      return { status: 'cancelled', changed: true, titleHold, removedFromRadarr };
    });
  }

  /**
   * Gives a held title (see AccessService.appHeld) to `householdIds`, added to any household its grant already has. A
   * title no longer held whose grant already has every one of them answers as released (unchanged).
   */
  public async release(requestId: string, householdIds: string[]): Promise<{ status: 'released'; changed: boolean; itemId: string }> {
    const wanted = [...new Set(householdIds.map(normalizeId))];
    if (wanted.length === 0) throw new Error('householdIds must contain at least one household');
    for (const id of wanted) if (!this.#store.getGroup(id)) throw new AdminRequestNotFoundError('household');
    this.#count();
    const grant = this.#store.findGrantForRequest(requestId);
    if (!grant?.active) throw new AdminRequestNotFoundError('held title');
    const held = this.#service.appHeld().titles.some((entry) => entry.requestId === requestId);
    if (!held) {
      if (wanted.every((id) => grant.groupIds.includes(id))) return { status: 'released', changed: false, itemId: grant.itemId };
      throw new ConflictError('the title is no longer held; change its access in Grants', 'title_not_held');
    }
    await this.#service.setGrantGroups(grant.itemId, [...new Set([...grant.groupIds, ...wanted])]);
    console.log(JSON.stringify({ level: 'info', message: 'admin released a held title', requestId, itemId: grant.itemId, households: wanted.length }));
    return { status: 'released', changed: true, itemId: grant.itemId };
  }

  /**
   * Sends every household following the request back to Get this, with a withdrawal for the request (all of them,
   * `requester`), in one write in the write queue. Resolves whether anything changed. Refused if a grant was decided
   * for the request meanwhile. `gone`: Seerr no longer has it, so it is treated as found gone by the refresh.
   */
  async #withdrawAll(requestId: string, title: { mediaType: MediaType; tmdbId: number }, requesterId: string | undefined, gone: boolean): Promise<boolean> {
    return this.#service.serialized(async () => {
      if (this.#store.hasHandledRequest(requestId)) throw new ConflictError('the request was granted already; revoke its access instead', 'request_granted');
      const following = this.#following(requestId);
      const households = [...new Set(this.#naming(requestId).map(([, record]) => record.householdId))];
      const known = this.#store.listAppWithdrawals().some(([id]) => id === requestId);
      if (gone && following.length === 0) {
        if (known) await this.#store.writeAppRequests({ requestsGone: [requestId] });
        return false;
      }
      await this.#store.writeAppRequests({
        update: following.map(([id]) => ({ id, status: 'deleted' as const })),
        ...(gone ? { requestsGone: [requestId] } : {
          withdraw: households.map((householdId) => ({
            requestId,
            mediaType: title.mediaType,
            tmdbId: title.tmdbId,
            householdId,
            requester: true,
            ...(requesterId ? { requesterId } : {}),
          })),
        }),
      });
      return following.length > 0 || !known;
    });
  }

  /** The records naming the request, not detached. */
  #naming(requestId: string): Array<[string, AppRequestRecord]> {
    return this.#store.listAppRequests().filter(([, record]) => !record.detached && record.seerrRequestId === requestId);
  }

  /** The records naming the request that still follow it (pending, not withdrawn). */
  #following(requestId: string): Array<[string, AppRequestRecord]> {
    return this.#naming(requestId).filter(([, record]) => record.status === 'pending' && !record.withdrawn);
  }

  /** The title of a request some household's record names; 404 for any other. */
  #titleOf(requestId: string): { mediaType: MediaType; tmdbId: number } {
    if (!/^[1-9][0-9]{0,15}$/.test(requestId)) throw new Error('requestId is invalid');
    const record = this.#naming(requestId)[0]?.[1];
    if (!record) throw new AdminRequestNotFoundError('request');
    return { mediaType: record.mediaType, tmdbId: record.tmdbId };
  }

  async #state(requestId: string): Promise<{ status: number; mediaId?: number }> {
    let state: { status: number; mediaId?: number } | undefined;
    try {
      state = await this.#seerr.requestState(requestId);
    } catch (error) {
      throw seerrFailure('Seerr could not be read', error);
    }
    if (!state) throw new ConflictError('Seerr no longer has the request', 'request_gone');
    return state;
  }

  #isTitleHold(requestId: string): boolean {
    return this.#store.listAppWithdrawals().some(([id, withdrawal]) => id === requestId && withdrawal.seerrGoneAt !== undefined && withdrawal.requesterId !== undefined);
  }

  #count(): void {
    if (this.#actions.increment('admin') > MAX_ADMIN_ACTIONS) throw new AdminActionLimitError();
  }

  /** Whether Jellyfin has no HD item of the movie (by TMDB ID or Seerr's HD link); unreadable counts as having one. */
  async #movieAbsent(tmdbId: number, title: SeerrTitleRecord): Promise<boolean> {
    try {
      return (await this.#heldItems('movie', tmdbId, title)).length === 0;
    } catch {
      return false;
    }
  }

  /** The HD items Jellyfin has of a title, by TMDB ID and Seerr's HD link (as AccessService's title holds read them). */
  async #heldItems(mediaType: MediaType, tmdbId: number, title: SeerrTitleRecord): Promise<string[]> {
    const hd = title.jellyfinMediaId ? normalizeId(title.jellyfinMediaId) : undefined;
    const [byTmdb, linked] = await Promise.all([
      this.#jellyfin.findItemsByTmdbId(mediaType, tmdbId),
      hd ? this.#jellyfin.existingItems(mediaType, [hd]) : Promise.resolve([]),
    ]);
    const fourK = title.jellyfinMediaId4k ? normalizeId(title.jellyfinMediaId4k) : undefined;
    return [...new Set([...byTmdb, ...linked].map(normalizeId))].filter((itemId) => itemId !== fourK || itemId === hd);
  }

  #freshName(key: string, now: number): boolean {
    const name = this.#names.get(key);
    return name !== undefined && now - name.at < NAME_TTL_MS;
  }

  #remember(key: string, title: SeerrTitleRecord | undefined, now: number): void {
    this.#names.delete(key);
    this.#names.set(key, { title: title?.names[0] ?? null, ...(title?.year !== undefined ? { year: title.year } : {}), at: now });
    while (this.#names.size > MAX_NAMES) this.#names.delete(this.#names.keys().next().value as string);
  }
}

function splitKey(key: string): [MediaType, number] {
  const [mediaType, tmdbId] = key.split(':');
  return [mediaType as MediaType, Number(tmdbId)];
}

function seerrStatusOf(status: number | undefined): AdminSeerrStatus {
  return status === undefined ? 'gone' : SEERR_STATUS[status] ?? 'unknown';
}

function rowStatus(record: AppRequestRecord): AdminRowStatus {
  if (record.withdrawn) return 'cancelled';
  return record.status === 'pending' ? 'requested' : record.status === 'completed' ? 'ready' : record.status;
}

function seerrFailure(message: string, error: unknown): AdminSeerrError {
  logError(message, error);
  return new AdminSeerrError(message);
}

/** Logs a request ID and the action, never a title, member or credential. */
function log(message: string, requestId: string): void {
  console.log(JSON.stringify({ level: 'info', message, requestId }));
}

function logError(message: string, error: unknown): void {
  console.error(JSON.stringify({
    level: 'error',
    message,
    // SeerrError messages carry only the route template and status (see guardedSeerrJson).
    detail: error instanceof SeerrError || error instanceof TypeError ? error.message : error instanceof Error ? error.name : String(error),
  }));
}
