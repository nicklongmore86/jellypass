import assert from 'node:assert/strict';
import http from 'node:http';
import test, { mock } from 'node:test';
import { RequestBridge } from '../dist/request-bridge.js';
import { SeerrClient } from '../dist/seerr.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const ALEX_TOKEN = 'alex0000000000000000000000000000';
const BLAIR_TOKEN = 'blair000000000000000000000000000';

// Jellyfin stand-in: resolves access tokens to users via GET /Users/Me.
async function createFakeJellyfin() {
  const tokens = new Map([
    [ALEX_TOKEN, { Id: 'abc123', Name: 'Alex', Policy: { IsDisabled: false } }],
    [BLAIR_TOKEN, { Id: 'def456', Name: 'Blair', Policy: { IsDisabled: false } }],
  ]);
  const state = { meCalls: 0, authorizations: [], tokens };
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/Users/Me') {
      state.meCalls += 1;
      const authorization = request.headers.authorization ?? '';
      state.authorizations.push(authorization);
      const token = /^MediaBrowser\s/.test(authorization)
        ? authorization.match(/(?:\s|,)Token="([^"]+)"/)?.[1]
        : undefined;
      const user = tokens.get(token);
      response.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(user ?? {}));
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);
  return { server, state, url: `http://127.0.0.1:${port}` };
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

