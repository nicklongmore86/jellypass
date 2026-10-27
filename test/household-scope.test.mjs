// A household host shows one household nothing of another's members, and works only for its own members' tokens:
// Jellyfin's user listings (GET /Users, GET /Sessions, SyncPlay's groups) are narrowed to the household's members, and
// a token that is not a member's, valid at Jellyfin or not, gets one fixed answer on every route relayed to Jellyfin.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { describe, it } from 'node:test';
import { HouseholdGateway } from '../dist/household-gateway.js';
import { ALICE, ANN, BOB, CAROL, HOST_A, HOST_B, ITEMS, JELLYFIN_ADMIN, OUTSIDER, get, post, startApp, world } from './support/household-app.mjs';

const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-scope-test", Version="10.11.3"';
const NOT_A_MEMBER = '{"error":"unauthorized"}';
const ITEM_NOT_FOUND = '{"error":"item_not_found"}';
const passwords = { [ALICE]: 'alice-pass', [BOB]: 'bob-pass' };
const as = (host, token) => ({ Host: host, Authorization: `${WEB}, Token="${token}"` });
const verifications = (app) => app.jellyfin.requests.filter((request) => request.pathname === '/Users/Me').length;
/** Requests that reached the fake Jellyfin but the gateway's own checks (GET /Users/Me) and its admin-key reads. */
const relayed = (app) => app.jellyfin.requests.filter((request) => request.pathname !== '/Users/Me' && !/Token="jellyfin-key"|api_key=jellyfin-key/.test(`${request.headers.authorization ?? ''} ${request.path}`));

/** Spellings Jellyfin 10.11 routes as `GET /<name>` (any case, an encoded letter, a trailing slash, legacy prefixes). */
const spellings = (name) => [
  `/${name}`, `/${name.toLowerCase()}`, `/${name.toUpperCase()}`, `/${name}/`, `/%${name.charCodeAt(0).toString(16).toUpperCase()}${name.slice(1)}`,
  `/emby/${name}`, `/MediaBrowser/${name}/`,
];

const sessions = [
  { Id: 'session-alice', UserId: ALICE, UserName: 'Alice', DeviceName: 'Alice TV', AdditionalUsers: [] },
  { Id: 'session-bob', UserId: BOB, UserName: 'Bob', DeviceName: 'Bob phone', AdditionalUsers: [] },
  { Id: 'session-ann-and-alice', UserId: ANN, UserName: 'Ann', DeviceName: 'Kitchen', AdditionalUsers: [{ UserId: ALICE, UserName: 'Alice' }] },
  { Id: 'session-ann-and-bob', UserId: ANN, UserName: 'Ann', DeviceName: 'Lounge', AdditionalUsers: [{ UserId: BOB, UserName: 'Bob' }] },
  { Id: 'session-nobody', UserId: '00000000000000000000000000000000', DeviceName: 'Bob laptop', AdditionalUsers: [] },
  { Id: 'session-anonymous', DeviceName: 'Somebody', AdditionalUsers: [] },
];
const GROUPS = { farmhouse: 'f0f0f0f0000000000000000000000001', mill: 'b1b1b1b1000000000000000000000002', mixed: 'c2c2c2c2000000000000000000000003', empty: 'e3e3e3e3000000000000000000000004' };
const NO_SUCH_GROUP = 'deadbeef00000000000000000000dead';
const syncPlayGroups = [
  { GroupId: GROUPS.farmhouse, GroupName: 'Alice\'s group', State: 'Idle', Participants: ['Alice', 'ann'], LastUpdatedAt: '2026-10-27T00:00:00Z' },
  { GroupId: GROUPS.mill, GroupName: 'Bob\'s group', State: 'Idle', Participants: ['Bob'], LastUpdatedAt: '2026-10-27T00:00:00Z' },
  { GroupId: GROUPS.mixed, GroupName: 'Alice\'s group', State: 'Playing', Participants: ['Alice', 'Bob'], LastUpdatedAt: '2026-10-27T00:00:00Z' },
  { GroupId: GROUPS.empty, GroupName: 'Outsider\'s group', State: 'Idle', Participants: [], LastUpdatedAt: '2026-10-27T00:00:00Z' },
];
const scopeWorld = () => world({ passwords, sessions, syncPlayGroups });

