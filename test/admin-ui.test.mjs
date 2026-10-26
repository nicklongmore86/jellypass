import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { ADMIN_APP_JS, ADMIN_HTML } from '../dist/admin-ui.js';

const UNAVAILABLE = { status: 503, body: { error: 'session_check_unavailable' } };
const UNAUTHORIZED = { status: 401, body: { error: 'unauthorized' } };
const DATA = {
  '/auth/session': { status: 200, body: { authenticated: true, username: 'admin' } },
  '/v1/grants': { status: 200, body: { grants: [] } },
  '/v1/groups': { status: 200, body: { groups: [] } },
  '/v1/users': { status: 200, body: { users: [], jellyseerrImportAvailable: false } },
  '/v1/library': { status: 200, body: { items: [], lastSyncedAt: null } },
  '/v1/requests/recent': { status: 200, body: { requests: [] } },
};

/**
 * The admin UI's script run against its own page, with fetch answered by `answer(path, init)` and a manual clock:
 * timers only run when `advance` passes their time.
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
    const reply = answer(path, init);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  const context = {
    window,
    document,
    history: {},
    fetch,
    Headers,
    URLSearchParams,
    Date: { now: () => now, parse: Date.parse },
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
    /** The retry timer's delay from now, in ms, or null when none is armed (the 4.2 s toast timer is not one). */
    pendingRetry() {
      const delays = [...timers.values()].map((timer) => timer.at - now).filter((ms) => ms >= 30_000);
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

  it('does not retry while the tab is hidden and resumes when it is shown', async () => {
    let session = UNAVAILABLE;
    const page = adminPage((path) => (path === '/auth/session' ? session : DATA[path]));
    await page.settle();
    await page.setVisibility('hidden');
    assert.equal(page.pendingRetry(), null);
    await page.advance(600_000);
    assert.equal(page.requests.filter((request) => request === 'GET /auth/session').length, 1);
    session = DATA['/auth/session'];
    await page.setVisibility('visible');
    await page.advance(0);
    assert.equal(page.requests.filter((request) => request === 'GET /auth/session').length, 2);
    assert.equal(JSON.stringify(page.view()), JSON.stringify({ login: false, app: true, notice: '', connection: 'Library sync required' }));
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
