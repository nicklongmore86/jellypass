import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import http, { type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { HouseholdAppHandler, JellyfinCaller } from './app-api.js';
import { NEVER_STORE, type AppAssets } from './app-assets.js';
import { ClientIpResolver, normaliseIp } from './client-ip.js';
import { DEFAULT_WS_IDLE_TIMEOUT_MS, DEFAULT_WS_UPSTREAM_IDLE_TIMEOUT_MS, type LogLevel } from './config.js';
import { LIBRARY_JOIN_HTML, LIBRARY_JOIN_JS, LIBRARY_JOIN_STYLES } from './household-ui.js';
import { AttemptCounter } from './rate-limit.js';

const PUBLIC_USERS_PATH = '/users/public';
const BRANDING_CONFIGURATION_PATH = '/branding/configuration';
const QUICK_CONNECT_ENABLED_PATH = '/quickconnect/enabled';
const AUTHENTICATE_BY_NAME_PATH = '/users/authenticatebyname';
const LOGOUT_PATH = '/sessions/logout';
const FORGOT_PASSWORD_PATHS = new Set(['/users/forgotpassword', '/users/forgotpassword/pin']);
const MAX_TRANSFORMED_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 20;
const MAX_LOGIN_CLIENTS = 10_000;
/** Largest answer to a household sign-in read from Jellyfin, in bytes. */
const MAX_LOGIN_RESPONSE_BYTES = 1024 * 1024;
/** How long Jellyfin's user list, which household sign-in checks names against, is reused. */
const LOGIN_USERS_TTL_MS = 10_000;
/** The least time a refused household sign-in takes, so its timing does not tell why it was refused. */
const DEFAULT_LOGIN_FAILURE_DELAY_MS = 1000;
/** How long a household sign-in waits for Jellyfin's answer before it counts as no answer. */
const DEFAULT_LOGIN_TIMEOUT_MS = 15_000;
/** The client metadata Jellyfin requires of every sign-in: without any of it Jellyfin refuses with a 400. */
const LOGIN_CLIENT_FIELDS = ['client', 'device', 'deviceid', 'version'];
const LIBRARY_JOIN_PATH = '/jellypass/add';
const APP_PATH = '/jellypass/app';
/** Largest Jellyfin answer read for the household app with the caller's own credentials, in bytes. */
const MAX_CALLER_JSON_BYTES = 16 * 1024 * 1024;
const LIBRARY_JOIN_ASSETS: Record<string, { body: string; contentType: string }> = {
  '/jellypass/add': { body: LIBRARY_JOIN_HTML, contentType: 'text/html; charset=utf-8' },
  '/jellypass/add.js': { body: LIBRARY_JOIN_JS, contentType: 'text/javascript; charset=utf-8' },
  '/jellypass/add.css': { body: LIBRARY_JOIN_STYLES, contentType: 'text/css; charset=utf-8' },
};
const MAX_LIBRARY_JOIN_BODY_BYTES = 1024;
const LIBRARY_JOIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LIBRARY_JOINS = 30;
/**
 * Joins started per signed-in user, and in all, in each window of LIBRARY_JOIN_WINDOW_MS (the per-address budget is the
 * MAX_LIBRARY_JOINS rate limit). These count submissions and are never given back when a join finishes, so whether a
 * call is started depends only on how many calls were made and when, never on how long any title's work took. A signed-
 * in, valid call past either budget is answered exactly like any other but not started; a call past the user's own
 * budget is not counted against the shared one. Both are fixed windows that start at the first counted call. At most
 * MAX_LIBRARY_JOINS_STARTED joins are therefore started per window: this limits the rate work is submitted to Seerr and
 * the shared write queue, not how much is in flight, since joins still queued from one window add to the next.
 */
const MAX_LIBRARY_JOINS_STARTED_PER_USER = 10;
const MAX_LIBRARY_JOINS_STARTED = 200;
/**
 * The only answer to an accepted join, sent as soon as the caller is authenticated and the input is valid, before the
 * title is looked up. It is the same, and takes the same time, whether the title was joined, already visible to the
 * caller, public, held by another household, admin-managed, missing, or could not be looked up.
 */
const LIBRARY_JOIN_ACCEPTED = { status: 'accepted' };
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 60_000;
/** How long a WebSocket peer gets to answer our FIN during shutdown before its socket is destroyed. */
const WS_SHUTDOWN_GRACE_MS = 250;
// Manual login stays: it is how a hidden member (left off the picker, as Jellyfin's "hidden" asks) signs in by name.
const HOUSEHOLD_LOGIN_CSS = `
/* JellyPass household profile picker */
#loginPage .btnQuick,
#loginPage .btnForgotPassword,
#loginPage .btnSelectServer,
#loginPage .loginDisclaimerContainer {
  display: none !important;
}
#loginPage .visualLoginForm {
  margin-inline: auto;
  max-width: 72rem;
}
#loginPage .visualLoginForm > h1 {
  color: #ffffff;
  font-weight: 600;
}
`;

export interface HouseholdGatewayOptions {
  jellyfinUrl: string;
  domain: string;
  hostPrefix: string;
  memberIds: (householdId: string) => string[] | undefined;
  isPasswordless?: (userId: string) => boolean;
  /**
   * Every Jellyfin user as Jellyfin's admin API lists them, hidden ones included: household sign-in finds the member a
   * name belongs to in it. Without it every household sign-in is refused.
   */
  users?: () => Promise<Array<{ Id: string; Name: string }>>;
  /** The least time a refused household sign-in takes, in milliseconds (default DEFAULT_LOGIN_FAILURE_DELAY_MS). */
  loginFailureDelayMs?: number;
  /** How long a household sign-in waits for Jellyfin, in milliseconds (default DEFAULT_LOGIN_TIMEOUT_MS). */
  loginTimeoutMs?: number;
  /** Close an upgraded connection after this long with no bytes in either direction; 0 disables. */
  webSocketIdleTimeoutMs?: number;
  /** Close an upgraded connection after this long with no bytes from Jellyfin, even if the client keeps talking; 0 disables. */
  webSocketUpstreamIdleTimeoutMs?: number;
  logLevel?: LogLevel;
  /** Reverse proxies trusted to report the client address in X-Forwarded-For; empty uses the TCP peer. */
  trustedProxies?: string[];
  /**
   * Household "Add to my library" at /jellypass/add. Without it those paths are proxied to Jellyfin like any other.
   * `start` begins the join as tracked background work and returns at once: a promise that settles when the work has,
   * and must not reject, or undefined when shutdown refused it. Its outcome is never shown to the caller. `dropped` is
   * called for a join not started because its user, or all users together, had used up their budget.
   */
  libraryJoin?: {
    start: (input: { userId: string; isAdministrator: boolean; mediaType: 'movie' | 'tv'; tmdbId: number }) => Promise<void> | undefined;
    dropped?: () => void;
  };
  /**
   * The household app API at /jellypass/app/v1/*. Without it every /jellypass/app path answers a fixed 404 and is never
   * proxied to Jellyfin.
   */
  app?: HouseholdAppHandler;
  /** The app's own files at /jellypass/app/ (the page, script, styles, manifest, service worker). Only served with `app`. */
  appAssets?: AppAssets;
}

interface CurrentUser {
  Id: string;
  Name?: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
}

/** The Jellyfin credentials a request carries: its authorization headers and token query parameters, nothing else. */
interface JellyfinCredentials {
  headers: Headers;
  query: URLSearchParams;
}

export class HouseholdGateway {
  readonly #target: URL;
  readonly #domain: string;
  readonly #hostPrefix: string;
  readonly #memberIds: HouseholdGatewayOptions['memberIds'];
  readonly #isPasswordless: NonNullable<HouseholdGatewayOptions['isPasswordless']>;
  readonly #users: HouseholdGatewayOptions['users'];
  readonly #loginFailureDelayMs: number;
  readonly #loginTimeoutMs: number;
  #loginUsers: { list: Promise<Array<{ Id: string; Name: string }>>; expires: number } | undefined;
  readonly #loginAttempts = new AttemptCounter({ windowMs: LOGIN_ATTEMPT_WINDOW_MS, maxKeys: MAX_LOGIN_CLIENTS });
  readonly #libraryJoinAttempts = new AttemptCounter({ windowMs: LIBRARY_JOIN_WINDOW_MS, maxKeys: MAX_LOGIN_CLIENTS });
  readonly #libraryJoin: HouseholdGatewayOptions['libraryJoin'];
  readonly #app: HouseholdGatewayOptions['app'];
  readonly #appAssets: HouseholdGatewayOptions['appAssets'];
  readonly #libraryJoinsByUser = new AttemptCounter({ windowMs: LIBRARY_JOIN_WINDOW_MS, maxKeys: MAX_LOGIN_CLIENTS });
  readonly #libraryJoinsInAll = new AttemptCounter({ windowMs: LIBRARY_JOIN_WINDOW_MS, maxKeys: 1 });
  readonly #webSocketIdleTimeoutMs: number;
  readonly #webSocketUpstreamIdleTimeoutMs: number;
  readonly #debug: boolean;
  readonly #clientIp: ClientIpResolver;
  /** Every upgrade in progress or established, keyed by its client socket, with the function that closes it. */
  readonly #webSockets = new Map<Duplex, () => void>();
  #closing = false;

  public constructor(options: HouseholdGatewayOptions) {
    this.#target = new URL(options.jellyfinUrl);
    if (this.#target.protocol !== 'http:' && this.#target.protocol !== 'https:') {
      throw new Error('household gateway requires an HTTP(S) Jellyfin URL');
    }
    this.#domain = options.domain.toLowerCase();
    this.#hostPrefix = options.hostPrefix.toLowerCase();
    this.#memberIds = options.memberIds;
    this.#isPasswordless = options.isPasswordless ?? (() => false);
    this.#users = options.users;
    this.#loginFailureDelayMs = options.loginFailureDelayMs ?? DEFAULT_LOGIN_FAILURE_DELAY_MS;
    this.#loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.#webSocketIdleTimeoutMs = options.webSocketIdleTimeoutMs ?? DEFAULT_WS_IDLE_TIMEOUT_MS;
    this.#webSocketUpstreamIdleTimeoutMs = options.webSocketUpstreamIdleTimeoutMs ?? DEFAULT_WS_UPSTREAM_IDLE_TIMEOUT_MS;
    this.#debug = options.logLevel === 'debug';
    this.#clientIp = new ClientIpResolver(options.trustedProxies);
    this.#libraryJoin = options.libraryJoin;
    this.#app = options.app;
    this.#appAssets = options.app ? options.appAssets : undefined;
  }

  public householdId(hostHeader: string | undefined): string | undefined {
    if (!hostHeader) return undefined;
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    const suffix = `.${this.#domain}`;
    if (!hostname.endsWith(suffix)) return undefined;
    const label = hostname.slice(0, -suffix.length);
    if (!label.startsWith(this.#hostPrefix)) return undefined;
    const householdId = label.slice(this.#hostPrefix.length);
    return /^[a-z0-9_-]{1,128}$/.test(householdId) ? householdId : undefined;
  }

  public householdUrl(householdId: string): string | undefined {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(householdId)) return undefined;
    return `https://${this.#hostPrefix}${householdId}.${this.#domain}`;
  }

  public async handle(request: IncomingMessage, response: ServerResponse, householdId: string): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname.toLowerCase();
    const appPath = pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`);
    const memberIds = this.#memberIds(householdId);
    if (!memberIds) {
      // No CDN may keep any answer under /jellypass/app, this one included (see NEVER_STORE).
      writeJson(response, 404, { error: 'household_not_found' }, appPath ? NEVER_STORE : {});
      return;
    }
    if (appPath) {
      // The app's own files carry nothing user-specific and need no credentials; the API under /v1 always does.
      // Files only at their exact (lower-case) paths: another spelling is an unknown app path, like any other.
      if (this.#appAssets?.serve(request, response, requestUrl.pathname)) return;
      // Every other answer here, whatever writes it (an unknown file, the API, its errors), is never stored by a CDN.
      for (const [name, value] of Object.entries(NEVER_STORE)) response.setHeader(name, value);
      await this.#householdApp(request, response, requestUrl, householdId, memberIds);
      return;
    }
    if (request.method === 'GET' && pathname === PUBLIC_USERS_PATH) {
      await this.#proxyPublicUsers(request, response, memberIds);
      return;
    }
    if (request.method === 'GET' && pathname === BRANDING_CONFIGURATION_PATH) {
      await this.#proxyBrandingConfiguration(request, response);
      return;
    }
    if (request.method === 'GET' && pathname === QUICK_CONNECT_ENABLED_PATH) {
      writeJson(response, 200, false);
      return;
    }
    if (request.method === 'POST' && FORGOT_PASSWORD_PATHS.has(pathname)) {
      writeJson(response, 403, { error: 'household_password_recovery_disabled' });
      return;
    }
    if (request.method === 'POST' && pathname === LOGOUT_PATH) {
      // Forgotten before Jellyfin is asked, whatever it answers: only the tokens this sign-out itself carries.
      this.#app?.forget(tokenKeys(this.#credentials(request, requestUrl)));
    }
    if (request.method === 'POST' && pathname === AUTHENTICATE_BY_NAME_PATH) {
      await this.#proxyHouseholdLogin(request, response, memberIds);
      return;
    }
    if (this.#libraryJoin) {
      const libraryJoinAsset = LIBRARY_JOIN_ASSETS[pathname];
      if (request.method === 'GET' && libraryJoinAsset) {
        writeAsset(response, libraryJoinAsset.body, libraryJoinAsset.contentType);
        return;
      }
      if (request.method === 'POST' && pathname === LIBRARY_JOIN_PATH) {
        await this.#joinLibrary(request, response, requestUrl, this.#libraryJoin);
        return;
      }
    }
    const streamedItemId = protectedResourceItemId(requestUrl.pathname);
    if (streamedItemId) {
      try {
        if (!await this.#canAccessItem(request, requestUrl, streamedItemId)) {
          writeJson(response, 404, { error: 'item_not_found' });
          return;
        }
      } catch {
        writeJson(response, 502, { error: 'jellyfin_unavailable' });
        return;
      }
    }
    await this.#proxy(request, response);
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, householdId: string): void {
    const exchange = this.#exchange();
    // Node's HTTP server detaches its own socket error listener before emitting 'upgrade', so a client
    // reset (ECONNRESET/EPIPE) on an unguarded upgrade socket is an unhandled 'error' event that kills the process.
    socket.on('error', (error) => {
      exchange.error('client', 'websocket client socket', error);
      socket.destroy();
    });
    if (this.#closing) {
      socket.end(`HTTP/1.1 503 Service Unavailable\r\n${neverStoreHeaders()}Connection: close\r\n\r\n`);
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname.toLowerCase();
    const appPath = pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`);
    // The app API has no WebSockets, and its paths are never proxied to Jellyfin.
    if (!this.#memberIds(householdId) || appPath) {
      socket.end(`HTTP/1.1 404 Not Found\r\n${appPath ? neverStoreHeaders() : ''}Connection: close\r\n\r\n`);
      return;
    }
    const upstream = this.#transport().request(this.#requestOptions(request));
    let upgraded = false;
    this.#webSockets.set(socket, () => {
      exchange.clientGone();
      upstream.destroy();
      socket.destroy();
    });
    socket.once('close', () => this.#webSockets.delete(socket));
    // HTTP server sockets allow half-open connections, so a client that sends FIN while the upstream upgrade is
    // pending emits 'end' but never 'close'; abort on either so the upstream request is not left dangling.
    const abortPending = () => {
      if (upgraded) return;
      exchange.clientGone();
      upstream.destroy();
      socket.destroy();
    };
    socket.once('end', abortPending);
    socket.once('close', abortPending);
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      upgraded = true;
      upstreamSocket.on('error', (error) => {
        exchange.error('upstream', 'websocket upstream socket', error);
        upstreamSocket.destroy();
      });
      if (socket.destroyed || this.#closing) {
        upstreamSocket.destroy();
        socket.destroy();
        return;
      }
      const status = upstreamResponse.statusCode ?? 101;
      socket.write(`HTTP/1.1 ${status} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}\r\n`);
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        socket.write(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}\r\n`);
      }
      socket.write('\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      // A peer that vanishes without FIN/RST (sleeping TV, dropped NAT mapping) never surfaces as an error on its own:
      // TCP keepalive lets the kernel notice a dead peer, and the idle timers close connections with no traffic at all
      // or whose Jellyfin side has gone quiet while the client keeps sending KeepAlives into the void.
      enableTcpKeepAlive(socket);
      enableTcpKeepAlive(upstreamSocket);
      const closeBoth = (message: string, timeoutMs: number) => {
        this.#logDebug(message, { timeoutMs });
        socket.destroy();
        upstreamSocket.destroy();
      };
      const idleTimer = unrefTimer(this.#webSocketIdleTimeoutMs, () =>
        closeBoth('household gateway websocket idle timeout', this.#webSocketIdleTimeoutMs));
      const upstreamIdleTimer = unrefTimer(this.#webSocketUpstreamIdleTimeoutMs, () =>
        closeBoth('household gateway websocket upstream idle timeout', this.#webSocketUpstreamIdleTimeoutMs));
      socket.on('data', () => idleTimer?.refresh());
      upstreamSocket.on('data', () => {
        idleTimer?.refresh();
        upstreamIdleTimer?.refresh();
      });
      const clearTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(upstreamIdleTimer);
      };
      // The relay is a byte pipe that never parses frames, so it cannot inject a WebSocket close frame without risking
      // one in the middle of a relayed frame. Shutdown instead sends FIN both ways and destroys whatever lingers.
      this.#webSockets.set(socket, () => {
        clearTimers();
        upstreamSocket.unpipe(socket);
        socket.unpipe(upstreamSocket);
        socket.end();
        upstreamSocket.end();
        unrefTimer(WS_SHUTDOWN_GRACE_MS, () => {
          socket.destroy();
          upstreamSocket.destroy();
        });
      });
      socket.once('close', () => {
        clearTimers();
        upstreamSocket.destroy();
      });
      upstreamSocket.once('close', () => {
        clearTimers();
        socket.destroy();
      });
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on('response', (upstreamResponse) => {
      upstreamResponse.resume();
      if (!socket.destroyed) {
        socket.end(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
      }
    });
    upstream.on('error', (error) => {
      exchange.error('upstream', 'websocket upstream request', error);
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    upstream.end();
  }

  /**
   * Stops accepting upgrades and closes every proxied WebSocket, pending or established, on both sides. Returns how many
   * were open and resolves once all their client sockets have closed.
   */
  public async closeWebSockets(): Promise<number> {
    this.#closing = true;
    const sockets = [...this.#webSockets.entries()];
    await Promise.all(sockets.map(([socket, close]) => {
      const closed = socket.destroyed ? Promise.resolve() : new Promise<void>((resolve) => socket.once('close', () => resolve()));
      close();
      return closed;
    }));
    return sockets.length;
  }

  #exchange(): Exchange {
    return new Exchange((level, message, fields) => {
      if (level === 'debug') this.#logDebug(message, fields);
      else console.warn(JSON.stringify({ level, message, ...fields }));
    });
  }

  #logDebug(message: string, fields: Record<string, unknown>): void {
    if (this.#debug) console.debug(JSON.stringify({ level: 'debug', message, ...fields }));
  }

  #allowLoginAttempt(clientId: string): boolean {
    if (this.#loginAttempts.attempts(clientId) >= MAX_LOGIN_ATTEMPTS) return false;
    this.#loginAttempts.increment(clientId);
    return true;
  }

  /**
   * The household app API. Identity comes only from Jellyfin, through the same GET /Users/Me check as "Add to my
   * library" and protected media; Jellyfin reads made for the app use the caller's own credentials, so Jellyfin applies
   * the caller's own access. The app decides everything else.
   */
  async #householdApp(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
    householdId: string,
    memberIds: string[],
  ): Promise<void> {
    if (!this.#app) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }
    const credentials = this.#credentials(request, requestUrl);
    await this.#app.handle(request, response, {
      householdId,
      memberIds,
      origin: `https://${this.#hostPrefix}${householdId}.${this.#domain}`,
      clientId: this.#clientAddress(request),
      credentialKey: credentialKey(credentials),
      tokenKeys: tokenKeys(credentials),
      currentUser: async () => {
        const user = (await this.#userFor(credentials, { serverErrorsThrow: true }))?.user;
        return user ? callerOf(user) : undefined;
      },
      getAsCaller: (pathname, query) => this.#callerJson(credentials, pathname, query),
    });
  }

  /**
   * Household "Add to my library". Identity comes only from Jellyfin: the caller's own token is checked with
   * GET /Users/Me, exactly as for protected media. Rate limiting, authentication and input validation answer the same
   * for every title. Past them the join is started in the background and every case gets the same 202 at once: nothing
   * that depends on the title (Seerr, the write queue, Jellyfin) is awaited before answering.
   */
  async #joinLibrary(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
    libraryJoin: NonNullable<HouseholdGatewayOptions['libraryJoin']>,
  ): Promise<void> {
    if (this.#closing) {
      writeJson(response, 503, { error: 'shutting_down' });
      return;
    }
    const clientId = this.#clientAddress(request);
    if (this.#libraryJoinAttempts.attempts(clientId) >= MAX_LIBRARY_JOINS) {
      writeJson(response, 429, { error: 'too_many_requests' });
      return;
    }
    this.#libraryJoinAttempts.increment(clientId);
    let user: CurrentUser | undefined;
    try {
      user = (await this.#currentUser(request, requestUrl))?.user;
    } catch {
      writeJson(response, 502, { error: 'jellyfin_unavailable' });
      return;
    }
    if (!user || user.Policy?.IsDisabled === true) {
      writeJson(response, 401, { error: 'unauthorized' });
      return;
    }
    let media: { mediaType: 'movie' | 'tv'; tmdbId: number };
    try {
      media = libraryJoinInput(JSON.parse((await readLimitedBody(request, MAX_LIBRARY_JOIN_BODY_BYTES)).toString('utf8')) as unknown);
    } catch {
      writeJson(response, 400, { error: 'invalid_request' });
      return;
    }
    if (this.#closing) {
      writeJson(response, 503, { error: 'shutting_down' });
      return;
    }
    // Every such call is counted against its user, started or not; only a call the user's budget admits is counted
    // against the shared one, so one user cannot use up more of it than their own budget.
    const overBudget = this.#libraryJoinsByUser.increment(user.Id.toLowerCase()) > MAX_LIBRARY_JOINS_STARTED_PER_USER
      || this.#libraryJoinsInAll.increment('all') > MAX_LIBRARY_JOINS_STARTED;
    if (overBudget) {
      this.#logDebug('household library join dropped: over budget', { clientId });
      libraryJoin.dropped?.();
    } else if (!libraryJoin.start({ userId: user.Id, isAdministrator: user.Policy?.IsAdministrator === true, ...media })) {
      writeJson(response, 503, { error: 'shutting_down' });
      return;
    }
    writeJson(response, 202, LIBRARY_JOIN_ACCEPTED);
  }

  /**
   * Household sign-in. Jellyfin's own AuthenticateByName is not scoped to a household; without this the household
   * hostname would be a generic login proxy for every Jellyfin user, administrators included. The name must belong to a
   * member of this household: it is looked up in Jellyfin's full user list, so a hidden member (left off the picker)
   * signs in by typing their name, matched case-insensitively as Jellyfin matches names. Jellyfin is then asked to sign
   * in that member by their own name, and the user it signs in must be that member, or the new session is revoked and
   * the sign-in refused.
   *
   * Only a sign-in that works is answered by Jellyfin. Every other attempt gets one of three fixed answers, no sooner
   * than #loginFailureDelayMs after it arrived, and none of them depends on whether the name is a member's:
   * - invalid_request, for a request Jellyfin would refuse whoever it named (no client metadata, or a body that is not
   *   a name and a password), decided before any name is looked up;
   * - jellyfin_unavailable, when Jellyfin's user list cannot be read, which is tried for a member and a non-member alike
   *   (a member's sign-in that Jellyfin fails to answer reads the list afresh, as a name not found in a reused one does);
   * - invalid_credentials, for everything else: a name that is no member's, and any answer Jellyfin gives a member but
   *   success, whatever its status.
   */
  async #proxyHouseholdLogin(request: IncomingMessage, response: ServerResponse, memberIds: string[]): Promise<void> {
    if (!this.#allowLoginAttempt(this.#clientAddress(request))) {
      writeJson(response, 429, { error: 'too_many_login_attempts' });
      return;
    }
    const started = performance.now();
    const fail = async (status: number, error: string) => {
      await delay(Math.max(0, this.#loginFailureDelayMs - (performance.now() - started)));
      writeJson(response, status, { error });
    };
    const refuse = () => fail(401, 'invalid_credentials');
    const unavailable = () => fail(502, 'jellyfin_unavailable');
    let credentials: { Username: string; Pw: string } | undefined;
    try {
      credentials = loginCredentials(JSON.parse((await readLimitedBody(request, MAX_LOGIN_BODY_BYTES)).toString('utf8')) as unknown);
    } catch {
      credentials = undefined;
    }
    if (!credentials || !hasLoginClient(request.headers)) return fail(400, 'invalid_request');
    let member: { Id: string; Name: string } | undefined;
    try {
      member = await this.#householdMember(memberIds, credentials.Username);
    } catch {
      return unavailable();
    }
    if (!member) return refuse();
    const answer = await this.#authenticate(request, Buffer.from(JSON.stringify({ Username: member.Name, Pw: credentials.Pw })));
    if (answer?.status === 200) {
      const signedIn = signedInUser(answer.body);
      if (signedIn?.userId.toLowerCase() === member.Id.toLowerCase()) {
        response.writeHead(answer.status, answer.headers);
        response.end(answer.body);
        return;
      }
      if (signedIn) await this.#revoke(signedIn.token);
      return refuse();
    }
    if (answer && answer.status < 500) return refuse();
    // Jellyfin did not answer, or failed: whether it is unavailable is decided as for a name that is no member's.
    try {
      await this.#jellyfinUsers(true);
    } catch {
      return unavailable();
    }
    return refuse();
  }

  /**
   * The member of the household whose name `username` is, as Jellyfin matches names, if any. A name not found in a
   * reused list is looked for again in a fresh one, so a member just added or renamed can sign in at once. Throws if
   * Jellyfin cannot list its users.
   */
  async #householdMember(memberIds: string[], username: string): Promise<{ Id: string; Name: string } | undefined> {
    const allowed = new Set(memberIds.map((id) => id.toLowerCase()));
    const target = username.toLowerCase();
    const find = (users: Array<{ Id: string; Name: string }>) =>
      users.find((user) => allowed.has(user.Id.toLowerCase()) && user.Name.toLowerCase() === target);
    const reused = this.#loginUsers !== undefined && Date.now() < this.#loginUsers.expires;
    const member = find(await this.#jellyfinUsers(false));
    return member || !reused ? member : find(await this.#jellyfinUsers(true));
  }

  /** Jellyfin's users, reused for LOGIN_USERS_TTL_MS unless `fresh`; a failed listing is not reused. */
  #jellyfinUsers(fresh: boolean): Promise<Array<{ Id: string; Name: string }>> {
    const now = Date.now();
    if (!fresh && this.#loginUsers && now < this.#loginUsers.expires) return this.#loginUsers.list;
    const list = (this.#users?.() ?? Promise.resolve([])).then((users) => {
      if (!Array.isArray(users)) throw new Error('Jellyfin users must be an array');
      return users.filter((user) => user && typeof user.Id === 'string' && typeof user.Name === 'string');
    });
    const entry = { list, expires: now + LOGIN_USERS_TTL_MS };
    this.#loginUsers = entry;
    list.catch(() => {
      if (this.#loginUsers === entry) this.#loginUsers = undefined;
    });
    return list;
  }

  /**
   * Sends a sign-in to Jellyfin with the client's own headers and reads the whole answer, or undefined if Jellyfin could
   * not be reached, did not answer within #loginTimeoutMs or its answer was too large.
   */
  async #authenticate(request: IncomingMessage, body: Buffer): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer } | undefined> {
    const exchange = this.#exchange();
    return new Promise((resolve) => {
      const headers: IncomingHttpHeaders = {
        ...request.headers,
        'content-type': 'application/json',
        'content-length': String(body.length),
        accept: 'application/json',
        'accept-encoding': 'identity',
      };
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      delete headers.expect;
      const upstream = this.#transport().request(this.#requestOptions(request, headers), (upstreamResponse) => {
        const chunks: Buffer[] = [];
        let size = 0;
        upstreamResponse.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_LOGIN_RESPONSE_BYTES) upstreamResponse.destroy(new Error('sign-in response is too large'));
          else chunks.push(chunk);
        });
        upstreamResponse.on('error', (error) => {
          exchange.error('upstream', 'household login response', error);
          resolve(undefined);
        });
        // An upstream reset mid-body ends the answer without 'end' (or an error): it is no answer at all.
        upstreamResponse.once('close', () => {
          if (!upstreamResponse.complete) resolve(undefined);
        });
        upstreamResponse.once('end', () => {
          const answer = Buffer.concat(chunks);
          const relayed: IncomingHttpHeaders = { ...upstreamResponse.headers, 'content-length': String(answer.length) };
          delete relayed['transfer-encoding'];
          resolve({ status: upstreamResponse.statusCode ?? 502, headers: relayed, body: answer });
        });
      });
      upstream.setTimeout(this.#loginTimeoutMs, () => upstream.destroy(new Error('household login timed out')));
      upstream.on('error', (error) => {
        exchange.error('upstream', 'household login request', error);
        resolve(undefined);
      });
      upstream.end(body);
    });
  }

  /** Signs a session out at Jellyfin. Best effort: a failure is only logged. */
  async #revoke(token: string): Promise<void> {
    const authorization = `MediaBrowser Client="JellyPass", Device="JellyPass", DeviceId="jellypass-household-gateway", Version="1.0", Token="${encodeURIComponent(token)}"`;
    try {
      const response = await fetch(this.#targetUrl('/Sessions/Logout'), {
        method: 'POST',
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', message: 'household login revoke failed', error: error instanceof Error ? error.message : String(error) }));
    }
  }

  async #proxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await new Promise<void>((resolve) => {
      const exchange = this.#exchange();
      const upstream = this.#transport().request(this.#requestOptions(request), (upstreamResponse) => {
        relayResponse(upstreamResponse, response, exchange, resolve);
      });
      guardUpstream(upstream, response, exchange, resolve);
      request.on('error', (error) => {
        exchange.error('client', 'proxy client request', error);
        upstream.destroy();
      });
      request.once('aborted', () => {
        exchange.clientGone();
        upstream.destroy();
      });
      request.pipe(upstream);
    });
  }

  /**
   * The household's profile picker: Jellyfin's own public list, narrowed to the household's members. Jellyfin leaves
   * hidden (and disabled) users off it, and so does the picker; a hidden member signs in by name instead.
   */
  async #proxyPublicUsers(request: IncomingMessage, response: ServerResponse, memberIds: string[]): Promise<void> {
    const allowed = new Set(memberIds.map((id) => id.toLowerCase()));
    await this.#proxyJson(request, response, 'invalid_jellyfin_public_users', (value) => {
      if (!Array.isArray(value)) throw new Error('public users must be an array');
      return value.filter((user): user is Record<string, unknown> =>
        Boolean(user) && typeof user === 'object' && !Array.isArray(user) &&
        typeof (user as Record<string, unknown>).Id === 'string' &&
        allowed.has(((user as Record<string, unknown>).Id as string).toLowerCase())
      ).map((user) =>
        // Jellyfin reports HasPassword=true even for empty passwords, which makes its web client
        // prompt for a password. Members marked passwordless in JellyPass sign in with one tap.
        this.#isPasswordless(user.Id as string) ? { ...user, HasPassword: false, HasConfiguredPassword: false } : user
      );
    });
  }

  async #proxyBrandingConfiguration(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await this.#proxyJson(request, response, 'invalid_jellyfin_branding_configuration', (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('branding configuration must be an object');
      }
      const branding = value as Record<string, unknown>;
      const existingCss = typeof branding.CustomCss === 'string' ? branding.CustomCss.trim() : '';
      const existingDisclaimer = typeof branding.LoginDisclaimer === 'string' ? branding.LoginDisclaimer.trim() : '';
      const styleElement = `<style id="jellypass-household-profile-picker">${HOUSEHOLD_LOGIN_CSS}</style>`;
      return {
        ...branding,
        CustomCss: existingCss ? `${existingCss}\n${HOUSEHOLD_LOGIN_CSS}` : HOUSEHOLD_LOGIN_CSS,
        LoginDisclaimer: existingDisclaimer ? `${existingDisclaimer}\n${styleElement}` : styleElement,
      };
    });
  }

  async #canAccessItem(request: IncomingMessage, requestUrl: URL, itemId: string): Promise<boolean> {
    const current = await this.#currentUser(request, requestUrl);
    if (!current) return false;
    const itemResponse = await fetch(this.#targetUrl(
      `/Users/${encodeURIComponent(current.user.Id)}/Items/${encodeURIComponent(itemId)}${current.suffix}`,
    ), {
      headers: current.headers,
      signal: AbortSignal.timeout(15_000),
    });
    await itemResponse.body?.cancel();
    return itemResponse.ok;
  }

  /**
   * The Jellyfin user the request's own credentials (authorization headers or token query parameters) belong to, as
   * Jellyfin's GET /Users/Me reports it, or undefined if Jellyfin rejects them. Throws if Jellyfin cannot be reached.
   */
  async #currentUser(request: IncomingMessage, requestUrl: URL): Promise<{ user: CurrentUser; headers: Headers; suffix: string } | undefined> {
    return this.#userFor(this.#credentials(request, requestUrl));
  }

  #credentials(request: IncomingMessage, requestUrl: URL): JellyfinCredentials {
    const headers = new Headers({ Accept: 'application/json' });
    for (const name of ['authorization', 'x-emby-authorization', 'x-emby-token']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const query = new URLSearchParams();
    for (const [name, value] of requestUrl.searchParams) {
      if (['apikey', 'api_key', 'access_token'].includes(name.toLowerCase()) && value) {
        query.append(name, value);
      }
    }
    return { headers, query };
  }

  /**
   * See {@link #currentUser}. With `serverErrorsThrow`, a 5xx from Jellyfin throws like an unreachable Jellyfin instead
   * of counting as rejected credentials.
   */
  async #userFor(
    credentials: JellyfinCredentials,
    options: { serverErrorsThrow?: boolean } = {},
  ): Promise<{ user: CurrentUser; headers: Headers; suffix: string } | undefined> {
    const { headers } = credentials;
    const suffix = credentials.query.size ? `?${credentials.query}` : '';
    const currentUserResponse = await fetch(this.#targetUrl(`/Users/Me${suffix}`), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!currentUserResponse.ok) {
      await currentUserResponse.body?.cancel();
      if (options.serverErrorsThrow && currentUserResponse.status >= 500) {
        throw new Error(`Jellyfin GET /Users/Me returned ${currentUserResponse.status}`);
      }
      return undefined;
    }
    const currentUser = await currentUserResponse.json() as { Id?: unknown; Name?: unknown; Policy?: unknown };
    if (typeof currentUser.Id !== 'string' || !currentUser.Id) return undefined;
    const policy = currentUser.Policy && typeof currentUser.Policy === 'object' ? currentUser.Policy as CurrentUser['Policy'] : undefined;
    return {
      user: {
        Id: currentUser.Id,
        ...(typeof currentUser.Name === 'string' ? { Name: currentUser.Name } : {}),
        ...(policy ? { Policy: policy } : {}),
      },
      headers,
      suffix,
    };
  }

  /**
   * A Jellyfin GET made with the caller's own credentials, so Jellyfin answers with what that caller may see. Never
   * follows a redirect; reads at most MAX_CALLER_JSON_BYTES. Errors name only the path and status.
   */
  async #callerJson(credentials: JellyfinCredentials, pathname: string, query: URLSearchParams): Promise<unknown> {
    const url = this.#targetUrl(pathname);
    for (const [name, value] of query) url.searchParams.append(name, value);
    for (const [name, value] of credentials.query) url.searchParams.append(name, value);
    const response = await fetch(url, {
      headers: credentials.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Jellyfin GET ${pathname} returned ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_CALLER_JSON_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Jellyfin GET ${pathname} response is too large`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_CALLER_JSON_BYTES) throw new Error(`Jellyfin GET ${pathname} response is too large`);
        chunks.push(chunk);
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new Error(`Jellyfin GET ${pathname} returned invalid JSON`);
    }
  }

  async #proxyJson(
    request: IncomingMessage,
    response: ServerResponse,
    invalidResponseCode: string,
    transform: (value: unknown) => unknown,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const headers: IncomingHttpHeaders = { ...request.headers, 'accept-encoding': 'identity' };
      const exchange = this.#exchange();
      const upstream = this.#transport().request(this.#requestOptions(request, headers), (upstreamResponse) => {
        const chunks: Buffer[] = [];
        let size = 0;
        upstreamResponse.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_TRANSFORMED_JSON_BYTES) upstreamResponse.destroy(new Error('JSON response is too large'));
          else chunks.push(chunk);
        });
        upstreamResponse.on('error', (error) => {
          exchange.error('upstream', 'proxy upstream response', error);
          if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
          resolve();
        });
        upstreamResponse.once('close', () => {
          if (upstreamResponse.complete) return;
          if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
          resolve();
        });
        upstreamResponse.once('end', () => {
          if (response.headersSent) return resolve();
          const body = Buffer.concat(chunks);
          if (upstreamResponse.statusCode !== 200) {
            response.writeHead(upstreamResponse.statusCode ?? 502, sanitizedHeaders(upstreamResponse.headers, body.length));
            response.end(body);
            return resolve();
          }
          try {
            const encoded = Buffer.from(JSON.stringify(transform(JSON.parse(body.toString('utf8')) as unknown)));
            response.writeHead(200, sanitizedHeaders(upstreamResponse.headers, encoded.length));
            response.end(encoded);
          } catch {
            writeJson(response, 502, { error: invalidResponseCode });
          }
          resolve();
        });
      });
      guardUpstream(upstream, response, exchange, resolve);
      upstream.end();
    });
  }

  #requestOptions(request: IncomingMessage, headersInput?: IncomingHttpHeaders): RequestOptions {
    const headers = { ...(headersInput ?? request.headers) };
    headers.host = this.#target.host;
    if (request.headers.host) headers['x-forwarded-host'] = request.headers.host;
    // Jellyfin (with JellyPass in KnownProxies) and its logs see the household client rather than this gateway only if
    // each hop appends its own peer. Existing entries are kept: Jellyfin decides which of them it trusts.
    const peer = normaliseIp(request.socket.remoteAddress);
    if (peer) {
      const forwardedFor = joinedHeader(headers['x-forwarded-for']);
      headers['x-forwarded-for'] = forwardedFor ? `${forwardedFor}, ${peer}` : peer;
    }
    headers['x-forwarded-proto'] ??= 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http';
    headers['x-real-ip'] ??= this.#clientAddress(request);
    return {
      protocol: this.#target.protocol,
      hostname: this.#target.hostname,
      port: this.#target.port || (this.#target.protocol === 'https:' ? 443 : 80),
      method: request.method,
      path: targetPath(this.#target, request.url ?? '/'),
      headers,
    };
  }

  #clientAddress(request: IncomingMessage): string {
    return this.#clientIp.resolve(request.socket.remoteAddress, request.headers['x-forwarded-for']);
  }

  #transport(): typeof http | typeof https {
    return this.#target.protocol === 'https:' ? https : http;
  }

  #targetUrl(pathname: string): URL {
    const url = new URL(this.#target.origin);
    const [path, query = ''] = targetPath(this.#target, pathname).split('?', 2);
    url.pathname = path as string;
    url.search = query;
    return url;
  }
}

const DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED']);
// TCP keepalive reports a client that vanished (sleeping TV, roaming phone) as ETIMEDOUT/EHOSTUNREACH. On the
// Jellyfin side the same codes mean the server or its network is unreachable, which is worth a warning.
const CLIENT_DISCONNECT_CODES = new Set([...DISCONNECT_CODES, 'ETIMEDOUT', 'EHOSTUNREACH']);

type ExchangeLog = (level: 'debug' | 'warn', message: string, fields: Record<string, unknown>) => void;

/**
 * Classifies stream errors for one proxied request or WebSocket. Client disconnects are routine (media seeks/skips,
 * closed tabs, sleeping TVs) and only logged with LOG_LEVEL=debug. Jellyfin-side errors log as warnings unless they are
 * the consequence of a failure already seen: our own abort after the client left ("socket hang up"/"aborted") or a
 * follow-on error from the same upstream reset.
 */
class Exchange {
  #firstFailure: 'client' | 'upstream' | undefined;

  public constructor(private readonly log: ExchangeLog) {}

  public clientGone(): void {
    this.#firstFailure ??= 'client';
  }

  public error(side: 'client' | 'upstream', context: string, error: unknown): void {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    const disconnect = code !== undefined && (side === 'client' ? CLIENT_DISCONNECT_CODES : DISCONNECT_CODES).has(code);
    const expected = disconnect && (side === 'client' || this.#firstFailure !== undefined);
    this.#firstFailure ??= side;
    this.log(expected ? 'debug' : 'warn', `household gateway ${context} error`, {
      code,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function unrefTimer(timeoutMs: number, callback: () => void): NodeJS.Timeout | undefined {
  if (timeoutMs <= 0) return undefined;
  const timer = setTimeout(callback, timeoutMs);
  timer.unref();
  return timer;
}

function enableTcpKeepAlive(socket: Duplex): void {
  if ('setKeepAlive' in socket && typeof socket.setKeepAlive === 'function') {
    (socket as Socket).setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
  }
}

function guardUpstream(upstream: http.ClientRequest, response: ServerResponse, exchange: Exchange, resolve: () => void): void {
  upstream.on('error', (error) => {
    exchange.error('upstream', 'proxy upstream request', error);
    if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
    else response.destroy();
    resolve();
  });
  response.on('error', (error) => {
    exchange.error('client', 'proxy client response', error);
    upstream.destroy();
  });
  response.once('close', () => {
    if (!response.writableFinished) {
      exchange.clientGone();
      upstream.destroy();
    }
    resolve();
  });
}

function relayResponse(upstreamResponse: IncomingMessage, response: ServerResponse, exchange: Exchange, resolve: () => void): void {
  upstreamResponse.on('error', (error) => {
    exchange.error('upstream', 'proxy upstream response', error);
    response.destroy();
  });
  // An upstream reset mid-body aborts the response without 'end'; tear down the client side instead of hanging.
  upstreamResponse.once('close', () => {
    if (!upstreamResponse.complete) response.destroy();
  });
  response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
  upstreamResponse.pipe(response);
  upstreamResponse.once('end', resolve);
}

async function readLimitedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function libraryJoinInput(value: unknown): { mediaType: 'movie' | 'tv'; tmdbId: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object');
  const { mediaType, tmdbId } = value as Record<string, unknown>;
  if (mediaType !== 'movie' && mediaType !== 'tv') throw new Error('mediaType must be movie or tv');
  if (typeof tmdbId !== 'number' || !Number.isSafeInteger(tmdbId) || tmdbId < 1 || tmdbId > 2_147_483_647) {
    throw new Error('tmdbId must be a positive integer');
  }
  return { mediaType, tmdbId };
}

function protectedResourceItemId(pathname: string): string | undefined {
  const media = pathname.match(/^\/(?:videos|audio)\/([^/]+)\/(?:stream(?:\.[^/]*)?|master\.m3u8|main\.m3u8)$/i);
  if (media) return decodeURIComponent(media[1] as string);
  const download = pathname.match(/^\/items\/([^/]+)\/download$/i);
  return download ? decodeURIComponent(download[1] as string) : undefined;
}

/**
 * A hash of the credentials a request carries, to key the app's short-lived cache of who they belong to, or undefined
 * when it carries none.
 */
function credentialKey(credentials: JellyfinCredentials): string | undefined {
  const parts = [...credentials.headers].filter(([name]) => name !== 'accept').sort(([a], [b]) => a.localeCompare(b));
  const query = [...credentials.query].sort(([a], [b]) => a.localeCompare(b));
  if (!parts.length && !query.length) return undefined;
  return createHash('sha256').update(JSON.stringify([parts, query])).digest('hex');
}

/**
 * A hash of each Jellyfin token the credentials carry, however each is given: `Token` in an `Authorization` or
 * `X-Emby-Authorization` header (URL-decoded, as Jellyfin reads it), `X-Emby-Token`, or a token query parameter.
 */
function tokenKeys(credentials: JellyfinCredentials): string[] {
  const tokens = new Set<string>();
  for (const name of ['authorization', 'x-emby-authorization']) {
    const value = credentials.headers.get(name);
    const token = value ? authorizationToken(value) : undefined;
    if (token) tokens.add(token);
  }
  const embyToken = credentials.headers.get('x-emby-token');
  if (embyToken) tokens.add(embyToken);
  for (const [, value] of credentials.query) tokens.add(value);
  return [...tokens].map((token) => createHash('sha256').update(`token\n${token}`).digest('hex'));
}

/** The `Token` of a `MediaBrowser key="value", ...` header, or undefined if it has none. */
function authorizationToken(header: string): string | undefined {
  const parameters = header.trim().replace(/^[A-Za-z]+\s+/, '');
  for (const part of parameters.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim().toLowerCase() !== 'token') continue;
    const raw = part.slice(separator + 1).trim().replace(/^"|"$/g, '');
    let token = raw;
    try {
      token = decodeURIComponent(raw);
    } catch {
      // Not URL-encoded: the token as given.
    }
    return token || undefined;
  }
  return undefined;
}

/** The user and token in a successful AuthenticateByName answer, or undefined if it has none. */
/** A sign-in body Jellyfin takes: a name and a password, both strings. Anything else in it is dropped. */
function loginCredentials(value: unknown): { Username: string; Pw: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { Username, Pw } = value as Record<string, unknown>;
  return typeof Username === 'string' && typeof Pw === 'string' ? { Username, Pw } : undefined;
}

/**
 * Whether a sign-in names its client as Jellyfin requires: every Authorization or X-Emby-Authorization header given
 * (at least one) uses the MediaBrowser (or Emby) scheme and has a non-empty Client, Device, DeviceId and Version.
 */
function hasLoginClient(headers: IncomingHttpHeaders): boolean {
  const given = [headers.authorization, headers['x-emby-authorization']].flat().filter((value) => value !== undefined);
  return given.length > 0 && given.every((value) => {
    const match = /^\s*(mediabrowser|emby)\s+(.*)$/is.exec(value);
    if (!match) return false;
    const fields = new Map<string, string>();
    for (const part of (match[2] as string).split(',')) {
      const field = /^\s*([a-z]+)\s*=\s*"?([^"]*)"?\s*$/i.exec(part);
      if (field) fields.set((field[1] as string).toLowerCase(), (field[2] as string).trim());
    }
    return LOGIN_CLIENT_FIELDS.every((name) => Boolean(fields.get(name)));
  });
}

function neverStoreHeaders(): string {
  return Object.entries(NEVER_STORE).map(([name, value]) => `${name}: ${value}\r\n`).join('');
}

function signedInUser(body: Buffer): { userId: string; token: string } | undefined {
  let answer: unknown;
  try {
    answer = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (!answer || typeof answer !== 'object') return undefined;
  const { User: user, AccessToken: token } = answer as Record<string, unknown>;
  const userId = user && typeof user === 'object' ? (user as Record<string, unknown>).Id : undefined;
  return typeof userId === 'string' && typeof token === 'string' && token ? { userId, token } : undefined;
}

function callerOf(user: CurrentUser): JellyfinCaller {
  return { id: user.Id, name: user.Name ?? '', disabled: user.Policy?.IsDisabled === true };
}

function joinedHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value.join(', ') : value ?? '').trim();
}

function targetPath(target: URL, requestUrl: string): string {
  const base = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
  return `${base}${requestUrl.startsWith('/') ? requestUrl : `/${requestUrl}`}`;
}

function sanitizedHeaders(headers: IncomingHttpHeaders, contentLength: number): IncomingHttpHeaders {
  const result = { ...headers };
  delete result['content-encoding'];
  delete result['transfer-encoding'];
  result['content-type'] = 'application/json; charset=utf-8';
  result['content-length'] = String(contentLength);
  result['cache-control'] = 'no-store';
  result['x-content-type-options'] = 'nosniff';
  return result;
}

function writeAsset(response: ServerResponse, body: string, contentType: string): void {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  response.end(body);
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(encoded);
}
