// Seerr request and auto-approve permissions in the admin Users tab (docs/server-reference.md, "Seerr request
// permissions"): the bit normalisation, GET /v1/seerr/permissions and the PUTs under it, against the fake Seerr.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SeerrClient } from '../dist/seerr.js';
import {
  applyRequestPermissions,
  permissionsChange,
  PermissionsReadOnlyError,
  requestPermissions,
  SEERR_PERMISSION,
  SeerrPermissions,
  SeerrPermissionsError,
} from '../dist/seerr-permissions.js';
import {
  ALICE,
  BOB,
  HOST_A,
  JELLYFIN_ADMIN,
  REQUEST,
  SEERR_IDS,
  T_MOVIE,
  get,
  startApp,
  world,
} from './support/household-app.mjs';

const { ADMIN, MANAGE_REQUESTS, AUTO_APPROVE, AUTO_APPROVE_MOVIE, AUTO_APPROVE_TV, REQUEST_MOVIE, REQUEST_TV } = SEERR_PERMISSION;
const AA_BITS = AUTO_APPROVE | AUTO_APPROVE_MOVIE | AUTO_APPROVE_TV;
// Every bit the Users tab never writes: AUTO_REQUEST, MANAGE_*, 4K, REQUEST_MOVIE/TV, VOTE and bits Seerr does not
// define yet (up to 2^30), all set, so a change that touched any of them would show.
const OTHER_BITS = 0x7fffffff & ~(ADMIN | MANAGE_REQUESTS | REQUEST | AA_BITS);
const ADMIN_HOST = 'jellypass.example.test';
const SEERR_ADMIN_ID = 61;
const SEERR_MANAGER_ID = 62;
const GROVE_ADMIN = 'ad0000000000000000000000000000ad';
const HEATH_MANAGER = 'ae0000000000000000000000000000ae';