describe('household host user listings', { timeout: 60_000 }, () => {
  it('lists only the household\'s own members at GET /Users, in every spelling and with any filter, though Jellyfin lists everyone', async (t) => {
    const app = await startApp(t, scopeWorld());
    const direct = await get(new URL(app.jellyfin.url).port, '/Users', { Authorization: `${WEB}, Token="token-alice"` });
    assert.deepEqual(direct.json().map((user) => user.Id), [ALICE, ANN, BOB, CAROL, OUTSIDER, JELLYFIN_ADMIN], 'Jellyfin lists every user');
    for (const path of [...spellings('Users'), '/Users?isHidden=false', '/Users?isDisabled=false&isHidden=true']) {
      const answer = await get(app.port, path, as(HOST_A, 'token-alice'));
      assert.equal(answer.status, 200, path);
      assert.deepEqual(answer.json().map((user) => [user.Id, user.Name]), [[ALICE, 'Alice'], [ANN, 'Ann']], path);
      assert.equal(answer.headers['cache-control'], 'no-store', path);
    }
    // Jellyfin's own schema is kept for each member.
    assert.deepEqual(Object.keys((await get(app.port, '/Users', as(HOST_A, 'token-alice'))).json()[0]).sort(), ['Id', 'Name', 'Policy', 'ServerId']);
    const mill = await get(app.port, '/Users', as(HOST_B, 'token-bob'));
    assert.deepEqual(mill.json().map((user) => user.Id), [BOB]);
    // A user ID in its query must still be the caller's own.
    assert.deepEqual([(await get(app.port, `/Users?userId=${BOB}`, as(HOST_A, 'token-alice'))).text], [ITEM_NOT_FOUND]);
  });

  it('lists only sessions all of whose users are the household\'s members at GET /Sessions', async (t) => {
    const app = await startApp(t, scopeWorld());
    for (const path of [...spellings('Sessions'), `/Sessions?controllableByUserId=${ALICE}`, '/Sessions?activeWithinSeconds=960']) {
      const answer = await get(app.port, path, as(HOST_A, 'token-alice'));
      assert.equal(answer.status, 200, path);
      assert.deepEqual(answer.json().map((session) => session.Id), ['session-alice', 'session-ann-and-alice'], path);
    }
    assert.deepEqual((await get(app.port, '/Sessions', as(HOST_B, 'token-bob'))).json().map((session) => session.Id), ['session-bob']);
    assert.equal((await get(app.port, `/Sessions?controllableByUserId=${BOB}`, as(HOST_A, 'token-alice'))).text, ITEM_NOT_FOUND);
  });

  it('lists only SyncPlay groups all of whose participants are the household\'s members, and refuses any other group', async (t) => {
    const app = await startApp(t, scopeWorld());
    for (const path of [...spellings('SyncPlay/List')]) {
      const answer = await get(app.port, path, as(HOST_A, 'token-alice'));
      assert.equal(answer.status, 200, path);
      assert.deepEqual(answer.json(), [syncPlayGroups[0]], path);
    }
    assert.deepEqual((await get(app.port, '/SyncPlay/List', as(HOST_B, 'token-bob'))).json().map((group) => group.GroupId), [GROUPS.mill]);
    assert.deepEqual((await get(app.port, `/SyncPlay/${GROUPS.farmhouse}`, as(HOST_A, 'token-alice'))).json(), syncPlayGroups[0]);
    for (const id of [GROUPS.mill, GROUPS.mixed, GROUPS.empty, NO_SUCH_GROUP]) {
      const answer = await get(app.port, `/emby/syncplay/${id}`, as(HOST_A, 'token-alice'));
      assert.deepEqual([answer.status, answer.text], [404, ITEM_NOT_FOUND], id);
    }
  });

  it('fails closed when Jellyfin\'s listing is not one', async (t) => {
    const state = scopeWorld();
    state.sessions = { not: 'an array' };
    const app = await startApp(t, state);
    const answer = await get(app.port, '/Sessions', as(HOST_A, 'token-alice'));
    assert.deepEqual([answer.status, answer.text], [502, '{"error":"invalid_jellyfin_sessions"}']);
  });

  it('relays only a 200 listing, narrowed: any other answer gets a fixed one, never Jellyfin\'s body (Codex)', async (t) => {
    const state = scopeWorld();
    const app = await startApp(t, state);
    const bobUser = { Id: BOB, Name: 'Bob', ServerId: 'server' };
    const bobGroup = syncPlayGroups[1];
    const lists = [
      ['/Users', 'invalid_jellyfin_users', [bobUser]],
      ['/Sessions', 'invalid_jellyfin_sessions', [sessions[1]]],
      ['/SyncPlay/List', 'invalid_jellyfin_syncplay_groups', [bobGroup]],
      [`/SyncPlay/${GROUPS.mill}`, 'invalid_jellyfin_syncplay_group', bobGroup],
    ];
    for (const [path, invalid, bobs] of lists) {
      for (const [status, expected, headers] of [
        [201, [502, `{"error":"${invalid}"}`]],
        [203, [502, `{"error":"${invalid}"}`]],
        [302, [502, `{"error":"${invalid}"}`], { Location: '/elsewhere' }],
        [400, [400, '{"error":"jellyfin_refused"}']],
        [401, [401, NOT_A_MEMBER]],
        [403, [403, '{"error":"jellyfin_refused"}']],
        [404, [404, ITEM_NOT_FOUND]],
        [500, [502, '{"error":"jellyfin_unavailable"}']],
        [503, [502, '{"error":"jellyfin_unavailable"}']],
      ]) {
        state.listingAnswer = { status, body: bobs, headers };
        const answer = await get(app.port, path, as(HOST_A, 'token-alice'));
        assert.deepEqual([answer.status, answer.text], expected, `${path} ${status}`);
        assert.equal(answer.headers.location, undefined, `${path} ${status}`);
      }
    }
  });
});

