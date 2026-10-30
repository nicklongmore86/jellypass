import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ConflictError, UserProvisioningError, type AccessService } from './access-service.js';
import { HouseholdApp, type HouseholdAppOptions } from './app-api.js';
import { AdminActionLimitError, AdminSeerrError, type AdminRequests } from './admin-requests.js';
import { ADMIN_APP_JS, ADMIN_FAVICON_SVG, ADMIN_HTML, ADMIN_STYLES } from './admin-ui.js';
import { APP_PERMISSIONS_POLICY, AppAssets, NEVER_STORE } from './app-assets.js';
import { expiredSessionCookie, hasSessionCookie, isSameOriginRequest, isSecureRequest, sessionCookie, type WebAuth } from './auth.js';
import { ClientIpResolver } from './client-ip.js';
import type { LogLevel } from './config.js';
import { HouseholdGateway } from './household-gateway.js';
import type { HouseholdRequests } from './household-requests.js';
import { UNKNOWN_VERSION_MESSAGE, UNTESTED_VERSION_MESSAGE, VersionConfirmationError, type HouseholdDecision, type JellyfinVersionGate } from './jellyfin-version.js';
import { RECENT_REQUESTS_LIMIT } from './seerr.js';
import { BackgroundTasks } from './shutdown.js';
import { TvAssets } from './tv-assets.js';
import { parseWebhook } from './webhook.js';

const BODY_LIMIT = 64 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A request body that is not declared as JSON; answered 415 before any of it is read. */
class UnsupportedMediaTypeError extends Error {}

export interface ServerTokens {
  webhook: string;
  admin: string;
}

