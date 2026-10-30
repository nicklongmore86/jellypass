// Where the app is in signing in, and the moves between: the address step, a setup link waiting to be confirmed, the
// sign-in screens, checking a kept sign-in with GET /me, signed in, and signing out. One household at a time:
// changing household signs out first.
//
// - At start the kept sign-in (if any) is checked with GET /me: a 401 deletes it and shows the profile picker; no answer
//   (or any other) keeps it and offers a retry, held until a 429's Retry-After has passed. Nothing retries by itself.
// - A sign-in is kept only if the app is still where it was when the sign-in was sent (the same `epoch`). One that
//   finishes after the app moved on (a setup link to another household accepted meanwhile) is not kept and starts no
//   /me: its token is revoked at the household address it came from.
// - A setup link is only ever offered: nothing happens until the member confirms it, and it never signs anyone in.
// - Sign-out asks the gateway to forget the session (best effort, five seconds), then deletes the sign-in from the
//   device whatever came of that.
// - What the member just asked for (src/title/asked.ts) belongs to one signed-in session: a sign-out, a 401 or any
//   other sign-in (household, member or token) starts it empty. Coming back to the foreground reads its clocks again
//   (a timer may have slept with the app), and leaving the provider stops its timer. The titles My requests has named
//   (src/requests/titleCache.ts) belong to the same session and are forgotten with it, as is the page a Home row hands
//   its See all page (src/home/rowPages.ts), and what the member hid or unhid here (src/hidden/store.ts) with its sheet
//   and toast.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { HouseholdAddress } from '../api/address';
import type { ClientIdentity } from '../api/auth';
import { createApiClient, type ApiClient, type FetchLike } from '../api/client';
import { ApiError } from '../api/errors';
import type { MediaType, Me, Request } from '../api/types';
import { createHiddenTitles, type HiddenTitles, type HideTarget } from '../hidden/store';
import { HIDE_API_VERSION } from '../hidden/text';
import { parseLinkAddress } from '../signin/address-input';
import { createSignInApi, SignInError, type SignInApi, type SignInResult } from '../signin/signin-api';
import type { StalledKind } from '../signin/wording';
import { createHideStore, type HideStore } from '../home/hide';
import { createRowPages, type RowPages } from '../home/rowPages';
import { createRequestFilterStore, type RequestFilterStore } from '../requests/filters';
import { createTitleCache, type TitleCache } from '../requests/titleCache';
import { createAsked, type Asked } from '../title/asked';
import { clientIdentity } from './identity';
import { clearSessionIf, readSession, writeSession, type StoredSession } from './store';

export type Phase =
  | { kind: 'starting' }
  | { kind: 'address' }
  | { kind: 'signin'; address: HouseholdAddress; expired: boolean }
  | { kind: 'checking'; session: StoredSession }
  | { kind: 'signedIn'; session: StoredSession; me: Me }
  /** `retryAt`: when a 429 said to wait (its Retry-After), the time (ms) before which no retry is made. */
  | { kind: 'stalled'; session: StoredSession; problem: StalledKind; retryAt?: number }
  | { kind: 'signingOut' };

/** A setup link waiting for the member: the address it names, or `undefined` when it names none. */
export interface LinkOffer {
  address: HouseholdAddress | undefined;
}

export interface SessionDeps {
  fetch?: FetchLike;
  identity?: () => Promise<ClientIdentity>;
  now?: () => number;
}

