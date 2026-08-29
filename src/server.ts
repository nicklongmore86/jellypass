import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AccessService } from './access-service.js';
import { parseWebhook } from './webhook.js';

const BODY_LIMIT = 64 * 1024;

export function makeServer(service: AccessService, token: string) {
  let mutationQueue = Promise.resolve();

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { status: 'ok' });
      }
      if (!authorized(request, token)) return json(response, 401, { error: 'unauthorized' });

      if (request.method === 'GET' && url.pathname === '/v1/grants') {
        return json(response, 200, { grants: service.listGrants() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/reconcile') {
        mutationQueue = mutationQueue.catch(() => undefined).then(() => service.reconcileAll());
        await mutationQueue;
        return json(response, 200, { status: 'reconciled' });
      }
      if (request.method === 'POST' && url.pathname === '/webhooks/seerr') {
        const event = parseWebhook(await readJson(request));
        let result = null;
        mutationQueue = mutationQueue.catch(() => undefined).then(async () => {
          result = await service.processWebhook(event);
        });
        await mutationQueue;
        return json(response, result ? 200 : 202, result ? { status: 'granted', grant: result } : { status: 'ignored' });
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(JSON.stringify({ level: 'error', message }));
      const status = message.includes('must be') || message.includes('invalid') ? 400 : 502;
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

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(encoded);
}
