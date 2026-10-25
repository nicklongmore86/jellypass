import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
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

describe('real Jellyfin integration', { timeout: 90_000, skip: !baseUrl }, () => {
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
    assert.deepEqual(me.json(), { name: 'Bob', household: 'App House' });

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
    assert.deepEqual(me.json(), { name: 'Bob', household: 'Sign-in House' });

    // Another household's user, and the administrator, cannot sign in on this host; Jellyfin is never asked to.
    for (const name of ['Alice', 'admin']) {
      await assert.rejects(api.signIn(name, name === 'admin' ? 'test-password' : ''), (error) => error instanceof SignInError && error.kind === 'invalid');
    }

    // Signing out revokes the token at Jellyfin and takes it out of storage.
    await api.signOut(result.token);
    assert.equal((await fetch(`${baseUrl}/Users/Me`, { headers: { Authorization: `MediaBrowser Token="${result.token}"` } })).status, 401);
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
    assert.deepEqual(me.json(), { name: 'Hilda', household: 'Hidden House' });
    await api.signOut(result.token);

    // Jellyfin web's own manual login on the household host signs her in too.
    const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-real-hidden-web", Version="10.11.3"';
    const web = (username, password) => postWithHeaders(port, '/Users/AuthenticateByName', { Host: host, Authorization: WEB }, { Username: username, Pw: password });
    const signedIn = await web('Hilda', 'hilda-pass');
    assert.equal(signedIn.status, 200);
    assert.equal(same(signedIn.json().User.Id), same(hilda.Id));
    await request(baseUrl, '/Sessions/Logout', { method: 'POST', authorization: `${WEB}, Token="${signedIn.json().AccessToken}"` });

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
  await waitFor(async () => (await request(url, '/System/Info/Public')).Version === '10.11.3');
  await request(url, '/Startup/User');
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
    const libraries = await request(url, '/Library/VirtualFolders', { token });
    const movies = libraries.find((library) => library.Name === 'Movies');
    return movies?.RefreshStatus === 'Idle';
  });
  return { token, aliceId: alice.Id, bobId: bob.Id, itemId: item.Id };
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

async function waitFor(predicate) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
