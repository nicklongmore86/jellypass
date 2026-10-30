// Jellyfin routes one endpoint by many spellings: in any case, percent-encoded, with a trailing slash, and under the
// legacy /emby and /mediabrowser prefixes. Every decision a household host makes about a path (sign-in membership, the
// profile picker, password recovery, sign-out, protected media, Quick Connect, its own pages) is made on the route
// Jellyfin would take it to, so each spelling is answered exactly as the plain path is; and a path Jellyfin might read
// otherwise than the gateway is refused with a fixed answer and never proxied.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { ALICE, ANN, BOB, HOST_A, HOST_B, ITEMS, JELLYFIN_ADMIN, OUTSIDER, get, post, startApp, world } from './support/household-app.mjs';

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
 * Paths with repeated slashes are refused before endpoint-specific checks or relay.
 */
const repeatedSlashes = (path) => {
  const [, first, rest] = /^\/([^/]+)\/(.+)$/.exec(path);
  return [`//${first}//${rest}/`, `/emby//${first}/${rest}`, `${path}//`];
};

/** Requests that reached the fake Jellyfin at anything but the gateway's own reads (its user list, /Users/Me, items). */
const forwarded = (app) => app.jellyfin.requests.filter((request) =>
  !['/Users', '/Users/Me'].includes(request.pathname) && !/^\/Users\/[0-9a-f]{32}\/Items\/[0-9a-f]{32}$/.test(request.pathname));

describe('household paths with empty segments', () => {
  for (const path of ['//', '////', '//?value=x', '//Users/Public', '//x/Users/Public', '///Users/Public', '/Users//Public', '/%2F/Users/Public', '/emby//Users/Public', '/Users/Public//', '/Users/%2fPublic', '/%2f%2FUsers/Public']) {
    it(`refuses ${path} before any upstream request`, async (t) => {
      const app = await startApp(t);
      const before = app.jellyfin.requests.length;
      const answer = await get(app.port, path, { Host: HOST_A });
      assert.deepEqual([answer.status, answer.text], [404, '{"error":"not_found"}']);
      assert.equal(app.jellyfin.requests.length, before);
    });
  }

  it('allows a trailing slash and duplicate slashes in the query', async (t) => {
    const app = await startApp(t);
    const answer = await get(app.port, '/Users/Public/?value=//', { Host: HOST_A });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json().map((user) => user.Name), ['Alice', 'Ann']);
  });

  for (const path of ['//socket', '/%2Fsocket']) {
    it(`closes refused upgrade ${path} even when the client keeps its writable half open`, async (t) => {
      const app = await startApp(t);
      const before = app.jellyfin.requests.length;
      const serverClosed = new Promise((resolve) => app.server.once('connection', (socket) => socket.once('close', resolve)));
      const answer = await new Promise((resolve, reject) => {
        const socket = connect({ port: app.port, host: '127.0.0.1', allowHalfOpen: true });
        t.after(() => socket.destroy());
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade socket lingered')); }, 2_000);
        let text = '';
        socket.on('data', (chunk) => { text += chunk.toString(); });
        socket.once('error', reject);
        socket.once('end', () => { clearTimeout(timer); resolve(text); });
        socket.once('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${HOST_A}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
      });
      await Promise.race([serverClosed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('server kept upgrade socket open')), 2_000);
        timer.unref();
        serverClosed.then(() => clearTimeout(timer));
      })]);
      assert.match(answer, /^HTTP\/1.1 404 Not Found\r\n/);
      assert.equal(answer.split('\r\n\r\n')[1], '{"error":"not_found"}');
      assert.equal(app.jellyfin.requests.length, before);
    });
  }
});

