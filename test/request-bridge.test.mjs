import assert from 'node:assert/strict';
import http from 'node:http';
import test, { mock } from 'node:test';
import { RequestBridge } from '../dist/request-bridge.js';
import { SeerrClient } from '../dist/seerr.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const ALEX_TOKEN = 'alex0000000000000000000000000000';
const BLAIR_TOKEN = 'blair000000000000000000000000000';
const ALEX_SEERR = { id: 7, username: 'Alex', email: 'alex@example.com', jellyfinUserId: 'abc123' };
const BLAIR_SEERR = { id: 8, username: 'Blair', email: 'blair@example.com', jellyfinUserId: 'def456' };
const ADMIN_SEERR = { id: 1, username: 'admin', email: 'admin@example.com', jellyfinUserId: '0000aaaa' };

// Jellyfin stand-in: resolves access tokens to users via GET /Users/Me.
async function createFakeJellyfin() {
  const tokens = new Map([
    [ALEX_TOKEN, { Id: 'abc123', Name: 'Alex', Policy: { IsDisabled: false } }],
    [BLAIR_TOKEN, { Id: 'def456', Name: 'Blair', Policy: { IsDisabled: false } }],
  ]);
  const state = { meCalls: 0, authorizations: [], tokens };
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/Users/Me') {
      state.meCalls += 1;
      const authorization = request.headers.authorization ?? '';
      state.authorizations.push(authorization);
      const token = /^MediaBrowser\s/.test(authorization)
        ? authorization.match(/(?:\s|,)Token="([^"]+)"/)?.[1]
        : undefined;
      const user = tokens.get(token);
      response.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(user ?? {}));
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);
  return { server, state, url: `http://127.0.0.1:${port}` };
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

