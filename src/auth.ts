import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { JellyfinError, type JellyfinClient } from './jellyfin.js';
import { AttemptCounter } from './rate-limit.js';

const SESSION_SECONDS = 12 * 60 * 60;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_FAILURE_CLIENTS = 10_000;
const NAME_FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** Failures for one name from one client address before that pair is refused outright. */
const MAX_NAME_CLIENT_FAILURES = 10;
const MAX_FAILURE_NAME_CLIENTS = 10_000;
/** Failures for one name, from any address, before its sign-ins start to be slowed down. */
const NAME_FAILURES_BEFORE_DELAY = 5;
const MAX_FAILURE_NAMES = 10_000;
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 4096;
const DEFAULT_LOGIN_FAILURE_DELAY_MS = 1000;
const DEFAULT_NAME_DELAY_STEP_MS = 250;
const DEFAULT_NAME_DELAY_MAX_MS = 5000;
const DEFAULT_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RECHECK_RETRY_MS = 30 * 1000;

/** Plain-HTTP (LAN) session cookie. Over HTTPS the `__Host-` name is used instead; see {@link sessionCookieName}. */
const SESSION_COOKIE = 'jellypass_session';
const HOST_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

export interface WebAuthOptions {
  /** The least time a refused administrator sign-in takes, in milliseconds (default one second). */
  loginFailureDelayMs?: number;
  /**
   * The first added wait, in milliseconds, before a sign-in for a name that has failed often (default 250); it doubles
   * with each further failure, up to {@link nameDelayMaxMs}.
   */
  nameDelayStepMs?: number;
  /** The longest added wait before a sign-in for a name that has failed often, in milliseconds (default five seconds). */
  nameDelayMaxMs?: number;
  /** How often each session's administrator is checked again at Jellyfin, in milliseconds (default five minutes). */
  recheckIntervalMs?: number;
  /** How long a session waits before retrying a check Jellyfin failed to answer, in milliseconds (default 30 seconds). */
  recheckRetryMs?: number;
  now?: () => number;
}

/** What the admin sign-in needs from Jellyfin: the sign-in itself, and a user read with JellyPass's API key. */
export type AdministratorDirectory = Pick<JellyfinClient, 'authenticateAdministrator' | 'getUser'>;

export type SessionState =
  | { status: 'active'; username: string }
  | { status: 'none' }
  /** The session's administrator is due a check that Jellyfin did not answer; the session is kept but not honoured. */
  | { status: 'unavailable' };

interface Session {
  userId: string;
  username: string;
  expiresAt: number;
  checkedAt: number;
  retryAt: number;
  check?: Promise<void>;
}

export class WebAuth {
  readonly #jellyfin: AdministratorDirectory;
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;
  readonly #failures: AttemptCounter;
  readonly #nameClientFailures: AttemptCounter;
  readonly #nameFailures: AttemptCounter;
  readonly #loginFailureDelayMs: number;
  readonly #nameDelayStepMs: number;
  readonly #nameDelayMaxMs: number;
  readonly #recheckIntervalMs: number;
  readonly #recheckRetryMs: number;

