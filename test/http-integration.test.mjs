import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../dist/access-service.js';
import { WebAuth } from '../dist/auth.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { makeServer } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { createFakeJellyfin } from './support/fake-jellyfin.mjs';

describe('HTTP integration', { timeout: 5_000 }, () => {
  let jellyfin;
  let bridge;
  let bridgeUrl;
  let importedUserIds;

  before(async () => {
    jellyfin = await createFakeJellyfin();
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'jfa-http-test-')), 'grants.json');
    const store = new GrantStore(file);
    await store.load();
    await store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: ['alice-id', 'bob-id'] });
    const jellyfinClient = new JellyfinClient(jellyfin.url, 'test-key');
    importedUserIds = [];
    const seerr = {
      async getRecentRequests(take, jellyfinItemIds) {
        assert.equal(take, 8);
        assert.equal(jellyfinItemIds.has('item-2'), true);
        return [{ id: 136, mediaType: 'tv', title: 'Recent Series', year: 2026, posterPath: '/poster.jpg', jellyfinItemId: 'item-2', requestStatus: 'approved', mediaStatus: 'partially_available', requestedBy: 'Alice', createdAt: '2026-08-29T03:46:03.000Z', seasonCount: 2 }];
      },
      async getPoster(pathname) {
        assert.equal(pathname, '/poster.jpg');
        return { body: new Uint8Array([255, 216, 255, 217]), contentType: 'image/jpeg' };
      },
      async importJellyfinUser(jellyfinUserId) {
        if (jellyfinUserId === 'import-failure-id') throw new Error('simulated Jellyseerr failure');
        importedUserIds.push(jellyfinUserId);
        return { status: 'imported', user: { id: 44, jellyfinUserId } };
      },
    };
    const service = new AccessService(jellyfinClient, store, undefined, seerr);
    const webAuth = new WebAuth(jellyfinClient);
    bridge = makeServer(service, { webhook: 'webhook-secret', admin: 'admin-secret' }, webAuth, {
      householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-' },
    });
    await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const address = bridge.address();
    bridgeUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    bridge.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => bridge.close(resolve)),
      jellyfin.close(),
    ]);
  });

  it('processes a webhook through both HTTP services', async () => {
    const root = await fetch(`${bridgeUrl}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/admin/');

    const householdUsers = await fetchWithHost(bridgeUrl, '/Users/Public', 'jelly-farmhouse.example.test');
    assert.equal(householdUsers.status, 200);
    assert.deepEqual((await householdUsers.json()).map((user) => user.Name), ['Alice', 'Bob']);
    const householdInfo = await fetchWithHost(bridgeUrl, '/System/Info/Public', 'jelly-farmhouse.example.test');
    assert.equal(householdInfo.status, 200);
    assert.equal((await householdInfo.json()).ServerName, 'Test Jellyfin');
    const householdBranding = await fetchWithHost(bridgeUrl, '/Branding/Configuration', 'jelly-farmhouse.example.test');
    assert.equal(householdBranding.status, 200);
    const householdBrandingBody = await householdBranding.json();
    assert.match(householdBrandingBody.CustomCss, /existing-branding/);
    assert.match(householdBrandingBody.CustomCss, /#loginPage \.manualLoginForm/);
    assert.match(householdBrandingBody.CustomCss, /#loginPage \.readOnlyContent/);
    assert.match(householdBrandingBody.CustomCss, /#loginPage \.btnManual/);
    assert.match(householdBrandingBody.CustomCss, /#loginPage \.btnQuick/);
    assert.match(householdBrandingBody.CustomCss, /#loginPage \.btnForgotPassword/);
    assert.match(householdBrandingBody.LoginDisclaimer, /<style id="jellypass-household-profile-picker">/);
    assert.match(householdBrandingBody.LoginDisclaimer, /#loginPage \.readOnlyContent/);
    const householdQuickConnect = await fetchWithHost(bridgeUrl, '/QuickConnect/Enabled', 'jelly-farmhouse.example.test');
    assert.equal(householdQuickConnect.status, 200);
    assert.equal(await householdQuickConnect.json(), false);
    assert.equal(householdQuickConnect.headers.get('cache-control'), 'no-store');
    const householdLogin = await fetchWithHost(bridgeUrl, '/Users/AuthenticateByName', 'jelly-farmhouse.example.test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'Alice', Pw: 'user-password' }),
    });
    assert.equal(householdLogin.status, 200);
    assert.equal((await householdLogin.json()).User.Name, 'Alice');
    assert.match(await upgradeWithHost(bridgeUrl, '/socket', 'jelly-farmhouse.example.test'), /^HTTP\/1\.1 101/);
    const missingHousehold = await fetchWithHost(bridgeUrl, '/Users/Public', 'jelly-missing.example.test');
    assert.equal(missingHousehold.status, 404);
    assert.equal((await missingHousehold.json()).error, 'household_not_found');

    const adminUi = await fetch(`${bridgeUrl}/admin/`);
    assert.equal(adminUi.status, 200);
    assert.match(adminUi.headers.get('content-security-policy'), /default-src 'none'/);
    const adminMarkup = await adminUi.text();
    assert.match(adminMarkup, /JellyPass/);
    assert.doesNotMatch(adminMarkup, /id="import-media"/);
    assert.match(adminMarkup, /Synchronized library/);
    assert.match(adminMarkup, /id="reconcile-policies"/);
    assert.match(adminMarkup, /<button class="active" data-tab="dashboard">Dashboard/);
    assert.match(adminMarkup, /<section id="dashboard-panel" class="tab-panel">/);
    assert.match(adminMarkup, /id="hero-title">JellyPass dashboard/);
    assert.match(adminMarkup, /id="recent-requests"/);
    assert.match(adminMarkup, /id="clear-library-search"[^>]*>Clear search</);
    assert.match(adminMarkup, /id="clear-selection"[^>]*>Clear selection</);
    assert.match(adminMarkup, /<section id="grants-panel" class="tab-panel" hidden>/);
    assert.match(adminMarkup, /<section id="library-panel" class="tab-panel" hidden>/);
    assert.match(adminMarkup, /id="connection" class="connection disconnected"/);
    assert.match(adminMarkup, /id="logout" class="button quiet compact" hidden/);
    assert.doesNotMatch(adminMarkup, /id="errors-stat"/);
    assert.match(adminMarkup, /id="library-name-filter"/);
    assert.doesNotMatch(adminMarkup, /id="library-date-filter"/);
    assert.doesNotMatch(adminMarkup, /library-(type|status)-filter/);
    assert.match(adminMarkup, /id="library-page-size"/);
    assert.match(adminMarkup, /<option value="25">25<\/option><option value="50">50<\/option><option value="100">100<\/option>/);
    assert.match(adminMarkup, /id="library-sort"/);
    assert.match(adminMarkup, /Request\/access · recent/);
    assert.match(adminMarkup, /id="new-user"/);
    assert.match(adminMarkup, /id="user-dialog"/);
    assert.match(adminMarkup, /Password · optional/);
    assert.doesNotMatch(adminMarkup, /id="new-password"[^>]*required/);
    assert.match(adminMarkup, /Leave both password fields blank/);
    assert.match(adminMarkup, /id="import-to-jellyseerr"/);
    assert.doesNotMatch(adminMarkup, /id="import-to-jellyseerr"[^>]*checked/);
    assert.match(adminMarkup, /Jellyseerr applies its configured default permissions/);

    const adminScript = await fetch(`${bridgeUrl}/admin/app.js`);
    assert.equal(adminScript.status, 200);
    const adminScriptText = await adminScript.text();
    assert.match(adminScriptText, /\/v1\/library\/access/);
    assert.match(adminScriptText, /Your media library/);
    assert.match(adminScriptText, /Access grants/);
    assert.match(adminScriptText, /Access groups/);
    assert.match(adminScriptText, /\/v1\/requests\/recent/);
    assert.match(adminScriptText, /Edit library access/);
    assert.match(adminScriptText, /dateStyle: 'short'/);
    assert.match(adminScriptText, /sortingByDateAdded/);
    assert.match(adminScriptText, /function clearLibrarySearch/);
    assert.match(adminScriptText, /function resetLibraryView/);
    assert.match(adminScriptText, /state\.activeTab === 'library' && tab !== 'library'/);
    assert.match(adminScriptText, /importOption\.checked = false/);
    assert.match(adminScriptText, /POST.*\/v1\/users|\/v1\/users.*method: 'POST'/s);
    assert.doesNotThrow(() => new Function(adminScriptText));

    const adminStyles = await fetch(`${bridgeUrl}/admin/styles.css`);
    assert.equal(adminStyles.status, 200);
    assert.match(await adminStyles.text(), /\[hidden\]\{display:none!important\}/);

    const favicon = await fetch(`${bridgeUrl}/admin/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.match(await favicon.text(), /#AA5CC3/);

    const noSession = await fetch(`${bridgeUrl}/auth/session`);
    assert.equal(noSession.status, 401);
    await noSession.json();

    const badLogin = await fetch(`${bridgeUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Admin', password: 'wrong-password' }),
    });
    assert.equal(badLogin.status, 401);
    await badLogin.json();

    const nonAdminLogin = await fetch(`${bridgeUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Alice', password: 'user-password' }),
    });
    assert.equal(nonAdminLogin.status, 401);
    await nonAdminLogin.json();

    const login = await fetch(`${bridgeUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ username: 'Admin', password: 'admin-password' }),
    });
    assert.equal(login.status, 200);
    await login.json();
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /^jellypass_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    assert.equal(jellyfin.logoutCount, 2);
    const sessionCookie = setCookie.split(';')[0];

    const sessionUsers = await fetch(`${bridgeUrl}/v1/users`, { headers: { Cookie: sessionCookie } });
    assert.equal(sessionUsers.status, 200);
    const sessionUsersBody = await sessionUsers.json();
    assert.deepEqual(sessionUsersBody.users.map((user) => user.name), ['Admin', 'Alice', 'Bob']);
    assert.equal(sessionUsersBody.jellyseerrImportAvailable, true);
    const groups = await fetch(`${bridgeUrl}/v1/groups`, { headers: { Cookie: sessionCookie } });
    assert.equal(groups.status, 200);
    assert.equal((await groups.json()).groups[0].householdUrl, 'https://jelly-farmhouse.example.test');

    const shortPassword = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Charlie', password: 'short', groupId: 'farmhouse' }),
    });
    assert.equal(shortPassword.status, 400);
    assert.match((await shortPassword.json()).error, /empty or contain between 8 and 256/);

    const missingGroup = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Charlie', password: 'charlie-password', groupId: 'missing' }),
    });
    assert.equal(missingGroup.status, 404);
    assert.equal((await missingGroup.json()).error, 'group not found: missing');

    const createdUser = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Charlie', password: '', groupId: 'farmhouse' }),
    });
    assert.equal(createdUser.status, 201);
    const createdBody = await createdUser.json();
    assert.deepEqual(createdBody.user, { id: 'charlie-id', name: 'Charlie', isAdministrator: false });
    assert.equal(Object.hasOwn(createdBody, 'password'), false);
    assert.deepEqual(createdBody.group.userIds, ['alice-id', 'bob-id', 'charlie-id']);
    assert.deepEqual(createdBody.jellyseerr, { status: 'not_requested' });
    assert.equal(jellyfin.user('charlie-id').Policy.IsHidden, false);
    assert.deepEqual(importedUserIds, []);
    const duplicateUser = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'charlie', password: 'another-password', groupId: 'farmhouse' }),
    });
    assert.equal(duplicateUser.status, 400);
    assert.equal((await duplicateUser.json()).error, 'username is already in use');

    const importedUser = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Dana', password: 'dana-password', groupId: 'farmhouse', importToJellyseerr: true }),
    });
    assert.equal(importedUser.status, 201);
    const importedBody = await importedUser.json();
    assert.deepEqual(importedBody.jellyseerr, { status: 'imported', userId: 44 });
    assert.deepEqual(importedUserIds, ['dana-id']);
    const protectedUserLogin = await fetchWithHost(bridgeUrl, '/Users/AuthenticateByName', 'jelly-farmhouse.example.test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'Dana', Pw: 'dana-password' }),
    });
    assert.equal(protectedUserLogin.status, 200);
    assert.equal((await protectedUserLogin.json()).User.Name, 'Dana');

    const failedImport = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Import Failure', password: 'failure-password', groupId: 'farmhouse', importToJellyseerr: true }),
    });
    assert.equal(failedImport.status, 502);
    const failedImportBody = await failedImport.json();
    assert.equal(failedImportBody.code, 'user_created_jellyseerr_import_failed');
    assert.deepEqual(failedImportBody.user, { id: 'import-failure-id', name: 'Import Failure', isAdministrator: false });
    assert.equal(failedImportBody.group.id, 'farmhouse');
    assert.match(failedImportBody.error, /created and assigned.*Jellyseerr import failed/i);
    const updatedHouseholdUsers = await fetchWithHost(bridgeUrl, '/Users/Public', 'jelly-farmhouse.example.test');
    assert.deepEqual((await updatedHouseholdUsers.json()).map((user) => user.Name), ['Alice', 'Bob', 'Charlie', 'Dana', 'Import Failure']);
    const newUserLogin = await fetchWithHost(bridgeUrl, '/Users/AuthenticateByName', 'jelly-farmhouse.example.test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'Charlie', Pw: '' }),
    });
    assert.equal(newUserLogin.status, 200);
    assert.equal((await newUserLogin.json()).User.Name, 'Charlie');

    const librarySearch = await fetch(`${bridgeUrl}/v1/library/search?q=Second`, { headers: { Cookie: sessionCookie } });
    assert.equal(librarySearch.status, 200);
    assert.deepEqual((await librarySearch.json()).items, [{ id: 'item-2', name: 'Second Movie', mediaType: 'movie', productionYear: 2026 }]);

    const catalogSync = await fetch(`${bridgeUrl}/v1/library/sync`, { method: 'POST', headers: { Cookie: sessionCookie } });
    assert.equal(catalogSync.status, 200);
    assert.equal((await catalogSync.json()).items.length, 2);
    const catalog = await fetch(`${bridgeUrl}/v1/library`, { headers: { Cookie: sessionCookie } });
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).items.length, 2);

    const recentRequests = await fetch(`${bridgeUrl}/v1/requests/recent`, { headers: { Cookie: sessionCookie } });
    assert.equal(recentRequests.status, 200);
    assert.equal((await recentRequests.json()).requests[0].title, 'Recent Series');
    const requestPoster = await fetch(`${bridgeUrl}/v1/requests/poster?path=%2Fposter.jpg`, { headers: { Cookie: sessionCookie } });
    assert.equal(requestPoster.status, 200);
    assert.equal(requestPoster.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(new Uint8Array(await requestPoster.arrayBuffer()), new Uint8Array([255, 216, 255, 217]));

    const manualBody = JSON.stringify({ itemIds: ['item-2'], userIds: ['bob-id'], groupIds: [] });
    const manualPreview = await fetch(`${bridgeUrl}/v1/library/access?dryRun=true`, {
      method: 'PUT',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: manualBody,
    });
    assert.equal(manualPreview.status, 200);
    assert.equal((await manualPreview.json()).result.plans[0].item.action, 'add_tag');
    assert.deepEqual(jellyfin.itemById('item-2').Tags, []);

    const manualImport = await fetch(`${bridgeUrl}/v1/library/access`, {
      method: 'PUT',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: manualBody,
    });
    assert.equal(manualImport.status, 200);
    assert.deepEqual((await manualImport.json()).result.currents[0].manualUserIds, ['bob-id']);
    assert.deepEqual(jellyfin.itemById('item-2').Tags, ['jfa:private:item-2']);
    assert.deepEqual(jellyfin.user('alice-id').Policy.BlockedTags, ['jfa:private:item-2']);

    const unauthorized = await fetch(`${bridgeUrl}/webhooks/seerr`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    await unauthorized.json();

    const queryAuthenticated = await fetch(`${bridgeUrl}/webhooks/seerr?token=webhook-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationType: 'TEST_NOTIFICATION', request: { id: '1' } }),
    });
    assert.equal(queryAuthenticated.status, 202);
    await queryAuthenticated.json();

    const response = await fetch(`${bridgeUrl}/webhooks/seerr`, {
      method: 'POST',
      headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notificationType: 'MEDIA_AVAILABLE',
        media: { jellyfinMediaId: 'item-1', mediaType: 'movie' },
        request: { id: '17', requestedBy: { jellyfinUserId: 'alice-id' } },
      }),
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.deepEqual(jellyfin.item.Tags, ['existing', 'jfa:private:item-1']);
    assert.deepEqual(jellyfin.user('bob-id').Policy.BlockedTags, ['jfa:private:item-1']);

    const metrics = await fetch(`${bridgeUrl}/metrics`, { headers: { Authorization: 'Bearer admin-secret' } });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /jfa_webhooks_total\{result="granted"\} 1/);

    const plan = await fetch(`${bridgeUrl}/v1/grants/item-1/plan`, { headers: { Authorization: 'Bearer admin-secret' } });
    assert.equal(plan.status, 200);
    assert.equal((await plan.json()).plan.item.action, 'none');

    const users = await fetch(`${bridgeUrl}/v1/users`, { headers: { Authorization: 'Bearer admin-secret' } });
    assert.equal(users.status, 200);
    assert.deepEqual((await users.json()).users.map((user) => user.name), ['Admin', 'Alice', 'Bob', 'Charlie', 'Dana', 'Import Failure']);

    const revoke = await fetch(`${bridgeUrl}/v1/grants/item-1/requests/17`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-secret' },
    });
    assert.equal(revoke.status, 200);
    await revoke.json();
    assert.deepEqual(jellyfin.item.Tags, ['existing']);
    assert.deepEqual(jellyfin.user('bob-id').Policy.BlockedTags, []);
  });
});

function fetchWithHost(baseUrl, pathname, host, options = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: pathname, method: options.method, headers: { ...options.headers, Host: host } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

function upgradeWithHost(baseUrl, pathname, host) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connectSocket(Number(url.port), url.hostname);
    let response = '';
    socket.once('connect', () => socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.once('error', reject);
  });
}
