import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { AccessService, accessTag } from '../dist/access-service.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { makeServer } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { createSignInApi, SignInError } from '../dist/app-js/api.js';
import { clearSignIn, deviceId, jellyfinToken, storeSignIn } from '../dist/app-js/session.js';
import { OWN_MOVIE, REQUEST, TMDB_KEY, createFakeSeerr, createFakeTmdb, get as getWithHeaders, post as postWithHeaders, world } from './support/household-app.mjs';
import { SeerrClient } from '../dist/seerr.js';
import { SeerrUserMap } from '../dist/seerr-users.js';
import { TmdbClient } from '../dist/tmdb.js';
import { makeTempDir } from './support/temp-dir.mjs';

const baseUrl = process.env.JELLYFIN_REAL_URL;
const webhookToken = 'real-webhook-secret';

describe('real Jellyfin integration', { timeout: 150_000, skip: !baseUrl }, () => {
  let fixture;
  let client;
  let store;
  let server;

  before(async () => {
    fixture = await setupJellyfin(baseUrl);
    store = new GrantStore(path.join(await makeTempDir(null, 'jfa-real-'), 'grants.json'));
    await store.load();
    client = new JellyfinClient(baseUrl, fixture.token);
    // No Seerr client: webhooks must carry an HD event to be trusted.
    server = makeServer(new AccessService(client, store), { webhook: webhookToken, admin: 'real-admin-secret' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  const available = (requestId, event) => ({
    notificationType: 'MEDIA_AVAILABLE',
    ...(event === undefined ? {} : { event }),
    media: { jellyfinMediaId: fixture.itemId, mediaType: 'movie' },
    request: { id: requestId, requestedBy: { jellyfinUserId: fixture.aliceId } },
  });

  it('rejects a Seerr-less webhook without a recognised HD event and grants nothing', async () => {
    for (const [requestId, event] of [['real-16', undefined], ['real-16b', 'Something Else']]) {
      assert.deepEqual(await sendWebhook(server, available(requestId, event)), {
        status: 502,
        body: { error: 'webhook event does not name an HD request and Seerr lookup is not configured' },
      }, String(event));
    }

    assert.equal(store.get(fixture.itemId), undefined);
    const item = await client.getItem(fixture.itemId);
    const users = await client.getUsers();
    assert.ok(!item.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(users, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
  });

  it('answers an unknown item ID with a 404, the only status JellyPass treats as a deleted item', async () => {
    const unknownId = randomUUID().replaceAll('-', '');
    await assert.rejects(client.getItem(unknownId), (error) => error.status === 404);
  });

  it('reads one user with the API key and answers a missing one with a 404, as the admin session re-check expects', async () => {
    const bob = await client.getUser(fixture.bobId);
    assert.equal(bob.Id, fixture.bobId);
    assert.equal(typeof bob.Policy.IsAdministrator, 'boolean');
    assert.equal(typeof bob.Policy.IsDisabled, 'boolean');
    await assert.rejects(client.getUser(randomUUID().replaceAll('-', '')), (error) => error.status === 404);
  });

  it('grants and revokes access on Jellyfin for an HD Now Available webhook', async () => {
    const granted = await sendWebhook(server, available('real-17', 'Movie Request Now Available'));
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.status, 'granted');
    assert.ok(store.get(fixture.itemId));

    const taggedItem = await client.getItem(fixture.itemId);
    const grantedUsers = await client.getUsers();
    assert.ok(taggedItem.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(user(grantedUsers, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(grantedUsers, fixture.aliceId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));

    const revoked = await fetch(`${serverUrl(server)}/v1/grants/${fixture.itemId}/requests/real-17`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer real-admin-secret' },
    });
    assert.ok(revoked.ok, await revoked.text());
    const cleanedItem = await client.getItem(fixture.itemId);
    const cleanedUsers = await client.getUsers();
    assert.ok(!cleanedItem.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(cleanedUsers, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
  });

  it('lets a signed-in user add a household title to their library, checking their token with Jellyfin', async (t) => {
    // Alice's household requested the movie; Bob belongs to no household and signs in on Jellyfin itself.
    const joinStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-join-'), 'grants.json'));
    await joinStore.load();
    await joinStore.upsertGroup({ id: 'realhouse', name: 'Real House', userIds: [fixture.aliceId] });
    const seerr = { getJellyfinItemId: async (mediaType, tmdbId) => (mediaType === 'movie' && tmdbId === 603 ? fixture.itemId : undefined) };
    const service = new AccessService(client, joinStore, undefined, seerr);
    const gateway = makeServer(service, { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: baseUrl, domain: 'example.test', hostPrefix: 'jelly-' },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const granted = await sendWebhook(gateway, available('real-18', 'Movie Request Now Available'));
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.ok(user(await client.getUsers(), fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));

    const join = (authorization) => postWithHost(gateway, '/jellypass/add', 'jelly-realhouse.example.test', authorization, { mediaType: 'movie', tmdbId: 603 });
    assert.equal((await join(undefined)).status, 401);
    assert.equal((await join('MediaBrowser Client="jfa-test", Device="ci", DeviceId="jfa-real-join", Version="1.0", Token="not-a-token"')).status, 401);
    assert.equal(joinStore.get(fixture.itemId).joins, undefined);

    const bob = await request(baseUrl, '/Users/AuthenticateByName', {
      method: 'POST',
      authorization: 'MediaBrowser Client="jfa-test", Device="ci", DeviceId="jfa-real-bob", Version="1.0"',
      body: { Username: 'Bob', Pw: '' },
    });
    // The page sends only the token, as Jellyfin web stored it, so Jellyfin does not rename the user's web session.
    const accepted = await join(`MediaBrowser Token="${bob.AccessToken}"`);
    assert.deepEqual(accepted, { status: 202, body: { status: 'accepted' } });
    // The join runs after the answer.
    await waitFor(async () => joinStore.get(fixture.itemId).manualUserIds.includes(fixture.bobId.toLowerCase()));
    assert.deepEqual(joinStore.get(fixture.itemId).manualUserIds, [fixture.bobId.toLowerCase()]);
    await waitFor(async () => !user(await client.getUsers(), fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
    const item = await request(baseUrl, `/Users/${fixture.bobId}/Items/${fixture.itemId}`, { token: bob.AccessToken });
    assert.equal(item.Id, fixture.itemId);
  });

  it('shows a household app title in_library only when the caller\'s own Jellyfin view has it', async (t) => {
    // The movie gets a TMDB ID the fake TMDB knows; Bob's household is the only one here.
    const original = await client.getItem(fixture.itemId);
    await client.updateItem({ ...original, ProviderIds: { ...original.ProviderIds, Tmdb: String(OWN_MOVIE) }, Tags: [...original.Tags, 'jp-app-hidden'] });
    t.after(() => client.updateItem({ ...original }));
    const originalBob = user(await client.getUsers(), fixture.bobId);
    t.after(() => client.updatePolicy(fixture.bobId, originalBob.Policy));
    const setBob = (changes) => client.updatePolicy(fixture.bobId, { ...originalBob.Policy, BlockedTags: [], ...changes });

    const appStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-app-'), 'grants.json'));
    await appStore.load();
    await appStore.upsertGroup({ id: 'apphouse', name: 'App House', userIds: [fixture.bobId] });
    const state = world({ seerrUsers: { 61: { jellyfinUserId: fixture.bobId.replaceAll('-', '').toLowerCase(), permissions: REQUEST } } });
    const seerr = await createFakeSeerr(state);
    const tmdb = await createFakeTmdb(state);
    t.after(() => Promise.all([seerr.close(), tmdb.close()]));
    const admin = new SeerrClient(seerr.url, 'seerr-key');
    const gateway = makeServer(new AccessService(client, appStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: baseUrl, domain: 'example.test', hostPrefix: 'jelly-' },
      householdApp: {
        catalogue: new TmdbClient(TMDB_KEY, { baseUrl: tmdb.url }),
        blocklist: admin,
        members: new SeerrUserMap(admin),
        libraryTtlMs: 0,
        blocklistTtlMs: 0,
      },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const bob = await request(baseUrl, '/Users/AuthenticateByName', {
      method: 'POST',
      authorization: 'MediaBrowser Client="jfa-test", Device="ci", DeviceId="jfa-real-app", Version="1.0"',
      body: { Username: 'Bob', Pw: '' },
    });
    // The app's page is served from the household host with no sign-in, and the sign-in the app sends (Jellyfin web's own
    // token, as the only part of the Authorization header) is accepted by the real Jellyfin.
    const host = { Host: 'jelly-apphouse.example.test' };
    const shell = await getWithHeaders(gateway.address().port, '/jellypass/app/', host);
    assert.equal(shell.status, 200);
    assert.equal(shell.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(shell.headers['content-security-policy'], /^default-src 'none'; script-src 'self'; /);
    assert.match(shell.text, /<title>JellyPass<\/title>/);
    // The page names its files by content-hashed address; each is served, and so is the worker.
    const assets = [...shell.text.matchAll(/(?:href|src)="([^"#]+)"/g)].map((match) => match[1]).filter((asset) => !/^(?:https?:)?\/\//.test(asset));
    assert.ok(assets.length >= 5);
    for (const asset of [...assets, 'sw.js']) {
      assert.equal((await getWithHeaders(gateway.address().port, `/jellypass/app/${asset}`, host)).status, 200, asset);
    }
    const adminHost = await getWithHeaders(gateway.address().port, '/jellypass/app/', { Host: 'jellypass.example.test' });
    assert.notEqual(adminHost.status, 200);
    const me = await getWithHeaders(gateway.address().port, '/jellypass/app/v1/me', { ...host, Authorization: `MediaBrowser Token="${bob.AccessToken}"` });
    assert.deepEqual(me.json(), { name: 'Bob', household: 'App House', apiVersion: 2 });

    const movie = async () => {
      const answer = await getWithHeaders(gateway.address().port, `/jellypass/app/v1/movie/${OWN_MOVIE}`, {
        Host: 'jelly-apphouse.example.test',
        Authorization: `MediaBrowser Token="${bob.AccessToken}"`,
      });
      assert.equal(answer.status, 200, answer.text);
      return answer.json();
    };

    await setBob({});
    const itemId = fixture.itemId.replaceAll('-', '').toLowerCase();
    assert.deepEqual(await movie(), {
      ...(await movie()),
      state: 'in_library',
      play: { itemId, url: `https://jelly-apphouse.example.test/web/#/details?id=${itemId}` },
    });
    // A tag Bob is blocked from hides it, as JellyPass grants do.
    await setBob({ BlockedTags: ['jp-app-hidden'] });
    assert.deepEqual([(await movie()).state, (await movie()).play], ['get_this', null]);
    // So does a parental rating above Bob's limit.
    await client.updateItem({ ...(await client.getItem(fixture.itemId)), OfficialRating: 'R' });
    await setBob({ MaxParentalRating: 10 });
    assert.equal((await movie()).state, 'get_this');
    await setBob({});
    assert.equal((await movie()).state, 'in_library');
    // Bob's own playable item needs no request permission, and stays playable once blocklisted; hidden, it is
    // unavailable to him.
    state.seerrUsers[61].permissions = 0;
    state.blocklist.push({ mediaType: 'movie', tmdbId: OWN_MOVIE });
    assert.equal((await movie()).state, 'in_library');
    await setBob({ BlockedTags: ['jp-app-hidden'] });
    assert.deepEqual([(await movie()).state, (await movie()).play], ['unavailable', null]);
    assert.deepEqual(seerr.violations, []);
  });

  it('signs in through the app\'s own flow on the household host, stores it where Jellyfin web does, and then loads /me', async (t) => {
    // Bob is the only member of this household; Alice signs in on Jellyfin itself, and the admin is in no household. Jellyfin
    // 10.11 hides new users from its public list (the profile picker) until the owner shows them, as a household's owner has.
    const originalBob = user(await client.getUsers(), fixture.bobId);
    t.after(() => client.updatePolicy(fixture.bobId, originalBob.Policy));
    await client.updatePolicy(fixture.bobId, { ...originalBob.Policy, IsHidden: false });
    const appStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-signin-'), 'grants.json'));
    await appStore.load();
    await appStore.upsertGroup({ id: 'signinhouse', name: 'Sign-in House', userIds: [fixture.bobId] });
    const state = world({ seerrUsers: { 61: { jellyfinUserId: fixture.bobId.replaceAll('-', '').toLowerCase(), permissions: REQUEST } } });
    const seerr = await createFakeSeerr(state);
    const tmdb = await createFakeTmdb(state);
    t.after(() => Promise.all([seerr.close(), tmdb.close()]));
    const admin = new SeerrClient(seerr.url, 'seerr-key');
    const gateway = makeServer(new AccessService(client, appStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: baseUrl, domain: 'example.test', hostPrefix: 'jelly-' },
      householdApp: {
        catalogue: new TmdbClient(TMDB_KEY, { baseUrl: tmdb.url }),
        blocklist: admin,
        members: new SeerrUserMap(admin),
      },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const port = gateway.address().port;
    const host = 'jelly-signinhouse.example.test';
    const origin = `https://${host}`;

    // The page's calls, as the browser makes them: same-origin paths, answered by the gateway for this household's host.
    const asPage = async (pathname, init = {}) => {
      const answer = init.method === 'POST'
        ? await postWithHeaders(port, pathname, { Host: host, ...init.headers }, init.body ? JSON.parse(init.body) : undefined)
        : await getWithHeaders(port, pathname, { Host: host, ...init.headers });
      return new Response([204, 304].includes(answer.status) ? null : answer.body, { status: answer.status, headers: answer.headers });
    };
    const storage = (() => {
      const items = new Map();
      return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
    })();
    const api = createSignInApi({ fetch: asPage, deviceId: () => deviceId(storage), deviceName: 'iPhone' });

    // The picker: this household's members only, as the gateway lists them; Alice and the admin are not on it.
    const profiles = await api.profiles();
    assert.deepEqual(profiles.map((profile) => profile.name), ['Bob']);
    assert.equal(profiles[0].id.replaceAll('-', '').toLowerCase(), fixture.bobId.replaceAll('-', '').toLowerCase());

    // Signing in is Jellyfin web's own call with the app's device ID and headers; Jellyfin accepts it.
    const result = await api.signIn('Bob', '');
    const info = await request(baseUrl, '/System/Info/Public');
    assert.equal(result.serverId, info.Id);
    assert.equal(result.userId.replaceAll('-', '').toLowerCase(), fixture.bobId.replaceAll('-', '').toLowerCase());
    assert.equal(storeSignIn(storage, origin, { serverId: result.serverId, userId: result.userId, token: result.token }), true);
    assert.equal(jellyfinToken(storage, origin), result.token);
    const stored = JSON.parse(storage.items.get('jellyfin_credentials')).Servers;
    assert.deepEqual(stored.map(({ DateLastAccessed, ...entry }) => entry), [
      { Id: info.Id, ManualAddress: origin, LastConnectionMode: 2, UserId: result.userId, AccessToken: result.token },
    ]);
    // Jellyfin recorded the session as the app's own device, which is not Jellyfin web's.
    const devices = await request(baseUrl, '/Devices', { token: fixture.token });
    const device = devices.Items.find((entry) => entry.Id === storage.items.get('jellypass_device_id'));
    assert.ok(device, 'the app\'s device is listed');
    assert.deepEqual([device.AppName, device.Name], ['JellyPass', 'iPhone']);

    // The app then calls /me with that token, and nothing else, and is the household's member.
    const me = await getWithHeaders(port, '/jellypass/app/v1/me', { Host: host, Authorization: `MediaBrowser Token="${jellyfinToken(storage, origin)}"` });
    assert.deepEqual(me.json(), { name: 'Bob', household: 'Sign-in House', apiVersion: 2 });

    // Another household's user, and the administrator, cannot sign in on this host; Jellyfin is never asked to.
    for (const name of ['Alice', 'admin']) {
      await assert.rejects(api.signIn(name, name === 'admin' ? 'test-password' : ''), (error) => error instanceof SignInError && error.kind === 'invalid');
    }

    // Signing out revokes the token at Jellyfin and takes it out of storage, and the app API forgets it at once.
    await api.signOut(result.token);
    assert.equal((await fetch(`${baseUrl}/Users/Me`, { headers: { Authorization: `MediaBrowser Token="${result.token}"` } })).status, 401);
    const after = await getWithHeaders(port, '/jellypass/app/v1/me', { Host: host, Authorization: `MediaBrowser Token="${result.token}"` });
    assert.deepEqual([after.status, after.text], [401, '{"error":"unauthorized"}']);
    assert.equal(clearSignIn(storage, origin), true);
    assert.equal(jellyfinToken(storage, origin), undefined);
  });

  it('signs in a hidden member by name, from the app and as Jellyfin web does, and refuses any other name as a wrong password', async (t) => {
    // Hilda is hidden at Jellyfin (left off its public list, so off the picker) and has a password; Bob, shown, is the
    // household's other member. Alice is in no household here, and the admin is in none.
    const hilda = await request(baseUrl, '/Users/New', { method: 'POST', token: fixture.token, body: { Name: 'Hilda', Password: 'hilda-pass' } });
    t.after(() => request(baseUrl, `/Users/${hilda.Id}`, { method: 'DELETE', token: fixture.token }));
    await client.updatePolicy(hilda.Id, { ...user(await client.getUsers(), hilda.Id).Policy, IsHidden: true });
    const originalBob = user(await client.getUsers(), fixture.bobId);
    t.after(() => client.updatePolicy(fixture.bobId, originalBob.Policy));
    await client.updatePolicy(fixture.bobId, { ...originalBob.Policy, IsHidden: false });
    const appStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-hidden-'), 'grants.json'));
    await appStore.load();
    await appStore.upsertGroup({ id: 'hiddenhouse', name: 'Hidden House', userIds: [fixture.bobId, hilda.Id] });
    const state = world();
    const seerr = await createFakeSeerr(state);
    const tmdb = await createFakeTmdb(state);
    t.after(() => Promise.all([seerr.close(), tmdb.close()]));
    const admin = new SeerrClient(seerr.url, 'seerr-key');
    const DELAY = 200;
    const gateway = makeServer(new AccessService(client, appStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: baseUrl, domain: 'example.test', hostPrefix: 'jelly-', loginFailureDelayMs: DELAY },
      householdApp: {
        catalogue: new TmdbClient(TMDB_KEY, { baseUrl: tmdb.url }),
        blocklist: admin,
        members: new SeerrUserMap(admin),
      },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const port = gateway.address().port;
    const host = 'jelly-hiddenhouse.example.test';
    const asPage = async (pathname, init = {}) => {
      const answer = init.method === 'POST'
        ? await postWithHeaders(port, pathname, { Host: host, ...init.headers }, init.body ? JSON.parse(init.body) : undefined)
        : await getWithHeaders(port, pathname, { Host: host, ...init.headers });
      return new Response([204, 304].includes(answer.status) ? null : answer.body, { status: answer.status, headers: answer.headers });
    };
    const storage = (() => {
      const items = new Map();
      return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
    })();
    const api = createSignInApi({ fetch: asPage, deviceId: () => deviceId(storage), deviceName: 'iPhone' });
    const same = (id) => id.replaceAll('-', '').toLowerCase();

    // Jellyfin itself leaves Hilda off its public list, and so the picker does.
    assert.deepEqual((await api.profiles()).map((profile) => profile.name), ['Bob']);

    // Typed in the app, in any case, she signs in, and the token is what the app API accepts.
    const result = await api.signIn('hilda', 'hilda-pass');
    assert.equal(same(result.userId), same(hilda.Id));
    const me = await getWithHeaders(port, '/jellypass/app/v1/me', { Host: host, Authorization: `MediaBrowser Token="${result.token}"` });
    assert.deepEqual(me.json(), { name: 'Hilda', household: 'Hidden House', apiVersion: 2 });
    await api.signOut(result.token);
    assert.equal((await getWithHeaders(port, '/jellypass/app/v1/me', { Host: host, Authorization: `MediaBrowser Token="${result.token}"` })).status, 401);

    // Jellyfin web's own manual login on the household host signs her in too.
    const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-real-hidden-web", Version="10.11.3"';
    const web = (username, password) => postWithHeaders(port, '/Users/AuthenticateByName', { Host: host, Authorization: WEB }, { Username: username, Pw: password });
    const signedIn = await web('Hilda', 'hilda-pass');
    assert.equal(signedIn.status, 200);
    assert.equal(same(signedIn.json().User.Id), same(hilda.Id));
    // Signed in on the app with that token, then out as Jellyfin web signs out, through the household host: forgotten at once.
    const webToken = { Host: host, Authorization: `MediaBrowser Token="${signedIn.json().AccessToken}"` };
    assert.equal((await getWithHeaders(port, '/jellypass/app/v1/me', webToken)).status, 200);
    assert.equal((await postWithHeaders(port, '/Sessions/Logout', { Host: host, Authorization: `${WEB}, Token="${signedIn.json().AccessToken}"` }, undefined)).status, 204);
    assert.equal((await getWithHeaders(port, '/jellypass/app/v1/me', webToken)).status, 401);

    // A wrong password, and any name that is not this household's member's, get one and the same answer, never sooner than DELAY.
    const seen = (answer) => ({ status: answer.status, text: answer.text, headers: { ...answer.headers, date: undefined } });
    const timed = async (username, password) => {
      const started = performance.now();
      const answer = seen(await web(username, password));
      const ms = performance.now() - started;
      assert.ok(ms >= DELAY - 5, `${username}: ${ms} ms`);
      return answer;
    };
    const wrongPassword = await timed('Hilda', 'wrong');
    assert.deepEqual([wrongPassword.status, wrongPassword.text], [401, '{"error":"invalid_credentials"}']);
    for (const [username, password] of [['Alice', ''], ['admin', 'test-password'], ['nobody', 'x'], ['Bob', 'wrong']]) {
      assert.deepEqual(await timed(username, password), wrongPassword, username);
    }
    await assert.rejects(api.signIn('admin', 'test-password'), (error) => error instanceof SignInError && error.kind === 'invalid');

    // A sign-in Jellyfin would refuse whoever it named (here with a 400, for a request naming no client) is answered alike
    // for a member and for any other name, and no sooner either: Codex had Hilda's answered in 20 ms, nobody's in 1 s.
    const malformed = async (headers, body) => {
      const answers = [];
      for (const username of ['Hilda', 'nobody']) {
        const started = performance.now();
        answers.push(seen(await postWithHeaders(port, '/Users/AuthenticateByName', { Host: host, ...headers }, body(username))));
        const ms = performance.now() - started;
        assert.ok(ms >= DELAY - 5, `${username}: ${ms} ms`);
      }
      assert.deepEqual(answers[0], answers[1]);
      return answers[0];
    };
    const noClient = await malformed({}, (username) => ({ Username: username, Pw: 'wrong' }));
    assert.deepEqual([noClient.status, noClient.text], [400, '{"error":"invalid_request"}']);
    assert.deepEqual(await malformed({ Authorization: 'MediaBrowser Token="x"' }, (username) => ({ Username: username, Pw: 'wrong' })), noClient);
    assert.deepEqual(await malformed({ Authorization: WEB }, (username) => ({ Username: username })), noClient);
  });

  it('keeps Quick Connect, Streamyfin and Jellyfin Enhanced\'s Seerr, reviews and provider lookup off a household host, though Jellyfin itself offers Quick Connect', async (t) => {
    const configuration = await request(baseUrl, '/System/Configuration', { token: fixture.token });
    t.after(() => request(baseUrl, '/System/Configuration', { method: 'POST', token: fixture.token, body: configuration }));
    await request(baseUrl, '/System/Configuration', { method: 'POST', token: fixture.token, body: { ...configuration, QuickConnectAvailable: true } });
    const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-real-quick-connect", Version="10.11.3"';
    // At Jellyfin itself Quick Connect is on and hands out a code, by every route it takes: Jellyfin 10.11 by the legacy
    // prefix too, Jellyfin 12 (which no longer routes it) by the plain path only. The household host refuses every
    // spelling on both.
    assert.equal(await request(baseUrl, '/QuickConnect/Enabled'), true);
    assert.match((await request(baseUrl, '/QuickConnect/Initiate', { method: 'POST', authorization: WEB })).Code, /^\d+$/);
    const legacyInitiate = await postWithHeaders(new URL(baseUrl).port, '/emby/QuickConnect/Initiate', { Host: new URL(baseUrl).host, Authorization: WEB }, {});
    if (fixture.major < 12) assert.match(legacyInitiate.json().Code, /^\d+$/, legacyInitiate.text);
    else assert.equal(legacyInitiate.status, 404, 'Jellyfin 12 routes /emby/ again: check the household host still refuses it');

    const householdStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-quick-connect-'), 'grants.json'));
    await householdStore.load();
    await householdStore.upsertGroup({ id: 'quickhouse', name: 'Quick House', userIds: [fixture.bobId] });
    const gateway = makeServer(new AccessService(client, householdStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: baseUrl, domain: 'example.test', hostPrefix: 'jelly-' },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const port = gateway.address().port;
    const host = { Host: 'jelly-quickhouse.example.test', Authorization: WEB };
    for (const pathname of ['/QuickConnect/Enabled', '/emby/QuickConnect/Enabled/', '/QuickConnect/%45nabled']) {
      const answer = await getWithHeaders(port, pathname, host);
      assert.deepEqual([answer.status, answer.text], [200, 'false'], pathname);
    }
    for (const pathname of ['/QuickConnect/Initiate', '/emby/QuickConnect/Initiate', '/QuickConnect/Authorize?Code=000000', '/Users/AuthenticateWithQuickConnect']) {
      const answer = await postWithHeaders(port, pathname, host, { Secret: 'x' });
      assert.deepEqual([answer.status, answer.text], [403, '{"error":"household_quick_connect_disabled"}'], pathname);
    }
    const streamyfin = await getWithHeaders(port, '/Streamyfin/config', host);
    assert.deepEqual([streamyfin.status, streamyfin.text], [404, '{"error":"not_found"}']);
    // Jellyfin Enhanced's Seerr, reviews and provider lookup routes are answered by the gateway alike; its other routes still reach Jellyfin, which
    // (without the plugin here) answers them itself.
    for (const pathname of ['/JellyfinEnhanced/jellyseerr/search?query=x', '/emby/JellyfinEnhanced/jellyseerr/status/', '/jellyfinenhanced/ARR/requests', '/JellyfinEnhanced/proxy/avatar?path=/x', '/JellyfinEnhanced//tmdb/%67enres/movie', '/emby/JellyfinEnhanced/Reviews/movie/603/', '/JellyfinEnhanced/reviews/ratings?keys=movie:603', '/jellyfinenhanced/ITEMS/by-providers?Tmdb=603']) {
      const answer = await getWithHeaders(port, pathname, host);
      assert.deepEqual([answer.status, answer.text], [404, '{"error":"not_found"}'], pathname);
    }
    const requested = await postWithHeaders(port, '/JellyfinEnhanced/jellyseerr/request', host, { mediaType: 'movie', mediaId: 603 });
    assert.deepEqual([requested.status, requested.text], [404, '{"error":"not_found"}']);
    const reviewed = await postWithHeaders(port, '/JellyfinEnhanced/reviews/movie/603', host, { content: 'x', rating: 5 });
    assert.deepEqual([reviewed.status, reviewed.text], [404, '{"error":"not_found"}']);
    const script = await getWithHeaders(port, '/JellyfinEnhanced/script', host);
    assert.notEqual(script.text, '{"error":"not_found"}');
  });

  it('adds the TV add-on to Jellyfin web\'s real page exactly once, on the household it is on for only', async (t) => {
    const householdStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-tv-'), 'grants.json'));
    await householdStore.load();
    await householdStore.upsertGroup({ id: 'tvhouse', name: 'TV House', userIds: [fixture.bobId] });
    await householdStore.upsertGroup({ id: 'otherhouse', name: 'Other House', userIds: [] });
    const gateway = makeServer(new AccessService(client, householdStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: baseUrl, domain: 'example.test', hostPrefix: 'jelly-', tvAddon: { households: ['tvhouse'] } },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const port = gateway.address().port;
    const direct = await new Promise((resolve, reject) => {
      httpRequest(`${baseUrl}/web/index.html`, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject).end();
    });
    assert.equal(direct.status, 200);
    assert.ok(/<\/head>/i.test(direct.text), 'Jellyfin web\'s page has a </head>');
    const tag = /<script defer src="(\/jellypass\/tv\/jellypass-tv\.[0-9a-f]{12}\.js)" data-jellypass-tv><\/script>/;
    for (const pathname of ['/web/index.html', '/web/']) {
      // Whatever encodings and validators the browser offers, the page comes back whole, with the tag; Jellyfin is asked
      // for it unencoded, and JellyPass encodes it (in the coding the browser prefers) and marks it no-transform.
      const answer = await getWithHeaders(port, pathname, { Host: 'jelly-tvhouse.example.test', 'Accept-Encoding': 'gzip, br', 'If-Modified-Since': new Date().toUTCString() });
      assert.equal(answer.status, 200, pathname);
      assert.equal(answer.headers['content-encoding'], 'br', pathname);
      assert.equal(answer.headers['cache-control'], 'no-store, no-transform', pathname);
      assert.equal(answer.headers.etag, undefined, pathname);
      const page = { text: brotliDecompressSync(answer.body).toString('utf8') };
      assert.equal(page.text.split('data-jellypass-tv').length - 1, 1, pathname);
      assert.equal(page.text.replace(tag, ''), direct.text, `${pathname}: Jellyfin's page with the tag and nothing else`);
      assert.ok(page.text.indexOf('data-jellypass-tv') < page.text.search(/<\/head>/i), `${pathname}: in the head`);
      const script = await getWithHeaders(port, tag.exec(page.text)[1], { Host: 'jelly-tvhouse.example.test' });
      assert.deepEqual([script.status, script.headers['content-type']], [200, 'text/javascript; charset=utf-8']);
    }
    const other = await getWithHeaders(port, '/web/index.html', { Host: 'jelly-otherhouse.example.test', 'Accept-Encoding': 'identity' });
    assert.deepEqual([other.status, other.text], [200, direct.text]);
    // Relayed without the add-on, the page is still marked no-transform, and comes back whole whichever coding is used
    // (Jellyfin's own, passed through, or JellyPass's).
    assert.match(other.headers['cache-control'] ?? '', /(?:^|,\s*)no-transform$/);
    for (const accept of ['gzip', 'br', 'gzip, br']) {
      const relayed = await getWithHeaders(port, '/web/index.html', { Host: 'jelly-otherhouse.example.test', 'Accept-Encoding': accept });
      assert.equal(relayed.status, 200, accept);
      assert.match(relayed.headers['cache-control'] ?? '', /(?:^|,\s*)no-transform$/, accept);
      assert.match(relayed.headers.vary ?? '', /accept-encoding/i, accept);
      const coding = relayed.headers['content-encoding'];
      assert.ok(coding === 'gzip' || coding === 'br', `${accept}: ${coding}`);
      assert.equal((coding === 'br' ? brotliDecompressSync : gunzipSync)(relayed.body).toString('utf8'), direct.text, accept);
    }
  });

  it('checks a household sign-in, profile list and protected media in every spelling Jellyfin routes', async (t) => {
    const originalBob = user(await client.getUsers(), fixture.bobId);
    t.after(() => client.updatePolicy(fixture.bobId, originalBob.Policy));
    const original = await client.getItem(fixture.itemId);
    t.after(() => client.updateItem({ ...original }));
    // Sign-in by ID needs a password that is not empty.
    await request(baseUrl, `/Users/${fixture.aliceId}/Password`, { method: 'POST', token: fixture.token, body: { NewPw: 'alice-paths' } });
    t.after(() => request(baseUrl, `/Users/${fixture.aliceId}/Password`, { method: 'POST', token: fixture.token, body: { ResetPassword: true } }));
    const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-real-paths", Version="10.11.3"';
    // At Jellyfin itself Alice signs in by every one of these spellings, and by her ID; the legacy-prefixed ones only on
    // Jellyfin 10.11, as Jellyfin 12 no longer routes the prefix. The household host checks them on both.
    const legacy = ['/emby/Users/AuthenticateByName', '/MediaBrowser/Users/AuthenticateByName/', '/%65mby/Users/AuthenticateByName'];
    const spellings = [...legacy, '/Users/AuthenticateByName/', '/Users/%41uthenticateByName'];
    for (const pathname of spellings) {
      const answer = await postWithHeaders(new URL(baseUrl).port, pathname, { Host: new URL(baseUrl).host, Authorization: WEB }, { Username: 'Alice', Pw: 'alice-paths' });
      if (fixture.major >= 12 && legacy.includes(pathname)) assert.equal(answer.status, 404, `${pathname}: Jellyfin 12 routes the legacy prefix again`);
      else assert.equal(answer.json().User.Id, fixture.aliceId, pathname);
    }
    assert.equal((await request(baseUrl, `/Users/${fixture.aliceId}/Authenticate?pw=alice-paths`, { method: 'POST', authorization: WEB })).User.Id, fixture.aliceId);

    const householdStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-paths-'), 'grants.json'));
    await householdStore.load();
    await householdStore.upsertGroup({ id: 'pathhouse', name: 'Path House', userIds: [fixture.bobId] });
    const jellyfin = await recordedJellyfin(t);
    const gateway = makeServer(new AccessService(client, householdStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-', loginFailureDelayMs: 0 },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const port = gateway.address().port;
    const host = { Host: 'jelly-pathhouse.example.test', Authorization: WEB };
    // Alice is no member here: refused in every spelling, by name or by ID, as on the plain path.
    for (const pathname of ['/Users/AuthenticateByName', ...spellings]) {
      const answer = await postWithHeaders(port, pathname, host, { Username: 'Alice', Pw: 'alice-paths' });
      assert.deepEqual([answer.status, answer.text], [401, '{"error":"invalid_credentials"}'], pathname);
    }
    const byId = await postWithHeaders(port, `/emby/Users/${fixture.aliceId}/Authenticate?pw=alice-paths`, host, {});
    assert.deepEqual([byId.status, byId.text], [401, '{"error":"invalid_credentials"}']);
    // Sign-in by ID is offered to no one on a household host: a member's ID is answered exactly as Alice's.
    const memberById = await postWithHeaders(port, `/Users/${fixture.bobId}/Authenticate?pw=`, host, {});
    const { date: _byIdDate, ...byIdHeaders } = byId.headers;
    const { date: _memberDate, ...memberHeaders } = memberById.headers;
    assert.deepEqual([memberById.status, memberById.text, memberHeaders], [byId.status, byId.text, byIdHeaders]);
    // Bob is: the household host relays his sign-in in every spelling, once and as spelled, and Jellyfin signs him in by
    // every spelling it routes; the plain ones on every Jellyfin.
    for (const pathname of spellings) {
      jellyfin.seen.length = 0;
      const answer = await postWithHeaders(port, pathname, host, { Username: 'Bob', Pw: '' });
      assert.deepEqual(jellyfin.seen, [`POST ${pathname}`], pathname);
      if (fixture.major >= 12 && legacy.includes(pathname)) {
        // Jellyfin 12 removed the /emby and /mediabrowser routes and answers this 404, which the household host answers
        // as any failed sign-in of a member: no token, no user.
        assert.deepEqual([answer.status, answer.text], [401, '{"error":"invalid_credentials"}'], pathname);
      } else {
        assert.equal(answer.status, 200, `${pathname}: ${answer.text}`);
        assert.equal(answer.json().User.Id, fixture.bobId, pathname);
      }
    }
    const bob = await postWithHeaders(port, '/Users/AuthenticateByName', host, { Username: 'Bob', Pw: '' });
    assert.equal(bob.status, 200, bob.text);
    assert.equal(bob.json().User.Id, fixture.bobId);
    // Jellyfin 10.11 lists no hidden user publicly, and makes every new user hidden: Bob and the administrator are shown.
    await client.updatePolicy(fixture.bobId, { ...originalBob.Policy, IsHidden: false });
    const originalAdmin = (await client.getUsers()).find((entry) => entry.Policy.IsAdministrator);
    t.after(() => client.updatePolicy(originalAdmin.Id, originalAdmin.Policy));
    await client.updatePolicy(originalAdmin.Id, { ...originalAdmin.Policy, IsHidden: false });
    assert.ok((await request(baseUrl, '/Users/Public')).some((entry) => entry.Id === originalAdmin.Id), 'Jellyfin itself lists the administrator');
    for (const pathname of ['/Users/Public', '/emby/Users/Public', '/Users/Public/', '/%65mby/Users/%50ublic']) {
      jellyfin.seen.length = 0;
      const answer = await getWithHeaders(port, pathname, host);
      assert.deepEqual(jellyfin.seen, [`GET ${pathname}`], pathname);
      if (fixture.major >= 12 && /^\/(?:%65|e)mby\//i.test(pathname)) {
        // Jellyfin 12 removed the /emby and /mediabrowser routes and answers this 404, which gets the household host's
        // fixed one, listing no one.
        assert.deepEqual([answer.status, answer.text], [404, '{"error":"item_not_found"}'], pathname);
      } else {
        assert.deepEqual(answer.json().map((entry) => entry.Id), [fixture.bobId], pathname);
      }
    }
    // A title Bob may not see: its media is refused in every spelling, as on the plain path.
    await client.updateItem({ ...original, Tags: [...original.Tags, 'jp-paths-hidden'] });
    await client.updatePolicy(fixture.bobId, { ...originalBob.Policy, BlockedTags: ['jp-paths-hidden'] });
    const asBob = { Host: 'jelly-pathhouse.example.test', Authorization: `${WEB}, Token="${bob.json().AccessToken}"` };
    for (const pathname of [`/Videos/${fixture.itemId}/stream`, `/emby/Videos/${fixture.itemId}/stream`, `/MediaBrowser/Items/${fixture.itemId}/Download`, `/Videos/${fixture.itemId}/stream/`]) {
      const answer = await getWithHeaders(port, `${pathname}?Static=true`, asBob);
      assert.deepEqual([answer.status, answer.text], [404, '{"error":"item_not_found"}'], pathname);
    }
  });

  it('refuses every route of an item a member may not see, HLS, subtitles and attachments included, and serves them to one who may', async (t) => {
    const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-real-media", Version="10.11.3"';
    let clip;
    await waitFor(async () => {
      clip = (await request(baseUrl, '/Items?Recursive=true&SearchTerm=Gateway%20Clip&IncludeItemTypes=Movie', { token: fixture.token })).Items?.[0];
      return !!clip;
    });
    const originalClip = await client.getItem(clip.Id);
    t.after(() => client.updateItem({ ...originalClip }));
    const originalBob = user(await client.getUsers(), fixture.bobId);
    t.after(() => client.updatePolicy(fixture.bobId, originalBob.Policy));
    await client.updateItem({ ...originalClip, Tags: [...originalClip.Tags, 'jp-clip-hidden'] });
    await client.updatePolicy(fixture.bobId, { ...originalBob.Policy, BlockedTags: ['jp-clip-hidden'] });

    const householdStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-media-'), 'grants.json'));
    await householdStore.load();
    await householdStore.upsertGroup({ id: 'cliphouse', name: 'Clip House', userIds: [fixture.aliceId, fixture.bobId] });
    const gateway = makeServer(new AccessService(client, householdStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: baseUrl, domain: 'example.test', hostPrefix: 'jelly-', loginFailureDelayMs: 0 },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const port = gateway.address().port;
    const host = 'jelly-cliphouse.example.test';
    const signIn = async (name) => {
      const answer = await postWithHeaders(port, '/Users/AuthenticateByName', { Host: host, Authorization: WEB }, { Username: name, Pw: '' });
      assert.equal(answer.status, 200, answer.text);
      return answer.json().AccessToken;
    };
    const tokens = { alice: await signIn('Alice'), bob: await signIn('Bob') };

    // The clip as the administrator sees it: its media source, its subtitle streams (embedded and a sidecar) and its attachment.
    const info = await request(baseUrl, `/Items/${clip.Id}/PlaybackInfo?UserId=${fixture.aliceId}`, { token: fixture.token });
    const source = info.MediaSources[0];
    const subtitles = source.MediaStreams.filter((stream) => stream.Type === 'Subtitle').map((stream) => stream.Index);
    assert.ok(subtitles.length >= 1, JSON.stringify(source.MediaStreams));
    const hls = (token) => `MediaSourceId=${source.Id}&VideoCodec=h264&AudioCodec=aac&SegmentContainer=ts&PlaySessionId=jp-${token.slice(0, 8)}&ApiKey=${token}`;
    const attachment = source.MediaAttachments[0].Index;
    // Jellyfin's live.m3u8 waits for a transcode it may never finish for a file: asked of the household host as Bob only.
    const live = (token) => `/Videos/${clip.Id}/live.m3u8?${hls(token)}`;
    const routes = (token) => [
      `/Videos/${clip.Id}/master.m3u8?${hls(token)}`,
      `/Videos/${clip.Id}/main.m3u8?${hls(token)}`,
      `/Videos/${clip.Id}/hls1/main/0.ts?${hls(token)}&runtimeTicks=0&actualSegmentLengthTicks=30000000`,
      `/Videos/${clip.Id}/stream?Static=true&ApiKey=${token}`,
      ...subtitles.flatMap((index) => [
        `/Videos/${clip.Id}/${source.Id}/Subtitles/${index}/0/Stream.srt?ApiKey=${token}`,
        `/Videos/${clip.Id}/${source.Id}/Subtitles/${index}/Stream.vtt?ApiKey=${token}`,
        `/Videos/${clip.Id}/${source.Id}/Subtitles/${index}/subtitles.m3u8?SegmentLength=3&ApiKey=${token}`,
      ]),
      `/Videos/${clip.Id}/${source.Id}/Attachments/${attachment}?ApiKey=${token}`,
      `/Videos/${clip.Id}/Trickplay/320/tiles.m3u8?ApiKey=${token}`,
      `/Items/${clip.Id}/PlaybackInfo?ApiKey=${token}`,
      `/Items/${clip.Id}/Download?ApiKey=${token}`,
      `/Audio/${clip.Id}/universal?ApiKey=${token}`,
    ];

    // Jellyfin itself hides the clip from Bob, yet serves him its HLS playlist, a segment and its subtitles.
    const atJellyfin = (pathname) => getWithHeaders(new URL(baseUrl).port, pathname, { Host: new URL(baseUrl).host });
    assert.equal((await atJellyfin(`/Users/${fixture.bobId}/Items/${clip.Id}?ApiKey=${tokens.bob}`)).status, 404);
    const leakedPlaylist = await atJellyfin(`/Videos/${clip.Id}/main.m3u8?${hls(tokens.bob)}`);
    assert.equal(leakedPlaylist.status, 200, 'Jellyfin no longer serves a hidden item\'s HLS playlist: revisit the gateway\'s item checks');
    assert.match(leakedPlaylist.text, /^#EXTM3U/);
    assert.equal((await atJellyfin(`/Videos/${clip.Id}/${source.Id}/Subtitles/${subtitles[0]}/0/Stream.srt`)).status, 200, 'and its subtitles, to anyone');

    // The household host refuses Bob every route of it, in any spelling, without sending it to Jellyfin.
    for (const pathname of [...routes(tokens.bob), live(tokens.bob)]) {
      for (const spelled of [pathname, `/emby${pathname}`]) {
        const answer = await getWithHeaders(port, spelled, { Host: host });
        assert.deepEqual([answer.status, answer.text], [404, '{"error":"item_not_found"}'], spelled);
      }
    }
    // Alice may see it: her playlist, a segment of it, its subtitles and attachment are Jellyfin's to answer.
    const alice = {};
    for (const pathname of routes(tokens.alice)) alice[pathname] = await getWithHeaders(port, pathname, { Host: host });
    for (const [pathname, answer] of Object.entries(alice)) assert.notEqual(answer.text, '{"error":"item_not_found"}', pathname);
    const playlist = alice[routes(tokens.alice)[1]];
    assert.equal(playlist.status, 200, playlist.text);
    const segment = playlist.text.split('\n').find((line) => line.startsWith('hls1/'));
    assert.ok(segment, playlist.text);
    const bytes = await getWithHeaders(port, `/Videos/${clip.Id}/${segment}`, { Host: host });
    assert.equal(bytes.status, 200);
    assert.ok(bytes.text.length > 0);
    const srt = alice[routes(tokens.alice).find((pathname) => pathname.includes('/Stream.srt'))];
    assert.equal(srt.status, 200);
    assert.match(srt.text, /Gateway clip subtitle/);
    assert.equal(alice[routes(tokens.alice).find((pathname) => pathname.includes('/Attachments/'))].status, 200);
  });

  it('refuses a member any other user\'s ID, so Bob cannot list Alice\'s private playlist or its hidden entries by naming her', async (t) => {
    const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-real-userid", Version="10.11.3"';
    let clip;
    await waitFor(async () => {
      clip = (await request(baseUrl, '/Items?Recursive=true&SearchTerm=Gateway%20Clip&IncludeItemTypes=Movie', { token: fixture.token })).Items?.[0];
      return !!clip;
    });
    const originalClip = await client.getItem(clip.Id);
    t.after(() => client.updateItem({ ...originalClip }));
    const originalBob = user(await client.getUsers(), fixture.bobId);
    t.after(() => client.updatePolicy(fixture.bobId, originalBob.Policy));
    await client.updateItem({ ...originalClip, Tags: [...originalClip.Tags, 'jp-userid-hidden'] });
    await client.updatePolicy(fixture.bobId, { ...originalBob.Policy, BlockedTags: ['jp-userid-hidden'] });

    const householdStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-userid-'), 'grants.json'));
    await householdStore.load();
    await householdStore.upsertGroup({ id: 'listhouse', name: 'List House', userIds: [fixture.aliceId, fixture.bobId] });
    const gateway = makeServer(new AccessService(client, householdStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: baseUrl, domain: 'example.test', hostPrefix: 'jelly-', loginFailureDelayMs: 0 },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const port = gateway.address().port;
    const host = 'jelly-listhouse.example.test';
    const signIn = async (name) => {
      const answer = await postWithHeaders(port, '/Users/AuthenticateByName', { Host: host, Authorization: WEB }, { Username: name, Pw: '' });
      assert.equal(answer.status, 200, answer.text);
      return answer.json().AccessToken;
    };
    const tokens = { alice: await signIn('Alice'), bob: await signIn('Bob') };
    // Alice's private playlist holds the clip Bob may not see and the movie he may; Bob's own holds the movie.
    const playlistOf = async (token, userId, ids) => {
      const { Id } = await request(baseUrl, '/Playlists', { method: 'POST', token, body: { Name: `jp-${userId.slice(0, 6)}`, Ids: ids, UserId: userId, MediaType: 'Video', IsPublic: false } });
      // A private playlist is its owner's to delete: the administrator does not see it.
      t.after(() => request(baseUrl, `/Items/${Id}`, { method: 'DELETE', token }));
      return Id;
    };
    const alicePlaylist = await playlistOf(tokens.alice, fixture.aliceId, [clip.Id, fixture.itemId]);
    const bobPlaylist = await playlistOf(tokens.bob, fixture.bobId, [fixture.itemId]);
    const dashed = (id) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    const ids = (answer) => answer.json().Items.map((item) => item.Id);

    // Jellyfin itself refuses Bob Alice's playlist. Jellyfin 10.11 lists it, hidden clip included, once he names her;
    // Jellyfin 12 refuses that too.
    const atJellyfin = (pathname) => getWithHeaders(new URL(baseUrl).port, pathname, { Host: new URL(baseUrl).host });
    assert.equal((await atJellyfin(`/Users/${fixture.bobId}/Items/${clip.Id}?ApiKey=${tokens.bob}`)).status, 404);
    assert.equal((await atJellyfin(`/Playlists/${alicePlaylist}/Items?ApiKey=${tokens.bob}`)).status, 404);
    const leaked = await atJellyfin(`/Playlists/${alicePlaylist}/Items?userId=${fixture.aliceId}&ApiKey=${tokens.bob}`);
    if (fixture.major < 12) {
      assert.equal(leaked.status, 200, 'Jellyfin 10.11 no longer trusts a playlist\'s userId for the caller: revisit the gateway\'s user checks');
      assert.ok(ids(leaked).includes(clip.Id), leaked.text);
    } else {
      assert.equal(leaked.status, 403, `Jellyfin 12 trusts a playlist's userId for the caller again: ${leaked.text}`);
      assert.ok(!leaked.text.includes(clip.Id), leaked.text);
    }

    // The household host refuses Bob every way of naming Alice, without sending it to Jellyfin, however he gives his
    // token, on every Jellyfin alike. His token goes in a header, so that a query of one encoded key (`?userId%3D...`) is
    // all Jellyfin would re-read as the query. (Jellyfin 12 no longer reads X-Emby-Token; the household host still does.)
    const named = [
      `userId=${fixture.aliceId}`, `UserId=${fixture.aliceId.toUpperCase()}`, `userid=${dashed(fixture.aliceId)}`,
      `USERID=%7B${dashed(fixture.aliceId)}%7D`, `userId=${fixture.bobId}&userId=${fixture.aliceId}`, `userId%3D${fixture.aliceId}`,
    ];
    for (const asBob of [{ Host: host, Authorization: `MediaBrowser Token="${tokens.bob}"` }, { Host: host, 'X-Emby-Token': tokens.bob }]) {
      for (const parameter of named) {
        for (const pathname of [`/Playlists/${alicePlaylist}/Items`, `/emby/Playlists/${alicePlaylist}/Items`, `/Users/${fixture.aliceId}/Items`]) {
          const answer = await getWithHeaders(port, `${pathname}?${parameter}`, asBob);
          assert.deepEqual([answer.status, answer.text], [404, '{"error":"item_not_found"}'], `${pathname}?${parameter}`);
        }
      }
      for (const pathname of [`/Users/${fixture.aliceId}`, `/Users/${dashed(fixture.aliceId)}/Views`, `/Users/${fixture.aliceId}/Items?ParentId=${alicePlaylist}`]) {
        const answer = await getWithHeaders(port, pathname, asBob);
        assert.deepEqual([answer.status, answer.text], [404, '{"error":"item_not_found"}'], pathname);
      }
    }
    // Without naming anyone, Bob gets Jellyfin's own refusal.
    assert.equal((await getWithHeaders(port, `/Playlists/${alicePlaylist}/Items?ApiKey=${tokens.bob}`, { Host: host })).status, 404);

    // Alice, naming herself or no one, still lists her playlist, hidden clip included.
    for (const query of [`userId=${fixture.aliceId}&`, `UserId=${dashed(fixture.aliceId)}&`, '']) {
      const answer = await getWithHeaders(port, `/Playlists/${alicePlaylist}/Items?${query}ApiKey=${tokens.alice}`, { Host: host });
      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual(ids(answer).sort(), [clip.Id, fixture.itemId].sort(), query);
    }
    // And Bob, naming himself, still lists his own playlist and his own views.
    const own = await getWithHeaders(port, `/Playlists/${bobPlaylist}/Items?userId=${fixture.bobId}&ApiKey=${tokens.bob}`, { Host: host });
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(ids(own), [fixture.itemId]);
    const views = await getWithHeaders(port, `/Users/${fixture.bobId}/Views?ApiKey=${tokens.bob}`, { Host: host });
    assert.equal(views.status, 200, views.text);
  });

  it('lets a member share their playlist by path, naming who it is shared with, and leaves the rights to Jellyfin', async (t) => {
    const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-real-share", Version="10.11.3"';
    const householdStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-share-'), 'grants.json'));
    await householdStore.load();
    await householdStore.upsertGroup({ id: 'sharehouse', name: 'Share House', userIds: [fixture.aliceId, fixture.bobId] });
    const jellyfin = await recordedJellyfin(t);
    const gateway = makeServer(new AccessService(client, householdStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-', loginFailureDelayMs: 0 },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const port = gateway.address().port;
    const host = 'jelly-sharehouse.example.test';
    const signIn = async (name) => {
      const answer = await postWithHeaders(port, '/Users/AuthenticateByName', { Host: host, Authorization: WEB }, { Username: name, Pw: '' });
      assert.equal(answer.status, 200, answer.text);
      return answer.json().AccessToken;
    };
    const tokens = { alice: await signIn('Alice'), bob: await signIn('Bob') };
    const as = (token) => ({ Host: host, Authorization: `MediaBrowser Token="${token}"`, 'Content-Type': 'application/json' });
    const send = (method, pathname, token, body) => getWithHeaders(port, pathname, as(token), { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const { Id: playlist } = await request(baseUrl, '/Playlists', { method: 'POST', token: tokens.alice, body: { Name: 'jp-share', Ids: [fixture.itemId], UserId: fixture.aliceId, MediaType: 'Video', IsPublic: false } });
    t.after(() => request(baseUrl, `/Items/${playlist}`, { method: 'DELETE', token: tokens.alice }));
    const items = `/Playlists/${playlist}/Items`;
    assert.equal((await send('GET', items, tokens.bob)).status, 404, 'Bob sees Alice\'s private playlist before she shares it');

    // Bob cannot share Alice's playlist, with himself or anyone: Jellyfin refuses him, the household host does not.
    for (const id of [fixture.bobId, fixture.aliceId]) {
      const answer = await send('POST', `/Playlists/${playlist}/Users/${id}`, tokens.bob, { CanEdit: true });
      assert.equal(answer.status, 404, answer.text);
      assert.notEqual(answer.text, '{"error":"item_not_found"}', 'the household host, not Jellyfin, refused Bob');
    }
    // Nor by naming Alice in the query: that is still the household host's to refuse.
    const named = await send('POST', `/Playlists/${playlist}/Users/${fixture.bobId}?userId=${fixture.aliceId}`, tokens.bob, { CanEdit: true });
    assert.deepEqual([named.status, named.text], [404, '{"error":"item_not_found"}']);

    // Jellyfin 10.11 cannot add a first share by path (it looks the playlist up as the user it is shared with, who
    // cannot see it yet), but that is Jellyfin's own answer, not the household host's.
    const first = await send('POST', `/Playlists/${playlist}/Users/${fixture.bobId}`, tokens.alice, { CanEdit: false });
    assert.notEqual(first.text, '{"error":"item_not_found"}');
    assert.equal(first.status, 500, 'Jellyfin now adds a first playlist share by path: share by path here instead of by the body');
    // Alice shares it with Bob by the body, and then makes him an editor by path; Bob reads it and his share.
    const shared = await send('POST', `/Playlists/${playlist}`, tokens.alice, { Users: [{ UserId: fixture.bobId, CanEdit: false }] });
    assert.equal(shared.status, 204, shared.text);
    const read = await send('GET', items, tokens.bob);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.json().Items.map((item) => item.Id), [fixture.itemId]);
    // A client that gives its token the legacy way is checked with exactly those credentials: the household host relays
    // them as given and never rewrites them into a header Jellyfin 12 reads. Jellyfin 10.11 reads them, so Bob reads the
    // playlist; Jellyfin 12 disabled legacy authorization, so its GET /Users/Me refuses them, the household host answers
    // its fixed 401, and only that check reached Jellyfin.
    const legacyCredentials = [
      [items, { 'X-Emby-Token': tokens.bob }],
      [items, { 'X-Emby-Authorization': `MediaBrowser Token="${tokens.bob}"` }],
      [items, { 'X-MediaBrowser-Token': tokens.bob }],
      [`${items}?api_key=${tokens.bob}`, {}],
    ];
    for (const [pathname, credentials] of legacyCredentials) {
      jellyfin.seen.length = 0;
      const answer = await getWithHeaders(port, pathname, { Host: host, ...credentials });
      const label = `${pathname} ${Object.keys(credentials)}`;
      if (fixture.major < 12) {
        assert.equal(answer.status, 200, `${label}: ${answer.text}`);
        assert.deepEqual(answer.json().Items.map((item) => item.Id), [fixture.itemId], label);
      } else {
        assert.deepEqual([answer.status, answer.text], [401, '{"error":"unauthorized"}'], label);
        const check = pathname.includes('?') ? `GET /Users/Me?api_key=${tokens.bob}` : 'GET /Users/Me';
        assert.deepEqual(jellyfin.seen, [check], label);
      }
    }
    const shareOf = async (token, id) => {
      const answer = await send('GET', `/playlists/${playlist}/users/${id}`, token);
      assert.equal(answer.status, 200, answer.text);
      // The legacy prefix is let through to Jellyfin alike, as spelled. Jellyfin 10.11 answers it as the plain path;
      // Jellyfin 12 removed the /emby and /mediabrowser routes, and its own empty 404 is relayed, naming no one.
      jellyfin.seen.length = 0;
      const legacy = await send('GET', `/emby/playlists/${playlist}/users/${id}`, token);
      assert.deepEqual(jellyfin.relayed(), [`GET /emby/playlists/${playlist}/users/${id}`]);
      assert.deepEqual([legacy.status, legacy.text], fixture.major < 12 ? [answer.status, answer.text] : [404, '']);
      return answer.json().CanEdit;
    };
    assert.equal(await shareOf(tokens.bob, fixture.bobId), false);
    // Not an editor, Bob may read no one else's share, nor change his own.
    assert.equal((await send('GET', `/Playlists/${playlist}/Users/${fixture.aliceId}`, tokens.bob)).status, 403);
    assert.equal((await send('POST', `/Playlists/${playlist}/Users/${fixture.bobId}`, tokens.bob, { CanEdit: true })).status, 403);
    const editor = await send('POST', `/Playlists/${playlist}/Users/${fixture.bobId}`, tokens.alice, { CanEdit: true });
    assert.equal(editor.status, 204, editor.text);
    assert.equal(await shareOf(tokens.bob, fixture.bobId), true);
    assert.equal(await shareOf(tokens.alice, fixture.bobId), true);
    // An editor still may not change who it is shared with: only its owner may.
    assert.equal((await send('POST', `/Playlists/${playlist}/Users/${fixture.aliceId}`, tokens.bob, { CanEdit: true })).status, 403);

    // Alice removes Bob's share by path: Jellyfin 10.11 accepts it, yet keeps the share (it removes a copy of it).
    const removed = await send('DELETE', `/Playlists/${playlist}/Users/${fixture.bobId}`, tokens.alice);
    assert.equal(removed.status, 204, removed.text);
    const kept = await send('GET', `/Playlists/${playlist}/Users`, tokens.alice);
    assert.deepEqual(kept.json().map((entry) => entry.UserId), [fixture.bobId], 'Jellyfin now removes a playlist share by path: check Bob no longer sees it here');
    // By the body, Bob's share goes, and with it the playlist.
    assert.equal((await send('POST', `/Playlists/${playlist}`, tokens.alice, { Users: [] })).status, 204);
    assert.equal((await send('GET', items, tokens.bob)).status, 404);
  });

  it('shows Alice in grove only grove\'s users, sessions and SyncPlay groups, and refuses her token on another household\'s host', async (t) => {
    const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-real-scope", Version="10.11.3"';
    const householdStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-scope-'), 'grants.json'));
    await householdStore.load();
    await householdStore.upsertGroup({ id: 'grove', name: 'Grove', userIds: [fixture.aliceId] });
    await householdStore.upsertGroup({ id: 'heath', name: 'Heath', userIds: [fixture.bobId] });
    // With the household app on, as deployed, sign-out is the household host's own route.
    const seerr = await createFakeSeerr(world());
    const tmdb = await createFakeTmdb(world());
    t.after(() => Promise.all([seerr.close(), tmdb.close()]));
    const admin = new SeerrClient(seerr.url, 'seerr-key');
    const jellyfin = await recordedJellyfin(t);
    const gateway = makeServer(new AccessService(client, householdStore), { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-', loginFailureDelayMs: 0 },
      householdApp: { catalogue: new TmdbClient(TMDB_KEY, { baseUrl: tmdb.url }), blocklist: admin, members: new SeerrUserMap(admin) },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const port = gateway.address().port;
    const grove = 'jelly-grove.example.test';
    const heath = 'jelly-heath.example.test';
    const signIn = async (host, name, device) => {
      const answer = await postWithHeaders(port, '/Users/AuthenticateByName', { Host: host, Authorization: WEB.replace('jellypass-real-scope', device) }, { Username: name, Pw: '' });
      assert.equal(answer.status, 200, answer.text);
      return answer.json().AccessToken;
    };
    const alice = await signIn(grove, 'Alice', 'jellypass-real-scope-alice');
    const bob = await signIn(heath, 'Bob', 'jellypass-real-scope-bob');
    const as = (host, token) => ({ Host: host, Authorization: `${WEB}, Token="${token}"` });
    // Straight to Jellyfin, with a token as both Jellyfin 10.11 and 12 read it.
    const direct = (token) => ({ Host: new URL(baseUrl).host, Authorization: `MediaBrowser Token="${token}"` });
    const atJellyfin = (pathname, token) => getWithHeaders(new URL(baseUrl).port, pathname, direct(token));

    // Jellyfin lists every user to Alice; grove's host lists only her, in every filter.
    const everyone = await atJellyfin('/Users', alice);
    assert.ok(everyone.json().some((user) => user.Id === fixture.bobId), 'Jellyfin no longer lists every user to a member: revisit the gateway\'s /Users filter');
    // Each filter is still Jellyfin's own (a new user is hidden in 10.11, so `isHidden=false` leaves Alice off too).
    for (const pathname of ['/Users', '/users?isHidden=true', '/Users?isHidden=false', '/emby/Users/', '/Users?isDisabled=false']) {
      jellyfin.seen.length = 0;
      const answer = await getWithHeaders(port, pathname, as(grove, alice));
      assert.deepEqual(jellyfin.relayed(), [`GET ${pathname}`], pathname);
      if (fixture.major >= 12 && pathname.startsWith('/emby/')) {
        // Jellyfin 12 removed the /emby and /mediabrowser routes: its 404 gets the household host's fixed one, listing
        // no one.
        assert.equal((await atJellyfin(pathname, alice)).status, 404);
        assert.deepEqual([answer.status, answer.text], [404, '{"error":"item_not_found"}'], pathname);
        continue;
      }
      const own = (await atJellyfin(pathname, alice)).json().filter((user) => user.Id === fixture.aliceId).map((user) => user.Name);
      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual(answer.json().map((user) => user.Name), own, pathname);
    }
    assert.deepEqual((await getWithHeaders(port, '/Users', as(grove, alice))).json().map((user) => user.Name), ['Alice']);
    // A client that gives its token the legacy way (relayed as given, see the share test): Jellyfin 10.11 reads it and
    // grove's host lists only Alice; Jellyfin 12 disabled legacy authorization, so the household host answers its fixed
    // 401 and nothing but the check reached Jellyfin.
    for (const [pathname, credentials] of [['/Users', { 'X-Emby-Token': alice }], [`/Users?api_key=${alice}`, {}]]) {
      jellyfin.seen.length = 0;
      const answer = await getWithHeaders(port, pathname, { Host: grove, ...credentials });
      if (fixture.major < 12) {
        assert.equal(answer.status, 200, answer.text);
        assert.deepEqual(answer.json().map((user) => user.Name), ['Alice'], pathname);
      } else {
        assert.deepEqual([answer.status, answer.text], [401, '{"error":"unauthorized"}'], pathname);
        assert.deepEqual(jellyfin.seen, [`GET /Users/Me${pathname.includes('?') ? `?api_key=${alice}` : ''}`], pathname);
      }
    }

    // Bob's SyncPlay group, listed with his name to anyone at Jellyfin, is not grove's.
    const newGroup = await getWithHeaders(new URL(baseUrl).port, '/SyncPlay/New', { ...direct(bob), 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify({ GroupName: 'Bob group' }) });
    assert.equal(newGroup.status, 200, newGroup.text);
    t.after(() => getWithHeaders(new URL(baseUrl).port, '/SyncPlay/Leave', direct(bob), { method: 'POST' }));
    const groups = (await atJellyfin('/SyncPlay/List', alice)).json();
    const bobGroup = groups.find((group) => group.Participants.includes('Bob'));
    assert.ok(bobGroup, 'Jellyfin no longer lists other users\' SyncPlay groups: revisit the gateway\'s SyncPlay filter');
    assert.deepEqual((await getWithHeaders(port, '/SyncPlay/List', as(grove, alice))).json(), []);
    assert.deepEqual((await getWithHeaders(port, `/SyncPlay/${bobGroup.GroupId}`, as(grove, alice))).text, '{"error":"item_not_found"}');
    assert.deepEqual((await getWithHeaders(port, '/SyncPlay/List', as(heath, bob))).json().map((group) => group.GroupId), [bobGroup.GroupId]);
    // Jellyfin lets anyone join any group by its ID, then sends them its participants' names; grove's host joins
    // Alice to no group that is not grove's, and answers a group Jellyfin does not have alike.
    const join = (host, token, groupId) => getWithHeaders(port, '/SyncPlay/Join', { ...as(host, token), 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify({ GroupId: groupId }) });
    for (const groupId of [bobGroup.GroupId, 'ffffffffffffffffffffffffffffffff']) {
      assert.deepEqual([(await join(grove, alice, groupId)).text], ['{"error":"item_not_found"}'], groupId);
    }
    const stillBobs = (await atJellyfin(`/SyncPlay/${bobGroup.GroupId}`, bob)).json();
    assert.deepEqual(stillBobs.Participants, ['Bob'], 'Alice joined Bob\'s group');
    // A group that is the household's own is joined as Jellyfin joins it.
    assert.equal((await join(heath, bob, bobGroup.GroupId)).status, 204);

    // Allowed to control other users' sessions, Alice is listed Bob's at Jellyfin, never on grove's host.
    const originalAlice = user(await client.getUsers(), fixture.aliceId);
    t.after(() => client.updatePolicy(fixture.aliceId, originalAlice.Policy));
    await client.updatePolicy(fixture.aliceId, { ...originalAlice.Policy, EnableRemoteControlOfOtherUsers: true });
    // Bob's session is remote-controllable once his client has a WebSocket open and has said it takes commands.
    // (`ApiKey`, not the legacy `api_key`, which Jellyfin 12 no longer reads.)
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/socket?ApiKey=${bob}&deviceId=jellypass-real-scope-bob`);
    t.after(() => socket.close());
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    const capabilities = await getWithHeaders(new URL(baseUrl).port, '/Sessions/Capabilities/Full', { ...direct(bob), 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify({ PlayableMediaTypes: ['Video'], SupportedCommands: ['DisplayMessage'], SupportsMediaControl: true }) });
    assert.equal(capabilities.status, 204, capabilities.text);
    const controllable = `/Sessions?controllableByUserId=${fixture.aliceId}`;
    await waitFor(async () => (await atJellyfin(controllable, alice)).json().some((session) => session.UserId === fixture.bobId), 10).catch(() => undefined);
    assert.ok((await atJellyfin(controllable, alice)).json().some((session) => session.UserId === fixture.bobId), 'Jellyfin no longer lists Bob\'s session to Alice: revisit the gateway\'s /Sessions filter');
    const sessions = await getWithHeaders(port, controllable, as(grove, alice));
    assert.equal(sessions.status, 200, sessions.text);
    assert.ok(sessions.json().every((session) => session.UserId === fixture.aliceId), sessions.text);

    // Alice's token works on grove's host, and on heath's gets the same fixed answer as a token Jellyfin never issued.
    assert.equal((await getWithHeaders(port, '/System/Info', as(grove, alice))).status, 200);
    assert.equal((await atJellyfin('/System/Info', alice)).status, 200);
    for (const token of [alice, 'ffffffffffffffffffffffffffffffff']) {
      for (const pathname of ['/System/Info', '/Users', `/Users/${fixture.aliceId}/Views`, '/Items?Recursive=true', `/Items/${fixture.itemId}/PlaybackInfo`]) {
        const answer = await getWithHeaders(port, pathname, as(heath, token));
        const expected = pathname.includes(fixture.aliceId) || pathname.includes(fixture.itemId) ? [404, '{"error":"item_not_found"}'] : [401, '{"error":"unauthorized"}'];
        assert.deepEqual([answer.status, answer.text], expected, `${pathname} ${token === alice ? 'Alice' : 'unknown'}`);
      }
      // In the legacy `api_key` too, which the household host still reads though Jellyfin 12 does not.
      for (const name of ['ApiKey', 'api_key']) {
        assert.match(await rawUpgrade(port, `/socket?${name}=${token}&deviceId=jellypass-real-scope`, heath), /^HTTP\/1\.1 401 /, name);
      }
    }
    assert.match(await rawUpgrade(port, `/socket?ApiKey=${alice}&deviceId=jellypass-real-scope`, grove), /^HTTP\/1\.1 101 /);
    // Her token in the legacy `api_key`, relayed as given: Jellyfin 10.11 reads it, Jellyfin 12 does not, so the
    // household host refuses the upgrade there before it reaches Jellyfin.
    jellyfin.seen.length = 0;
    const legacySocket = await rawUpgrade(port, `/socket?api_key=${alice}&deviceId=jellypass-real-scope`, grove);
    if (fixture.major < 12) {
      assert.match(legacySocket, /^HTTP\/1\.1 101 /);
    } else {
      assert.match(legacySocket, /^HTTP\/1\.1 401 /);
      // Jellyfin's refusal of these credentials is remembered from the listing above, so not even the check is sent.
      assert.deepEqual(jellyfin.relayed(), []);
    }

    // Signing Bob out through grove's host gets the answer a token Jellyfin never issued gets, and revokes nothing.
    const signOut = (host, token) => postWithHeaders(port, '/Sessions/Logout', as(host, token), undefined);
    const unknown = await signOut(grove, 'ffffffffffffffffffffffffffffffff');
    assert.deepEqual([unknown.status, unknown.text], [401, '{"error":"unauthorized"}']);
    const bobOut = await signOut(grove, bob);
    assert.deepEqual([bobOut.status, bobOut.text, bobOut.headers['content-type']], [unknown.status, unknown.text, unknown.headers['content-type']]);
    assert.equal((await atJellyfin('/Users/Me', bob)).status, 200, 'Bob\'s token was revoked through another household\'s host');
    assert.equal((await getWithHeaders(port, '/System/Info', as(heath, bob))).status, 200);
    // Alice's own sign-out through her household's host still revokes her token.
    assert.equal((await signOut(grove, alice)).status, 204);
    assert.equal((await atJellyfin('/Users/Me', alice)).status, 401);
  });

  it('finds a title\'s items by TMDB ID with JellyPass\'s key, the "Get this" decision input for "Jellyfin already has it"', async () => {
    const original = await client.getItem(fixture.itemId);
    await client.updateItem({ ...original, ProviderIds: { ...original.ProviderIds, Tmdb: '424242' } });
    const itemId = fixture.itemId.replaceAll('-', '').toLowerCase();
    assert.deepEqual(await client.findItemsByTmdbId('movie', 424242), [itemId]);
    // A series with the same TMDB ID is another title, and another TMDB ID matches nothing.
    assert.deepEqual(await client.findItemsByTmdbId('tv', 424242), []);
    assert.deepEqual(await client.findItemsByTmdbId('movie', 4242), []);
  });

  it('finds a title\'s items by name (and year) with JellyPass\'s key, the decision input for items without TMDB metadata or a Seerr link', async () => {
    const original = await client.getItem(fixture.itemId);
    const itemId = fixture.itemId.replaceAll('-', '').toLowerCase();
    await client.updateItem({ ...original, ProviderIds: {} });
    const { ProductionYear: year } = await client.getItem(fixture.itemId);
    const found = (itemIds) => ({ itemIds, complete: true });
    assert.deepEqual(await client.findItemsByName('movie', 4242, [original.Name], year), found([itemId]));
    assert.deepEqual(await client.findItemsByName('movie', 4242, ['An Unrelated Title', original.Name.toLowerCase()]), found([itemId]));
    // An item without TMDB metadata whose name contains the title's cannot be ruled out.
    const part = original.Name.slice(0, Math.max(3, Math.ceil(original.Name.length / 2)));
    assert.deepEqual(await client.findItemsByName('movie', 4242, [part], year), found([itemId]));
    // Another year, another media type or another name is another title.
    if (typeof year === 'number') assert.deepEqual(await client.findItemsByName('movie', 4242, [original.Name], year + 5), found([]));
    assert.deepEqual(await client.findItemsByName('tv', 4242, [original.Name]), found([]));
    assert.deepEqual(await client.findItemsByName('movie', 4242, ['An Unrelated Title']), found([]));
    // An item with another TMDB ID is another title, whatever its name.
    await client.updateItem({ ...original, ProviderIds: { ...original.ProviderIds, Tmdb: '424242' } });
    assert.deepEqual(await client.findItemsByName('movie', 4242, [original.Name], year), found([]));
    assert.deepEqual(await client.findItemsByName('movie', 424242, [original.Name], year), found([itemId]));
  });

  it('finds the items Seerr links to a title by their IDs, whatever their metadata, the decision input for items without a TMDB ID', async () => {
    const itemId = fixture.itemId.replaceAll('-', '').toLowerCase();
    const missing = 'f'.repeat(32);
    assert.deepEqual(await client.existingItems('movie', [missing, fixture.itemId]), [itemId]);
    // Only items of the media type asked for.
    assert.deepEqual(await client.existingItems('tv', [itemId]), []);
    assert.deepEqual(await client.existingItems('movie', []), []);
  });
});

function postWithHost(server, pathname, host, authorization, body) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: 'POST',
      headers: { Host: host, 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify(body));
  });
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function sendWebhook(server, body) {
  const response = await fetch(`${serverUrl(server)}/webhooks/seerr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${webhookToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}

async function setupJellyfin(url) {
  // A slow runner can take most of a minute to start Jellyfin, and as long again to complete its startup.
  // The version scripts/test-real-jellyfin.sh started, so a run never passes against another Jellyfin than it names.
  const expected = process.env.JELLYFIN_REAL_VERSION;
  let version;
  await waitFor(async () => {
    const info = await request(url, '/System/Info/Public');
    version = info.Version ?? info.version;
    if (expected ? version !== expected : typeof version !== 'string') return false;
    // Since 10.11.4 Jellyfin answers /System/Info/Public while it starts, and every other route with a 503 until it has.
    await request(url, '/Startup/User');
    return true;
  }, 90);
  await request(url, '/Startup/Configuration', {
    method: 'POST',
    body: { UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' },
  });
  await request(url, '/Startup/User', { method: 'POST', body: { Name: 'admin', Password: 'test-password' } });
  await request(url, '/Startup/Complete', { method: 'POST' });
  const authentication = await request(url, '/Users/AuthenticateByName', {
    method: 'POST',
    authorization: 'MediaBrowser Client="jfa-test", Device="ci", DeviceId="jfa-real-ci", Version="1.0"',
    body: { Username: 'admin', Pw: 'test-password' },
  });
  const token = authentication.AccessToken;
  const alice = await request(url, '/Users/New', { method: 'POST', token, body: { Name: 'Alice', Password: '' } });
  const bob = await request(url, '/Users/New', { method: 'POST', token, body: { Name: 'Bob', Password: '' } });
  // A library scan saves each item as it read it, so a tag written while one runs is lost: the tests start only once
  // every scan is over. A fresh Jellyfin scans once at startup and adding the library queues a second scan; the
  // library's RefreshStatus reads Idle throughout both, so the Scan Media Library task is what is waited on.
  const tasks = () => request(url, '/ScheduledTasks', { token });
  const libraryScan = (all) => all.find((task) => task.Key === 'RefreshLibrary');
  let startupScan;
  await waitFor(async () => {
    startupScan = libraryScan(await tasks());
    return startupScan?.State === 'Idle' && !!startupScan.LastExecutionResult;
  }, 90);
  await request(url, '/Library/VirtualFolders?name=Movies&collectionType=movies&paths=%2Fmedia&refreshLibrary=true', {
    method: 'POST',
    token,
  });
  let item;
  await waitFor(async () => {
    const result = await request(url, '/Items?Recursive=true&SearchTerm=Test%20Movie&IncludeItemTypes=Movie', { token });
    item = result.Items?.[0];
    return !!item;
  });
  await waitFor(async () => {
    const all = await tasks();
    return libraryScan(all).LastExecutionResult?.StartTimeUtc !== startupScan.LastExecutionResult.StartTimeUtc
      && all.every((task) => task.State === 'Idle');
  });
  // Where Jellyfin's own answers differ between the supported releases, a test says what each does: Jellyfin 12 no longer
  // routes the legacy `/emby` and `/mediabrowser` prefixes, nor reads a token from the legacy `X-Emby-Token`,
  // `X-Emby-Authorization` and `X-MediaBrowser-Token` headers or the `api_key` query parameter.
  return { token, aliceId: alice.Id, bobId: bob.Id, itemId: item.Id, major: Number.parseInt(version, 10) };
}

async function request(url, pathname, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) {
    headers.Authorization = `MediaBrowser Client="jfa-test", Device="ci", DeviceId="jfa-real-ci", Version="1.0", Token="${encodeURIComponent(options.token)}"`;
  }
  if (options.authorization) headers.Authorization = options.authorization;
  const response = await fetch(`${url}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${pathname} returned ${response.status}: ${await response.text()}`);
  if (response.status === 204) return undefined;
  return response.json();
}

async function waitFor(predicate, attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError ?? new Error('timed out waiting for Jellyfin');
}

function user(users, id) {
  const found = users.find((entry) => entry.Id === id);
  assert.ok(found, `user ${id} should exist`);
  return found;
}

/**
 * A pass-through in front of the real Jellyfin for a gateway under test: `seen` lists every request that reached Jellyfin
 * through it (method and target, as sent), WebSocket upgrades included, and `relayed()` the same without the household
 * host's token checks (GET /Users/Me), which it may have answered from its cache.
 */
async function recordedJellyfin(t) {
  const target = new URL(baseUrl);
  const seen = [];
  const sockets = new Set();
  const proxy = createServer((incoming, outgoing) => {
    seen.push(`${incoming.method} ${incoming.url}`);
    const upstream = httpRequest({ hostname: target.hostname, port: target.port, method: incoming.method, path: incoming.url, headers: incoming.headers }, (answer) => {
      outgoing.writeHead(answer.statusCode, answer.headers);
      answer.pipe(outgoing);
    });
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  proxy.on('upgrade', (incoming, socket, head) => {
    seen.push(`${incoming.method} ${incoming.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
      const headers = [];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}\r\n`);
      upstream.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${headers.join('')}\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    for (const end of [socket, upstream]) {
      sockets.add(end);
      end.on('error', () => { socket.destroy(); upstream.destroy(); });
      end.on('close', () => { socket.destroy(); upstream.destroy(); });
    }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections();
    return new Promise((resolve) => proxy.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${proxy.address().port}`,
    seen,
    relayed: () => seen.filter((line) => !/^GET \/Users\/Me(?:\?|$)/.test(line)),
  };
}

/** A WebSocket upgrade's answer, up to the end of its headers. */
function rawUpgrade(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answer = '';
    socket.once('connect', () => socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
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