  public constructor(jellyfin: AdministratorDirectory, options: WebAuthOptions = {}) {
    this.#jellyfin = jellyfin;
    this.#now = options.now ?? Date.now;
    this.#failures = new AttemptCounter({ windowMs: FAILURE_WINDOW_MS, maxKeys: MAX_FAILURE_CLIENTS, now: this.#now });
    this.#nameClientFailures = new AttemptCounter({
      windowMs: NAME_FAILURE_WINDOW_MS,
      maxKeys: MAX_FAILURE_NAME_CLIENTS,
      now: this.#now,
    });
    this.#nameFailures = new AttemptCounter({ windowMs: NAME_FAILURE_WINDOW_MS, maxKeys: MAX_FAILURE_NAMES, now: this.#now });
    this.#loginFailureDelayMs = options.loginFailureDelayMs ?? DEFAULT_LOGIN_FAILURE_DELAY_MS;
    this.#nameDelayStepMs = options.nameDelayStepMs ?? DEFAULT_NAME_DELAY_STEP_MS;
    this.#nameDelayMaxMs = options.nameDelayMaxMs ?? DEFAULT_NAME_DELAY_MAX_MS;
    this.#recheckIntervalMs = options.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS;
    this.#recheckRetryMs = options.recheckRetryMs ?? DEFAULT_RECHECK_RETRY_MS;
  }

  /**
   * Administrator sign-in. Only a sign-in that works is answered at once. Every other attempt, whatever went wrong (a
   * malformed body, an unknown name, a wrong password, a user who is not an enabled administrator, or Jellyfin failing to
   * answer), resolves null no sooner than #loginFailureDelayMs after it started, and Jellyfin's own text never leaves
   * this method.
   *
   * Failures are counted per client address, per (normalised name, client address) and per normalised name, each
   * whether or not Jellyfin has such a user, so no limit says anything about which accounts exist. The first two refuse
   * outright: either reached rejects with `too_many_login_attempts`, also no sooner than the delay, without asking
   * Jellyfin. The per-name count never refuses: past a few failures it only adds a wait before Jellyfin is asked
   * (doubling, up to #nameDelayMaxMs), so guessing one name from many addresses cannot lock its owner out; their right
   * password from an address of their own still signs in.
   */
  public async login(username: unknown, password: unknown, clientId: string): Promise<{ token: string; username: string } | null> {
    const started = performance.now();
    const floor = () => delay(Math.max(0, this.#loginFailureDelayMs - (performance.now() - started)));
    const name = typeof username === 'string' ? username.trim() : '';
    const nameKey = usernameKey(name);
    const nameClientKey = `${clientId}\u0000${nameKey}`;
    if (this.#failures.attempts(clientId) >= MAX_FAILURES || this.#nameClientFailures.attempts(nameClientKey) >= MAX_NAME_CLIENT_FAILURES) {
      await floor();
      throw new Error('too_many_login_attempts');
    }
    const nameDelay = this.#nameDelayMs(this.#nameFailures.attempts(nameKey));
    if (nameDelay > 0) await delay(nameDelay);
    let user: Awaited<ReturnType<AdministratorDirectory['authenticateAdministrator']>> = null;
    if (name && name.length <= MAX_USERNAME_LENGTH && typeof password === 'string' && password && password.length <= MAX_PASSWORD_LENGTH) {
      try {
        user = await this.#jellyfin.authenticateAdministrator(name, password);
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          message: 'administrator sign-in could not be checked at Jellyfin',
          detail: error instanceof Error ? error.message : String(error),
        }));
        user = null;
      }
    }
    if (!user) {
      this.#failures.increment(clientId);
      this.#nameClientFailures.increment(nameClientKey);
      this.#nameFailures.increment(nameKey);
      await floor();
      return null;
    }
    this.#failures.delete(clientId);
    this.#nameClientFailures.delete(nameClientKey);
    this.#nameFailures.delete(nameKey);
    this.#purgeExpired();
    const now = this.#now();
    const token = randomBytes(32).toString('base64url');
    this.#sessions.set(sessionKey(token), {
      userId: user.Id,
      username: user.Name,
      expiresAt: now + SESSION_SECONDS * 1000,
      checkedAt: now,
      retryAt: 0,
    });
    return { token, username: user.Name };
  }

  /**
   * The session the request's cookie names. Every #recheckIntervalMs a session's administrator is read again with
   * JellyPass's API key (one read per session at a time, however many requests wait on it): a user Jellyfin no longer
   * has, or one who is no longer an enabled administrator, ends the session. A check Jellyfin fails to answer keeps the
   * session but does not honour it, and is not retried for #recheckRetryMs.
   */
  public async session(request: IncomingMessage): Promise<SessionState> {
    this.#purgeExpired();
    const token = cookieValue(request, sessionCookieName(isSecureRequest(request)));
    if (!token) return { status: 'none' };
    const key = sessionKey(token);
    const session = this.#sessions.get(key);
    if (!session) return { status: 'none' };
    if (this.#now() - session.checkedAt >= this.#recheckIntervalMs) {
      if (!session.check && this.#now() >= session.retryAt) {
        session.check = this.#recheck(key, session).finally(() => { delete session.check; });
      }
      if (session.check) await session.check;
      if (this.#sessions.get(key) !== session) return { status: 'none' };
      if (this.#now() - session.checkedAt >= this.#recheckIntervalMs) return { status: 'unavailable' };
    }
    return { status: 'active', username: session.username };
  }

  public logout(request: IncomingMessage): void {
    const token = cookieValue(request, sessionCookieName(isSecureRequest(request)));
    if (token) this.#sessions.delete(sessionKey(token));
  }

  #nameDelayMs(failures: number): number {
    if (failures < NAME_FAILURES_BEFORE_DELAY) return 0;
    const exponent = Math.min(failures - NAME_FAILURES_BEFORE_DELAY, 30);
    return Math.min(this.#nameDelayMaxMs, this.#nameDelayStepMs * 2 ** exponent);
  }

  async #recheck(key: string, session: Session): Promise<void> {
    let user: Awaited<ReturnType<AdministratorDirectory['getUser']>> | undefined;
    try {
      user = await this.#jellyfin.getUser(session.userId);
    } catch (error) {
      if (error instanceof JellyfinError && error.status === 404) {
        user = undefined;
      } else {
        session.retryAt = this.#now() + this.#recheckRetryMs;
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'could not check an administrator session at Jellyfin',
          detail: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
    }
    if (!user || user.Id !== session.userId || user.Policy?.IsAdministrator !== true || user.Policy?.IsDisabled === true) {
      this.#sessions.delete(key);
      return;
    }
    session.username = user.Name;
    session.checkedAt = this.#now();
    session.retryAt = 0;
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(key);
    }
  }
}

