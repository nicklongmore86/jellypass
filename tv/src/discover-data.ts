import {
  type DiscoverList,
  type DiscoverPage,
  type DiscoverSources,
  type Failure,
  type NetworkList,
  DISCOVER_LISTS,
  discoverList,
  discoverSources,
  networkList,
  studioList,
  validId,
  validPage,
} from './api.js';
import type { SessionWatch, Stamp } from './session-watch.js';

/** How long an answer is reused, in memory: the server keeps each for as long per household, and the titles' names (#89) the same. */
export const DISCOVER_CACHE_TTL_MS = 10 * 60 * 1000;
/** At most this many addresses are kept (a full page is 15, a few services' and studios' pages more); the least recently used goes first. */
export const DISCOVER_CACHE_SIZE = 60;
/** How long a failure is remembered, so a page drawn again at once does not ask again (a member's "Try again" passes `retry`). */
export const DISCOVER_FAILURE_MS = 30_000;
/** How long to wait after a `429` that did not say (the Search row's). */
export const DISCOVER_BACKOFF_MS = 30_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** What can be asked for: the address is the cache key, so the first page of a list is the same entry wherever it is asked for. */
export type DiscoverRequest =
  | { kind: 'list'; list: DiscoverList; page?: number }
  | { kind: 'sources' }
  | { kind: 'network'; id: number; list: NetworkList; page?: number }
  | { kind: 'studio'; id: number; page?: number };
type ValueOf<R extends DiscoverRequest> = R extends { kind: 'sources' } ? DiscoverSources : DiscoverPage;

/** An answer that belongs to a session that is gone (signed out, another member, a new token): nothing is stored or shown for it. */
export interface Stale {
  ok: false;
  stale: true;
}
export type DiscoverResult<R extends DiscoverRequest> = { ok: true; value: ValueOf<R> } | Failure | Stale;

/** The cache key of a request: its address under `/jellypass/app/v1`, as the budget file writes it (sorted query and all). */
export function discoverKey(request: DiscoverRequest): string {
  const page = 'page' in request && request.page !== undefined && request.page > 1 ? `?page=${request.page}` : '';
  switch (request.kind) {
    case 'list': return `/discover/${request.list}${page}`;
    case 'sources': return '/discover/sources';
    case 'network': return `/discover/network/${request.id}${request.list === 'series' ? '' : `/${request.list}`}${page}`;
    default: return `/discover/studio/${request.id}${page}`;
  }
}

/** Whether the readers would send `request`: checked before the cache or a call in flight is looked at, so an address they would refuse never shares an entry (or a call) with a valid one. */
function valid(request: DiscoverRequest): boolean {
  switch (request.kind) {
    case 'list': return DISCOVER_LISTS.indexOf(request.list) >= 0 && (request.page === undefined || validPage(request.page));
    case 'sources': return true;
    case 'network': return validId(request.id) && (request.list === 'series' || request.list === 'films' || request.list === 'all') && (request.page === undefined || validPage(request.page));
    case 'studio': return validId(request.id) && (request.page === undefined || validPage(request.page));
    default: return false;
  }
}

interface Kept {
  /** The parsed answer, or the failure it was. */
  result: { ok: true; value: unknown } | Failure;
  mono: number;
  wall: number;
}

/**
 * The Discover page's data: the readers of api.ts behind an answer cache that lives and dies with the sign-in.
 *
 * - **Per session.** Answers are kept for the member signed in, by their token and the {@link SessionWatch} generation (the
 *   same check as the rest of the add-on). A sign-out, another member or a new token empties the cache and forgets the
 *   calls in flight at the next use, and an answer that comes back for an old session is dropped whole (`Stale`): not
 *   stored, not shown, its `401` or `429` not acted on.
 * - **In memory only.** Nothing is stored or sent anywhere but the API call itself. An answer is used for
 *   {@link DISCOVER_CACHE_TTL_MS} on both the monotonic and the wall clock (a sleep ends it, so does a clock set back).
 * - **One call per address.** Two askers of the same address at once share one call; a kept answer costs none (so Back
 *   from a title and switching chips back are free).
 * - **No retry by itself.** A failure (a `429` apart) is remembered for {@link DISCOVER_FAILURE_MS}; asking again sooner needs `retry`. A `429`
 *   stops every call until its `Retry-After` is over (or {@link DISCOVER_BACKOFF_MS} when it did not say), a retry included;
 *   what is asked in that time gets the `429` again, with the time left, without a call. A `401` empties the cache.
 */
export class DiscoverData {
  readonly #fetch: Fetch;
  readonly #origin: string;
  readonly #watch: SessionWatch;
  readonly #now: () => number;
  readonly #wall: () => number;
  // A Map keeps insertion order: an address used again moves to the end, so the first one is the least recently used.
  #entries = new Map<string, Kept>();
  #flights = new Map<string, Promise<unknown>>();
  /** The session the cache holds answers for. */
  #stamp: Stamp | undefined;
  #blockedUntil = 0;

  public constructor(fetcher: Fetch, origin: string, watch: SessionWatch, now: () => number, wall: () => number) {
    this.#fetch = fetcher;
    this.#origin = origin;
    this.#watch = watch;
    this.#now = now;
    this.#wall = wall;
  }

