// Signing in to the household app goes through the household gateway, exactly as Jellyfin web's does: the household's
// own profile list, AuthenticateByName scoped to the household's members and rate-limited per client, and the token it
// returns is the one the app API accepts. These tests drive the gateway over HTTP; the page itself is tested in
// test/app-pwa.test.mjs and the same flow against a real Jellyfin in test/real-jellyfin.test.mjs.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
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
    assert.deepEqual(me.json(), { name: 'Alice', household: 'Farmhouse', apiVersion: 1 });
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

    /** Sends a sign-out the client then leaves, as the app's own does after five seconds; `leave` destroys it. */
    const leavingSignOut = (app, headers) => {
      const client = httpRequest({ hostname: '127.0.0.1', port: app.port, path: '/Sessions/Logout', method: 'POST', headers });
      client.on('error', () => {});
      client.end();
      return { leave: () => client.destroy() };
    };
    /** Lets the gateway see a client leave, and gives up waiting for `request` (Jellyfin's) to close soon after, if it does not. */
    const afterLeaving = (request) => Promise.race([
      new Promise((resolve) => request.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);

    it('keeps no token verified after a sign-out its client gave up on, as Jellyfin still has it and revokes it later', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state);
      const token = await tokenOf(app, HOST_A, 'Alice', 'alice-pass');
      const alice = as(HOST_A, token);
      assert.equal((await me(app, alice)).status, 200);
      const hold = holdLogouts(state);
      const client = leavingSignOut(app, alice);
      const { request } = await hold.arrived;
      assert.equal((await me(app, alice)).status, 200);
      // The client leaves; JellyPass keeps Jellyfin's sign-out going, which Jellyfin goes on with.
      client.leave();
      await afterLeaving(request);
      assert.equal(request.socket.destroyed, false, 'still at Jellyfin');
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 4, 'not kept between the client leaving and Jellyfin revoking it');
      hold.release();
      while (!app.jellyfin.logouts.includes(token)) await new Promise((resolve) => setImmediate(resolve));
      const after = await me(app, alice);
      assert.equal(after.status, 401);
      assert.equal(after.text, UNAUTHORIZED);
      assert.equal(verifications(app), 5);
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

    /** A sign-out with none of its tokens known to Jellyfin: `count` made-up tokens, in the headers and query parameters. */
    let junkSerial = 0;
    const junkSignOut = (app, host, count, headers = {}) => {
      const junk = () => `junk${(junkSerial += 1).toString(36)}`;
      const names = ['api_key', 'ApiKey', 'access_token'];
      const query = Array.from({ length: Math.max(0, count - 3) }, (_, index) => `${names[index % names.length]}=${junk()}`).join('&');
      return post(app.port, `/Sessions/Logout?${query}`, { Host: host, Authorization: `MediaBrowser Token="${junk()}"`, 'X-Emby-Authorization': `${WEB_AUTHORIZATION}, Token="${junk()}"`, 'X-Emby-Token': junk(), ...headers }, undefined);
    };
    /** Holds every sign-out at Jellyfin from now on, before it revokes anything, until `release`; `arrived(n)` once n are there. */
    const holdAllLogouts = (state) => {
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      const requests = [];
      state.holdLogout = (request) => {
        requests.push(request);
        return released;
      };
      const arrived = async (count) => {
        while (requests.length < count) await new Promise((resolve) => setImmediate(resolve));
      };
      return { arrived, release };
    };

    it('never checks another household\'s fresh session again for a flood of made-up sign-out tokens (Codex)', async (t) => {
      const app = await startApp(t, world({ passwords }));
      // 21 sign-outs on household B, 500 made-up tokens each and nothing valid: all refused by Jellyfin.
      for (let round = 0; round < 21; round += 1) assert.equal((await junkSignOut(app, HOST_B, 500)).status, 401);
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      const before = verifications(app);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app) - before, 1, 'the second call was answered from the cache');
    });

    it('tracks a sign-out by the first value of each token query parameter only, however many it sends', async (t) => {
      const app = await startApp(t, world({ passwords }));
      const aliceToken = await tokenOf(app, HOST_A, 'Alice', 'alice-pass');
      const annToken = await tokenOf(app, HOST_A, 'Ann', 'ann-pass');
      const alice = as(HOST_A, aliceToken);
      const ann = as(HOST_A, annToken);
      for (const headers of [alice, ann, alice, ann]) assert.equal((await me(app, headers)).status, 200);
      assert.equal(verifications(app), 2);
      // Forwarded as sent; but Ann's token, a second api_key, is not one of the sign-out's tokens.
      assert.equal((await post(app.port, `/Sessions/Logout?api_key=${aliceToken}&API_KEY=${annToken}`, { Host: HOST_A }, undefined)).status, 204);
      assert.equal(app.jellyfin.logouts.length, 1);
      assert.equal(app.jellyfin.logouts[0], aliceToken);
      assert.equal((await me(app, alice)).text, UNAUTHORIZED);
      assert.equal(verifications(app), 3);
      assert.equal((await me(app, ann)).status, 200);
      assert.equal(verifications(app), 3, 'Ann still answered from the cache');
    });

    const from = (client, headers) => ({ ...headers, 'X-Forwarded-For': client });

    it('keeps a token back while Jellyfin has its sign-out, though made-up sign-outs used up every limit and its client left (Codex)', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state, { trustedProxies: ['127.0.0.1'] });
      const token = await tokenOf(app, HOST_A, 'Alice', 'alice-pass');
      const alice = as(HOST_A, token);
      // 30 sign-outs to household A from three addresses, with no token of anyone's: the client and household limits used up.
      for (const client of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
        for (let index = 0; index < 10; index += 1) assert.equal((await junkSignOut(app, HOST_A, 6, { 'X-Forwarded-For': client })).status, 401);
      }
      const hold = holdLogouts(state);
      const client = leavingSignOut(app, from('203.0.113.4', alice));
      const { request } = await hold.arrived;
      client.leave();
      await afterLeaving(request);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 2, 'never kept while Jellyfin has its sign-out');
      hold.release();
      while (!app.jellyfin.logouts.includes(token)) await new Promise((resolve) => setImmediate(resolve));
      const after = await me(app, alice);
      assert.equal(after.status, 401);
      assert.equal(after.text, UNAUTHORIZED);
    });

    it('gives a sign-out up once Jellyfin has taken too long, and keeps its tokens back for a minute after, past every limit', async (t) => {
      let now = Date.parse('2026-10-25T12:00:00.000Z');
      const state = world({ passwords });
      const app = await startApp(t, state, { now: () => now, trustedProxies: ['127.0.0.1'], signOutTimeoutMs: 200, signOutLimits: { inFlightPerClient: 1, perClient: 0 } });
      const alice = from('203.0.113.7', as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass')));
      const hold = holdAllLogouts(state);
      t.after(() => hold.release());
      const started = performance.now();
      const timedOut = await signOut(app, alice);
      assert.equal(timedOut.status, 502);
      assert.equal(timedOut.text, UNAVAILABLE);
      assert.equal(performance.now() - started >= 190, true, 'given up only after the timeout');
      // Jellyfin never answered: whether it revoked the token is not known, so it is kept back, limits or not.
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 2, 'checked every time');
      // No longer at Jellyfin: the client's one sign-out at a time is free again, so its next is sent rather than refused.
      assert.equal((await signOut(app, alice)).status, 502);
      await hold.arrived(2);
      now += 60 * 1000;
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 3, 'checked once, then kept again a minute after');
    });

    it('refuses a sign-out past the limits on those at Jellyfin at once, per client, per household and in all, rather than send it untracked', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state, { trustedProxies: ['127.0.0.1'], signOutLimits: { inFlightPerClient: 1, inFlightPerHousehold: 2, inFlight: 3 } });
      const logoutsSent = () => app.jellyfin.requests.filter((request) => request.pathname === '/Sessions/Logout').length;
      const hold = holdAllLogouts(state);
      const held = [junkSignOut(app, HOST_A, 3, { 'X-Forwarded-For': '203.0.113.1' })];
      await hold.arrived(1);
      const busy = await junkSignOut(app, HOST_A, 3, { 'X-Forwarded-For': '203.0.113.1' });
      assert.equal(busy.status, 503, 'the client has one at Jellyfin already');
      assert.equal(busy.text, '{"error":"too_many_sign_outs"}');
      assert.equal(busy.headers['retry-after'], '1');
      held.push(junkSignOut(app, HOST_A, 3, { 'X-Forwarded-For': '203.0.113.2' }));
      await hold.arrived(2);
      assert.equal((await junkSignOut(app, HOST_A, 3, { 'X-Forwarded-For': '203.0.113.3' })).status, 503, 'household A has two');
      held.push(junkSignOut(app, HOST_B, 3, { 'X-Forwarded-For': '203.0.113.3' }));
      await hold.arrived(3);
      assert.equal((await junkSignOut(app, HOST_B, 3, { 'X-Forwarded-For': '203.0.113.4' })).status, 503, 'three in all');
      assert.equal(logoutsSent(), 3, 'none refused was sent to Jellyfin');
      hold.release();
      assert.deepEqual(await Promise.all(held.map(async (answer) => (await answer).status)), [401, 401, 401]);
      assert.equal((await junkSignOut(app, HOST_A, 3, { 'X-Forwarded-For': '203.0.113.1' })).status, 401, 'free again once Jellyfin answered');
      assert.equal(logoutsSent(), 4);
    });

    it('past a client\'s limit keeps back after its sign-out only the tokens JellyPass verified, and another client has its own', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state, { trustedProxies: ['127.0.0.1'] });
      for (let index = 0; index < 10; index += 1) assert.equal((await junkSignOut(app, HOST_A, 6, { 'X-Forwarded-For': '203.0.113.5' })).status, 401);
      // Each sign-out carries an Alice token Jellyfin revokes, and an Ann token it does not, never verified before.
      const signOutWith = (client, aliceToken, annToken) => post(app.port, '/Sessions/Logout', from(client, { ...as(HOST_A, aliceToken), 'X-Emby-Token': annToken }), undefined);
      const [alice1, alice2, ann1, ann2] = [
        await tokenOf(app, HOST_A, 'Alice', 'alice-pass'),
        await tokenOf(app, HOST_A, 'Alice', 'alice-pass'),
        await tokenOf(app, HOST_A, 'Ann', 'ann-pass'),
        await tokenOf(app, HOST_A, 'Ann', 'ann-pass'),
      ];
      assert.equal((await me(app, as(HOST_A, alice1))).status, 200);
      // The client's 11th sign-out: every token kept back while Jellyfin has it.
      const hold = holdAllLogouts(state);
      const first = signOutWith('203.0.113.5', alice1, ann1);
      await hold.arrived(1);
      for (const token of [ann1, ann1, alice1, alice1]) assert.equal((await me(app, as(HOST_A, token))).status, 200);
      assert.equal(verifications(app), 5, 'checked every time');
      hold.release();
      assert.equal((await first).status, 204);
      // After: Alice's, verified, is still kept back; Ann's, never verified, is not.
      assert.equal((await me(app, as(HOST_A, alice1))).text, UNAUTHORIZED);
      assert.equal((await me(app, as(HOST_A, ann1))).status, 200);
      assert.equal((await me(app, as(HOST_A, ann1))).status, 200);
      assert.equal(verifications(app), 7, 'Ann\'s checked once, then kept');
      // Another client, within its own limit: both kept back after.
      assert.equal((await signOutWith('203.0.113.6', alice2, ann2)).status, 204);
      assert.equal((await me(app, as(HOST_A, ann2))).status, 200);
      assert.equal((await me(app, as(HOST_A, ann2))).status, 200);
      assert.equal(verifications(app), 9, 'Ann\'s other token checked every time');
    });

    it('past a household\'s limit, from any client, keeps back after its sign-outs only the tokens JellyPass verified, and never another household\'s', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state, { trustedProxies: ['127.0.0.1'], signOutLimits: { perHousehold: 3 } });
      for (const client of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) assert.equal((await junkSignOut(app, HOST_B, 6, { 'X-Forwarded-For': client })).status, 401);
      const [bob1, bob2] = [await tokenOf(app, HOST_B, 'Bob', 'bob-pass'), await tokenOf(app, HOST_B, 'Bob', 'bob-pass')];
      const [alice, ann] = [await tokenOf(app, HOST_A, 'Alice', 'alice-pass'), await tokenOf(app, HOST_A, 'Ann', 'ann-pass')];
      const hold = holdAllLogouts(state);
      const bobOut = post(app.port, '/Sessions/Logout', from('203.0.113.9', { ...as(HOST_B, bob1), 'X-Emby-Token': bob2 }), undefined);
      await hold.arrived(1);
      assert.equal((await me(app, as(HOST_B, bob2))).status, 200);
      assert.equal((await me(app, as(HOST_B, bob2))).status, 200);
      assert.equal(verifications(app), 2, 'never kept while Jellyfin has the sign-out, past the limit too');
      hold.release();
      assert.equal((await bobOut).status, 204);
      assert.equal((await me(app, as(HOST_B, bob2))).status, 200);
      assert.equal((await me(app, as(HOST_B, bob2))).status, 200);
      assert.equal(verifications(app), 3, 'household B past its limit: after, checked once, then kept');
      assert.equal((await post(app.port, '/Sessions/Logout', from('203.0.113.9', { ...as(HOST_A, alice), 'X-Emby-Token': ann }), undefined)).status, 204);
      assert.equal((await me(app, as(HOST_A, ann))).status, 200);
      assert.equal((await me(app, as(HOST_A, ann))).status, 200);
      assert.equal(verifications(app), 5, 'household A within its own: checked every time');
      assert.equal((await me(app, as(HOST_B, bob1))).text, UNAUTHORIZED);
      assert.equal((await me(app, as(HOST_A, alice))).text, UNAUTHORIZED);
    });

    it('past every limit, still keeps a token JellyPass verified back after Jellyfin answers, should it revoke it a little late', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state, { signOutLimits: { perClient: 0 } });
      const token = await tokenOf(app, HOST_A, 'Alice', 'alice-pass');
      const alice = as(HOST_A, token);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 1);
      let revoke;
      state.revokeLate = () => new Promise((resolve) => { revoke = resolve; });
      assert.equal((await signOut(app, alice)).status, 204);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 3, 'checked every time');
      revoke();
      while (!app.jellyfin.logouts.includes(token)) await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await me(app, alice)).text, UNAUTHORIZED);
    });

    it('when what is kept back after is full, drops the oldest of it, and never touches anyone else\'s, nor sign-outs at Jellyfin', async (t) => {
      const state = world({ passwords });
      const app = await startApp(t, state, { signOutLimits: { tracked: 6, perClient: 1000, perHousehold: 1000 } });
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      const bob = as(HOST_B, await tokenOf(app, HOST_B, 'Bob', 'bob-pass'));
      for (const headers of [alice, bob, alice, bob]) assert.equal((await me(app, headers)).status, 200);
      assert.equal(verifications(app), 2);
      // Far more signed-out tokens than there is room for, over and over.
      for (let round = 0; round < 20; round += 1) assert.equal((await junkSignOut(app, HOST_B, 500)).status, 401);
      for (const headers of [alice, bob]) assert.equal((await me(app, headers)).status, 200);
      assert.equal(verifications(app), 2, 'sessions made before are still answered from the cache');
      const ann = as(HOST_A, await tokenOf(app, HOST_A, 'Ann', 'ann-pass'));
      assert.equal((await me(app, ann)).status, 200);
      assert.equal((await me(app, ann)).status, 200);
      assert.equal(verifications(app), 3, 'and a new one is kept');
      // Sign-outs at Jellyfin keep all of their tokens back, however many, whatever is kept back after.
      const hold = holdAllLogouts(state);
      const junkOut = junkSignOut(app, HOST_B, 7);
      await hold.arrived(1);
      const aliceOut = signOut(app, alice);
      const bobOut = signOut(app, bob);
      await hold.arrived(3);
      for (const headers of [alice, alice, bob, bob]) assert.equal((await me(app, headers)).status, 200);
      assert.equal(verifications(app), 7, 'never kept while Jellyfin has their sign-outs');
      assert.equal((await me(app, ann)).status, 200);
      assert.equal(verifications(app), 7, 'Ann still answered from the cache');
      hold.release();
      assert.equal((await aliceOut).status, 204);
      assert.equal((await junkOut).status, 401);
      assert.equal((await bobOut).status, 204);
      assert.equal((await me(app, alice)).text, UNAUTHORIZED);
      assert.equal((await me(app, bob)).text, UNAUTHORIZED);
      assert.equal((await me(app, ann)).status, 200);
      assert.equal(verifications(app), 9, 'Ann still answered from the cache');
    });

    it('tracks the token Jellyfin reads from an authorization header: its last Token, and never one inside a quoted value', async (t) => {
      const app = await startApp(t, world({ passwords }));
      const aliceToken = await tokenOf(app, HOST_A, 'Alice', 'alice-pass');
      const annToken = await tokenOf(app, HOST_A, 'Ann', 'ann-pass');
      const alice = as(HOST_A, aliceToken);
      const ann = as(HOST_A, annToken);
      for (const headers of [alice, ann, alice, ann]) assert.equal((await me(app, headers)).status, 200);
      assert.equal(verifications(app), 2);
      // Given twice, Jellyfin takes the last Token: Ann's. Alice's, first, is neither signed out nor forgotten.
      const twice = `MediaBrowser Token="${aliceToken}", Client="Jellyfin Web", Token="${annToken}"`;
      assert.equal((await signOut(app, { Host: HOST_A, Authorization: twice })).status, 204);
      assert.deepEqual(app.jellyfin.logouts, [annToken]);
      assert.equal((await me(app, ann)).text, UNAUTHORIZED);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 3, 'Alice still answered from the cache');
      // A comma inside quotes is part of the value: "Token=" inside Device is no Token. Alice's, after it, is.
      const second = await tokenOf(app, HOST_A, 'Ann', 'ann-pass');
      assert.equal((await me(app, as(HOST_A, second))).status, 200);
      const quoted = `MediaBrowser Client="Jellyfin Web", Device="Firefox, Token=${second}", DeviceId="jellypass-test", Version="10.11.3", Token="${aliceToken}"`;
      assert.equal((await signOut(app, { Host: HOST_A, 'X-Emby-Authorization': quoted })).status, 204);
      assert.deepEqual(app.jellyfin.logouts, [annToken, aliceToken]);
      assert.equal((await me(app, alice)).text, UNAUTHORIZED);
      assert.equal((await me(app, as(HOST_A, second))).status, 200);
      assert.equal(verifications(app), 5, 'Ann\'s other sign-in still answered from the cache');
    });

    it('forgets nothing on a call that is not a sign-out', async (t) => {
      const app = await startApp(t, world({ passwords }));
      const alice = as(HOST_A, await tokenOf(app, HOST_A, 'Alice', 'alice-pass'));
      assert.equal((await me(app, alice)).status, 200);
      await get(app.port, '/Sessions/Logout', alice);
      await post(app.port, '/Sessions/Logouts', alice, undefined);
      await post(app.port, '/Sessions/Logout/Other', alice, undefined);
      assert.deepEqual(app.jellyfin.logouts, []);
      // The household host checked once that the relayed calls' token is a member's; the app asked nothing more.
      assert.equal(verifications(app), 2);
      assert.equal((await me(app, alice)).status, 200);
      assert.equal(verifications(app), 2, 'still answered from the cache');
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
    assert.deepEqual(me.json(), { name: 'Ann', household: 'Farmhouse', apiVersion: 1 });
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

// Quick Connect signs in whoever authorizes a code, so Jellyfin never asks whether they are the household's; and the
// Streamyfin plugin hands its settings, Seerr's keys among them, to any signed-in user. A household host answers both
// itself, the same for anyone, and never asks Jellyfin.
describe('Quick Connect and Streamyfin on a household host', { timeout: 30_000 }, () => {
  const QUICK_CONNECT_REFUSED = '{"error":"household_quick_connect_disabled"}';
  const NOT_FOUND = '{"error":"not_found"}';
  /** Each spelling Jellyfin routes the same: any case, percent-encoded, trailing slashes, the legacy prefixes. */
  const spellings = (path) => {
    const [, first, rest] = /^\/([^/]+)\/(.+)$/.exec(path);
    return [
      path,
      path.toLowerCase(),
      path.toUpperCase(),
      `${path}/`,
      `${path}//`,
      `/${first}/%${rest.charCodeAt(0).toString(16).toUpperCase()}${rest.slice(1)}`,
      `/emby${path}`,
      `/MediaBrowser${path}/`,
      `/%65mby${path}`,
      `${path}?Secret=x`,
    ];
  };
  const QUICK_CONNECT = ['/QuickConnect/Initiate', '/QuickConnect/Connect', '/QuickConnect/Authorize', '/Users/AuthenticateWithQuickConnect'];
  const STREAMYFIN = ['/Streamyfin/config', '/Streamyfin/config/yaml', '/Streamyfin/notification'];
  const callers = {
    nobody: {},
    member: { Authorization: `${WEB_AUTHORIZATION}, Token="token-alice"` },
    outsider: { Authorization: `${WEB_AUTHORIZATION}, Token="token-outsider"` },
  };
  const asks = (app) => app.jellyfin.requests.length;

  it('refuses every Quick Connect call, member or not, in every method and spelling, without asking Jellyfin', async (t) => {
    const app = await startApp(t);
    const before = asks(app);
    for (const path of QUICK_CONNECT) {
      for (const spelling of spellings(path)) {
        for (const [who, headers] of Object.entries(callers)) {
          for (const method of ['GET', 'POST']) {
            const answer = await get(app.port, spelling, { Host: HOST_A, 'Content-Type': 'application/json', ...headers }, { method, body: method === 'POST' ? '{"Secret":"x"}' : undefined });
            const label = `${method} ${spelling} as ${who}`;
            assert.equal(answer.status, 403, label);
            assert.equal(answer.text, QUICK_CONNECT_REFUSED, label);
            assert.equal(answer.headers['cache-control'], 'no-store', label);
            assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8', label);
          }
        }
      }
    }
    assert.equal(asks(app), before, 'a Quick Connect call reached Jellyfin');
  });

  it('says Quick Connect is off in every spelling, member or not, without asking Jellyfin', async (t) => {
    const app = await startApp(t);
    const before = asks(app);
    for (const spelling of spellings('/QuickConnect/Enabled')) {
      for (const [who, headers] of Object.entries(callers)) {
        const answer = await get(app.port, spelling, { Host: HOST_A, ...headers });
        assert.deepEqual([answer.status, answer.text, answer.headers['cache-control']], [200, 'false', 'no-store'], `${spelling} as ${who}`);
      }
    }
    // Jellyfin has no other method there: refused like any other Quick Connect call.
    assert.equal((await post(app.port, '/QuickConnect/Enabled', { Host: HOST_A }, undefined)).text, QUICK_CONNECT_REFUSED);
    assert.equal(asks(app), before, 'a Quick Connect call reached Jellyfin');
  });

  it('answers every Streamyfin plugin call with a 404, member or not, without asking Jellyfin', async (t) => {
    const app = await startApp(t);
    const before = asks(app);
    for (const path of STREAMYFIN) {
      for (const spelling of [...spellings(path), '/Streamyfin', '/streamyfin/']) {
        for (const [who, headers] of Object.entries(callers)) {
          for (const method of ['GET', 'POST', 'DELETE']) {
            const answer = await get(app.port, spelling, { Host: HOST_A, ...headers }, { method });
            const label = `${method} ${spelling} as ${who}`;
            assert.deepEqual([answer.status, answer.text, answer.headers['cache-control']], [404, NOT_FOUND, 'no-store'], label);
          }
        }
      }
    }
    assert.equal(asks(app), before, 'a Streamyfin call reached Jellyfin');
  });

  it('never proxies a WebSocket upgrade to Quick Connect or Streamyfin', async (t) => {
    const app = await startApp(t);
    const before = asks(app);
    for (const path of [...QUICK_CONNECT, '/QuickConnect/Enabled', ...STREAMYFIN]) {
      for (const spelling of spellings(path)) {
        assert.match(await upgrade(app.port, spelling, HOST_A), /^HTTP\/1\.1 404 /, spelling);
      }
    }
    assert.equal(asks(app), before, 'an upgrade reached Jellyfin');
  });

  it('still signs members in by name and refuses anyone else, and still proxies what is merely named alike', async (t) => {
    const app = await startApp(t, world({ passwords: { [ALICE]: 'alice-pass', [OUTSIDER]: 'out-pass' } }));
    const signIn = (username, password) => post(app.port, '/Users/AuthenticateByName', { Host: HOST_A, Authorization: AUTHORIZATION }, { Username: username, Pw: password });
    const alice = await signIn('Alice', 'alice-pass');
    assert.equal(alice.status, 200);
    assert.equal(alice.json().User.Id, ALICE);
    const outsider = await signIn('Outsider', 'out-pass');
    assert.deepEqual([outsider.status, outsider.text], [401, NOT_A_MEMBER]);
    // Only Quick Connect's own routes are answered here: a look-alike path still reaches Jellyfin.
    const before = asks(app);
    await get(app.port, '/QuickConnectX/Enabled', { Host: HOST_A });
    await get(app.port, '/StreamyfinX/config', { Host: HOST_A });
    assert.equal(asks(app), before + 2);
  });
});

// The Jellyfin Enhanced plugin relays Seerr to any signed-in user: its answers carry mediaInfo (other households'
// requests), its request list names other requesters, and it requests past the household app's own checks. A household
// host answers every one of those routes itself, as it does Streamyfin's, and never asks Jellyfin. It does the same for
// the plugin's reviews, which hand out other users' reviews and names whatever the caller may see, and its lookup by
// provider ID, which searches the whole library. The plugin's other routes (its scripts, settings and own lookups) are
// still relayed.
describe('Jellyfin Enhanced Seerr, reviews and provider lookup routes on a household host', { timeout: 60_000 }, () => {
  const NOT_FOUND = '{"error":"not_found"}';
  const alternate = (text) => [...text].map((char, index) => (index % 2 ? char.toUpperCase() : char.toLowerCase())).join('');
  /** Each spelling Jellyfin routes the same: any case, percent-encoded, trailing or doubled slashes, the legacy prefixes. */
  const spellings = (path) => {
    const [, first, rest] = /^\/([^/]+)\/(.+)$/.exec(path);
    return [
      path,
      path.toLowerCase(),
      path.toUpperCase(),
      alternate(path),
      `${path}/`,
      `${path}//`,
      `/${first}//${rest}`,
      `//${first}/${rest}`,
      `/${first}/%${rest.charCodeAt(0).toString(16).toUpperCase()}${rest.slice(1)}`,
      `/%${first.charCodeAt(0).toString(16)}${first.slice(1)}/${rest}`,
      `/emby${path}`,
      `/Emby${path}/`,
      `/MediaBrowser${path}`,
      `/mediabrowser${path}/`,
      `/%65mby${path}`,
      `${path}?query=x&take=20`,
    ];
  };
  // Every Seerr route of Jellyfin Enhanced 12.13 (Controllers/JellyfinEnhancedController.cs), and the Sonarr and Radarr
  // ones that list what Seerr's requests fetched, with their parameters filled in.
  const SEERR = [
    '/JellyfinEnhanced/jellyseerr',
    '/JellyfinEnhanced/jellyseerr/status',
    '/JellyfinEnhanced/jellyseerr/validate',
    '/JellyfinEnhanced/jellyseerr/user-status',
    '/JellyfinEnhanced/jellyseerr/user',
    '/JellyfinEnhanced/jellyseerr/quota',
    '/JellyfinEnhanced/jellyseerr/permission-audit',
    '/JellyfinEnhanced/jellyseerr/trigger-recently-added-scan',
    '/JellyfinEnhanced/jellyseerr/search',
    '/JellyfinEnhanced/jellyseerr/sonarr',
    '/JellyfinEnhanced/jellyseerr/radarr',
    '/JellyfinEnhanced/jellyseerr/sonarr/lookup/1399',
    '/JellyfinEnhanced/jellyseerr/settings/radarr',
    '/JellyfinEnhanced/jellyseerr/settings/partial-requests',
    '/JellyfinEnhanced/jellyseerr/radarr/0',
    '/JellyfinEnhanced/jellyseerr/request',
    '/JellyfinEnhanced/jellyseerr/request/tv/1399/seasons',
    '/JellyfinEnhanced/jellyseerr/movie/603',
    '/JellyfinEnhanced/jellyseerr/movie/603/similar',
    '/JellyfinEnhanced/jellyseerr/movie/603/recommendations',
    '/JellyfinEnhanced/jellyseerr/movie/603/ratingscombined',
    '/JellyfinEnhanced/jellyseerr/movie-collections',
    '/JellyfinEnhanced/jellyseerr/tv/1399',
    '/JellyfinEnhanced/jellyseerr/tv/1399/season/1',
    '/JellyfinEnhanced/jellyseerr/tv/1399/similar',
    '/JellyfinEnhanced/jellyseerr/tv/1399/recommendations',
    '/JellyfinEnhanced/jellyseerr/tv/1399/ratings',
    '/JellyfinEnhanced/jellyseerr/discover/trending',
    '/JellyfinEnhanced/jellyseerr/discover/movies',
    '/JellyfinEnhanced/jellyseerr/discover/movies/upcoming',
    '/JellyfinEnhanced/jellyseerr/discover/movies/studio/2',
    '/JellyfinEnhanced/jellyseerr/discover/movies/genre/28',
    '/JellyfinEnhanced/jellyseerr/discover/movies/keyword/9715',
    '/JellyfinEnhanced/jellyseerr/discover/tv',
    '/JellyfinEnhanced/jellyseerr/discover/tv/upcoming',
    '/JellyfinEnhanced/jellyseerr/discover/tv/network/49',
    '/JellyfinEnhanced/jellyseerr/discover/tv/studio/2',
    '/JellyfinEnhanced/jellyseerr/discover/tv/genre/18',
    '/JellyfinEnhanced/jellyseerr/discover/tv/keyword/9715',
    '/JellyfinEnhanced/jellyseerr/discover/genreslider/movie',
    '/JellyfinEnhanced/jellyseerr/discover/genreslider/tv',
    '/JellyfinEnhanced/jellyseerr/person/287',
    '/JellyfinEnhanced/jellyseerr/person/287/combined_credits',
    '/JellyfinEnhanced/jellyseerr/collection/10',
    '/JellyfinEnhanced/jellyseerr/overrideRule',
    '/JellyfinEnhanced/jellyseerr/watchlist',
    '/JellyfinEnhanced/jellyseerr/sync-watchlist',
    '/JellyfinEnhanced/jellyseerr/import-users',
    '/JellyfinEnhanced/jellyseerr/issue',
    '/JellyfinEnhanced/jellyseerr/issue/7',
    '/JellyfinEnhanced/tmdb/search/person',
    '/JellyfinEnhanced/tmdb/search/keyword',
    '/JellyfinEnhanced/tmdb/genres/movie',
    '/JellyfinEnhanced/tmdb/genres/tv',
    '/JellyfinEnhanced/proxy/avatar',
    '/JellyfinEnhanced/arr',
    '/JellyfinEnhanced/arr/requests',
    '/JellyfinEnhanced/arr/requests/7/approve',
    '/JellyfinEnhanced/arr/requests/7/decline',
    '/JellyfinEnhanced/arr/queue',
    '/JellyfinEnhanced/arr/history',
    '/JellyfinEnhanced/arr/calendar',
    '/JellyfinEnhanced/arr/calendar/user-data',
    '/JellyfinEnhanced/arr/links',
    '/JellyfinEnhanced/arr/movie-instances',
    '/JellyfinEnhanced/arr/identify-url',
    '/JellyfinEnhanced/arr/series-slug',
    '/JellyfinEnhanced/arr/series-slugs',
    '/JellyfinEnhanced/arr/validate/sonarr',
    '/JellyfinEnhanced/arr/validate/radarr',
  ];
  // Its reviews, read and write, and its lookup of library items by provider ID, with their parameters filled in.
  const UNCHECKED = [
    '/JellyfinEnhanced/reviews',
    '/JellyfinEnhanced/reviews/movie/603',
    '/JellyfinEnhanced/reviews/tv/1399',
    '/JellyfinEnhanced/reviews/ratings',
    '/JellyfinEnhanced/reviews/admin/all',
    '/JellyfinEnhanced/reviews/admin/0123456789abcdef0123456789abcdef/movie/603',
    '/JellyfinEnhanced/items/by-providers',
  ];
  // Its other routes carry nothing from Seerr: its scripts and settings, and lookups made with its own TMDB key.
  const NOT_SEERR = [
    '/JellyfinEnhanced/script',
    '/JellyfinEnhanced/bundle.js',
    '/JellyfinEnhanced/js/enhanced/helpers.js',
    '/JellyfinEnhanced/version',
    '/JellyfinEnhanced/public-config',
    '/JellyfinEnhanced/bootstrap',
    '/JellyfinEnhanced/locales/en.json',
    '/JellyfinEnhanced/tag-styles',
    '/JellyfinEnhanced/tmdb/movie/603',
    '/JellyfinEnhanced/tmdb/search/movie',
    '/JellyfinEnhanced/tmdb/genre/movie/list',
    '/JellyfinEnhanced/tmdb/validate',
    '/JellyfinEnhanced/watch-providers',
    '/JellyfinEnhanced/proxyx/avatar',
    '/JellyfinEnhanced/jellyseerrx/search',
    '/JellyfinEnhanced/arrx/queue',
    '/JellyfinEnhancedX/jellyseerr/search',
    '/JellyfinEnhanced/tmdb/search/personx',
    '/jellyseerr/search',
    '/JellyfinEnhanced/anilist/reviews',
    '/JellyfinEnhanced/reviewsx/movie/603',
    '/JellyfinEnhancedX/reviews/movie/603',
    '/JellyfinEnhanced/items',
    '/JellyfinEnhanced/items/by-providersx',
    '/JellyfinEnhanced/item-stats/0123456789abcdef0123456789abcdef/0123456789abcdef0123456789abcdef',
    '/JellyfinEnhanced/activity',
    '/JellyfinEnhanced/active-streams/sessions',
    '/JellyfinEnhanced/translate',
    '/JellyfinEnhanced/translate/languages',
    '/reviews/movie/603',
  ];
  const callers = {
    nobody: {},
    member: { Authorization: `${WEB_AUTHORIZATION}, Token="token-alice"` },
    outsider: { Authorization: `${WEB_AUTHORIZATION}, Token="token-outsider"` },
  };
  // The household host's own check that a token is a member's (GET /Users/Me) is not a call relayed to Jellyfin.
  const asks = (app) => app.jellyfin.requests.filter((request) => request.pathname !== '/Users/Me').length;

  it('answers every Seerr, reviews and provider lookup route of the plugin with a 404, member or not, in every method and spelling, without asking Jellyfin', async (t) => {
    const app = await startApp(t);
    const before = asks(app);
    for (const path of [...SEERR, ...UNCHECKED]) {
      for (const spelling of spellings(path)) {
        for (const [who, headers] of Object.entries(callers)) {
          for (const method of ['GET', 'POST', 'DELETE']) {
            const answer = await get(app.port, spelling, { Host: HOST_A, 'Content-Type': 'application/json', ...headers }, { method, body: method === 'POST' ? '{"mediaType":"movie","mediaId":603}' : undefined });
            const label = `${method} ${spelling} as ${who}`;
            assert.deepEqual([answer.status, answer.text, answer.headers['cache-control']], [404, NOT_FOUND, 'no-store'], label);
            assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8', label);
          }
        }
      }
    }
    assert.equal(asks(app), before, 'a refused Jellyfin Enhanced call reached Jellyfin');
  });

  it('answers the reviews and provider lookup routes with a 404 by every method, with the query the plugin reads, without asking Jellyfin', async (t) => {
    const app = await startApp(t);
    const before = asks(app);
    const paths = [
      '/JellyfinEnhanced/reviews/ratings?keys=movie:603,tv:1399',
      '/JellyfinEnhanced/items/by-providers?providers[Tmdb]=603&types=Movie',
      '/JellyfinEnhanced/items/by-providers?Tmdb=603',
    ];
    for (const path of [...UNCHECKED, ...paths]) {
      for (const [who, headers] of Object.entries(callers)) {
        for (const method of ['HEAD', 'PUT', 'PATCH', 'OPTIONS']) {
          const answer = await get(app.port, path, { Host: HOST_A, ...headers }, { method });
          const label = `${method} ${path} as ${who}`;
          assert.deepEqual([answer.status, answer.headers['cache-control']], [404, 'no-store'], label);
          if (method !== 'HEAD') assert.equal(answer.text, NOT_FOUND, label);
        }
      }
    }
    assert.equal(asks(app), before, 'a refused Jellyfin Enhanced call reached Jellyfin');
  });

  it('refuses a path that is a Seerr route only once decoded again, without asking Jellyfin', async (t) => {
    const app = await startApp(t);
    const before = asks(app);
    // %256A is %6A once decoded, which some reader on the way might decode again to j.
    for (const path of ['/JellyfinEnhanced/%256Aellyseerr/search', '/%254AellyfinEnhanced/arr/requests', '/JellyfinEnhanced/tmdb/genres/%256Dovie', '/JellyfinEnhanced/%2572eviews/movie/603', '/JellyfinEnhanced/items/%2562y-providers']) {
      const answer = await get(app.port, path, { Host: HOST_A, ...callers.member });
      assert.deepEqual([answer.status, answer.text, answer.headers['cache-control']], [400, '{"error":"invalid_request"}', 'no-store'], path);
    }
    assert.equal(asks(app), before, 'an encoded Jellyfin Enhanced Seerr call reached Jellyfin');
  });

  it('never proxies a WebSocket upgrade to a refused route of the plugin', async (t) => {
    const app = await startApp(t);
    const before = asks(app);
    for (const path of ['/JellyfinEnhanced/jellyseerr/search', '/JellyfinEnhanced/arr/requests', '/JellyfinEnhanced/proxy/avatar', '/JellyfinEnhanced/tmdb/search/person', '/JellyfinEnhanced/reviews/movie/603', '/JellyfinEnhanced/items/by-providers']) {
      for (const spelling of spellings(path)) {
        assert.match(await upgrade(app.port, spelling, HOST_A), /^HTTP\/1\.1 404 /, spelling);
      }
    }
    assert.equal(asks(app), before, 'an upgrade reached Jellyfin');
  });

  it('still relays the plugin\'s other routes, and what is merely named alike, to Jellyfin', async (t) => {
    const app = await startApp(t);
    for (const path of NOT_SEERR) {
      for (const spelling of [path, path.toLowerCase(), `/emby${path}/`]) {
        const before = asks(app);
        const answer = await get(app.port, spelling, { Host: HOST_A, ...callers.member });
        assert.notEqual(answer.text, NOT_FOUND, spelling);
        assert.equal(asks(app), before + 1, `${spelling} did not reach Jellyfin`);
        assert.equal(app.jellyfin.requests.at(-1).pathname, spelling, spelling);
      }
    }
  });

  it('leaves the admin host as it was', async (t) => {
    const app = await startApp(t);
    const before = asks(app);
    for (const host of ['jellypass.example.test', '127.0.0.1']) {
      const unrelated = await get(app.port, '/JellyfinEnhanced/script', { Host: host });
      assert.notEqual(unrelated.text, NOT_FOUND);
      for (const path of ['/JellyfinEnhanced/jellyseerr/search', '/JellyfinEnhanced/arr/requests', '/JellyfinEnhanced/proxy/avatar', '/JellyfinEnhanced/tmdb/genres/movie', '/JellyfinEnhanced/reviews/movie/603', '/JellyfinEnhanced/items/by-providers?Tmdb=603']) {
        const answer = await get(app.port, path, { Host: host });
        assert.deepEqual([answer.status, answer.text], [unrelated.status, unrelated.text], `${host}${path}`);
      }
    }
    assert.equal(asks(app), before);
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
