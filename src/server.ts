import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { SelfCheck } from './self-check.js';
import { ConflictError, UserProvisioningError, type AccessService } from './access-service.js';
import { HouseholdApp, type HouseholdAppOptions } from './app-api.js';
import { AdminActionLimitError, AdminSeerrError, type AdminRequests } from './admin-requests.js';
import { ADMIN_APP_JS, ADMIN_FAVICON_SVG, ADMIN_HTML, ADMIN_STYLES } from './admin-ui.js';
import { APP_PERMISSIONS_POLICY, AppAssets, NEVER_STORE } from './app-assets.js';
import { expiredSessionCookie, hasSessionCookie, isSameOriginRequest, isSecureRequest, sessionCookie, type WebAuth } from './auth.js';
import { ClientIpResolver } from './client-ip.js';
import type { LogLevel } from './config.js';
import { HouseholdAddresses, HouseholdAddressError, normalizeEntry } from './household-addresses.js';
import { HouseholdGateway } from './household-gateway.js';
import type { HouseholdRequests } from './household-requests.js';
import { writeWhole } from './html-response.js';
import { UNKNOWN_VERSION_MESSAGE, UNTESTED_VERSION_MESSAGE, VersionConfirmationError, type HouseholdDecision, type JellyfinVersionGate } from './jellyfin-version.js';
import { RECENT_REQUESTS_LIMIT } from './seerr.js';
import { BackgroundTasks } from './shutdown.js';
import { TvAssets } from './tv-assets.js';
import { parseWebhook } from './webhook.js';

const BODY_LIMIT = 64 * 1024;
/** The admin page's bytes, once, so its encoded copies are worked out once (see html-response.ts). */
const ADMIN_HTML_BYTES = Buffer.from(ADMIN_HTML);
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A request body that is not declared as JSON; answered 415 before any of it is read. */
class UnsupportedMediaTypeError extends Error {}

export interface ServerTokens {
  webhook: string;
  admin: string;
}

export interface ServerOptions {
  selfCheck?: SelfCheck;
  /** Reverse proxies trusted to report the client address in X-Forwarded-For; empty uses the TCP peer. */
  trustedProxies?: string[];
  /**
   * The member listener's household gateway: requests whose Host is a household's address (see household-addresses.ts)
   * are that household's. Without it there is no member listener.
   */
  householdGateway?: {
    additionalPluginRoutes?: string[];
    jellyfinUrl: string;
    /**
     * The legacy address rule, `https://<hostPrefix><household>.<domain>` (HOUSEHOLD_DOMAIN, HOUSEHOLD_HOST_PREFIX),
     * joined with the address map. Without `domain` only the map gives households addresses.
     */
    domain?: string;
    hostPrefix?: string;
    webSocketIdleTimeoutMs?: number;
    webSocketUpstreamIdleTimeoutMs?: number;
    logLevel?: LogLevel;
    /** The least time a refused household sign-in takes, in milliseconds (default one second). */
    loginFailureDelayMs?: number;
    /** How long a household sign-in waits for Jellyfin, in milliseconds (default 15 seconds). */
    loginTimeoutMs?: number;
    /** How long a sign-out through a household host may take at Jellyfin, in milliseconds (default 15 seconds). */
    signOutTimeoutMs?: number;
    /**
     * The TV add-on (docs/tv-addon.md) on these households' hosts (by household ID), or on every household's. Without
     * it, no household host changes.
     */
    tvAddon?: { households: string[] | 'all' };
  };
  /**
   * Runs title-hold checks in the background. Pass the BackgroundTasks shutdown stops, so it can
   * abort them and wait for them before closing the store.
   */
  background?: Pick<BackgroundTasks, 'run'>;
  /**
   * The household app API at /jellypass/app/v1/* on household hosts (needs `householdGateway`). Without it those paths
   * answer a fixed 404 there; they are never served on the admin host.
   */
  householdApp?: Pick<HouseholdAppOptions, 'catalogue' | 'blocklist' | 'members' | 'requests' | 'libraryTtlMs' | 'titleTtlMs' | 'blocklistTtlMs' | 'catalogueLimits' | 'signOutLimits' | 'now'>;
  /**
   * The household app's title holds (HouseholdRequests.checkTitleHolds), checked in the background after each
   * MEDIA_AVAILABLE webhook and library catalog sync, so a title whose cancelled request Seerr lost is held soon after it
   * arrives rather than at the next scheduled reconciliation.
   */
  titleHolds?: Pick<HouseholdRequests, 'checkTitleHolds'>;
  /**
   * The administrators' Requests tab's API (`GET /v1/app/requests`, its actions and releasing held titles); without it
   * those paths answer 404 `requests_not_configured`.
   */
  adminRequests?: Pick<AdminRequests, 'list' | 'approve' | 'decline' | 'cancel' | 'release'>;
  /**
   * LEGACY_WEBHOOK_ON_MEMBER_PORT: the member listener also answers POST /webhooks/seerr for a Host that is no
   * household's, exactly as the admin listener does, so a Seerr webhook URL from before 4.0.0 keeps working.
   */
  memberWebhook?: boolean;
  /**
   * The Jellyfin version check (docs/server-reference.md, "Supported Jellyfin versions"): household hosts answer a fixed 503 unless
   * it decides they serve (always, unless it enforces: see JELLYFIN_VERSION_ENFORCEMENT), and the admin API reads and
   * confirms it at /v1/jellyfin/version. Without it household hosts serve whatever the version.
   */
  jellyfinVersion?: Pick<JellyfinVersionGate, 'decision' | 'householdDecision' | 'status' | 'confirm' | 'clearConfirmation' | 'renderMetrics'>;
}

