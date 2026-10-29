// JellyPass supports the current and the previous Jellyfin release. On any other version, household hosts answer a
// fixed 503 until an administrator confirms that exact version; supported versions are served as before. The admin site
// keeps working throughout, so the administrator can see the version and confirm it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService } from '../dist/access-service.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import {
  JellyfinVersionGate,
  SUPPORTED_JELLYFIN_RELEASES,
  UNKNOWN_VERSION_MESSAGE,
  UNTESTED_VERSION_MESSAGE,
  isSupportedJellyfinVersion,
} from '../dist/jellyfin-version.js';
import { makeServer } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { get } from './support/household-app.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const HOST = 'jelly-grove.example.test';
const ADMIN = { Authorization: 'Bearer admin-secret' };
const RELAYED = 'jellyfin web page';

describe('supported Jellyfin versions', () => {
  it('supports every 10.11.x and every 12.x, and nothing else', () => {
    assert.deepEqual(SUPPORTED_JELLYFIN_RELEASES, ['10.11', '12']);
    for (const version of ['10.11.0', '10.11.3', '10.11.11', '12.0.0', '12.3.0', '12.4.0', '12.10.2']) {
      assert.equal(isSupportedJellyfinVersion(version), true, version);
    }
    for (const version of ['10.10.7', '10.1.11', '10.110.0', '11.0.0', '13.0.0', '120.0.0', '1.0', '12.0.0-rc1', 'v12.4.0', '', '12.4.0 ']) {
      assert.equal(isSupportedJellyfinVersion(version), false, version);
    }
  });

  it('tests every supported release in CI and before a release, against the same pinned images', async () => {
    const pinned = JSON.parse(await readFile('scripts/jellyfin-versions.json', 'utf8'));
    assert.ok(pinned.length >= 2);
    for (const { image, version } of pinned) {
      assert.match(image, /^jellyfin\/jellyfin:\d[\w.-]*$/, 'an exact tag, never latest or a floating one');
      assert.ok(isSupportedJellyfinVersion(version), version);
    }
    for (const release of SUPPORTED_JELLYFIN_RELEASES) {
      assert.ok(pinned.some(({ version }) => version === release || version.startsWith(`${release}.`)), `no CI image for ${release}`);
    }
    for (const workflow of ['.github/workflows/ci.yaml', '.github/workflows/release.yaml']) {
      const text = await readFile(workflow, 'utf8');
      for (const { image, version } of pinned) {
        assert.ok(text.includes(`image: ${image}`) && text.includes(`version: ${version}`), `${workflow} does not test ${image}`);
      }
      assert.match(text, /JELLYFIN_IMAGE: \$\{\{ matrix\.jellyfin\.image \}\}/, workflow);
    }
  });
});

describe('Jellyfin version gate', () => {
  it('serves on a supported version and logs no warning', async () => {
    const { gate, logs } = gateFor({ version: '12.3.0' });
    await gate.check();
    assert.equal(gate.decision(), 'serve');
    assert.equal(gate.status().householdHosts, 'serving');
    assert.equal(logs.filter((entry) => entry.level === 'warn').length, 0);
    gate.stop();
  });

  it('refuses an untested version until that exact version is confirmed, and warns once', async () => {
    const { gate, logs, jellyfin, stored } = gateFor({ version: '13.0.0' });
    await gate.check();
    await gate.check();
    assert.equal(gate.decision(), 'refuse');
    assert.equal(logs.filter((entry) => entry.level === 'warn').length, 1);
    assert.match(logs.find((entry) => entry.level === 'warn').message, /JELLYFIN_UNTESTED_VERSION_OK/);
    await assert.rejects(gate.confirm('13.0.1'), { message: 'jellyfin_version_changed' });
    await gate.confirm('13.0.0');
    assert.equal(stored.value, '13.0.0');
    assert.equal(gate.decision(), 'serve');
    // An upgrade to another untested version asks again.
    jellyfin.version = '13.1.0';
    await gate.check();
    assert.equal(gate.decision(), 'refuse');
    // A supported version needs no confirmation, and one cannot be stored for it.
    jellyfin.version = '12.4.0';
    await gate.check();
    assert.equal(gate.decision(), 'serve');
    await assert.rejects(gate.confirm('12.4.0'), { message: 'jellyfin_version_supported' });
    gate.stop();
  });

  it('serves the exact version JELLYFIN_UNTESTED_VERSION_OK names, and no other', async () => {
    const { gate, jellyfin } = gateFor({ version: '13.0.0', environmentConfirmed: '13.0.0' });
    await gate.check();
    assert.equal(gate.decision(), 'serve');
    jellyfin.version = '13.0.1';
    await gate.check();
    assert.equal(gate.decision(), 'refuse');
    gate.stop();
  });

  it('does not wait for an unreachable Jellyfin: refuses while the version is unknown, and reads it again on demand', async () => {
    let now = 0;
    const { gate, jellyfin } = gateFor({ version: '12.4.0', down: true, now: () => now });
    await gate.check();
    assert.equal(gate.decision(), 'unknown');
    assert.match(gate.status().error, /unreachable/);
    // Within five seconds of the last read a request does not start another.
    now = 4_000;
    assert.equal(await gate.householdDecision(), 'unknown');
    assert.equal(jellyfin.reads, 1);
    jellyfin.down = false;
    now = 5_000;
    assert.equal(await gate.householdDecision(), 'serve');
    assert.equal(jellyfin.reads, 2);
    // A read that fails later forgets the version, so an upgrade during a restart is never served unchecked.
    jellyfin.down = true;
    await gate.check();
    assert.equal(gate.decision(), 'unknown');
    gate.stop();
  });
});

