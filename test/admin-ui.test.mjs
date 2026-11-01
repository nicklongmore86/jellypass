import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { ADMIN_APP_JS, ADMIN_HTML, ADMIN_STYLES } from '../dist/admin-ui.js';

const UNAVAILABLE = { status: 503, body: { error: 'session_check_unavailable' } };
const UNAUTHORIZED = { status: 401, body: { error: 'unauthorized' } };
const DATA = {
  '/v1/webhooks/status': { status: 200, body: { lastRemovedFormAt: null } },
  '/auth/session': { status: 200, body: { authenticated: true, username: 'admin' } },
  '/v1/grants': { status: 200, body: { grants: [] } },
  '/v1/groups': { status: 200, body: { groups: [] } },
  '/v1/users': { status: 200, body: { users: [], jellyseerrImportAvailable: false } },
  '/v1/library': { status: 200, body: { items: [], lastSyncedAt: null } },
  '/v1/requests/recent': { status: 200, body: { requests: [] } },
};
const SYNCED = { status: 200, body: { items: [], lastSyncedAt: null } };
const SESSION_CHECKS = (page) => page.requests.filter((request) => request === 'GET /auth/session').length;

/** An answer held back until `resolve(reply)` is called, or a request that fails when `reject(error)` is. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * The admin UI's script run against its own page, with fetch answered by `answer(path, init)` (a reply, or a promise
 * of one) and a manual clock: timers only run when `advance` passes their time.
 */
function adminPage(answer) {
  const { window, document } = parseHTML(ADMIN_HTML);
  // linkedom's <select> has no value setter, which the catalog's filters use.
  const select = window.HTMLSelectElement.prototype;
  const { get } = Object.getOwnPropertyDescriptor(select, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    get,
    set(value) { for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value); },
  });
  let now = 1_000_000;
  let nextTimer = 1;
  const timers = new Map();
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => visibility });
  const requests = [];
  const fetch = async (path, init) => {
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    const reply = await answer(path, init);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  const context = {
    window,
    document,
    history: {},
    fetch,
    Headers,
    URLSearchParams,
    confirm: () => true,
    // A real Date (a grant card formats its time), with the manual clock's now.
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, ms) => { const id = nextTimer++; timers.set(id, { at: now + (ms ?? 0), callback }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  window.scrollTo = () => {};
  runInNewContext(ADMIN_APP_JS, context);
  const byId = (id) => document.getElementById(id);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    requests,
    async settle() { for (let i = 0; i < 20; i += 1) await settle(); },
    /** The session retry timer's delay from now, in ms, or null when none is armed. */
    pendingRetry() {
      const delays = [...timers.values()].filter((timer) => timer.callback.name === 'retrySession').map((timer) => timer.at - now);
      return delays.length ? Math.min(...delays) : null;
    },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.callback(); }
      }
      await this.settle();
    },
    async setVisibility(value) {
      visibility = value;
      document.dispatchEvent(new window.Event('visibilitychange'));
      await this.settle();
    },
    view() {
      return {
        login: !byId('login-view').hidden,
        app: !byId('app-view').hidden,
        notice: byId('notice').hidden ? '' : byId('notice').textContent,
        connection: byId('connection').querySelector('b').textContent,
      };
    },
    window,
    document,
    toast: () => byId('toast').textContent,
    click: (id) => byId(id).dispatchEvent(new window.Event('click')),
  };
}