test('keeps the Jellyseerr session server-side and limits relayed operations', async () => {
  let loginBody;
  let loginCalls = 0;
  let userListCalls = 0;
  const fakeSeerr = http.createServer(async (request, response) => {
    if (request.url?.startsWith('/api/v1/user?') && request.method === 'GET') {
      userListCalls += 1;
      assert.equal(request.headers['x-api-key'], 'test-api-key');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        pageInfo: { results: 1 },
        results: [{ id: 7, username: 'Alex', jellyfinUserId: 'abc123' }],
      }));
      return;
    }
    if (request.url === '/api/v1/auth/jellyfin' && request.method === 'POST') {
      loginCalls += 1;
      loginBody = JSON.parse(await requestBody(request));
      // Passwordless members: Jellyseerr accepts an empty password for any known name.
      const jellyfinUserId = { Alex: 'abc123', Blair: 'def456' }[loginBody.username];
      if (!jellyfinUserId || loginBody.password !== '') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'Unauthorized' }));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `connect.sid=${jellyfinUserId === 'abc123' ? 'test-session' : 'other-session'}; HttpOnly; Path=/`,
      });
      response.end(JSON.stringify({ id: jellyfinUserId === 'abc123' ? 7 : 8, jellyfinUserId }));
      return;
    }
    if (request.url === '/api/v1/discover/trending' && request.headers.cookie === 'connect.sid=test-session') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ results: [{ id: 1, title: 'Verified' }] }));
      return;
    }
    if (request.url === '/api/v1/movie/101' && request.headers.cookie === 'connect.sid=test-session') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 101,
        mediaInfo: {
          jellyfinMediaId: 'a1b2c3',
          status: 5,
          requests: [
            { id: 1, status: 2, requestedBy: ALEX_SEERR, modifiedBy: ADMIN_SEERR },
            { id: 2, status: 2, requestedBy: BLAIR_SEERR },
          ],
          watchlists: [{ id: 3, requestedBy: BLAIR_SEERR }],
        },
      }));
      return;
    }
    if (request.url === '/api/v1/request?take=20&requestedBy=7' && request.headers.cookie === 'connect.sid=test-session') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        pageInfo: { results: 3 },
        results: [
          { id: 1, requestedBy: ALEX_SEERR, media: { tmdbId: 101 } },
          { id: 2, requestedBy: BLAIR_SEERR, media: { tmdbId: 101 } },
          { id: 4, requestedBy: 8, media: { tmdbId: 202 } },
        ],
      }));
      return;
    }
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Unauthorized' }));
  });
  const fakePort = await listen(fakeSeerr);
  const seerr = new SeerrClient(`http://127.0.0.1:${fakePort}`, 'test-api-key');
  const accessCalls = [];
  const visibleItems = new Set();
  const access = {
    hasJellyseerrUser(userId) {
      return seerr.hasJellyfinUser(userId);
    },
    getMediaAccess(userId, mediaType, tmdbId, jellyfinItemId) {
      accessCalls.push({ operation: 'get', userId, mediaType, tmdbId, jellyfinItemId });
      return { mediaType, tmdbId, claimed: false, managed: true, owned: false, public: false, jellyfinItemId };
    },
    listMediaClaims(userId) {
      accessCalls.push({ operation: 'list', userId });
      // Deliberately over-shared: the bridge must still return only caller-safe fields.
      return [{
        mediaType: 'movie', tmdbId: 101, claimed: true, managed: true, owned: true, public: false,
        jellyfinItemId: 'a1b2c3', claimedAt: '2026-09-02T00:00:00.000Z',
        userIds: [userId, 'def456'], updatedAt: '2026-09-03T00:00:00.000Z',
      }];
    },
    canAccessItem(userId, itemId) {
      return userId === 'abc123' && visibleItems.has(itemId);
    },
    async claimMediaAccess(userId, mediaType, tmdbId, jellyfinItemId) {
      accessCalls.push({ operation: 'claim', userId, mediaType, tmdbId, jellyfinItemId });
      return { mediaType, tmdbId, claimed: true, managed: true, owned: true, public: false, jellyfinItemId };
    },
  };
  const jellyfin = await createFakeJellyfin();
  const bridge = new RequestBridge(`http://127.0.0.1:${fakePort}`, jellyfin.url, access);
  const app = http.createServer(async (request, response) => {
    const handled = await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
    if (!handled) {
      response.writeHead(418).end();
    }
  });
  const appPort = await listen(app);
  const origin = `http://127.0.0.1:${appPort}`;

  try {
    const page = await fetch(`${origin}/jellyquest-bridge/bridge.html`);
    assert.equal(page.status, 200);
    assert.equal(
      page.headers.get('content-security-policy'),
      "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors file: tizen-app:",
    );
    assert.match(await page.text(), /jellyquest-bridge/);
    assert.equal((await fetch(`${origin}/jellyquest-bridge/health`)).status, 200);
    assert.equal((await fetch(`${origin}/outside`)).status, 418);

    const eligibleProfile = await fetch(`${origin}/jellyquest-bridge/eligibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
      body: JSON.stringify({ id: 'abc123' }),
    });
    assert.equal(eligibleProfile.status, 200);
    assert.deepEqual(await eligibleProfile.json(), { eligible: true });

    const ineligibleProfile = await fetch(`${origin}/jellyquest-bridge/eligibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': BLAIR_TOKEN },
      body: '{}',
    });
    assert.equal(ineligibleProfile.status, 200);
    assert.deepEqual(await ineligibleProfile.json(), { eligible: false }, 'Blair has no Jellyseerr account');
    assert.equal(userListCalls, 2);
    assert.equal(loginCalls, 0, 'eligibility checks must not authenticate or create a Jellyseerr user');
    jellyfin.state.meCalls = 0;
    jellyfin.state.authorizations.length = 0;

    const missingJellyfinToken = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'Alex', id: 'abc123' }),
    });
    assert.equal(missingJellyfinToken.status, 401, 'a passwordless member cannot be impersonated by name and ID alone');
    assert.equal(jellyfin.state.meCalls, 0);

    const invalidJellyfinToken = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': 'forged000000000000000000000000000' },
      body: JSON.stringify({ user: 'Alex', id: 'abc123' }),
    });
    assert.equal(invalidJellyfinToken.status, 401);
    assert.equal(jellyfin.state.meCalls, 1);

    const malformedJellyfinToken = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': 'x", Token="' + ALEX_TOKEN },
      body: JSON.stringify({ id: 'abc123' }),
    });
    assert.equal(malformedJellyfinToken.status, 401);
    assert.equal(jellyfin.state.meCalls, 1, 'malformed tokens are rejected before reaching Jellyfin');

    const mismatchedProfile = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
      body: JSON.stringify({ user: 'Blair', id: 'def456' }),
    });
    assert.equal(mismatchedProfile.status, 401, 'a token for Alex cannot open a session claimed for Blair');
    assert.equal(loginCalls, 0, 'no Jellyseerr login happens before the Jellyfin identity is verified');

    const claimedName = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'Blair', accessToken: ALEX_TOKEN }),
    });
    assert.equal(claimedName.status, 200);
    assert.deepEqual(loginBody, { username: 'Alex', password: '', email: 'Alex' }, 'the verified name is used, not the claimed one');
    const claimedNameToken = (await claimedName.json()).token;
    const claimedNameClaims = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claimedNameToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/jellyquest/access/claims', options: {} }),
    });
    assert.equal((await claimedNameClaims.json()).data.claims[0].tmdbId, 101);
    assert.deepEqual(accessCalls.at(-1), { operation: 'list', userId: 'abc123' }, 'claims are listed for the verified user');
    accessCalls.length = 0;

    const sessionResponse = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `MediaBrowser Client="JellyQuest", Device="TV", DeviceId="tv-1", Version="1.0.0", Token="${ALEX_TOKEN}"`,
      },
      body: JSON.stringify({ id: 'ABC123' }),
    });
    assert.equal(sessionResponse.status, 200);
    const { token } = await sessionResponse.json();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.deepEqual(loginBody, { username: 'Alex', password: '', email: 'Alex' });
    assert.equal(loginCalls, 2);
    assert.equal(jellyfin.state.authorizations.at(-1), `MediaBrowser Token="${ALEX_TOKEN}"`);
    for (const authorization of jellyfin.state.authorizations) {
      assert.doesNotMatch(authorization, /\b(?:Client|Device|DeviceId|Version)=/, 'verification must not rewrite the device record of the user token');
    }

    const proxyResponse = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/discover/trending', options: {} }),
    });
    assert.equal(proxyResponse.status, 200);
    assert.equal((await proxyResponse.json()).data.results[0].title, 'Verified');

    const accessStatus = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/jellyquest/access?mediaType=movie&tmdbId=101', options: {} }),
    });
    assert.equal(accessStatus.status, 200);
    assert.equal((await accessStatus.json()).data.jellyfinItemId, 'a1b2c3');

    const claimed = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/jellyquest/access',
        options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'movie', tmdbId: 101 }) },
      }),
    });
    assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).data.owned, true);

    const claims = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/jellyquest/access/claims', options: {} }),
    });
    assert.equal(claims.status, 200);
    assert.deepEqual((await claims.json()).data.claims, [{
      mediaType: 'movie', tmdbId: 101, claimed: true, managed: true, owned: true, public: false,
      jellyfinItemId: 'a1b2c3', claimedAt: '2026-09-02T00:00:00.000Z',
    }], 'no claimant IDs, counts, or shared timestamps leave the bridge');
    assert.deepEqual(accessCalls, [
      { operation: 'get', userId: 'abc123', mediaType: 'movie', tmdbId: 101, jellyfinItemId: 'a1b2c3' },
      { operation: 'claim', userId: 'abc123', mediaType: 'movie', tmdbId: 101, jellyfinItemId: 'a1b2c3' },
      { operation: 'list', userId: 'abc123' },
    ]);

    const details = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/movie/101', options: {} }),
    });
    assert.equal(details.status, 200);
    assert.deepEqual((await details.json()).data.mediaInfo, {
      status: 5,
      requests: [{ id: 1, status: 2, requestedBy: ALEX_SEERR }],
      watchlists: [],
    }, 'only the caller\'s own request survives; a private item ID the caller cannot open is withheld');
    visibleItems.add('a1b2c3');
    const visibleDetails = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/movie/101', options: {} }),
    });
    assert.equal((await visibleDetails.json()).data.mediaInfo.jellyfinMediaId, 'a1b2c3');

    const requests = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/request?take=20', options: {} }),
    });
    const requestList = (await requests.json()).data;
    assert.deepEqual(requestList.results.map((entry) => entry.id), [1]);
    assert.doesNotMatch(JSON.stringify(requestList), /def456|Blair|admin/i);

    const blocked = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/settings/main', options: {} }),
    });
    assert.equal(blocked.status, 403);

    const missingToken = await fetch(`${origin}/jellyquest-bridge/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/api/v1/discover/trending', options: {} }),
    });
    assert.equal(missingToken.status, 401);
  } finally {
    await close(app);
    await close(fakeSeerr);
    await close(jellyfin.server);
  }
});

test('relays only the caller\'s own Jellyseerr activity', async () => {
  // Minimal record with no Jellyfin ID: only the Seerr user ID (resolved via /auth/me) identifies the caller.
  const ALEX_MINIMAL = { id: 7, avatar: '/a.png', userType: 3 };
  const BLAIR_MINIMAL = { id: 8, avatar: '/b.png', userType: 3 };
  const seen = { requestUrls: [], meCalls: 0, meResponse: { id: 7, jellyfinUserId: 'abc123' } };
  const payloads = {
    '/api/v1/movie/101': {
      id: 101,
      releaseDate: '2026-01-01',
      mediaInfo: {
        id: 50, tmdbId: 101, status: 5, jellyfinMediaId: 'item-private', jellyfinMediaId4k: 'item-4k',
        createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z', mediaAddedAt: '2026-03-02T00:00:00.000Z',
        seasons: [{ id: 1, seasonNumber: 1, status: 5, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z' }],
        requests: [
          { id: 1, status: 2, createdAt: '2026-02-01T00:00:00.000Z', requestedBy: ALEX_MINIMAL, modifiedBy: BLAIR_MINIMAL, modifiedById: 8 },
          { id: 2, status: 2, createdAt: '2026-02-05T00:00:00.000Z', requestedBy: BLAIR_MINIMAL },
        ],
        issues: [
          {
            id: 10, issueType: 1, createdAt: '2026-04-01T00:00:00.000Z', createdBy: ALEX_MINIMAL,
            comments: [
              { id: 100, message: 'mine', createdAt: '2026-04-01T00:00:00.000Z', user: ALEX_MINIMAL },
              { id: 101, message: 'theirs', createdAt: '2026-04-02T00:00:00.000Z', user: BLAIR_MINIMAL },
            ],
          },
          { id: 11, issueType: 2, createdAt: '2026-04-03T00:00:00.000Z', createdBy: BLAIR_MINIMAL, comments: [] },
        ],
      },
    },
    '/api/v1/discover/requested?page=3': {
      page: 3,
      totalPages: 3,
      totalResults: 5,
      pageInfo: { page: 3, pages: 3, pageSize: 2, results: 5 },
      results: [
        { id: 1, requestedBy: 7, status: 2 },
        { id: 2, requestedBy: 8, status: 2 },
      ],
    },
    '/api/v1/discover/unknown-shape': {
      id: 1,
      requestedById: 7,
      reviewerUserId: 'def456',
      approvedById: 8,
      owner_user: 'def456',
      viewerUserId: 'ABC-123',
      watchers: [BLAIR_MINIMAL, ALEX_MINIMAL],
      users: [8, 7],
      user_id: 8,
      sharedUsers: [8],
      curator: { id: 8, avatar: '/b.png', userType: 3 },
      hobbyId: 3,
      lobbyId: 'lobby-1',
      sortBy: 'popularity.desc',
    },
    '/api/v1/tv/202': {
      id: 202,
      name: 'Show',
      createdBy: [{ id: 11, name: 'Creator', gender: 1, profilePath: '/c.png', creditId: 'credit-1' }],
      mediaInfo: { status: 3, requests: [{ id: 5, requestedBy: BLAIR_MINIMAL }, { id: 6, createdBy: BLAIR_MINIMAL }] },
    },
    '/api/v1/discover/top-level-user': BLAIR_MINIMAL,
    // Credit-shaped user references must not pass as TMDB creators outside a show's `createdBy`.
    '/api/v1/tv/303': {
      id: 303,
      name: 'Other Show',
      createdBy: [
        { id: 11, name: 'Creator', profilePath: '/c.png', creditId: 'credit-1' },
        { id: 8, username: 'Blair', profilePath: '/b.png', creditId: 'credit-2' },
        8,
      ],
      requestedBy: { id: 8, name: 'Blair', profilePath: '/b.png', creditId: 'credit-3' },
      requestedByIds: [{ id: 8, profilePath: '/b.png', creditId: 'credit-4' }],
      mediaInfo: {
        status: 3,
        requests: [
          { id: 7, requestedBy: { id: 8, profilePath: '/b.png', creditId: 'credit-5' } },
          { id: 8, requestedBy: ALEX_MINIMAL },
        ],
        issues: [{ id: 12, createdBy: [{ id: 8, profilePath: '/b.png', creditId: 'credit-6' }] }],
      },
    },
    '/api/v1/movie/404': {
      id: 404,
      createdBy: [{ id: 8, name: 'Blair', profilePath: '/b.png', creditId: 'credit-7' }],
      mediaInfo: { status: 3, requests: [{ id: 9, createdBy: { id: 8, profile_path: '/b.png', credit_id: 'credit-8' } }] },
    },
    '/api/v1/discover/mixed-case': {
      id: 2,
      UserId: 8,
      USER_ID: 8,
      user_ID: 8,
      USERID: 8,
      RequestedById: 8,
      REQUESTED_BY: BLAIR_MINIMAL,
      ApprovedByID: 8,
      UserIDs: [8, 7],
      USERS: [BLAIR_MINIMAL, ALEX_MINIMAL],
      Owner_User: 'DEF456',
      ViewerUserId: 7,
      ModifiedBy: ALEX_MINIMAL,
      UPDATED_BY_ID: 7,
      hobbyId: 3,
      HobbyId: 4,
      HOBBY_ID: 5,
      lobbyId: 'lobby-1',
      sortBy: 'popularity.desc',
      SORT_BY: 'title.asc',
      UserType: 3,
      CreatedAt: '2026-05-01T00:00:00.000Z',
      UPDATED_AT: '2026-05-02T00:00:00.000Z',
      MediaAddedAt: '2026-05-03T00:00:00.000Z',
      last_season_change: '2026-05-04T00:00:00.000Z',
      JellyfinMediaId: 'item-private',
      JELLYFIN_MEDIA_ID_4K: 'item-4k',
      totalResults: 40,
      totalPages: 4,
      pageInfo: { page: 2, pages: 4, pageSize: 10, results: 40 },
      results: [
        { id: 1, USER_ID: 7 },
        { id: 2, RequestedBy: BLAIR_MINIMAL },
        { id: 3, Requested_By_Id: 8 },
        { id: 4, CREATEDBY: 8 },
        { id: 5, userid: 8 },
        { id: 6, Userid: 8 },
        { id: 7, requestedbyid: 8 },
        { id: 8, createdbyid: 8, CreatedAt: '2026-05-05T00:00:00.000Z' },
        { id: 9, Userid: 7, CreatedAt: '2026-05-06T00:00:00.000Z', UPDATED_AT: '2026-05-07T00:00:00.000Z' },
        { id: 10, media: { CREATED_AT: '2026-05-08T00:00:00.000Z', jellyfinmediaid: 'item-private', JellyfinMediaID4k: 'item-4k' } },
      ],
    },
  };
  const fakeSeerr = http.createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.url === '/api/v1/auth/jellyfin' && request.method === 'POST') {
      await requestBody(request);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'connect.sid=test-session; Path=/' });
      response.end(JSON.stringify({ jellyfinUserId: 'abc123' })); // no numeric Seerr ID
      return;
    }
    if (request.url === '/api/v1/auth/me') {
      seen.meCalls += 1;
      return seen.meResponse ? send(200, seen.meResponse) : send(500, { message: 'boom' });
    }
    if (request.url?.startsWith('/api/v1/request?')) {
      seen.requestUrls.push(request.url);
      const requestedBy = new URL(request.url, 'http://seerr').searchParams.get('requestedBy');
      const rows = [
        { id: 1, requestedBy: ALEX_MINIMAL, createdAt: '2026-02-01T00:00:00.000Z', media: { tmdbId: 101, createdAt: '2026-03-01T00:00:00.000Z' } },
        { id: 2, requestedBy: BLAIR_MINIMAL, createdAt: '2026-02-05T00:00:00.000Z', media: { tmdbId: 101 } },
      ].filter((row) => !requestedBy || String(row.requestedBy.id) === requestedBy);
      return send(200, { pageInfo: { page: 1, pages: 1, pageSize: 10, results: rows.length }, results: rows });
    }
    if (request.url === '/api/v1/request' && request.method === 'POST') {
      const body = JSON.parse(await requestBody(request));
      if (body.mediaId === 1) return send(409, { message: 'Blair (blair@example.com) already requested this title.' });
      if (body.mediaId === 3) return send(403, { message: 'Movie Quota exceeded.' });
      if (body.mediaId === 4) return send(202, { message: 'No seasons available to request' });
      return send(500, { message: 'TypeError at Blair\'s quota for user def456' });
    }
    if (payloads[request.url]) return send(200, payloads[request.url]);
    send(404, { message: 'Not found' });
  });
  const fakePort = await listen(fakeSeerr);
  const jellyfin = await createFakeJellyfin();
  const access = {
    hasJellyseerrUser: async () => true,
    getMediaAccess: () => { throw new Error('unused'); },
    listMediaClaims: () => [],
    canAccessItem: (userId, itemId) => userId === 'abc123' && itemId === 'item-4k',
    claimMediaAccess: async () => { throw new Error('unused'); },
  };
  const bridge = new RequestBridge(`http://127.0.0.1:${fakePort}`, jellyfin.url, access);
  const app = http.createServer(async (request, response) => {
    await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  const appPort = await listen(app);
  const origin = `http://127.0.0.1:${appPort}`;
  const openSession = () => fetch(`${origin}/jellyquest-bridge/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
    body: '{}',
  });

  try {
    const sessionResponse = await openSession();
    assert.equal(sessionResponse.status, 200);
    assert.equal(seen.meCalls, 1, 'the Seerr user ID is resolved from the verified Jellyseerr session');
    const { token } = await sessionResponse.json();
    const proxy = async (path, options = {}) => {
      const response = await fetch(`${origin}/jellyquest-bridge/proxy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, options }),
      });
      return { status: response.status, body: await response.json() };
    };

    // Request listings are scoped upstream, even if the client asks for someone else's.
    const requests = await proxy('/api/v1/request?take=10&requestedBy=8');
    assert.deepEqual(seen.requestUrls, ['/api/v1/request?take=10&requestedBy=7']);
    assert.deepEqual(requests.body.data, {
      pageInfo: { page: 1, pages: 1, pageSize: 10, results: 1 },
      results: [{ id: 1, requestedBy: ALEX_MINIMAL, createdAt: '2026-02-01T00:00:00.000Z', media: { tmdbId: 101 } }],
    }, 'own request kept with its timestamp; media-level timing removed');

    // Rows filtered locally get counts recomputed from what is visible.
    const filtered = (await proxy('/api/v1/discover/requested?page=3')).body.data;
    assert.deepEqual(filtered, {
      page: 1,
      totalPages: 1,
      totalResults: 1,
      pageInfo: { page: 1, pages: 1, pageSize: 2, results: 1 },
      results: [{ id: 1, requestedBy: 7, status: 2 }],
    }, 'page and totals agree after rows are withheld');
    assert.equal((await proxy('/api/v1/media?filter=pending&sort=modified')).status, 403, '/api/v1/media is not relayed');
    assert.equal((await proxy('/api/v1/media')).status, 403);

    assert.deepEqual((await proxy('/api/v1/tv/202')).body.data, {
      id: 202,
      name: 'Show',
      createdBy: [{ id: 11, name: 'Creator', gender: 1, profilePath: '/c.png', creditId: 'credit-1' }],
      mediaInfo: { status: 3, requests: [] },
    }, 'TMDB show creators are kept while Jellyseerr users are still removed');

    assert.deepEqual((await proxy('/api/v1/tv/303')).body.data, {
      id: 303,
      name: 'Other Show',
      createdBy: [{ id: 11, name: 'Creator', profilePath: '/c.png', creditId: 'credit-1' }],
      requestedByIds: [],
      mediaInfo: { status: 3, requests: [{ id: 8, requestedBy: ALEX_MINIMAL }], issues: [{ id: 12, createdBy: [] }] },
    }, 'only a show\'s top-level createdBy keeps TMDB credits; credit-shaped requesters are removed');
    assert.deepEqual((await proxy('/api/v1/movie/404')).body.data, {
      id: 404,
      createdBy: [],
      mediaInfo: { status: 3, requests: [] },
    }, 'the creator exception does not apply outside TV details');

    assert.deepEqual((await proxy('/api/v1/discover/mixed-case')).body.data, {
      id: 2,
      UserIDs: [7],
      USERS: [ALEX_MINIMAL],
      ViewerUserId: 7,
      hobbyId: 3,
      HobbyId: 4,
      HOBBY_ID: 5,
      lobbyId: 'lobby-1',
      sortBy: 'popularity.desc',
      SORT_BY: 'title.asc',
      UserType: 3,
      JELLYFIN_MEDIA_ID_4K: 'item-4k',
      totalResults: 3,
      totalPages: 1,
      pageInfo: { page: 1, pages: 1, pageSize: 10, results: 3 },
      results: [
        { id: 1, USER_ID: 7 },
        { id: 9, Userid: 7, CreatedAt: '2026-05-06T00:00:00.000Z', UPDATED_AT: '2026-05-07T00:00:00.000Z' },
        { id: 10, media: { JellyfinMediaID4k: 'item-4k' } },
      ],
    }, 'run-together owner keys drop other users\' rows and recompute totals; timestamps and item IDs match in any case; '
      + 'identity keys match in any case, other users\' rows are dropped, staff keys are always removed, unrelated keys survive');

    const details = (await proxy('/api/v1/movie/101')).body.data;
    assert.deepEqual(details, {
      id: 101,
      releaseDate: '2026-01-01',
      mediaInfo: {
        id: 50, tmdbId: 101, status: 5, jellyfinMediaId4k: 'item-4k',
        seasons: [{ id: 1, seasonNumber: 1, status: 5 }],
        requests: [{ id: 1, status: 2, createdAt: '2026-02-01T00:00:00.000Z', requestedBy: ALEX_MINIMAL }],
        issues: [{
          id: 10, issueType: 1, createdAt: '2026-04-01T00:00:00.000Z', createdBy: ALEX_MINIMAL,
          comments: [{ id: 100, message: 'mine', createdAt: '2026-04-01T00:00:00.000Z', user: ALEX_MINIMAL }],
        }],
      },
    }, 'other users\' requests, issues, comments, staff edits and media timing are removed');

    assert.deepEqual((await proxy('/api/v1/discover/unknown-shape')).body.data, {
      id: 1,
      requestedById: 7,
      viewerUserId: 'ABC-123',
      watchers: [ALEX_MINIMAL],
      users: [7],
      sharedUsers: [],
      hobbyId: 3,
      lobbyId: 'lobby-1',
      sortBy: 'popularity.desc',
    }, 'unknown identity keys and minimal user records fail closed; unrelated keys survive');
    assert.deepEqual((await proxy('/api/v1/discover/top-level-user')).body.data, {});

    const duplicate = await proxy('/api/v1/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'movie', mediaId: 1 }),
    });
    assert.deepEqual(duplicate, { status: 409, body: { error: 'That title has already been requested.' } });
    const failure = await proxy('/api/v1/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'movie', mediaId: 2 }),
    });
    assert.deepEqual(failure, { status: 500, body: { error: 'Jellyseerr is unavailable.' } }, 'unknown messages mentioning a quota are not passed through');
    const quota = await proxy('/api/v1/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'movie', mediaId: 3 }),
    });
    assert.deepEqual(quota, { status: 403, body: { error: 'You have reached your request limit for now.' } });
    const noSeasons = await proxy('/api/v1/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'tv', mediaId: 4, seasons: 'all' }),
    });
    assert.deepEqual(noSeasons, { status: 409, body: { error: 'Every season of this show has already been requested.' } });
    assert.deepEqual(await proxy('/api/v1/movie/999'), { status: 404, body: { error: 'Jellyseerr could not find that title.' } });

    seen.meResponse = { id: 8, jellyfinUserId: 'def456' };
    assert.equal((await openSession()).status, 502, 'a Seerr user that is not the verified profile is rejected');
    seen.meResponse = undefined;
    assert.equal((await openSession()).status, 502, 'sessions are not opened without a resolvable Seerr user ID');
  } finally {
    await close(app);
    await close(fakeSeerr);
    await close(jellyfin.server);
  }
});