export interface ServerOptions {
  /** Reverse proxies trusted to report the client address in X-Forwarded-For; empty uses the TCP peer. */
  trustedProxies?: string[];
  householdGateway?: {
    jellyfinUrl: string;
    domain: string;
    hostPrefix: string;
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
   * Runs household "Add to my library" joins after their answer. Pass the BackgroundTasks shutdown stops, so it can
   * abort them and wait for them before closing the store; without it, joins run untracked.
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
   * The Jellyfin version check (docs: README, "Supported Jellyfin versions"): household hosts answer a fixed 503 unless
   * it decides they serve, and the admin API reads and confirms it at /v1/jellyfin/version. Without it household hosts
   * serve whatever the version.
   */
  jellyfinVersion?: Pick<JellyfinVersionGate, 'decision' | 'householdDecision' | 'status' | 'confirm' | 'clearConfirmation' | 'renderMetrics'>;
}

export interface JellyPassServer extends Server {
  /** Closes every proxied household WebSocket and refuses new upgrades; resolves with how many were open. */
  closeWebSockets(): Promise<number>;
}

export function makeServer(
  service: AccessService,
  tokens: ServerTokens,
  webAuth?: WebAuth,
  options?: ServerOptions,
): JellyPassServer {
  const background = options?.background ?? new BackgroundTasks();
  const { tvAddon: tvOption, ...gatewayOptions } = options?.householdGateway ?? {};
  const tvHouseholds = tvOption?.households;
  const householdGateway = options?.householdGateway
    ? new HouseholdGateway({
        ...gatewayOptions,
        jellyfinUrl: options.householdGateway.jellyfinUrl,
        domain: options.householdGateway.domain,
        hostPrefix: options.householdGateway.hostPrefix,
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
            record: (endpoint, outcome) => service.recordAppRequest(endpoint, outcome),
            ...(options.householdGateway.logLevel ? { logLevel: options.householdGateway.logLevel } : {}),
          }),
        } : {}),
        ...(service.canJoinLibrary() ? {
          libraryJoin: {
            start: (input) => background.run((signal) => service.joinLibrary(input, { signal })),
            dropped: () => service.recordLibraryJoinDropped(),
          },
        } : {}),
      })
    : undefined;
  const jellyfinVersion = options?.jellyfinVersion;
  const titleHolds = options?.titleHolds;
  const checkTitleHolds = () => { if (titleHolds) background.run((signal) => titleHolds.checkTitleHolds({ signal })); };
  const clientIp = new ClientIpResolver(options?.trustedProxies);
  const server = createServer(async (request, response) => {
    try {
      const householdId = householdGateway?.householdId(request.headers.host);
      if (householdId) {
        const decision = jellyfinVersion ? await jellyfinVersion.householdDecision() : 'serve';
        if (decision !== 'serve') return versionRefused(response, decision);
        await householdGateway?.handle(request, response, householdId);
        return;
      }
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
        return asset(response, 200, ADMIN_HTML, 'text/html; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/admin/styles.css') {
        return asset(response, 200, ADMIN_STYLES, 'text/css; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/admin/app.js') {
        return asset(response, 200, ADMIN_APP_JS, 'text/javascript; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/admin/favicon.svg') {
        return asset(response, 200, ADMIN_FAVICON_SVG, 'image/svg+xml; charset=utf-8');
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
      if (request.method === 'POST' && url.pathname === '/webhooks/seerr') {
        if (!authorized(request, tokens.webhook) && !sameToken(url.searchParams.get('token') ?? '', tokens.webhook)) {
          return json(response, 401, { error: 'unauthorized' });
        }
        service.recordWebhookReceived();
        let event: ReturnType<typeof parseWebhook>;
        try {
          event = parseWebhook(await readJson(request, { requireJsonType: false }));
        } catch (error) {
          service.recordInvalidWebhook();
          throw error;
        }
        const result = await service.processWebhook(event);
        if (event.notificationType === 'MEDIA_AVAILABLE') checkTitleHolds();
        return json(response, result ? 200 : 202, result ? { status: 'granted', grant: result } : { status: 'ignored' });
      }
      if (!authorized(request, tokens.admin)) {
        // Refused before the session is looked at, so a cross-origin request never starts a session's check at Jellyfin
        // or sees its outcome (a 503, or a demoted administrator's session ended). Without a session cookie it is 401.
        if (!SAFE_METHODS.has(request.method ?? 'GET') && hasSessionCookie(request) && !sameOrigin()) return forbidden();
        const session = webAuth ? await webAuth.session(request) : { status: 'none' as const };
        if (session.status === 'unavailable') return json(response, 503, { error: 'session_check_unavailable' });
        if (session.status !== 'active') return json(response, 401, { error: 'unauthorized' });
      }

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
        return json(response, 200, { groups: service.listGroups().map((group) => ({
          ...group,
          ...(householdGateway?.householdUrl(group.id) ? { householdUrl: householdGateway.householdUrl(group.id) } : {}),
        })) });
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
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(JSON.stringify({ level: 'error', message }));
      const status = message.includes('not found') ? 404 : isClientError(message) ? 400 : 502;
      return json(response, status, { error: message });
    }
  });
  server.on('upgrade', (request, socket, head) => {
    const householdId = householdGateway?.householdId(request.headers.host);
    if (!householdGateway || !householdId) {
      socket.destroy();
      return;
    }
    if (!jellyfinVersion || jellyfinVersion.decision() === 'serve') {
      householdGateway.handleUpgrade(request, socket, head, householdId);
      return;
    }
    // Waiting for the version: a client reset meanwhile must not be an unhandled 'error' event (see handleUpgrade).
    const ignore = () => socket.destroy();
    socket.on('error', ignore);
    void jellyfinVersion.householdDecision().then((settled) => {
      socket.off('error', ignore);
      if (socket.destroyed) return;
      if (settled === 'serve') householdGateway.handleUpgrade(request, socket, head, householdId);
      else {
        const { headers, body } = versionRefusal(settled);
        const head = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
        socket.on('error', ignore).end(`HTTP/1.1 503 Service Unavailable\r\n${head}Connection: close\r\n\r\n${body}`);
      }
    });
  });
  return Object.assign(server, {
    closeWebSockets: async () => householdGateway ? householdGateway.closeWebSockets() : 0,
  });
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
function asset(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': APP_PERMISSIONS_POLICY,
  });
  response.end(body);
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
 * A household host's fixed 503 while the Jellyfin version is untested and not confirmed, or not known: never relayed
 * to Jellyfin, and the same for every path and for a WebSocket upgrade, so it tells a caller nothing but that.
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
