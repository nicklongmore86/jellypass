import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { AccessService } from '../dist/access-service.js';
import { loadConfig } from '../dist/config.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { makeServers, makeSetupServer } from '../dist/server.js';
import { mergedEnvironment, missingRequired, readAdminTokenFile, settingsPaths, SettingsStore, setupRequired } from '../dist/settings.js';
import { MAX_RESPONSE_BYTES, SEERR_MEDIA_AVAILABLE, SetupWizard } from '../dist/setup.js';
import { SETUP_APP_JS, SETUP_HTML } from '../dist/setup-ui.js';
import { GrantStore } from '../dist/store.js';
import { createSetupJellyfin, createSetupSeerr, createSetupTmdb, SECRETS } from './support/setup-fakes.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const BEARER = { Authorization: `Bearer ${SECRETS.adminToken}` };

/** Every value that must never leave the server: the fixed secrets, and those made during a test (keys, tokens). */
function assertNoSecret(text, extra = []) {
  for (const secret of [...Object.values(SECRETS), ...extra].filter(Boolean)) {
    assert.ok(!String(text).includes(secret), `a secret leaked: ${String(text).slice(0, 200)}`);
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A setup-mode listener with a wizard over a fresh settings file; `answers` collects every response body. */
async function setupMode(t, { environment = {}, mode = 'setup' } = {}) {
  const directory = await makeTempDir(t, 'jfa-setup-');
  const file = path.join(directory, 'settings.json');
  const settings = await SettingsStore.load(file);
  const applied = [];
  const logs = [];
  const tmdb = await createSetupTmdb();
  const wizard = new SetupWizard({
    settings,
    environment,
    mode,
    adminTokenSource: 'file',
    apply: () => applied.push(Date.now()),
    tmdbBaseUrl: tmdb.url,
    log: (message, fields) => logs.push(JSON.stringify({ message, ...fields })),
  });
  const server = makeSetupServer({ setup: wizard, adminToken: SECRETS.adminToken });
  const base = await listen(server);
  const answers = [];
  t.after(async () => { await closeServer(server); await tmdb.close(); });
  const call = async (pathname, { method = 'POST', body, headers = BEARER } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
  };
  return { base, file, settings, wizard, applied, logs, answers, call, tmdb };
}

describe('setup settings: stored settings under the environment', () => {
  it('lets every variable the environment sets win, and never lets a stored choice override HOUSEHOLD_DOMAIN', () => {
    const stored = { version: 1, createdAt: '2026-10-31T00:00:00.000Z', jellyfinUrl: 'http://stored:8096', jellyfinApiKey: 'stored-key', webhookToken: 'stored-token', householdGatewayEnabled: false, trustedProxies: '10.0.0.1' };
    const merged = mergedEnvironment({ JELLYFIN_URL: 'http://env:8096', HOUSEHOLD_DOMAIN: 'example.com', TRUSTED_PROXIES: ' ' }, stored, 'file-token');
    assert.equal(merged.JELLYFIN_URL, 'http://env:8096');
    assert.equal(merged.JELLYFIN_API_KEY, 'stored-key');
    assert.equal(merged.WEBHOOK_TOKEN, 'stored-token');
    assert.equal(merged.HOUSEHOLD_GATEWAY_ENABLED, undefined);
    // A blank variable is not set, as loadConfig reads it.
    assert.equal(merged.TRUSTED_PROXIES, '10.0.0.1');
    assert.equal(merged.ADMIN_TOKEN, 'file-token');
    assert.equal(mergedEnvironment({ ADMIN_TOKEN: 'env-admin' }, stored, 'file-token').ADMIN_TOKEN, 'env-admin');
    assert.deepEqual(missingRequired(mergedEnvironment({}, undefined)), ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'WEBHOOK_TOKEN']);
    assert.deepEqual(missingRequired(merged), []);
    const config = loadConfig({ ...merged, HOUSEHOLD_DOMAIN: '' });
    assert.equal(config.jellyfinUrl, 'http://env:8096');
    assert.equal(config.jellyfinApiKey, 'stored-key');
    assert.equal(config.adminToken, 'file-token');
    assert.equal(config.householdGatewayEnabled, false);
  });

  it('keeps the settings file next to the state file unless SETTINGS_FILE names another', () => {
    assert.deepEqual(settingsPaths({ STATE_FILE: '/srv/jp/grants.json' }), { settingsFile: '/srv/jp/settings.json', adminTokenFile: '/srv/jp/admin-token' });
    assert.deepEqual(settingsPaths({ STATE_FILE: '/srv/jp/grants.json', SETTINGS_FILE: '/etc/jp/settings.json' }), { settingsFile: '/etc/jp/settings.json', adminTokenFile: '/etc/jp/admin-token' });
  });

  it('creates no file by reading, writes it whole with mode 0600, and refuses a broken one without quoting it', async (t) => {
    const directory = await makeTempDir(t, 'jfa-settings-');
    const file = path.join(directory, 'settings.json');
    const settings = await SettingsStore.load(file);
    assert.equal(settings.current, undefined);
    await assert.rejects(stat(file), { code: 'ENOENT' });
    await settings.update(() => ({ jellyfinApiKey: 'stored-secret-key' }));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.ok(Date.parse(saved.createdAt));
    assert.equal((await SettingsStore.load(file)).current.jellyfinApiKey, 'stored-secret-key');
    await settings.update(() => ({ jellyfinApiKey: undefined }));
    assert.equal('jellyfinApiKey' in JSON.parse(await readFile(file, 'utf8')), false);
    await writeFile(file, JSON.stringify({ version: 1, createdAt: saved.createdAt, seerrApiKey: 42, webhookToken: 'leak-me-not' }));
    await assert.rejects(SettingsStore.load(file), (error) => /invalid seerrApiKey/.test(error.message) && !error.message.includes('leak-me-not'));
    await writeFile(file, '{"version":2}');
    await assert.rejects(SettingsStore.load(file), /unsupported version/);
  });

  it('makes the setup token file once, mode 0600, and reads the same token after', async (t) => {
    const directory = await makeTempDir(t, 'jfa-token-');
    const file = path.join(directory, 'admin-token');
    assert.equal(await readAdminTokenFile(file, { create: false }), undefined);
    const token = await readAdminTokenFile(file, { create: true });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await readAdminTokenFile(file, { create: true }), token);
    await writeFile(file, 'short\n');
    await assert.rejects(readAdminTokenFile(file, { create: false }), /does not hold a setup token/);
  });
});