export interface Session {
  phase: Phase;
  link: LinkOffer | undefined;
  /** The household the app is on now, if any. */
  household: HouseholdAddress | undefined;
  /** A setup link was opened (its `address` parameter): shown for the member to confirm. */
  offerLink: (param: string | string[] | undefined) => void;
  acceptLink: () => Promise<void>;
  dismissLink: () => void;
  /** The address step's answer: on to the profile picker. */
  chooseAddress: (address: HouseholdAddress) => void;
  /** Back to the address step, signing out first if signed in. */
  changeHousehold: () => Promise<void>;
  /** The clock `retryAt` is on. */
  now: () => number;
  /** Where the app is now: read when a sign-in is sent, and handed back with its result to completeSignIn. */
  epoch: () => number;
  /**
   * Keeps a sign-in and checks it, if the app is still at `epoch`; otherwise revokes it at `address` and resolves.
   * Throws SignInError `storage` (having revoked the token) if it cannot be kept.
   */
  completeSignIn: (address: HouseholdAddress, result: SignInResult, epoch: number) => Promise<void>;
  /** Checks the kept sign-in again, after it stalled (not before a 429's Retry-After has passed). */
  retry: () => void;
  signOut: () => Promise<void>;
  signInApi: (address: HouseholdAddress) => SignInApi;
  /** The signed-in household's API client (one per sign-in), or undefined while not signed in. */
  api: ApiClient | undefined;
  /** The API answered 401: the token is no longer good, so the device forgets it and the profile picker shows. */
  expire: () => Promise<void>;
  /** What this member just asked for, shown as requested while the server records it (in memory only). */
  asked: Asked;
  /** The titles My requests has named in this session, reused for ten minutes (in memory only, never their state). */
  titles: TitleCache;
  /** My requests' filters, kept while the app is open and reset with the session (in memory only). */
  requestFilters: RequestFilterStore;
  /** Home's "New only": on at every sign-in, kept while the app is open and reset with the session (in memory only). */
  hideHeld: HideStore;
  /** The page a Home row hands its See all page as it opens (in memory only). */
  rowPages: RowPages;
  /** Whether the signed-in household can hide titles (`apiVersion` 3 or later): below it nothing of hiding is shown. */
  canHide: boolean;
  /** What the member hid or unhid in this session, and the sheet and toast (in memory only). */
  hiddenTitles: HiddenTitles;
  /**
   * Hides (`hidden` true) or unhides a title through the signed-in client. Once it is accepted in the same session as
   * when it was sent, it is marked in `hiddenTitles` (a hide also shows the toast). Rejects with the ApiError, or the
   * caller's abort. One that settles (either way) after the sign-in changed is another member's: it marks nothing and
   * rejects as aborted, so nothing anywhere says how it went.
   */
  setHidden: (target: HideTarget, hidden: boolean, signal?: AbortSignal) => Promise<void>;
  /**
   * Get this through the signed-in client. Once it is accepted (a 2xx) in the same session as when it was sent (no move
   * since), the title (and the seasons asked for) is added to `asked`. Rejects with the ApiError, or the caller's abort.
   */
  getThis: (mediaType: MediaType, tmdbId: number, seasons: readonly number[], signal?: AbortSignal) => Promise<void>;
  /**
   * Cancels one of the member's own requests (an entry of `requests()`) through the signed-in client. Once it is accepted
   * in the same session as when it was sent, the title is withdrawn in `asked` (shown as Get this again). Rejects with
   * the ApiError, or the caller's abort.
   */
  cancelRequest: (request: Pick<Request, 'id' | 'mediaType' | 'tmdbId'>, signal?: AbortSignal) => Promise<void>;
}

const SessionContext = createContext<Session | undefined>(undefined);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession needs a SessionProvider');
  return session;
}

function stalledKind(error: unknown): StalledKind {
  if (!(error instanceof ApiError)) return 'unavailable';
  if (error.kind === 'network') return 'offline';
  if (error.kind === 'too_many_requests') return 'rate_limited';
  if (error.kind === 'not_found' && error.householdNotFound) return 'not_found';
  return 'unavailable';
}

/** A call that settled after the sign-in changed, thrown as an abort: the session that asked is gone. */
function movedOn(): Error {
  const error = new Error('The sign-in changed');
  error.name = 'AbortError';
  return error;
}

function sessionOf(phase: Phase): StoredSession | undefined {
  return phase.kind === 'checking' || phase.kind === 'signedIn' || phase.kind === 'stalled' ? phase.session : undefined;
}

