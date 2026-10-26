// Where the app is in signing in, and the moves between: the address step, a setup link waiting to be confirmed, the
// sign-in screens, checking a kept sign-in with GET /me, signed in, and signing out. One household at a time:
// changing household signs out first.
//
// - At start the kept sign-in (if any) is checked with GET /me: a 401 deletes it and shows the profile picker; no answer
//   (or any other) keeps it and offers a retry.
// - A setup link is only ever offered: nothing happens until the member confirms it, and it never signs anyone in.
// - Sign-out asks the gateway to forget the session (best effort, five seconds), then deletes the sign-in from the
//   device whatever came of that.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { HouseholdAddress } from '../api/address';
import type { ClientIdentity } from '../api/auth';
import { createApiClient, type FetchLike } from '../api/client';
import { ApiError } from '../api/errors';
import type { Me } from '../api/types';
import { parseLinkAddress } from '../signin/address-input';
import { createSignInApi, SignInError, type SignInApi, type SignInResult } from '../signin/signin-api';
import type { StalledKind } from '../signin/wording';
import { clientIdentity } from './identity';
import { clearSession, readSession, writeSession, type StoredSession } from './store';

export type Phase =
  | { kind: 'starting' }
  | { kind: 'address' }
  | { kind: 'signin'; address: HouseholdAddress; expired: boolean }
  | { kind: 'checking'; session: StoredSession }
  | { kind: 'signedIn'; session: StoredSession; me: Me }
  | { kind: 'stalled'; session: StoredSession; problem: StalledKind }
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
  /** Keeps a sign-in and checks it. Throws SignInError `storage` (having revoked the token) if it cannot be kept. */
  completeSignIn: (address: HouseholdAddress, result: SignInResult) => Promise<void>;
  /** Checks the kept sign-in again, after it stalled. */
  retry: () => void;
  signOut: () => Promise<void>;
  signInApi: (address: HouseholdAddress) => SignInApi;
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

function sessionOf(phase: Phase): StoredSession | undefined {
  return phase.kind === 'checking' || phase.kind === 'signedIn' || phase.kind === 'stalled' ? phase.session : undefined;
}

export function SessionProvider({ children, deps = {} }: { children: ReactNode; deps?: SessionDeps }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [link, setLink] = useState<LinkOffer | undefined>(undefined);
  // Every move bumps this; an answer that comes back after a later move is dropped.
  const generation = useRef(0);

  const { fetch, identity = clientIdentity, now } = deps;
  const signInApi = useCallback(
    (address: HouseholdAddress) => createSignInApi({ address, identity, ...(fetch ? { fetch } : {}), ...(now ? { now } : {}) }),
    [fetch, identity, now],
  );

  const move = useCallback((next: Phase) => {
    generation.current += 1;
    setPhase(next);
    return generation.current;
  }, []);

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
          await clearSession();
          if (generation.current === mine) move({ kind: 'signin', address: session.address, expired: true });
          return;
        }
        move({ kind: 'stalled', session, problem: stalledKind(error) });
      }
    },
    [fetch, now, move],
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

  /** Signs out of the current sign-in, if any, then shows `next`. */
  const leave = useCallback(
    async (next: (session: StoredSession | undefined) => Phase) => {
      // A link the app held back (to the household it was on) is moot once it moves on.
      setLink(undefined);
      const session = sessionOf(phase);
      if (session) {
        move({ kind: 'signingOut' });
        try {
          await signInApi(session.address).signOut(session.token);
        } finally {
          await clearSession();
        }
      }
      move(next(session));
    },
    [phase, move, signInApi],
  );

  const offerLink = useCallback((param: string | string[] | undefined) => setLink({ address: parseLinkAddress(param) }), []);

  const household = phase.kind === 'signin' ? phase.address : sessionOf(phase)?.address;

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
      completeSignIn: async (address, result) => {
        const session: StoredSession = { address, token: result.token, userId: result.userId, name: result.name };
        try {
          await writeSession(session);
        } catch {
          // Not kept, so not used: the gateway forgets it too.
          await signInApi(address).signOut(result.token);
          throw new SignInError('storage');
        }
        void check(session);
      },
      retry: () => {
        const session = sessionOf(phase);
        if (session) void check(session);
      },
      signOut: () => leave((session) => (session ? { kind: 'signin', address: session.address, expired: false } : { kind: 'address' })),
      signInApi,
    }),
    [phase, offer, household, offerLink, leave, move, check, signInApi],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