describe('admin UI while Jellyfin cannot answer the session check', () => {
  it('keeps the sign-in form hidden at load, shows a notice and retries after 30 s, backing off to 2 min', async () => {
    let session = UNAVAILABLE;
    const page = adminPage((path) => (path === '/auth/session' ? session : DATA[path]));
    await page.settle();
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: false, notice: 'Jellyfin is temporarily unavailable — retrying…', connection: 'Jellyfin unavailable' }));
    assert.doesNotMatch(JSON.stringify(page.view()), /session_check_unavailable/);
    assert.equal(page.pendingRetry(), 30_000);
    await page.advance(29_999);
    assert.equal(page.requests.filter((request) => request === 'GET /auth/session').length, 1);
    await page.advance(1);
    assert.equal(page.requests.filter((request) => request === 'GET /auth/session').length, 2);
    assert.equal(page.pendingRetry(), 60_000);
    await page.advance(60_000);
    assert.equal(page.pendingRetry(), 120_000);
    await page.advance(120_000);
    assert.equal(page.pendingRetry(), 120_000, 'capped at two minutes');
    assert.equal(page.requests.filter((request) => request === 'GET /auth/session').length, 4);

    session = DATA['/auth/session'];
    await page.advance(120_000);
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: true, notice: '', connection: 'Library sync required' }));
    assert.equal(page.pendingRetry(), null);
    assert.ok(page.requests.includes('GET /v1/grants'), 'the data is loaded once the check passes');
  });

  it('does not retry while the tab is hidden, and waits the whole delay once it is shown', async () => {
    let session = UNAVAILABLE;
    const page = adminPage((path) => (path === '/auth/session' ? session : DATA[path]));
    await page.settle();
    await page.setVisibility('hidden');
    assert.equal(page.pendingRetry(), null);
    await page.advance(600_000);
    assert.equal(SESSION_CHECKS(page), 1);
    session = DATA['/auth/session'];
    await page.setVisibility('visible');
    assert.equal(page.pendingRetry(), 30_000, 'hidden time does not count towards the wait');
    await page.advance(29_999);
    assert.equal(SESSION_CHECKS(page), 1);
    await page.advance(1);
    assert.equal(SESSION_CHECKS(page), 2);
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: true, notice: '', connection: 'Library sync required' }));
  });

  it('keeps the part of the delay that was left when the tab was hidden', async () => {
    const page = adminPage((path) => (path === '/auth/session' ? UNAVAILABLE : DATA[path]));
    await page.settle();
    await page.advance(10_000);
    await page.setVisibility('hidden');
    assert.equal(page.pendingRetry(), null);
    await page.advance(10_000);
    await page.setVisibility('visible');
    assert.equal(page.pendingRetry(), 20_000);
    await page.advance(19_999);
    assert.equal(SESSION_CHECKS(page), 1);
    await page.advance(1);
    assert.equal(SESSION_CHECKS(page), 2);
    assert.equal(page.pendingRetry(), 60_000);
  });

  it('keeps the connected view on an API call 503 with a friendly toast, then clears the notice on recovery', async () => {
    const page = adminPage((path) => (path.startsWith('/v1/reconcile') ? UNAVAILABLE : DATA[path]));
    await page.settle();
    assert.equal(page.view().app, true);

    page.click('reconcile-policies');
    await page.settle();
    assert.ok(page.requests.includes('POST /v1/reconcile?dryRun=true'));
    assert.equal(page.toast(), 'Jellyfin is temporarily unavailable — retrying…');
    assert.doesNotMatch(page.toast(), /session_check_unavailable/);
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: true, notice: 'Jellyfin is temporarily unavailable — retrying…', connection: 'Jellyfin unavailable' }));
    assert.equal(page.pendingRetry(), 30_000);

    await page.advance(30_000);
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: true, notice: '', connection: 'Library sync required' }));
    assert.equal(page.pendingRetry(), null);
  });

  it('maps other known error codes to sentences in the toast', async () => {
    const page = adminPage((path) => (path.startsWith('/v1/reconcile') ? { status: 403, body: { error: 'cross_origin_request_refused' } } : DATA[path]));
    await page.settle();
    page.click('reconcile-policies');
    await page.settle();
    assert.equal(page.toast(), 'This request was refused because it did not come from the admin page. Reload the page and try again.');
  });

  it('returns to sign-in on a 401, at load or from a retry', async () => {
    const atLoad = adminPage((path) => (path === '/auth/session' ? UNAUTHORIZED : DATA[path]));
    await atLoad.settle();
    assert.equal(JSON.stringify(atLoad.view()), JSON.stringify({ login: true, app: false, notice: '', connection: 'Disconnected' }));
    assert.equal(atLoad.pendingRetry(), null);

    let session = UNAVAILABLE;
    const retried = adminPage((path) => (path === '/auth/session' ? session : DATA[path]));
    await retried.settle();
    session = UNAUTHORIZED;
    await retried.advance(30_000);
    assert.equal(JSON.stringify(retried.view()), JSON.stringify({ login: true, app: false, notice: '', connection: 'Disconnected' }));
    assert.equal(retried.pendingRetry(), null);
  });

  it('returns to sign-in on a 401 from an API call', async () => {
    const page = adminPage((path) => (path.startsWith('/v1/reconcile') ? UNAUTHORIZED : DATA[path]));
    await page.settle();
    page.click('reconcile-policies');
    await page.settle();
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: true, app: false, notice: '', connection: 'Disconnected' }));
  });
});

