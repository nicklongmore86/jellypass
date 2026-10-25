// Signing in to the household app goes through the household gateway, exactly as Jellyfin web's does: the household's
// own profile list, AuthenticateByName scoped to the household's members and rate-limited per client, and the token it
// returns is the one the app API accepts. These tests drive the gateway over HTTP; the page itself is tested in
// test/app-pwa.test.mjs and the same flow against a real Jellyfin in test/real-jellyfin.test.mjs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { performance } from 'node:perf_hooks';
import { ALICE, ANN, BOB, CAROL, HOST_A, HOST_B, OUTSIDER, get, post, startApp, world } from './support/household-app.mjs';

const AUTHORIZATION = 'MediaBrowser Client="JellyPass", Device="Browser", DeviceId="jellypass-test-device-0001", Version="1.0"';
const NOT_A_MEMBER = '{"error":"invalid_credentials"}';
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
    // A body that is not a name is refused the same way.
    for (const body of [{}, { Username: 5 }, { Username: ['Alice'] }]) {
      const answer = await post(app.port, '/Users/AuthenticateByName', { Host: HOST_A, Authorization: AUTHORIZATION }, body);
      assert.deepEqual([answer.status, answer.text], [401, NOT_A_MEMBER]);
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
});