describe('Seerr request permissions: bit handling', () => {
  const view = (canRequest, autoApprove, extra = {}) => ({ canRequest, autoApprove, requestMovie: false, requestTv: false, editable: { canRequest: true, autoApprove: true }, ...extra });
  /** The three auto-approve bits in each of their 8 combinations. */
  const spellings = Array.from({ length: 8 }, (_, index) => (index & 1 ? AUTO_APPROVE : 0) | (index & 2 ? AUTO_APPROVE_MOVIE : 0) | (index & 4 ? AUTO_APPROVE_TV : 0));

  it('uses Seerr 3.5.1\'s bit values', () => {
    assert.deepEqual({ ...SEERR_PERMISSION }, {
      ADMIN: 2, MANAGE_REQUESTS: 16, REQUEST: 32, AUTO_APPROVE: 128, AUTO_APPROVE_MOVIE: 256, AUTO_APPROVE_TV: 512,
      REQUEST_MOVIE: 262144, REQUEST_TV: 524288,
    });
  });

  it('shows AUTO_APPROVE (or both kind bits) as on, one kind bit alone as partial, none as off', () => {
    assert.deepEqual(requestPermissions(0), view(false, 'off'));
    assert.deepEqual(requestPermissions(REQUEST | AUTO_APPROVE), view(true, 'on'));
    assert.deepEqual(requestPermissions(REQUEST | AUTO_APPROVE_MOVIE), view(true, 'partial_movie'));
    assert.deepEqual(requestPermissions(AUTO_APPROVE_TV), view(false, 'partial_tv'));
    assert.deepEqual(requestPermissions(AUTO_APPROVE_MOVIE | AUTO_APPROVE_TV).autoApprove, 'on');
    assert.deepEqual(requestPermissions(AUTO_APPROVE | AUTO_APPROVE_TV).autoApprove, 'on');
    assert.deepEqual(requestPermissions(REQUEST_MOVIE), view(false, 'off', { requestMovie: true }));
  });

  it('applies every switch combination from every auto-approve spelling and keeps every other bit', () => {
    let cases = 0;
    for (const others of [0, REQUEST, OTHER_BITS, OTHER_BITS | REQUEST]) {
      for (const start of spellings) {
        const mask = others | start;
        for (const canRequest of [true, false, undefined]) {
          for (const autoApprove of [true, false, undefined]) {
            if (canRequest === undefined && autoApprove === undefined) continue;
            const change = { ...(canRequest === undefined ? {} : { canRequest }), ...(autoApprove === undefined ? {} : { autoApprove }) };
            const next = applyRequestPermissions(mask, change);
            const label = `${mask} with ${JSON.stringify(change)}`;
            // Everything but REQUEST and the three auto-approve bits is as it was.
            assert.equal(next & ~(REQUEST | AA_BITS), others & ~REQUEST, label);
            assert.equal((next & REQUEST) !== 0, canRequest ?? (others & REQUEST) !== 0, label);
            if (autoApprove === true) assert.equal(next & AA_BITS, start | AUTO_APPROVE, label);
            if (autoApprove === false) assert.equal(next & AA_BITS, 0, label);
            // Left alone, a partial (or any) spelling stays exactly as Seerr had it.
            if (autoApprove === undefined) assert.equal(next & AA_BITS, start, label);
            const shown = requestPermissions(next).autoApprove;
            if (autoApprove !== undefined) assert.equal(shown, autoApprove ? 'on' : 'off', label);
            cases += 1;
          }
        }
      }
    }
    assert.equal(cases, 4 * 8 * 8);
  });

  it('turns a partial state on or off with one change', () => {
    assert.equal(applyRequestPermissions(REQUEST | AUTO_APPROVE_MOVIE, { autoApprove: true }), REQUEST | AUTO_APPROVE_MOVIE | AUTO_APPROVE);
    assert.equal(applyRequestPermissions(REQUEST | AUTO_APPROVE_TV, { autoApprove: false }), REQUEST);
    assert.equal(applyRequestPermissions(REQUEST | AUTO_APPROVE_MOVIE, { canRequest: false }), AUTO_APPROVE_MOVIE);
  });

  it('keeps REQUEST_MOVIE, REQUEST_TV and the 4K bits when Can request and Auto-approve go off', () => {
    const fourK = 1024 | 2048 | 4096 | 32768 | 65536 | 131072;
    const mask = REQUEST | REQUEST_MOVIE | REQUEST_TV | AUTO_APPROVE | AUTO_APPROVE_MOVIE | fourK;
    assert.equal(applyRequestPermissions(mask, { canRequest: false, autoApprove: false }), REQUEST_MOVIE | REQUEST_TV | fourK);
  });

  it('shows ADMIN, the owner and MANAGE_REQUESTS as approving every request, read-only', () => {
    assert.deepEqual(requestPermissions(ADMIN), { canRequest: true, autoApprove: 'on', requestMovie: false, requestTv: false, implicit: 'admin', editable: { canRequest: false, autoApprove: false } });
    assert.equal(requestPermissions(0, { owner: true }).implicit, 'admin');
    assert.deepEqual(requestPermissions(MANAGE_REQUESTS), { canRequest: false, autoApprove: 'on', requestMovie: false, requestTv: false, implicit: 'manage_requests', editable: { canRequest: false, autoApprove: false } });
  });

  it('never changes an administrator\'s or a MANAGE_REQUESTS mask', () => {
    for (const change of [{ canRequest: false }, { canRequest: true }, { autoApprove: false }, { autoApprove: true }]) {
      assert.throws(() => applyRequestPermissions(ADMIN | REQUEST, change), (error) => error instanceof PermissionsReadOnlyError && error.code === 'seerr_admin_read_only');
      assert.throws(() => applyRequestPermissions(REQUEST, change, { owner: true }), (error) => error instanceof PermissionsReadOnlyError && error.code === 'seerr_admin_read_only');
      assert.throws(() => applyRequestPermissions(MANAGE_REQUESTS | AUTO_APPROVE_TV, change), (error) => error instanceof PermissionsReadOnlyError && error.code === 'seerr_admin_read_only');
    }
  });

  it('keeps the highest bit Seerr may use', () => {
    const high = 2 ** 30;
    assert.equal(applyRequestPermissions(high | REQUEST, { autoApprove: true }), high | REQUEST | AUTO_APPROVE);
    assert.equal(applyRequestPermissions(0x7fffffff & ~(ADMIN | MANAGE_REQUESTS), { canRequest: false, autoApprove: false }), 0x7fffffff & ~(ADMIN | MANAGE_REQUESTS | REQUEST | AA_BITS));
  });

  it('accepts only the two booleans as a change', () => {
    assert.deepEqual(permissionsChange({ canRequest: true }), { canRequest: true });
    assert.deepEqual(permissionsChange({ canRequest: false, autoApprove: true }), { canRequest: false, autoApprove: true });
    for (const body of [{}, { canRequest: 'true' }, { autoApprove: 1 }, { canRequest: null }, { permissions: 160 }, { canRequest: true, admin: true }, { autoApproveMovie: true }, { autoApproveTv: false }]) {
      assert.throws(() => permissionsChange(body), /must/, JSON.stringify(body));
    }
  });
});

