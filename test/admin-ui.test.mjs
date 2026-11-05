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
    // Destructive actions ask in the page's own dialogs, never with the browser's.
    confirm: () => { throw new Error('window.confirm is not used'); },
    prompt: () => { throw new Error('window.prompt is not used'); },
    // A real Date (a grant card formats its time), with the manual clock's now.
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, ms) => { const id = nextTimer++; timers.set(id, { at: now + (ms ?? 0), callback }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  window.scrollTo = () => {};
  // linkedom has no <dialog> methods: as in a browser, close() shuts the dialog at once and queues its "close" event.
  window.HTMLElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function close() {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    setImmediate(() => this.dispatchEvent(new window.Event('close')));
  };
  // linkedom has no `open` property either (the grant card's <details> sets it).
  Object.defineProperty(window.HTMLElement.prototype, 'open', {
    configurable: true,
    get() { return this.hasAttribute('open'); },
    set(value) { this.toggleAttribute('open', Boolean(value)); },
  });
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
    toast: () => byId('toast').querySelector('.toast-text')?.textContent ?? '',
    toastDetail: () => byId('toast').querySelector('.toast-detail')?.textContent ?? '',
    click: (id) => byId(id).dispatchEvent(new window.Event('click')),
    /** Escape on an open dialog: "cancel" fires at once, then the dialog closes (its "close" event queued). */
    escape(id) {
      const dialog = byId(id);
      if (dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }))) dialog.close();
    },
    /** Whether the dialog is open. */
    open: (id) => byId(id).hasAttribute('open'),
    /** Submits the form of an open in-page confirmation (confirm-dialog, or the plan dialog's Apply step). */
    async accept(id) {
      assert.ok(byId(id).hasAttribute('open'), id + ' is open');
      byId(id).querySelector('form').dispatchEvent(new window.Event('submit'));
      await this.settle();
    },
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
    await page.accept('confirm-dialog');
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

  it('says the household app is turned off when the server has no requests to list, and hides the rest of the tab', async () => {
    const page = await requestsPage([], { '/v1/app/requests': { status: 404, body: { error: 'requests_not_configured' } } });
    const list = page.document.getElementById('household-requests-list');
    assert.match(list.textContent, /^Household app is turned off/);
    assert.match(list.textContent, /Turn the household app on in Setup \(HOUSEHOLD_APP_ENABLED\)/);
    assert.match(list.textContent, /Grants → Request grants/);
    assert.doesNotMatch(list.textContent, /requests_not_configured|unavailable/);
    for (const id of ['requests-toolbar', 'refresh-requests', 'held-head', 'held-list']) assert.equal(page.document.getElementById(id).hidden, true, id);
    assert.equal(page.document.getElementById('requests-summary').textContent, '');
    assert.equal(page.document.getElementById('requests-count').textContent, 'off');
    assert.doesNotMatch(page.document.documentElement.outerHTML, /apiKey|admin-secret|X-Api-Key/i);
  });

  it('says requests are unavailable, with the reason, when Seerr cannot be read', async () => {
    const page = await requestsPage([], { '/v1/app/requests': { status: 503, body: { error: 'session_check_unavailable' } } });
    assert.match(page.document.getElementById('household-requests-list').textContent, /^Requests unavailable.*Jellyfin is temporarily unavailable/);
    assert.equal(page.document.getElementById('requests-toolbar').hidden, false);
    assert.equal(page.document.getElementById('held-list').hidden, false);
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
    await page.settle();
    page.document.querySelector('.tabs button[data-tab="requests"]').dispatchEvent(new page.window.Event('click'));
    await page.settle();
    page.document.querySelector('.tabs button[data-tab="grants"]').dispatchEvent(new page.window.Event('click'));
    await page.settle();
    [...page.document.querySelectorAll('#grants-list button')].find((entry) => entry.textContent === 'Request grants').dispatchEvent(new page.window.Event('click'));
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

  it('removes the mapped addresses after confirming in the page', async () => {
    const { page, sent } = await addressPage({ current: { groupId: 'grove', gateway: true, origin: 'https://media.example.com', aliases: [] } });
    page.click('address-remove');
    await page.settle();
    assert.equal(page.open('confirm-dialog'), true);
    assert.equal(page.document.getElementById('confirm-title').textContent, 'Remove addresses?');
    page.document.querySelector('#confirm-dialog .dialog-actions .dialog-close').dispatchEvent(new page.window.Event('click'));
    await page.settle();
    assert.deepEqual(sent, [], 'Cancel removes nothing');
    assert.equal(page.open('address-dialog'), true);
    page.click('address-remove');
    await page.settle();
    await page.accept('confirm-dialog');
    assert.deepEqual(sent, [['DELETE', '/v1/groups/grove/addresses', undefined]]);
    assert.equal(page.open('address-dialog'), false);
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

  it('shows the TV switch locked while TV_ADDON_HOUSEHOLDS decides it, and keeps it locked after an app switch save', async () => {
    const group = { id: 'grove', name: 'Grove', userIds: [], appEnabled: true, tvAddonEnabled: true, tvAddonLockedBy: ['TV_ADDON_HOUSEHOLDS'] };
    const writes = [];
    const page = adminPage((path, init) => {
      if (path === '/v1/groups') return { status: 200, body: { groups: [group] } };
      if (path === '/v1/groups/grove/features') {
        writes.push(JSON.parse(init.body));
        return { status: 200, body: { group: { ...group, ...writes.at(-1) } } };
      }
      return DATA[path];
    });
    await page.settle();
    const app = page.document.querySelector('input[aria-label="Mobile app access"]');
    const tv = page.document.querySelector('input[aria-label="TV add-on injection"]');
    assert.equal(tv.checked, true);
    assert.equal(tv.disabled, true);
    assert.equal(app.disabled, false);
    assert.match(tv.closest('label').textContent, /Set in the environment \(TV_ADDON_HOUSEHOLDS\), which wins over this switch\./);
    app.checked = false;
    app.dispatchEvent(new page.window.Event('change'));
    await page.settle();
    assert.deepEqual(writes, [{ appEnabled: false }]);
    assert.equal(tv.disabled, true, 'still locked after a save');
    assert.equal(app.disabled, false);
  });
});

describe('admin UI dashboard and copy', () => {
  it('shows the deployment self-check on the Dashboard tab only, styled by the stylesheet (the CSP allows no inline style)', async () => {
    const { document } = parseHTML(ADMIN_HTML);
    assert.doesNotMatch(ADMIN_HTML, /\sstyle=/, 'style-src \'self\' blocks inline styles');
    const panel = document.getElementById('self-check-title').closest('section');
    assert.equal(panel.className, 'panel self-check');
    assert.equal(panel.closest('#dashboard-panel'), document.getElementById('dashboard-panel'));
    assert.match(ADMIN_STYLES, /\.self-check\{padding:24px;margin-top:36px\}/);

    const page = adminPage((path) => DATA[path]);
    await page.settle();
    const visible = () => !page.document.getElementById('self-check-title').closest('.tab-panel').hidden;
    assert.equal(visible(), true);
    page.document.querySelector('.tabs button[data-tab="grants"]').dispatchEvent(new page.window.Event('click'));
    assert.equal(visible(), false);
  });

  it('shows a sentence, with the code as detail, when the self-check is not available', async () => {
    const page = adminPage((path) => path === '/v1/self-check' ? { status: 404, body: { error: 'self_check_not_configured' } } : DATA[path]);
    await page.settle();
    page.click('run-self-check');
    await page.settle();
    const output = page.document.getElementById('self-check-results');
    assert.equal(output.querySelector('.self-check-error').textContent, 'The deployment self-check is not available on this JellyPass.');
    assert.equal(output.querySelector('.self-check-detail').textContent, 'self_check_not_configured');
  });

  it('names the Dashboard\'s Seerr activity for what it is, and keeps the sign-in copy short', () => {
    const { document } = parseHTML(ADMIN_HTML);
    assert.equal(document.querySelector('#dashboard-panel .recent-head h2').textContent, 'Recent Seerr activity');
    assert.doesNotMatch(ADMIN_HTML, /successfully linked|Until household SSO|login-note|The right library/);
    assert.equal(document.querySelector('#login-view h1').textContent, 'Sign in to JellyPass');
    assert.doesNotMatch(ADMIN_STYLES, /\.token-row|\.brand-mark span|\.connection\.online|\.login-note/);
    assert.doesNotMatch(ADMIN_APP_JS, /'online'/);
  });

  it('labels the refused Seerr webhook warning as an upgrade step', async () => {
    const page = adminPage((path) => path === '/v1/webhooks/status' ? { status: 200, body: { lastRemovedFormAt: Date.now() } } : DATA[path]);
    await page.settle();
    assert.match(page.view().connection, /^Upgrade needed: Seerr webhook refused, update its header and template/);
  });
});

describe('admin UI error toasts', () => {
  const failing = (reply) => adminPage((path) => (path.startsWith('/v1/reconcile') ? reply : DATA[path]));

  it('shows a known code as its sentence with the code as detail', async () => {
    const page = failing({ status: 403, body: { error: 'cross_origin_request_refused' } });
    await page.settle();
    page.click('reconcile-policies');
    await page.settle();
    assert.equal(page.toast(), 'This request was refused because it did not come from the admin page. Reload the page and try again.');
    assert.equal(page.toastDetail(), 'cross_origin_request_refused');
  });

  it('shows an unknown code as a sentence, never as the message itself', async () => {
    const page = failing({ status: 404, body: { error: 'some_new_code' } });
    await page.settle();
    page.click('reconcile-policies');
    await page.settle();
    assert.equal(page.toast(), 'That is not available on this JellyPass.');
    assert.equal(page.toastDetail(), 'some_new_code');
  });

  it('turns an upstream failure into a sentence and keeps what it said as detail', async () => {
    const raw = 'Jellyfin GET /Users/ad00/Items/0dead returned 404: {}';
    const page = failing({ status: 502, body: { error: raw } });
    await page.settle();
    page.click('reconcile-policies');
    await page.settle();
    assert.equal(page.toast(), 'Jellyfin no longer has what JellyPass asked it for. Sync the library, then try again.');
    assert.equal(page.toastDetail(), raw);
  });

  it('shows a server sentence as it is, with no detail', async () => {
    const page = failing({ status: 400, body: { error: 'groupIds must be an array' } });
    await page.settle();
    page.click('reconcile-policies');
    await page.settle();
    assert.equal(page.toast(), 'groupIds must be an array');
    assert.equal(page.toastDetail(), '');
  });
});

describe('admin UI Jellyfin version alert', () => {
  const STATUS = { version: '13.0.0', supported: false, confirmation: 'unconfirmed', confirmedVersion: null, enforcement: 'refuse', householdHosts: 'refused', supportedReleases: ['10.11', '12'] };
  function versionPage(status, writes = []) {
    let current = status;
    return adminPage((path, init) => {
      if (path === '/v1/jellyfin/version') return { status: 200, body: current };
      if (path === '/v1/jellyfin/version/confirmation') {
        writes.push([init.method, init.body ? JSON.parse(init.body) : undefined]);
        current = init.method === 'PUT'
          ? { ...status, confirmation: 'confirmed', confirmedVersion: '13.0.0', householdHosts: 'serving' }
          : status;
        return { status: 200, body: current };
      }
      return DATA[path];
    });
  }

  it('always describes the enforced (refuse) behaviour: there is no warn-only copy', async () => {
    assert.doesNotMatch(ADMIN_APP_JS, /from JellyPass 4\.0\.0|keep serving/);
    // Even a status that reported warn (no JellyPass 4 does) reads as enforced.
    const page = versionPage({ ...STATUS, enforcement: 'warn' });
    await page.settle();
    assert.equal(page.document.getElementById('jellyfin-version-title').textContent, 'Household hosts are paused: Jellyfin 13.0.0 is not a tested version');
    assert.equal(page.document.getElementById('jellyfin-version-text').textContent, 'JellyPass is tested with Jellyfin 10.11.x and 12.x. Household hosts answer 503 until you allow this exact version; the household privacy checks were not tested against it.');
    assert.equal(page.document.getElementById('jellyfin-version-confirm').textContent, 'Allow Jellyfin 13.0.0');
  });

  it('allows the version only once the administrator confirms in the page, then offers Withdraw', async () => {
    const writes = [];
    const page = versionPage(STATUS, writes);
    await page.settle();
    page.click('jellyfin-version-confirm');
    await page.settle();
    assert.equal(page.open('confirm-dialog'), true);
    assert.equal(page.document.getElementById('confirm-accept').textContent, 'Allow Jellyfin 13.0.0');
    page.document.getElementById('confirm-dialog').close();
    await page.settle();
    assert.deepEqual(writes, [], 'closing the dialog allows nothing');

    page.click('jellyfin-version-confirm');
    await page.settle();
    await page.accept('confirm-dialog');
    assert.deepEqual(writes, [['PUT', { version: '13.0.0' }]]);
    assert.equal(page.toast(), 'Jellyfin 13.0.0 is allowed');
    assert.equal(page.document.getElementById('jellyfin-version-text').textContent, 'Household hosts serve on it because an administrator allowed it. JellyPass is tested with Jellyfin 10.11.x and 12.x.');
    assert.equal(page.document.getElementById('jellyfin-version-confirm').textContent, 'Withdraw');
    page.click('jellyfin-version-confirm');
    await page.settle();
    assert.deepEqual(writes.at(-1), ['DELETE', undefined]);
  });
});

describe('admin UI grants and in-page confirmations', () => {
  const GRANT_ID = '22220000222200002222000022220000';
  const NEW_ID = '33330000333300003333000033330000';
  const grant = (itemId, overrides = {}) => ({
    itemId, mediaType: 'movie', requests: { 7380001: 'a11ce000a11ce000a11ce000a11ce000' }, manualUserIds: [], groupIds: [],
    owners: ['a11ce000a11ce000a11ce000a11ce000'], sync: { state: 'synced', attempts: 0 }, updatedAt: '2026-10-20T10:00:00.000Z', active: true, ...overrides,
  });
  const PLAN = (itemId) => ({ itemId, itemName: 'Synthetic', item: { action: 'add-tag' }, users: [{ action: 'block', userName: 'Bob' }] });
  const ITEMS = [
    { id: GRANT_ID, name: 'Zebra Film', mediaType: 'movie', libraryId: 'lib', libraryName: 'Films' },
    { id: '44440000444400004444000044440000', name: 'Apple Film', mediaType: 'movie', libraryId: 'lib', libraryName: 'Films' },
  ];

  /** A signed-in page with grants; `sent` gets every write as [method, path, body]. */
  async function grantsPage(answers = {}, grants = [grant(GRANT_ID, { updatedAt: '2026-10-21T10:00:00.000Z' }), grant(ITEMS[1].id)]) {
    const sent = [];
    const page = adminPage((path, init) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') sent.push([method, path, init.body ? JSON.parse(init.body) : undefined]);
      const key = method + ' ' + path;
      if (answers[key]) return typeof answers[key] === 'function' ? answers[key](init) : answers[key];
      if (path === '/v1/grants') return { status: 200, body: { grants } };
      if (path === '/v1/library') return { status: 200, body: { items: ITEMS, lastSyncedAt: null } };
      if (path === '/v1/groups') return { status: 200, body: { groups: [{ id: 'grove', name: 'Grove', userIds: [] }] } };
      if (path.startsWith('/v1/library/poster')) return { status: 404, body: {} };
      return DATA[path] ?? (method === 'GET' ? { status: 404, body: { error: 'not_found' } } : { status: 200, body: {} });
    });
    await page.settle();
    page.document.querySelector('.tabs button[data-tab="grants"]').dispatchEvent(new page.window.Event('click'));
    return { page, sent, byId: (id) => page.document.getElementById(id) };
  }
  const cardButton = (page, title, label) => [...page.document.querySelectorAll('#grants-list .grant-card')]
    .find((card) => card.querySelector('h3').textContent === title)
    .querySelectorAll('button, summary')
    .values().find((entry) => entry.textContent === label);

  it('sorts grants by title and shows no "updated" time (a group save rewrites it on every grant)', async () => {
    const { page } = await grantsPage();
    assert.deepEqual([...page.document.querySelectorAll('#grants-list h3')].map((heading) => heading.textContent), ['Apple Film', 'Zebra Film']);
    assert.doesNotMatch(page.document.getElementById('grants-list').textContent, /updated/i);
    assert.match(page.document.getElementById('grants-list').textContent, /1 request grant(?!s)/);
  });

  it('labels the grant actions Plan, Request grants and Access, with Move behind More', async () => {
    const { page } = await grantsPage();
    const card = page.document.querySelector('#grants-list .grant-card');
    assert.deepEqual([...card.querySelectorAll('.card-actions > button')].map((entry) => entry.textContent), ['Plan', 'Request grants', 'Access']);
    const more = card.querySelector('.card-actions > details.card-more');
    assert.equal(more.querySelector('summary').textContent, 'More');
    assert.deepEqual([...more.querySelectorAll('.card-more-menu button')].map((entry) => entry.textContent), ['Move to another item…']);
  });

  it('applies a reconciliation only from the plan dialog\'s Apply step, and not when it is cancelled', async () => {
    const { page, sent, byId } = await grantsPage({ 'POST /v1/reconcile?dryRun=true': { status: 200, body: { plans: [PLAN(GRANT_ID)] } }, 'POST /v1/reconcile': { status: 200, body: { plans: [] } } });
    page.click('reconcile-policies');
    await page.settle();
    assert.equal(page.open('plan-dialog'), true);
    assert.equal(byId('plan-form').hidden, false);
    assert.equal(byId('plan-question').textContent, 'Apply 2 previewed reconciliation changes?');
    assert.equal(byId('plan-apply').textContent, 'Apply 2 changes');
    assert.equal(byId('plan-apply').disabled, false, 'its own button is not disabled by the preview');
    page.document.querySelector('#plan-dialog .dialog-head .dialog-close').dispatchEvent(new page.window.Event('click'));
    await page.settle();
    assert.deepEqual(sent.map(([method, path]) => method + ' ' + path), ['POST /v1/reconcile?dryRun=true']);

    page.click('reconcile-policies');
    await page.settle();
    await page.accept('plan-dialog');
    assert.deepEqual(sent.map(([method, path]) => method + ' ' + path), ['POST /v1/reconcile?dryRun=true', 'POST /v1/reconcile?dryRun=true', 'POST /v1/reconcile']);
    assert.equal(page.open('plan-dialog'), false);
    assert.equal(page.toast(), 'Policies reconciled');
  });

  it('only shows a reconciliation plan with nothing to apply', async () => {
    const { page, sent, byId } = await grantsPage({ 'POST /v1/reconcile?dryRun=true': { status: 200, body: { plans: [{ itemId: GRANT_ID, item: { action: 'none' }, users: [] }] } } });
    page.click('reconcile-policies');
    await page.settle();
    assert.equal(page.open('plan-dialog'), true);
    assert.equal(byId('plan-form').hidden, true);
    assert.equal(sent.length, 1);
  });

  it('revokes a request grant after its plan is applied', async () => {
    const path = '/v1/grants/' + GRANT_ID + '/requests/7380001';
    const { page, sent, byId } = await grantsPage({ ['DELETE ' + path + '?dryRun=true']: { status: 200, body: { result: { plan: PLAN(GRANT_ID) } } }, ['DELETE ' + path]: { status: 200, body: {} } });
    cardButton(page, 'Zebra Film', 'Request grants').dispatchEvent(new page.window.Event('click'));
    assert.equal(byId('requests-dialog-title').textContent, 'Request grants');
    page.document.querySelector('#requests-list button').dispatchEvent(new page.window.Event('click'));
    await page.settle();
    assert.equal(page.open('requests-dialog'), false);
    assert.equal(byId('plan-apply').textContent, 'Revoke');
    assert.equal(byId('plan-apply').className, 'button danger');
    assert.deepEqual(sent.map(([method, path]) => method + ' ' + path), ['DELETE ' + path + '?dryRun=true']);
    await page.accept('plan-dialog');
    assert.deepEqual(sent.map(([method, path]) => method + ' ' + path), ['DELETE ' + path + '?dryRun=true', 'DELETE ' + path]);
    assert.equal(page.toast(), 'Request grant revoked');
  });

  it('applies a shared-access change from the plan dialog', async () => {
    const { page, sent, byId } = await grantsPage({
      ['PUT /v1/grants/' + GRANT_ID + '/groups?dryRun=true']: { status: 200, body: { result: { plan: PLAN(GRANT_ID) } } },
      ['PUT /v1/grants/' + GRANT_ID + '/groups']: { status: 200, body: {} },
    });
    cardButton(page, 'Zebra Film', 'Access').dispatchEvent(new page.window.Event('click'));
    byId('access-form').dispatchEvent(new page.window.Event('submit'));
    await page.settle();
    assert.equal(byId('plan-apply').textContent, 'Apply changes');
    await page.accept('plan-dialog');
    assert.deepEqual(sent.map(([method, path]) => method + ' ' + path), ['PUT /v1/grants/' + GRANT_ID + '/groups?dryRun=true', 'PUT /v1/grants/' + GRANT_ID + '/groups']);
    assert.equal(page.toast(), 'Shared access updated');
  });

  it('deletes a group only after confirming in the page', async () => {
    const { page, sent, byId } = await grantsPage();
    const remove = () => [...page.document.querySelectorAll('#groups-list button')].find((entry) => entry.textContent === 'Delete').dispatchEvent(new page.window.Event('click'));
    remove();
    await page.settle();
    assert.equal(byId('confirm-title').textContent, 'Delete Grove?');
    assert.equal(byId('confirm-accept').textContent, 'Delete group');
    byId('confirm-dialog').close();
    await page.settle();
    assert.deepEqual(sent, []);
    remove();
    await page.settle();
    await page.accept('confirm-dialog');
    assert.deepEqual(sent, [['DELETE', '/v1/groups/grove', undefined]]);
    assert.equal(page.toast(), 'Group deleted');
  });

  describe('Move', () => {
    const REMAP = '/v1/grants/' + GRANT_ID + '/remap';
    const preview = { status: 200, body: { result: { sourcePlan: PLAN(GRANT_ID), plan: PLAN(NEW_ID) } } };
    async function openMove(answers) {
      const context = await grantsPage({
        'GET /v1/library/search?q=zeb': { status: 200, body: { items: [{ id: GRANT_ID, name: 'Zebra Film', mediaType: 'movie' }, { id: NEW_ID, name: 'Zebra Film', mediaType: 'movie', productionYear: 2021 }] } },
        ...answers,
      });
      cardButton(context.page, 'Zebra Film', 'Move to another item…').dispatchEvent(new context.page.window.Event('click'));
      return context;
    }
    async function search(page, value) {
      page.document.getElementById('move-search').value = value;
      page.document.getElementById('move-search').dispatchEvent(new page.window.Event('input'));
      await page.advance(250);
    }
    function pick(page, id) {
      const input = page.document.querySelector('#move-results input[value="' + id + '"]');
      input.checked = true;
      input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    }

    it('picks the new item from a Jellyfin search, previews the move, and moves it once applied', async () => {
      const { page, sent, byId } = await openMove({ ['POST ' + REMAP + '?dryRun=true']: preview, ['POST ' + REMAP]: { status: 200, body: {} } });
      assert.equal(page.open('move-dialog'), true);
      assert.equal(byId('move-source').textContent, 'From Zebra Film · ' + GRANT_ID);
      assert.equal(byId('move-preview').disabled, true);
      await search(page, 'z');
      assert.ok(!page.requests.some((request) => request.startsWith('GET /v1/library/search')), 'one character searches nothing');
      await search(page, 'zeb');
      assert.ok(page.requests.includes('GET /v1/library/search?q=zeb'));
      const options = [...page.document.querySelectorAll('#move-results input')].map((input) => input.value);
      assert.deepEqual(options, [NEW_ID], 'the grant\'s own item is not offered');
      assert.match(byId('move-results').textContent, /Zebra Film \(2021\)/);
      pick(page, NEW_ID);
      assert.equal(byId('move-preview').disabled, false);
      byId('move-form').dispatchEvent(new page.window.Event('submit'));
      await page.settle();
      assert.deepEqual(sent, [['POST', REMAP + '?dryRun=true', { toItemId: NEW_ID }]]);
      assert.equal(page.open('move-dialog'), false);
      assert.equal(byId('plan-title').textContent, 'Move plan');
      assert.equal(byId('plan-apply').textContent, 'Move grant');
      await page.accept('plan-dialog');
      assert.deepEqual(sent.at(-1), ['POST', REMAP, { toItemId: NEW_ID }]);
      assert.equal(page.toast(), 'Grant moved');
    });

    it('takes a pasted Jellyfin item ID without searching', async () => {
      const { page, sent, byId } = await openMove({ ['POST ' + REMAP + '?dryRun=true']: preview });
      await search(page, NEW_ID);
      assert.ok(!page.requests.some((request) => request.startsWith('GET /v1/library/search')));
      pick(page, NEW_ID);
      byId('move-form').dispatchEvent(new page.window.Event('submit'));
      await page.settle();
      assert.deepEqual(sent, [['POST', REMAP + '?dryRun=true', { toItemId: NEW_ID }]]);
    });

    it('keeps the dialog open with the reason when the move is refused', async () => {
      const { page, sent, byId } = await openMove({ ['POST ' + REMAP + '?dryRun=true']: { status: 409, body: { error: 'source exists', code: 'source_item_exists' } } });
      await search(page, 'zeb');
      pick(page, NEW_ID);
      byId('move-form').dispatchEvent(new page.window.Event('submit'));
      await page.settle();
      assert.equal(page.open('move-dialog'), true);
      assert.match(byId('move-error').textContent, /^Not moved: 2222.* still exists in Jellyfin/);
      assert.equal(page.open('plan-dialog'), false);
      assert.equal(sent.length, 1);
    });
  });

  describe('previews that answer after their dialog was closed or changed', () => {
    const OTHER_ID = '55550000555500005555000055550000';
    const REMAP = '/v1/grants/' + GRANT_ID + '/remap';
    const ACCESS = '/v1/grants/' + GRANT_ID + '/groups';
    const REVOKE = '/v1/grants/' + GRANT_ID + '/requests/7380001';
    const OK = (body) => ({ status: 200, body });
    const GROUPS = OK({ groups: [{ id: 'grove', name: 'Grove', userIds: [] }, { id: 'heath', name: 'Heath', userIds: [] }] });
    /** Every dry run held back until the test answers it: `calls[n].resolve(reply)`. */
    function held() {
      const calls = [];
      return { calls, answer: () => { const call = deferred(); calls.push(call); return call.promise; } };
    }
    // Ways to shut a dialog while its preview is pending; `queued` resolves the preview before the queued "close" fires.
    const SHUT = {
      'closed with ×': (page, id) => page.document.querySelector('#' + id + ' .dialog-head .dialog-close').dispatchEvent(new page.window.Event('click')),
      'closed with Escape': (page, id) => page.escape(id),
    };
    const ORDERINGS = { 'after its close event': true, 'before its close event fires': false };
    const submit = (page, formId) => page.document.getElementById(formId).dispatchEvent(new page.window.Event('submit'));
    const check = (page, selector) => {
      const input = page.document.querySelector(selector);
      // linkedom's :checked reads the attribute, and its checked property is not reflected to it.
      const next = !input.hasAttribute('checked');
      input.toggleAttribute('checked', next);
      input.checked = next;
      input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    };
    function assertNoPlan(page, sent, writes) {
      assert.equal(page.open('plan-dialog'), false, 'no plan opens');
      assert.deepEqual(sent.map(([method, path]) => method + ' ' + path), writes, 'nothing is applied');
    }

    const FLOWS = {
      Move: {
        dialog: 'move-dialog',
        dryRun: 'POST ' + REMAP + '?dryRun=true',
        async start(answers) {
          const context = await grantsPage({
            'GET /v1/library/search?q=zeb': OK({ items: [{ id: NEW_ID, name: 'Zebra Film', mediaType: 'movie' }, { id: OTHER_ID, name: 'Zebra Film II', mediaType: 'movie' }] }),
            ['POST ' + REMAP]: OK({}),
            ...answers,
          });
          const { page } = context;
          cardButton(page, 'Zebra Film', 'Move to another item…').dispatchEvent(new page.window.Event('click'));
          page.document.getElementById('move-search').value = 'zeb';
          page.document.getElementById('move-search').dispatchEvent(new page.window.Event('input', { bubbles: true }));
          await page.advance(250);
          check(page, '#move-results input[value="' + NEW_ID + '"]');
          submit(page, 'move-form');
          await page.settle();
          return context;
        },
        change: (page) => check(page, '#move-results input[value="' + OTHER_ID + '"]'),
        reply: OK({ result: { sourcePlan: PLAN(GRANT_ID), plan: PLAN(NEW_ID) } }),
        applied: ['POST', REMAP, { toItemId: OTHER_ID }],
        form: 'move-form',
      },
      'Shared access': {
        dialog: 'access-dialog',
        dryRun: 'PUT ' + ACCESS + '?dryRun=true',
        async start(answers) {
          const context = await grantsPage({ 'GET /v1/groups': GROUPS, ['PUT ' + ACCESS]: OK({}), ...answers });
          cardButton(context.page, 'Zebra Film', 'Access').dispatchEvent(new context.page.window.Event('click'));
          submit(context.page, 'access-form');
          await context.page.settle();
          return context;
        },
        change: (page) => check(page, '#group-options input[value="heath"]'),
        reply: OK({ result: { plan: PLAN(GRANT_ID) } }),
        applied: ['PUT', ACCESS, { groupIds: ['heath'] }],
        form: 'access-form',
      },
      'Bulk access': {
        dialog: 'bulk-dialog',
        dryRun: 'PUT /v1/library/access?dryRun=true',
        async start(answers) {
          const context = await grantsPage({ 'GET /v1/groups': GROUPS, 'PUT /v1/library/access': OK({}), ...answers });
          const { page } = context;
          page.document.querySelector('.tabs button[data-tab="library"]').dispatchEvent(new page.window.Event('click'));
          const row = [...page.document.querySelectorAll('#catalog-list .catalog-row')].find((entry) => entry.textContent.includes('Zebra Film'));
          const box = row.querySelector('.catalog-check');
          box.checked = true;
          box.dispatchEvent(new page.window.Event('change'));
          page.click('bulk-access');
          page.document.querySelector('#bulk-group-options input[value="grove"]').toggleAttribute('checked', true);
          submit(page, 'bulk-form');
          await page.settle();
          return context;
        },
        change: (page) => check(page, '#bulk-group-options input[value="heath"]'),
        reply: OK({ result: { plans: [PLAN(GRANT_ID)] } }),
        applied: ['PUT', '/v1/library/access', { itemIds: [GRANT_ID], userIds: [], groupIds: ['grove', 'heath'] }],
        form: 'bulk-form',
      },
      'Request grant revocation': {
        dialog: 'requests-dialog',
        dryRun: 'DELETE ' + REVOKE + '?dryRun=true',
        async start(answers) {
          const context = await grantsPage({ ['DELETE ' + REVOKE]: OK({}), ...answers });
          cardButton(context.page, 'Zebra Film', 'Request grants').dispatchEvent(new context.page.window.Event('click'));
          context.page.document.querySelector('#requests-list button').dispatchEvent(new context.page.window.Event('click'));
          await context.page.settle();
          return context;
        },
        reply: OK({ result: { plan: PLAN(GRANT_ID) } }),
      },
    };

    for (const [name, flow] of Object.entries(FLOWS)) {
      for (const [way, shut] of Object.entries(SHUT)) {
        for (const [ordering, settleFirst] of Object.entries(ORDERINGS)) {
          it(name + ': a preview that answers after the dialog was ' + way + ' (' + ordering + ') opens no plan', async () => {
            const dry = held();
            const { page, sent } = await flow.start({ [flow.dryRun]: dry.answer });
            assert.equal(dry.calls.length, 1, 'the preview is pending');
            assert.equal(page.open(flow.dialog), true);
            shut(page, flow.dialog);
            if (settleFirst) await page.settle();
            dry.calls[0].resolve(flow.reply);
            await page.settle();
            assert.equal(page.open(flow.dialog), false);
            assertNoPlan(page, sent, [flow.dryRun]);
          });
        }
      }
      if (!flow.change) continue;
      it(name + ': a preview for input changed while it was pending is dropped, and Apply sends what the shown plan previewed', async () => {
        const dry = held();
        const { page, sent } = await flow.start({ [flow.dryRun]: dry.answer });
        flow.change(page);
        dry.calls[0].resolve(flow.reply);
        await page.settle();
        assertNoPlan(page, sent, [flow.dryRun]);
        assert.equal(page.open(flow.dialog), true, 'the changed form stays open');
        submit(page, flow.form);
        await page.settle();
        assert.equal(dry.calls.length, 2);
        dry.calls[1].resolve(flow.reply);
        await page.settle();
        assert.equal(page.open(flow.dialog), false);
        assert.equal(page.open('plan-dialog'), true);
        assert.deepEqual(sent[1].slice(2), [flow.applied[2]], 'the second preview is for the changed input');
        await page.accept('plan-dialog');
        assert.deepEqual(sent.at(-1), flow.applied);
      });
    }

    it('Move: a refusal that answers after the dialog was closed is not shown in the reopened dialog', async () => {
      const dry = held();
      const { page } = await FLOWS.Move.start({ [FLOWS.Move.dryRun]: dry.answer });
      page.escape('move-dialog');
      await page.settle();
      cardButton(page, 'Zebra Film', 'Move to another item…').dispatchEvent(new page.window.Event('click'));
      dry.calls[0].resolve({ status: 409, body: { error: 'source exists', code: 'source_item_exists' } });
      await page.settle();
      assert.equal(page.open('move-dialog'), true);
      assert.equal(page.document.getElementById('move-error').textContent, '');
      assert.equal(page.open('plan-dialog'), false);
    });
  });
});

describe('admin UI layout', () => {
  it('keeps the tab row, dialogs, group grid and card actions inside the viewport', () => {
    assert.match(ADMIN_STYLES, /\.tabs\{overflow-x:auto;/);
    assert.match(ADMIN_STYLES, /\.tabs button\{flex:0 0 auto;white-space:nowrap\}/);
    assert.match(ADMIN_STYLES, /\.dialog-actions\{flex-wrap:wrap;position:sticky;bottom:-26px;/);
    assert.match(ADMIN_STYLES, /\.dialog-actions \.button\{white-space:normal\}/);
    assert.match(ADMIN_STYLES, /\.group-grid\{grid-template-columns:repeat\(auto-fill,minmax\(min\(100%,340px\),1fr\)\)\}/);
    assert.match(ADMIN_STYLES, /\.grant-card \.card-actions,\.group-card \.card-actions\{flex-wrap:wrap\}/);
  });

  it('switches grant cards to the stacked layout below 1100px and scopes its column rules to grant cards', () => {
    assert.match(ADMIN_STYLES, /@media\(max-width:1100px\)\{\.grant-card\{grid-template-columns:56px minmax\(0,1fr\) minmax\(0,1fr\)\}/);
    // A bare .grant-main column rule would also move the Requests tab's rows (which reuse .grant-main).
    assert.doesNotMatch(ADMIN_STYLES, /[}{]\.grant-main\{grid-column/);
    assert.doesNotMatch(ADMIN_STYLES, /[}{,]\.grant-(?:poster|owners|access)\{grid-column/);
  });

  it('gives Requests-tab rows fixed columns and readable household text, and keeps the dialog rows as a flex list', () => {
    assert.match(ADMIN_STYLES, /@media\(min-width:901px\)\{\.request-rows>\.request-row\{grid-template-columns:minmax\(0,1\.5fr\) minmax\(0,1fr\) minmax\(0,\.9fr\) 300px\}\}/);
    assert.match(ADMIN_STYLES, /\.request-rows \.request-row small\{font-family:inherit;font-size:12px;/);
    assert.match(ADMIN_STYLES, /\.request-list>\.request-row\{display:flex;/);
  });

  it('shows a short health word on phones and keeps the full label for screen readers', async () => {
    assert.match(ADMIN_STYLES, /\.connection:after\{content:attr\(data-short\)\}/);
    const page = adminPage((path) => DATA[path]);
    await page.settle();
    const connection = page.document.getElementById('connection');
    assert.equal(connection.dataset.short, 'Attention', 'a never-synced library is a warning');
    assert.equal(connection.title, connection.querySelector('b').textContent);
  });

  it('renders household feature switches as .check labels with the lock note under the label', async () => {
    const group = { id: 'grove', name: 'Grove', userIds: [], appEnabled: true, tvAddonEnabled: true, tvAddonLockedBy: ['TV_ADDON_HOUSEHOLDS'] };
    const page = adminPage((path) => (path === '/v1/groups' ? { status: 200, body: { groups: [group] } } : DATA[path]));
    await page.settle();
    for (const name of ['Mobile app access', 'TV add-on injection']) {
      const label = page.document.querySelector('input[aria-label="' + name + '"]').closest('label');
      assert.ok(label.classList.contains('check'), name);
      assert.equal(label.firstElementChild.tagName, 'INPUT');
      assert.equal(label.querySelector('span > strong').textContent, name);
    }
    const note = page.document.querySelector('input[aria-label="TV add-on injection"]').closest('label').querySelector('span > small');
    assert.match(note.textContent, /Set in the environment/);
  });

  it('names the title in the grant dialogs and shows a missing title\'s item ID once', async () => {
    const known = 'a0000000000000000000000000000001';
    const missing = 'dead0000000000000000000000000002';
    const grant = (itemId) => ({ itemId, mediaType: 'movie', active: true, owners: [], groupIds: [], manualUserIds: [], requests: {}, sync: { state: 'synced' }, updatedAt: '2026-11-01T00:00:00Z' });
    const page = adminPage((path) => {
      if (path === '/v1/grants') return { status: 200, body: { grants: [grant(known), grant(missing)] } };
      if (path === '/v1/library') return { status: 200, body: { items: [{ id: known, name: 'Amber Road', mediaType: 'movie' }], lastSyncedAt: null } };
      return DATA[path];
    });
    page.window.HTMLElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    await page.settle();
    const cards = [...page.document.querySelectorAll('.grant-card')];
    const missingCard = cards.find((card) => card.textContent.includes(missing));
    assert.equal(missingCard.textContent.split(missing).length - 1, 1);
    const knownCard = cards.find((card) => card.textContent.includes('Amber Road'));
    [...knownCard.querySelectorAll('button')].find((button) => button.textContent === 'Access').dispatchEvent(new page.window.Event('click'));
    const heading = page.document.getElementById('access-item');
    assert.equal(heading.querySelector('strong').textContent, 'Amber Road');
    assert.equal(heading.querySelector('span').textContent, known);
  });
});

describe('household one-tap warning', () => {
  it('shows the security consequence beside the controls before enabling one-tap sign-in', async () => {
    const page = adminPage((path) => path === '/v1/users'
      ? { status: 200, body: { users: [{ id: 'member-id', name: 'Member', isAdministrator: false, passwordless: false }] } }
      : DATA[path]);
    await page.settle();
    const byId = (id) => page.document.getElementById(id);
    byId('new-group').dispatchEvent(new page.window.Event('click'));
    const options = byId('passwordless-options');
    assert.ok(byId('group-dialog').open);
    assert.equal(options.querySelector('input').hasAttribute('checked'), false);
    const hint = options.previousElementSibling;
    assert.equal(hint.className, 'hint');
    assert.equal(hint.hidden, false);
    assert.ok(hint.textContent.includes("With one-tap sign-in on, anyone who can reach this household's address can sign in as any passwordless member, with no password and no other check. Hiding a profile does not protect it: someone can still type the member's name."));
    assert.ok(hint.textContent.includes('If a marked user has a password, one-tap sign-in fails until you remove the mark; they can still sign in with their password.'));
  });
});