test('ends bridge sessions when the Jellyfin access token is revoked', async () => {
  const fakeSeerr = http.createServer(async (request, response) => {
    if (request.url === '/api/v1/auth/jellyfin' && request.method === 'POST') {
      await requestBody(request);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'connect.sid=test-session; Path=/' });
      response.end(JSON.stringify({ id: 7, jellyfinUserId: 'abc123' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ results: [] }));
  });
  const fakePort = await listen(fakeSeerr);
  const jellyfin = await createFakeJellyfin();
  const bridge = new RequestBridge(`http://127.0.0.1:${fakePort}`, jellyfin.url);
  const app = http.createServer(async (request, response) => {
    await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  const appPort = await listen(app);
  const origin = `http://127.0.0.1:${appPort}`;
  const proxy = (token) => fetch(`${origin}/jellyquest-bridge/proxy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/api/v1/discover/trending', options: {} }),
  });
  mock.timers.enable({ apis: ['Date'], now: Date.now() });

  try {
    const session = await fetch(`${origin}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
      body: '{}',
    });
    assert.equal(session.status, 200);
    const { token } = await session.json();
    assert.equal((await proxy(token)).status, 200);
    assert.equal(jellyfin.state.meCalls, 1, 'fresh sessions are not re-verified on every call');

    jellyfin.state.tokens.delete(ALEX_TOKEN);
    mock.timers.tick(6 * 60 * 1000);
    assert.equal((await proxy(token)).status, 401);
    assert.equal(jellyfin.state.meCalls, 2);
    assert.equal((await proxy(token)).status, 401, 'the revoked session is discarded');
  } finally {
    mock.timers.reset();
    await close(app);
    await close(fakeSeerr);
    await close(jellyfin.server);
  }
});

