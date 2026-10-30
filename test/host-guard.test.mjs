// One Host per request: the server refuses, with a fixed 400 and before a household is chosen or anything relayed, a
// request that does not name exactly one host, so a proxy in front and JellyPass can never read different hosts.
// Requests are written to the socket as they are, since Node's HTTP client would not send two Host headers.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { describe, it } from 'node:test';
import { HOST_A, HOST_B, get, startApp, world } from './support/household-app.mjs';

const INVALID_HOST = '{"error":"invalid_host"}';
const ADMIN_HOST = 'jellypass.example.test';
const BEARER = 'Authorization: Bearer admin-secret';
/** Requests that reached the fake Jellyfin as a household's, rather than JellyPass's token checks or own calls with its API key. */
const relayed = (app) => app.jellyfin.requests.filter((request) => request.pathname !== '/Users/Me' && !/Token="jellyfin-key"|api_key=jellyfin-key/.test(`${request.headers.authorization ?? ''} ${request.path}`));
const users = (answer) => JSON.parse(answer.body).map((user) => user.Name);
// Each of these is refused with the fixed 400, whatever the path; none is relayed.
const malformed = (host) => [
  ['two Host headers, household A first', [`Host: ${HOST_A}`, `Host: ${HOST_B}`]],
  ['two Host headers, household A last', [`Host: ${HOST_B}`, `Host: ${HOST_A}`]],
  ['an unknown Host, then a household', [`Host: ${ADMIN_HOST}`, `Host: ${HOST_B}`]],
  ['a household, then an unknown Host', [`Host: ${HOST_A}`, `Host: ${ADMIN_HOST}`]],
  ['the same Host twice', [`Host: ${host}`, `Host: ${host}`]],
  ['the same Host twice, the name in mixed case', [`host: ${host}`, `HOST: ${host.toUpperCase()}`]],
  ['two Host headers in mixed case', [`hOsT: ${HOST_B}`, `Host: ${HOST_A}`]],
  ['an empty Host', ['Host: ']],
  ['userinfo', [`Host: user@${host}`]],
  ['userinfo with a password', [`Host: user:pass@${host}`]],
  ['whitespace inside', [`Host: ${host} x`]],
  ['a path', [`Host: ${host}/x`]],
  ['other characters', [`Host: <${host}`]],
  ['a percent-encoding', [`Host: ${host}%2f`]],
];

