import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { RequestBridge } from '../dist/request-bridge.js';
import { SeerrClient } from '../dist/seerr.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
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
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'connect.sid=test-session; HttpOnly; Path=/',
      });
      response.end(JSON.stringify({ jellyfinUserId: 'abc123' }));
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
  const bridge = new RequestBridge(`http://127.0.0.1:${fakePort}`, access);
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
      "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors * file: tizen-app:",
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

    const rejectedProfile = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'Alex', id: 'deadbeef' }),
    });
    assert.equal(rejectedProfile.status, 401);

    const sessionResponse = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'Alex', id: 'abc123' }),
    });
    assert.equal(sessionResponse.status, 200);
    const { token } = await sessionResponse.json();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.deepEqual(loginBody, { username: 'Alex', password: '', email: 'Alex' });
    assert.equal(loginCalls, 2);

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
  }
});

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