export interface JellyPassServer extends Server {
  /** Closes every proxied household WebSocket and refuses new upgrades; resolves with how many were open. */
  closeWebSockets(): Promise<number>;
}

/** JellyPass's two listeners. They share nothing but the services behind them; neither ever answers for the other. */
export interface JellyPassServers {
  /**
   * The admin listener: the admin site and API, /metrics, the Seerr webhook and /health, for any Host. It is meant to
   * be reachable only by administrators (ADMIN_HOST) and never proxies to Jellyfin.
   */
  admin: JellyPassServer;
  /**
   * The member listener (with `householdGateway` only): household addresses and nothing else. A Host that is no
   * household's gets a fixed 421 (WebSocket upgrades are dropped), never the admin site.
   */
  member?: JellyPassServer;
}

export function makeServers(
  service: AccessService,
  tokens: ServerTokens,
  webAuth?: WebAuth,
  options?: ServerOptions,
): JellyPassServers {
  const background = options?.background ?? new BackgroundTasks();
  const { tvAddon: tvOption, domain, hostPrefix, ...gatewayOptions } = options?.householdGateway ?? {};
  const tvHouseholds = tvOption?.households;
  const householdGateway = options?.householdGateway
    ? new HouseholdGateway({
        ...gatewayOptions,
        jellyfinUrl: options.householdGateway.jellyfinUrl,
        ...(tvHouseholds ? {
          tvAddon: {
            enabled: (householdId: string) => tvHouseholds === 'all' || tvHouseholds.includes(householdId.toLowerCase()),
            assets: TvAssets.load(),
          },
        } : {}),
        trustedProxies: options.trustedProxies ?? [],
        memberIds: (householdId) => service.getHouseholdMemberIds(householdId),
        isPasswordless: (userId) => service.isPasswordless(userId),
        users: () => service.listJellyfinUsers(),
        ...(options.householdApp ? {
          appAssets: AppAssets.load(),
          app: new HouseholdApp({
            ...options.householdApp,
            householdName: (householdId) => service.getHouseholdName(householdId),
            householdTotal: () => service.getHouseholdTotal(),
            hidden: {
              keys: (householdId, userId) => service.hiddenTitleKeys(householdId, userId),
              list: (householdId, userId) => service.listHiddenTitles(householdId, userId),
              hide: (input) => service.hideTitle(input),
              unhide: (input) => service.unhideTitle(input),
            },
            record: (endpoint, outcome) => service.recordAppRequest(endpoint, outcome),
            ...(options.householdGateway.logLevel ? { logLevel: options.householdGateway.logLevel } : {}),
          }),
        } : {}),
      })
    : undefined;
  const jellyfinVersion = options?.jellyfinVersion;
  const titleHolds = options?.titleHolds;
  const checkTitleHolds = () => { if (titleHolds) background.run((signal) => titleHolds.checkTitleHolds({ signal })); };
  const clientIp = new ClientIpResolver(options?.trustedProxies);
  // The address map as stored, joined with the legacy rule; checked now, so a conflict stops startup. Rebuilt when the
  // map changes (the store hands out the same object until then).
  const legacyRule = domain ? { domain, prefix: hostPrefix ?? 'jelly-' } : undefined;
  let addressSource = service.getHouseholdAddresses();
  let addressBook = new HouseholdAddresses(addressSource, legacyRule);
  const addresses = (): HouseholdAddresses => {
    const current = service.getHouseholdAddresses();
    if (current !== addressSource) {
      addressBook = new HouseholdAddresses(current, legacyRule);
      addressSource = current;
    }
    return addressBook;
  };
  // Address changes are checked against the map and stored one at a time, so two never pass the check together.
  let addressWrites: Promise<unknown> = Promise.resolve();
  const writeAddresses = <T>(write: () => Promise<T>): Promise<T> => {
    const next = addressWrites.then(write, write);
    addressWrites = next.catch(() => undefined);
    return next;
  };
  const householdAddresses = (groupId: string) => {
    const book = addresses();
    return { groupId, gateway: householdGateway !== undefined, ...book.addresses(groupId), ...(householdGateway && book.householdUrl(groupId) ? { householdUrl: book.householdUrl(groupId) } : {}) };
  };

  const handleWebhook = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    // 4.0.0 takes the token from the Authorization header only; a query token is refused whatever it is.
    if (url.searchParams.has('token')) {
      if (sameToken(url.searchParams.get('token') ?? '', tokens.webhook)) {
        service.recordRemovedWebhook('webhook_query_token_removed_use_authorization_header');
      }
      return json(response, 400, { error: 'webhook_query_token_removed_use_authorization_header' });
    }
    if (!authorized(request, tokens.webhook)) {
      return json(response, 401, { error: 'unauthorized' });
    }
    service.recordWebhookReceived();
    let event: ReturnType<typeof parseWebhook>;
    try {
      event = parseWebhook(await readJson(request, { requireJsonType: false }));
    } catch (error) {
      if (error instanceof Error && error.message === 'webhook_payload_removed_use_current_seerr_template') {
        service.recordRemovedWebhook(error.message);
        return json(response, 400, { error: error.message });
      }
      service.recordInvalidWebhook();
      throw error;
    }
    const result = await service.processWebhook(event);
    if (event.notificationType === 'MEDIA_AVAILABLE') checkTitleHolds();
    return json(response, result ? 200 : 202, result ? { status: 'granted', grant: result } : { status: 'ignored' });
  };

  // Node's own check would answer an HTTP/1.1 request with no Host with a bare 400 before any handler; on both
  // listeners singleHost gives it the fixed invalid_host answer instead.
  const admin = createServer({ requireHostHeader: false }, async (request, response) => {
    try {
      if (!singleHost(request)) return invalidHost(response);
      if (emptyFirstSegment(request)) return json(response, 404, { error: 'not_found' });
      if (removedPage(request)) return json(response, 410, { error: 'library_add_removed_use_household_app' });
      const url = new URL(request.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      // Cross-site request forgery: a state-changing request a browser sends with the session cookie must come from the
      // admin origin itself. SameSite=Strict alone is not enough, as every sibling host under the same site (household
      // hosts, Seerr) is same-site. Requests with ADMIN_TOKEN as a bearer token carry no ambient credential and are
      // exempt; so is the Seerr webhook, which has its own token.
      const sameOrigin = () => isSameOriginRequest(request);
      const forbidden = () => json(response, 403, { error: 'cross_origin_request_refused' });

      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { status: 'ok' });
      }
      if (request.method === 'GET' && url.pathname === '/') {
        return redirect(response, '/admin/');
      }
      if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
        return asset(request, response, 200, ADMIN_HTML_BYTES, 'text/html; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/admin/styles.css') {
        return asset(request, response, 200, Buffer.from(ADMIN_STYLES), 'text/css; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/admin/app.js') {
        return asset(request, response, 200, Buffer.from(ADMIN_APP_JS), 'text/javascript; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/admin/favicon.svg') {
        return asset(request, response, 200, Buffer.from(ADMIN_FAVICON_SVG), 'image/svg+xml; charset=utf-8');
      }
      if (request.method === 'POST' && url.pathname === '/auth/login') {
        if (!webAuth) return json(response, 404, { error: 'web_auth_not_configured' });
        if (!sameOrigin()) return forbidden();
        requireJsonBody(request);
        let body: Record<string, unknown>;
        try {
          body = recordBody(await readJson(request));
        } catch {
          body = {};
        }
        let login: { token: string; username: string } | null;
        try {
          login = await webAuth.login(body.username, body.password, clientIp.resolve(request.socket.remoteAddress, request.headers['x-forwarded-for']));
        } catch (error) {
          if (error instanceof Error && error.message === 'too_many_login_attempts') {
            return json(response, 429, { error: 'too_many_login_attempts' });
          }
          throw error;
        }
        if (!login) return json(response, 401, { error: 'invalid_credentials' });
        response.setHeader('Set-Cookie', sessionCookie(login.token, isSecureRequest(request)));
        return json(response, 200, { status: 'authenticated', username: login.username });
      }
      if (request.method === 'GET' && url.pathname === '/auth/session') {
        const session = webAuth ? await webAuth.session(request) : { status: 'none' as const };
        if (session.status === 'unavailable') return json(response, 503, { error: 'session_check_unavailable' });
        if (session.status !== 'active') return json(response, 401, { error: 'unauthorized' });
        return json(response, 200, { authenticated: true, username: session.username });
      }
      if (request.method === 'POST' && url.pathname === '/auth/logout') {
        if (!sameOrigin()) return forbidden();
        requireJsonIfBody(request);
        webAuth?.logout(request);
        response.setHeader('Set-Cookie', expiredSessionCookie(isSecureRequest(request)));
        return json(response, 200, { status: 'logged_out' });
      }
      if (request.method === 'POST' && url.pathname === '/webhooks/seerr') return await handleWebhook(request, response, url);
      if (!authorized(request, tokens.admin)) {
        // Refused before the session is looked at, so a cross-origin request never starts a session's check at Jellyfin
        // or sees its outcome (a 503, or a demoted administrator's session ended). Without a session cookie it is 401.
        if (!SAFE_METHODS.has(request.method ?? 'GET') && hasSessionCookie(request) && !sameOrigin()) return forbidden();
        const session = webAuth ? await webAuth.session(request) : { status: 'none' as const };
        if (session.status === 'unavailable') return json(response, 503, { error: 'session_check_unavailable' });
        if (session.status !== 'active') return json(response, 401, { error: 'unauthorized' });
      }

      if (request.method === 'POST' && url.pathname === '/v1/self-check') {
        requireJsonIfBody(request);
        const results = await options?.selfCheck?.run();
        if (!options?.selfCheck) return json(response, 404, { error: 'self_check_not_configured' });
        if (!results) { response.setHeader('Retry-After', '60'); return json(response, 429, { error: 'too_many_requests' }); }
        response.setHeader('Cache-Control', 'no-store');
        return json(response, 200, { results });
      }

      if (request.method === 'GET' && url.pathname === '/v1/webhooks/status') return json(response, 200, service.webhookStatus());
      if (request.method === 'GET' && url.pathname === '/metrics') {
        return text(response, 200, service.renderMetrics() + (jellyfinVersion?.renderMetrics() ?? ''), 'text/plain; version=0.0.4; charset=utf-8');
      }
      if (url.pathname === '/v1/jellyfin/version' || url.pathname === '/v1/jellyfin/version/confirmation') {
        if (request.method === 'GET' && url.pathname === '/v1/jellyfin/version') {
          if (!jellyfinVersion) return json(response, 404, { error: 'jellyfin_version_not_checked' });
          return json(response, 200, jellyfinVersion.status());
        }
        if (request.method === 'PUT' && url.pathname === '/v1/jellyfin/version/confirmation') {
          const body = recordBody(await readJson(request));
          if (!jellyfinVersion) return json(response, 404, { error: 'jellyfin_version_not_checked' });
          return json(response, 200, await jellyfinVersion.confirm(nonEmptyString(body.version, 'version')));
        }
        if (request.method === 'DELETE' && url.pathname === '/v1/jellyfin/version/confirmation') {
          requireJsonIfBody(request);
          if (!jellyfinVersion) return json(response, 404, { error: 'jellyfin_version_not_checked' });
          return json(response, 200, await jellyfinVersion.clearConfirmation());
        }
      }
      if (request.method === 'GET' && url.pathname === '/v1/app/outstanding') {
        return json(response, 200, service.appOutstanding());
      }
      if (request.method === 'GET' && url.pathname === '/v1/app/held') {
        return json(response, 200, service.appHeld());
      }
      if (url.pathname === '/v1/app/requests' || url.pathname.startsWith('/v1/app/requests/') || url.pathname.startsWith('/v1/app/held/')) {
        const adminRequests = options?.adminRequests;
        if (request.method === 'GET' && url.pathname === '/v1/app/requests') {
          if (!adminRequests) return json(response, 404, { error: 'requests_not_configured' });
          return json(response, 200, await adminRequests.list());
        }
        const action = request.method === 'POST' && segments.length === 5 && segments[0] === 'v1' && segments[1] === 'app' ? segments[4] : undefined;
        if (segments[2] === 'requests' && (action === 'approve' || action === 'decline' || action === 'cancel')) {
          const body = action === 'cancel' ? await optionalBody(request) : (requireJsonIfBody(request), {});
          if (!adminRequests) return json(response, 404, { error: 'requests_not_configured' });
          const requestId = segments[3] ?? '';
          if (action === 'approve') return json(response, 200, await adminRequests.approve(requestId));
          if (action === 'decline') return json(response, 200, await adminRequests.decline(requestId));
          if (Object.keys(body).some((key) => key !== 'removeFromRadarr')) throw new Error('body must contain only removeFromRadarr');
          return json(response, 200, await adminRequests.cancel(requestId, { removeFromRadarr: optionalBoolean(body.removeFromRadarr, 'removeFromRadarr') }));
        }
        if (segments[2] === 'held' && action === 'release') {
          const body = recordBody(await readJson(request));
          if (!adminRequests) return json(response, 404, { error: 'requests_not_configured' });
          const householdIds = stringArray(body.householdIds, 'householdIds').map((id) => validId(id, 'householdId'));
          if (!/^[1-9][0-9]{0,15}$/.test(segments[3] ?? '')) throw new Error('requestId is invalid');
          return json(response, 200, await adminRequests.release(segments[3] as string, householdIds));
        }
      }
      if (request.method === 'GET' && url.pathname === '/v1/grants') {
        return json(response, 200, { grants: service.listGrants() });
      }
      if (request.method === 'GET' && url.pathname === '/v1/groups') {
        const book = addresses();
        return json(response, 200, { groups: service.listGroups().map((group) => {
          const { origin, aliases, legacy } = book.addresses(group.id);
          const householdUrl = householdGateway ? book.householdUrl(group.id) : undefined;
          return {
            ...group,
            ...(householdUrl ? { householdUrl } : {}),
            // Every address that selects the household, the canonical one first (shown where householdUrl is).
            ...(householdGateway ? { householdAddresses: [origin, ...aliases, legacy].filter((address) => address !== undefined) } : {}),
          };
        }) });
      }
      if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'groups' && segments[3] === 'addresses') {
        if (request.method === 'GET') {
          const groupId = validId(segments[2], 'groupId').toLowerCase();
          if (!service.getHouseholdMemberIds(groupId)) throw new Error('group not found');
          return json(response, 200, householdAddresses(groupId));
        }
        if (request.method === 'PUT') {
          const body = recordBody(await readJson(request));
          if (Object.keys(body).some((key) => key !== 'origin' && key !== 'aliases')) throw new Error('body must contain only origin and aliases');
          const groupId = validId(segments[2], 'groupId').toLowerCase();
          const entry = normalizeEntry(body as { origin: unknown; aliases?: unknown });
          await writeAddresses(async () => {
            addresses().with(groupId, entry);
            await service.setHouseholdAddresses(groupId, entry);
          });
          return json(response, 200, { status: 'saved', ...householdAddresses(groupId) });
        }
        if (request.method === 'DELETE') {
          requireJsonIfBody(request);
          const groupId = validId(segments[2], 'groupId').toLowerCase();
          await writeAddresses(() => service.setHouseholdAddresses(groupId, undefined));
          return json(response, 200, { status: 'deleted', ...householdAddresses(groupId) });
        }
      }
      if (request.method === 'GET' && url.pathname === '/v1/users') {
        return json(response, 200, {
          users: await service.listUsers(),
          jellyseerrImportAvailable: service.canImportJellyfinUsersToSeerr(),
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/users') {
        const body = recordBody(await readJson(request));
        const username = userName(body.username);
        const password = newUserPassword(body.password);
        const groupId = validId(nonEmptyString(body.groupId, 'groupId'), 'groupId');
        const importToSeerr = optionalBoolean(body.importToJellyseerr, 'importToJellyseerr');
        const result = await service.createUserInGroup({ username, password, groupId, importToSeerr });
        return json(response, 201, { status: 'created', ...result });
      }
      if (request.method === 'PUT' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'users' && segments[3] === 'sign-in') {
        const body = recordBody(await readJson(request));
        if (typeof body.passwordless !== 'boolean') throw new Error('passwordless must be a boolean');
        const user = await service.setUserPasswordless(validId(segments[2], 'userId'), body.passwordless);
        return json(response, 200, { status: 'saved', user });
      }
      if (request.method === 'GET' && url.pathname === '/v1/requests/recent') {
        return json(response, 200, { requests: await service.listRecentRequests(RECENT_REQUESTS_LIMIT) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/requests/poster') {
        const poster = await service.getRequestPoster(nonEmptyString(url.searchParams.get('path'), 'posterPath'));
        return image(response, poster.body, poster.contentType);
      }
      if (request.method === 'GET' && url.pathname === '/v1/library/search') {
        const query = nonEmptyString(url.searchParams.get('q'), 'q');
        if (query.length < 2) return json(response, 400, { error: 'q must contain at least 2 characters' });
        return json(response, 200, { items: await service.searchLibrary(query) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/library/poster') {
        const poster = await service.getLibraryPoster(validId(url.searchParams.get('itemId') ?? undefined, 'itemId'));
        return image(response, poster.body, poster.contentType);
      }
      if (request.method === 'GET' && url.pathname === '/v1/library') {
        return json(response, 200, service.getLibraryCatalog());
      }
      if (request.method === 'POST' && url.pathname === '/v1/library/sync') {
        requireJsonIfBody(request);
        const catalog = await service.syncLibraryCatalog();
        checkTitleHolds();
        return json(response, 200, { status: 'synced', ...catalog });
      }
      if (request.method === 'PUT' && url.pathname === '/v1/library/access') {
        const body = recordBody(await readJson(request));
        const dryRun = url.searchParams.get('dryRun') === 'true';
        const result = await service.setBulkManualAccess({
          itemIds: stringArray(body.itemIds, 'itemIds').map((id) => validId(id, 'itemId')),
          userIds: stringArray(body.userIds, 'userIds').map((id) => validId(id, 'userId')),
          groupIds: stringArray(body.groupIds, 'groupIds').map((id) => validId(id, 'groupId')),
        }, dryRun);
        return json(response, 200, { status: dryRun ? 'planned' : 'updated', result });
      }
      if (request.method === 'POST' && url.pathname === '/v1/reconcile') {
        requireJsonIfBody(request);
        const dryRun = url.searchParams.get('dryRun') === 'true';
        const plans = await service.reconcileAll({ dryRun });
        return json(response, 200, { status: dryRun ? 'planned' : 'reconciled', plans });
      }
      if (request.method === 'GET' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'grants' && segments[3] === 'plan') {
        return json(response, 200, { plan: await service.planGrant(validId(segments[2], 'itemId')) });
      }
      if (request.method === 'DELETE' && segments.length === 5 && segments[0] === 'v1' && segments[1] === 'grants' && segments[3] === 'requests') {
        requireJsonIfBody(request);
        const dryRun = url.searchParams.get('dryRun') === 'true';
        const result = await service.revokeRequest(validId(segments[2], 'itemId'), validId(segments[4], 'requestId'), dryRun);
        return json(response, 200, { status: dryRun ? 'planned' : 'revoked', result });
      }
      if (request.method === 'PUT' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'grants' && segments[3] === 'groups') {
        const body = recordBody(await readJson(request));
        const dryRun = url.searchParams.get('dryRun') === 'true';
        const result = await service.setGrantGroups(validId(segments[2], 'itemId'), stringArray(body.groupIds, 'groupIds'), dryRun);
        return json(response, 200, { status: dryRun ? 'planned' : 'updated', result });
      }
      if (request.method === 'POST' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'grants' && segments[3] === 'remap') {
        const body = recordBody(await readJson(request));
        const dryRun = url.searchParams.get('dryRun') === 'true';
        const toItemId = validId(typeof body.toItemId === 'string' ? body.toItemId.trim() : undefined, 'toItemId');
        const result = await service.remapGrant(validId(segments[2], 'itemId'), toItemId, dryRun);
        return json(response, 200, { status: dryRun ? 'planned' : 'remapped', result });
      }
      if (request.method === 'PUT' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'grants' && segments[3] === 'manual') {
        const body = recordBody(await readJson(request));
        const mediaType = typeof body.mediaType === 'string' && body.mediaType.trim() ? body.mediaType.trim() : undefined;
        const result = await service.setManualAccess({
          itemId: validId(segments[2], 'itemId'),
          userIds: stringArray(body.userIds, 'userIds').map((id) => validId(id, 'userId')),
          groupIds: stringArray(body.groupIds, 'groupIds').map((id) => validId(id, 'groupId')),
          ...(mediaType ? { mediaType } : {}),
        }, url.searchParams.get('dryRun') === 'true');
        return json(response, 200, { status: url.searchParams.get('dryRun') === 'true' ? 'planned' : 'imported', result });
      }
      if (request.method === 'PUT' && segments.length === 3 && segments[0] === 'v1' && segments[1] === 'groups') {
        const body = recordBody(await readJson(request));
        const group = await service.upsertGroup({
          id: validId(segments[2], 'groupId'),
          name: nonEmptyString(body.name, 'name'),
          userIds: stringArray(body.userIds, 'userIds').map((id) => validId(id, 'userId')),
        });
        return json(response, 200, { status: 'saved', group });
      }
      if (request.method === 'DELETE' && segments.length === 3 && segments[0] === 'v1' && segments[1] === 'groups') {
        requireJsonIfBody(request);
        return json(response, 200, { status: 'deleted', result: await service.deleteGroup(validId(segments[2], 'groupId')) });
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      answerError(response, error);
    }
  });
  // The admin listener proxies nothing, so it upgrades nothing and opens no tunnel.
  admin.on('upgrade', (request, socket) => {
    if (!singleHost(request)) return invalidHostUpgrade(socket);
    socket.destroy();
  });
  refuseInvalidMethods(admin);
  admin.on('connect', (_request, socket) => socket.destroy());

  if (!householdGateway) {
    return { admin: Object.assign(admin, { closeWebSockets: async () => 0 }) };
  }
  const member = createServer({ requireHostHeader: false }, async (request, response) => {
    try {
      if (!singleHost(request)) return invalidHost(response);
      if (emptyFirstSegment(request)) return json(response, 404, { error: 'not_found' });
      const household = addresses().resolve(request.headers.host);
      if (household) {
        if (removedPage(request)) return json(response, 410, { error: 'library_add_removed_use_household_app' });
        // The deployment self-check's own request back through the reverse proxy (see self-check.ts).
        if (options?.selfCheck?.handleProxyRequest(request, response)) return;
        // Every household address, whichever source gave it, waits on the Jellyfin version check.
        const decision = jellyfinVersion ? await jellyfinVersion.householdDecision() : 'serve';
        if (decision !== 'serve') return versionRefused(response, decision);
        await householdGateway.handle(request, response, household.householdId, household.origin);
        return;
      }
      // The request target is parsed only to look for the legacy webhook; otherwise it is never read.
      if (options?.memberWebhook && request.method === 'POST') {
        let url: URL;
        try {
          url = new URL(request.url ?? '/', 'http://localhost');
        } catch {
          return json(response, 400, { error: 'invalid_request_target' });
        }
        if (url.pathname === '/webhooks/seerr') return await handleWebhook(request, response, url);
      }
      // No household's address: the same answer for every path and method, and never the admin site.
      return json(response, 421, { error: 'unknown_host' });
    } catch (error) {
      answerError(response, error);
    }
  });
  refuseInvalidMethods(member);
  // Node emits CONNECT separately from ordinary requests; never open a household tunnel.
  member.on('connect', (request, socket) => {
    socket.on('error', () => socket.destroy());
    if (!addresses().resolve(request.headers.host)) { socket.destroy(); return; }
    refuseMethod(socket);
  });
  member.on('upgrade', (request, socket, head) => {
    if (!singleHost(request)) return invalidHostUpgrade(socket);
    const household = addresses().resolve(request.headers.host);
    if (!household) {
      socket.destroy();
      return;
    }
    const decided = (settled: HouseholdDecision) => {
      if (socket.destroyed) return;
      if (settled === 'serve') {
        householdGateway.handleUpgrade(request, socket, head, household.householdId);
        return;
      }
      const { headers, body } = versionRefusal(settled);
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
      refuseSocket(socket, `HTTP/1.1 503 Service Unavailable\r\n${lines}Connection: close\r\n\r\n${body}`);
    };
    if (!jellyfinVersion || jellyfinVersion.decision() === 'serve') {
      decided('serve');
      return;
    }
    // Waiting for the version: a client reset meanwhile must not be an unhandled 'error' event (see handleUpgrade).
    const ignore = () => socket.destroy();
    socket.on('error', ignore);
    void jellyfinVersion.householdDecision().then((settled) => {
      socket.off('error', ignore);
      decided(settled);
    });
  });
  return {
    admin: Object.assign(admin, { closeWebSockets: async () => 0 }),
    member: Object.assign(member, { closeWebSockets: () => householdGateway.closeWebSockets() }),
  };
}

/**
 * A target that starts with two slashes or backslashes (`//`, `/\evil.example`): the URL parser reads it as a host,
 * not a path, so both listeners refuse it with a fixed 404 right after the Host check, before anything parses or routes
 * it (the household gateway refuses its other empty segments itself).
 */
function emptyFirstSegment(request: IncomingMessage): boolean {
  return /^[/\\]{2}/.test(request.url ?? '/');
}

/** The add-to-library page, removed in 4.0.0; answered 410. URL.parse, as `new URL` throws on some targets. */
function removedPage(request: IncomingMessage): boolean {
  return ['/jellypass/add', '/jellypass/add.js', '/jellypass/add.css'].includes(URL.parse(request.url ?? '/', 'http://localhost')?.pathname ?? '');
}

/**
 * Answers a request whose method token is invalid with a fixed 404. Other client errors are left to Node, so it keeps
 * its own timeout, parser-error and in-flight-response handling.
 */
function refuseInvalidMethods(server: Server): void {
  const emit = server.emit;
  server.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'clientError' && (args[0] as NodeJS.ErrnoException).code !== 'HPE_INVALID_METHOD') return false;
    return Reflect.apply(emit, this, [event, ...args]);
  };
  server.on('clientError', (_error, socket) => refuseMethod(socket));
}

/** The fixed 404 for an invalid method or a household CONNECT, written to the raw socket. */
function refuseMethod(socket: Duplex): void {
  socket.on('error', () => socket.destroy());
  const responseStarted = (socket as Duplex & { _httpMessage?: ServerResponse })._httpMessage?.headersSent;
  if (!socket.writable || responseStarted) { socket.destroy(); return; }
  // Parser errors and CONNECT detach from the HTTP timeouts. Bound even a stalled write.
  const timer = setTimeout(() => socket.destroy(), 500);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  const body = '{"error":"not_found"}';
  socket.end(`HTTP/1.1 404 Not Found\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`, () => socket.destroy());
}

const HOST_VALUE = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/;
const INVALID_HOST = JSON.stringify({ error: 'invalid_host' });

/**
 * Whether the request names exactly one host: one Host header (none only from an HTTP/1.0 client), a plain host[:port]
 * with no userinfo, whitespace or other characters and a port, if any, from 1 to 65535, and for an absolute-form target
 * the same authority as the Host.
 * Node keeps only the first of several Host headers in `request.headers.host` while a proxy in front may route on
 * another, so both listeners refuse anything else with a fixed 400 before the target is parsed or anything relayed.
 */
function singleHost(request: IncomingMessage): boolean {
  const hosts: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'host') hosts.push(request.rawHeaders[index + 1] ?? '');
  }
  if (hosts.length > 1 || (hosts.length === 0 && request.httpVersion !== '1.0')) return false;
  const [host] = hosts;
  if (host !== undefined) {
    const value = HOST_VALUE.exec(host);
    if (!value) return false;
    const port = value[1] === undefined ? undefined : Number(value[1]);
    if (port !== undefined && (port < 1 || port > 65_535)) return false;
  }
  const target = request.url ?? '';
  if (target.startsWith('/') || target === '*') return true;
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(target)?.[1];
  return authority !== undefined && host !== undefined && authority.toLowerCase() === host.toLowerCase();
}

/** The fixed answer to a request {@link singleHost} refuses; the connection is closed after it. */
function invalidHost(response: ServerResponse): void {
  response.setHeader('Connection', 'close');
  json(response, 400, { error: 'invalid_host' });
}

/** {@link invalidHost} for a WebSocket upgrade, written to the raw socket. */
function invalidHostUpgrade(socket: Duplex): void {
  refuseSocket(
    socket,
    'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(INVALID_HOST)}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n${INVALID_HOST}`,
  );
}

/** How long a refused raw socket may take to flush its answer before it is destroyed anyway. */
const REFUSAL_FLUSH_MS = 1_000;

/**
 * Writes a whole HTTP answer to a raw socket (an upgrade's) and then destroys it. `end()` alone closes only the write
 * side, so a client that keeps its own side open (allowHalfOpen) would hold the server socket readable indefinitely;
 * a client that stops reading cannot hold it past REFUSAL_FLUSH_MS either.
 */
function refuseSocket(socket: Duplex, answer: string): void {
  const destroy = () => socket.destroy();
  const timer = setTimeout(destroy, REFUSAL_FLUSH_MS);
  timer.unref();
  socket.on('error', destroy).once('close', () => clearTimeout(timer));
  socket.end(answer, destroy);
}

/** The admin API's (and the webhook's) answer to an error a handler threw. */
function answerError(response: ServerResponse, error: unknown): void {
  if (error instanceof UserProvisioningError) {
    console.error(JSON.stringify({ level: 'error', message: error.message, userId: error.user.id }));
    return json(response, 502, {
      error: error.message,
      code: error.stage === 'household' ? 'user_created_household_assignment_failed' : 'user_created_jellyseerr_import_failed',
      user: error.user,
      ...(error.group ? { group: error.group } : {}),
    });
  }
  if (error instanceof UnsupportedMediaTypeError) return json(response, 415, { error: 'unsupported_media_type' });
  if (error instanceof AdminActionLimitError) return json(response, 429, { error: 'too_many_requests' });
  if (error instanceof AdminSeerrError) return json(response, 502, { error: error.message });
  if (error instanceof ConflictError) return json(response, 409, { error: error.message, code: error.code });
  if (error instanceof VersionConfirmationError) return json(response, 409, { error: error.message });
  if (error instanceof HouseholdAddressError) return json(response, error.code === 'address_conflict' ? 409 : 400, { error: error.message, code: error.code });
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(JSON.stringify({ level: 'error', message }));
  const status = message.includes('not found') ? 404 : isClientError(message) ? 400 : 502;
  return json(response, status, { error: message });
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  return sameToken(supplied, expectedToken);
}

function sameToken(supplied: string, expectedToken: string): boolean {
  const left = createHash('sha256').update(supplied).digest();
  const right = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(left, right);
}

/**
 * Refuses a body not declared as JSON on a matched state-changing route that never reads one, before its handler runs
 * and without reading the body. A body is a non-zero Content-Length or any Transfer-Encoding; a body-less request passes
 * whatever its Content-Type. Unknown paths and methods are not checked, so they stay 404.
 */
function requireJsonIfBody(request: IncomingMessage): void {
  if (request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? 0) > 0) requireJsonBody(request);
}

/** Refuses a body not declared as `application/json` (parameters such as charset allowed), before any of it is read. */
function requireJsonBody(request: IncomingMessage): void {
  const mediaType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new UnsupportedMediaTypeError('unsupported_media_type');
}

/**
 * Reads a JSON body. Admin requests must declare it as JSON, so a cross-site form or `no-cors` fetch (which can only send
 * text/plain, form or multipart bodies) never reaches a handler. The Seerr webhook keeps accepting any declared type.
 */
async function readJson(request: IncomingMessage, { requireJsonType = true } = {}): Promise<unknown> {
  if (requireJsonType) requireJsonBody(request);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error('body must be smaller than 64 KiB');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('body must be valid JSON');
  }
}