describe('one Host per request', { timeout: 60_000 }, () => {
  it('refuses a household request with other than exactly one valid Host, for HTTP and WebSocket alike, relaying nothing', async (t) => {
    const app = await startApp(t);
    for (const [what, hosts] of malformed(HOST_A)) {
      const answer = await raw(app.port, 'GET /Users/Public HTTP/1.1', hosts);
      assert.deepEqual([answer.status, answer.body], [400, INVALID_HOST], what);
      assert.equal(answer.headers['cache-control'], 'no-store', what);
      assert.equal(answer.headers.connection, 'close', what);
      const refused = await upgrade(app.port, '/socket?api_key=token-alice&deviceId=x', hosts);
      assert.match(refused, /^HTTP\/1\.1 400 [^]*\r\nConnection: close\r\n\r\n\{"error":"invalid_host"\}$/, what);
    }
    assert.deepEqual(relayed(app), [], 'nothing reached Jellyfin');
  });

  it('answers HTTP/1.1 with no Host with the same fixed 400, not Node\'s own bare one, on any path and for WebSocket', async (t) => {
    const app = await startApp(t);
    for (const target of ['/health', '/Users/Public', '/v1/groups']) {
      const answer = await raw(app.port, `GET ${target} HTTP/1.1`, target === '/v1/groups' ? [BEARER] : []);
      assert.deepEqual([answer.status, answer.body], [400, INVALID_HOST], target);
      assert.equal(answer.headers['cache-control'], 'no-store', target);
      assert.equal(answer.headers.connection, 'close', target);
      assert.match(answer.headers['content-type'] ?? '', /^application\/json/, target);
    }
    assert.match(await upgrade(app.port, '/socket?api_key=token-alice&deviceId=x', []), /^HTTP\/1\.1 400 [^]*\r\nCache-Control: no-store\r\n[^]*\r\nConnection: close\r\n\r\n\{"error":"invalid_host"\}$/);
    assert.deepEqual(relayed(app), [], 'nothing reached Jellyfin');
  });

  it('closes its own end of a refused connection even when the client keeps its end open', async (t) => {
    const app = await startApp(t);
    const websocket = `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n`;
    for (const [what, request] of [
      ['an upgrade with two Hosts', `GET /socket?api_key=token-alice&deviceId=x HTTP/1.1\r\nHost: ${HOST_A}\r\nHost: ${HOST_B}\r\n${websocket}\r\n`],
      ['an upgrade with no Host', `GET /socket?api_key=token-alice&deviceId=x HTTP/1.1\r\n${websocket}\r\n`],
      ['a request with two Hosts', `GET /Users/Public HTTP/1.1\r\nHost: ${HOST_A}\r\nHost: ${HOST_B}\r\n\r\n`],
      ['a request with no Host', 'GET /health HTTP/1.1\r\n\r\n'],
    ]) {
      const { answer, closed } = await halfOpen(app, request);
      assert.match(answer, /^HTTP\/1\.1 400 [^]*\{"error":"invalid_host"\}$/, what);
      assert.ok(closed, `${what}: the server socket is closed within a second`);
    }
    assert.deepEqual(relayed(app), [], 'nothing reached Jellyfin');
  });

  it('still routes one Host to its household, in any casing of the header name, and relays its WebSocket', async (t) => {
    const app = await startApp(t);
    assert.deepEqual(users(await raw(app.port, 'GET /Users/Public HTTP/1.1', [`Host: ${HOST_A}`])), ['Alice', 'Ann']);
    assert.deepEqual(users(await raw(app.port, 'GET /Users/Public HTTP/1.1', [`host: ${HOST_B}`])), ['Bob']);
    assert.deepEqual(users(await raw(app.port, 'GET /Users/Public HTTP/1.1', [`HOST: ${HOST_A.toUpperCase()}:443`])), ['Alice', 'Ann']);
    assert.deepEqual(users(await raw(app.port, 'GET /Users/Public HTTP/1.0', [`Host: ${HOST_B}`])), ['Bob']);
    await upgrade(app.port, '/socket?api_key=token-alice&deviceId=x', [`Host: ${HOST_A}`]);
    assert.deepEqual(relayed(app).map((request) => request.pathname), ['/Users/Public', '/Users/Public', '/Users/Public', '/Users/Public', '/socket']);
  });

  it('serves a request as Nginx Proxy Manager sends it: one Host it set, and the forwarding headers', async (t) => {
    const app = await startApp(t);
    // NPM's proxy_set_header lines: Host $host, X-Forwarded-Scheme, X-Forwarded-Proto, X-Forwarded-For, X-Real-IP,
    // and for WebSockets Upgrade and Connection.
    const npm = (host) => [`Host: ${host}`, 'X-Forwarded-Scheme: https', 'X-Forwarded-Proto: https', 'X-Forwarded-For: 203.0.113.7', 'X-Real-IP: 203.0.113.7'];
    assert.deepEqual(users(await raw(app.port, 'GET /Users/Public HTTP/1.1', npm(HOST_A))), ['Alice', 'Ann']);
    assert.deepEqual(users(await raw(app.port, 'GET /Users/Public HTTP/1.1', npm(HOST_B))), ['Bob']);
    // The fake Jellyfin answers the WebSocket itself; what matters is that the upgrade is relayed.
    assert.doesNotMatch(await upgrade(app.port, '/socket?api_key=token-alice&deviceId=x', npm(HOST_A)), /invalid_host/);
    assert.deepEqual(relayed(app).map((request) => request.pathname), ['/Users/Public', '/Users/Public', '/socket']);
    const admin = await raw(app.port, 'GET /v1/groups HTTP/1.1', [...npm(ADMIN_HOST), BEARER]);
    assert.equal(admin.status, 200, admin.body);
  });

  it('refuses an absolute-form target whose authority is not the Host, and lets one that agrees through the Host check', async (t) => {
    const app = await startApp(t);
    for (const target of [`http://${HOST_B}/Users/Public`, `https://${HOST_B}/Users/Public`, `http://${HOST_A}:8443/Users/Public`, `http://user@${HOST_A}/Users/Public`, 'http:///Users/Public']) {
      const answer = await raw(app.port, `GET ${target} HTTP/1.1`, [`Host: ${HOST_A}`]);
      assert.deepEqual([answer.status, answer.body], [400, INVALID_HOST], target);
    }
    // The admin side: an absolute-form target naming a household, with the admin Host, is refused too.
    const absolute = await raw(app.port, `GET http://${HOST_A}/v1/groups HTTP/1.1`, [`Host: ${ADMIN_HOST}`, BEARER]);
    assert.deepEqual([absolute.status, absolute.body], [400, INVALID_HOST]);
    assert.equal((await raw(app.port, `GET http://${ADMIN_HOST}/v1/groups HTTP/1.1`, [`Host: ${ADMIN_HOST}`, BEARER])).status, 200);
    assert.notEqual((await raw(app.port, `GET http://${HOST_A.toUpperCase()}/Users/Public HTTP/1.1`, [`Host: ${HOST_A}`])).body, INVALID_HOST);
    // An HTTP/1.0 absolute-form target with no Host names a host the Host header cannot agree with.
    const noHost = await raw(app.port, `GET http://${HOST_A}/Users/Public HTTP/1.0`, []);
    assert.deepEqual([noHost.status, noHost.body], [400, INVALID_HOST]);
  });

  it('keeps HTTP/1.0 with no Host as before: no household, so the admin side answers', async (t) => {
    const app = await startApp(t);
    assert.deepEqual(await raw(app.port, 'GET /health HTTP/1.0', []).then((answer) => [answer.status, answer.body]), [200, '{"status":"ok"}']);
    assert.equal((await raw(app.port, 'GET /v1/groups HTTP/1.0', [BEARER])).status, 200);
    assert.equal((await raw(app.port, 'GET /v1/groups HTTP/1.0', [])).status, 401);
    assert.notEqual((await raw(app.port, 'GET /Users/Public HTTP/1.0', [])).status, 200, 'no household listing');
    assert.deepEqual(relayed(app), [], 'nothing reached Jellyfin');
  });

  it('refuses the same on the admin paths and the webhook, before the admin token or webhook token is looked at', async (t) => {
    const app = await startApp(t);
    for (const [what, hosts] of malformed(ADMIN_HOST)) {
      const answer = await raw(app.port, 'GET /v1/groups HTTP/1.1', [...hosts, BEARER]);
      assert.deepEqual([answer.status, answer.body], [400, INVALID_HOST], what);
      assert.equal((await raw(app.port, 'GET /health HTTP/1.1', hosts)).body, INVALID_HOST, what);
    }
    const test = JSON.stringify({ notificationType: 'TEST_NOTIFICATION', subject: 'Test Notification' });
    const webhook = (hosts) => raw(app.port, 'POST /webhooks/seerr HTTP/1.1', [...hosts, 'Authorization: Bearer webhook-secret', 'Content-Type: application/json'], test);
    for (const hosts of [[`Host: ${ADMIN_HOST}`, `Host: ${HOST_A}`], [`Host: ${HOST_A}`, `Host: ${ADMIN_HOST}`], [`Host: ${ADMIN_HOST}`, `host: ${ADMIN_HOST}`]]) {
      assert.deepEqual(await webhook(hosts).then((answer) => [answer.status, answer.body]), [400, INVALID_HOST], hosts.join(', '));
    }
    assert.deepEqual(await webhook([`Host: ${ADMIN_HOST}`]).then((answer) => [answer.status, answer.body]), [202, '{"status":"ignored"}']);
    // One Host: the admin site, API and health as before, and a WebSocket upgrade on a non-household Host still dropped.
    assert.equal((await raw(app.port, 'GET /v1/groups HTTP/1.1', [`Host: ${ADMIN_HOST}`, BEARER])).status, 200);
    assert.equal((await raw(app.port, 'GET /v1/groups HTTP/1.1', [`Host: ${ADMIN_HOST}`])).status, 401);
    assert.equal((await raw(app.port, 'GET /admin/ HTTP/1.1', [`Host: ${ADMIN_HOST}`])).status, 200);
    assert.equal((await raw(app.port, 'GET / HTTP/1.1', [`Host: 127.0.0.1:${app.port}`])).status, 302);
    assert.equal((await raw(app.port, 'GET /health HTTP/1.1', ['Host: [::1]:8787'])).status, 200);
    assert.equal(await upgrade(app.port, '/socket', [`Host: ${ADMIN_HOST}`]), '');
    assert.deepEqual(relayed(app), [], 'nothing reached Jellyfin');
  });

  it('answers the Samsung app\'s CORS preflight on a household host as before', async (t) => {
    const app = await startApp(t, Object.assign(world(), { webPage: {} }), { tvAddon: { households: ['grove'] } });
    const before = app.jellyfin.requests.length;
    for (const origin of ['null', 'file://']) {
      const answer = await get(app.port, '/jellypass/app/v1/me', { Host: HOST_A, Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' }, { method: 'OPTIONS' });
      assert.equal(answer.status, 204, origin);
      assert.equal(answer.headers['access-control-allow-origin'], origin);
      assert.equal(answer.headers.vary, 'Origin');
    }
    const doubled = await raw(app.port, 'OPTIONS /jellypass/app/v1/me HTTP/1.1', [`Host: ${HOST_A}`, `Host: ${HOST_B}`, 'Origin: null', 'Access-Control-Request-Method: GET']);
    assert.deepEqual([doubled.status, doubled.body, doubled.headers['access-control-allow-origin']], [400, INVALID_HOST, undefined]);
    assert.equal(app.jellyfin.requests.length, before, 'a preflight never reaches Jellyfin');
  });
});

/** One request written as it is (each of `headers` a line), and its answer read to the end of the connection. */
function raw(port, requestLine, headers, body = '') {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const lines = [requestLine, ...headers, 'Connection: close', ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : [])];
    const chunks = [];
    socket.once('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => {
      const answer = Buffer.concat(chunks).toString('utf8');
      const end = answer.indexOf('\r\n\r\n');
      const head = answer.slice(0, end).split('\r\n');
      const headers = Object.fromEntries(head.slice(1).map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
      let rest = answer.slice(end + 4);
      if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
        let decoded = '';
        for (let size = parseInt(rest, 16); size > 0; size = parseInt(rest, 16)) {
          const start = rest.indexOf('\r\n') + 2;
          decoded += rest.slice(start, start + size);
          rest = rest.slice(start + size + 2);
        }
        rest = decoded;
      }
      resolve({ status: Number(head[0]?.split(' ')[1]), headers, body: rest });
    });
  });
}