describe('admin UI answers that arrive after the session changed', () => {
  const SIGNED_OUT = JSON.stringify({ login: true, app: false, notice: '', connection: 'Disconnected' });

  it('ignores a late 503 after a sign-out: no notice, no retry, the sign-in form stays', async () => {
    const sync = deferred();
    const page = adminPage((path) => (path === '/v1/library/sync' ? sync.promise : path === '/auth/logout' ? { status: 200, body: {} } : DATA[path]));
    await page.settle();
    page.click('sync-library');
    await page.settle();
    page.click('logout');
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);

    sync.resolve(UNAVAILABLE);
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(page.pendingRetry(), null);
    assert.equal(page.toast(), '');
    await page.advance(600_000);
    assert.equal(SESSION_CHECKS(page), 1);
  });

  it('ignores a late 503 after a 401', async () => {
    const sync = deferred();
    const page = adminPage((path) => (path === '/v1/library/sync' ? sync.promise : path.startsWith('/v1/reconcile') ? UNAUTHORIZED : DATA[path]));
    await page.settle();
    page.click('sync-library');
    await page.settle();
    page.click('reconcile-policies');
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);

    sync.resolve(UNAVAILABLE);
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(page.pendingRetry(), null);
    assert.equal(page.toast(), 'Your session has ended. Sign in again.');
  });

  it('ignores a late 503 from a session check that was in flight at sign-out', async () => {
    const check = deferred();
    let session = DATA['/auth/session'];
    const page = adminPage((path) => (path === '/auth/session' ? session : path.startsWith('/v1/reconcile') ? UNAVAILABLE : path === '/auth/logout' ? { status: 200, body: {} } : DATA[path]));
    await page.settle();
    page.click('reconcile-policies');
    await page.settle();
    session = check.promise;
    await page.advance(30_000);
    assert.equal(SESSION_CHECKS(page), 2);
    page.click('logout');
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);

    check.resolve(UNAVAILABLE);
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(page.pendingRetry(), null);
  });

  it('does not show the app view or a toast for a late success after a sign-out', async () => {
    const sync = deferred();
    const grants = deferred();
    let session = UNAVAILABLE;
    const page = adminPage((path) => {
      if (path === '/auth/session') return session;
      if (path === '/v1/grants' && session !== UNAVAILABLE) return grants.promise;
      if (path === '/v1/library/sync') return sync.promise;
      if (path === '/auth/logout') return { status: 200, body: {} };
      return DATA[path];
    });
    await page.settle();
    // The retry's session check passes, and the data it loads is still on its way at sign-out.
    session = DATA['/auth/session'];
    await page.advance(30_000);
    assert.ok(page.requests.includes('GET /v1/grants'));
    page.click('sync-library');
    page.click('logout');
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);

    grants.resolve(DATA['/v1/grants']);
    sync.resolve(SYNCED);
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(page.toast(), '');
    assert.equal(page.pendingRetry(), null);
  });

  it('does not show the app view for a first load whose recent requests are answered after a sign-out', async () => {
    const recent = deferred();
    const page = adminPage((path) => (path === '/v1/requests/recent' ? recent.promise : path === '/auth/logout' ? { status: 200, body: {} } : DATA[path]));
    await page.settle();
    assert.ok(page.requests.includes('GET /v1/requests/recent'));
    page.click('logout');
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);

    recent.resolve(DATA['/v1/requests/recent']);
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(page.toast(), '');
  });

  it('shows the sign-in form for a 401 from recent requests during the first load', async () => {
    const page = adminPage((path) => (path === '/v1/requests/recent' ? UNAUTHORIZED : DATA[path]));
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(page.pendingRetry(), null);
  });

  it('still shows the app view with empty activity when only recent requests fail', async () => {
    const page = adminPage((path) => (path === '/v1/requests/recent' ? { status: 500, body: { error: 'boom' } } : DATA[path]));
    await page.settle();
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: true, notice: '', connection: 'Library sync required' }));
    assert.equal(page.toast(), '');
  });

  it('does not toast a request that fails after a sign-out', async () => {
    const sync = deferred();
    const page = adminPage((path) => (path === '/v1/library/sync' ? sync.promise : path === '/auth/logout' ? { status: 200, body: {} } : DATA[path]));
    await page.settle();
    page.click('sync-library');
    await page.settle();
    page.click('logout');
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);

    sync.reject(new TypeError('Failed to fetch'));
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(page.toast(), '');
    assert.equal(page.pendingRetry(), null);
  });

  it('still toasts a request that fails while the session lasts', async () => {
    const page = adminPage((path) => (path === '/v1/library/sync' ? Promise.reject(new TypeError('Failed to fetch')) : DATA[path]));
    await page.settle();
    page.click('sync-library');
    await page.settle();
    assert.equal(page.toast(), 'Failed to fetch');
  });

  it('does not toast a group deletion whose reload is answered after a sign-out', async () => {
    const group = { id: 'family', name: 'Family', userIds: [], householdUrl: null };
    const recent = deferred();
    let deleted = false;
    const page = adminPage((path, init) => {
      if (path === '/v1/groups/family' && init?.method === 'DELETE') { deleted = true; return { status: 200, body: {} }; }
      if (path === '/v1/groups') return { status: 200, body: { groups: deleted ? [] : [group] } };
      if (path === '/v1/requests/recent' && deleted) return recent.promise;
      if (path === '/auth/logout') return { status: 200, body: {} };
      return DATA[path];
    });
    await page.settle();
    const remove = [...page.document.querySelectorAll('#groups-list button')].find((button) => button.textContent === 'Delete');
    remove.dispatchEvent(new page.window.Event('click'));
    await page.settle();
    assert.ok(deleted);
    page.click('logout');
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);

    recent.resolve(DATA['/v1/requests/recent']);
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(page.toast(), '');
  });
});

