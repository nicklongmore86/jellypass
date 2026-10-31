import { createServer } from 'node:http';

/** Every secret the setup tests use: none may appear in any answer, log line or page. */
export const SECRETS = {
  adminPassword: 'synthetic-admin-password',
  memberPassword: 'synthetic-member-password',
  seerrKey: 'synthetic-seerr-admin-key-0001',
  tmdbKey: 'f00dfeedf00dfeedf00dfeedf00dfeed',
  adminToken: 'synthetic-admin-token-0123456789abcdef0123456789',
};

function send(response, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  response.end(text);
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : undefined;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function token(request) {
  return /Token="([^"]*)"/.exec(request.headers.authorization ?? '')?.[1];
}

/**
 * A Jellyfin that answers what the setup wizard calls: sign-in (admin / member), the user, API keys (list, create,
 * delete) and a check with a key. `requests` records every call; `keys` holds the API keys it has made.
 */
export async function createSetupJellyfin({ version = '10.11.3' } = {}) {
  const requests = [];
  const keys = [];
  const sessions = new Map();
  const loggedOut = [];
  let sequence = 0;
  const users = {
    admin: { Id: 'a0000000000000000000000000000001', Name: 'admin', password: SECRETS.adminPassword, Policy: { IsAdministrator: true, IsDisabled: false } },
    member: { Id: 'a0000000000000000000000000000002', Name: 'member', password: SECRETS.memberPassword, Policy: { IsAdministrator: false, IsDisabled: false } },
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const body = request.method === 'POST' ? await readBody(request).catch(() => undefined) : undefined;
    requests.push({ method: request.method, path: `${url.pathname}${url.search}`, headers: request.headers, body });
    const supplied = token(request);
    if (url.pathname === '/System/Info/Public') return send(response, 200, { ServerName: 'Synthetic', Version: version, Id: 'synthetic-server' });
    if (request.method === 'POST' && url.pathname === '/Users/AuthenticateByName') {
      const user = Object.values(users).find((entry) => entry.Name === body?.Username);
      if (!user || user.password !== body?.Pw) return send(response, 401, undefined);
      const accessToken = `session-${++sequence}`;
      sessions.set(accessToken, user);
      return send(response, 200, { User: { Id: user.Id, Name: user.Name }, AccessToken: accessToken, ServerId: 'synthetic-server' });
    }
    const sessionUser = sessions.get(supplied);
    const key = keys.find((entry) => entry.AccessToken === supplied);
    if (request.method === 'POST' && url.pathname === '/Sessions/Logout') {
      if (!sessionUser) return send(response, 401, undefined);
      sessions.delete(supplied);
      loggedOut.push(supplied);
      return send(response, 204);
    }
    if (url.pathname.startsWith('/Users/') && request.method === 'GET' && sessionUser) {
      const user = Object.values(users).find((entry) => entry.Id === url.pathname.slice('/Users/'.length));
      return user ? send(response, 200, { Id: user.Id, Name: user.Name, Policy: user.Policy }) : send(response, 404, undefined);
    }
    if (url.pathname === '/Auth/Keys') {
      if (!sessionUser?.Policy.IsAdministrator) return send(response, 403, undefined);
      if (request.method === 'GET') return send(response, 200, { Items: keys.map((entry) => ({ ...entry })), TotalRecordCount: keys.length, StartIndex: 0 });
      if (request.method === 'POST') {
        keys.push({ Id: 0, AccessToken: `jellyfin-key-${String(++sequence).padStart(4, '0')}${'0'.repeat(20)}`, AppName: url.searchParams.get('app'), DateCreated: new Date(Date.now() + sequence).toISOString() });
        return send(response, 204);
      }
    }
    if (key && (url.pathname === '/System/Info' || url.pathname === '/Users')) return send(response, 200, url.pathname === '/Users' ? [] : { Version: version });
    // What a running JellyPass reads with its key; empty answers are enough.
    if (key && url.pathname === '/Library/MediaFolders') return send(response, 200, { Items: [] });
    return send(response, 401, undefined);
  });
  const url = await listen(server);
  return { url, requests, keys, loggedOut, revoke: (accessToken) => keys.splice(keys.findIndex((entry) => entry.AccessToken === accessToken), 1), close: () => close(server) };
}

/**
 * A Seerr that answers the wizard's calls like Seerr v3.5.1: its status, the webhook settings (GET and POST), and the
 * webhook test, which sends a TEST_NOTIFICATION to the configured URL with the configured Authorization header and the
 * configured payload (its {{...}} filled as Seerr fills them for a test) and answers 204 only for a 2xx.
 */
export async function createSetupSeerr({ apiKey = SECRETS.seerrKey, webhook } = {}) {
  const requests = [];
  const deliveries = [];
  const state = {
    webhook: webhook ?? { enabled: false, embedPoster: true, types: 0, options: { webhookUrl: '', jsonPayload: '{"notification_type":"{{notification_type}}"}', customHeaders: [] } },
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const body = request.method === 'POST' ? await readBody(request).catch(() => undefined) : undefined;
    requests.push({ method: request.method, path: url.pathname, headers: request.headers, body });
    if (url.pathname === '/api/v1/status') return send(response, 200, { version: '3.5.1', commitTag: 'synthetic' });
    if (request.headers['x-api-key'] !== apiKey) return send(response, 403, { message: 'You do not have permission to access this endpoint.' });
    if (url.pathname === '/api/v1/settings/notifications/webhook' && request.method === 'GET') return send(response, 200, state.webhook);
    if (url.pathname === '/api/v1/settings/notifications/webhook' && request.method === 'POST') {
      JSON.parse(body.options.jsonPayload);
      state.webhook = body;
      return send(response, 200, body);
    }
    if (url.pathname === '/api/v1/settings/notifications/webhook/test' && request.method === 'POST') {
      const payload = body.options.jsonPayload
        .replaceAll('{{notification_type}}', 'TEST_NOTIFICATION')
        .replace(/\{\{[a-zA-Z_]+\}\}/g, '');
      try {
        const delivered = await fetch(body.options.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(body.options.authHeader ? { Authorization: body.options.authHeader } : {}) },
          body: payload,
          signal: AbortSignal.timeout(5_000),
        });
        deliveries.push({ status: delivered.status });
        return delivered.ok ? send(response, 204) : send(response, 500, { message: 'Failed to send webhook notification.' });
      } catch {
        deliveries.push({ status: 0 });
        return send(response, 500, { message: 'Failed to send webhook notification.' });
      }
    }
    return send(response, 404, { message: 'not found' });
  });
  const url = await listen(server);
  return { url, requests, deliveries, state, close: () => close(server) };
}

/** TMDB's /3/authentication for SECRETS.tmdbKey only. */
export async function createSetupTmdb() {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push(url.pathname);
    if (url.searchParams.get('api_key') !== SECRETS.tmdbKey) return send(response, 401, { status_code: 7, status_message: 'Invalid API key' });
    return send(response, 200, { success: true });
  });
  const url = await listen(server);
  return { url, requests, close: () => close(server) };
}