describe('household host checks in every spelling Jellyfin routes', { timeout: 60_000 }, () => {
  it('refuses a non-member\'s sign-in by name in every spelling with the fixed answer, without asking Jellyfin to sign in', async (t) => {
    const app = await startApp(t, world({ passwords }), { trustedProxies: ['127.0.0.1'] });
    let client = 0;
    const signIn = (path, username, password) => post(app.port, path, { Host: HOST_A, Authorization: AUTHORIZATION, 'X-Forwarded-For': `203.0.113.${++client}` }, { Username: username, Pw: password });
    const bare = await signIn('/Users/AuthenticateByName', 'Outsider', 'out-pass');
    assert.deepEqual([bare.status, bare.text], [401, NOT_A_MEMBER]);
    for (const path of routed('/Users/AuthenticateByName')) {
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

  it('refuses Jellyfin\'s obsolete sign-in by ID for members and non-members alike, in every spelling, without asking Jellyfin', async (t) => {
    const loginFailureDelayMs = 150;
    const app = await startApp(t, world({ passwords }), { trustedProxies: ['127.0.0.1'], loginFailureDelayMs });
    const dashed = (id) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    let client = 0;
    const answers = [];
    for (const [id, password] of [[ALICE, 'alice-pass'], [OUTSIDER, 'out-pass'], [ALICE, 'wrong'], [dashed(ALICE), 'alice-pass'], [`{${dashed(OUTSIDER)}}`, 'out-pass'], ['not-a-user', '']]) {
      for (const path of [`/Users/${id}/Authenticate`, ...routed(`/Users/${id}/Authenticate`)]) {
        const started = performance.now();
        const answer = await post(app.port, `${path}?pw=${password}`, { Host: HOST_A, Authorization: AUTHORIZATION, 'X-Forwarded-For': `203.0.113.${++client}` }, {});
        const took = performance.now() - started;
        assert.ok(took >= loginFailureDelayMs - 5, `${path} answered after ${took} ms`);
        const { date, ...headers } = answer.headers;
        answers.push({ path, answer: [answer.status, answer.text, headers] });
      }
    }
    // A member's ID with her own password is answered exactly as an outsider's, or no user's at all.
    for (const { path, answer } of answers) assert.deepEqual(answer, answers[0].answer, path);
    assert.deepEqual(answers[0].answer.slice(0, 2), [401, NOT_A_MEMBER]);
    assert.deepEqual(app.jellyfin.signInAttempts, [], 'Jellyfin was asked to sign someone in by ID');
    assert.deepEqual(forwarded(app), []);
  });

  it('counts sign-ins by ID against the same per-address budget as sign-ins by name, for members and non-members alike', async (t) => {
    const app = await startApp(t, world({ passwords }), { trustedProxies: ['127.0.0.1'] });
    const from = (address) => ({ Host: HOST_A, Authorization: AUTHORIZATION, 'X-Forwarded-For': address });
    for (const [address, id] of [['203.0.113.10', ALICE], ['203.0.113.11', OUTSIDER]]) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        assert.equal((await post(app.port, `/Users/${id}/Authenticate?pw=x`, from(address), {})).status, 401);
      }
      const byId = await post(app.port, `/Users/${id}/Authenticate?pw=x`, from(address), {});
      const byName = await post(app.port, '/Users/AuthenticateByName', from(address), { Username: 'Alice', Pw: 'alice-pass' });
      assert.deepEqual([byId.status, byId.text], [429, '{"error":"too_many_login_attempts"}'], id);
      assert.deepEqual([byName.status, byName.text], [429, '{"error":"too_many_login_attempts"}'], id);
    }
  });

  it('lists only the household\'s members in every spelling of /Users/Public', async (t) => {
    const app = await startApp(t, world({ passwords }));
    const bare = await get(app.port, '/Users/Public', { Host: HOST_A });
    assert.deepEqual(bare.json().map((user) => user.Name), ['Alice', 'Ann']);
    for (const path of routed('/Users/Public')) {
      const answer = await get(app.port, path, { Host: HOST_A });
      assert.deepEqual([answer.status, answer.text], [200, bare.text], path);
    }
    for (const path of repeatedSlashes('/Users/Public')) {
      const answer = await get(app.port, path, { Host: HOST_A });
      assert.deepEqual([answer.status, answer.text], [404, '{"error":"not_found"}'], path);
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
      for (const path of [bare, ...routed(bare)]) {
        const answer = await post(app.port, path, { Host: HOST_A }, { EnteredUsername: 'Alice', Pin: '0000' });
        assert.deepEqual([answer.status, answer.text], [403, '{"error":"household_password_recovery_disabled"}'], path);
      }
    }
    assert.deepEqual(forwarded(app), []);
  });

  for (const path of routed('/Sessions/Logout')) {
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
      for (const path of [bare, ...routed(bare)]) {
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

  it('checks every route that names an item, HLS, subtitles and attachments included, and proxies only what the caller may see', async (t) => {
    const app = await startApp(t, mediaWorld());
    const alice = { Host: HOST_A, Authorization: `${AUTHORIZATION}, Token="token-alice"` };
    const source = 'd00d0000d00d0000d00d0000d00d0000';
    const query = 'api_key=token-alice&MediaSourceId=d00d0000d00d0000d00d0000d00d0000&PlaySessionId=p1';
    // Every route Jellyfin 10.11 takes an item ID in, by method; most of them check nobody's access to the item.
    const itemRoutes = (id) => [
      ['GET', `/Videos/${id}/live.m3u8`], ['GET', `/Videos/${id}/master.m3u8`], ['HEAD', `/Videos/${id}/master.m3u8`],
      ['GET', `/Videos/${id}/main.m3u8`], ['GET', `/Videos/${id}/hls1/main/0.ts`], ['GET', `/Videos/${id}/hls1/main/-1.mp4`],
      ['GET', `/Videos/${id}/hls/abc/stream.m3u8`], ['GET', `/Videos/${id}/hls/abc/0.ts`], ['GET', `/Videos/${id}/stream`],
      ['HEAD', `/Videos/${id}/stream.mp4`], ['GET', `/Videos/${id}/${source}/Subtitles/2/Stream.vtt`],
      ['GET', `/Videos/${id}/${source}/Subtitles/2/0/Stream.srt`], ['GET', `/Videos/${id}/${source}/Subtitles/2/subtitles.m3u8`],
      ['GET', `/Videos/${id}/${source}/Attachments/0`], ['GET', `/Videos/${id}/Trickplay/320/tiles.m3u8`],
      ['GET', `/Videos/${id}/Trickplay/320/0.jpg`], ['GET', `/Videos/${id}/AdditionalParts`], ['POST', `/Videos/${id}/Subtitles`],
      ['GET', `/Audio/${id}/universal`], ['HEAD', `/Audio/${id}/universal`], ['GET', `/Audio/${id}/stream.mp3`],
      ['GET', `/Audio/${id}/main.m3u8`], ['GET', `/Audio/${id}/hls1/main/0.aac`], ['GET', `/Audio/${id}/hls/0/stream.aac`],
      ['GET', `/Audio/${id}/Lyrics`], ['GET', `/Items/${id}`], ['GET', `/Items/${id}/PlaybackInfo`],
      ['POST', `/Items/${id}/PlaybackInfo`], ['GET', `/Items/${id}/File`], ['GET', `/Items/${id}/Download`],
      ['GET', `/Items/${id}/Images`], ['GET', `/Items/${id}/ThemeMedia`], ['GET', `/Items/${id}/Similar`],
      ['GET', `/Items/${id}/SpecialFeatures`], ['GET', `/Items/${id}/Intros`], ['GET', `/Items/${id}/Ancestors`],
      ['GET', `/Items/${id}/SomeRouteJellyfinAddsLater`], ['POST', `/Items/${id}/Images/Primary`],
      ['GET', `/UserItems/${id}/UserData`], ['POST', `/UserPlayedItems/${id}`], ['POST', `/UserFavoriteItems/${id}`],
      ['POST', `/PlayingItems/${id}/Progress`], ['GET', `/MediaSegments/${id}`], ['GET', `/Shows/${id}/Episodes`],
      ['GET', `/Shows/${id}/Seasons`], ['GET', `/Movies/${id}/Similar`], ['GET', `/Albums/${id}/InstantMix`],
      ['GET', `/Artists/${id}/Similar`], ['GET', `/Users/${ALICE}/Items/${id}`], ['POST', `/Users/${ALICE}/PlayedItems/${id}`],
      ['POST', `/Users/${ALICE}/PlayingItems/${id}/Progress`], ['DELETE', `/Users/${ALICE}/FavoriteItems/${id}`],
    ];
    for (const [method, bare] of itemRoutes(HIDDEN)) {
      for (const path of [bare, ...routed(bare)]) {
        const answer = await get(app.port, `${path}?${query}`, alice, { method });
        assert.deepEqual([answer.status, method === 'HEAD' ? ITEM_NOT_FOUND : answer.text], [404, ITEM_NOT_FOUND], `${method} ${path}`);
      }
      // As a WebSocket upgrade (a GET), save an image's route, which is Jellyfin's to answer (below).
      if (!bare.includes('/Images/')) assert.match(await upgrade(app.port, bare, HOST_A), /^HTTP\/1\.1 404 /, bare);
    }
    // Jellyfin takes a subtitle's item from the query over the route: the query's is checked too.
    // Jellyfin also reads a query that is one encoded key (`?itemId%3D...`) as the pairs in it.
    for (const parameter of [`itemId=${HIDDEN}`, `ItemId=${HIDDEN}`, `ITEMID=${HIDDEN}`, `item%49d=${HIDDEN}`, `itemId%3D${HIDDEN}`, `api_key%3Dtoken-alice%26itemId%3D${HIDDEN}`]) {
      const path = `/Videos/${ITEMS.ownMovie}/${source}/Subtitles/2/Stream.vtt?${parameter}`;
      assert.deepEqual([(await get(app.port, path, alice)).status], [404], path);
    }
    // Jellyfin's live TV streams for its own transcoder are served to no household client.
    for (const path of ['/LiveTv/LiveRecordings/0123/stream', '/emby/livetv/livestreamfiles/abc/stream.ts']) {
      assert.deepEqual([(await get(app.port, path, alice)).status, (await get(app.port, path, alice)).text], [404, ITEM_NOT_FOUND], path);
    }
    assert.deepEqual(forwarded(app), [], 'a route of an item Alice may not see reached Jellyfin');
    // An item she may see is proxied, by every route.
    for (const [method, bare] of itemRoutes(ITEMS.ownMovie)) {
      const answer = await get(app.port, `${bare}?${query}`, alice, { method });
      assert.notEqual(answer.text, ITEM_NOT_FOUND, `${method} ${bare}`);
      assert.equal(app.jellyfin.requests.at(-1).path, `${bare}?${query}`, `${method} ${bare}`);
    }
    // Images are Jellyfin's to answer, signed in or not: clients load them without credentials.
    const before = forwarded(app).length;
    for (const path of [`/Items/${HIDDEN}/Images/Primary`, `/Items/${HIDDEN}/Images/Backdrop/0`, `/emby/Items/${HIDDEN}/Images/Primary/0/tag/Jpg/100/100/0/0`]) {
      await get(app.port, `${path}?tag=x`, { Host: HOST_A });
    }
    assert.equal(forwarded(app).length, before + 3);
  });

  it('refuses any user ID but the caller\'s own, in the route or the query, in every spelling and form, without proxying it', async (t) => {
    const app = await startApp(t, world({ tokens: { [JELLYFIN_ADMIN]: 'token-admin' } }));
    const as = (token) => ({ Host: HOST_A, Authorization: `${AUTHORIZATION}, Token="${token}"` });
    const alice = as('token-alice');
    const dashed = (id) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    // Every spelling Jellyfin's GUID binding reads as the same user.
    const forms = (id) => [id, id.toUpperCase(), dashed(id), `{${dashed(id).toUpperCase()}}`, `(${dashed(id)})`];
    const playlist = '9a9a00009a9a00009a9a00009a9a0000';
    // Every route Jellyfin 10.11 takes a user ID in, by method; and one it may add later under /Users.
    const userRoutes = (id) => [
      ['GET', `/Users/${id}`], ['POST', `/Users/${id}`], ['DELETE', `/Users/${id}`], ['POST', `/Users/${id}/Policy`],
      ['POST', `/Users/${id}/Configuration`], ['POST', `/Users/${id}/Password`], ['POST', `/Users/${id}/EasyPassword`],
      ['GET', `/Users/${id}/Views`], ['GET', `/Users/${id}/GroupingOptions`], ['GET', `/Users/${id}/Items`],
      ['GET', `/Users/${id}/Items/Resume`], ['GET', `/Users/${id}/Items/Latest`], ['GET', `/Users/${id}/Items/Root`],
      ['GET', `/Users/${id}/Suggestions`], ['GET', `/Users/${id}/Items/${ITEMS.ownMovie}`],
      ['POST', `/Users/${id}/PlayedItems/${ITEMS.ownMovie}`], ['POST', `/Users/${id}/PlayingItems/${ITEMS.ownMovie}/Progress`],
      ['POST', `/Users/${id}/Images/Primary`], ['DELETE', `/Users/${id}/Images/Primary/0`],
      ['GET', `/Users/${id}/SomeRouteJellyfinAddsLater`], ['GET', `/Users/${id}/Authenticate`], ['GET', `/Users/${id}/Public`],
      ['POST', `/Sessions/abc/User/${id}`], ['DELETE', `/Sessions/abc/User/${id}`],
    ];
    // Routes that take a user ID in the query, Jellyfin's that trusts it for the caller among them, and the playlist
    // share routes, whose user in the path is who the playlist is shared with (see the next test).
    const queried = [
      ['GET', `/Playlists/${playlist}/Items`], ['GET', '/Items'], ['GET', '/UserViews'], ['GET', `/UserItems/${ITEMS.ownMovie}/UserData`],
      ['GET', `/Playlists/${playlist}/Users/${ALICE}`], ['POST', `/Playlists/${playlist}/Users/${BOB}`], ['DELETE', `/Playlists/${playlist}/Users/${BOB}`],
      ['GET', '/Sessions'], ['POST', '/Sessions/abc/Playing/Pause'], ['GET', '/DisplayPreferences/usersettings'], ['POST', '/Users/Configuration'],
    ];
    const userParameters = (id) => [
      `userId=${id}`, `UserId=${id}`, `USERID=${id}`, `user%49d=${id}`, `userId=${dashed(id)}`, `userId={${dashed(id).toUpperCase()}}`,
      `userId%3D${id}`, `api_key%3Dtoken-alice%26userId%3D${id}`, `controllableByUserId=${id}`, `ControllingUserId=${id}`,
      `userId=${ALICE}&userId=${id}`, `userId=${id}&userId=${ALICE}`, `userId=${ALICE}&UserId=${id}`,
    ];
    const proxied = () => app.jellyfin.requests.filter((request) => request.pathname !== '/Users/Me').length;
    const refused = async (method, path, headers = alice) => {
      const answer = await get(app.port, path, headers, { method });
      assert.deepEqual([answer.status, method === 'HEAD' ? ITEM_NOT_FOUND : answer.text], [404, ITEM_NOT_FOUND], `${method} ${path}`);
    };
    const before = proxied();
    for (const [method, bare] of userRoutes(BOB)) {
      for (const path of [bare, ...routed(bare)]) await refused(method, path);
      assert.match(await upgrade(app.port, bare, HOST_A), /^HTTP\/1\.1 404 /, bare);
    }
    // A fixed name under /Users is only that route: anything longer takes the name for a user ID.
    for (const path of ['/Users/Me/Views', '/Users/Public/Items', '/emby/users/me/items/latest']) await refused('GET', path);
    // Another member's, an outsider's, an administrator's and no one's ID, in each of their forms.
    for (const other of [ANN, OUTSIDER, JELLYFIN_ADMIN, '00000000000000000000000000000000']) {
      for (const id of [...forms(other), `${other}x`]) {
        for (const [method, path] of userRoutes(encodeURIComponent(id))) await refused(method, path);
      }
    }
    for (const [method, route] of queried) {
      for (const parameter of [...userParameters(BOB), 'userId=00000000000000000000000000000000', 'userId=me', `userId=${ALICE},${BOB}`]) {
        await refused(method, `${route}?${parameter}`);
      }
    }
    // Alice's own ID is no use to anyone else, an administrator included, or to no one at all.
    for (const headers of [as('token-bob'), as('token-admin'), { Host: HOST_A }]) {
      await refused('GET', `/Users/${ALICE}/Views`, headers);
      await refused('GET', `/Playlists/${playlist}/Items?userId=${ALICE}`, headers);
    }
    assert.equal(proxied(), before, 'a request naming another user reached Jellyfin');
    // The caller's own ID, in any of its forms, any number of times, or an empty one, is proxied as sent.
    const own = [
      ...forms(ALICE).flatMap((id) => userRoutes(encodeURIComponent(id))),
      ...queried.flatMap(([method, route]) => [...forms(ALICE).map((id) => `userId=${encodeURIComponent(id)}`), `userId=${ALICE}&UserId=${dashed(ALICE)}`, 'userId=', `userId%3D${ALICE}`]
        .map((parameter) => [method, `${route}?${parameter}`])),
    ];
    for (const [method, path] of own) {
      const answer = await get(app.port, path, alice, { method });
      assert.notEqual(answer.text, ITEM_NOT_FOUND, `${method} ${path}`);
      assert.equal(app.jellyfin.requests.at(-1).path, path, `${method} ${path}`);
    }
    // A member's picture is Jellyfin's to serve to anyone, as the profile picker loads it; no one else's is served.
    for (const path of [`/Users/${ALICE}/Images/Primary?tag=x`, `/emby/users/${dashed(ANN)}/images/primary/0`, `/UserImage?userId=${ANN}`]) {
      for (const method of ['GET', 'HEAD']) {
        await get(app.port, path, { Host: HOST_A }, { method });
        assert.equal(app.jellyfin.requests.at(-1).path, path, `${method} ${path}`);
      }
    }
    const pictures = proxied();
    for (const path of [`/Users/${BOB}/Images/Primary`, `/UserImage?userId=${OUTSIDER}`, `/Users/${ALICE}/Images/Primary?userId=${BOB}`, `/Users/${JELLYFIN_ADMIN}/Images/Primary/0`]) {
      for (const method of ['GET', 'HEAD']) await refused(method, path, { Host: HOST_A });
    }
    assert.equal(proxied(), pictures, 'another household\'s picture reached Jellyfin');
  });

  it('proxies a playlist share by path whoever it names, in every spelling, leaving the caller\'s rights to Jellyfin', async (t) => {
    const playlist = '9a9a00009a9a00009a9a00009a9a0000';
    const app = await startApp(t, world({ playlists: { [playlist]: { owner: ALICE, items: [ITEMS.ownMovie], shares: [] } } }));
    const as = (token, host = HOST_A) => ({ Host: host, Authorization: `${AUTHORIZATION}, Token="${token}"`, 'Content-Type': 'application/json' });
    const alice = as('token-alice');
    const bob = as('token-bob', HOST_B);
    const send = (method, path, headers, body) => get(app.port, path, headers, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const items = `/Playlists/${playlist}/Items`;
    const share = (id) => `/Playlists/${playlist}/Users/${id}`;
    assert.equal((await send('GET', items, bob)).status, 404);

    // Bob cannot share Alice's playlist, with himself or anyone: Jellyfin refuses him, not the household host.
    for (const id of [BOB, ALICE, ANN]) {
      const answer = await send('POST', share(id), bob, { CanEdit: true });
      assert.deepEqual([answer.status, answer.text], [404, '"Playlist not found"'], id);
    }
    // Naming Alice in the query is still the household host's to refuse, without asking Jellyfin.
    const proxied = () => app.jellyfin.requests.filter((request) => request.pathname !== '/Users/Me').length;
    const before = proxied();
    for (const path of [`${share(BOB)}?userId=${ALICE}`, `${share(BOB)}?UserId=${ALICE}`, `/emby/playlists/${playlist}/users/${BOB}?userid=${ALICE}`]) {
      const answer = await send('POST', path, bob, { CanEdit: true });
      assert.deepEqual([answer.status, answer.text], [404, ITEM_NOT_FOUND], path);
    }
    assert.equal(proxied(), before, 'a share naming another caller reached Jellyfin');

    // Alice shares it with Bob by the body, and makes him an editor by path; Bob then reads it and his share.
    assert.equal((await send('POST', `/Playlists/${playlist}`, alice, { Users: [{ UserId: BOB, CanEdit: false }] })).status, 204);
    const read = await send('GET', items, bob);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.json().Items.map((item) => item.Id), [ITEMS.ownMovie]);
    assert.deepEqual((await send('GET', share(BOB), bob)).json(), { UserId: BOB, CanEdit: false });
    // Not an editor, Bob may read no one else's share, nor change his own.
    assert.equal((await send('GET', share(ANN), bob)).status, 403);
    assert.equal((await send('POST', share(BOB), bob, { CanEdit: true })).status, 403);
    // Every spelling is proxied, for Jellyfin to answer: those it routes change the share.
    for (const path of [share(BOB), ...routed(share(BOB))]) {
      const sent = proxied();
      const answer = await send('POST', path, alice, { CanEdit: true });
      assert.equal(proxied(), sent + 1, path);
      if (!repeatedSlashes(share(BOB)).includes(path)) assert.deepEqual([answer.status, app.jellyfin.requests.at(-1).path], [204, path]);
    }
    assert.deepEqual((await send('GET', share(BOB), bob)).json(), { UserId: BOB, CanEdit: true });
    // An editor still may not change who it is shared with: only its owner may.
    assert.equal((await send('POST', share(ANN), bob, { CanEdit: true })).status, 403);
    assert.equal((await send('DELETE', share(BOB), alice)).status, 204);
    assert.equal((await send('GET', items, bob)).status, 404);
  });

  it('never proxies the household app\'s own paths, in any spelling', async (t) => {
    const app = await startApp(t);
    for (const bare of ['/jellypass/app/v1/me', '/jellypass/app/', '/jellypass/app/nope.js']) {
      for (const path of routed(bare)) {
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
      '/Users/%252FPublic',
      '/Users/AuthenticateByName%2f',
      '/Users%5CAuthenticateByName',
      '/Users\\AuthenticateByName',
      '/jellypass/%2561pp/v1/me',
      '/%2565mby/QuickConnect/Enabled',
      '/Users/%252e%252e/Public',
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
    // Double encoding that would make a sign-in of something else, were it decoded again: ambiguous for a sign-in only.
    for (const path of ['/%2565mby/Users/AuthenticateByName', '/Users/%2541uthenticateByName', '/Users/%2525%2534%2531uthenticateByName']) {
      const answer = await post(app.port, path, alice, { Username: 'Outsider', Pw: 'out-pass' });
      assert.deepEqual([answer.status, answer.text, answer.headers['cache-control']], [400, INVALID_PATH, 'no-store'], `POST ${path}`);
    }
    // And one that would be the household's profile list: ambiguous for a GET only.
    const list = await get(app.port, '/Users/%2550ublic', alice);
    assert.deepEqual([list.status, list.text, list.headers['cache-control']], [400, INVALID_PATH, 'no-store']);
    assert.deepEqual(app.jellyfin.requests, [], 'an ambiguous path reached Jellyfin');
  });

  it('still proxies ordinary paths, encoded ones included', async (t) => {
    const app = await startApp(t);
    const proxied = () => app.jellyfin.requests.filter((request) => request.pathname !== '/Users/Me').length;
    const before = proxied();
    const paths = [
      '/web/index.html', '/Genres/Sci-Fi%20%26%20Fantasy', '/Persons/100%25%20Real', '/System/Info/Public', '/emby/System/Info/Public',
      // A name that is itself percent-encoded once decoded, wherever decoding it again would change nothing.
      '/Artists/100%2520%20Real', '/Genres/100%2520%20Hits', '/Persons/%2541lice', '/MusicGenres/%2525%2520', '/Studios/%25zz',
    ];
    for (const path of paths) {
      assert.equal((await get(app.port, path, { Host: HOST_A })).status, 401, path);
    }
    assert.deepEqual(app.jellyfin.requests.slice(before).map((request) => request.path), paths);
    // GET of a sign-out route is no sign-out, so its double encoding changes nothing either.
    assert.equal((await get(app.port, '/Sessions/%254Cogout', { Host: HOST_A })).status, 401);
    // But under /Users every other name is a user's ID, which decoding again would make a fixed name: ambiguous.
    const user = await get(app.port, '/Users/%2541uthenticateByName', { Host: HOST_A });
    assert.deepEqual([user.status, user.text], [400, INVALID_PATH]);
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