/** An optional JSON object body: none (or an empty one) is `{}`; one that is there must be declared as JSON. */
async function optionalBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  requireJsonIfBody(request);
  if (request.headers['transfer-encoding'] === undefined && Number(request.headers['content-length'] ?? 0) === 0) return {};
  return recordBody(await readJson(request));
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object');
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function userName(value: unknown): string {
  const username = nonEmptyString(value, 'username');
  if (username.length > 128 || /[\u0000-\u001f\u007f]/.test(username)) throw new Error('username is invalid');
  return username;
}

function newUserPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || (value.length > 0 && value.length < 8)) {
    throw new Error('password must be empty or contain between 8 and 256 characters');
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${name} must be an array of strings`);
  return value as string[];
}

function optionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function validId(value: string | undefined, name: string): string {
  if (!value || !ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function isClientError(message: string): boolean {
  return ['must be', 'must contain', 'invalid', 'unsupported', 'missing', 'already in use'].some((part) => message.includes(part));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  text(response, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function text(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  response.end(body);
}

/**
 * Headers for the admin UI's own files: the household app's set. The UI posts no forms (every form's submit is handled
 * by script with fetch), so form-action is 'none'.
 */
function asset(request: IncomingMessage, response: ServerResponse, status: number, body: Buffer, contentType: string): void {
  // The page is marked no-transform and compressed (see html-response.ts); its script, styles and icon are sent as they are.
  writeWhole(request, response, status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': APP_PERMISSIONS_POLICY,
  }, body);
}

function image(response: ServerResponse, body: Uint8Array, upstreamContentType: string): void {
  const contentType = /^image\/(?:avif|jpeg|png|webp)$/i.test(upstreamContentType.split(';')[0]?.trim() ?? '')
    ? upstreamContentType
    : 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
    'Cache-Control': 'private, max-age=86400',
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  response.end(body);
}

/**
 * A household host's fixed 503, when enforcing, while the Jellyfin version is untested and not confirmed, or not known:
 * never relayed to Jellyfin, and the same for every path and for a WebSocket upgrade, so it tells a caller nothing but
 * that.
 */
function versionRefusal(decision: Exclude<HouseholdDecision, 'serve'>): { headers: Record<string, string>; body: string } {
  const body = decision === 'refuse' ? UNTESTED_VERSION_MESSAGE : UNKNOWN_VERSION_MESSAGE;
  return {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      ...NEVER_STORE,
      'X-Content-Type-Options': 'nosniff',
      'Retry-After': decision === 'refuse' ? '300' : '5',
    },
    body,
  };
}

function versionRefused(response: ServerResponse, decision: Exclude<HouseholdDecision, 'serve'>): void {
  const { headers, body } = versionRefusal(decision);
  response.writeHead(503, headers).end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end();
}