/**
 * The session cookie's name. Over HTTPS it carries the `__Host-` prefix, so the browser only accepts it if it is Secure,
 * has Path=/ and no Domain: no sibling host under the same site (a household host, Seerr) can set or overwrite it. Plain
 * HTTP (a LAN address) cannot use the prefix and keeps the plain name. Each scheme reads only its own name, so a plain
 * cookie left over from an HTTPS sign-in before the prefix is ignored, and is cleared at the next sign-in or sign-out.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? HOST_SESSION_COOKIE : SESSION_COOKIE;
}

export function sessionCookie(token: string, secure: boolean): string[] {
  return [
    `${sessionCookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`,
    ...(secure ? [expiredCookie(SESSION_COOKIE, true)] : []),
  ];
}

export function expiredSessionCookie(secure: boolean): string[] {
  return secure ? [expiredCookie(HOST_SESSION_COOKIE, true), expiredCookie(SESSION_COOKIE, true)] : [expiredCookie(SESSION_COOKIE, false)];
}

export function isSecureRequest(request: IncomingMessage): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return protocol?.split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * Whether a state-changing request was sent by a page on the admin origin itself. Browsers send Sec-Fetch-Site with
 * every request, and page script cannot change it; when it is present it must be `same-origin` (`same-site`, from a
 * sibling host such as a household host or Seerr, is refused). Without it, Origin must name the admin origin: the host
 * the request was sent to, from Host only, with the scheme it arrived over. X-Forwarded-Host is never read, even from a
 * trusted proxy: a proxy that keeps Host (as Nginx Proxy Manager does) may still pass on a client's own X-Forwarded-Host,
 * which would let a page on a sibling host name its own origin as the admin one. When a proxy reports HTTPS only an https
 * Origin matches; otherwise either scheme does, since a proxy that terminates TLS may still report the plain hop it
 * forwarded over. A request with neither header (or `Origin: null`) is refused.
 */
export function isSameOriginRequest(request: IncomingMessage): boolean {
  const fetchSite = singleHeader(request.headers['sec-fetch-site']);
  if (fetchSite !== undefined) return fetchSite.trim().toLowerCase() === 'same-origin';
  const origin = singleHeader(request.headers.origin)?.trim();
  if (!origin || origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return false;
  if (isSecureRequest(request) && parsed.protocol !== 'https:') return false;
  const host = request.headers.host;
  return host !== undefined && sameHost(parsed, host.trim());
}

/** Whether the request carries a session cookie under the name for its scheme (valid or not). */
export function hasSessionCookie(request: IncomingMessage): boolean {
  return cookieValue(request, sessionCookieName(isSecureRequest(request))) !== undefined;
}

function sameHost(origin: URL, host: string): boolean {
  if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(host)) return false;
  try {
    return new URL(`${origin.protocol}//${host}`).host === origin.host;
  } catch {
    return false;
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function expiredCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Jellyfin matches names case-insensitively, so a name's failures are counted under one key however it is spelled. */
function usernameKey(username: string): string {
  return username.normalize('NFKC').toLowerCase().slice(0, MAX_USERNAME_LENGTH);
}

function sessionKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const pair of request.headers.cookie?.split(';') ?? []) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return undefined;
}