describe('household hosts and the Jellyfin version', { timeout: 30_000 }, () => {
  it('relays household requests on a supported version, as before', async (t) => {
    const app = await startApp(t, { version: '10.11.11' });
    const answer = await get(app.port, '/web/index.html', { Host: HOST });
    assert.deepEqual([answer.status, answer.text], [200, RELAYED]);
    assert.equal((await get(app.port, '/v1/jellyfin/version', ADMIN)).json().householdHosts, 'serving');
  });

  it('answers a fixed 503 on an untested version and never relays it, while the admin site keeps working', async (t) => {
    const app = await startApp(t, { version: '13.0.0' });
    for (const pathname of ['/web/index.html', '/Users/AuthenticateByName', '/System/Info/Public', '/jellypass/app/v1/me']) {
      const answer = await get(app.port, pathname, { Host: HOST });
      assert.deepEqual([answer.status, answer.text], [503, UNTESTED_VERSION_MESSAGE], pathname);
      assert.equal(answer.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(answer.headers['cache-control'], 'no-store');
    }
    assert.deepEqual(app.jellyfin.relayed, [], 'nothing reached Jellyfin from a household host');
    assert.match(await rawUpgrade(app.port, '/socket', HOST), /^HTTP\/1\.1 503 /);

    assert.equal((await get(app.port, '/health')).status, 200);
    const status = (await get(app.port, '/v1/jellyfin/version', ADMIN)).json();
    assert.deepEqual(
      [status.version, status.supported, status.householdHosts, status.confirmedVersion, status.supportedReleases],
      ['13.0.0', false, 'refused', null, ['10.11', '12']],
    );
    const metrics = (await get(app.port, '/metrics', ADMIN)).text;
    assert.match(metrics, /^jfa_jellyfin_version_info\{confirmed="false",supported="false",version="13\.0\.0"\} 1$/m);
    assert.match(metrics, /^jfa_household_hosts_refusing 1$/m);
  });

  it('serves once an administrator confirms the exact version, keeps it across a restart, and asks again after an upgrade', async (t) => {
    const app = await startApp(t, { version: '13.0.0' });
    const wrong = await put(app.port, '/v1/jellyfin/version/confirmation', { version: '13.0.1' });
    assert.deepEqual([wrong.status, wrong.json().error], [409, 'jellyfin_version_changed']);
    const confirmed = await put(app.port, '/v1/jellyfin/version/confirmation', { version: '13.0.0' });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.deepEqual([confirmed.json().confirmedVersion, confirmed.json().householdHosts], ['13.0.0', 'serving']);
    assert.deepEqual([(await get(app.port, '/web/index.html', { Host: HOST })).text], [RELAYED]);
    assert.match((await get(app.port, '/metrics', ADMIN)).text, /^jfa_household_hosts_refusing 0$/m);

    // Stored in the state file, so a restarted JellyPass serves at once.
    assert.equal(JSON.parse(await readFile(app.stateFile, 'utf8')).jellyfinVersionConfirmed, '13.0.0');
    const restarted = await startApp(t, { version: '13.0.0', stateFile: app.stateFile });
    assert.equal((await get(restarted.port, '/web/index.html', { Host: HOST })).text, RELAYED);

    app.jellyfin.version = '13.1.0';
    await app.gate.check();
    const upgraded = await get(app.port, '/web/index.html', { Host: HOST });
    assert.deepEqual([upgraded.status, upgraded.text], [503, UNTESTED_VERSION_MESSAGE]);

    // Withdrawing the confirmation pauses the version it was for again.
    app.jellyfin.version = '13.0.0';
    await app.gate.check();
    const withdrawn = await request(app.port, '/v1/jellyfin/version/confirmation', { method: 'DELETE', headers: ADMIN });
    assert.deepEqual([withdrawn.status, withdrawn.json().householdHosts], [200, 'refused']);
  });

  it('answers a fixed 503 while Jellyfin is unreachable at start, and serves once it answers', async (t) => {
    let now = 0;
    const app = await startApp(t, { version: '12.4.0', down: true, now: () => now });
    const waiting = await get(app.port, '/web/index.html', { Host: HOST });
    assert.deepEqual([waiting.status, waiting.text], [503, UNKNOWN_VERSION_MESSAGE]);
    assert.equal((await get(app.port, '/health')).status, 200);
    assert.equal((await get(app.port, '/v1/jellyfin/version', ADMIN)).json().householdHosts, 'waiting');
    app.jellyfin.down = false;
    now = 10_000;
    assert.equal((await get(app.port, '/web/index.html', { Host: HOST })).text, RELAYED);
  });

  it('keeps household hosts as they were when no version check is configured', async (t) => {
    const app = await startApp(t, { version: '13.0.0', gate: false });
    assert.equal((await get(app.port, '/web/index.html', { Host: HOST })).text, RELAYED);
    assert.equal((await get(app.port, '/v1/jellyfin/version', ADMIN)).status, 404);
  });
});

function gateFor({ version, down = false, environmentConfirmed, now }) {
  const jellyfin = { version, down, reads: 0 };
  const stored = { value: undefined };
  const logs = [];
  const gate = new JellyfinVersionGate({
    read: async () => {
      jellyfin.reads += 1;
      if (jellyfin.down) throw new Error('Jellyfin is unreachable');
      return jellyfin.version;
    },
    ...(environmentConfirmed ? { environmentConfirmed } : {}),
    confirmation: { get: () => stored.value, set: async (value) => { stored.value = value; } },
    ...(now ? { now } : {}),
    log: (entry) => logs.push(entry),
  });
  return { gate, logs, jellyfin, stored };
}

/** A Jellyfin that reports `version` (in Jellyfin 12's camelCase) and answers every other path with a fixed page. */
async function startJellyfin(t, { version, down }) {
  const jellyfin = { version, down, relayed: [] };
  const server = createServer((request, response) => {
    if (request.url === '/System/Info/Public' && request.headers.authorization?.includes('Token="jellyfin-key"')) {
      if (jellyfin.down) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ serverName: 'Test', version: jellyfin.version }));
      return;
    }
    jellyfin.relayed.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(RELAYED);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  jellyfin.url = `http://127.0.0.1:${server.address().port}`;
  return jellyfin;
}

