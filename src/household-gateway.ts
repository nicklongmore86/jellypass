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
import type { TvAssets } from './tv-assets.js';
import { applyTvCors, corsFamily } from './tv-cors.js';

const PUBLIC_USERS_PATH = '/users/public';
const BRANDING_CONFIGURATION_PATH = '/branding/configuration';
const QUICK_CONNECT_ENABLED_PATH = '/quickconnect/enabled';
/** Quick Connect: every route under it, and the sign-in it ends in, which Jellyfin does not scope to a household. */
const QUICK_CONNECT_PATH = '/quickconnect';
const AUTHENTICATE_WITH_QUICK_CONNECT_PATH = '/users/authenticatewithquickconnect';
/** The Streamyfin plugin's routes, which hand its settings (Seerr's keys among them) to any signed-in user. */
const STREAMYFIN_PATH = '/streamyfin';
/**
 * The Jellyfin Enhanced plugin's routes (12.13) that a household host answers itself, each with every path below it:
 * - those that relay Seerr (or Sonarr and Radarr, which Seerr's requests feed): their answers carry other users'
 *   requests and their requesters, and they take requests past the household app's own checks. Of its `tmdb` routes
 *   only these four go to Seerr (its search and genre lists); `tmdb/validate` and the rest of `tmdb/...` go to TMDB
 *   with the plugin's own key, carry nothing from Seerr and are relayed.
 * - `reviews`, read and write: they hand out other users' reviews and names without checking that the caller may see
 *   the item.
 * - `items/by-providers`: it looks a provider ID up across the whole library without checking that the caller may see
 *   what it finds.
 * Its other routes (its scripts and settings among them) are relayed.
 */
const JELLYFIN_ENHANCED_REFUSED_PATHS = [
  '/jellyfinenhanced/jellyseerr',
  '/jellyfinenhanced/arr',
  '/jellyfinenhanced/proxy',
  '/jellyfinenhanced/tmdb/search/person',
  '/jellyfinenhanced/tmdb/search/keyword',
  '/jellyfinenhanced/tmdb/genres/movie',
  '/jellyfinenhanced/tmdb/genres/tv',
  '/jellyfinenhanced/reviews',
  '/jellyfinenhanced/items/by-providers',
];
const AUTHENTICATE_BY_NAME_PATH = '/users/authenticatebyname';
/** Jellyfin's obsolete sign-in by user ID and password, still routed in 10.11 and, like AuthenticateByName, not scoped to a household. */
const AUTHENTICATE_BY_ID_ROUTE = /^\/users\/([^/]+)\/authenticate$/;
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
/** How long the Jellyfin user a request's credentials belong to (or that Jellyfin rejects them) is reused. */
const TOKEN_OWNER_TTL_MS = 60_000;
/** Most credentials whose Jellyfin user is kept at once; the oldest go first. */
const MAX_TOKEN_OWNERS = 10_000;
/** The fixed answer to a request whose token is not a member's of the household, whether or not Jellyfin knows it. */
const NOT_A_MEMBER = { error: 'unauthorized' };
/** The least time a refused household sign-in takes, so its timing does not tell why it was refused. */
const DEFAULT_LOGIN_FAILURE_DELAY_MS = 1000;
/** How long a household sign-in waits for Jellyfin's answer before it counts as no answer. */
const DEFAULT_LOGIN_TIMEOUT_MS = 15_000;
/** How long a sign-out (POST /Sessions/Logout) may take at Jellyfin in all, whether or not its client is still there. */
const DEFAULT_SIGN_OUT_TIMEOUT_MS = 15_000;
/** The client metadata Jellyfin requires of every sign-in: without any of it Jellyfin refuses with a 400. */
const LOGIN_CLIENT_FIELDS = ['client', 'device', 'deviceid', 'version'];
const LIBRARY_JOIN_PATH = '/jellypass/add';
const APP_PATH = '/jellypass/app';
/** The TV add-on's files, on a household host it is on for (see docs/tv-addon.md). */
const TV_PATH = '/jellypass/tv';
/** The routes Jellyfin answers with Jellyfin web's page: `/web/` (the trailing slash is not part of a route) and `/web/index.html`. */
const WEB_PAGE_ROUTES = new Set(['/web', '/web/index.html']);
/** Largest Jellyfin web page the TV add-on is added to, in bytes; a larger one is relayed as it is. */
const MAX_WEB_PAGE_BYTES = 1024 * 1024;
/**
 * Request headers not sent to Jellyfin for its web page when the TV add-on is added to it: the page must come back
 * whole (no range), unencoded (so the tag can be added) and fresh (a 304 would leave the browser on a copy without it).
 */
const WEB_PAGE_DROPPED_REQUEST_HEADERS = ['accept-encoding', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since'];
/** Jellyfin's answer headers that no longer describe the page once the tag is added to it. */
const WEB_PAGE_DROPPED_RESPONSE_HEADERS = ['content-length', 'transfer-encoding', 'etag', 'last-modified', 'content-md5', 'digest', 'accept-ranges', 'cache-control', 'expires', 'pragma', 'age'];
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
  /** How long a sign-out may take at Jellyfin in all, in milliseconds (default DEFAULT_SIGN_OUT_TIMEOUT_MS). */
  signOutTimeoutMs?: number;
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
  /**
   * The TV add-on (docs/tv-addon.md), on the household hosts `enabled` says: their Jellyfin web page (`/web/`,
   * `/web/index.html`) gets one `<script>` for it, and /jellypass/tv/* serves its files. Every other household host,
   * and every other path, is answered exactly as without it.
   */
  tvAddon?: { enabled: (householdId: string) => boolean; assets: TvAssets };
}