describe('household host SyncPlay joins', { timeout: 60_000 }, () => {
  const join = (app, host, token, body) => get(app.port, '/SyncPlay/Join', { ...as(host, token), 'Content-Type': 'application/json' }, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  const joinsSent = (app) => app.jellyfin.requests.filter((request) => /^\/syncplay\/join$/i.test(request.pathname)).length;

  it('joins a member only to a group all of whose participants are the household\'s members (Codex)', async (t) => {
    const state = scopeWorld();
    const app = await startApp(t, state);
    const dashed = GROUPS.farmhouse.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5').toUpperCase();
    for (const body of [{ GroupId: GROUPS.farmhouse }, { GroupId: dashed }, { groupId: `{${dashed}}` }]) {
      const answer = await join(app, HOST_A, 'token-alice', body);
      assert.equal(answer.status, 204, JSON.stringify(body));
    }
    assert.deepEqual(state.syncPlayJoins, [ALICE, ALICE, ALICE].map((userId) => ({ userId, groupId: GROUPS.farmhouse })));
    // Jellyfin is sent the checked group alone, in one form.
    assert.ok(app.jellyfin.requests.filter((request) => /^\/syncplay\/join$/i.test(request.pathname)).every((request) => request.method === 'POST'));
    // Bob's own household joins him to his own group.
    assert.equal((await join(app, HOST_B, 'token-bob', { GroupId: GROUPS.mill })).status, 204);
    assert.equal(joinsSent(app), 4);
  });

  it('refuses any other group, and one Jellyfin does not have, with the same fixed 404, without asking Jellyfin to join it', async (t) => {
    const state = scopeWorld();
    const app = await startApp(t, state);
    for (const groupId of [GROUPS.mill, GROUPS.mixed, GROUPS.empty, NO_SUCH_GROUP]) {
      for (const path of ['/SyncPlay/Join', '/syncplay/join/', '/emby/SyncPlay/Join']) {
        const answer = await get(app.port, path, { ...as(HOST_A, 'token-alice'), 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify({ GroupId: groupId }) });
        assert.deepEqual([answer.status, answer.text], [404, ITEM_NOT_FOUND], `${groupId} ${path}`);
      }
    }
    assert.equal(joinsSent(app), 0);
    assert.deepEqual(state.syncPlayJoins, []);
  });

  it('refuses a join it cannot read as Jellyfin does, and another household\'s token, without asking Jellyfin', async (t) => {
    const state = scopeWorld();
    const app = await startApp(t, state);
    for (const body of ['not json', '[]', '{}', JSON.stringify({ GroupId: 42 }), JSON.stringify({ GroupId: 'farmhouse' }),
      JSON.stringify({ GroupId: GROUPS.mill, groupid: GROUPS.farmhouse }),
      JSON.stringify({ GroupId: `{${GROUPS.farmhouse}` })]) {
      const answer = await join(app, HOST_A, 'token-alice', body);
      assert.deepEqual([answer.status, answer.text], [400, '{"error":"invalid_request"}'], body);
    }
    // A repeated key is read as Jellyfin reads it, the last one, and only the group checked is sent on.
    assert.equal((await join(app, HOST_A, 'token-alice', `{"GroupId":"${GROUPS.farmhouse}","GroupId":"${GROUPS.mill}"}`)).text, ITEM_NOT_FOUND);
    for (const token of ['token-bob', 'no-such-token']) {
      assert.deepEqual((await join(app, HOST_A, token, { GroupId: GROUPS.farmhouse })).text, NOT_A_MEMBER, token);
    }
    assert.equal(joinsSent(app), 0);
    assert.deepEqual(state.syncPlayJoins, []);
  });
});

describe('household host tokens', { timeout: 60_000 }, () => {
  /** Every way Jellyfin 10.11 takes a token, for `token`, on GET `pathname`. */
  const carriers = (pathname, token) => {
    const query = (parameter) => `${pathname}${pathname.includes('?') ? '&' : '?'}${parameter}`;
    return [
    [pathname, { Authorization: `${WEB}, Token="${token}"` }],
    [pathname, { 'X-Emby-Authorization': `Emby Token="${token}"` }],
    [pathname, { 'X-Emby-Token': token }],
    [pathname, { 'X-MediaBrowser-Token': token }],
    [query(`api_key=${token}`), {}],
    [query(`ApiKey=${token}`), {}],
    [query(`API_KEY=${token}`), {}],
    [query(`access_token=${token}`), {}],
    // Jellyfin re-reads a query of one encoded key as the query.
    ...(pathname.includes('?') ? [] : [[`${pathname}?api_key%3D${token}`, {}]]),
    ];
  };
  const ordinary = ['/System/Info', '/Items?Recursive=true', '/UserViews', '/Shows/NextUp', '/DisplayPreferences/usersettings', '/web/index.html', `/Users/${BOB}/Images/Primary`];

  it('refuses another household\'s member, an outsider and an unknown token alike on every relayed route, without relaying it', async (t) => {
    const app = await startApp(t, scopeWorld());
    const first = await get(app.port, '/System/Info', as(HOST_A, 'token-bob'));
    assert.deepEqual([first.status, first.text], [401, NOT_A_MEMBER]);
    for (const token of ['token-bob', 'token-outsider', 'no-such-token']) {
      for (const pathname of ordinary) {
        for (const [path, headers] of carriers(pathname, token)) {
          const answer = await get(app.port, path, { Host: HOST_A, ...headers });
          assert.deepEqual([answer.status, answer.text], [401, NOT_A_MEMBER], `${token} ${path} ${JSON.stringify(headers)}`);
          assert.deepEqual([answer.headers['content-type'], answer.headers['cache-control']], [first.headers['content-type'], first.headers['cache-control']]);
        }
      }
      for (const [method, path] of [['POST', '/Sessions/Playing'], ['POST', '/Sessions/Capabilities/Full'], ['DELETE', '/Videos/ActiveEncodings']]) {
        const answer = await get(app.port, path, as(HOST_A, token), { method });
        assert.deepEqual([answer.status, answer.text], [401, NOT_A_MEMBER], `${token} ${method} ${path}`);
      }
      // Routes that name an item or a user keep their own fixed answer, the same for each of them.
      for (const path of [`/Users/${BOB}/Views`, `/Items/${ITEMS.ownMovie}/PlaybackInfo`, `/Videos/${ITEMS.ownMovie}/stream`]) {
        const answer = await get(app.port, path, as(HOST_A, token));
        assert.deepEqual([answer.status, answer.text], [404, ITEM_NOT_FOUND], `${token} ${path}`);
      }
      // And so do the listings.
      for (const path of ['/Users', '/Sessions', '/SyncPlay/List']) {
        assert.deepEqual((await get(app.port, path, as(HOST_A, token))).text, NOT_A_MEMBER, `${token} ${path}`);
      }
    }
    assert.deepEqual(relayed(app), [], 'a non-member\'s call reached Jellyfin');
    // Bob's token still works on his own household's host.
    assert.notEqual((await get(app.port, '/System/Info', as(HOST_B, 'token-bob'))).text, NOT_A_MEMBER);
    assert.deepEqual(relayed(app).map((request) => request.pathname), ['/System/Info']);
  });

  it('still relays a member\'s token in every form Jellyfin takes it, and calls with no token at all', async (t) => {
    const app = await startApp(t, scopeWorld());
    for (const pathname of ordinary.filter((path) => path !== `/Users/${BOB}/Images/Primary`)) {
      for (const [path, headers] of carriers(pathname, 'token-alice')) {
        const before = relayed(app).length;
        const answer = await get(app.port, path, { Host: HOST_A, ...headers });
        assert.notEqual(answer.text, NOT_A_MEMBER, `${path} ${JSON.stringify(headers)}`);
        assert.equal(relayed(app).length, before + 1, `${path} ${JSON.stringify(headers)}`);
      }
    }
    for (const path of ['/System/Info/Public', '/web/index.html', `/Users/${ALICE}/Images/Primary`]) {
      const before = relayed(app).length;
      await get(app.port, path, { Host: HOST_A, Authorization: WEB });
      assert.equal(relayed(app).length, before + 1, path);
    }
  });

  it('answers the sign-in screen\'s calls whatever token they carry, as Jellyfin does', async (t) => {
    const app = await startApp(t, scopeWorld());
    for (const token of ['token-bob', 'no-such-token']) {
      const picker = await get(app.port, '/Users/Public', as(HOST_A, token));
      assert.deepEqual(picker.json().map((user) => user.Id), [ALICE, ANN]);
      assert.equal((await get(app.port, '/Branding/Configuration', as(HOST_A, token))).status, 200);
      const signIn = await post(app.port, '/Users/AuthenticateByName', as(HOST_A, token), { Username: 'Alice', Pw: 'alice-pass' });
      assert.equal(signIn.status, 200, signIn.text);
    }
  });

  it('refuses a WebSocket with a non-member\'s token before it reaches Jellyfin, and relays a member\'s', async (t) => {
    const app = await startApp(t, scopeWorld());
    for (const token of ['token-bob', 'token-outsider', 'no-such-token']) {
      for (const path of [`/socket?api_key=${token}&deviceId=x`, `/emby/socket?ApiKey=${token}`]) {
        assert.match(await upgrade(app.port, path, HOST_A), /^HTTP\/1\.1 401 /, `${token} ${path}`);
      }
      assert.match(await upgrade(app.port, '/socket', HOST_A, { 'X-Emby-Token': token }), /^HTTP\/1\.1 401 /, token);
    }
    assert.deepEqual(relayed(app), []);
    await upgrade(app.port, '/socket?api_key=token-alice&deviceId=x', HOST_A);
    await upgrade(app.port, '/socket?api_key=token-bob&deviceId=x', HOST_B);
    assert.deepEqual(relayed(app).map((request) => request.pathname), ['/socket', '/socket']);
  });

  it('checks a token with Jellyfin once a minute at most, membership on every call, and afresh after a sign-out', async (t) => {
    const app = await startApp(t, scopeWorld());
    const { AccessToken } = (await post(app.port, '/Users/AuthenticateByName', { Host: HOST_A, Authorization: WEB }, { Username: 'Alice', Pw: 'alice-pass' })).json();
    const alice = as(HOST_A, AccessToken);
    for (let call = 0; call < 5; call += 1) assert.notEqual((await get(app.port, '/System/Info', alice)).text, NOT_A_MEMBER);
    assert.equal(verifications(app), 1);
    // Another household's host: the same token, known to be Alice's, is refused without asking Jellyfin again.
    assert.equal((await get(app.port, '/System/Info', { ...alice, Host: HOST_B })).text, NOT_A_MEMBER);
    assert.equal(verifications(app), 1);
    // Taken out of the household, she is refused at once.
    await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [ANN] });
    assert.equal((await get(app.port, '/System/Info', alice)).text, NOT_A_MEMBER);
    await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN] });
    assert.notEqual((await get(app.port, '/System/Info', alice)).text, NOT_A_MEMBER);
    assert.equal(verifications(app), 1);
    // A sign-out through the household host forgets the token: Jellyfin is asked again, and now refuses it.
    assert.equal((await post(app.port, '/Sessions/Logout', alice, undefined)).status, 204);
    assert.equal((await get(app.port, '/System/Info', alice)).text, NOT_A_MEMBER);
    assert.equal(verifications(app), 2);
  });

  it('refuses a sign-out with another household\'s, an outsider\'s or an unknown token alike, revoking nothing (Codex)', async (t) => {
    const app = await startApp(t, scopeWorld());
    const signIn = async (host, Username, Pw) => (await post(app.port, '/Users/AuthenticateByName', { Host: host, Authorization: WEB }, { Username, Pw })).json().AccessToken;
    const bob = await signIn(HOST_B, 'Bob', 'bob-pass');
    assert.notEqual((await get(app.port, '/System/Info', as(HOST_B, bob))).text, NOT_A_MEMBER);
    const unknown = await post(app.port, '/Sessions/Logout', as(HOST_A, 'no-such-token'), undefined);
    assert.deepEqual([unknown.status, unknown.text], [401, NOT_A_MEMBER]);
    for (const headers of [as(HOST_A, bob), { Host: HOST_A, 'X-Emby-Token': bob }, as(HOST_A, 'token-bob'), as(HOST_A, 'token-outsider'), { Host: HOST_A, Authorization: WEB }]) {
      const answer = await post(app.port, '/Sessions/Logout', headers, undefined);
      assert.deepEqual([answer.status, answer.text, answer.headers['content-type'], answer.headers['cache-control']],
        [unknown.status, unknown.text, unknown.headers['content-type'], unknown.headers['cache-control']], JSON.stringify(headers));
    }
    assert.deepEqual(app.jellyfin.logouts, []);
    assert.equal(app.jellyfin.requests.filter((request) => request.pathname === '/Sessions/Logout').length, 0, 'a sign-out reached Jellyfin');
    // Bob's token still works on his own household's host, and his own sign-out there still revokes it.
    assert.notEqual((await get(app.port, '/System/Info', as(HOST_B, bob))).text, NOT_A_MEMBER);
    assert.equal((await post(app.port, '/Sessions/Logout', as(HOST_B, bob), undefined)).status, 204);
    assert.deepEqual(app.jellyfin.logouts, [bob]);
    assert.equal((await get(app.port, '/System/Info', as(HOST_B, bob))).text, NOT_A_MEMBER);
  });

  it('answers 502 without relaying the call when Jellyfin cannot say whose a token is', async (t) => {
    const app = await startApp(t, scopeWorld());
    app.jellyfin.down = true;
    const answer = await get(app.port, '/System/Info', as(HOST_A, 'token-alice'));
    assert.deepEqual([answer.status, answer.text], [502, '{"error":"jellyfin_unavailable"}']);
    assert.match(await upgrade(app.port, '/socket?api_key=token-alice', HOST_A), /^HTTP\/1\.1 502 /);
    app.jellyfin.down = false;
    assert.notEqual((await get(app.port, '/System/Info', as(HOST_A, 'token-alice'))).text, NOT_A_MEMBER, 'a failed check is not kept');
  });

  it('leaves the main Jellyfin hostname alone: it is no household\'s', () => {
    const gateway = new HouseholdGateway({ jellyfinUrl: 'http://127.0.0.1:8096', domain: 'starrgroup.io', hostPrefix: 'jelly-', memberIds: () => [] });
    assert.equal(gateway.householdId('jelly.starrgroup.io'), undefined);
    assert.equal(gateway.householdId('jelly.starrgroup.io:443'), undefined);
    assert.equal(gateway.householdId('jelly-farmhouse.starrgroup.io'), 'farmhouse');
  });
});

function upgrade(port, pathname, host, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answer = '';
    const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    socket.once('connect', () => socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
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