describe('setup wizard: authentication and setup mode', () => {
  it('needs ADMIN_TOKEN as a bearer token for every /v1/setup call; a cookie, a wrong token or none is 401', async (t) => {
    const { call } = await setupMode(t);
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Cookie: '__Host-jellypass_session=anything; jellypass_session=anything' }, { Authorization: SECRETS.adminToken }]) {
      assert.equal((await call('/v1/setup', { method: 'GET', headers })).status, headers.Authorization === SECRETS.adminToken ? 200 : 401, JSON.stringify(headers));
      for (const step of ['jellyfin', 'seerr', 'webhook', 'secrets', 'tmdb', 'backfill', 'household', 'finish']) {
        const answer = await call(`/v1/setup/${step}`, { headers, body: {} });
        if (headers.Authorization !== SECRETS.adminToken) assert.deepEqual([answer.status, answer.body], [401, { error: 'unauthorized' }], step);
      }
    }
  });

  it('serves the wizard page, styles and health, and answers every other admin path 503 setup_required', async (t) => {
    const { base, call } = await setupMode(t);
    const redirect = await fetch(`${base}/admin/`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/admin/setup/');
    const page = await fetch(`${base}/admin/setup/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), /Set up JellyPass/);
    assert.equal((await fetch(`${base}/admin/setup.js`)).status, 200);
    assert.equal((await fetch(`${base}/admin/styles.css`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok', setup: 'required' });
    for (const [method, pathname] of [['GET', '/v1/grants'], ['GET', '/v1/groups'], ['GET', '/metrics'], ['PUT', '/v1/groups/grove/addresses'], ['POST', '/auth/login']]) {
      const answer = await call(pathname, { method, body: method === 'GET' ? undefined : {} });
      assert.deepEqual([answer.status, answer.body], [503, { error: 'setup_required' }], pathname);
    }
  });
});

describe('setup wizard: steps', () => {
  let jellyfin;
  let seerr;
  before(async () => {
    jellyfin = await createSetupJellyfin();
    seerr = await createSetupSeerr();
  });
  after(async () => { await jellyfin.close(); await seerr.close(); });

  it('connects Jellyfin with an administrator\'s sign-in: creates a JellyPass key, signs out, stores no password, and keeps the key on a re-run', async (t) => {
    const { call, file, answers, logs } = await setupMode(t);
    const refused = await call('/v1/setup/jellyfin', { body: { url: jellyfin.url, username: 'admin', password: 'wrong' } });
    assert.deepEqual([refused.status, refused.body.error], [400, 'jellyfin_sign_in_refused']);
    const member = await call('/v1/setup/jellyfin', { body: { url: jellyfin.url, username: 'member', password: SECRETS.memberPassword } });
    assert.deepEqual([member.status, member.body.error], [403, 'jellyfin_not_administrator']);
    assert.equal(jellyfin.keys.length, 0);
    const missing = await call('/v1/setup/jellyfin', { body: { url: jellyfin.url } });
    assert.deepEqual([missing.status, missing.body.error], [400, 'jellyfin_credentials_required']);
    for (const url of ['jellyfin:8096', 'ftp://jellyfin', 'http://user:pw@jellyfin:8096', 'http://jellyfin:8096/?x=1']) {
      assert.deepEqual((await call('/v1/setup/jellyfin', { body: { url, username: 'admin', password: SECRETS.adminPassword } })).body.error, 'url_invalid', url);
    }
    const created = await call('/v1/setup/jellyfin', { body: { url: `${jellyfin.url}/`, username: 'admin', password: SECRETS.adminPassword } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual([created.body.status, created.body.url, created.body.keyName, created.body.version], ['created', jellyfin.url, 'JellyPass', '10.11.3']);
    assert.equal(jellyfin.keys.length, 1);
    assert.equal(jellyfin.keys[0].AppName, 'JellyPass');
    const key = jellyfin.keys[0].AccessToken;
    // Every session the wizard opened was signed out again, the refused member's included.
    assert.equal(jellyfin.requests.filter((entry) => entry.path === '/Sessions/Logout').length, 2);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.jellyfinApiKey, key);
    assert.equal(stored.jellyfinUrl, jellyfin.url);
    assert.ok(!JSON.stringify(stored).includes(SECRETS.adminPassword));
    assert.deepEqual(created.body.setup.steps.jellyfin, { url: jellyfin.url, apiKey: 'set', source: 'settings', createdByJellyPass: true, locked: false, fields: { url: false, apiKey: false }, lockedBy: [] });

    // Run again: the stored key still works, so no sign-in and no second key.
    const before = jellyfin.requests.length;
    const kept = await call('/v1/setup/jellyfin', { body: { url: jellyfin.url } });
    assert.deepEqual([kept.status, kept.body.status], [200, 'kept']);
    assert.equal(jellyfin.keys.length, 1);
    assert.equal(jellyfin.requests.slice(before).some((entry) => entry.path === '/Users/AuthenticateByName'), false);
    // A key revoked in Jellyfin is replaced on the next run.
    jellyfin.revoke(key);
    const replaced = await call('/v1/setup/jellyfin', { body: { url: jellyfin.url, username: 'admin', password: SECRETS.adminPassword } });
    assert.equal(replaced.body.status, 'created');
    assert.notEqual(JSON.parse(await readFile(file, 'utf8')).jellyfinApiKey, key);
    assertNoSecret(answers.join('\n') + logs.join('\n'), jellyfin.keys.map((entry) => entry.AccessToken).concat(key));
  });

  it('connects Seerr with an administrator key, keeps it on a re-run, and refuses a wrong one', async (t) => {
    const { call, file, answers } = await setupMode(t);
    const wrong = await call('/v1/setup/seerr', { body: { url: seerr.url, apiKey: 'not-the-key' } });
    assert.deepEqual([wrong.status, wrong.body.error], [400, 'seerr_key_refused']);
    const unreachable = await call('/v1/setup/seerr', { body: { url: 'http://127.0.0.1:1', apiKey: SECRETS.seerrKey } });
    assert.deepEqual([unreachable.status, unreachable.body.error], [502, 'seerr_unreachable']);
    const saved = await call('/v1/setup/seerr', { body: { url: seerr.url, apiKey: SECRETS.seerrKey } });
    assert.deepEqual([saved.status, saved.body.status, saved.body.version], [200, 'connected', '3.5.1']);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).seerrApiKey, SECRETS.seerrKey);
    const again = await call('/v1/setup/seerr', { body: { url: seerr.url } });
    assert.deepEqual([again.status, again.body.status], [200, 'connected']);
    assert.equal(again.body.setup.steps.seerr.apiKey, 'set');
    assertNoSecret(answers.join('\n'));
  });

  it('generates the webhook token once, points Seerr\'s webhook at JellyPass with it, and sees Seerr\'s test arrive', async (t) => {
    const { call, file, base, answers, logs } = await setupMode(t);
    assert.deepEqual((await call('/v1/setup/webhook', { body: { jellypassUrl: base } })).body.error, 'seerr_required');
    await call('/v1/setup/seerr', { body: { url: seerr.url, apiKey: SECRETS.seerrKey } });
    const secrets = await call('/v1/setup/secrets', { body: {} });
    assert.equal(secrets.body.webhookToken, 'generated');
    const token = JSON.parse(await readFile(file, 'utf8')).webhookToken;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await call('/v1/setup/secrets')).body.webhookToken, 'kept');
    const configured = await call('/v1/setup/webhook', { body: { jellypassUrl: `${base}/` } });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.deepEqual([configured.body.status, configured.body.url, configured.body.tested], ['configured', `${base}/webhooks/seerr`, true]);
    const webhook = seerr.state.webhook;
    assert.equal(webhook.enabled, true);
    assert.equal(webhook.types, SEERR_MEDIA_AVAILABLE);
    assert.equal(webhook.options.webhookUrl, `${base}/webhooks/seerr`);
    assert.equal(webhook.options.authHeader, `Bearer ${token}`);
    const template = JSON.parse(webhook.options.jsonPayload);
    assert.deepEqual(template.request.requestedBy, { jellyfinUserId: '{{requestedBy_jellyfinUserId}}', username: '{{requestedBy_username}}' });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).webhookToken, token, 'the token is never replaced');
    assert.equal(seerr.deliveries.at(-1).status, 202);
    // The setup listener answers only the test: a wrong token is 401, a real event is refused until setup finishes.
    const wrong = await fetch(`${base}/webhooks/seerr`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
    assert.equal(wrong.status, 401);
    const available = await fetch(`${base}/webhooks/seerr`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ notificationType: 'MEDIA_AVAILABLE', event: 'Movie Request Now Available', media: { jellyfinMediaId: 'a1', mediaType: 'movie' }, request: { id: '1', requestedBy: { jellyfinUserId: 'b2', username: 'x' } } }) });
    assert.equal(available.status, 503);
    assertNoSecret(answers.join('\n') + logs.join('\n'), [token]);
  });

  it('replaces another enabled Seerr webhook only when asked, and reports a test that did not reach JellyPass', async (t) => {
    const other = await createSetupSeerr({ webhook: { enabled: true, types: 8, options: { webhookUrl: 'https://hooks.example.net/path?token=leak-me-not', jsonPayload: '{}', customHeaders: [{ key: 'X-Kept', value: 'kept' }] } } });
    t.after(() => other.close());
    const { call, base, answers } = await setupMode(t);
    await call('/v1/setup/seerr', { body: { url: other.url, apiKey: SECRETS.seerrKey } });
    const refused = await call('/v1/setup/webhook', { body: { jellypassUrl: base } });
    assert.deepEqual([refused.status, refused.body.error, refused.body.currentHost], [409, 'seerr_webhook_in_use', 'hooks.example.net']);
    assert.equal(other.state.webhook.options.webhookUrl, 'https://hooks.example.net/path?token=leak-me-not');
    const unreachable = await call('/v1/setup/webhook', { body: { jellypassUrl: 'http://127.0.0.1:1', replace: true } });
    assert.deepEqual([unreachable.status, unreachable.body.tested], [200, false]);
    assert.deepEqual(other.state.webhook.options.customHeaders, [{ key: 'X-Kept', value: 'kept' }]);
    assert.equal(unreachable.body.setup.steps.seerr.webhook.tested, false);
    assertNoSecret(answers.join('\n'), ['leak-me-not']);
  });

  it('checks the TMDB key with TMDB before storing it, and removes it only while the app is off', async (t) => {
    const { call, file, answers } = await setupMode(t);
    assert.deepEqual((await call('/v1/setup/tmdb', { body: { apiKey: 'not a key' } })).body.error, 'tmdb_key_invalid');
    assert.deepEqual((await call('/v1/setup/tmdb', { body: { apiKey: 'deadbeefdeadbeefdeadbeefdeadbeef' } })).body.error, 'tmdb_key_refused');
    const saved = await call('/v1/setup/tmdb', { body: { apiKey: SECRETS.tmdbKey } });
    assert.deepEqual([saved.status, saved.body.status, saved.body.setup.steps.tmdb.apiKey], [200, 'validated', 'set']);
    assert.ok(saved.body.setup.steps.tmdb.validatedAt);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).tmdbApiKey, SECRETS.tmdbKey);
    assert.equal((await call('/v1/setup/tmdb', { body: { apiKey: null } })).body.status, 'removed');
    assertNoSecret(answers.join('\n'));
  });

  it('sets the backfill cutoff to the install date by default, or a date given, and needs Seerr', async (t) => {
    const { call, settings } = await setupMode(t);
    assert.equal((await call('/v1/setup/backfill', { body: {} })).body.error, 'seerr_required');
    await call('/v1/setup/seerr', { body: { url: seerr.url, apiKey: SECRETS.seerrKey } });
    const installed = settings.current.createdAt;
    const saved = await call('/v1/setup/backfill', { body: {} });
    assert.deepEqual([saved.status, saved.body.since, saved.body.setup.steps.backfill.enabled], [200, installed, true]);
    assert.equal((await call('/v1/setup/backfill', { body: { since: '2026-10-01' } })).body.since, '2026-10-01T00:00:00.000Z');
    assert.equal((await call('/v1/setup/backfill', { body: { since: '2026-02-30' } })).body.error, 'backfill_since_invalid');
    const off = await call('/v1/setup/backfill', { body: { since: null } });
    assert.deepEqual([off.body.status, off.body.setup.steps.backfill.enabled], ['off', false]);
  });

  it('turns household addresses on only with the reverse proxy named, and the app only with Seerr and TMDB', async (t) => {
    const { call } = await setupMode(t);
    assert.equal((await call('/v1/setup/household', { body: { gatewayEnabled: true } })).body.error, 'trusted_proxies_required');
    assert.equal((await call('/v1/setup/household', { body: { trustedProxies: 'not-an-ip' } })).body.error, 'trusted_proxies_invalid');
    const saved = await call('/v1/setup/household', { body: { gatewayEnabled: true, trustedProxies: '192.168.1.5, 10.0.0.0/8' } });
    assert.deepEqual(saved.body.setup.steps.household.trustedProxies, ['192.168.1.5', '10.0.0.0/8']);
    assert.equal(saved.body.setup.steps.household.gatewayEnabled, true);
    assert.equal((await call('/v1/setup/household', { body: { appEnabled: true } })).body.error, 'app_requirements_missing');
    await call('/v1/setup/seerr', { body: { url: seerr.url, apiKey: SECRETS.seerrKey } });
    await call('/v1/setup/tmdb', { body: { apiKey: SECRETS.tmdbKey } });
    assert.equal((await call('/v1/setup/household', { body: { appEnabled: true } })).body.status, 'saved');
    assert.equal((await call('/v1/setup/tmdb', { body: { apiKey: null } })).body.error, 'tmdb_required_by_app');
    assert.equal((await call('/v1/setup/household', { body: { surprise: true } })).body.error, 'invalid_request');
  });

  it('finishes only once the required settings are in and the whole configuration loads; a half-done wizard resumes', async (t) => {
    const first = await setupMode(t);
    const incomplete = await first.call('/v1/setup/finish');
    assert.deepEqual([incomplete.status, incomplete.body.error, incomplete.body.missing], [409, 'setup_incomplete', ['Jellyfin address', 'Jellyfin API key', 'webhook token']]);
    await first.call('/v1/setup/jellyfin', { body: { url: jellyfin.url, username: 'admin', password: SECRETS.adminPassword } });
    // Left half done: a new wizard over the same file (JellyPass restarted) picks up where it stopped.
    const settings = await SettingsStore.load(first.file);
    const applied = [];
    const second = new SetupWizard({ settings, environment: {}, mode: 'setup', adminTokenSource: 'file', apply: () => applied.push(1) });
    assert.deepEqual(second.status().missing, ['webhook token']);
    assert.equal(second.status().steps.jellyfin.apiKey, 'set');
    await second.secrets({});
    await second.household({ trustedProxies: '192.168.1.5' });
    await settings.update(() => ({ householdGatewayEnabled: true, householdAppEnabled: true }));
    await assert.rejects(second.finish({}), (error) => error.code === 'configuration_invalid' && /HOUSEHOLD_APP_ENABLED/.test(error.message));
    await settings.update(() => ({ householdAppEnabled: undefined }));
    assert.deepEqual(await second.finish({}), { status: 'restarting' });
    assert.ok(settings.current.setupCompletedAt);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(applied.length, 1);
    assert.deepEqual(await second.finish({}), { status: 'restarting' });
  });

  it('refuses to change a setting the environment sets, and shows it as locked', async (t) => {
    const { call } = await setupMode(t, { environment: { JELLYFIN_URL: 'http://env-jellyfin:8096', JELLYFIN_API_KEY: 'env-jellyfin-key', TMDB_API_KEY: SECRETS.tmdbKey, TRUSTED_PROXIES: '192.168.1.5', HOUSEHOLD_DOMAIN: 'example.com' } });
    const calls = jellyfin.requests.length;
    const locked = await call('/v1/setup/jellyfin', { body: { url: jellyfin.url, username: 'admin', password: SECRETS.adminPassword } });
    assert.deepEqual([locked.status, locked.body.error, locked.body.variables], [409, 'locked_by_environment', ['JELLYFIN_URL', 'JELLYFIN_API_KEY']]);
    assert.equal(jellyfin.requests.length, calls, 'a locked step never reaches Jellyfin');
    assert.equal((await call('/v1/setup/tmdb', { body: { apiKey: SECRETS.tmdbKey } })).body.error, 'locked_by_environment');
    assert.equal((await call('/v1/setup/household', { body: { trustedProxies: '10.0.0.1' } })).body.error, 'locked_by_environment');
    assert.equal((await call('/v1/setup/household', { body: { gatewayEnabled: false } })).body.error, 'locked_by_environment');
    const status = (await call('/v1/setup', { method: 'GET' })).body;
    assert.deepEqual([status.steps.jellyfin.locked, status.steps.jellyfin.lockedBy, status.steps.jellyfin.url, status.steps.jellyfin.fields], [true, ['JELLYFIN_URL', 'JELLYFIN_API_KEY'], 'http://env-jellyfin:8096', { url: true, apiKey: true }]);
    assert.deepEqual([status.steps.tmdb.locked, status.steps.tmdb.apiKey, status.steps.tmdb.source], [true, 'set', 'environment']);
    assert.deepEqual(status.steps.household.locked, { gatewayEnabled: true, appEnabled: false, trustedProxies: true });
    assert.equal(status.steps.household.gatewayEnabled, true);
    assertNoSecret(JSON.stringify(status), ['env-jellyfin-key']);
  });

  it('with only JELLYFIN_URL in the environment, creates the key at that address and stores the key alone', async (t) => {
    const { call, file, wizard } = await setupMode(t, { environment: { JELLYFIN_URL: `${jellyfin.url}/` } });
    const status = (await call('/v1/setup', { method: 'GET' })).body.steps.jellyfin;
    assert.deepEqual([status.locked, status.fields, status.lockedBy, status.url], [false, { url: true, apiKey: false }, ['JELLYFIN_URL'], `${jellyfin.url}/`]);
    const other = await call('/v1/setup/jellyfin', { body: { url: 'http://elsewhere:8096', username: 'admin', password: SECRETS.adminPassword } });
    assert.deepEqual([other.status, other.body.error, other.body.variables], [409, 'locked_by_environment', ['JELLYFIN_URL']]);
    const created = await call('/v1/setup/jellyfin', { body: { username: 'admin', password: SECRETS.adminPassword } });
    assert.deepEqual([created.status, created.body.status, created.body.url], [200, 'created', jellyfin.url], JSON.stringify(created.body));
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal('jellyfinUrl' in stored, false, 'the locked address is not stored');
    assert.equal(stored.jellyfinApiKey, jellyfin.keys.at(-1).AccessToken);
    // The same address given again is not a change; the stored key is kept.
    assert.equal((await call('/v1/setup/jellyfin', { body: { url: jellyfin.url } })).body.status, 'kept');
    await wizard.secrets({});
    assert.deepEqual(wizard.status().missing, []);
  });

  it('with only JELLYFIN_API_KEY in the environment, checks that key at the address given and stores the address alone', async (t) => {
    jellyfin.addKey('env-only-jellyfin-key-000000000000');
    const { call, file, answers, logs } = await setupMode(t, { environment: { JELLYFIN_API_KEY: 'env-only-jellyfin-key-000000000000' } });
    assert.deepEqual((await call('/v1/setup', { method: 'GET' })).body.steps.jellyfin.fields, { url: false, apiKey: true });
    const keys = jellyfin.keys.length;
    const credentials = await call('/v1/setup/jellyfin', { body: { url: jellyfin.url, username: 'admin', password: SECRETS.adminPassword } });
    assert.deepEqual([credentials.status, credentials.body.error, credentials.body.variables], [409, 'locked_by_environment', ['JELLYFIN_API_KEY']]);
    const connected = await call('/v1/setup/jellyfin', { body: { url: jellyfin.url } });
    assert.deepEqual([connected.status, connected.body.status, connected.body.url], [200, 'connected', jellyfin.url], JSON.stringify(connected.body));
    assert.equal(jellyfin.keys.length, keys, 'no key is created');
    assert.equal(jellyfin.requests.slice(-3).some((entry) => entry.path === '/Users/AuthenticateByName'), false);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual([stored.jellyfinUrl, 'jellyfinApiKey' in stored], [jellyfin.url, false]);
    const refused = await setupMode(t, { environment: { JELLYFIN_API_KEY: 'not-a-jellyfin-key' } });
    assert.deepEqual((await refused.call('/v1/setup/jellyfin', { body: { url: jellyfin.url } })).body.error, 'jellyfin_key_refused');
    assert.equal(refused.settings.current, undefined);
    assertNoSecret(answers.join('\n') + logs.join('\n') + refused.answers.join('\n'), ['env-only-jellyfin-key-000000000000', 'not-a-jellyfin-key']);
  });

  it('with only SEERR_URL or only SEERR_API_KEY in the environment, uses it and stores the other', async (t) => {
    const urlOnly = await setupMode(t, { environment: { SEERR_URL: seerr.url } });
    assert.deepEqual((await urlOnly.call('/v1/setup', { method: 'GET' })).body.steps.seerr.fields, { url: true, apiKey: false });
    assert.equal((await urlOnly.call('/v1/setup/seerr', { body: { url: 'http://elsewhere:5055', apiKey: SECRETS.seerrKey } })).body.error, 'locked_by_environment');
    const connected = await urlOnly.call('/v1/setup/seerr', { body: { apiKey: SECRETS.seerrKey } });
    assert.deepEqual([connected.status, connected.body.status], [200, 'connected'], JSON.stringify(connected.body));
    let stored = JSON.parse(await readFile(urlOnly.file, 'utf8'));
    assert.deepEqual(['seerrUrl' in stored, stored.seerrApiKey], [false, SECRETS.seerrKey]);
    // The stored key is reused for the environment's address.
    assert.equal((await urlOnly.call('/v1/setup/seerr', { body: {} })).body.status, 'connected');

    const keyOnly = await setupMode(t, { environment: { SEERR_API_KEY: SECRETS.seerrKey } });
    assert.deepEqual((await keyOnly.call('/v1/setup', { method: 'GET' })).body.steps.seerr.fields, { url: false, apiKey: true });
    assert.equal((await keyOnly.call('/v1/setup/seerr', { body: { url: seerr.url, apiKey: 'another-key' } })).body.error, 'locked_by_environment');
    assert.equal((await keyOnly.call('/v1/setup/seerr', { body: { url: seerr.url } })).body.status, 'connected');
    stored = JSON.parse(await readFile(keyOnly.file, 'utf8'));
    assert.deepEqual([stored.seerrUrl, 'seerrApiKey' in stored], [seerr.url, false]);
    // Seerr is now complete from both sources, so the webhook step can run (an earlier test left this Seerr's webhook calling another listener).
    assert.equal((await keyOnly.call('/v1/setup/webhook', { body: { jellypassUrl: keyOnly.base, replace: true } })).body.status, 'configured');
    const both = await setupMode(t, { environment: { SEERR_URL: seerr.url, SEERR_API_KEY: SECRETS.seerrKey } });
    assert.deepEqual((await both.call('/v1/setup/seerr', { body: {} })).body.variables, ['SEERR_URL', 'SEERR_API_KEY']);
    assertNoSecret(urlOnly.answers.join('\n') + keyOnly.answers.join('\n'));
  });

  it('asks before replacing a Seerr webhook that is off but set to call another address', async (t) => {
    const other = await createSetupSeerr({ webhook: { enabled: false, types: 8, options: { webhookUrl: 'https://hooks.example.net/kept', jsonPayload: '{}', customHeaders: [] } } });
    t.after(() => other.close());
    const { call, base } = await setupMode(t);
    await call('/v1/setup/seerr', { body: { url: other.url, apiKey: SECRETS.seerrKey } });
    const refused = await call('/v1/setup/webhook', { body: { jellypassUrl: base } });
    assert.deepEqual([refused.status, refused.body.error, refused.body.currentHost, refused.body.currentEnabled], [409, 'seerr_webhook_in_use', 'hooks.example.net', false]);
    assert.equal(other.state.webhook.options.webhookUrl, 'https://hooks.example.net/kept');
    assert.equal(other.requests.filter((entry) => entry.method === 'POST').length, 0, 'nothing was written to Seerr');
    const replaced = await call('/v1/setup/webhook', { body: { jellypassUrl: base, replace: true } });
    assert.deepEqual([replaced.status, replaced.body.tested], [200, true]);
    assert.equal(other.state.webhook.options.webhookUrl, `${base}/webhooks/seerr`);
    // Ours already: a re-run needs no confirmation.
    assert.equal((await call('/v1/setup/webhook', { body: { jellypassUrl: base } })).status, 200);
  });

  it('refuses an answer larger than it reads, with or without a Content-Length', async (t) => {
    const big = 'x'.repeat(MAX_RESPONSE_BYTES + 1);
    const server = createHttpServer((request, response) => {
      if (request.url.startsWith('/declared')) {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(big) });
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
      }
      // Streamed in pieces, so the chunked answer is read part way before it is refused.
      for (let offset = 0; offset < big.length; offset += 65_536) response.write(big.slice(offset, offset + 65_536));
      response.end();
    });
    const url = await listen(server);
    t.after(() => closeServer(server));
    const { call } = await setupMode(t);
    for (const pathname of ['/declared', '/chunked']) {
      const answer = await call('/v1/setup/jellyfin', { body: { url: `${url}${pathname}`, username: 'admin', password: SECRETS.adminPassword } });
      assert.deepEqual([answer.status, answer.body.error], [502, 'jellyfin_response_too_large'], pathname);
    }
  });
});

describe('setup wizard: finishing', () => {
  let jellyfin;
  before(async () => { jellyfin = await createSetupJellyfin(); });
  after(() => jellyfin.close());

  it('refuses every step once finish has begun, lets the steps before it complete, and closes the settings before applying', async (t) => {
    const slowSeerr = await createSetupSeerr({ delayMs: 300 });
    t.after(() => slowSeerr.close());
    const { settings, wizard, applied, file } = await setupMode(t);
    await wizard.jellyfin({ url: jellyfin.url, username: 'admin', password: SECRETS.adminPassword });
    await wizard.secrets({});
    // A slow step in flight when finish is asked for: finish waits for it, and it is stored.
    const inFlight = wizard.seerr({ url: slowSeerr.url, apiKey: SECRETS.seerrKey });
    const finished = wizard.finish({});
    // Another tab's steps, queued behind finish: refused before they reach any service or the settings.
    const queued = [wizard.seerr({ url: slowSeerr.url, apiKey: SECRETS.seerrKey }), wizard.tmdb({ apiKey: SECRETS.tmdbKey }), wizard.backfill({ since: null })];
    assert.equal((await inFlight).status, 'connected');
    const probesBefore = slowSeerr.requests.length;
    assert.deepEqual(await finished, { status: 'restarting' });
    for (const step of queued) await assert.rejects(step, (error) => error.status === 409 && error.code === 'setup_applying');
    assert.equal(slowSeerr.requests.length, probesBefore, 'a refused step made no call');
    assert.deepEqual(await wizard.finish({}), { status: 'restarting' });
    await waitUntil(() => applied.length === 1);
    // The store the next phase replaces is closed: nothing from this wizard can write the file again.
    await assert.rejects(settings.update(() => ({ tmdbApiKey: SECRETS.tmdbKey })), /closed/);
    await assert.rejects(wizard.household({ trustedProxies: '10.0.0.1' }), (error) => error.code === 'setup_applying');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual([stored.seerrUrl, 'tmdbApiKey' in stored, Boolean(stored.setupCompletedAt)], [slowSeerr.url, false, true]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(applied.length, 1);
  });

  it('starts JellyPass only once the wizard is finished, unless the environment alone is complete', () => {
    const complete = { JELLYFIN_URL: 'http://jellyfin:8096', JELLYFIN_API_KEY: 'key', WEBHOOK_TOKEN: 'token' };
    const stored = { version: 1, createdAt: '2026-10-31T00:00:00.000Z', jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'key', webhookToken: 'token' };
    const required = (environment, settings) => setupRequired(environment, settings, mergedEnvironment(environment, settings));
    assert.equal(required({}, undefined), true);
    assert.equal(required({}, stored), true, 'complete from the wizard, not finished');
    assert.equal(required({ JELLYFIN_URL: 'http://jellyfin:8096' }, stored), true, 'partly from the environment, not finished');
    assert.equal(required({}, { ...stored, setupCompletedAt: '2026-10-31T01:00:00.000Z' }), false);
    assert.equal(required(complete, undefined), false, 'environment only');
    assert.equal(required(complete, { version: 1, createdAt: stored.createdAt, requestBackfillSince: stored.createdAt }), false, 'environment only, a wizard change never applied');
    assert.equal(required({}, { ...stored, setupCompletedAt: '2026-10-31T01:00:00.000Z', webhookToken: undefined }), true, 'finished, then a required setting went missing');
  });
});

describe('setup wizard on a running JellyPass', () => {
  it('is on the admin listener for the admin token only, and never on the member listener, whatever the Host', async (t) => {
    const jellyfin = await createSetupJellyfin();
    const directory = await makeTempDir(t, 'jfa-setup-running-');
    const store = new GrantStore(path.join(directory, 'grants.json'));
    await store.load();
    await store.upsertGroup({ id: 'grove', name: 'Grove', userIds: [] });
    await store.setHouseholdAddresses('grove', { origin: 'https://media.example.com', aliases: [] });
    const settings = await SettingsStore.load(path.join(directory, 'settings.json'));
    const applied = [];
    const setup = new SetupWizard({ settings, environment: { JELLYFIN_URL: jellyfin.url, JELLYFIN_API_KEY: 'k', WEBHOOK_TOKEN: 'w' }, mode: 'running', adminTokenSource: 'environment', apply: () => applied.push(1) });
    const servers = makeServers(new AccessService(new JellyfinClient(jellyfin.url, 'k'), store), { webhook: 'webhook-secret', admin: SECRETS.adminToken }, undefined, {
      setup,
      trustedProxies: ['127.0.0.1'],
      householdGateway: { jellyfinUrl: jellyfin.url },
    });
    const admin = await listen(servers.admin);
    const member = await listen(servers.member);
    t.after(async () => { await closeServer(servers.admin); await closeServer(servers.member); await store.close(); await jellyfin.close(); });

    const status = await fetch(`${admin}/v1/setup`, { headers: BEARER });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).mode, 'running');
    assert.equal((await fetch(`${admin}/v1/setup`)).status, 401);
    assert.equal((await fetch(`${admin}/v1/setup`, { headers: { Cookie: 'jellypass_session=x' } })).status, 401);
    assert.equal((await fetch(`${admin}/admin/setup/`)).status, 200);
    assert.deepEqual((await (await fetch(`${admin}/v1/setup/jellyfin`, { method: 'POST', headers: { ...BEARER, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: jellyfin.url }) })).json()).error, 'locked_by_environment');

    // On the member listener: a household's Host goes to the household gateway, any other Host is a fixed 421.
    for (const host of ['media.example.com', 'unknown.example.com', '127.0.0.1']) {
      for (const [method, pathname] of [['GET', '/v1/setup'], ['POST', '/v1/setup/finish'], ['POST', '/v1/setup/secrets'], ['GET', '/admin/setup/'], ['GET', '/admin/setup.js']]) {
        const answer = await rawRequest(member, method, pathname, { Host: host, ...BEARER, ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': '2' } : {}) }, method === 'POST' ? '{}' : '');
        assert.doesNotMatch(answer, /"mode":|"steps":|Set up JellyPass|restarting|webhookToken/, `${host} ${method} ${pathname}`);
        if (host !== 'media.example.com') assert.match(answer, /^HTTP\/1\.1 421 /, `${host} ${pathname}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(applied.length, 0);
    assert.equal(settings.current, undefined, 'nothing on the member listener wrote settings');
  });
});