describe('admin UI sign-in', () => {
  const SIGNED_OUT = JSON.stringify({ login: true, app: false, notice: '', connection: 'Disconnected' });
  const LOGGED_IN = { status: 200, body: { authenticated: true, username: 'admin' } };

  /** A page that starts signed out and submits the sign-in form once loaded. */
  async function signIn(answer) {
    const page = adminPage((path, init) => (path === '/auth/session' && !init?.method ? UNAUTHORIZED : answer(path, init)));
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    page.document.getElementById('username').value = 'admin';
    page.document.getElementById('password').value = 'secret';
    page.document.getElementById('login-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    return page;
  }
  const loginError = (page) => page.document.getElementById('login-error').textContent;

  it('says the session ended, not that the password was wrong, for a 401 while loading after sign-in', async () => {
    const page = await signIn((path) => (path === '/auth/login' ? LOGGED_IN : path === '/v1/groups' ? UNAUTHORIZED : DATA[path]));
    assert.ok(page.requests.includes('POST /auth/login'));
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(loginError(page), 'Your session has ended. Sign in again.');
    assert.equal(page.pendingRetry(), null);
  });

  it('still says the username or password was not accepted when the sign-in is refused', async () => {
    const page = await signIn((path) => (path === '/auth/login' ? { status: 401, body: { error: 'invalid_credentials' } } : DATA[path]));
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    assert.equal(loginError(page), 'That username or password was not accepted.');
    assert.ok(!page.requests.includes('GET /v1/grants'), 'nothing is loaded for a refused sign-in');
  });

  it('keeps the too-many-attempts wording for a rate-limited sign-in', async () => {
    const page = await signIn((path) => (path === '/auth/login' ? { status: 429, body: { error: 'too_many_login_attempts' } } : DATA[path]));
    assert.equal(loginError(page), 'Too many attempts. Try again later.');
  });

  it('shows the app view after a sign-in whose data loads', async () => {
    const page = await signIn((path) => (path === '/auth/login' ? LOGGED_IN : DATA[path]));
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: true, notice: '', connection: 'Library sync required' }));
    assert.equal(loginError(page), '');
  });

  it('ignores late answers from the first session after signing out and in again', async () => {
    const recent = deferred();
    let first = true;
    const page = await signIn((path) => {
      if (path === '/auth/login') return LOGGED_IN;
      if (path === '/auth/logout') return { status: 200, body: {} };
      if (path === '/v1/requests/recent' && first) return recent.promise;
      return DATA[path];
    });
    // The first sign-in's load is still waiting for recent requests when the administrator signs out.
    page.click('logout');
    await page.settle();
    assert.equal(JSON.stringify(page.view()), SIGNED_OUT);
    first = false;
    page.document.getElementById('login-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: true, notice: '', connection: 'Library sync required' }));

    recent.resolve(UNAUTHORIZED);
    await page.settle();
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: true, notice: '', connection: 'Library sync required' }));
    assert.equal(loginError(page), '');
    assert.equal(page.toast(), '');
  });
});

