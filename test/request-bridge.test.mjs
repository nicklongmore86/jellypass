import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { RequestBridge } from '../dist/request-bridge.js';

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
  const fakeSeerr = http.createServer(async (request, response) => {
    if (request.url === '/api/v1/auth/jellyfin' && request.method === 'POST') {
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
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Unauthorized' }));
  });
  const fakePort = await listen(fakeSeerr);
  const bridge = new RequestBridge(`http://127.0.0.1:${fakePort}`);
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
    assert.match(await page.text(), /jellyquest-bridge/);
    assert.equal((await fetch(`${origin}/jellyquest-bridge/health`)).status, 200);
    assert.equal((await fetch(`${origin}/outside`)).status, 418);

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

    const proxyResponse = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/discover/trending', options: {} }),
    });
    assert.equal(proxyResponse.status, 200);
    assert.equal((await proxyResponse.json()).data.results[0].title, 'Verified');

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