test('keeps the Jellyseerr session server-side and limits relayed operations', async () => {
  let loginBody;
  let loginCalls = 0;
  let userListCalls = 0;
  const fakeSeerr = http.createServer(async (request, response) => {
    if (request.url?.startsWith('/api/v1/user?') && request.method === 'GET') {
      userListCalls += 1;
      assert.equal(request.headers['x-api-key'], 'test-api-key');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        pageInfo: { results: 1 },
        results: [{ id: 7, username: 'Alex', jellyfinUserId: 'abc123' }],
      }));
      return;
    }
    if (request.url === '/api/v1/auth/jellyfin' && request.method === 'POST') {
      loginCalls += 1;
      loginBody = JSON.parse(await requestBody(request));
      // Passwordless members: Jellyseerr accepts an empty password for any known name.
      const jellyfinUserId = { Alex: 'abc123', Blair: 'def456' }[loginBody.username];
      if (!jellyfinUserId || loginBody.password !== '') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'Unauthorized' }));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `connect.sid=${jellyfinUserId === 'abc123' ? 'test-session' : 'other-session'}; HttpOnly; Path=/`,
      });
      response.end(JSON.stringify({ jellyfinUserId }));
      return;
    }
    if (request.url === '/api/v1/discover/trending' && request.headers.cookie === 'connect.sid=test-session') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ results: [{ id: 1, title: 'Verified' }] }));
      return;
    }
    if (request.url === '/api/v1/movie/101' && request.headers.cookie === 'connect.sid=test-session') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 101, mediaInfo: { jellyfinMediaId: 'a1b2c3', status: 5 } }));
      return;
    }
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Unauthorized' }));
  });
  const fakePort = await listen(fakeSeerr);
  const seerr = new SeerrClient(`http://127.0.0.1:${fakePort}`, 'test-api-key');
  const accessCalls = [];
  const access = {
    hasJellyseerrUser(userId) {
      return seerr.hasJellyfinUser(userId);
    },
    getMediaAccess(userId, mediaType, tmdbId, jellyfinItemId) {
      accessCalls.push({ operation: 'get', userId, mediaType, tmdbId, jellyfinItemId });
      return { mediaType, tmdbId, claimed: false, managed: true, owned: false, public: false, jellyfinItemId };
    },
    listMediaClaims(userId) {
      accessCalls.push({ operation: 'list', userId });
      return [{ mediaType: 'movie', tmdbId: 101, userIds: [userId], updatedAt: '2026-09-03T00:00:00.000Z' }];
    },
    async claimMediaAccess(userId, mediaType, tmdbId, jellyfinItemId) {
      accessCalls.push({ operation: 'claim', userId, mediaType, tmdbId, jellyfinItemId });
      return { mediaType, tmdbId, claimed: true, managed: true, owned: true, public: false, jellyfinItemId };
    },
  };
  const jellyfin = await createFakeJellyfin();
  const bridge = new RequestBridge(`http://127.0.0.1:${fakePort}`, jellyfin.url, access);
  const app = http.createServer(async (request, response) => {
    const handled = await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
    if (!handled) {
      response.writeHead(418).end();
    }
  });
  const appPort = await listen(app);
  const origin = `http://127.0.0.1:${appPort}`;

  try {
    const page = await fetch(`${origin}/jellyquest-bridge/bridge.html`);
    assert.equal(page.status, 200);
    assert.equal(
      page.headers.get('content-security-policy'),
      "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors file: tizen-app:",
    );
    assert.match(await page.text(), /jellyquest-bridge/);
    assert.equal((await fetch(`${origin}/jellyquest-bridge/health`)).status, 200);
    assert.equal((await fetch(`${origin}/outside`)).status, 418);

    const eligibleProfile = await fetch(`${origin}/jellyquest-bridge/eligibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'abc123' }),
    });
    assert.equal(eligibleProfile.status, 200);
    assert.deepEqual(await eligibleProfile.json(), { eligible: true });

    const ineligibleProfile = await fetch(`${origin}/jellyquest-bridge/eligibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'deadbeef' }),
    });
    assert.equal(ineligibleProfile.status, 200);
    assert.deepEqual(await ineligibleProfile.json(), { eligible: false });
    assert.equal(userListCalls, 2);
    assert.equal(loginCalls, 0, 'eligibility checks must not authenticate or create a Jellyseerr user');

    const missingJellyfinToken = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'Alex', id: 'abc123' }),
    });
    assert.equal(missingJellyfinToken.status, 401, 'a passwordless member cannot be impersonated by name and ID alone');
    assert.equal(jellyfin.state.meCalls, 0);

    const invalidJellyfinToken = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': 'forged000000000000000000000000000' },
      body: JSON.stringify({ user: 'Alex', id: 'abc123' }),
    });
    assert.equal(invalidJellyfinToken.status, 401);
    assert.equal(jellyfin.state.meCalls, 1);

    const malformedJellyfinToken = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': 'x", Token="' + ALEX_TOKEN },
      body: JSON.stringify({ id: 'abc123' }),
    });
    assert.equal(malformedJellyfinToken.status, 401);
    assert.equal(jellyfin.state.meCalls, 1, 'malformed tokens are rejected before reaching Jellyfin');

    const mismatchedProfile = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
      body: JSON.stringify({ user: 'Blair', id: 'def456' }),
    });
    assert.equal(mismatchedProfile.status, 401, 'a token for Alex cannot open a session claimed for Blair');
    assert.equal(loginCalls, 0, 'no Jellyseerr login happens before the Jellyfin identity is verified');

    const claimedName = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'Blair', accessToken: ALEX_TOKEN }),
    });
    assert.equal(claimedName.status, 200);
    assert.deepEqual(loginBody, { username: 'Alex', password: '', email: 'Alex' }, 'the verified name is used, not the claimed one');
    const claimedNameToken = (await claimedName.json()).token;
    const claimedNameClaims = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claimedNameToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/jellyquest/access/claims', options: {} }),
    });
    assert.equal((await claimedNameClaims.json()).data.claims[0].userIds[0], 'abc123');
    accessCalls.length = 0;

    const sessionResponse = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `MediaBrowser Client="JellyQuest", Device="TV", DeviceId="tv-1", Version="1.0.0", Token="${ALEX_TOKEN}"`,
      },
      body: JSON.stringify({ id: 'ABC123' }),
    });
    assert.equal(sessionResponse.status, 200);
    const { token } = await sessionResponse.json();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.deepEqual(loginBody, { username: 'Alex', password: '', email: 'Alex' });
    assert.equal(loginCalls, 2);
    assert.equal(jellyfin.state.authorizations.at(-1), `MediaBrowser Token="${ALEX_TOKEN}"`);
    for (const authorization of jellyfin.state.authorizations) {
      assert.doesNotMatch(authorization, /\b(?:Client|Device|DeviceId|Version)=/, 'verification must not rewrite the device record of the user token');
    }

    const proxyResponse = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/discover/trending', options: {} }),
    });
    assert.equal(proxyResponse.status, 200);
    assert.equal((await proxyResponse.json()).data.results[0].title, 'Verified');

    const accessStatus = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/jellyquest/access?mediaType=movie&tmdbId=101', options: {} }),
    });
    assert.equal(accessStatus.status, 200);
    assert.equal((await accessStatus.json()).data.jellyfinItemId, 'a1b2c3');

    const claimed = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/jellyquest/access',
        options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'movie', tmdbId: 101 }) },
      }),
    });
    assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).data.owned, true);

    const claims = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/jellyquest/access/claims', options: {} }),
    });
    assert.equal(claims.status, 200);
    assert.equal((await claims.json()).data.claims[0].tmdbId, 101);
    assert.deepEqual(accessCalls, [
      { operation: 'get', userId: 'abc123', mediaType: 'movie', tmdbId: 101, jellyfinItemId: 'a1b2c3' },
      { operation: 'claim', userId: 'abc123', mediaType: 'movie', tmdbId: 101, jellyfinItemId: 'a1b2c3' },
      { operation: 'list', userId: 'abc123' },
    ]);

    const blocked = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/settings/main', options: {} }),
    });
    assert.equal(blocked.status, 403);

    const missingToken = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/discover/trending', options: {} }),
    });
    assert.equal(missingToken.status, 401);
  } finally {
    await close(app);
    await close(fakeSeerr);
    await close(jellyfin.server);
  }
});