async function startApp(t, { version, down = false, now, gate: withGate = true, stateFile }) {
  const jellyfin = await startJellyfin(t, { version, down });
  const file = stateFile ?? path.join(await makeTempDir(t, 'jfa-version-'), 'grants.json');
  const store = new GrantStore(file);
  await store.load();
  if (!stateFile) await store.upsertGroup({ id: 'grove', name: 'Grove', userIds: [] });
  const client = new JellyfinClient(jellyfin.url, 'jellyfin-key');
  const gate = new JellyfinVersionGate({
    read: () => client.getServerVersion(),
    confirmation: { get: () => store.getJellyfinVersionConfirmed(), set: (value) => store.setJellyfinVersionConfirmed(value) },
    ...(now ? { now } : {}),
    log: () => undefined,
  });
  if (withGate) await gate.check();
  const server = makeServer(new AccessService(client, store), { webhook: 'webhook-secret', admin: 'admin-secret' }, undefined, {
    householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-' },
    ...(withGate ? { jellyfinVersion: gate } : {}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    gate.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });
  return { port: server.address().port, jellyfin, gate, stateFile: file };
}

/** A request to JellyPass, with the Host header given (household hosts are told apart by it). */
function request(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return get(port, pathname, headers, { method, body });
}

function put(port, pathname, body) {
  return request(port, pathname, { method: 'PUT', headers: { ...ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function rawUpgrade(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(raw));
    socket.on('close', () => resolve(raw));
  });
}
