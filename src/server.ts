import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AccessService } from './access-service.js';
import { parseWebhook } from './webhook.js';

const BODY_LIMIT = 64 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export interface ServerTokens {
  webhook: string;
  admin: string;
}

export function makeServer(service: AccessService, tokens: ServerTokens) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { status: 'ok' });
      }
      if (request.method === 'POST' && url.pathname === '/webhooks/seerr') {
        if (!authorized(request, tokens.webhook)) return json(response, 401, { error: 'unauthorized' });
        const result = await service.processWebhook(parseWebhook(await readJson(request)));
        return json(response, result ? 200 : 202, result ? { status: 'granted', grant: result } : { status: 'ignored' });
      }
      if (!authorized(request, tokens.admin)) return json(response, 401, { error: 'unauthorized' });

      if (request.method === 'GET' && url.pathname === '/metrics') {
        return text(response, 200, service.renderMetrics(), 'text/plain; version=0.0.4; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/v1/grants') {
        return json(response, 200, { grants: service.listGrants() });
      }
      if (request.method === 'GET' && url.pathname === '/v1/groups') {
        return json(response, 200, { groups: service.listGroups() });
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
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(JSON.stringify({ level: 'error', message }));
      const status = message.includes('not found') ? 404 : isClientError(message) ? 400 : 502;
      return json(response, status, { error: message });
    }
  });
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
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

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${name} must be an array of strings`);
  return value as string[];
}

function validId(value: string | undefined, name: string): string {
  if (!value || !ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function isClientError(message: string): boolean {
  return ['must be', 'invalid', 'unsupported', 'missing'].some((part) => message.includes(part));
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
