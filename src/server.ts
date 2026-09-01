import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { UserProvisioningError, type AccessService } from './access-service.js';
import { ADMIN_APP_JS, ADMIN_FAVICON_SVG, ADMIN_HTML, ADMIN_STYLES } from './admin-ui.js';
import { expiredSessionCookie, sessionCookie, type WebAuth } from './auth.js';
import { HouseholdGateway } from './household-gateway.js';
import { parseWebhook } from './webhook.js';

const BODY_LIMIT = 64 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export interface ServerTokens {
  webhook: string;
  admin: string;
}

export interface ServerOptions {
  householdGateway?: {
    jellyfinUrl: string;
    domain: string;
    hostPrefix: string;
  };
}

export function makeServer(service: AccessService, tokens: ServerTokens, webAuth?: WebAuth, options?: ServerOptions) {
  const householdGateway = options?.householdGateway
    ? new HouseholdGateway({
        ...options.householdGateway,
        memberIds: (householdId) => service.getHouseholdMemberIds(householdId),
      })
    : undefined;
  const server = createServer(async (request, response) => {
    try {
      const householdId = householdGateway?.householdId(request.headers.host);
      if (householdId) {
        await householdGateway?.handle(request, response, householdId);
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

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
        const body = recordBody(await readJson(request));
        const username = nonEmptyString(body.username, 'username');
        const password = nonEmptyString(body.password, 'password');
        let login: { token: string; username: string } | null;
        try {
          login = await webAuth.login(username, password, request.socket.remoteAddress ?? 'unknown');
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
        const session = webAuth?.session(request);
        if (!session) return json(response, 401, { error: 'unauthorized' });
        return json(response, 200, { authenticated: true, username: session.username });
      }
      if (request.method === 'POST' && url.pathname === '/auth/logout') {
        webAuth?.logout(request);
        response.setHeader('Set-Cookie', expiredSessionCookie(isSecureRequest(request)));
        return json(response, 200, { status: 'logged_out' });
      }
      if (request.method === 'POST' && url.pathname === '/webhooks/seerr') {
        if (!authorized(request, tokens.webhook) && !sameToken(url.searchParams.get('token') ?? '', tokens.webhook)) {
          return json(response, 401, { error: 'unauthorized' });
        }
        const result = await service.processWebhook(parseWebhook(await readJson(request)));
        return json(response, result ? 200 : 202, result ? { status: 'granted', grant: result } : { status: 'ignored' });
      }
      if (!authorized(request, tokens.admin) && !webAuth?.session(request)) {
        return json(response, 401, { error: 'unauthorized' });
      }

      if (request.method === 'GET' && url.pathname === '/metrics') {
        return text(response, 200, service.renderMetrics(), 'text/plain; version=0.0.4; charset=utf-8');
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
        const importToJellyseerr = optionalBoolean(body.importToJellyseerr, 'importToJellyseerr');
        const result = await service.createUserInGroup({ username, password, groupId, importToJellyseerr });
        return json(response, 201, { status: 'created', ...result });
      }
      if (request.method === 'GET' && url.pathname === '/v1/requests/recent') {
        return json(response, 200, { requests: await service.listRecentRequests(8) });
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
      if (request.method === 'GET' && url.pathname === '/v1/library') {
        return json(response, 200, service.getLibraryCatalog());
      }
      if (request.method === 'POST' && url.pathname === '/v1/library/sync') {
        const catalog = await service.syncLibraryCatalog();
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
        const dryRun = url.searchParams.get('dryRun') === 'true';
        const plans = await service.reconcileAll({ dryRun });
        return json(response, 200, { status: dryRun ? 'planned' : 'reconciled', plans });
      }
      if (request.method === 'GET' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'grants' && segments[3] === 'plan') {
        return json(response, 200, { plan: await service.planGrant(validId(segments[2], 'itemId')) });
      }
      if (request.method === 'DELETE' && segments.length === 5 && segments[0] === 'v1' && segments[1] === 'grants' && segments[3] === 'requests') {
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
    householdGateway.handleUpgrade(request, socket, head, householdId);
  });
  return server;
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

async function readJson(request: IncomingMessage): Promise<unknown> {
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

function isSecureRequest(request: IncomingMessage): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return protocol?.split(',')[0]?.trim().toLowerCase() === 'https';
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
  });
  response.end(body);
}

function asset(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
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
  });
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end();
}
