// Jellyfin routes one endpoint by many spellings: in any case, percent-encoded, with a trailing slash, and under the
// legacy /emby and /mediabrowser prefixes. Every decision a household host makes about a path (sign-in membership, the
// profile picker, password recovery, sign-out, protected media, Quick Connect, its own pages) is made on the route
// Jellyfin would take it to, so each spelling is answered exactly as the plain path is; and a path Jellyfin might read
// otherwise than the gateway is refused with a fixed answer and never proxied.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { describe, it } from 'node:test';
import { ALICE, HOST_A, ITEMS, OUTSIDER, get, post, startApp, world } from './support/household-app.mjs';

const AUTHORIZATION = 'MediaBrowser Client="JellyPass", Device="Browser", DeviceId="jellypass-test-device-0001", Version="1.0"';
const NOT_A_MEMBER = '{"error":"invalid_credentials"}';
const INVALID_PATH = '{"error":"invalid_request"}';
const ITEM_NOT_FOUND = '{"error":"item_not_found"}';
/** An item in a library Alice does not have. */
const HIDDEN = '44440000444400004444000044440000';
const passwords = { [ALICE]: 'alice-pass', [OUTSIDER]: 'out-pass' };
const mediaWorld = () => world({ passwords, items: [{ Id: HIDDEN, Name: 'Not For Alice', Type: 'Movie', Tags: [], library: 'private' }] });

const alternate = (text) => [...text].map((char, index) => (index % 2 ? char.toUpperCase() : char.toLowerCase())).join('');
/**
 * Spellings Jellyfin 10.11 routes as it does `path`: any case, a percent-encoded letter, a trailing slash, the legacy
 * prefixes in any case or encoding. `path` is `/<first>/<rest>`.
 */
const routed = (path) => {
  const [, first, rest] = /^\/([^/]+)\/(.+)$/.exec(path);
  return [
    path.toLowerCase(),
    path.toUpperCase(),
    alternate(path),
    `${path}/`,
    `/${first}/%${rest.charCodeAt(0).toString(16).toUpperCase()}${rest.slice(1)}`,
    `/emby${path}`,
    `/Emby${path}`,
    `/MediaBrowser${path}`,
    `/mediabrowser${path}/`,
    `/%65mby${path}`,
    `/%4D%45DIABROWSER${path}`,
  ];
};
/**
 * Spellings the gateway checks too though Jellyfin does not route them (repeated slashes): refused as the plain path
 * is when that is the check's answer, and otherwise sent to Jellyfin as spelled, for Jellyfin's own answer.
 */
const unrouted = (path) => {
  const [, first, rest] = /^\/([^/]+)\/(.+)$/.exec(path);
  return [`//${first}//${rest}/`, `/emby//${first}/${rest}`, `${path}//`];
};
const spellings = (path) => [...routed(path), ...unrouted(path)];

/** Requests that reached the fake Jellyfin at anything but the gateway's own reads (its user list, /Users/Me, items). */
const forwarded = (app) => app.jellyfin.requests.filter((request) =>
  !['/Users', '/Users/Me'].includes(request.pathname) && !/^\/Users\/[0-9a-f]{32}\/Items\/[0-9a-f]{32}$/.test(request.pathname));