describe('admin UI Requests tab', () => {
  const row = (overrides = {}) => ({
    requestId: '7380001',
    mediaType: 'movie',
    tmdbId: 960001,
    title: 'Synthetic Film',
    year: 2020,
    seasons: [],
    status: 'requested',
    seerrStatus: 'pending',
    requester: { id: 'a11ce000a11ce000a11ce000a11ce000', name: 'Alice' },
    householdId: 'grove',
    householdName: 'Grove',
    requestedOn: '2026-10-20',
    followers: 1,
    households: [{ id: 'grove', name: 'Grove', status: 'requested' }, { id: 'heath', name: 'Heath', status: 'requested' }],
    withdrawn: false,
    held: false,
    actions: { approve: true, decline: true, cancel: true, removeFromRadarr: true },
    ...overrides,
  });
  const LISTING = {
    radarr: true,
    requests: [
      row(),
      row({ requestId: '7380002', mediaType: 'tv', tmdbId: 960002, title: 'Synthetic Show', seasons: [1, 2], seerrStatus: 'approved', requester: { id: 'b0b00000b0b00000b0b00000b0b00000', name: 'Bob' }, householdId: 'heath', householdName: 'Heath', followers: 0, households: [{ id: 'heath', name: 'Heath', status: 'requested' }], actions: { approve: false, decline: false, cancel: true, removeFromRadarr: false } }),
      row({ requestId: '7380003', tmdbId: 960003, title: 'Synthetic Declined', status: 'declined', seerrStatus: 'declined', followers: 0, households: [{ id: 'grove', name: 'Grove', status: 'declined' }], actions: { approve: false, decline: false, cancel: false, removeFromRadarr: false } }),
    ],
    held: [{ requestId: '7380009', itemId: '11110000111100001111000011110000', mediaType: 'movie', tmdbId: 960009, title: 'Synthetic Held', year: 2021, cancelledAt: '2026-10-01T10:00:00.000Z', grantedAt: '2026-10-05T10:00:00.000Z' }],
  };
  const GROUPS = { status: 200, body: { groups: [{ id: 'grove', name: 'Grove', userIds: [] }, { id: 'heath', name: 'Heath', userIds: [] }] } };

  /** A signed-in page whose Requests tab answers LISTING; `posts` gets every action with its body. */
  async function requestsPage(posts = [], answers = {}) {
    const page = adminPage((path, init) => {
      if (init?.method === 'POST') {
        posts.push([path, init.body ? JSON.parse(init.body) : undefined]);
        return answers[path] ?? { status: 200, body: { status: 'done', changed: true } };
      }
      if (path === '/v1/app/requests') return answers[path] ?? { status: 200, body: LISTING };
      if (path === '/v1/groups') return GROUPS;
      return DATA[path];
    });
    // linkedom has no <dialog> methods.
    page.window.HTMLElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    page.window.HTMLElement.prototype.close = function close() { this.removeAttribute('open'); };
    await page.settle();
    page.document.querySelector('.tabs button[data-tab="requests"]').dispatchEvent(new page.window.Event('click'));
    await page.settle();
    return page;
  }
  const titles = (page) => [...page.document.querySelectorAll('#household-requests-list .request-row h3')].map((heading) => heading.textContent);
  const button = (page, label) => [...page.document.querySelectorAll('#requests-panel button, dialog button')].find((entry) => entry.getAttribute('aria-label') === label || entry.textContent === label);
  const change = (page, id, value) => {
    page.document.getElementById(id).value = value;
    page.document.getElementById(id).dispatchEvent(new page.window.Event(id === 'requests-search' ? 'input' : 'change'));
  };

  it('loads the requests only when the tab is opened, and lists each with its requester, household and actions', async () => {
    const page = await requestsPage();
    assert.equal(page.requests.filter((request) => request === 'GET /v1/app/requests').length, 1);
    assert.equal(page.document.getElementById('requests-panel').hidden, false);
    assert.deepEqual(titles(page), ['Synthetic Film (2020)', 'Synthetic Show (2020)', 'Synthetic Declined (2020)']);
    const first = page.document.querySelector('#household-requests-list .request-row');
    assert.match(first.textContent, /Requested 2026-10-20 by Alice · Grove/);
    assert.match(first.textContent, /Grove, Heath · 1 following/);
    assert.deepEqual([...first.querySelectorAll('button')].map((entry) => entry.textContent), ['Approve', 'Decline', 'Cancel request']);
    assert.deepEqual([...page.document.querySelectorAll('#household-requests-list .request-row')][2].querySelectorAll('button').length, 0);
    assert.equal(page.document.getElementById('requests-count').textContent, '3');
    assert.match(page.document.getElementById('held-list').textContent, /Synthetic Held \(2021\).*Cancelled 2026-10-01 · arrived 2026-10-05/);
  });

  it('filters by household, status, type and title or requester, on the page', async () => {
    const page = await requestsPage();
    const listed = page.requests.length;
    change(page, 'requests-type', 'tv');
    assert.deepEqual(titles(page), ['Synthetic Show (2020)']);
    change(page, 'requests-type', '');
    change(page, 'requests-household', 'heath');
    assert.deepEqual(titles(page), ['Synthetic Film (2020)', 'Synthetic Show (2020)']);
    change(page, 'requests-household', '');
    change(page, 'requests-status', 'failed');
    assert.deepEqual(titles(page), ['Synthetic Declined (2020)']);
    change(page, 'requests-status', 'waiting');
    assert.deepEqual(titles(page), ['Synthetic Film (2020)', 'Synthetic Show (2020)']);
    change(page, 'requests-status', '');
    change(page, 'requests-search', 'bob');
    assert.deepEqual(titles(page), ['Synthetic Show (2020)']);
    assert.equal(page.document.getElementById('requests-summary').textContent, '1 of 3 requests shown');
    change(page, 'requests-search', 'nothing like it');
    assert.match(page.document.getElementById('household-requests-list').textContent, /No requests match/);
    assert.equal(page.requests.length, listed, 'filtering asks the server nothing');
  });

  it('confirms a cancel first, offers "Also remove from Radarr" only where the server does, and sends it only when ticked', async () => {
    const posts = [];
    const page = await requestsPage(posts);
    button(page, 'Cancel request: Synthetic Show (2020)').dispatchEvent(new page.window.Event('click'));
    const dialog = page.document.getElementById('request-action-dialog');
    assert.ok(dialog.hasAttribute('open'));
    assert.equal(page.document.getElementById('request-radarr-option').hidden, true, 'never for a series');
    assert.match(page.document.getElementById('request-action-text').textContent, /back to “Get this”/);
    assert.deepEqual(posts, [], 'nothing is sent before the confirmation');
    page.document.getElementById('request-action-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.deepEqual(posts, [['/v1/app/requests/7380002/cancel', undefined]]);

    button(page, 'Cancel request: Synthetic Film (2020)').dispatchEvent(new page.window.Event('click'));
    assert.equal(page.document.getElementById('request-radarr-option').hidden, false);
    page.document.getElementById('request-radarr').checked = true;
    page.document.getElementById('request-action-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.deepEqual(posts.at(-1), ['/v1/app/requests/7380001/cancel', { removeFromRadarr: true }]);
    assert.equal(page.requests.filter((request) => request === 'GET /v1/app/requests').length, 3, 'the list is read again after each action');
  });

  it('approves and declines after confirming, and shows a refusal as a sentence', async () => {
    const posts = [];
    const page = await requestsPage(posts, { '/v1/app/requests/7380001/decline': { status: 409, body: { error: 'only a pending request can be declined', code: 'request_not_pending' } } });
    button(page, 'Approve: Synthetic Film (2020)').dispatchEvent(new page.window.Event('click'));
    assert.equal(page.document.getElementById('request-radarr-option').hidden, true);
    page.document.getElementById('request-action-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.equal(page.toast(), 'Approved.');
    button(page, 'Decline: Synthetic Film (2020)').dispatchEvent(new page.window.Event('click'));
    page.document.getElementById('request-action-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.deepEqual(posts.map(([path]) => path), ['/v1/app/requests/7380001/approve', '/v1/app/requests/7380001/decline']);
    assert.equal(page.toast(), 'only a pending request can be declined');
  });

  it('releases a held title to the households chosen, and asks for one first', async () => {
    const posts = [];
    const page = await requestsPage(posts);
    const release = [...page.document.querySelectorAll('#held-list button')].find((entry) => entry.textContent === 'Release');
    release.dispatchEvent(new page.window.Event('click'));
    assert.ok(page.document.getElementById('release-dialog').hasAttribute('open'));
    page.document.getElementById('release-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.equal(page.document.getElementById('release-error').textContent, 'Choose at least one household.');
    assert.deepEqual(posts, []);
    // linkedom matches :checked by the attribute.
    page.document.querySelector('#release-options input[value="heath"]').setAttribute('checked', '');
    page.document.getElementById('release-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.deepEqual(posts, [['/v1/app/held/7380009/release', { householdIds: ['heath'] }]]);
    assert.equal(page.toast(), 'Released to Heath.');
  });

  it('says so when the server has no requests to show, and puts no secret in the page', async () => {
    const page = await requestsPage([], { '/v1/app/requests': { status: 404, body: { error: 'requests_not_configured' } } });
    assert.match(page.document.getElementById('household-requests-list').textContent, /Requests unavailable.*Requests need the household app and Seerr\./);
    assert.doesNotMatch(page.document.documentElement.outerHTML, /apiKey|admin-secret|X-Api-Key/i);
  });

  it('gives every element of the page its own ID', () => {
    const { document } = parseHTML(ADMIN_HTML);
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    assert.ok(ids.length > 50);
    assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
  });

  it('still lists a grant\'s Seerr requests in the Grants dialog once the Requests tab was shown', async () => {
    const grant = {
      itemId: '22220000222200002222000022220000', mediaType: 'movie', requests: { 7380001: 'a11ce000a11ce000a11ce000a11ce000' },
      manualUserIds: [], groupIds: [], owners: ['a11ce000a11ce000a11ce000a11ce000'], sync: { state: 'synced', attempts: 0 }, updatedAt: '2026-10-20T10:00:00.000Z', active: true,
    };
    const page = adminPage((path, init) => {
      if (init?.method === 'POST') return { status: 200, body: {} };
      if (path === '/v1/app/requests') return { status: 200, body: LISTING };
      if (path === '/v1/groups') return GROUPS;
      if (path === '/v1/grants') return { status: 200, body: { grants: [grant] } };
      return DATA[path];
    });
    page.window.HTMLElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    page.window.HTMLElement.prototype.close = function close() { this.removeAttribute('open'); };
    await page.settle();
    page.document.querySelector('.tabs button[data-tab="requests"]').dispatchEvent(new page.window.Event('click'));
    await page.settle();
    page.document.querySelector('.tabs button[data-tab="grants"]').dispatchEvent(new page.window.Event('click'));
    await page.settle();
    [...page.document.querySelectorAll('#grants-list button')].find((entry) => entry.textContent === 'Requests').dispatchEvent(new page.window.Event('click'));
    assert.equal(page.document.getElementById('requests-dialog').hasAttribute('open'), true);
    assert.match(page.document.getElementById('requests-list').textContent, /Request 7380001/);
    assert.equal(page.document.querySelectorAll('#requests-dialog .request-row').length, 1);
    assert.equal(page.document.querySelectorAll('#household-requests-list .request-row').length, 3);
  });
});

describe('admin deployment self-check UI', () => {
  it('runs only on demand and renders upstream explanations as text', async () => {
    const page = adminPage((path) => path === '/v1/self-check' ? { status: 200, body: { results: [{ check: 'origin', status: 'warn', explanation: '<script>untrusted</script>' }] } } : DATA[path]);
    await page.settle();
    assert.ok(!page.requests.includes('POST /v1/self-check'));
    page.click('run-self-check');
    await page.settle();
    assert.ok(page.requests.includes('POST /v1/self-check'));
    const output = page.document.getElementById('self-check-results');
    assert.equal(output.textContent, 'WARN — origin: <script>untrusted</script>');
    assert.equal(output.querySelector('script'), null);
  });
});

it('warns administrators about recent refused removed-form webhooks', async () => {
  const page = adminPage((path) => path === '/v1/webhooks/status'
    ? { status: 200, body: { lastRemovedFormAt: Date.now() } } : DATA[path]);
  await page.settle();
  assert.match(page.document.querySelector('#connection').textContent, /Seerr webhook refused/);
  assert.match(page.document.querySelector('#connection').textContent, /Library sync required/);
});

describe('admin UI household address editor', () => {
  const GROUP = { id: 'grove', name: 'Grove', userIds: [], householdUrl: 'https://media.example.com', householdAddresses: ['https://media.example.com'] };
  async function addressPage(answers) {
    const sent = [];
    const page = adminPage((path, init) => {
      if (init?.method === 'PUT' || init?.method === 'DELETE') {
        sent.push([init.method, path, init.body ? JSON.parse(init.body) : undefined]);
        return answers.write?.(init.method, path, init.body ? JSON.parse(init.body) : undefined) ?? { status: 200, body: { status: 'saved' } };
      }
      if (path === '/v1/groups/grove/addresses') return { status: 200, body: answers.current };
      if (path === '/v1/groups') return { status: 200, body: { groups: [answers.group ?? GROUP] } };
      return DATA[path];
    });
    page.window.HTMLElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    page.window.HTMLElement.prototype.close = function close() { this.removeAttribute('open'); };
    await page.settle();
    const open = [...page.document.querySelectorAll('#groups-list button')].find((button) => button.textContent === 'Addresses');
    open.dispatchEvent(new page.window.Event('click'));
    await page.settle();
    return { page, sent, byId: (id) => page.document.getElementById(id) };
  }

  it('opens with the household\'s addresses, saves the main one and the others, and reloads', async () => {
    const { page, sent, byId } = await addressPage({ current: { groupId: 'grove', gateway: true, origin: 'https://media.example.com', aliases: ['https://films.example.net:8443'], legacy: 'https://jelly-grove.example.test' } });
    assert.equal(byId('address-dialog').hasAttribute('open'), true);
    assert.equal(byId('address-origin').value, 'https://media.example.com');
    assert.equal(byId('address-aliases').value, 'https://films.example.net:8443');
    assert.match(byId('address-legacy').textContent, /jelly-grove\.example\.test.*HOUSEHOLD_DOMAIN/);
    assert.equal(byId('address-gateway-off').hidden, true);
    byId('address-origin').value = ' https://watch.example.com ';
    byId('address-aliases').value = 'https://films.example.net:8443\n\nhttps://tv.example.org, ';
    byId('address-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.deepEqual(sent, [['PUT', '/v1/groups/grove/addresses', { origin: 'https://watch.example.com', aliases: ['https://films.example.net:8443', 'https://tv.example.org'] }]]);
    assert.equal(byId('address-dialog').hasAttribute('open'), false);
    assert.equal(page.toast(), 'Addresses saved');
  });

  it('shows the server\'s refusal of an invalid or conflicting address in the dialog and keeps it open', async () => {
    const { page, byId } = await addressPage({
      current: { groupId: 'grove', gateway: false, aliases: [] },
      write: () => ({ status: 409, body: { error: 'https://media.example.com is an address of both household heath and household grove', code: 'address_conflict' } }),
    });
    assert.equal(byId('address-gateway-off').hidden, false);
    assert.equal(byId('address-remove').hidden, true);
    byId('address-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.equal(byId('address-error').textContent, 'Enter an address, or use Remove addresses.');
    byId('address-origin').value = 'https://media.example.com';
    byId('address-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.equal(byId('address-error').textContent, 'https://media.example.com is an address of both household heath and household grove');
    assert.equal(byId('address-dialog').hasAttribute('open'), true);
  });

  it('warns for saved HTTP addresses and aliases, updates while typing, and permits saving', async () => {
    const origin = 'http://media.example.com';
    const { page, sent, byId } = await addressPage({
      current: { origin, aliases: [] },
      group: { ...GROUP, householdUrl: origin, householdAddresses: [origin, 'https://films.example.net'] },
    });
    const warning = byId('address-warning');
    assert.equal(warning.hasAttribute('hidden'), false);
    assert.match(warning.textContent, /This address uses http:/);
    assert.match(warning.textContent, /mobile app only connects over HTTPS/);
    assert.equal(page.document.querySelectorAll('#groups-list .address-warning').length, 1);
    assert.match(page.document.querySelector('#groups-list .address-warning').textContent, /mobile app unavailable/);
    assert.ok(page.document.querySelector('.household-route .address-warning'));
    assert.match(ADMIN_STYLES, /\.household-route \.address-warning\{color:var\(--amber\);font-size:11px;text-transform:none\}/);
    byId('address-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.equal(sent[0][2].origin, origin);
    assert.equal(byId('address-dialog').hasAttribute('open'), false);
    assert.equal(page.document.querySelectorAll('#groups-list .address-warning').length, 1);
    byId('address-origin').value = 'https://media.example.com';
    byId('address-origin').dispatchEvent(new page.window.Event('input'));
    assert.equal(warning.textContent, '');
    assert.equal(warning.hasAttribute('hidden'), false);
    byId('address-aliases').value = 'https://films.example.net\n HTTP://tv.example.org';
    byId('address-aliases').dispatchEvent(new page.window.Event('input'));
    assert.equal(warning.hasAttribute('hidden'), false);
    assert.match(warning.textContent, /This address uses http:/);
    byId('address-aliases').value = 'https://films.example.net';
    byId('address-aliases').dispatchEvent(new page.window.Event('input'));
    assert.equal(warning.textContent, '');
    assert.equal(warning.hasAttribute('hidden'), false);
  });

  it('does not warn for saved HTTPS addresses', async () => {
    const { page, byId } = await addressPage({ current: { origin: GROUP.householdUrl, aliases: ['https://films.example.net'] } });
    assert.equal(byId('address-warning').textContent, '');
    assert.equal(byId('address-warning').hasAttribute('hidden'), false);
    assert.equal(byId('address-warning').getAttribute('role'), 'status');
    assert.equal(byId('address-origin').getAttribute('aria-describedby'), 'address-warning');
    assert.equal(byId('address-aliases').getAttribute('aria-describedby'), 'address-warning');
    assert.equal(page.document.querySelectorAll('#groups-list .address-warning').length, 0);
  });

  it('removes the mapped addresses after confirming', async () => {
    const { page, sent, byId } = await addressPage({ current: { groupId: 'grove', gateway: true, origin: 'https://media.example.com', aliases: [] } });
    page.click('address-remove');
    await page.settle();
    assert.deepEqual(sent, [['DELETE', '/v1/groups/grove/addresses', undefined]]);
    assert.equal(page.toast(), 'Addresses removed');
  });

  it('links to the setup wizard once signed in', async () => {
    const { byId } = await addressPage({ current: { groupId: 'grove', gateway: true, aliases: [] } });
    assert.equal(byId('setup-link').hidden, false);
    assert.equal(byId('setup-link').getAttribute('href'), '/admin/setup/');
  });
});

describe('household feature controls', () => {
  it('saves both switches and restores the last saved value on refusal', async () => {
    const group = { id: 'grove', name: 'Grove', userIds: [], appEnabled: true, tvAddonEnabled: false };
    const writes = [];
    let refuse = false;
    const page = adminPage((path, init) => {
      if (path === '/v1/groups') return { status: 200, body: { groups: [group] } };
      if (path === '/v1/groups/grove/features') {
        writes.push(JSON.parse(init.body));
        return refuse ? { status: 400, body: { error: 'refused' } } : { status: 200, body: { group: { ...group, appEnabled: false, ...writes.at(-1) } } };
      }
      return DATA[path];
    });
    await page.settle();
    const app = page.document.querySelector('input[aria-label="Mobile app access"]');
    const tv = page.document.querySelector('input[aria-label="TV add-on injection"]');
    assert.equal(app.checked, true);
    assert.equal(tv.checked, false);
    tv.checked = true;
    tv.dispatchEvent(new page.window.Event('change'));
    await page.settle();
    assert.deepEqual(writes[0], { tvAddonEnabled: true });
    assert.equal(app.checked, false, 'refreshes the other flag changed in another tab');
    refuse = true;
    app.checked = true;
    app.dispatchEvent(new page.window.Event('change'));
    await page.settle();
    assert.equal(app.checked, false);
    assert.equal(tv.checked, true);
  });
});