describe('setup wizard page', () => {
  function setupPage(answer) {
    const { window, document } = parseHTML(SETUP_HTML);
    const requests = [];
    const storage = [];
    const context = {
      window,
      document,
      fetch: async (pathname, init) => {
        requests.push({ pathname, init });
        const reply = await answer(pathname, init);
        return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
      },
      confirm: () => true,
      setTimeout,
      clearTimeout,
      Date,
      localStorage: { setItem: (...args) => storage.push(args) },
      sessionStorage: { setItem: (...args) => storage.push(args) },
    };
    runInNewContext(SETUP_APP_JS, context);
    const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
    const submit = async (id) => { document.getElementById(id).dispatchEvent(new window.Event('submit')); await settle(); };
    return { window, document, requests, storage, submit };
  }

  const STATUS = {
    mode: 'setup', completedAt: null, installedAt: null, missing: ['Jellyfin address', 'Jellyfin API key', 'webhook token'], restartNeeded: false,
    steps: {
      jellyfin: { url: null, apiKey: 'unset', locked: false, lockedBy: [] },
      seerr: { url: null, apiKey: 'unset', locked: false, lockedBy: [], webhook: null },
      secrets: { webhookToken: 'unset', locked: false, lockedBy: [] },
      tmdb: { apiKey: 'set', locked: true, lockedBy: ['TMDB_API_KEY'], validatedAt: null },
      backfill: { since: null, enabled: false, suggested: '2026-10-31T00:00:00.000Z', locked: false, lockedBy: [] },
      household: { gatewayEnabled: false, appEnabled: false, trustedProxies: [], locked: { gatewayEnabled: false, appEnabled: false, trustedProxies: false }, lockedBy: [] },
    },
  };

  it('keeps the token in memory only, sends it as a bearer token, clears the password once sent, and greys out locked steps', async () => {
    const page = setupPage((pathname, init) => {
      if (init.headers.Authorization !== `Bearer ${SECRETS.adminToken}`) return { status: 401, body: { error: 'unauthorized' } };
      if (pathname === '/v1/setup/jellyfin') return { status: 200, body: { status: 'created', setup: { ...STATUS, steps: { ...STATUS.steps, jellyfin: { url: 'http://jellyfin:8096', apiKey: 'set', createdByJellyPass: true, locked: false, lockedBy: [] } } } } };
      return { status: 200, body: STATUS };
    });
    const byId = (id) => page.document.getElementById(id);
    byId('setup-token').value = 'wrong';
    await page.submit('setup-token-form');
    assert.equal(byId('setup-token-error').textContent, 'That token was not accepted.');
    assert.equal(byId('setup-steps').hidden, true);
    byId('setup-token').value = SECRETS.adminToken;
    await page.submit('setup-token-form');
    assert.equal(byId('setup-steps').hidden, false);
    assert.equal(byId('setup-token').value, '');
    assert.equal(byId('tmdb-key').disabled, true);
    assert.match(page.document.querySelector('[data-state="tmdb"]').textContent, /TMDB_API_KEY/);
    byId('jellyfin-url').value = 'http://jellyfin:8096';
    byId('jellyfin-username').value = 'admin';
    byId('jellyfin-password').value = SECRETS.adminPassword;
    await page.submit('jellyfin-form');
    const sent = page.requests.find((entry) => entry.pathname === '/v1/setup/jellyfin');
    assert.deepEqual(JSON.parse(sent.init.body), { url: 'http://jellyfin:8096', username: 'admin', password: SECRETS.adminPassword });
    assert.equal(byId('jellyfin-password').value, '');
    assert.match(page.document.querySelector('[data-state="jellyfin"]').textContent, /JellyPass's own API key/);
    assert.deepEqual(page.storage, []);
    assertNoSecret(page.document.documentElement.outerHTML);
  });

  it('turns off only the fields the environment sets, and leaves them out of what it sends', async () => {
    const partial = {
      ...STATUS,
      steps: {
        ...STATUS.steps,
        jellyfin: { url: 'http://env-jellyfin:8096', apiKey: 'unset', locked: false, fields: { url: true, apiKey: false }, lockedBy: ['JELLYFIN_URL'] },
        seerr: { url: null, apiKey: 'set', locked: false, fields: { url: false, apiKey: true }, lockedBy: ['SEERR_API_KEY'], webhook: null },
      },
    };
    const page = setupPage(() => ({ status: 200, body: { status: 'created', setup: partial, ...partial } }));
    const byId = (id) => page.document.getElementById(id);
    byId('setup-token').value = SECRETS.adminToken;
    await page.submit('setup-token-form');
    assert.deepEqual([byId('jellyfin-url').disabled, byId('jellyfin-url').value, byId('jellyfin-username').disabled, byId('jellyfin-password').disabled], [true, 'http://env-jellyfin:8096', false, false]);
    assert.deepEqual([byId('seerr-url').disabled, byId('seerr-key').disabled], [false, true]);
    assert.match(page.document.querySelector('[data-state="jellyfin"]').textContent, /JELLYFIN_URL/);
    byId('jellyfin-username').value = 'admin';
    byId('jellyfin-password').value = SECRETS.adminPassword;
    await page.submit('jellyfin-form');
    assert.deepEqual(JSON.parse(page.requests.find((entry) => entry.pathname === '/v1/setup/jellyfin').init.body), { username: 'admin', password: SECRETS.adminPassword });
    byId('seerr-url').value = 'http://seerr:5055';
    await page.submit('seerr-form');
    assert.deepEqual(JSON.parse(page.requests.find((entry) => entry.pathname === '/v1/setup/seerr').init.body), { url: 'http://seerr:5055' });
  });
});

describe('setup mode and the configured start, as a process', () => {
  it('starts in setup mode with no configuration: health answers, the token is in a 0600 file and never logged, no member listener', async (t) => {
    const directory = await makeTempDir(t, 'jfa-setup-process-');
    const [adminPort, memberPort] = await freePorts(2);
    const child = startProcess(t, { STATE_FILE: path.join(directory, 'grants.json'), ADMIN_PORT: String(adminPort), PORT: String(memberPort) });
    await child.waitFor(/not configured yet/);
    const token = (await readFile(path.join(directory, 'admin-token'), 'utf8')).trim();
    assert.equal((await stat(path.join(directory, 'admin-token'))).mode & 0o777, 0o600);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${adminPort}/health`)).json(), { status: 'ok', setup: 'required' });
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/v1/setup`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal(await portOpen(memberPort), false);
    await assert.rejects(stat(path.join(directory, 'settings.json')), { code: 'ENOENT' });
    assertNoSecret(child.output(), [token]);
  });

  it('goes from setup mode to a running JellyPass in place when the wizard finishes, and keeps the settings across restarts', async (t) => {
    const jellyfin = await createSetupJellyfin();
    const seerr = await createSetupSeerr();
    t.after(async () => { await jellyfin.close(); await seerr.close(); });
    const directory = await makeTempDir(t, 'jfa-setup-flow-');
    const [adminPort] = await freePorts(1);
    const base = `http://127.0.0.1:${adminPort}`;
    const environment = { STATE_FILE: path.join(directory, 'grants.json'), ADMIN_PORT: String(adminPort), ADMIN_TOKEN: SECRETS.adminToken, RECONCILE_INTERVAL_SECONDS: '0', CATALOG_SYNC_INTERVAL_SECONDS: '0' };
    const child = startProcess(t, environment);
    await child.waitFor(/not configured yet/);
    const post = async (step, body) => {
      const response = await fetch(`${base}/v1/setup/${step}`, { method: 'POST', headers: { ...BEARER, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const answer = await response.json();
      assert.equal(response.status, 200, `${step}: ${JSON.stringify(answer)}`);
      return answer;
    };
    await post('jellyfin', { url: jellyfin.url, username: 'admin', password: SECRETS.adminPassword });
    await post('seerr', { url: seerr.url, apiKey: SECRETS.seerrKey });
    assert.equal((await post('webhook', { jellypassUrl: base })).tested, true);
    await post('backfill', {});
    assert.equal((await post('finish', {})).status, 'restarting');
    await child.waitFor(/"message":"server started"/);
    // Running: the admin API answers with the token, and the wizard says so.
    assert.equal((await fetch(`${base}/v1/groups`, { headers: BEARER })).status, 200);
    const status = await (await fetch(`${base}/v1/setup`, { headers: BEARER })).json();
    assert.deepEqual([status.mode, status.restartNeeded, status.missing], ['running', false, []]);
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
    // The webhook now goes to the running JellyPass, with the token the wizard generated.
    const stored = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'));
    assert.equal((await stat(path.join(directory, 'settings.json'))).mode & 0o777, 0o600);
    const test = await fetch(`${base}/webhooks/seerr`, { method: 'POST', headers: { Authorization: `Bearer ${stored.webhookToken}` }, body: JSON.stringify({ notificationType: 'TEST_NOTIFICATION', event: '', media: {}, request: { id: '', requestedBy: { jellyfinUserId: '', username: '' } } }) });
    assert.equal(test.status, 202);
    assert.match(child.output(), /"requestBackfillSince":"20/);
    // A change on the running JellyPass waits for "apply", which restarts its services in place.
    await post('backfill', { since: null });
    assert.equal((await (await fetch(`${base}/v1/setup`, { headers: BEARER })).json()).restartNeeded, true);
    const starts = child.output().split('"message":"server started"').length - 1;
    await post('finish', {});
    await child.waitFor(new RegExp(`("message":"server started"[^]*){${starts + 1}}`));
    assert.match(child.output().split('"message":"server started"').at(-1), /"requestBackfillSince":null/);
    assertNoSecret(child.output(), [stored.webhookToken, stored.jellyfinApiKey]);
  });

  it('runs an install configured only by environment variables as before: no settings file, and the wizard shows it locked', async (t) => {
    const jellyfin = await createSetupJellyfin();
    t.after(() => jellyfin.close());
    const directory = await makeTempDir(t, 'jfa-setup-env-');
    const [adminPort] = await freePorts(1);
    const child = startProcess(t, {
      STATE_FILE: path.join(directory, 'grants.json'), ADMIN_PORT: String(adminPort), ADMIN_TOKEN: SECRETS.adminToken,
      JELLYFIN_URL: jellyfin.url, JELLYFIN_API_KEY: 'env-jellyfin-key', WEBHOOK_TOKEN: 'env-webhook-token', RECONCILE_INTERVAL_SECONDS: '0', CATALOG_SYNC_INTERVAL_SECONDS: '0',
    });
    await child.waitFor(/"message":"server started"/);
    assert.doesNotMatch(child.output(), /not configured yet/);
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/v1/groups`, { headers: BEARER })).status, 200);
    const status = await (await fetch(`http://127.0.0.1:${adminPort}/v1/setup`, { headers: BEARER })).json();
    assert.deepEqual([status.mode, status.completedAt, status.steps.jellyfin.locked, status.steps.secrets.locked, status.missing], ['running', null, true, true, []]);
    await assert.rejects(stat(path.join(directory, 'settings.json')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(directory, 'admin-token')), { code: 'ENOENT' });
  });

  it('lets the environment win over a stored setting at startup', async (t) => {
    const jellyfin = await createSetupJellyfin();
    t.after(() => jellyfin.close());
    const directory = await makeTempDir(t, 'jfa-setup-precedence-');
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ version: 1, createdAt: '2026-10-31T00:00:00.000Z', setupCompletedAt: '2026-10-31T00:01:00.000Z', jellyfinUrl: 'http://127.0.0.1:1', jellyfinApiKey: 'stored-key', webhookToken: 'stored-webhook-token-0000000000000000000' }), { mode: 0o600 });
    const [adminPort] = await freePorts(1);
    const child = startProcess(t, { STATE_FILE: path.join(directory, 'grants.json'), ADMIN_PORT: String(adminPort), ADMIN_TOKEN: SECRETS.adminToken, JELLYFIN_URL: jellyfin.url, RECONCILE_INTERVAL_SECONDS: '0', CATALOG_SYNC_INTERVAL_SECONDS: '0' });
    await child.waitFor(/"message":"server started"/);
    const status = await (await fetch(`http://127.0.0.1:${adminPort}/v1/setup`, { headers: BEARER })).json();
    assert.deepEqual([status.steps.jellyfin.url, status.steps.jellyfin.lockedBy, status.steps.jellyfin.source], [jellyfin.url, ['JELLYFIN_URL'], 'settings']);
    // The version check reached the environment's Jellyfin, not the stored address.
    await waitUntil(() => jellyfin.requests.some((entry) => entry.path === '/System/Info/Public'));
  });

  it('stays in setup mode while the wizard has every required setting but was never finished, and serves no household', async (t) => {
    const jellyfin = await createSetupJellyfin();
    t.after(() => jellyfin.close());
    const directory = await makeTempDir(t, 'jfa-setup-unfinished-');
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ version: 1, createdAt: '2026-10-31T00:00:00.000Z', jellyfinUrl: jellyfin.url, jellyfinApiKey: 'stored-key', webhookToken: 'stored-webhook-token-0000000000000000000' }), { mode: 0o600 });
    const [adminPort, memberPort] = await freePorts(2);
    const child = startProcess(t, { STATE_FILE: path.join(directory, 'grants.json'), ADMIN_PORT: String(adminPort), PORT: String(memberPort), ADMIN_TOKEN: SECRETS.adminToken, HOUSEHOLD_GATEWAY_ENABLED: 'true', TRUSTED_PROXIES: '127.0.0.1' });
    await child.waitFor(/setup is not finished yet/);
    assert.doesNotMatch(child.output(), /"message":"server started"/);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${adminPort}/health`)).json(), { status: 'ok', setup: 'required' });
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/v1/groups`, { headers: BEARER })).status, 503);
    assert.equal(await portOpen(memberPort), false);
    const status = await (await fetch(`http://127.0.0.1:${adminPort}/v1/setup`, { headers: BEARER })).json();
    assert.deepEqual([status.mode, status.missing, status.completedAt], ['setup', [], null]);
    assertNoSecret(child.output(), ['stored-key', 'stored-webhook-token-0000000000000000000']);
  });

  it('starts a finished wizard install directly, its admin token in the setup token file (made again once deleted)', async (t) => {
    const jellyfin = await createSetupJellyfin();
    t.after(() => jellyfin.close());
    jellyfin.addKey('stored-jellyfin-key-0000000000000000');
    const directory = await makeTempDir(t, 'jfa-setup-finished-');
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ version: 1, createdAt: '2026-10-31T00:00:00.000Z', setupCompletedAt: '2026-10-31T00:05:00.000Z', jellyfinUrl: jellyfin.url, jellyfinApiKey: 'stored-jellyfin-key-0000000000000000', webhookToken: 'stored-webhook-token-0000000000000000000' }), { mode: 0o600 });
    const [adminPort] = await freePorts(1);
    const child = startProcess(t, { STATE_FILE: path.join(directory, 'grants.json'), ADMIN_PORT: String(adminPort), RECONCILE_INTERVAL_SECONDS: '0', CATALOG_SYNC_INTERVAL_SECONDS: '0' });
    await child.waitFor(/"message":"server started"/);
    assert.doesNotMatch(child.output(), /not (configured|finished) yet/);
    const token = (await readFile(path.join(directory, 'admin-token'), 'utf8')).trim();
    assert.equal((await stat(path.join(directory, 'admin-token'))).mode & 0o777, 0o600);
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/v1/groups`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/v1/groups`, { headers: { Authorization: 'Bearer stored-webhook-token-0000000000000000000' } })).status, 401);
    const status = await (await fetch(`http://127.0.0.1:${adminPort}/v1/setup`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.deepEqual([status.mode, status.adminToken], ['running', 'file']);
    assertNoSecret(child.output(), [token, 'stored-jellyfin-key-0000000000000000', 'stored-webhook-token-0000000000000000000']);
  });
});

/** JellyPass as a child process with only `environment` (and PATH); stopped when the test ends. */
function startProcess(t, environment) {
  let output = '';
  const child = spawn(process.execPath, [ENTRYPOINT], { env: { PATH: process.env.PATH, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    child.kill('SIGTERM');
    await exited;
  });
  return {
    output: () => output,
    waitFor: async (pattern) => {
      await waitUntil(() => pattern.test(output) || child.exitCode !== null, 15_000);
      assert.match(output, pattern);
    },
  };
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function freePorts(count) {
  const { createServer } = await import('node:net');
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => resolve(server));
  })));
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** One request written as it is, and its whole answer (the connection is closed after it). */
function rawRequest(base, method, pathname, headers, body) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1');
    let answer = '';
    socket.once('connect', () => {
      const lines = Object.entries({ ...headers, Connection: 'close' }).map(([name, value]) => `${name}: ${value}\r\n`).join('');
      socket.write(`${method} ${pathname} HTTP/1.1\r\n${lines}\r\n${body}`);
    });
    socket.on('data', (chunk) => { answer += chunk; });
    socket.once('close', () => resolve(answer));
    socket.once('error', (error) => (error.code === 'ECONNRESET' ? resolve(answer) : reject(error)));
  });
}
