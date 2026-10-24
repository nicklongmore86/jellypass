// Signing in to the household app goes through the household gateway, exactly as Jellyfin web's does: the household's
// own profile list, AuthenticateByName scoped to the household's members and rate-limited per client, and the token it
// returns is the one the app API accepts. These tests drive the gateway over HTTP; the page itself is tested in
// test/app-pwa.test.mjs and the same flow against a real Jellyfin in test/real-jellyfin.test.mjs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALICE, ANN, BOB, CAROL, HOST_A, HOST_B, OUTSIDER, get, post, startApp, world } from './support/household-app.mjs';

const AUTHORIZATION = 'MediaBrowser Client="JellyPass", Device="Browser", DeviceId="jellypass-test-device-0001", Version="1.0"';
const NOT_A_MEMBER = '{"error":"invalid_credentials"}';

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
    // A wrong password is Jellyfin's refusal, passed on.
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
    assert.equal((await signIn(app, HOST_A, 'Alice', '')).status, 401, 'the member check cannot confirm the name, so it refuses');
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
});