/** Jellyfin's whole answer, as read by {@link HouseholdGateway.#sendWhole}. */
interface WholeAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A Jellyfin user listing a household host narrows to the household's own members; see HouseholdGateway.#proxyUserList. */
type UserList = 'users' | 'sessions' | 'syncPlayGroups' | 'syncPlayGroup';

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
  readonly #signOutTimeoutMs: number;
  #loginUsers: { list: Promise<Array<{ Id: string; Name: string }>>; expires: number } | undefined;
  /** The Jellyfin user each request's credentials belong to, undefined where Jellyfin rejects them, by credentialKey. */
  readonly #tokenOwners = new Map<string, { owner: Promise<string | undefined>; tokenKeys: string[]; expires: number }>();
  /** The app's verifications at Jellyfin now, with the tokens (hashes) each holds: a sign-out with one of them spoils it. */
  readonly #ownerLookups = new Set<{ tokenKeys: readonly string[]; spoiled: boolean }>();
  readonly #loginAttempts = new AttemptCounter({ windowMs: LOGIN_ATTEMPT_WINDOW_MS, maxKeys: MAX_LOGIN_CLIENTS });
  readonly #libraryJoinAttempts = new AttemptCounter({ windowMs: LIBRARY_JOIN_WINDOW_MS, maxKeys: MAX_LOGIN_CLIENTS });
  readonly #libraryJoin: HouseholdGatewayOptions['libraryJoin'];
  readonly #app: HouseholdGatewayOptions['app'];
  readonly #appAssets: HouseholdGatewayOptions['appAssets'];
  readonly #tvAddon: HouseholdGatewayOptions['tvAddon'];
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
    this.#signOutTimeoutMs = options.signOutTimeoutMs ?? DEFAULT_SIGN_OUT_TIMEOUT_MS;
    this.#webSocketIdleTimeoutMs = options.webSocketIdleTimeoutMs ?? DEFAULT_WS_IDLE_TIMEOUT_MS;
    this.#webSocketUpstreamIdleTimeoutMs = options.webSocketUpstreamIdleTimeoutMs ?? DEFAULT_WS_UPSTREAM_IDLE_TIMEOUT_MS;
    this.#debug = options.logLevel === 'debug';
    this.#clientIp = new ClientIpResolver(options.trustedProxies);
    this.#libraryJoin = options.libraryJoin;
    this.#app = options.app;
    this.#appAssets = options.app ? options.appAssets : undefined;
    this.#tvAddon = options.tvAddon;
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
    if (hasEmptyPathSegment(request.url ?? '/')) {
      writeJson(response, 404, { error: 'not_found' }, NEVER_STORE);
      return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    // Every decision below is made on the route Jellyfin takes the path to, never on the path as spelled.
    const route = jellyfinRoute(request.url ?? '/');
    const appPath = route !== undefined && isAppRoute(route);
    const memberIds = this.#memberIds(householdId);
    if (!memberIds) {
      // No CDN may keep any answer under /jellypass/app, this one included (see NEVER_STORE).
      writeJson(response, 404, { error: 'household_not_found' }, appPath ? NEVER_STORE : {});
      return;
    }
    const tv = this.#tvAssetsFor(householdId);
    const decision = route === undefined ? undefined : this.#decide(request.method, route, requestUrl.searchParams, tv !== undefined);
    if (decision === undefined) {
      // Jellyfin might route it otherwise than the gateway reads it, so no check here can be trusted to apply.
      writeJson(response, 400, { error: 'invalid_request' }, NEVER_STORE);
      return;
    }
    // The Samsung app (another origin) reads the app API and the add-on's files on a household host the add-on is on for;
    // its preflight is answered here, before any token is looked at (see tv-cors.ts).
    if (tv && (decision.kind === 'app' || decision.kind === 'tvAsset')) {
      const family = corsFamily((request.url ?? '/').split('?', 1)[0] as string);
      if (family === (decision.kind === 'app' ? 'api' : 'tv') && applyTvCors(request, response, family)) return;
    }
    if (TOKEN_CHECKED_KINDS.has(decision.kind)) {
      // A token works on a household host only for that household's members: anyone else's, and one Jellyfin does not
      // know, get the same fixed answer, so it tells nothing about the token.
      let member: boolean;
      try {
        member = await this.#tokenIsMember(this.#credentials(request, requestUrl), memberIds);
      } catch {
        writeJson(response, 502, { error: 'jellyfin_unavailable' });
        return;
      }
      if (!member) {
        writeJson(response, 401, NOT_A_MEMBER);
        return;
      }
    }
    switch (decision.kind) {
      case 'app':
        // The app's own files carry nothing user-specific and need no credentials; the API under /v1 always does.
        // Files only at their exact (lower-case) paths: another spelling is an unknown app path, like any other.
        if (this.#appAssets?.serve(request, response, (request.url ?? '/').split('?', 1)[0] as string)) return;
        // Every other answer here, whatever writes it (an unknown file, the API, its errors), is never stored by a CDN.
        for (const [name, value] of Object.entries(NEVER_STORE)) response.setHeader(name, value);
        await this.#householdApp(request, response, requestUrl, householdId, memberIds);
        return;
      case 'tvAsset':
        if ((tv as TvAssets).serve(request, response, (request.url ?? '/').split('?', 1)[0] as string)) return;
        writeJson(response, 404, { error: 'not_found' });
        return;
      case 'webPage':
        await this.#proxyWebPage(request, response, tv as TvAssets);
        return;
      case 'publicUsers':
        await this.#proxyPublicUsers(request, response, memberIds);
        return;
      case 'webConfig':
        // Jellyfin web appends `/System/Info/Public` and API paths to configured server URLs.
        // Remove trailing separators here so a legitimate client never generates an empty segment.
        await this.#proxyJson(request, response, 'invalid_web_config', (value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
          const config = value as Record<string, unknown>;
          if (!Array.isArray(config.servers)) return value;
          return { ...config, servers: config.servers.map((server: unknown) => {
            if (typeof server !== 'string') return server;
            try {
              const url = new URL(server);
              return !url.search && !url.hash && (url.protocol === 'http:' || url.protocol === 'https:')
                ? server.replace(/\/+$/, '') : server;
            } catch {
              return server;
            }
          }) };
        }, { unconditional: true });
        return;
      case 'branding':
        await this.#proxyBrandingConfiguration(request, response);
        return;
      // Quick Connect signs in whoever authorizes the code, member or not, so no household host offers it: whether it
      // is enabled is always false, and every other Quick Connect call is refused alike, without asking Jellyfin.
      case 'quickConnectEnabled':
        writeJson(response, 200, false);
        return;
      case 'quickConnect':
        writeJson(response, 403, { error: 'household_quick_connect_disabled' });
        return;
      case 'streamyfin':
      case 'jellyfinEnhanced':
        writeJson(response, 404, { error: 'not_found' });
        return;
      case 'forgotPassword':
        writeJson(response, 403, { error: 'household_password_recovery_disabled' });
        return;
      case 'signOut':
        await this.#proxySignOut(request, response, requestUrl, householdId, memberIds, this.#app as HouseholdAppHandler);
        return;
      case 'signIn':
        await this.#proxyHouseholdLogin(request, response, memberIds);
        return;
      case 'signInById':
        await this.#refuseSignInById(request, response);
        return;
      case 'libraryJoinAsset':
        writeAsset(response, decision.asset.body, decision.asset.contentType);
        return;
      case 'libraryJoin':
        await this.#joinLibrary(request, response, requestUrl, this.#libraryJoin as NonNullable<HouseholdGatewayOptions['libraryJoin']>);
        return;
      case 'notFound':
        writeJson(response, 404, { error: 'item_not_found' });
        return;
      case 'userList':
      case 'syncPlayJoin':
      case 'caller':
        try {
          const checked = decision.kind === 'caller' || decision.userIds.length > 0;
          if (checked && !await this.#callerMay(request, requestUrl, memberIds, decision.userIds, decision.kind === 'caller' ? decision.itemIds : [])) {
            writeJson(response, 404, { error: 'item_not_found' });
            return;
          }
        } catch {
          writeJson(response, 502, { error: 'jellyfin_unavailable' });
          return;
        }
        if (decision.kind === 'userList') {
          await this.#proxyUserList(request, response, decision.list, memberIds);
          return;
        }
        if (decision.kind === 'syncPlayJoin') {
          await this.#proxySyncPlayJoin(request, response, requestUrl, memberIds);
          return;
        }
        break;
      // A user's picture, which Jellyfin serves to anyone and clients load without credentials (the profile picker):
      // only the household's own members' pictures, refused otherwise with the same answer as any other check.
      case 'userImage':
        if (!decision.userIds.every((userId) => isMemberId(memberIds, userId))) {
          writeJson(response, 404, { error: 'item_not_found' });
          return;
        }
        break;
      case 'proxy':
        break;
    }
    await this.#proxy(request, response);
  }

  /**
   * What a household host does with a request, decided on its method, its {@link jellyfinRoute} and its query alone;
   * undefined when Jellyfin might route it otherwise. A route still percent-encoded once decoded (a name such as
   * `100%25 Real`) is decided as Jellyfin reads it, decoded once, unless decoding it further would change the decision:
   * then it is undefined, as some other reader on the way (a proxy, a CDN) might decode it again.
   */
  #decide(method: string | undefined, route: string, query: URLSearchParams, tv: boolean): RouteDecision | undefined {
    const decision = this.#decideRoute(method, route, query, tv);
    if (!/%[0-9a-f]{2}/i.test(route)) return decision;
    const further = furtherDecodedRoute(route);
    if (further === undefined) return undefined;
    return JSON.stringify(this.#decideRoute(method, further, query, tv)) === JSON.stringify(decision) ? decision : undefined;
  }

  /** `tv`: the TV add-on is on for the household; without it, no route is decided otherwise than before it existed. */
  #decideRoute(method: string | undefined, route: string, query: URLSearchParams, tv: boolean): RouteDecision {
    if (isAppRoute(route)) return { kind: 'app' };
    if (tv && (route === TV_PATH || route.startsWith(`${TV_PATH}/`))) return { kind: 'tvAsset' };
    if (tv && (method === 'GET' || method === 'HEAD') && WEB_PAGE_ROUTES.has(route)) return { kind: 'webPage' };
    if (method === 'GET' && route === '/web/config.json') return { kind: 'webConfig' };
    if (method === 'GET' && route === PUBLIC_USERS_PATH) return { kind: 'publicUsers' };
    if (method === 'GET' && route === BRANDING_CONFIGURATION_PATH) return { kind: 'branding' };
    if (method === 'GET' && route === QUICK_CONNECT_ENABLED_PATH) return { kind: 'quickConnectEnabled' };
    if (isQuickConnectRoute(route)) return { kind: 'quickConnect' };
    if (isStreamyfinRoute(route)) return { kind: 'streamyfin' };
    if (isRefusedJellyfinEnhancedRoute(route)) return { kind: 'jellyfinEnhanced' };
    if (method === 'POST' && FORGOT_PASSWORD_PATHS.has(route)) return { kind: 'forgotPassword' };
    if (this.#app && method === 'POST' && route === LOGOUT_PATH) return { kind: 'signOut' };
    if (method === 'POST' && route === AUTHENTICATE_BY_NAME_PATH) return { kind: 'signIn' };
    if (method === 'POST' && AUTHENTICATE_BY_ID_ROUTE.test(route)) return { kind: 'signInById' };
    if (this.#libraryJoin) {
      const asset = LIBRARY_JOIN_ASSETS[route];
      if (method === 'GET' && asset) return { kind: 'libraryJoinAsset', asset };
      if (method === 'POST' && route === LIBRARY_JOIN_PATH) return { kind: 'libraryJoin' };
    }
    if (isServerInternalStreamRoute(route)) return { kind: 'notFound' };
    const userIds = userScopedIds(route, query);
    if (userIds.length && (method === 'GET' || method === 'HEAD') && isUserImageRoute(route)) return { kind: 'userImage', userIds };
    const list = method === 'GET' ? userListOf(route) : undefined;
    if (list) return { kind: 'userList', list, userIds };
    if (method === 'POST' && route === SYNCPLAY_JOIN_ROUTE) return { kind: 'syncPlayJoin', userIds };
    const itemIds = itemScopedIds(method, route, query);
    return userIds.length || itemIds.length ? { kind: 'caller', userIds, itemIds } : { kind: 'proxy' };
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, householdId: string): void {
    const exchange = this.#exchange();
    // Node's HTTP server detaches its own socket error listener before emitting 'upgrade', so a client
    // reset (ECONNRESET/EPIPE) on an unguarded upgrade socket is an unhandled 'error' event that kills the process.
    socket.on('error', (error) => {
      exchange.error('client', 'websocket client socket', error);
      socket.destroy();
    });
    if (hasEmptyPathSegment(request.url ?? '/')) {
      const body = JSON.stringify({ error: 'not_found' });
      // A peer may keep its writable half open forever. Flush the answer, then close both halves;
      // the timer also closes a socket whose peer never drains the write.
      const timer = setTimeout(() => socket.destroy(), 1_000);
      timer.unref();
      socket.once('close', () => clearTimeout(timer));
      socket.write(`HTTP/1.1 404 Not Found\r\n${neverStoreHeaders()}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`, () => socket.destroy());
      return;
    }
    if (this.#closing) {
      socket.end(`HTTP/1.1 503 Service Unavailable\r\n${neverStoreHeaders()}Connection: close\r\n\r\n`);
      return;
    }
    const route = jellyfinRoute(request.url ?? '/');
    const decision = route === undefined
      ? undefined
      : this.#decide(request.method, route, new URL(request.url ?? '/', 'http://localhost').searchParams, this.#tvAssetsFor(householdId) !== undefined);
    if (route === undefined || decision === undefined) {
      socket.end(`HTTP/1.1 400 Bad Request\r\n${neverStoreHeaders()}Connection: close\r\n\r\n`);
      return;
    }
    const appPath = decision.kind === 'app';
    // Jellyfin's only WebSocket is an ordinary route: anything a household host checks or answers itself (the app API,
    // which has none, Quick Connect, Streamyfin, Jellyfin Enhanced's refused routes, a route that names an item or a user) is never proxied as an upgrade.
    const memberIds = this.#memberIds(householdId);
    if (!memberIds || decision.kind !== 'proxy') {
      socket.end(`HTTP/1.1 404 Not Found\r\n${appPath ? neverStoreHeaders() : ''}Connection: close\r\n\r\n`);
      return;
    }
    const credentials = this.#credentials(request, new URL(request.url ?? '/', 'http://localhost'));
    if (!carriesToken(credentials)) {
      this.#relayUpgrade(request, socket, head, exchange);
      return;
    }
    // As for any other request (see #handle), a token that is not a member's gets one fixed answer. Shutdown closes an
    // upgrade still being checked like any other.
    this.#webSockets.set(socket, () => socket.destroy());
    socket.once('close', () => this.#webSockets.delete(socket));
    this.#tokenIsMember(credentials, memberIds).then((member) => {
      if (socket.destroyed) return;
      if (this.#closing) socket.end(`HTTP/1.1 503 Service Unavailable\r\n${neverStoreHeaders()}Connection: close\r\n\r\n`);
      else if (!member) socket.end(`HTTP/1.1 401 Unauthorized\r\n${neverStoreHeaders()}Connection: close\r\n\r\n`);
      else this.#relayUpgrade(request, socket, head, exchange);
    }, () => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 502 Bad Gateway\r\n${neverStoreHeaders()}Connection: close\r\n\r\n`);
    });
  }

  /** Relays a WebSocket upgrade the household host has checked to Jellyfin, and then its bytes both ways. */
  #relayUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, exchange: Exchange): void {
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

  /** The TV add-on's files if it is on for this household, else undefined. */
  #tvAssetsFor(householdId: string): TvAssets | undefined {
    return this.#tvAddon?.enabled(householdId) ? this.#tvAddon.assets : undefined;
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
        const lookup = { tokenKeys: tokenKeys(credentials), spoiled: false };
        this.#ownerLookups.add(lookup);
        let user: CurrentUser | undefined;
        try {
          user = (await this.#userFor(credentials, { serverErrorsThrow: true }))?.user;
        } finally {
          this.#ownerLookups.delete(lookup);
        }
        // Whose the token is holds for the household host's own check too (see #tokenIsMember), a sign-out's included,
        // unless one of its tokens was signed out while Jellyfin was asked: Jellyfin may have answered before revoking it.
        if (carriesToken(credentials) && !lookup.spoiled) this.#rememberTokenOwner(credentials, Promise.resolve(user?.Id));
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
   * Jellyfin's obsolete sign-in by user ID (`POST /Users/{id}/Authenticate?pw=`), which no household host offers: it
   * is not scoped to a household, and no Jellyfin client in use signs in with it (they all use AuthenticateByName or
   * Quick Connect). Every call, a member's or not, right password or not, is counted against the same per-address
   * budget as a sign-in by name and gets the answer a refused sign-in by name gets, no sooner than #loginFailureDelayMs
   * after it arrived, without asking Jellyfin; so the answer tells nothing about the ID.
   */
  async #refuseSignInById(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#allowLoginAttempt(this.#clientAddress(request))) {
      writeJson(response, 429, { error: 'too_many_login_attempts' });
      return;
    }
    const started = performance.now();
    // Read (and drop) the body as a sign-in by name does, so the two take the same course.
    await readLimitedBody(request, MAX_LOGIN_BODY_BYTES).catch(() => undefined);
    await delay(Math.max(0, this.#loginFailureDelayMs - (performance.now() - started)));
    writeJson(response, 401, { error: 'invalid_credentials' });
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
   * A sign-out through the household host, sent to Jellyfin as the client sent it, but only with a member's token:
   * Jellyfin ends the session of the token it reads first, which is the one GET /Users/Me answers for, so that token
   * must be a member's of the household (see #tokenIsMember). Any other, valid at Jellyfin or not, and a sign-out with no
   * token at all, gets the same fixed 401 as any other route, is never sent to Jellyfin and so revokes nothing, and
   * nothing is forgotten for it. The app forgets the sessions of a member's sign-out's tokens and keeps them back until
   * Jellyfin's request is over (see {@link HouseholdAppHandler.signingOut}): that is when Jellyfin answers, fails or
   * takes longer than #signOutTimeoutMs, never when the client leaves, as Jellyfin may still revoke the token after. So
   * it is not sent on when its client leaves, and is read whole before it is sent. Refused (503) when the app has too
   * many sign-outs at Jellyfin already. When Jellyfin cannot say whose the token is, it is forgotten all the same, as
   * for a sign-out Jellyfin did not answer, and not sent (502).
   */
  async #proxySignOut(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
    householdId: string,
    memberIds: string[],
    app: HouseholdAppHandler,
  ): Promise<void> {
    let body: Buffer;
    try {
      body = await readLimitedBody(request, MAX_LOGIN_BODY_BYTES);
    } catch {
      if (!response.destroyed) writeJson(response, 413, { error: 'request_too_large' });
      return;
    }
    const credentials = this.#credentials(request, requestUrl);
    let member: boolean | undefined;
    try {
      member = carriesToken(credentials) && await this.#tokenIsMember(credentials, memberIds);
    } catch {
      member = undefined;
    }
    if (member === false) {
      if (!response.destroyed) writeJson(response, 401, NOT_A_MEMBER);
      return;
    }
    const keys = tokenKeys(credentials);
    this.#forgetTokenOwners(keys);
    const done = app.signingOut(keys, { clientId: this.#clientAddress(request), householdId });
    if (!done) {
      if (!response.destroyed) writeJson(response, 503, { error: 'too_many_sign_outs' }, { 'Retry-After': '1' });
      return;
    }
    const headers: IncomingHttpHeaders = { ...request.headers, 'content-length': String(body.length) };
    let answer: WholeAnswer | undefined;
    try {
      if (member) answer = await this.#sendWhole(request, headers, body, { totalTimeoutMs: this.#signOutTimeoutMs, context: 'household sign-out' });
    } finally {
      done(answer !== undefined);
      this.#forgetTokenOwners(keys);
    }
    if (response.destroyed) return;
    if (!answer) writeJson(response, 502, { error: 'jellyfin_unavailable' });
    else {
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
    }
  }

  /**
   * Sends a sign-in to Jellyfin with the client's own headers and reads the whole answer, or undefined if Jellyfin could
   * not be reached, did not answer within #loginTimeoutMs or its answer was too large.
   */
  async #authenticate(request: IncomingMessage, body: Buffer): Promise<WholeAnswer | undefined> {
    const headers: IncomingHttpHeaders = {
      ...request.headers,
      'content-type': 'application/json',
      'content-length': String(body.length),
      accept: 'application/json',
      'accept-encoding': 'identity',
    };
    delete headers['content-encoding'];
    return this.#sendWhole(request, headers, body, { idleTimeoutMs: this.#loginTimeoutMs, context: 'household login' });
  }

  /**
   * Sends `request` to Jellyfin with these headers and body, and reads the whole answer, or undefined if Jellyfin could
   * not be reached, went quiet for `idleTimeoutMs` or took `totalTimeoutMs` in all, or its answer was too large. Its
   * client leaving changes nothing.
   */
  async #sendWhole(
    request: IncomingMessage,
    headersInput: IncomingHttpHeaders,
    body: Buffer,
    options: { idleTimeoutMs?: number; totalTimeoutMs?: number; context: string },
  ): Promise<WholeAnswer | undefined> {
    const exchange = this.#exchange();
    const { context } = options;
    return new Promise((settle) => {
      let timer: NodeJS.Timeout | undefined;
      const resolve = (answer: WholeAnswer | undefined) => {
        clearTimeout(timer);
        settle(answer);
      };
      const headers = { ...headersInput };
      delete headers['transfer-encoding'];
      delete headers.expect;
      const upstream = this.#transport().request(this.#requestOptions(request, headers), (upstreamResponse) => {
        const chunks: Buffer[] = [];
        let size = 0;
        upstreamResponse.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_LOGIN_RESPONSE_BYTES) upstreamResponse.destroy(new Error(`${context} response is too large`));
          else chunks.push(chunk);
        });
        upstreamResponse.on('error', (error) => {
          exchange.error('upstream', `${context} response`, error);
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
      if (options.idleTimeoutMs !== undefined) upstream.setTimeout(options.idleTimeoutMs, () => upstream.destroy(new Error(`${context} timed out`)));
      if (options.totalTimeoutMs !== undefined) timer = setTimeout(() => upstream.destroy(new Error(`${context} timed out`)), options.totalTimeoutMs);
      upstream.on('error', (error) => {
        exchange.error('upstream', `${context} request`, error);
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
   * Jellyfin web's page with the TV add-on's `<script>` added (see {@link TvAssets.inject}). It is asked for whole,
   * unencoded and unconditionally; a 200 `text/html` answer gets the tag, and is sent with its other headers (Jellyfin's
   * own security headers among them) as Jellyfin sent them, but `no-store` and without validators, which no longer
   * describe it. Anything else (another status, another type, an encoded or oversized body, a page with no `</head>`)
   * is relayed exactly as Jellyfin sent it. A HEAD is asked as a GET, so its headers are the GET's.
   */
  async #proxyWebPage(request: IncomingMessage, response: ServerResponse, tv: TvAssets): Promise<void> {
    const headers: IncomingHttpHeaders = { ...request.headers };
    for (const name of WEB_PAGE_DROPPED_REQUEST_HEADERS) delete headers[name];
    headers['accept-encoding'] = 'identity';
    const head = request.method === 'HEAD';
    await new Promise<void>((resolve) => {
      const exchange = this.#exchange();
      const upstream = this.#transport().request({ ...this.#requestOptions(request, headers), method: 'GET' }, (upstreamResponse) => {
        const encoding = upstreamResponse.headers['content-encoding'];
        const declared = Number(upstreamResponse.headers['content-length']);
        const html = upstreamResponse.statusCode === 200
          && /^text\/html\s*(?:;|$)/i.test(upstreamResponse.headers['content-type'] ?? '')
          && (encoding === undefined || encoding.trim().toLowerCase() === 'identity')
          && !(declared > MAX_WEB_PAGE_BYTES);
        const relay = (prefix: Buffer[]) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          if (head) {
            upstreamResponse.destroy();
            response.end();
            return resolve();
          }
          for (const chunk of prefix) response.write(chunk);
          relayResponse(upstreamResponse, response, exchange, resolve, { writeHead: false });
        };
        if (!html) return relay([]);
        const chunks: Buffer[] = [];
        let size = 0;
        const onData = (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size <= MAX_WEB_PAGE_BYTES) return;
          upstreamResponse.off('data', onData);
          upstreamResponse.off('end', onEnd);
          upstreamResponse.pause();
          relay(chunks);
        };
        const onEnd = () => {
          if (response.headersSent) return resolve();
          const page = Buffer.concat(chunks);
          const injected = tv.inject(page);
          if (!injected) {
            response.writeHead(200, upstreamResponse.headers);
            response.end(head ? undefined : page);
            return resolve();
          }
          const answer: IncomingHttpHeaders = { ...upstreamResponse.headers };
          for (const name of WEB_PAGE_DROPPED_RESPONSE_HEADERS) delete answer[name];
          response.writeHead(200, { ...answer, ...NEVER_STORE, 'content-length': String(injected.length) });
          response.end(head ? undefined : injected);
          resolve();
        };
        upstreamResponse.on('data', onData);
        upstreamResponse.once('end', onEnd);
        upstreamResponse.on('error', (error) => {
          exchange.error('upstream', 'web page response', error);
          if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
          else response.destroy();
          resolve();
        });
        upstreamResponse.once('close', () => {
          if (upstreamResponse.complete || response.headersSent) return;
          writeJson(response, 502, { error: 'jellyfin_unavailable' });
          resolve();
        });
      });
      guardUpstream(upstream, response, exchange, resolve);
      upstream.end();
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
    }, { failClosed: true });
  }

  /**
   * A Jellyfin user listing narrowed to the household's members, in Jellyfin's own order and schema: Jellyfin lists every
   * user to any signed-in caller (`GET /Users`), every remote-controllable session to one allowed to control others'
   * (`GET /Sessions`), and every SyncPlay group with its participants' names to anyone (`GET /SyncPlay/List`,
   * `GET /SyncPlay/{id}`). Only members' users, sessions all of whose users are members, and groups all of whose
   * participants are members are kept; a single group that is not gets the fixed 404. Fails closed (see #proxyJson):
   * only Jellyfin's 200 is relayed, narrowed.
   */
  async #proxyUserList(request: IncomingMessage, response: ServerResponse, list: UserList, memberIds: string[]): Promise<void> {
    const member = (id: unknown) => typeof id === 'string' && isMemberId(memberIds, id);
    if (list === 'users') {
      await this.#proxyJson(request, response, 'invalid_jellyfin_users', (value) => jsonObjects(value).filter((user) => member(user.Id)), { failClosed: true });
      return;
    }
    if (list === 'sessions') {
      await this.#proxyJson(request, response, 'invalid_jellyfin_sessions', (value) => jsonObjects(value).filter((session) =>
        member(session.UserId) && (session.AdditionalUsers === undefined || session.AdditionalUsers === null
          || (Array.isArray(session.AdditionalUsers) && session.AdditionalUsers.every((user) =>
            Boolean(user) && typeof user === 'object' && member((user as Record<string, unknown>).UserId))))), { failClosed: true });
      return;
    }
    let ours: (group: unknown) => boolean;
    try {
      ours = await this.#householdSyncPlayGroup(memberIds);
    } catch {
      writeJson(response, 502, { error: 'jellyfin_unavailable' });
      return;
    }
    if (list === 'syncPlayGroups') {
      await this.#proxyJson(request, response, 'invalid_jellyfin_syncplay_groups', (value) => jsonObjects(value).filter(ours), { failClosed: true });
      return;
    }
    await this.#proxyJson(request, response, 'invalid_jellyfin_syncplay_group', (value) => ours(value) ? value : REFUSED, { failClosed: true });
  }

  /**
   * Whether a SyncPlay group as Jellyfin describes it (`GroupInfoDto`) is the household's own: it has at least one
   * participant, and all of them are members. SyncPlay names participants only by name, so they are matched to the
   * members' names (Jellyfin's are unique in any case). Throws if Jellyfin's user list cannot be read.
   */
  async #householdSyncPlayGroup(memberIds: string[]): Promise<(group: unknown) => boolean> {
    const allowed = new Set(memberIds.map(userIdKey));
    const names = new Set((await this.#jellyfinUsers(false)).filter((user) => allowed.has(userIdKey(user.Id))).map((user) => user.Name.toLowerCase()));
    return (group) => {
      const participants = group && typeof group === 'object' && !Array.isArray(group) ? (group as Record<string, unknown>).Participants : undefined;
      return Array.isArray(participants) && participants.length > 0
        && participants.every((name) => typeof name === 'string' && names.has(name.toLowerCase()));
    };
  }

  /**
   * Joining a SyncPlay group (`POST /SyncPlay/Join`, `{"GroupId": ...}`): Jellyfin 10.11 lets anyone join any group by
   * its ID (SyncPlayManager.JoinGroup checks only the caller's SyncPlay access and the group's existence), and then sends
   * the joiner the group's participants' names over the WebSocket (`GroupJoined`, `UserJoined`). On a household host
   * only a group that is the household's own (see #householdSyncPlayGroup), as Jellyfin's GET /SyncPlay/{id} describes
   * it to the caller, may be joined; any other group, and one Jellyfin does not have, gets the fixed 404 without the
   * join reaching Jellyfin. Jellyfin is sent the checked group ID alone, so it joins no other. Every other SyncPlay
   * route acts on the group the caller's session is already in, so needs no check of its own.
   */
  async #proxySyncPlayJoin(request: IncomingMessage, response: ServerResponse, requestUrl: URL, memberIds: string[]): Promise<void> {
    let groupId: string | undefined;
    try {
      groupId = syncPlayJoinGroupId(await readLimitedBody(request, MAX_LOGIN_BODY_BYTES));
    } catch {
      if (!response.destroyed) writeJson(response, 413, { error: 'request_too_large' });
      return;
    }
    if (groupId === undefined) {
      writeJson(response, 400, { error: 'invalid_request' });
      return;
    }
    try {
      const credentials = this.#credentials(request, requestUrl);
      const url = this.#targetUrl(`/SyncPlay/${groupId}`);
      for (const [name, value] of credentials.query) url.searchParams.append(name, value);
      const groupResponse = await fetch(url, { headers: credentials.headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      if (groupResponse.status >= 500) {
        await groupResponse.body?.cancel().catch(() => undefined);
        throw new Error(`Jellyfin GET /SyncPlay/{id} returned ${groupResponse.status}`);
      }
      const group = groupResponse.status === 200 ? await groupResponse.json().catch(() => undefined) as unknown : undefined;
      if (groupResponse.status !== 200) await groupResponse.body?.cancel().catch(() => undefined);
      if (!(await this.#householdSyncPlayGroup(memberIds))(group)) {
        writeJson(response, 404, { error: 'item_not_found' });
        return;
      }
    } catch {
      writeJson(response, 502, { error: 'jellyfin_unavailable' });
      return;
    }
    const body = Buffer.from(JSON.stringify({ GroupId: groupId }));
    const headers: IncomingHttpHeaders = { ...request.headers, 'content-type': 'application/json', 'content-length': String(body.length) };
    delete headers['content-encoding'];
    const answer = await this.#sendWhole(request, headers, body, { totalTimeoutMs: 15_000, context: 'household SyncPlay join' });
    if (response.destroyed) return;
    if (!answer) writeJson(response, 502, { error: 'jellyfin_unavailable' });
    else {
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
    }
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

  /**
   * Whether the request's own credentials belong to a Jellyfin user who is every one of `userIds` (see
   * {@link userScopedIds}), is a member of the household and may see every one of `itemIds` (see {@link itemScopedIds}).
   * Jellyfin administrators are not exempt: on a household host no one acts as another user. Throws if Jellyfin cannot
   * be reached.
   */
  async #callerMay(request: IncomingMessage, requestUrl: URL, memberIds: string[], userIds: string[], itemIds: string[]): Promise<boolean> {
    const current = await this.#currentUser(request, requestUrl);
    if (!current || !isMemberId(memberIds, current.user.Id)) return false;
    if (userIds.some((userId) => userIdKey(userId) !== userIdKey(current.user.Id))) return false;
    for (const itemId of itemIds) {
      const itemResponse = await fetch(this.#targetUrl(
        `/Users/${encodeURIComponent(current.user.Id)}/Items/${encodeURIComponent(itemId)}${current.suffix}`,
      ), {
        headers: current.headers,
        signal: AbortSignal.timeout(15_000),
      });
      await itemResponse.body?.cancel();
      if (!itemResponse.ok) return false;
    }
    return true;
  }

  /**
   * The Jellyfin user the request's own credentials (authorization headers or token query parameters) belong to, as
   * Jellyfin's GET /Users/Me reports it, or undefined if Jellyfin rejects them. Throws if Jellyfin cannot be reached.
   */
  async #currentUser(request: IncomingMessage, requestUrl: URL): Promise<{ user: CurrentUser; headers: Headers; suffix: string } | undefined> {
    return this.#userFor(this.#credentials(request, requestUrl));
  }

  /**
   * The request's own credentials, exactly as the client gave them, legacy forms included (X-Emby-Token,
   * X-Emby-Authorization, X-MediaBrowser-Token, the Emby scheme, api_key). They are never rewritten into another form:
   * Jellyfin 12 disabled the legacy ones, and translating them would turn them back on. So Jellyfin itself decides, on
   * every version, whether they are valid and which one it reads first, for the check as for the relayed request; on
   * Jellyfin 12 a legacy-only request is refused (fixed 401), as Jellyfin refuses it.
   */
  #credentials(request: IncomingMessage, requestUrl: URL): JellyfinCredentials {
    const headers = new Headers({ Accept: 'application/json' });
    for (const name of ['authorization', 'x-emby-authorization', 'x-emby-token', 'x-mediabrowser-token']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const query = new URLSearchParams();
    for (const [name, value] of jellyfinQueryPairs(requestUrl.searchParams)) {
      if (['apikey', 'api_key', 'access_token'].includes(name.toLowerCase()) && value) {
        query.append(name, value);
      }
    }
    return { headers, query };
  }

  /**
   * Whether credentials that carry a Jellyfin token (see {@link carriesToken}) belong to a member of the household, as
   * Jellyfin's GET /Users/Me reports it; true for credentials without one, which Jellyfin answers as anyone's. Who a
   * token belongs to never changes, so it is reused for TOKEN_OWNER_TTL_MS, as is Jellyfin's rejecting it (a sign-out
   * through a household host forgets its tokens at once); membership is checked afresh every time. Throws if Jellyfin
   * cannot be reached or fails.
   */
  async #tokenIsMember(credentials: JellyfinCredentials, memberIds: string[]): Promise<boolean> {
    if (!carriesToken(credentials)) return true;
    const key = credentialKey(credentials) as string;
    const now = Date.now();
    const entry = this.#tokenOwners.get(key);
    const owner = await (entry && entry.expires > now
      ? entry.owner
      : this.#rememberTokenOwner(credentials, this.#userFor(credentials, { serverErrorsThrow: true }).then((current) => current?.user.Id)));
    return owner !== undefined && isMemberId(memberIds, owner);
  }

  /**
   * Keeps whom credentials that carry a token belong to (see #tokenIsMember) for TOKEN_OWNER_TTL_MS; a failure is not
   * kept. Kept while Jellyfin is still being asked too, so a sign-out of one of its tokens meanwhile forgets it (see
   * #forgetTokenOwners) and an answer from before Jellyfin revoked the token is never kept.
   */
  #rememberTokenOwner(credentials: JellyfinCredentials, owner: Promise<string | undefined>): Promise<string | undefined> {
    const key = credentialKey(credentials) as string;
    const created = { owner, tokenKeys: tokenKeys(credentials), expires: Date.now() + TOKEN_OWNER_TTL_MS };
    this.#tokenOwners.delete(key);
    this.#tokenOwners.set(key, created);
    while (this.#tokenOwners.size > MAX_TOKEN_OWNERS) this.#tokenOwners.delete(this.#tokenOwners.keys().next().value as string);
    owner.catch(() => {
      if (this.#tokenOwners.get(key) === created) this.#tokenOwners.delete(key);
    });
    return owner;
  }

  /**
   * Forgets whom credentials holding any of these tokens (hashes, as {@link tokenKeys}) belong to, those still being
   * asked included, and spoils the app's verifications of them now at Jellyfin so their answers are not kept.
   */
  #forgetTokenOwners(keys: readonly string[]): void {
    if (!keys.length) return;
    const forgotten = new Set(keys);
    for (const [key, entry] of this.#tokenOwners) {
      if (entry.tokenKeys.some((tokenKey) => forgotten.has(tokenKey))) this.#tokenOwners.delete(key);
    }
    for (const lookup of this.#ownerLookups) {
      if (lookup.tokenKeys.some((tokenKey) => forgotten.has(tokenKey))) lookup.spoiled = true;
    }
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

  /**
   * Relays a Jellyfin JSON answer through `transform`. With `failClosed`, for answers that reveal users, only a 200 is
   * relayed (transformed): a 401 or 404 gets the fixed answer of that status, any other 4xx a fixed
   * `{"error":"jellyfin_refused"}`, a 5xx `502 jellyfin_unavailable`, and any other status `502` with
   * `invalidResponseCode`, so no other answer's body (a 201 that lists someone, say) is ever relayed. Without it, any
   * answer but a 200 is relayed as it is.
   */
  async #proxyJson(
    request: IncomingMessage,
    response: ServerResponse,
    invalidResponseCode: string,
    transform: (value: unknown) => unknown | typeof REFUSED,
    options: { failClosed?: boolean; unconditional?: boolean } = {},
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const headers: IncomingHttpHeaders = { ...request.headers, 'accept-encoding': 'identity' };
      if (options.unconditional) {
        for (const name of WEB_PAGE_DROPPED_REQUEST_HEADERS) delete headers[name];
        headers['accept-encoding'] = 'identity';
      }
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
          if (upstreamResponse.statusCode !== 200 && options.failClosed) {
            const status = upstreamResponse.statusCode ?? 502;
            if (status === 401) writeJson(response, 401, NOT_A_MEMBER);
            else if (status === 404) writeJson(response, 404, { error: 'item_not_found' });
            else if (status >= 400 && status < 500) writeJson(response, status, { error: 'jellyfin_refused' });
            else if (status >= 500) writeJson(response, 502, { error: 'jellyfin_unavailable' });
            else writeJson(response, 502, { error: invalidResponseCode });
            return resolve();
          }
          if (upstreamResponse.statusCode !== 200) {
            response.writeHead(upstreamResponse.statusCode ?? 502, sanitizedHeaders(upstreamResponse.headers, body.length));
            response.end(body);
            return resolve();
          }
          try {
            const transformed = transform(JSON.parse(body.toString('utf8')) as unknown);
            if (transformed === REFUSED) {
              writeJson(response, 404, { error: 'item_not_found' });
              return resolve();
            }
            const encoded = Buffer.from(JSON.stringify(transformed));
            const answerHeaders = sanitizedHeaders(upstreamResponse.headers, encoded.length);
            if (options.unconditional) {
              for (const name of ['etag', 'last-modified', 'accept-ranges', 'content-md5', 'digest']) delete answerHeaders[name];
            }
            response.writeHead(200, answerHeaders);
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

function relayResponse(
  upstreamResponse: IncomingMessage,
  response: ServerResponse,
  exchange: Exchange,
  resolve: () => void,
  { writeHead = true }: { writeHead?: boolean } = {},
): void {
  upstreamResponse.on('error', (error) => {
    exchange.error('upstream', 'proxy upstream response', error);
    response.destroy();
  });
  // An upstream reset mid-body aborts the response without 'end'; tear down the client side instead of hanging.
  upstreamResponse.once('close', () => {
    if (!upstreamResponse.complete) response.destroy();
  });
  if (writeHead) response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
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

/**
 * Route roots under which Jellyfin 10.11 reads the next segment as an item's ID (`/Videos/{itemId}/...`), each with the
 * fixed names it routes there instead (`/Videos/MergeVersions`): lists and searches, which Jellyfin scopes to the caller
 * itself. Under these roots every other second segment is taken for an item's ID, whatever follows it, so a route this
 * list does not know of is checked rather than let through.
 */
const ITEM_ROUTE_ROOTS = new Map<string, readonly string[]>([
  ['videos', ['activeencodings', 'mergeversions']],
  ['audio', []],
  ['items', ['counts', 'filters', 'filters2', 'latest', 'remotesearch', 'root', 'suggestions']],
  ['useritems', ['resume']],
  ['userplayeditems', []],
  ['userfavoriteitems', []],
  ['playingitems', []],
  ['mediasegments', []],
  ['shows', ['nextup', 'upcoming']],
]);
/** The legacy `/Users/{userId}/<collection>/{itemId}` routes, each with the fixed names it routes in the item's place. */
const USER_ITEM_COLLECTIONS = new Map<string, readonly string[]>([
  ['items', ['latest', 'resume', 'root']],
  ['playeditems', []],
  ['playingitems', []],
  ['favoriteitems', []],
]);
/** Routes named `/<root>/{itemId}/<action>` whose root also takes names elsewhere (`/Artists/{name}`). */
const ITEM_ACTION_ROOTS = new Set(['albums', 'artists', 'movies', 'songs', 'trailers']);
const ITEM_ACTIONS = new Set(['instantmix', 'similar']);

/**
 * The items a request on a household host reads or acts on, from its {@link jellyfinRoute}, each of which the caller
 * must be able to see before it is proxied: the item ID in the route, and every `itemId` query parameter (in any case,
 * however Jellyfin reads the query: see {@link jellyfinQueryPairs}), which some of Jellyfin's routes (subtitles) take
 * over the route's. Empty for a route that names no item.
 *
 * Every route that takes an item ID in its path is covered, whether or not Jellyfin checks the caller's access to the
 * item itself, with one exception: an item's images (`GET`/`HEAD /Items/{itemId}/Images/{type}[/...]`), which Jellyfin
 * serves to anyone, signed in or not, and which clients load without credentials (an `<img>`), so no check could be
 * made. Jellyfin still refuses them to a signed-in caller who may not see the item.
 */
function itemScopedIds(method: string | undefined, route: string, query: URLSearchParams): string[] {
  const segments = route.split('/').slice(1);
  const [root = '', second, third = '', fourth] = segments;
  const fixed = ITEM_ROUTE_ROOTS.get(root);
  const userFixed = root === 'users' ? USER_ITEM_COLLECTIONS.get(third) : undefined;
  let itemId: string | undefined;
  if (fixed && second !== undefined && !fixed.includes(second)) {
    const image = root === 'items' && third === 'images' && segments.length >= 4 && (method === 'GET' || method === 'HEAD');
    if (!image) itemId = second;
  } else if (userFixed && fourth !== undefined && !userFixed.includes(fourth)) {
    itemId = fourth;
  } else if (ITEM_ACTION_ROOTS.has(root) && second !== undefined && segments.length === 3 && ITEM_ACTIONS.has(third)) {
    itemId = second;
  }
  if (itemId === undefined) return [];
  const ids = [itemId];
  for (const [name, value] of jellyfinQueryPairs(query)) if (name.toLowerCase() === 'itemid') ids.push(value);
  return [...new Set(ids)];
}

/**
 * The routes Jellyfin 10.11 has under `/Users` with a fixed name in a user ID's place (`/Users/Me`, `/Users/Public`).
 * Only these exact routes: Jellyfin routes anything longer (`/Users/Me/Views`) to a route that takes a user ID.
 */
const USER_FIXED_ROUTES = new Set([
  '/users/authenticatebyname', '/users/authenticatewithquickconnect', '/users/configuration', '/users/forgotpassword',
  '/users/forgotpassword/pin', '/users/me', '/users/new', '/users/password', '/users/public',
]);
/** The query parameters Jellyfin 10.11 reads a user ID from (in any case). */
const USER_ID_PARAMETERS = new Set(['userid', 'controllablebyuserid', 'controllinguserid']);

/**
 * Every user ID a request on a household host names, from its {@link jellyfinRoute} and query, each of which must be
 * the caller's own before it is proxied: Jellyfin 10.11 takes some of them for the caller without checking
 * (`GET /Playlists/{id}/Items?userId=`, `GET /Users/{userId}`, `POST /Sessions/{id}/User/{userId}`), so a member could
 * otherwise act as anyone, another household's members included. They are
 *
 * - the second segment of every route under `/Users` but Jellyfin's fixed ones there (USER_FIXED_ROUTES), whatever
 *   follows it and by any method, so a route Jellyfin adds later is checked too;
 * - the user in `/Sessions/{sessionId}/User/{userId}`;
 * - every non-empty `userId`, `controllableByUserId` and `controllingUserId` query parameter, in any case, each of
 *   them where one is given more than once, and however Jellyfin reads the query (see {@link jellyfinQueryPairs}).
 *
 * An empty parameter is no user ID: Jellyfin binds it as none given. Empty for a request that names no user.
 *
 * The user in `/Playlists/{playlistId}/Users/{userId}` (`GET`, `POST`, `DELETE`) is not one of them: it is who the
 * playlist is shared with, not who acts, and Jellyfin checks the caller's own rights there (the playlist must be the
 * caller's to see; reading another user's share takes the caller's `CanEdit`, changing it ownership, removing it
 * ownership or `CanEdit`), so a member shares their playlist with anyone by path as by `POST /Playlists/{id}`.
 */
function userScopedIds(route: string, query: URLSearchParams): string[] {
  const [root = '', second, third, fourth] = route.split('/').slice(1);
  const ids: string[] = [];
  if (root === 'users' && second !== undefined && !USER_FIXED_ROUTES.has(route)) ids.push(second);
  if (root === 'sessions' && third === 'user' && fourth !== undefined) ids.push(fourth);
  for (const [name, value] of jellyfinQueryPairs(query)) if (value && USER_ID_PARAMETERS.has(name.toLowerCase())) ids.push(value);
  return [...new Set(ids)];
}

/** Whether a {@link jellyfinRoute} is one of a user's pictures: `/Users/{userId}/Images/...` or `/UserImage`. */
function isUserImageRoute(route: string): boolean {
  return route === '/userimage' || /^\/users\/[^/]+\/images(?:\/|$)/.test(route);
}

/**
 * A user ID in the one form Jellyfin's GUID binding reads each of its spellings as (`a11ce000-...`, `{A11CE000-...}`,
 * `(a11ce000...)`, `a11ce000...`), to compare two of them: without braces, parentheses or dashes, in lower case. A value
 * Jellyfin does not read as a GUID at all never matches a user's own.
 */
function userIdKey(value: string): string {
  return value.replace(/[{}()-]/g, '').toLowerCase();
}

/** Whether `userId` is one of `memberIds`, compared as Jellyfin reads user IDs (see {@link userIdKey}). */
function isMemberId(memberIds: readonly string[], userId: string): boolean {
  const key = userIdKey(userId);
  return key !== '' && memberIds.some((memberId) => userIdKey(memberId) === key);
}

/** The {@link UserList} a `GET` {@link jellyfinRoute} is, if any. */
function userListOf(route: string): UserList | undefined {
  if (route === '/users') return 'users';
  if (route === '/sessions') return 'sessions';
  if (route === '/syncplay/list') return 'syncPlayGroups';
  return /^\/syncplay\/[^/]+$/.test(route) ? 'syncPlayGroup' : undefined;
}

/** A JSON array's objects, for a listing to be narrowed; throws if it is not an array. */
function jsonObjects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('a Jellyfin listing must be an array');
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
}

/**
 * Every query parameter Jellyfin 10.11 might read: the query's own, and, for a query that is a single key with no
 * value and an `=` in it (`?itemId%3D...`), the `&`-separated pairs in that key, which Jellyfin's UrlDecodeQueryFeature
 * reads as the query instead.
 */
function jellyfinQueryPairs(query: URLSearchParams): Array<[string, string]> {
  const pairs = [...query];
  const [only] = pairs;
  if (pairs.length !== 1 || !only || only[1] || !only[0].includes('=')) return pairs;
  return [...pairs, ...only[0].split('&').map((pair): [string, string] => {
    const equals = pair.indexOf('=');
    return equals < 0 ? [pair, ''] : [pair.slice(0, equals), pair.slice(equals + 1)];
  })];
}

/**
 * Jellyfin's anonymous live TV stream routes (`/LiveTv/LiveRecordings/{id}/stream`, `/LiveTv/LiveStreamFiles/{id}/...`),
 * which Jellyfin's own transcoder reads at Jellyfin's local address and no client is sent to. They check no one, and
 * their IDs are a recording's timer and a tuner stream, not items, so no household host serves them.
 */
function isServerInternalStreamRoute(route: string): boolean {
  return /^\/livetv\/(?:liverecordings|livestreamfiles)(?:\/|$)/.test(route);
}

/** What a household host does with a request; see HouseholdGateway.#decide. */
type RouteDecision =
  | { kind: 'app' | 'publicUsers' | 'webConfig' | 'branding' | 'quickConnectEnabled' | 'quickConnect' | 'streamyfin' | 'jellyfinEnhanced' | 'forgotPassword' }
  | { kind: 'signOut' | 'signIn' | 'signInById' | 'libraryJoin' | 'notFound' | 'proxy' | 'tvAsset' | 'webPage' }
  | { kind: 'libraryJoinAsset'; asset: { body: string; contentType: string } }
  | { kind: 'userImage'; userIds: string[] }
  | { kind: 'userList'; list: UserList; userIds: string[] }
  | { kind: 'syncPlayJoin'; userIds: string[] }
  | { kind: 'caller'; userIds: string[]; itemIds: string[] };

/**
 * The decisions whose requests reach Jellyfin with the caller's own token, which must then be a member's (see
 * HouseholdGateway.#tokenIsMember). Not among them: what a household host answers itself; sign-in and what comes before
 * it (the profile picker and branding), which Jellyfin answers alike whoever asks; the household app and "Add to my
 * library", which have their own checks (the app's membership, and the caller's own grants); routes that name an item
 * or a user, whose own check refuses a non-member with its fixed 404; and sign-out, which checks its token itself (see
 * HouseholdGateway.#proxySignOut) so that a sign-out Jellyfin cannot be asked about is still forgotten.
 */
const TOKEN_CHECKED_KINDS = new Set<RouteDecision['kind']>(['proxy', 'userImage', 'webPage', 'webConfig', 'userList', 'syncPlayJoin']);

/** Jellyfin's route for joining a SyncPlay group; see HouseholdGateway.#proxySyncPlayJoin. */
const SYNCPLAY_JOIN_ROUTE = '/syncplay/join';

/**
 * The group a `POST /SyncPlay/Join` body names, as 32 lower-case hex digits, or undefined unless it is a JSON object
 * with exactly one `GroupId` property (any case, as Jellyfin reads it) that is a GUID in a form Jellyfin parses.
 */
function syncPlayJoinGroupId(body: Buffer): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ids = Object.entries(value).filter(([name]) => name.toLowerCase() === 'groupid').map(([, id]) => id);
  if (ids.length !== 1 || typeof ids[0] !== 'string') return undefined;
  const match = /^(?:([0-9a-f]{32})|\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?)$/i.exec(ids[0]);
  if (!match || (ids[0].startsWith('{') !== ids[0].endsWith('}'))) return undefined;
  return (match[1] ?? match.slice(2).join('')).toLowerCase();
}

/** What a JSON transform returns for an answer the caller may not have: the fixed 404 is sent instead. */
const REFUSED = Symbol('refused');

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
 * `X-Emby-Authorization` header (as Jellyfin reads it, see {@link authorizationToken}), `X-Emby-Token`,
 * `X-MediaBrowser-Token`, or the first value of each token query parameter (in any case; any more values of one are not
 * taken). So at most seven, however many a request sends.
 */
function tokenKeys(credentials: JellyfinCredentials): string[] {
  const tokens = new Set<string>();
  for (const name of ['authorization', 'x-emby-authorization']) {
    const value = credentials.headers.get(name);
    const token = value ? authorizationToken(value) : undefined;
    if (token) tokens.add(token);
  }
  for (const name of ['x-emby-token', 'x-mediabrowser-token']) {
    const token = credentials.headers.get(name);
    if (token) tokens.add(token);
  }
  const names = new Set<string>();
  for (const [name, value] of credentials.query) {
    if (names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    tokens.add(value);
  }
  return [...tokens].map((token) => createHash('sha256').update(`token\n${token}`).digest('hex'));
}

/**
 * Whether credentials carry a Jellyfin token: any {@link tokenKeys} reads, or an `Authorization` or
 * `X-Emby-Authorization` header naming a token in any spelling, so a header Jellyfin might read otherwise is still
 * checked. Jellyfin web's sign-in calls carry none.
 */
function carriesToken(credentials: JellyfinCredentials): boolean {
  if (tokenKeys(credentials).length) return true;
  return ['authorization', 'x-emby-authorization'].some((name) => /token/i.test(credentials.headers.get(name) ?? ''));
}

const LEGACY_PREFIXES = new Set(['emby', 'mediabrowser']);

function hasEmptyPathSegment(target: string): boolean {
  const path = target.split('?', 1)[0] as string;
  // Only %2F can introduce a slash in one percent-decode. Checking it directly also
  // catches empty segments alongside malformed escapes, which routing refuses separately.
  return path.includes('//') || path.replace(/%2f/gi, '/').includes('//');
}

/**
 * The route Jellyfin 10.11 takes a request target to, which every decision a household host makes about a path is made
 * on: each segment percent-decoded once and in lower case, without empty segments (so runs of slashes count as one and
 * a trailing slash as none) and without the legacy `/emby` or `/mediabrowser` prefix Jellyfin strips before routing. It
 * may match a path Jellyfin itself does not route (`//Users//Public`, say), never the other way round.
 *
 * Undefined for a target Jellyfin might read otherwise than this, which is refused rather than proxied: one that is not
 * a path (`*`, an absolute URL); one with a backslash, a fragment or a character outside printable ASCII; invalid
 * percent-encoding; an encoded slash or backslash, which Jellyfin keeps inside its segment; a `.` or `..` segment,
 * encoded or not, which Jellyfin resolves; a control character; and a legacy prefix after another. What is still
 * percent-encoded once decoded (`%2541` is `%41`) is kept as Jellyfin keeps it: whether decoding it again would change
 * what the gateway does is HouseholdGateway.#decide's to ask (see {@link furtherDecodedRoute}).
 */
function jellyfinRoute(target: string): string | undefined {
  if (!target.startsWith('/')) return undefined;
  const queryAt = target.indexOf('?');
  const path = queryAt < 0 ? target : target.slice(0, queryAt);
  if (/[^\x21-\x7e]|[\\#]/.test(path)) return undefined;
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    if (!raw) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === '.' || segment === '..' || /[/\\\u0000-\u001f\u007f]/.test(segment)) return undefined;
    segments.push(segment.toLowerCase());
  }
  return withoutLegacyPrefix(segments);
}

/** Decodings tried by {@link furtherDecodedRoute} before a route counts as ambiguous. */
const MAX_FURTHER_DECODINGS = 4;

/**
 * A {@link jellyfinRoute} as it reads with each segment percent-decoded again until nothing more decodes, normalised
 * as jellyfinRoute normalises (a decoded `/` now splits its segment); undefined if that reading has a dot segment, a
 * backslash, a control character or a repeated legacy prefix, or still decodes after MAX_FURTHER_DECODINGS rounds.
 */
function furtherDecodedRoute(route: string): string | undefined {
  const segments: string[] = [];
  for (let segment of route.split('/')) {
    for (let round = 0; /%[0-9a-f]{2}/i.test(segment); round += 1) {
      if (round === MAX_FURTHER_DECODINGS) return undefined;
      try {
        segment = decodeURIComponent(segment);
      } catch {
        break;
      }
    }
    segments.push(...segment.split('/'));
  }
  const kept = segments.filter(Boolean);
  if (kept.some((segment) => segment === '.' || segment === '..' || /[\\\u0000-\u001f\u007f]/.test(segment))) return undefined;
  return withoutLegacyPrefix(kept.map((segment) => segment.toLowerCase()));
}

/** `/`-joined route segments without one legacy prefix, as Jellyfin strips it; undefined if another follows it. */
function withoutLegacyPrefix(segments: string[]): string | undefined {
  const routed = LEGACY_PREFIXES.has(segments[0] ?? '') ? segments.slice(1) : segments;
  return LEGACY_PREFIXES.has(routed[0] ?? '') ? undefined : `/${routed.join('/')}`;
}

/** Whether a {@link jellyfinRoute} is the household app's: never proxied to Jellyfin. */
function isAppRoute(route: string): boolean {
  return route === APP_PATH || route.startsWith(`${APP_PATH}/`);
}

function isQuickConnectRoute(route: string): boolean {
  return route === QUICK_CONNECT_PATH || route.startsWith(`${QUICK_CONNECT_PATH}/`) || route === AUTHENTICATE_WITH_QUICK_CONNECT_PATH;
}

function isStreamyfinRoute(route: string): boolean {
  return route === STREAMYFIN_PATH || route.startsWith(`${STREAMYFIN_PATH}/`);
}

function isRefusedJellyfinEnhancedRoute(route: string): boolean {
  return JELLYFIN_ENHANCED_REFUSED_PATHS.some((path) => route === path || route.startsWith(`${path}/`));
}

/**
 * The `Token` Jellyfin takes from a `MediaBrowser key="value", ...` (or `Emby ...`) header, or undefined if it has none,
 * parsed exactly as Jellyfin 10.11's AuthorizationContext.GetParts does: a comma inside quotes is part of the value, a
 * key is matched in its case, a key given twice has its last value, and each value is URL-decoded as
 * WebUtility.UrlDecode does (`+` is a space).
 */
function authorizationToken(header: string): string | undefined {
  const firstSpace = header.indexOf(' ');
  if (firstSpace < 0) return undefined;
  const scheme = header.slice(0, firstSpace).toLowerCase();
  if (scheme !== 'mediabrowser' && scheme !== 'emby') return undefined;
  const parameters = header.slice(firstSpace + 1);
  let token: string | undefined;
  let escaped = false;
  let start = 0;
  let key = '';
  const take = (end: number) => {
    if (key === 'Token') token = urlDecode(parameters.slice(start, end).replace(/^"+|"+$/g, ''));
  };
  for (let index = 0; index < parameters.length; index += 1) {
    const character = parameters[index];
    if (character === '"' || character === ',') {
      // A quote opens or closes a value; a comma outside one ends it.
      escaped = !escaped === (character === '"');
      if (character === ',' && !escaped) {
        if (start < index) {
          take(index);
          key = '';
        }
        start = index + 1;
      }
    } else if (!escaped && character === '=') {
      key = parameters.slice(start, index).trim();
      start = index + 1;
    }
  }
  if (start < parameters.length) take(parameters.length);
  return token || undefined;
}

/**
 * `value` URL-decoded as .NET's WebUtility.UrlDecode does: `+` is a space, `%XX` a byte (the bytes read as UTF-8), and
 * anything else, a `%` not followed by two hex digits included, as it is.
 */
function urlDecode(value: string): string {
  let decoded = '';
  let bytes: number[] = [];
  const flush = () => {
    if (!bytes.length) return;
    decoded += Buffer.from(bytes).toString('utf8');
    bytes = [];
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character === '+') {
      bytes.push(0x20);
      continue;
    }
    if (character === '%' && index < value.length - 2 && /^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
    else {
      flush();
      decoded += character;
    }
  }
  flush();
  return decoded;
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