describe('household host checks in every spelling Jellyfin routes', { timeout: 60_000 }, () => {
  it('refuses a non-member\'s sign-in by name in every spelling with the fixed answer, without asking Jellyfin to sign in', async (t) => {
    const app = await startApp(t, world({ passwords }), { trustedProxies: ['127.0.0.1'] });
    let client = 0;
    const signIn = (path, username, password) => post(app.port, path, { Host: HOST_A, Authorization: AUTHORIZATION, 'X-Forwarded-For': `203.0.113.${++client}` }, { Username: username, Pw: password });
    const bare = await signIn('/Users/AuthenticateByName', 'Outsider', 'out-pass');
    assert.deepEqual([bare.status, bare.text], [401, NOT_A_MEMBER]);
    for (const path of spellings('/Users/AuthenticateByName')) {
      const answer = await signIn(path, 'Outsider', 'out-pass');
      assert.deepEqual([answer.status, answer.text, answer.headers['content-type']], [401, NOT_A_MEMBER, bare.headers['content-type']], path);
    }
    assert.deepEqual(app.jellyfin.signInAttempts, [], 'Jellyfin was asked to sign a non-member in');
    assert.deepEqual(forwarded(app), []);
  });

  it('still signs a member in by name in every spelling Jellyfin routes', async (t) => {
    const app = await startApp(t, world({ passwords }), { trustedProxies: ['127.0.0.1'] });
    let client = 0;
    for (const path of ['/Users/AuthenticateByName', ...routed('/Users/AuthenticateByName')]) {
      const answer = await post(app.port, path, { Host: HOST_A, Authorization: AUTHORIZATION, 'X-Forwarded-For': `203.0.113.${++client}` }, { Username: 'Alice', Pw: 'alice-pass' });
      assert.equal(answer.status, 200, path);
      assert.equal(answer.json().User.Id, ALICE, path);
    }
  });

  it('refuses Jellyfin\'s sign-in by ID for a non-member in every spelling, without asking Jellyfin', async (t) => {
    const app = await startApp(t, world({ passwords }));
    const dashed = `${OUTSIDER.slice(0, 8)}-${OUTSIDER.slice(8, 12)}-${OUTSIDER.slice(12, 16)}-${OUTSIDER.slice(16, 20)}-${OUTSIDER.slice(20)}`;
    for (const id of [OUTSIDER, dashed, `{${dashed}}`, 'not-a-user']) {
      for (const path of [`/Users/${id}/Authenticate`, ...spellings(`/Users/${id}/Authenticate`)]) {
        const answer = await post(app.port, `${path}?pw=out-pass`, { Host: HOST_A, Authorization: AUTHORIZATION }, {});
        assert.deepEqual([answer.status, answer.text], [401, NOT_A_MEMBER], path);
      }
    }
    assert.deepEqual(app.jellyfin.signInAttempts, []);
    assert.deepEqual(forwarded(app), []);
    // A member's is Jellyfin's to answer, as before.
    const alice = await post(app.port, `/emby/Users/${ALICE}/Authenticate?pw=alice-pass`, { Host: HOST_A, Authorization: AUTHORIZATION }, {});
    assert.equal(alice.json().User.Id, ALICE);
  });

  it('lists only the household\'s members in every spelling of /Users/Public', async (t) => {
    const app = await startApp(t, world({ passwords }));
    const bare = await get(app.port, '/Users/Public', { Host: HOST_A });
    assert.deepEqual(bare.json().map((user) => user.Name), ['Alice', 'Ann']);
    for (const path of routed('/Users/Public')) {
      const answer = await get(app.port, path, { Host: HOST_A });
      assert.deepEqual([answer.status, answer.text], [200, bare.text], path);
    }
    for (const path of unrouted('/Users/Public')) {
      const answer = await get(app.port, path, { Host: HOST_A });
      assert.ok(!answer.text.includes('Outsider'), path);
    }
  });

  it('adds the household login styles in every spelling of /Branding/Configuration', async (t) => {
    const app = await startApp(t);
    const bare = await get(app.port, '/Branding/Configuration', { Host: HOST_A });
    assert.match(bare.json().CustomCss, /#loginPage \.btnQuick/);
    for (const path of routed('/Branding/Configuration')) {
      const answer = await get(app.port, path, { Host: HOST_A });
      assert.deepEqual([answer.status, answer.text], [200, bare.text], path);
    }
  });

  it('refuses password recovery in every spelling without asking Jellyfin', async (t) => {
    const app = await startApp(t);
    for (const bare of ['/Users/ForgotPassword', '/Users/ForgotPassword/Pin']) {
      for (const path of [bare, ...spellings(bare)]) {
        const answer = await post(app.port, path, { Host: HOST_A }, { EnteredUsername: 'Alice', Pin: '0000' });
        assert.deepEqual([answer.status, answer.text], [403, '{"error":"household_password_recovery_disabled"}'], path);
      }
    }
    assert.deepEqual(forwarded(app), []);
  });

  for (const path of spellings('/Sessions/Logout')) {
    it(`forgets the app's session when it signs out at ${path}`, async (t) => {
      const app = await startApp(t, world({ passwords }));
      const { AccessToken } = (await post(app.port, '/Users/AuthenticateByName', { Host: HOST_A, Authorization: AUTHORIZATION }, { Username: 'Alice', Pw: 'alice-pass' })).json();
      const alice = { Host: HOST_A, Authorization: `MediaBrowser Token="${AccessToken}"` };
      const verifications = () => app.jellyfin.requests.filter((request) => request.pathname === '/Users/Me').length;
      assert.equal((await get(app.port, '/jellypass/app/v1/me', alice)).status, 200);
      assert.equal((await get(app.port, '/jellypass/app/v1/me', alice)).status, 200);
      assert.equal(verifications(), 1);
      const out = await post(app.port, path, alice, undefined);
      const me = await get(app.port, '/jellypass/app/v1/me', alice);
      assert.equal(verifications(), 2, 'the app still trusted its cached session');
      // The fake Jellyfin, unlike Jellyfin, also routes any trailing slashes (`/Sessions/Logout//`).
      if (routed('/Sessions/Logout').includes(path) || out.status === 204) {
        assert.equal(out.status, 204);
        assert.deepEqual(app.jellyfin.logouts, [AccessToken]);
        assert.equal(me.text, '{"error":"unauthorized"}');
      } else {
        // Jellyfin does not route it and signs nobody out: the app forgot the session all the same, and asked again.
        assert.deepEqual(app.jellyfin.logouts, []);
        assert.equal(me.status, 200);
      }
    });
  }

  it('checks protected media in every spelling, and never proxies what the caller may not see', async (t) => {
    const app = await startApp(t, mediaWorld());
    const alice = { Host: HOST_A, Authorization: `${AUTHORIZATION}, Token="token-alice"` };
    const media = (id) => [`/Videos/${id}/stream`, `/Videos/${id}/stream.mkv`, `/Audio/${id}/master.m3u8`, `/Items/${id}/Download`];
    for (const bare of media(HIDDEN)) {
      for (const path of [bare, ...spellings(bare)]) {
        const answer = await get(app.port, `${path}?Static=true`, alice);
        assert.deepEqual([answer.status, answer.text], [404, ITEM_NOT_FOUND], path);
      }
    }
    assert.deepEqual(forwarded(app), [], 'a stream of an item Alice may not see reached Jellyfin');
    for (const bare of media(ITEMS.ownMovie)) {
      for (const path of [bare, ...routed(bare)]) {
        const answer = await get(app.port, `${path}?Static=true`, alice);
        assert.equal(answer.status, 200, path);
      }
    }
  });

  it('never proxies the household app\'s own paths, in any spelling', async (t) => {
    const app = await startApp(t);
    for (const bare of ['/jellypass/app/v1/me', '/jellypass/app/', '/jellypass/app/nope.js']) {
      for (const path of spellings(bare)) {
        const answer = await get(app.port, path, { Host: HOST_A });
        assert.match(answer.headers['cache-control'] ?? '', /no-store/, `${path}: ${answer.status}`);
      }
    }
    assert.deepEqual(forwarded(app), []);
  });

  it('refuses a path Jellyfin might read otherwise than the gateway, with a fixed answer, without proxying it', async (t) => {
    const app = await startApp(t, mediaWorld());
    const alice = { Host: HOST_A, Authorization: `${AUTHORIZATION}, Token="token-alice"` };
    const ambiguous = [
      '/Users%2FAuthenticateByName',
      '/Users/AuthenticateByName%2f',
      '/Users%5CAuthenticateByName',
      '/Users\\AuthenticateByName',
      '/%2565mby/Users/AuthenticateByName',
      '/Users/%2541uthenticateByName',
      '/Users/x/../AuthenticateByName',
      '/Users/%2e%2e/Users/AuthenticateByName',
      '/Users/AuthenticateByName/.',
      '/web/%2E/index.html',
      '/emby/emby/Users/AuthenticateByName',
      '/emby/MediaBrowser/Users/Public',
      '/Users/%E0%A4%A',
      '/Users/%00/Public',
      `/Videos/${HIDDEN}%2Fx/stream`,
    ];
    for (const path of ambiguous) {
      for (const method of ['GET', 'POST']) {
        const answer = await get(app.port, path, { ...alice, 'Content-Type': 'application/json' }, { method, body: method === 'POST' ? JSON.stringify({ Username: 'Outsider', Pw: 'out-pass' }) : undefined });
        assert.deepEqual([answer.status, answer.text, answer.headers['cache-control']], [400, INVALID_PATH, 'no-store'], `${method} ${path}`);
      }
      assert.match(await upgrade(app.port, path, HOST_A), /^HTTP\/1\.1 400 /, path);
    }
    assert.deepEqual(app.jellyfin.requests, [], 'an ambiguous path reached Jellyfin');
  });

  it('still proxies ordinary paths, encoded ones included', async (t) => {
    const app = await startApp(t);
    const before = app.jellyfin.requests.length;
    for (const path of ['/web/index.html', '/Genres/Sci-Fi%20%26%20Fantasy', '/Persons/100%25%20Real', '/System/Info/Public', '/emby/System/Info/Public']) {
      await get(app.port, path, { Host: HOST_A });
    }
    assert.equal(app.jellyfin.requests.length, before + 5);
  });
});

/** The status line and headers a household host answers a WebSocket upgrade with. */
function upgrade(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answer = '';
    socket.once('connect', () => socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.on('data', (chunk) => {
      answer += chunk.toString('utf8');
      if (answer.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(answer);
      }
    });
    socket.once('end', () => resolve(answer));
    socket.once('error', reject);
  });
}