describe('Seerr request permissions: Seerr unreachable', () => {
  it('fails closed with seerr_unavailable and names neither the URL nor the key', async (t) => {
    const logged = [];
    t.mock.method(console, 'error', (line) => logged.push(line));
    const permissions = new SeerrPermissions({ seerr: new SeerrClient('http://127.0.0.1:9', 'secret-seerr-key'), users: async () => [{ id: ALICE, name: 'Alice', isAdministrator: false }] });
    for (const call of [() => permissions.list(), () => permissions.setUser(ALICE, { canRequest: true }), () => permissions.setDefaults({ canRequest: true })]) {
      const error = await call().catch((caught) => caught);
      assert.ok(error instanceof SeerrPermissionsError);
      assert.equal(error.code, 'seerr_unavailable');
      assert.equal(error.status, 502);
    }
    assert.doesNotMatch(logged.join('\n'), /secret-seerr-key|127\.0\.0\.1/);
  });
});

describe('Seerr request permissions: the admin API', { timeout: 60_000 }, () => {
  const admin = (app, pathname, { method = 'GET', body, headers = { Authorization: 'Bearer admin-secret' }, host = ADMIN_HOST } = {}) => {
    const encoded = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return get(app.portFor(host), pathname, {
      Host: host,
      ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }),
      ...headers,
    }, { method, body: encoded });
  };
  const listing = async (app) => (await admin(app, '/v1/seerr/permissions')).json();
  const setUser = (app, jellyfinUserId, body, options) => admin(app, `/v1/seerr/permissions/users/${jellyfinUserId}`, { method: 'PUT', body, ...options });
  const setDefaults = (app, body, options) => admin(app, '/v1/seerr/permissions/defaults', { method: 'PUT', body, ...options });
  const permissionWrites = (app) => app.seerr.adminWrites.filter((write) => /permissions|settings\/main/.test(write));
  const extended = () => world({
    jellyfinUsers: {
      [GROVE_ADMIN]: { Name: 'Grove admin', Policy: { BlockedTags: [], EnableAllFolders: true } },
      [HEATH_MANAGER]: { Name: 'Heath manager', Policy: { BlockedTags: [], EnableAllFolders: true } },
    },
    seerrUsers: {
      [SEERR_ADMIN_ID]: { jellyfinUserId: GROVE_ADMIN, permissions: ADMIN },
      [SEERR_MANAGER_ID]: { jellyfinUserId: HEATH_MANAGER, permissions: MANAGE_REQUESTS | REQUEST | (1 << 23) },
    },
  });
  const start = (t, state = extended(), options = {}) => startApp(t, state, options);
  /** Captures JellyPass's info lines (JSON) for the rest of the test. */
  const infoLines = (t) => {
    const lines = [];
    const original = console.log;
    t.mock.method(console, 'log', (line, ...rest) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.message === 'Seerr request permissions changed') return void lines.push(parsed);
      } catch { /* not JSON */ }
      original(line, ...rest);
    });
    return lines;
  };

  it('answers only the administrator, only on the admin host, and refuses a cross-origin cookie request', async (t) => {
    const app = await start(t);
    for (const headers of [{}, { Authorization: 'Bearer webhook-secret' }, { Authorization: 'Bearer wrong' }]) {
      assert.equal((await admin(app, '/v1/seerr/permissions', { headers })).status, 401);
      assert.equal((await admin(app, '/v1/seerr/permissions/defaults', { headers })).status, 401);
      assert.equal((await setUser(app, ALICE, { autoApprove: true }, { headers })).status, 401);
      assert.equal((await setDefaults(app, { autoApprove: true }, { headers })).status, 401);
    }
    const crossSite = { Cookie: 'jellypass_session=forged', Origin: 'https://evil.example.org' };
    for (const answer of [await setUser(app, ALICE, { autoApprove: true }, { headers: crossSite }), await setDefaults(app, { canRequest: false }, { headers: crossSite })]) {
      assert.equal(answer.status, 403);
      assert.equal(answer.json().error, 'cross_origin_request_refused');
    }
    for (const headers of [{ Authorization: 'Bearer admin-secret' }, { Authorization: 'MediaBrowser Token="token-alice"' }]) {
      const answer = await admin(app, '/v1/seerr/permissions', { headers, host: HOST_A });
      assert.notEqual(answer.status, 200);
      assert.doesNotMatch(answer.text, /autoApprove|defaults/);
      assert.notEqual((await setUser(app, ALICE, { autoApprove: true }, { headers, host: HOST_A })).status, 200);
    }
    assert.deepEqual(permissionWrites(app), []);
    assert.equal(app.seerr.state.seerrUsers[SEERR_IDS[ALICE]].permissions, REQUEST);
  });

  it('lists every Jellyfin user with its Seerr permissions and the defaults, read with the admin key only', async (t) => {
    const app = await start(t, extended(), {});
    app.seerr.state.seerrUsers[SEERR_IDS[BOB]].permissions = REQUEST | AUTO_APPROVE_TV;
    app.seerr.calls.length = 0;
    const answer = await admin(app, '/v1/seerr/permissions');
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['cache-control'], 'no-store');
    const body = answer.json();
    assert.deepEqual(body.defaults, { canRequest: true, autoApprove: 'off', requestMovie: false, requestTv: false, editable: { canRequest: true, autoApprove: true } });
    const byName = Object.fromEntries(body.users.map((user) => [user.name, user]));
    assert.deepEqual(byName.Alice, { jellyfinUserId: ALICE, name: 'Alice', isJellyfinAdministrator: false, seerr: { id: SEERR_IDS[ALICE], canRequest: true, autoApprove: 'off', requestMovie: false, requestTv: false, editable: { canRequest: true, autoApprove: true } } });
    assert.equal(byName.Bob.seerr.autoApprove, 'partial_tv');
    assert.equal(byName.Administrator.seerr, null);
    assert.equal(byName.Administrator.isJellyfinAdministrator, true);
    assert.equal(byName['Grove admin'].seerr.implicit, 'admin');
    assert.deepEqual(byName['Grove admin'].seerr.editable, { canRequest: false, autoApprove: false });
    assert.equal(byName['Heath manager'].seerr.implicit, 'manage_requests');
    assert.deepEqual(byName['Heath manager'].seerr.editable, { canRequest: false, autoApprove: false });
    // Seerr's main settings carry its API key: nothing of them but defaultPermissions is passed on.
    assert.doesNotMatch(answer.text, /canary/);
    assert.ok(app.seerr.calls.length > 0);
    assert.ok(app.seerr.calls.every((call) => call.actingUser === undefined && call.method === 'GET'));
  });

  it('turns auto-approve on for one member, so its next request is approved at once, and logs old→new', async (t) => {
    const app = await start(t);
    const lines = infoLines(t);
    const answer = await setUser(app, ALICE, { autoApprove: true });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json(), { status: 'saved', seerrUserId: SEERR_IDS[ALICE], changed: true, permissions: { canRequest: true, autoApprove: 'on', requestMovie: false, requestTv: false, editable: { canRequest: true, autoApprove: true } } });
    assert.equal(app.seerr.state.seerrUsers[SEERR_IDS[ALICE]].permissions, REQUEST | AUTO_APPROVE);
    assert.deepEqual(app.seerr.adminBodies, [{ path: `/api/v1/user/${SEERR_IDS[ALICE]}/settings/permissions`, body: { permissions: REQUEST | AUTO_APPROVE } }]);
    assert.deepEqual(lines, [{ level: 'info', message: 'Seerr request permissions changed', action: 'set_user_request_permissions', seerrUserId: SEERR_IDS[ALICE], oldMask: REQUEST, newMask: REQUEST | AUTO_APPROVE, mask: `${REQUEST}→${REQUEST | AUTO_APPROVE}` }]);

    // Alice's next request, made as Alice (X-API-User), is approved at once.
    assert.equal((await app.post(`/jellypass/app/v1/movie/${T_MOVIE}/get`)).status, 202);
    await app.background.settled();
    assert.deepEqual(app.seerr.state.requests[SEERR_IDS[ALICE]].map((entry) => entry.status), [2]);

    // Off again: off for both kinds.
    await setUser(app, ALICE, { autoApprove: false });
    assert.equal(app.seerr.state.seerrUsers[SEERR_IDS[ALICE]].permissions, REQUEST);
    assert.equal(lines.length, 2);
  });

  it('shows a partial state until the switch is changed, then writes on or off for both kinds', async (t) => {
    const app = await start(t);
    const id = SEERR_IDS[BOB];
    app.seerr.state.seerrUsers[id].permissions = REQUEST | AUTO_APPROVE_MOVIE;
    const bob = (await listing(app)).users.find((user) => user.jellyfinUserId === BOB);
    assert.equal(bob.seerr.autoApprove, 'partial_movie');
    // Changing Can request leaves the partial bit as it is.
    await setUser(app, BOB, { canRequest: false });
    assert.equal(app.seerr.state.seerrUsers[id].permissions, AUTO_APPROVE_MOVIE);
    await setUser(app, BOB, { autoApprove: false });
    assert.equal(app.seerr.state.seerrUsers[id].permissions, 0);
    app.seerr.state.seerrUsers[id].permissions = REQUEST | AUTO_APPROVE_TV;
    await setUser(app, BOB, { autoApprove: true });
    assert.equal(app.seerr.state.seerrUsers[id].permissions, REQUEST | AUTO_APPROVE_TV | AUTO_APPROVE);
  });

  it('keeps every other bit, writes nothing for no change, and turns Can request off', async (t) => {
    const app = await start(t);
    const id = SEERR_IDS[BOB];
    app.seerr.state.seerrUsers[id].permissions = OTHER_BITS | REQUEST | AUTO_APPROVE;
    const unchanged = await setUser(app, BOB, { canRequest: true, autoApprove: true });
    assert.equal(unchanged.json().changed, false);
    assert.deepEqual(permissionWrites(app), []);
    await setUser(app, BOB, { canRequest: false, autoApprove: false });
    assert.equal(app.seerr.state.seerrUsers[id].permissions, OTHER_BITS);
    // A Jellyfin ID with dashes and capitals is the same user.
    const dashed = BOB.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-').toUpperCase();
    assert.equal((await setUser(app, dashed, { canRequest: true })).json().changed, true);
    assert.equal(app.seerr.state.seerrUsers[id].permissions, OTHER_BITS | REQUEST);
  });

  it('refuses malformed input before Seerr is called', async (t) => {
    const app = await start(t);
    for (const body of [{}, { canRequest: 'yes' }, { permissions: 2 }, { canRequest: true, extra: 1 }, [], 'null', '"x"', '{']) {
      const answer = await setUser(app, ALICE, body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.equal((await setDefaults(app, body)).status, 400, JSON.stringify(body));
    }
    for (const id of ['abc', '1', `${ALICE}0`, 'zz'.repeat(16)]) {
      assert.equal((await setUser(app, id, { canRequest: true })).status, 400, id);
    }
    const text = await admin(app, `/v1/seerr/permissions/users/${ALICE}`, { method: 'PUT', body: '{"canRequest":true}', headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'text/plain' } });
    assert.equal(text.status, 415);
    assert.equal((await admin(app, '/v1/seerr/permissions/users', { method: 'PUT', body: { canRequest: true } })).status, 404);
    assert.equal((await admin(app, `/v1/seerr/permissions/users/${ALICE}`, { method: 'POST', body: { canRequest: true } })).status, 404);
    assert.deepEqual(permissionWrites(app), []);
  });

  it('answers not_in_seerr for an unlinked user, and never edits an administrator or a manager', async (t) => {
    const app = await start(t);
    const unlinked = await setUser(app, JELLYFIN_ADMIN, { canRequest: true });
    assert.equal(unlinked.status, 404);
    assert.equal(unlinked.json().error, 'not_in_seerr');
    for (const body of [{ canRequest: false }, { autoApprove: false }]) {
      const answer = await setUser(app, GROVE_ADMIN, body);
      assert.equal(answer.status, 409);
      assert.equal(answer.json().code, 'seerr_admin_read_only');
    }
    for (const body of [{ autoApprove: true }, { canRequest: false }]) {
      const manager = await setUser(app, HEATH_MANAGER, body);
      assert.equal(manager.status, 409);
      assert.equal(manager.json().code, 'seerr_admin_read_only');
    }
    assert.deepEqual(permissionWrites(app), []);
  });

  it('passes Seerr\'s failures on as 502 or 404 with its status, never its body or the key, and fails the listing closed', async (t) => {
    const app = await start(t);
    t.mock.method(console, 'error', () => undefined);
    for (const [status, code, answerStatus] of [[401, 'seerr_refused', 502], [403, 'seerr_refused', 502], [500, 'seerr_failed', 502], [503, 'seerr_failed', 502]]) {
      app.seerr.state.failAdminReads = status;
      for (const answer of [await admin(app, '/v1/seerr/permissions'), await setUser(app, ALICE, { canRequest: false }), await setDefaults(app, { canRequest: false })]) {
        assert.equal(answer.status, answerStatus, `${status}`);
        assert.equal(answer.json().error, code);
        assert.equal(answer.json().seerrStatus, status);
        assert.doesNotMatch(answer.text, /seerr-key|canary|users/);
      }
    }
    app.seerr.state.failAdminReads = undefined;
    app.seerr.state.failAdminWrites = '/api/v1/user/';
    for (const [status, code, answerStatus] of [[403, 'seerr_refused', 502], [404, 'not_in_seerr', 404], [500, 'seerr_failed', 502]]) {
      app.seerr.state.failAdminWritesStatus = status;
      const answer = await setUser(app, ALICE, { autoApprove: true });
      assert.equal(answer.status, answerStatus);
      assert.equal(answer.json().error, code);
      assert.equal(answer.json().seerrStatus, status);
    }
    assert.equal(app.seerr.state.seerrUsers[SEERR_IDS[ALICE]].permissions, REQUEST);
  });

  it('answers seerr_not_configured without Seerr', async (t) => {
    const app = await start(t, world(), { seerrPermissions: false });
    assert.equal((await admin(app, '/v1/seerr/permissions')).json().error, 'seerr_not_configured');
    assert.equal((await admin(app, '/v1/seerr/permissions/defaults')).json().error, 'seerr_not_configured');
    assert.equal((await setUser(app, ALICE, { canRequest: true })).status, 404);
    assert.equal((await setDefaults(app, { canRequest: true })).status, 404);
    // Still validated first.
    assert.equal((await setDefaults(app, { canRequest: 1 })).status, 400);
  });

  it('changes only defaultPermissions in Seerr\'s main settings, with a body of that field alone', async (t) => {
    const app = await start(t, world({ defaultPermissions: REQUEST | (1 << 23) | 64 | AUTO_APPROVE_TV }));
    const lines = infoLines(t);
    const before = structuredClone(app.seerr.state.mainSettings);
    assert.equal((await listing(app)).defaults.autoApprove, 'partial_tv');
    assert.deepEqual((await admin(app, '/v1/seerr/permissions/defaults')).json(), { defaults: (await listing(app)).defaults });
    const answer = await setDefaults(app, { autoApprove: true });
    assert.equal(answer.status, 200);
    assert.doesNotMatch(answer.text, /canary/);
    assert.deepEqual(answer.json(), { status: 'saved', changed: true, permissions: { canRequest: true, autoApprove: 'on', requestMovie: false, requestTv: false, editable: { canRequest: true, autoApprove: true } } });
    const wanted = before.defaultPermissions | AUTO_APPROVE;
    assert.deepEqual(app.seerr.adminBodies, [{ path: '/api/v1/settings/main', body: { defaultPermissions: wanted } }]);
    assert.deepEqual(app.seerr.state.mainSettings, { ...before, defaultPermissions: wanted });
    assert.deepEqual(lines.map((line) => [line.action, line.oldMask, line.newMask, line.seerrUserId]), [['set_default_request_permissions', before.defaultPermissions, wanted, undefined]]);
    // Off is off for both kinds; AUTO_REQUEST (2^23) and VOTE (64) stay; no change writes nothing.
    await setDefaults(app, { autoApprove: false, canRequest: false });
    assert.equal(app.seerr.state.mainSettings.defaultPermissions, (1 << 23) | 64);
    assert.equal((await setDefaults(app, { canRequest: false })).json().changed, false);
    assert.equal(app.seerr.adminBodies.length, 2);
  });

  it('serialises writes, so two changes made at once both stick', async (t) => {
    const app = await start(t);
    const [one, two] = await Promise.all([setUser(app, ALICE, { autoApprove: true }), setUser(app, ALICE, { canRequest: false })]);
    assert.equal(one.status, 200);
    assert.equal(two.status, 200);
    assert.equal(app.seerr.state.seerrUsers[SEERR_IDS[ALICE]].permissions, AUTO_APPROVE);
  });
});