test('ends bridge sessions when the Jellyfin access token is revoked', async () => {
  const fakeSeerr = http.createServer(async (request, response) => {
    if (request.url === '/api/v1/auth/jellyfin' && request.method === 'POST') {
      await requestBody(request);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'connect.sid=test-session; Path=/' });
      response.end(JSON.stringify({ jellyfinUserId: 'abc123' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ results: [] }));
  });
  const fakePort = await listen(fakeSeerr);
  const jellyfin = await createFakeJellyfin();
  const bridge = new RequestBridge(`http://127.0.0.1:${fakePort}`, jellyfin.url);
  const app = http.createServer(async (request, response) => {
    await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  const appPort = await listen(app);
  const origin = `http://127.0.0.1:${appPort}`;
  const proxy = (token) => fetch(`${origin}/jellyquest-bridge/proxy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/api/v1/discover/trending', options: {} }),
  });
  mock.timers.enable({ apis: ['Date'], now: Date.now() });

  try {
    const session = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
      body: '{}',
    });
    assert.equal(session.status, 200);
    const { token } = await session.json();
    assert.equal((await proxy(token)).status, 200);
    assert.equal(jellyfin.state.meCalls, 1, 'fresh sessions are not re-verified on every call');

    jellyfin.state.tokens.delete(ALEX_TOKEN);
    mock.timers.tick(6 * 60 * 1000);
    assert.equal((await proxy(token)).status, 401);
    assert.equal(jellyfin.state.meCalls, 2);
    assert.equal((await proxy(token)).status, 401, 'the revoked session is discarded');
  } finally {
    mock.timers.reset();
    await close(app);
    await close(fakeSeerr);
    await close(jellyfin.server);
  }
});

test('reports an unreachable Jellyfin without creating a session', async () => {
  let loginCalls = 0;
  const fakeSeerr = http.createServer((request, response) => {
    loginCalls += 1;
    response.writeHead(500).end();
  });
  const fakePort = await listen(fakeSeerr);
  const bridge = new RequestBridge(`http://127.0.0.1:${fakePort}`, 'http://127.0.0.1:1');
  const app = http.createServer(async (request, response) => {
    await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  const appPort = await listen(app);

  try {
    const session = await fetch(`http://127.0.0.1:${appPort}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
      body: '{}',
    });
    assert.equal(session.status, 502);
    assert.equal(loginCalls, 0);
  } finally {
    await close(app);
    await close(fakeSeerr);
  }
});

test('rate limits repeated eligibility probes from the same client', async () => {
  const access = {
    hasJellyseerrUser() { return Promise.resolve(false); },
  };
  const bridge = new RequestBridge('http://127.0.0.1:1', 'http://127.0.0.1:1', access);
  const app = http.createServer(async (request, response) => {
    await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  const appPort = await listen(app);
  const origin = `http://127.0.0.1:${appPort}`;

  try {
    let lastStatus;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const probe = await fetch(`${origin}/jellyquest-bridge/eligibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'abc123' }),
      });
      lastStatus = probe.status;
      await probe.json();
    }
    assert.equal(lastStatus, 429);
  } finally {
    await close(app);
  }
});

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