export function SessionProvider({ children, deps = {} }: { children: ReactNode; deps?: SessionDeps }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [link, setLink] = useState<LinkOffer | undefined>(undefined);
  // Every move bumps this; an answer that comes back after a later move is dropped.
  const generation = useRef(0);

  const { fetch, identity = clientIdentity, now } = deps;
  const clock = now ?? Date.now;
  const signInApi = useCallback(
    (address: HouseholdAddress) => createSignInApi({ address, identity, ...(fetch ? { fetch } : {}), ...(now ? { now } : {}) }),
    [fetch, identity, now],
  );

  // The phase as of the last move, for an answer that comes back later.
  const phaseRef = useRef<Phase>(phase);
  // The overlay and the titles in use now (below), for the moves that forget them.
  const askedRef = useRef<Asked | undefined>(undefined);
  const titlesRef = useRef<TitleCache | undefined>(undefined);
  const filtersRef = useRef<RequestFilterStore | undefined>(undefined);
  const hideRef = useRef<HideStore | undefined>(undefined);
  const rowPagesRef = useRef<RowPages | undefined>(undefined);
  const hiddenRef = useRef<HiddenTitles | undefined>(undefined);

  const move = useCallback((next: Phase) => {
    generation.current += 1;
    phaseRef.current = next;
    setPhase(next);
    return generation.current;
  }, []);

  /**
   * Deletes `session`'s credentials once its sign-out (or 401) is done, but only if what is kept is its own (same
   * household and token), compared and deleted in one step of the credential queue: a newer sign-in's write is never
   * erased, whatever order the two finish in.
   */
  const forget = useCallback((session: StoredSession) => clearSessionIf(session), []);

  const check = useCallback(
    async (session: StoredSession) => {
      const mine = move({ kind: 'checking', session });
      const api = createApiClient({ address: session.address, token: () => session.token, ...(fetch ? { fetch } : {}), ...(now ? { now } : {}) });
      try {
        const me = await api.me();
        if (generation.current === mine) move({ kind: 'signedIn', session, me });
      } catch (error) {
        if (generation.current !== mine) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') {
          await forget(session);
          if (generation.current === mine) move({ kind: 'signin', address: session.address, expired: true });
          return;
        }
        const wait = error instanceof ApiError ? error.retryAfterSeconds : undefined;
        move({ kind: 'stalled', session, problem: stalledKind(error), ...(wait ? { retryAt: clock() + wait * 1000 } : {}) });
      }
    },
    [fetch, now, clock, move, forget],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      let session: StoredSession | undefined;
      try {
        session = await readSession();
      } catch {
        // The credential store could not be read (a locked device): sign in afresh.
        session = undefined;
      }
      if (!live) return;
      if (session) void check(session);
      else move({ kind: 'address' });
    })();
    return () => {
      live = false;
    };
  }, [check, move]);

  /** Signs out of the current sign-in, if any, then shows `next` (unless the app has moved on meanwhile). */
  const leave = useCallback(
    async (next: (session: StoredSession | undefined) => Phase) => {
      // A link the app held back (to the household it was on) is moot once it moves on.
      setLink(undefined);
      askedRef.current?.forget();
      titlesRef.current?.forget();
      filtersRef.current?.reset();
      hideRef.current?.reset();
      rowPagesRef.current?.forget();
      hiddenRef.current?.forget();
      const session = sessionOf(phase);
      if (session) {
        const mine = move({ kind: 'signingOut' });
        try {
          await signInApi(session.address).signOut(session.token);
        } finally {
          await forget(session);
        }
        // A sign-in or household chosen while this was out has moved the app already: it is not undone.
        if (generation.current === mine) move(next(session));
        return;
      }
      move(next(session));
    },
    [phase, move, signInApi, forget],
  );

  const offerLink = useCallback((param: string | string[] | undefined) => setLink({ address: parseLinkAddress(param) }), []);

  const household = phase.kind === 'signin' ? phase.address : sessionOf(phase)?.address;

  const signedPhase = phase.kind === 'signedIn' ? phase : undefined;
  const signedIn = signedPhase?.session;
  // A new client, overlay and titles for each sign-in (household, member or token); the old ones are forgotten as soon
  // as they are replaced.
  const { api, asked, titles, requestFilters, hideHeld, rowPages, hiddenTitles } = useMemo(
    () => ({
      api: signedIn
        ? createApiClient({ address: signedIn.address, token: () => signedIn.token, ...(fetch ? { fetch } : {}), ...(now ? { now } : {}) })
        : undefined,
      asked: createAsked(),
      titles: createTitleCache(),
      requestFilters: createRequestFilterStore(),
      hideHeld: createHideStore(),
      rowPages: createRowPages(),
      hiddenTitles: createHiddenTitles(),
    }),
    [signedIn, fetch, now],
  );
  useEffect(() => {
    askedRef.current = asked;
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') asked.recheck();
    });
    return () => {
      foreground.remove();
      if (askedRef.current === asked) askedRef.current = undefined;
      asked.forget();
    };
  }, [asked]);
  useEffect(() => {
    titlesRef.current = titles;
    return () => {
      if (titlesRef.current === titles) titlesRef.current = undefined;
      titles.forget();
    };
  }, [titles]);

  useEffect(() => {
    filtersRef.current = requestFilters;
    return () => {
      if (filtersRef.current === requestFilters) filtersRef.current = undefined;
      requestFilters.reset();
    };
  }, [requestFilters]);
  useEffect(() => {
    hideRef.current = hideHeld;
    return () => {
      if (hideRef.current === hideHeld) hideRef.current = undefined;
      hideHeld.reset();
    };
  }, [hideHeld]);
  useEffect(() => {
    rowPagesRef.current = rowPages;
    return () => {
      if (rowPagesRef.current === rowPages) rowPagesRef.current = undefined;
      rowPages.forget();
    };
  }, [rowPages]);

  useEffect(() => {
    hiddenRef.current = hiddenTitles;
    return () => {
      if (hiddenRef.current === hiddenTitles) hiddenRef.current = undefined;
      hiddenTitles.forget();
    };
  }, [hiddenTitles]);

  const getThis = useCallback(
    async (mediaType: MediaType, tmdbId: number, seasons: readonly number[], signal?: AbortSignal) => {
      // The sign-in this call belongs to: any move since (a sign-out, a 401, any other sign-in, even with the same
      // token) is another session.
      const mine = generation.current;
      if (!api || phaseRef.current.kind !== 'signedIn') throw new ApiError('unauthorized');
      await api.getThis(mediaType, tmdbId, seasons, signal ? { signal } : undefined);
      // Only for the member who asked: not if the sign-in changed (or went) while the call was out.
      if (generation.current === mine && askedRef.current === asked) asked.add(mediaType, tmdbId, seasons);
    },
    [api, asked],
  );

  const cancelRequest = useCallback(
    async (request: Pick<Request, 'id' | 'mediaType' | 'tmdbId'>, signal?: AbortSignal) => {
      const mine = generation.current;
      if (!api || phaseRef.current.kind !== 'signedIn') throw new ApiError('unauthorized');
      await api.cancelRequest(request.id, signal ? { signal } : undefined);
      if (generation.current === mine && askedRef.current === asked) asked.withdraw(request.mediaType, request.tmdbId);
    },
    [api, asked],
  );

  const setHidden = useCallback(
    async (target: HideTarget, hidden: boolean, signal?: AbortSignal) => {
      const mine = generation.current;
      if (!api || phaseRef.current.kind !== 'signedIn') throw new ApiError('unauthorized');
      const same = () => generation.current === mine && hiddenRef.current === hiddenTitles;
      try {
        await api.setHidden(target.mediaType, target.tmdbId, hidden, signal ? { signal } : undefined);
      } catch (error) {
        if (same()) throw error;
        throw movedOn();
      }
      if (!same()) throw movedOn();
      hiddenTitles.mark(target, hidden);
    },
    [api, hiddenTitles],
  );

  // The 401 callback belongs to the sign-in (the signedIn phase) it was made for. One that fires after the app moved on
  // (a sign-out, another sign-in, even the same token checked again) is another session's: it does nothing, before
  // anything is reset, deleted or moved.
  const expire = useCallback(async () => {
    const mine = signedPhase;
    if (!mine || phaseRef.current !== mine) return;
    askedRef.current?.forget();
    titlesRef.current?.forget();
    filtersRef.current?.reset();
    hideRef.current?.reset();
    rowPagesRef.current?.forget();
    hiddenRef.current?.forget();
    const session = mine.session;
    const gen = move({ kind: 'signingOut' });
    try {
      await forget(session);
    } finally {
      if (generation.current === gen) move({ kind: 'signin', address: session.address, expired: true });
    }
  }, [signedPhase, move, forget]);

  const canHide = signedPhase !== undefined && signedPhase.me.apiVersion >= HIDE_API_VERSION;

  // A link to the household the app is already on needs nothing.
  const offer = link?.address && household && link.address.origin === household.origin ? undefined : link;

  const value = useMemo<Session>(
    () => ({
      phase,
      link: offer,
      household,
      offerLink,
      acceptLink: async () => {
        const address = offer?.address;
        setLink(undefined);
        if (address) await leave(() => ({ kind: 'signin', address, expired: false }));
      },
      dismissLink: () => setLink(undefined),
      chooseAddress: (address) => {
        setLink(undefined);
        move({ kind: 'signin', address, expired: false });
      },
      changeHousehold: () => leave(() => ({ kind: 'address' })),
      now: clock,
      epoch: () => generation.current,
      completeSignIn: async (address, result, epoch) => {
        // The app moved on while this sign-in was out: it is not kept, and the household it came from forgets it.
        const revoke = () => signInApi(address).signOut(result.token);
        if (generation.current !== epoch) {
          await revoke();
          return;
        }
        const session: StoredSession = { address, token: result.token, userId: result.userId, name: result.name };
        try {
          await writeSession(session);
        } catch {
          // Not kept, so not used: the gateway forgets it too.
          await revoke();
          throw new SignInError('storage');
        }
        if (generation.current !== epoch) {
          // It moved on while the sign-in was being written. Nothing newer has been kept (that would have moved to a
          // phase with a session), so the device forgets this one.
          if (!sessionOf(phaseRef.current)) await clearSessionIf(session);
          await revoke();
          return;
        }
        void check(session);
      },
      retry: () => {
        const session = sessionOf(phase);
        if (!session) return;
        if (phase.kind === 'stalled' && phase.retryAt !== undefined && clock() < phase.retryAt) return;
        void check(session);
      },
      signOut: () => leave((session) => (session ? { kind: 'signin', address: session.address, expired: false } : { kind: 'address' })),
      signInApi,
      api,
      expire,
      asked,
      titles,
      requestFilters,
      hideHeld,
      rowPages,
      canHide,
      hiddenTitles,
      getThis,
      cancelRequest,
      setHidden,
    }),
    [phase, offer, household, offerLink, leave, move, check, signInApi, clock, api, expire, asked, titles, requestFilters, hideHeld, rowPages, canHide, hiddenTitles, getThis, cancelRequest, setHidden],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The signed-in member's overlay, drawn again whenever a title is added to it or it is forgotten. */
export function useAsked(): Asked {
  const { asked } = useSession();
  useSyncExternalStore(asked.subscribe, asked.version, asked.version);
  return asked;
}

/** The member's hidden titles in this session, drawn again whenever one is hidden or unhidden, or the sheet or toast changes. */
export function useHiddenTitles(): HiddenTitles {
  const { hiddenTitles } = useSession();
  useSyncExternalStore(hiddenTitles.subscribe, hiddenTitles.version, hiddenTitles.version);
  return hiddenTitles;
}
