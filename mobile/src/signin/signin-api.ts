// Sign-in and sign-out through the household gateway, with the calls Jellyfin web makes (docs/app-design.md, "Native
// clients (contract)"): GET /Users/Public for the household's profiles, POST /Users/AuthenticateByName with a name and
// password, and POST /Sessions/Logout. Every call is an absolute URL on the one household address. Sign-in is by name
// only, never POST /Users/{id}/Authenticate: the gateway checks that the name is a member's.
//
// - The gateway lists only this household's members (Jellyfin leaves hidden ones off, as here), marks passwordless
//   members `HasPassword: false`, and answers every refused sign-in with a fixed body, no sooner than a second after it
//   arrived: 400 (no client fields, or a body that is not a name and a password), 401 (any name or password that did not
//   work), 429 (too many attempts from this address) and 502 (Jellyfin unreachable). The app tells apart only the kinds
//   below, each with fixed wording (wording.ts); a body, an upstream message or a status line is never shown.
// - The password is only in the one request body that sends it: nothing here keeps or logs it.
// - No redirects: every call is `redirect: 'manual'` through expo/fetch (api/transport.ts), so the password, a token
//   or the client fields are never sent anywhere but the household. A 3xx is `unavailable`, with nothing read.
// - Nothing is logged, and a SignInError carries no URL, token, name or answer.

import type { HouseholdAddress } from '../api/address';
import { signInAuthorization, tokenAuthorization, type ClientIdentity } from '../api/auth';
import type { FetchLike, ResponseLike } from '../api/client';
import { retryAfterSeconds } from '../api/errors';
import { householdFetch, offHousehold } from '../api/transport';

/** The only sign-in failures the app tells apart (as the PWA's, plus `not_found` for an address no household has). */
export type SignInErrorKind = 'invalid' | 'rate_limited' | 'unavailable' | 'offline' | 'not_found' | 'storage';

export class SignInError extends Error {
  public readonly kind: SignInErrorKind;
  /** 429 with a usable `Retry-After`, in whole seconds. */
  public readonly retryAfterSeconds: number | undefined;

  public constructor(kind: SignInErrorKind, retryAfter?: number) {
    super(kind);
    this.name = 'SignInError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfter;
  }
}

/** A household member the gateway lists on this address, as Jellyfin's own profile picker would. */
export interface Profile {
  id: string;
  name: string;
  /** False for a member marked passwordless: one tap signs in, as in Jellyfin web. */
  hasPassword: boolean;
}

export interface SignInResult {
  token: string;
  userId: string;
  /** The member's name as Jellyfin has it (the typed name may differ in case). */
  name: string;
}

export interface SignInApi {
  profiles(signal?: AbortSignal): Promise<Profile[]>;
  signIn(username: string, password: string, signal?: AbortSignal): Promise<SignInResult>;
  /** Revokes `token` at Jellyfin through the gateway, which forgets the session at once. Best effort: never throws. */
  signOut(token: string): Promise<void>;
}

export interface SignInApiOptions {
  address: HouseholdAddress;
  identity: () => Promise<ClientIdentity>;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** The clock for Retry-After dates. */
  now?: () => number;
}

export const SIGN_IN_TIMEOUT_MS = 20_000;
/** Sign-out waits this long at most, then the app forgets the sign-in anyway (as the PWA). */
export const SIGN_OUT_TIMEOUT_MS = 5000;
const MAX_PROFILES = 200;
const MAX_NAME_LENGTH = 256;
const MAX_ANSWER_CHARS = 1024 * 1024;

/** The kind for a refused sign-in, by status alone, as the PWA reads it. */
export function signInKind(status: number): SignInErrorKind {
  if (status === 401 || status === 403) return 'invalid';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

function parse(text: string): unknown {
  try {
    return text.length <= MAX_ANSWER_CHARS ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function createSignInApi(options: SignInApiOptions): SignInApi {
  const { address } = options;
  const fetchAnswer: FetchLike = options.fetch ?? householdFetch;
  const timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  /** One call; `offline` when there was no answer, `unavailable` for a redirect (never followed) or an answer from elsewhere. */
  async function call(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
    limitMs: number,
    signal?: AbortSignal,
  ): Promise<{ response: ResponseLike; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      let response: ResponseLike;
      let text: string;
      try {
        response = await fetchAnswer(`${address.origin}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new SignInError('offline');
      }
      // Nothing from a redirect or from anywhere else is read.
      if (offHousehold(response, address.origin)) throw new SignInError('unavailable');
      try {
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new SignInError('offline');
      }
      return { response, text };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function refused(response: ResponseLike, kind: SignInErrorKind): SignInError {
    return new SignInError(kind, kind === 'rate_limited' ? retryAfterSeconds(response.headers.get('Retry-After'), now()) : undefined);
  }

  return {
    async profiles(signal) {
      const { response, text } = await call('GET', '/Users/Public', { Accept: 'application/json' }, undefined, timeoutMs, signal);
      const ok = response.status >= 200 && response.status < 300;
      if (!ok) {
        // 404 household_not_found: no household has this address (removed, or mistyped).
        const notFound = response.status === 404 && record(parse(text))['error'] === 'household_not_found';
        throw refused(response, notFound ? 'not_found' : response.status === 429 ? 'rate_limited' : 'unavailable');
      }
      const list = parse(text);
      if (!Array.isArray(list)) throw new SignInError('unavailable');
      const profiles: Profile[] = [];
      for (const entry of list.slice(0, MAX_PROFILES)) {
        const { Id: id, Name: name, HasPassword: hasPassword } = record(entry);
        if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || name.length > MAX_NAME_LENGTH) continue;
        profiles.push({ id, name, hasPassword: hasPassword !== false });
      }
      return profiles;
    },

    async signIn(username, password, signal) {
      let authorization: string;
      try {
        authorization = signInAuthorization(await options.identity());
      } catch {
        throw new SignInError('storage');
      }
      const { response, text } = await call(
        'POST',
        '/Users/AuthenticateByName',
        { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization },
        JSON.stringify({ Username: username, Pw: password }),
        timeoutMs,
        signal,
      );
      if (response.status !== 200) throw refused(response, signInKind(response.status));
      const answer = record(parse(text));
      const user = record(answer['User']);
      const token = answer['AccessToken'];
      const userId = user['Id'];
      const name = user['Name'];
      if (typeof token !== 'string' || !token || typeof userId !== 'string' || !userId) throw new SignInError('unavailable');
      return { token, userId, name: typeof name === 'string' && name && name.length <= MAX_NAME_LENGTH ? name : username };
    },

    async signOut(token) {
      try {
        await call('POST', '/Sessions/Logout', { Authorization: tokenAuthorization(token) }, undefined, SIGN_OUT_TIMEOUT_MS);
      } catch {
        // Offline or Jellyfin down: the sign-in is still removed from this device.
      }
    },
  };
}