test('reports an unreachable Jellyfin without creating a session', async () => {
  let loginCalls = 0;
  const fakeSeerr = http.createServer((request, response) => {
    loginCalls += 1;
    response.writeHead(500).end();
  });
  const fakePort = await listen(fakeSeerr);
  const bridge = new RequestBridge(`http://127.0.0.1:${fakePort}`, 'http://127.0.0.1:1');
  const app = http.createServer(async (request, response) => {
    await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  const appPort = await listen(app);

  try {
    const session = await fetch(`http://127.0.0.1:${appPort}/jellyquest-bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
      body: '{}',
    });
    assert.equal(session.status, 502);
    assert.equal(loginCalls, 0);
  } finally {
    await close(app);
    await close(fakeSeerr);
  }
});

test('eligibility requires a Jellyfin token and only answers for its own profile', async () => {
  const lookups = [];
  const eligibleUsers = new Set(['abc123']);
  const access = {
    hasJellyseerrUser(userId) {
      lookups.push(userId);
      return Promise.resolve(eligibleUsers.has(userId));
    },
  };
  const jellyfin = await createFakeJellyfin();
  const bridge = new RequestBridge('http://127.0.0.1:1', jellyfin.url, access);
  const app = http.createServer(async (request, response) => {
    await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  const appPort = await listen(app);
  const origin = `http://127.0.0.1:${appPort}`;
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error']) {
    mock.method(console, method, (...args) => { logged.push(args.map(String).join(' ')); });
  }
  const eligibility = async (headers, body) => {
    const response = await fetch(`${origin}/jellyquest-bridge/eligibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    // Before this change any caller could ask about any profile ID without a token.
    const anonymous = await eligibility({}, { id: 'abc123' });
    assert.equal(anonymous.status, 401, 'an unauthenticated probe for another profile is refused');
    assert.equal(anonymous.body.eligible, undefined);
    assert.equal(jellyfin.state.meCalls, 0);

    assert.equal((await eligibility({ 'X-Emby-Token': 'forged000000000000000000000000000' }, { id: 'abc123' })).status, 401);
    assert.equal((await eligibility({ 'X-Emby-Token': 'short' }, {})).status, 401, 'malformed tokens are rejected');
    assert.equal(jellyfin.state.meCalls, 1, 'malformed tokens never reach Jellyfin');

    const probeOther = await eligibility({ 'X-Emby-Token': BLAIR_TOKEN }, { id: 'abc123' });
    assert.equal(probeOther.status, 401, 'a token for Blair cannot ask about Alex');
    assert.equal(probeOther.body.eligible, undefined);
    assert.deepEqual(lookups, [], 'no Jellyseerr lookup happens for rejected or mismatched callers');

    assert.deepEqual(await eligibility({ 'X-Emby-Token': ALEX_TOKEN }, {}), { status: 200, body: { eligible: true } });
    assert.deepEqual(await eligibility({ 'X-Emby-Token': ALEX_TOKEN }, { id: 'ABC-123' }), { status: 200, body: { eligible: true } });
    assert.deepEqual(
      await eligibility({ Authorization: `MediaBrowser Client="JellyQuest", Token="${BLAIR_TOKEN}"` }, {}),
      { status: 200, body: { eligible: false } },
    );
    assert.deepEqual(lookups, ['abc123', 'abc123', 'def456'], 'the lookup uses the verified Jellyfin user ID');
    assert.equal(jellyfin.state.authorizations.at(-1), `MediaBrowser Token="${BLAIR_TOKEN}"`);

    for (const line of logged) {
      assert.doesNotMatch(line, new RegExp(`${ALEX_TOKEN}|${BLAIR_TOKEN}`), 'access tokens are never logged');
    }

    const page = await (await fetch(`${origin}/jellyquest-bridge/bridge.html`)).text();
    const checkEligibility = page.slice(page.indexOf('function checkEligibility'), page.indexOf('function createSession'));
    assert.match(checkEligibility, /'X-Emby-Token': params\.token \|\| ''/, 'the bridge page sends the Jellyfin token for eligibility checks');
  } finally {
    mock.restoreAll();
    await close(app);
    await close(jellyfin.server);
  }
});

test('eligibility fails closed when Jellyfin is unreachable', async () => {
  const lookups = [];
  const access = {
    hasJellyseerrUser(userId) {
      lookups.push(userId);
      return Promise.resolve(true);
    },
  };
  const bridge = new RequestBridge('http://127.0.0.1:1', 'http://127.0.0.1:1', access);
  const app = http.createServer(async (request, response) => {
    await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  const appPort = await listen(app);

  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/jellyquest-bridge/eligibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
      body: JSON.stringify({ id: 'abc123' }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Jellyfin is unavailable.' });
    assert.deepEqual(lookups, [], 'the ID in the body is never used as a fallback');
  } finally {
    await close(app);
  }
});

test('rate limits repeated eligibility probes from the same client', async () => {
  let lookups = 0;
  const access = {
    hasJellyseerrUser() {
      lookups += 1;
      return Promise.resolve(false);
    },
  };
  const jellyfin = await createFakeJellyfin();
  const bridge = new RequestBridge('http://127.0.0.1:1', jellyfin.url, access);
  const app = http.createServer(async (request, response) => {
    await bridge.handle(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  const appPort = await listen(app);
  const origin = `http://127.0.0.1:${appPort}`;

  try {
    const statuses = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const probe = await fetch(`${origin}/jellyquest-bridge/eligibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Emby-Token': ALEX_TOKEN },
        body: '{}',
      });
      statuses.push(probe.status);
      await probe.json();
    }
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
    assert.equal(statuses[30], 429);
    assert.equal(lookups, 30);
    assert.equal(jellyfin.state.meCalls, 30, 'rate-limited probes do not reach Jellyfin');
  } finally {
    await close(app);
    await close(jellyfin.server);
  }
});

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
