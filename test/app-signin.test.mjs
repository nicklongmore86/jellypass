// Signing in to the household app goes through the household gateway, exactly as Jellyfin web's does: the household's
// own profile list, AuthenticateByName scoped to the household's members and rate-limited per client, and the token it
// returns is the one the app API accepts. These tests drive the gateway over HTTP; the page itself is tested in
// test/app-pwa.test.mjs and the same flow against a real Jellyfin in test/real-jellyfin.test.mjs.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';
import { performance } from 'node:perf_hooks';
import { ALICE, ANN, BOB, CAROL, HOST_A, HOST_B, OUTSIDER, get, post, startApp, world } from './support/household-app.mjs';

const AUTHORIZATION = 'MediaBrowser Client="JellyPass", Device="Browser", DeviceId="jellypass-test-device-0001", Version="1.0"';
const NOT_A_MEMBER = '{"error":"invalid_credentials"}';
const MALFORMED = '{"error":"invalid_request"}';
const UNAVAILABLE = '{"error":"jellyfin_unavailable"}';
/** Jellyfin web's own sign-in, as /web/ on a household host sends it from its manual login form. */
const WEB_AUTHORIZATION = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="TW96aWxsYS81LjAgKFgxMTsgTGludXg", Version="10.11.3"';
/** A Jellyfin administrator, in no household. */
const ROOT = 'f00f0000f00f0000f00f0000f00f0000';
/** Ann left hidden at Jellyfin (off every login screen), with a password; Bob hidden too, in household B; and an administrator. */
const hiddenWorld = (extra = {}) => world({
  passwords: { [ALICE]: 'alice-pass', [ANN]: 'ann-pass', [BOB]: 'bob-pass', [CAROL]: 'carol-pass', [OUTSIDER]: 'out-pass', [ROOT]: 'root-pass' },
  jellyfinUsers: {
    [ANN]: { Name: 'Ann', Policy: { IsHidden: true, BlockedTags: [], EnabledFolders: ['shared'] } },
    [BOB]: { Name: 'Bob', Policy: { IsHidden: true, BlockedTags: [], EnableAllFolders: true } },
    [ROOT]: { Name: 'Root', Policy: { IsAdministrator: true, BlockedTags: [], EnableAllFolders: true } },
  },
  ...extra,
});
/** An answer as a client sees it, without the parts that differ between any two answers. */
const seen = (answer) => ({ status: answer.status, text: answer.text, headers: { ...answer.headers, date: undefined } });