/**
 * `request` written by a client that keeps its own end open after the server's answer (allowHalfOpen), and whether the
 * server then closed its socket for the connection within a second.
 */
function halfOpen(app, request) {
  return new Promise((resolve, reject) => {
    const serverClosed = new Promise((settle) => {
      app.server.once('connection', (serverSocket) => {
        const timer = setTimeout(() => settle(false), 1_000);
        serverSocket.once('close', () => { clearTimeout(timer); settle(true); });
      });
    });
    const client = connect({ port: app.port, host: '127.0.0.1', allowHalfOpen: true });
    let answer = '';
    client.once('connect', () => client.write(request));
    client.on('data', (chunk) => { answer += chunk.toString('utf8'); });
    client.once('error', reject);
    // The answer is whole once the server has ended its side; the client's side stays open until the verdict.
    const ended = new Promise((settle) => client.once('end', settle));
    void Promise.all([serverClosed, ended]).then(([closed]) => {
      client.destroy();
      resolve({ answer, closed });
    });
  });
}

/** A WebSocket upgrade's answer, up to its end of headers and body, or '' if the connection was closed without one. */
function upgrade(port, pathname, hosts) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answer = '';
    const lines = hosts.map((line) => `${line}\r\n`).join('');
    socket.once('connect', () => socket.write(`GET ${pathname} HTTP/1.1\r\n${lines}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.on('data', (chunk) => {
      answer += chunk.toString('utf8');
      const [head, body = ''] = answer.split('\r\n\r\n');
      const length = /\r\ncontent-length: (\d+)/i.exec(head)?.[1];
      if (answer.includes('\r\n\r\n') && Buffer.byteLength(body) >= Number(length ?? 0)) {
        socket.destroy();
        resolve(answer);
      }
    });
    socket.once('end', () => resolve(answer));
    socket.once('error', (error) => (error.code === 'ECONNRESET' ? resolve(answer) : reject(error)));
  });
}