  /** What is kept for `request` right now (no call, no clock beyond the TTL), so a page can draw its rows before anything is asked. */
  public peek<R extends DiscoverRequest>(request: R): { ok: true; value: ValueOf<R> } | Failure | undefined {
    if (!this.#sync() || !valid(request)) return undefined;
    const kept = this.#recall(discoverKey(request), true);
    return kept ? (kept.result as { ok: true; value: ValueOf<R> } | Failure) : undefined;
  }

  /**
   * The answer for `request`: kept, in flight, or asked for now. `retry` passes a remembered failure (never a `429`
   * block). Without a session nothing is asked and the answer is a `401`.
   */
  public async get<R extends DiscoverRequest>(request: R, options: { retry?: boolean } = {}): Promise<DiscoverResult<R>> {
    const session = this.#sync();
    if (!session) return { ok: false, status: 401 };
    if (!valid(request)) return { ok: false, status: 400 };
    const key = discoverKey(request);
    const kept = this.#recall(key, !options.retry);
    if (kept) return kept.result as DiscoverResult<R>;
    const blocked = this.#blockedUntil - this.#now();
    if (blocked > 0) return { ok: false, status: 429, retryAfterMs: blocked };
    const stamp = this.#watch.stamp(session);
    let flight = this.#flights.get(key);
    if (!flight) {
      flight = this.#ask(request, key, session.token, stamp);
      this.#flights.set(key, flight);
      const settled = () => { if (this.#flights.get(key) === flight) this.#flights.delete(key); };
      flight.then(settled, settled);
    }
    return (await flight) as DiscoverResult<R>;
  }

  /** Forgets every answer and call in flight (the add-on's own, e.g. on a `401` seen elsewhere). */
  public forget(): void {
    this.#entries = new Map();
    this.#flights = new Map();
  }

  /** Checks the session (the member and token seen may have changed): the current one, with the cache emptied if it is not the one it was kept for. */
  #sync(): ReturnType<SessionWatch['current']> {
    const session = this.#watch.current();
    if (!session) {
      this.#stamp = undefined;
      this.forget();
      return undefined;
    }
    if (!this.#stamp || !this.#watch.holds(this.#stamp)) {
      this.forget();
      this.#stamp = this.#watch.stamp(session);
    }
    return session;
  }

  #recall(key: string, failures: boolean): Kept | undefined {
    const kept = this.#entries.get(key);
    if (!kept) return undefined;
    this.#entries.delete(key);
    const mono = this.#now() - kept.mono;
    const wall = this.#wall() - kept.wall;
    const ttl = kept.result.ok ? DISCOVER_CACHE_TTL_MS : DISCOVER_FAILURE_MS;
    if (mono < 0 || mono >= ttl || wall < 0 || wall >= ttl) return undefined;
    // A failure is passed over when the member asked again; it is not given back as the answer, and stays gone.
    if (!kept.result.ok && !failures) return undefined;
    this.#entries.set(key, kept);
    return kept;
  }

  async #ask(request: DiscoverRequest, key: string, token: string, stamp: Stamp): Promise<DiscoverResult<DiscoverRequest>> {
    let result: { ok: true; value: unknown } | Failure;
    switch (request.kind) {
      case 'list': {
        const answer = await discoverList(this.#fetch, this.#origin, token, request.list, request.page);
        result = answer.ok ? { ok: true, value: answer.page } : answer;
        break;
      }
      case 'sources': {
        const answer = await discoverSources(this.#fetch, this.#origin, token);
        result = answer.ok ? { ok: true, value: answer.sources } : answer;
        break;
      }
      case 'network': {
        const answer = await networkList(this.#fetch, this.#origin, token, request.id, request.list, request.page);
        result = answer.ok ? { ok: true, value: answer.page } : answer;
        break;
      }
      default: {
        const answer = await studioList(this.#fetch, this.#origin, token, request.id, request.page);
        result = answer.ok ? { ok: true, value: answer.page } : answer;
      }
    }
    // An answer to another sign-in's call (signed out, another member, a new token) is dropped whole: a refused token
    // and a rate limit included.
    if (!this.#watch.holds(stamp)) return { ok: false, stale: true };
    if (!result.ok && result.status === 401) this.forget();
    if (!result.ok && result.status === 429) this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + (result.retryAfterMs ?? DISCOVER_BACKOFF_MS));
    // A refused token (401: the cache is emptied above), an address the reader would not send (400) and a rate limit (the
    // block above holds it, to its deadline, not for the failure's 30 seconds) are not remembered.
    if (result.ok || (result.status !== 401 && result.status !== 400 && result.status !== 429)) {
      this.#entries.delete(key);
      this.#entries.set(key, { result, mono: this.#now(), wall: this.#wall() });
      while (this.#entries.size > DISCOVER_CACHE_SIZE) {
        const oldest = this.#entries.keys().next();
        if (oldest.done) break;
        this.#entries.delete(oldest.value);
      }
    }
    return result as DiscoverResult<DiscoverRequest>;
  }
}