describe('household app sign-in through the gateway', { timeout: 30_000 }, () => {
  const signIn = (app, host, username, password, headers = {}) => post(app.port, '/Users/AuthenticateByName', { Host: host, Authorization: AUTHORIZATION, ...headers }, { Username: username, Pw: password });
  const names = async (app, host) => (await get(app.port, '/Users/Public', { Host: host })).json().map((user) => user.Name);
  const authentications = (app) => app.jellyfin.requests.filter((request) => request.pathname === '/Users/AuthenticateByName');

  it('lists only the household\'s members on its host, and marks passwordless members', async (t) => {
    const app = await startApp(t, world({ passwords: { [ALICE]: 'alice-pass' } }));
    assert.deepEqual(await names(app, HOST_A), ['Alice', 'Ann']);
    assert.deepEqual(await names(app, HOST_B), ['Bob']);
    const before = (await get(app.port, '/Users/Public', { Host: HOST_A })).json();
    assert.deepEqual(before.map((user) => user.HasPassword), [true, true]);
    await app.store.setUserPasswordless(ANN, true);
    const after = (await get(app.port, '/Users/Public', { Host: HOST_A })).json();
    assert.deepEqual(after.map((user) => [user.Name, user.HasPassword]), [['Alice', true], ['Ann', false]]);
  });

  it('signs a member in on the household host and the token is what the app API accepts', async (t) => {
    const app = await startApp(t, world({ passwords: { [ALICE]: 'alice-pass' } }));
    const answer = await signIn(app, HOST_A, 'Alice', 'alice-pass');
    assert.equal(answer.status, 200);
    const { AccessToken, User, ServerId } = answer.json();
    assert.equal(User.Id, ALICE);
    assert.equal(ServerId, 'server');
    // The client's own Authorization header reached Jellyfin unchanged.
    assert.equal(authentications(app).length, 1);
    assert.equal(app.jellyfin.signIns[0].header, AUTHORIZATION);
    const me = await app.get('/jellypass/app/v1/me', { user: null, headers: { Authorization: `MediaBrowser Token="${AccessToken}"` } });
    assert.deepEqual(me.json(), { name: 'Alice', household: 'Farmhouse' });
    // Names match as Jellyfin matches them.
    assert.equal((await signIn(app, HOST_A, 'alice', 'alice-pass')).status, 200);
    // A wrong password is refused with the gateway's own fixed answer, never Jellyfin's text.
    assert.equal((await signIn(app, HOST_A, 'Alice', 'wrong')).status, 401);
    // One-tap for a member marked passwordless.
    await app.store.setUserPasswordless(ANN, true);
    const ann = await signIn(app, HOST_A, 'Ann', '');
    assert.equal(ann.status, 200);
    assert.equal(ann.json().User.Id, ANN);
  });

  it('is scoped to the household: another household\'s user, an outsider or an administrator cannot sign in on this host', async (t) => {
    const app = await startApp(t, world({ passwords: { [ALICE]: 'alice-pass', [BOB]: 'bob-pass', [OUTSIDER]: 'out-pass' } }));
    assert.equal((await signIn(app, HOST_B, 'Bob', 'bob-pass')).status, 200, 'Bob signs in on his own household\'s host');
    const before = authentications(app).length;
    for (const [host, username, password] of [
      [HOST_A, 'Bob', 'bob-pass'],
      [HOST_A, 'Carol', ''],
      [HOST_A, 'Outsider', 'out-pass'],
      [HOST_B, 'Alice', 'alice-pass'],
      [HOST_A, 'nobody', 'x'],
    ]) {
      const answer = await signIn(app, host, username, password);
      assert.equal(answer.status, 401, `${username} on ${host}`);
      assert.equal(answer.text, NOT_A_MEMBER, `${username} on ${host}`);
    }
    // A non-member is refused before Jellyfin is asked to authenticate anyone.
    assert.equal(authentications(app).length, before);
    assert.equal(app.jellyfin.signIns.length, 1);
    // A body that is not a name and a password is refused as malformed, whatever the name.
    for (const body of [{}, { Username: 5, Pw: '' }, { Username: ['Alice'], Pw: '' }, { Username: 'Alice' }]) {
      const answer = await post(app.port, '/Users/AuthenticateByName', { Host: HOST_A, Authorization: AUTHORIZATION }, body);
      assert.deepEqual([answer.status, answer.text], [400, MALFORMED]);
    }
  });

  it('rate-limits sign-in attempts per client, successful or not, and never forwards a limited attempt', async (t) => {
    const app = await startApp(t, world({ passwords: { [ALICE]: 'alice-pass' } }), { trustedProxies: ['127.0.0.1'] });
    const attempt = (client, password = 'wrong') => signIn(app, HOST_A, 'Alice', password, { 'X-Forwarded-For': client });
    for (let index = 0; index < 19; index += 1) assert.equal((await attempt('203.0.113.5')).status, 401);
    assert.equal((await attempt('203.0.113.5', 'alice-pass')).status, 200, 'the 20th attempt is still allowed');
    const forwarded = authentications(app).length;
    const limited = await attempt('203.0.113.5', 'alice-pass');
    assert.equal(limited.status, 429);
    assert.equal(limited.text, '{"error":"too_many_login_attempts"}');
    assert.equal(authentications(app).length, forwarded, 'Jellyfin never saw it');
    // Another client has its own allowance, and the limit does not stop reading the profile list.
    assert.equal((await attempt('203.0.113.6', 'alice-pass')).status, 200);
    assert.equal((await get(app.port, '/Users/Public', { Host: HOST_A, 'X-Forwarded-For': '203.0.113.5' })).status, 200);
  });

  it('fails closed while Jellyfin is down: no profile list and no sign-in', async (t) => {
    const app = await startApp(t);
    app.jellyfin.down = true;
    assert.ok((await get(app.port, '/Users/Public', { Host: HOST_A })).status >= 500);
    const refused = await signIn(app, HOST_A, 'Alice', '');
    assert.deepEqual([refused.status, refused.text], [502, '{"error":"jellyfin_unavailable"}'], 'the member check cannot run, so nobody is signed in');
    assert.equal(authentications(app).filter((request) => request.method === 'POST').length, 0);
  });

  it('signs out through the household host by revoking the token', async (t) => {
    const app = await startApp(t, world({ passwords: { [ALICE]: 'alice-pass' } }));
    const { AccessToken } = (await signIn(app, HOST_A, 'Alice', 'alice-pass')).json();
    const header = { Host: HOST_A, Authorization: `MediaBrowser Token="${AccessToken}"` };
    const out = await post(app.port, '/Sessions/Logout', header, undefined);
    assert.equal(out.status, 204);
    assert.deepEqual(app.jellyfin.logouts, [AccessToken]);
    assert.equal((await get(app.port, '/Users/Me', header)).status, 401);
  });

  describe('forgets the app\'s session as soon as it signs out', () => {
    const ME = '/jellypass/app/v1/me';
    const UNAUTHORIZED = '{"error":"unauthorized"}';
    const verifications = (app) => app.jellyfin.requests.filter((request) => request.pathname === '/Users/Me').length;
    const tokenOf = async (app, host, username, password) => (await signIn(app, host, username, password)).json().AccessToken;
    const as = (host, token) => ({ Host: host, Authorization: `MediaBrowser Token="${token}"` });
    const me = (app, headers) => get(app.port, ME, headers);
    const signOut = (app, headers) => post(app.port, '/Sessions/Logout', headers, undefined);
    const passwords = { [ALICE]: 'alice-pass', [ANN]: 'ann-pass', [BOB]: 'bob-pass' };

    it('refuses the very next call after a sign-out, though the token was verified a moment ago', async (t) => {
      const app = await startApp(t, world({ passwords }));
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 1, 'the second call was answered from the cache');
      assert.equal((await signOut(app, alice)).status, 204);
      const after = await me(app, alice);
      assert.equal(after.status, 401);
      assert.equal(after.text, UNAUTHORIZED);
      assert.equal(verifications(app), 2, 'checked with Jellyfin again, which refused it');
    });

    it('forgets it whatever Jellyfin answers the sign-out, even when Jellyfin is down', async (t) => {
      const app = await startApp(t, world({ passwords }));
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      assert.equal((await me(app, alice)).status, 200);
      app.jellyfin.down = true;
      assert.equal((await signOut(app, alice)).status, 503);
      app.jellyfin.down = false;
      // Jellyfin never revoked it, so it is still valid there; but it is checked again rather than taken from the cache.
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 2);
    });

    it('forgets it on every household\'s cache, and a token is still refused on another household\'s host', async (t) => {
      const app = await startApp(t, world({ passwords }));
      const bobToken = await tokenOf(app, HOST_B, 'Bob', 'bob-pass');
      assert.equal((await me(app, as(HOST_B, bobToken))).status, 200);
      assert.equal((await me(app, as(HOST_A, bobToken))).text, UNAUTHORIZED, 'Bob is not in household A');
      // Signed out on household A's address with Bob's own token: his session on household B is forgotten too.
      assert.equal((await signOut(app, as(HOST_A, bobToken))).status, 204);
      const after = await me(app, as(HOST_B, bobToken));
      assert.equal(after.status, 401);
      assert.equal(after.text, UNAUTHORIZED);
      assert.equal((await me(app, as(HOST_A, bobToken))).text, UNAUTHORIZED);
    });

    it('forgets only the sessions of the token the sign-out carries, never anyone else\'s', async (t) => {
      const app = await startApp(t, world({ passwords }));
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      const annToken = await tokenOf(app, HOST_A, 'Ann', 'ann-pass');
      const ann = as(HOST_A, annToken);
      const bob = as(HOST_B, await tokenOf(app, HOST_B, 'Bob', 'bob-pass'));
      for (const headers of [alice, ann, bob]) assert.equal((await me(app, headers)).status, 200);
      assert.equal(verifications(app), 3);
      // A garbage token, no token, and the household's other member's token as another header carries: nobody else's.
      assert.equal((await signOut(app, as(HOST_A, 'not-a-token'))).status, 401);
      assert.equal((await signOut(app, { Host: HOST_A })).status, 401);
      assert.equal((await signOut(app, { Host: HOST_B, 'X-Emby-Token': 'not-a-token', Authorization: 'MediaBrowser Token=""' })).status, 401);
      for (const headers of [alice, ann, bob]) assert.equal((await me(app, headers)).status, 200);
      assert.equal(verifications(app), 3, 'every session still answered from the cache');
      // Ann signs out as Jellyfin web does (its own header, with the token at the end): only Ann is forgotten.
      assert.equal((await signOut(app, { Host: HOST_A, Authorization: `${WEB_AUTHORIZATION}, Token="${annToken}"` })).status, 204);
      assert.equal((await me(app, ann)).text, UNAUTHORIZED);
      assert.equal(verifications(app), 4);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, bob)).status, 200);
      assert.equal(verifications(app), 4, 'Alice and Bob still answered from the cache');
    });

    it('does not keep a token verified while it was being signed out', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state);
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      let release;
      let asked;
      const askedPromise = new Promise((resolve) => { asked = resolve; });
      state.holdMe = () => {
        asked();
        return new Promise((resolve) => { release = resolve; });
      };
      // Jellyfin decides it is valid, then the sign-out passes before its answer arrives.
      const first = me(app, alice);
      await askedPromise;
      state.holdMe = undefined;
      assert.equal((await signOut(app, alice)).status, 204);
      release();
      assert.equal((await first).status, 200);
      assert.equal((await me(app, alice)).text, UNAUTHORIZED);
    });

    /** Holds the next sign-outs at Jellyfin, before it revokes anything: `arrived` once one is there, `release` lets them go on. */
    const holdLogouts = (state) => {
      let arrive;
      let release;
      const arrived = new Promise((resolve) => { arrive = resolve; });
      const released = new Promise((resolve) => { release = resolve; });
      state.holdLogout = (request, response) => {
        arrive({ request, response });
        return released;
      };
      return { arrived, release };
    };

    it('keeps no token verified while its sign-out is still at Jellyfin, so it is refused once Jellyfin revokes it', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state);
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 1);
      const hold = holdLogouts(state);
      const signingOut = signOut(app, alice);
      await hold.arrived;
      // Forgotten when the sign-out started; Jellyfin has not revoked it yet, so it is still valid there, and answered so.
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 3, 'checked with Jellyfin every time, never kept');
      hold.release();
      assert.equal((await signingOut).status, 204);
      const after = await me(app, alice);
      assert.equal(after.status, 401);
      assert.equal(after.text, UNAUTHORIZED);
      assert.equal(verifications(app), 4);
    });

    it('keeps no token verified for a minute after a sign-out Jellyfin failed, then trusts it again', async (t) => {
      let now = Date.parse('2026-10-25T12:00:00.000Z');
      const state = world({ passwords });
      const app = await startApp(t, state, { now: () => now });
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      assert.equal((await me(app, alice)).status, 200);
      const hold = holdLogouts(state);
      const signingOut = signOut(app, alice);
      const { request } = await hold.arrived;
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 3);
      // Jellyfin's connection breaks before it answers: it never revoked the token.
      request.socket.destroy();
      const failed = await signingOut;
      assert.equal(failed.status, 502);
      assert.equal(failed.text, UNAVAILABLE);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 5, 'still checked every time just after the sign-out');
      now += 60 * 1000 - 1;
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 6);
      now += 1;
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 7, 'kept again a minute after the sign-out');
    });

    it('keeps no token verified after a sign-out its client gave up on, though Jellyfin revokes it later', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state);
      const token = await tokenOf(app, HOST_A, 'Alice', 'alice-pass');
      const alice = as(HOST_A, token);
      assert.equal((await me(app, alice)).status, 200);
      const hold = holdLogouts(state);
      const client = httpRequest({ hostname: '127.0.0.1', port: app.port, path: '/Sessions/Logout', method: 'POST', headers: alice });
      client.on('error', () => {});
      client.end();
      const { request } = await hold.arrived;
      assert.equal((await me(app, alice)).status, 200);
      // The client leaves; JellyPass gives up its sign-out, which Jellyfin goes on with all the same.
      const gaveUp = new Promise((resolve) => request.once('close', resolve));
      client.destroy();
      await gaveUp;
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 3, 'not kept between giving up and Jellyfin revoking it');
      hold.release();
      while (!app.jellyfin.logouts.includes(token)) await new Promise((resolve) => setImmediate(resolve));
      const after = await me(app, alice);
      assert.equal(after.status, 401);
      assert.equal(after.text, UNAUTHORIZED);
      assert.equal(verifications(app), 4);
    });

    const percentEncoded = (token) => [...token].map((character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).join('');
    const sources = [
      ['a URL-encoded Token in Authorization', (token) => ({ headers: { Authorization: `MediaBrowser Token="${percentEncoded(token)}"` } })],
      ['X-Emby-Authorization', (token) => ({ headers: { 'X-Emby-Authorization': `${WEB_AUTHORIZATION}, Token="${token}"` } })],
      ['X-Emby-Token', (token) => ({ headers: { 'X-Emby-Token': token } })],
      ...['api_key', 'ApiKey', 'API_KEY', 'access_token', 'Access_Token'].map((name) => [`the ${name} query parameter`, (token) => ({ query: `?${name}=${encodeURIComponent(token)}` })]),
    ];
    for (const [label, source] of sources) {
      it(`forgets it when it signs out with ${label}`, async (t) => {
        const app = await startApp(t, world({ passwords }));
        const token = await tokenOf(app, HOST_A, 'Alice', 'alice-pass');
        assert.equal((await me(app, as(HOST_A, token))).status, 200);
        assert.equal((await me(app, as(HOST_A, token))).status, 200);
        assert.equal(verifications(app), 1);
        const { headers = {}, query = '' } = source(token);
        assert.equal((await post(app.port, `/Sessions/Logout${query}`, { Host: HOST_A, ...headers }, undefined)).status, 204);
        assert.deepEqual(app.jellyfin.logouts, [token]);
        assert.equal((await me(app, as(HOST_A, token))).text, UNAUTHORIZED);
        assert.equal(verifications(app), 2);
      });
    }

    it('forgets every token a sign-out carries, though Jellyfin signs out only one', async (t) => {
      const app = await startApp(t, world({ passwords }));
      const [first, second, third] = [
        await tokenOf(app, HOST_A, 'Alice', 'alice-pass'),
        await tokenOf(app, HOST_A, 'Alice', 'alice-pass'),
        await tokenOf(app, HOST_A, 'Ann', 'ann-pass'),
      ];
      const calls = [
        () => me(app, as(HOST_A, first)),
        () => me(app, { Host: HOST_A, 'X-Emby-Token': second }),
        () => get(app.port, `${ME}?api_key=${third}`, { Host: HOST_A }),
      ];
      for (const call of [...calls, ...calls]) assert.equal((await call()).status, 200);
      assert.equal(verifications(app), 3, 'each answered from the cache the second time');
      const answer = await post(app.port, `/Sessions/Logout?api_key=${third}`, { Host: HOST_A, Authorization: `MediaBrowser Token="${first}"`, 'X-Emby-Token': second }, undefined);
      assert.equal(answer.status, 204);
      assert.deepEqual(app.jellyfin.logouts, [first]);
      assert.deepEqual(await Promise.all(calls.map(async (call) => (await call()).status)), [401, 200, 200]);
      assert.equal(verifications(app), 6, 'each checked with Jellyfin again');
    });

    for (const path of ['/Sessions/Logout/', '/sessions/logout', '/SESSIONS/LOGOUT', '/Sessions/Logout?client=web', '/Sessions/%4Cogout', '/Sessions/Logout//']) {
      it(`forgets it when it signs out at ${path}, as Jellyfin routes it`, async (t) => {
        const app = await startApp(t, world({ passwords }));
        const token = await tokenOf(app, HOST_A, 'Alice', 'alice-pass');
        const alice = as(HOST_A, token);
        assert.equal((await me(app, alice)).status, 200);
        assert.equal((await me(app, alice)).status, 200);
        assert.equal(verifications(app), 1);
        assert.equal((await post(app.port, path, alice, undefined)).status, 204);
        assert.deepEqual(app.jellyfin.logouts, [token]);
        assert.equal((await me(app, alice)).text, UNAUTHORIZED);
        assert.equal(verifications(app), 2);
      });
    }

    it('forgets nothing on a call that is not a sign-out', async (t) => {
      const app = await startApp(t, world({ passwords }));
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      assert.equal((await me(app, alice)).status, 200);
      await get(app.port, '/Sessions/Logout', alice);
      await post(app.port, '/Sessions/Logouts', alice, undefined);
      await post(app.port, '/Sessions/Logout/Other', alice, undefined);
      assert.deepEqual(app.jellyfin.logouts, []);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 1, 'still answered from the cache');
    });

    it('still trusts a token revoked outside JellyPass for up to five minutes', async (t) => {
      let now = Date.parse('2026-10-25T12:00:00.000Z');
      const app = await startApp(t, world({ passwords }), { now: () => now });
      const token = await tokenOf(app, HOST_A, 'Alice', 'alice-pass');
      const alice = as(HOST_A, token);
      assert.equal((await me(app, alice)).status, 200);
      // An administrator deletes the device at Jellyfin: JellyPass sees no sign-out.
      app.jellyfin.signIns.find((entry) => entry.token === token).revoked = true;
      assert.equal((await get(app.port, '/Users/Me', alice)).status, 401, 'Jellyfin refuses it');
      now += 5 * 60 * 1000 - 1;
      assert.equal((await me(app, alice)).status, 200, 'the cache still trusts it');
      now += 1;
      assert.equal((await me(app, alice)).text, UNAUTHORIZED);
    });
  });
  it('leaves a hidden member off the picker, and signs them in by name from the app and from /web/', async (t) => {
    const app = await startApp(t, hiddenWorld());
    assert.deepEqual(await names(app, HOST_A), ['Alice'], 'Ann is hidden at Jellyfin, so the picker leaves her off');
    assert.deepEqual(await names(app, HOST_B), [], 'household B\'s only member is hidden');
    for (const [header, username] of [[AUTHORIZATION, 'Ann'], [WEB_AUTHORIZATION, 'Ann'], [WEB_AUTHORIZATION, 'ANN']]) {
      const answer = await signIn(app, HOST_A, username, 'ann-pass', { Authorization: header });
      assert.equal(answer.status, 200, `${username} with ${header}`);
      assert.equal(answer.json().User.Id, ANN);
    }
    // Jellyfin is asked to sign in the member by their own name, with the password and headers exactly as sent.
    assert.deepEqual(app.jellyfin.signInAttempts.map(({ username, password, header }) => [username, password, header]), [
      ['Ann', 'ann-pass', AUTHORIZATION], ['Ann', 'ann-pass', WEB_AUTHORIZATION], ['Ann', 'ann-pass', WEB_AUTHORIZATION],
    ]);
    // The token is what the app API accepts.
    const { AccessToken } = (await signIn(app, HOST_A, 'ann', 'ann-pass')).json();
    const me = await app.get('/jellypass/app/v1/me', { user: null, headers: { Authorization: `MediaBrowser Token="${AccessToken}"` } });
    assert.deepEqual(me.json(), { name: 'Ann', household: 'Farmhouse' });
    // Hidden Bob, on his own household's host only.
    assert.equal((await signIn(app, HOST_B, 'Bob', 'bob-pass', { Authorization: WEB_AUTHORIZATION })).status, 200);
    // A hidden member marked passwordless signs in by name with an empty password.
    await app.store.setUserPasswordless(BOB, true);
    app.jellyfin.state.passwords[BOB] = '';
    assert.equal((await signIn(app, HOST_B, 'bob', '')).status, 200);
  });

  it('refuses a name that is not this household\'s exactly as it refuses a wrong password, in the same time', async (t) => {
    const DELAY = 400;
    const app = await startApp(t, hiddenWorld(), { loginFailureDelayMs: DELAY });
    const attempt = async (host, username, password) => {
      const started = performance.now();
      const answer = await signIn(app, host, username, password, { Authorization: WEB_AUTHORIZATION });
      return { answer: seen(answer), ms: performance.now() - started };
    };
    const wrongPassword = await attempt(HOST_A, 'Ann', 'wrong');
    assert.equal(wrongPassword.answer.status, 401);
    assert.equal(wrongPassword.answer.text, NOT_A_MEMBER, 'never Jellyfin\'s own text');
    const asked = app.jellyfin.signInAttempts.length;
    for (const [host, username, password, who] of [
      [HOST_A, 'Bob', 'bob-pass', 'a hidden member of another household, with his right password'],
      [HOST_B, 'Ann', 'ann-pass', 'a hidden member, on another household\'s host'],
      [HOST_B, 'Alice', 'alice-pass', 'a listed member, on another household\'s host'],
      [HOST_A, 'Carol', 'carol-pass', 'a user in no household'],
      [HOST_A, 'Outsider', 'out-pass', 'another user in no household'],
      [HOST_A, 'Root', 'root-pass', 'an administrator'],
      [HOST_A, 'nobody', 'x', 'a name no user has'],
      [HOST_A, 'Ann', 'wrong', 'a hidden member with a wrong password'],
      [HOST_A, 'Alice', 'wrong', 'a listed member with a wrong password'],
    ]) {
      const refused = await attempt(host, username, password);
      assert.deepEqual(refused.answer, wrongPassword.answer, who);
      assert.ok(refused.ms >= DELAY - 5, `${who}: ${refused.ms} ms`);
      assert.ok(refused.ms < DELAY + 300, `${who}: ${refused.ms} ms`);
    }
    assert.ok(wrongPassword.ms >= DELAY - 5 && wrongPassword.ms < DELAY + 300, `a wrong password: ${wrongPassword.ms} ms`);
    // Only the members' attempts reached Jellyfin; no one else's name or password did.
    assert.deepEqual(app.jellyfin.signInAttempts.slice(asked).map(({ username }) => username), ['Ann', 'Alice']);
    assert.equal(app.jellyfin.signIns.length, 0);
    // A right password is not held back.
    const started = performance.now();
    assert.equal((await signIn(app, HOST_A, 'Ann', 'ann-pass')).status, 200);
    assert.ok(performance.now() - started < DELAY, 'a sign-in that works is answered at once');
  });

  it('rate-limits sign-in by name like any other attempt, whatever the name', async (t) => {
    const app = await startApp(t, hiddenWorld(), { trustedProxies: ['127.0.0.1'] });
    const attempt = (username, password, client = '203.0.113.9') => signIn(app, HOST_A, username, password, { 'X-Forwarded-For': client, Authorization: WEB_AUTHORIZATION });
    for (let index = 0; index < 10; index += 1) assert.equal((await attempt('Ann', 'wrong')).status, 401);
    for (let index = 0; index < 9; index += 1) assert.equal((await attempt(['Bob', 'Root', 'nobody'][index % 3], 'x')).status, 401);
    assert.equal((await attempt('Ann', 'ann-pass')).status, 200, 'the 20th attempt is still allowed');
    const asked = app.jellyfin.signInAttempts.length;
    for (const username of ['Ann', 'Root', 'nobody']) {
      const limited = await attempt(username, 'ann-pass');
      assert.deepEqual([limited.status, limited.text], [429, '{"error":"too_many_login_attempts"}'], username);
    }
    assert.equal(app.jellyfin.signInAttempts.length, asked, 'Jellyfin never saw a limited attempt');
    assert.equal((await attempt('Ann', 'ann-pass', '203.0.113.10')).status, 200, 'another client has its own allowance');
  });

  it('signs in only the member the name belongs to: anyone else Jellyfin signs in is signed out again and refused', async (t) => {
    const app = await startApp(t, hiddenWorld());
    // The member list is read once and reused for a few seconds.
    assert.equal((await signIn(app, HOST_A, 'Ann', 'ann-pass')).status, 200);
    // Meanwhile, at Jellyfin, Ann is renamed and the outsider takes her old name.
    app.jellyfin.state.jellyfinUsers[ANN].Name = 'Annie';
    app.jellyfin.state.jellyfinUsers[OUTSIDER].Name = 'Ann';
    const answer = await signIn(app, HOST_A, 'Ann', 'out-pass');
    assert.deepEqual([answer.status, answer.text], [401, NOT_A_MEMBER]);
    const outsider = app.jellyfin.signIns.find((entry) => entry.userId === OUTSIDER);
    assert.ok(outsider, 'Jellyfin signed the outsider in');
    assert.deepEqual(app.jellyfin.logouts, [outsider.token], 'and that session was signed out at once');
    assert.equal(outsider.revoked, true);
  });

  describe('tells no member from a non-member by any failure', () => {
    const DELAY = 300;
    /** Ann (a hidden member of household A) and 'nobody' (no user's name), each sent exactly the same way. */
    const NAMES = ['Ann', 'nobody'];
    const attempt = async (app, username, { headers = { Authorization: WEB_AUTHORIZATION }, body = { Username: username, Pw: 'wrong' } } = {}) => {
      const started = performance.now();
      const answer = await post(app.port, '/Users/AuthenticateByName', { Host: HOST_A, ...headers }, body);
      return { answer: seen(answer), ms: performance.now() - started };
    };
    /** Sends the same attempt for a member and a non-member and checks both get `expected`, no sooner than DELAY. */
    const same = async (app, expected, options, label) => {
      const answers = [];
      for (const username of NAMES) {
        const { answer, ms } = await attempt(app, username, typeof options === 'function' ? options(username) : options);
        assert.ok(ms >= DELAY - 5, `${label}, ${username}: ${ms} ms`);
        answers.push(answer);
      }
      assert.deepEqual(answers[0], answers[1], `${label}: a member and a non-member are answered alike`);
      assert.deepEqual([answers[0].status, answers[0].text], expected, label);
    };

    it('answers a sign-in without client metadata alike for a member and a non-member (Codex: 400 in 20 ms against 401 in 1 s)', async (t) => {
      const app = await startApp(t, hiddenWorld(), { loginFailureDelayMs: DELAY });
      await same(app, [400, MALFORMED], { headers: {} }, 'no Authorization header');
      assert.equal(app.jellyfin.signInAttempts.length, 0, 'decided before Jellyfin is asked');
    });

    it('answers every malformed sign-in alike, before any name is looked up', async (t) => {
      const app = await startApp(t, hiddenWorld(), { loginFailureDelayMs: DELAY });
      for (const [label, headers] of [
        ['a token but no client', { Authorization: 'MediaBrowser Token="abc"' }],
        ['another scheme', { Authorization: 'Bearer Client="a", Device="b", DeviceId="c", Version="d"' }],
        ['no DeviceId', { Authorization: 'MediaBrowser Client="a", Device="b", Version="d"' }],
        ['an empty Version', { Authorization: 'MediaBrowser Client="a", Device="b", DeviceId="c", Version=""' }],
        ['a bad X-Emby-Authorization beside a good Authorization', { Authorization: WEB_AUTHORIZATION, 'X-Emby-Authorization': 'MediaBrowser Client="a"' }],
      ]) await same(app, [400, MALFORMED], { headers }, label);
      for (const [label, body] of [
        ['no password', (username) => ({ Username: username })],
        ['a password that is not a string', (username) => ({ Username: username, Pw: 5 })],
        ['a list', (username) => [username]],
      ]) await same(app, [400, MALFORMED], (username) => ({ body: body(username) }), label);
      const answers = [];
      for (const username of NAMES) {
        const started = performance.now();
        const answer = await new Promise((resolve, reject) => {
          const request = httpRequest({ hostname: '127.0.0.1', port: app.port, path: '/Users/AuthenticateByName', method: 'POST', headers: { Host: HOST_A, Authorization: WEB_AUTHORIZATION, 'Content-Type': 'application/json' } }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
          });
          request.on('error', reject);
          request.end(`{"Username":"${username}","Pw":`);
        });
        assert.ok(performance.now() - started >= DELAY - 5, `JSON that does not parse, ${username}`);
        answers.push(seen(answer));
      }
      assert.deepEqual(answers[0], answers[1]);
      assert.deepEqual([answers[0].status, answers[0].text], [400, MALFORMED]);
      assert.equal(app.jellyfin.signInAttempts.length, 0, 'Jellyfin was never asked');
    });

    it('answers a wrong password and any status Jellyfin gives a member as it answers a non-member', async (t) => {
      const app = await startApp(t, hiddenWorld(), { loginFailureDelayMs: DELAY });
      await same(app, [401, NOT_A_MEMBER], {}, 'a wrong password');
      for (const status of [400, 403, 404, 429, 500, 503]) {
        app.jellyfin.state.signInStatus = status;
        await same(app, [401, NOT_A_MEMBER], {}, `Jellyfin answers ${status}`);
      }
      assert.ok(app.jellyfin.signInAttempts.every(({ username }) => username === 'Ann'), 'only the member\'s attempts reached Jellyfin');
      assert.equal(app.jellyfin.signInAttempts.length, 7);
    });

    it('answers a member whose sign-in Jellyfin never answers as it answers a non-member', async (t) => {
      const app = await startApp(t, hiddenWorld(), { loginFailureDelayMs: DELAY, loginTimeoutMs: 100 });
      app.jellyfin.state.signInHangs = true;
      await same(app, [401, NOT_A_MEMBER], {}, 'Jellyfin does not answer the sign-in');
      assert.equal(app.jellyfin.signInAttempts.length, 1);
    });

    it('answers alike while Jellyfin is down, with the user list reused or not (Codex: 503 against 502)', async (t) => {
      const app = await startApp(t, hiddenWorld(), { loginFailureDelayMs: DELAY });
      // Cold: nothing reused, so the list is read for each attempt and cannot be.
      app.jellyfin.down = true;
      await same(app, [502, UNAVAILABLE], {}, 'down, cold');
      // Warm: a sign-in reads the list, then Jellyfin goes down while it is still reused.
      app.jellyfin.down = false;
      assert.equal((await signIn(app, HOST_A, 'Ann', 'ann-pass')).status, 200);
      app.jellyfin.down = true;
      await same(app, [502, UNAVAILABLE], {}, 'down, warm');
      // Gone altogether: no connection at all, the list still reused.
      app.jellyfin.down = false;
      assert.equal((await signIn(app, HOST_A, 'Ann', 'ann-pass')).status, 200);
      await app.jellyfin.close();
      await same(app, [502, UNAVAILABLE], {}, 'unreachable, warm');
    });
  });
});
