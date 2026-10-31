import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect as connectSocket } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../dist/access-service.js';
import { WebAuth } from '../dist/auth.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { makeServers } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { createFakeJellyfin } from './support/fake-jellyfin.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

describe('HTTP integration', { timeout: 5_000 }, () => {
  let jellyfin;
  let bridge;
  let member;
  let bridgeUrl;
  let memberUrl;
  let importedUserIds;
  let service;

  before(async () => {
    jellyfin = await createFakeJellyfin();
    const file = path.join(await makeTempDir(null, 'jfa-http-test-'), 'grants.json');
    const store = new GrantStore(file);
    await store.load();
    await store.upsertGroup({ id: 'grove', name: 'Grove', userIds: ['alice-id', 'bob-id'] });
    const jellyfinClient = new JellyfinClient(jellyfin.url, 'test-key');
    importedUserIds = [];
    const seerr = {
      async getRecentRequests(take, jellyfinItemIds) {
        assert.equal(take, 12);
        assert.equal(jellyfinItemIds.has('item-2'), true);
        return [{ id: 136, mediaType: 'tv', title: 'Recent Series', year: 2026, posterPath: '/poster.jpg', jellyfinItemId: 'item-2', requestStatus: 'approved', mediaStatus: 'partially_available', requestedBy: 'Alice', createdAt: '2026-08-29T03:46:03.000Z', seasonCount: 2 }];
      },
      async getPoster(pathname) {
        assert.equal(pathname, '/poster.jpg');
        return { body: new Uint8Array([255, 216, 255, 217]), contentType: 'image/jpeg' };
      },
      async importJellyfinUser(jellyfinUserId) {
        if (jellyfinUserId === 'import-failure-id') throw new Error('simulated Seerr failure');
        importedUserIds.push(jellyfinUserId);
        return { status: 'imported', user: { id: 44, jellyfinUserId } };
      },
    };
    service = new AccessService(jellyfinClient, store, undefined, seerr);
    const webAuth = new WebAuth(jellyfinClient, { loginFailureDelayMs: 0 });
    // The admin listener (bridgeUrl) and the member listener (memberUrl, household hosts).
    ({ admin: bridge, member } = makeServers(service, { webhook: 'webhook-secret', admin: 'admin-secret' }, webAuth, {
      householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-' },
    }));
    await Promise.all([bridge, member].map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
    bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
    memberUrl = `http://127.0.0.1:${member.address().port}`;
  });

  after(async () => {
    bridge.closeAllConnections();
    member.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => bridge.close(resolve)),
      new Promise((resolve) => member.close(resolve)),
      jellyfin.close(),
    ]);
  });

  it('processes a webhook through both HTTP services', async () => {
    const root = await fetch(`${bridgeUrl}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/admin/');

    const householdUsers = await fetchWithHost(memberUrl, '/Users/Public', 'jelly-grove.example.test');
    assert.equal(householdUsers.status, 200);
    const householdUsersBody = await householdUsers.json();
    assert.deepEqual(householdUsersBody.map((user) => user.Name), ['Alice', 'Bob']);
    assert.deepEqual(householdUsersBody.map((user) => user.HasPassword), [true, true]);
    const householdInfo = await fetchWithHost(memberUrl, '/System/Info/Public', 'jelly-grove.example.test');
    assert.equal(householdInfo.status, 200);
    assert.equal((await householdInfo.json()).ServerName, 'Test Jellyfin');
    const householdBranding = await fetchWithHost(memberUrl, '/Branding/Configuration', 'jelly-grove.example.test');
    assert.equal(householdBranding.status, 200);
    const householdBrandingBody = await householdBranding.json();
    assert.match(householdBrandingBody.CustomCss, /existing-branding/);
    assert.doesNotMatch(householdBrandingBody.CustomCss, /#loginPage \.manualLoginForm/);
    // Manual login stays (hidden members sign in by name), so neither it nor the container it sits in is hidden.
    assert.doesNotMatch(householdBrandingBody.CustomCss, /\.readOnlyContent|\.btnManual/);
    assert.match(householdBrandingBody.CustomCss, /#loginPage \.btnQuick/);
    assert.match(householdBrandingBody.CustomCss, /#loginPage \.btnForgotPassword/);
    assert.match(householdBrandingBody.CustomCss, /#loginPage \.btnSelectServer/);
    assert.match(householdBrandingBody.LoginDisclaimer, /<style id="jellypass-household-profile-picker">/);
    assert.doesNotMatch(householdBrandingBody.LoginDisclaimer, /#loginPage \.manualLoginForm|\.btnManual|\.readOnlyContent/);
    assert.match(householdBrandingBody.LoginDisclaimer, /#loginPage \.btnQuick/);
    const householdQuickConnect = await fetchWithHost(memberUrl, '/QuickConnect/Enabled', 'jelly-grove.example.test');
    assert.equal(householdQuickConnect.status, 200);
    assert.equal(await householdQuickConnect.json(), false);
    assert.equal(householdQuickConnect.headers.get('cache-control'), 'no-store');
    const householdLogin = await fetchWithHost(memberUrl, '/Users/AuthenticateByName', 'jelly-grove.example.test', {
      method: 'POST',
      headers: { Authorization: jellyfinAuthorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'Alice', Pw: 'user-password' }),
    });
    assert.equal(householdLogin.status, 200);
    const householdAuthentication = await householdLogin.json();
    assert.equal(householdAuthentication.User.Name, 'Alice');
    const forgotPassword = await fetchWithHost(memberUrl, '/Users/ForgotPassword', 'jelly-grove.example.test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ EnteredUsername: 'Alice' }),
    });
    assert.equal(forgotPassword.status, 403);
    assert.equal((await forgotPassword.json()).error, 'household_password_recovery_disabled');
    const forgotPasswordPin = await fetchWithHost(memberUrl, '/Users/ForgotPassword/Pin', 'jelly-grove.example.test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Pin: '000000' }),
    });
    assert.equal(forgotPasswordPin.status, 403);
    const nonHouseholdLogin = await fetchWithHost(memberUrl, '/Users/AuthenticateByName', 'jelly-grove.example.test', {
      method: 'POST',
      headers: { Authorization: jellyfinAuthorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'Admin', Pw: 'admin-password' }),
    });
    assert.equal(nonHouseholdLogin.status, 401, 'a household hostname must not proxy logins for users outside that household');
    assert.equal((await nonHouseholdLogin.json()).error, 'invalid_credentials');
    assert.match(await upgradeWithHost(memberUrl, '/socket', 'jelly-grove.example.test'), /^HTTP\/1\.1 101/);
    const missingHousehold = await fetchWithHost(memberUrl, '/Users/Public', 'jelly-missing.example.test');
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
    assert.match(adminMarkup, /id="import-to-seerr"/);
    assert.doesNotMatch(adminMarkup, /id="import-to-seerr"[^>]*checked/);
    assert.match(adminMarkup, /Import into Seerr/);
    assert.match(adminMarkup, /Seerr applies its configured default permissions/);
    assert.match(adminMarkup, /<div class="eyebrow">Activity<\/div><h2>Recent requests<\/h2>/);
    assert.doesNotMatch(adminMarkup, /Jellyseerr/i);

    const adminScript = await fetch(`${bridgeUrl}/admin/app.js`);
    assert.equal(adminScript.status, 200);
    const adminScriptText = await adminScript.text();
    assert.match(adminScriptText, /\/v1\/library\/access/);
    assert.match(adminScriptText, /Your media library/);
    assert.match(adminScriptText, /Access grants/);
    assert.match(adminScriptText, /function catalogItem/);
    assert.match(adminScriptText, /v1\/library\/poster\?itemId=/);
    assert.match(adminScriptText, /text: displayTitle/);
    assert.match(adminScriptText, /function scrollToTop/);
    assert.match(adminScriptText, /window\.scrollTo\(0, 0\)/);
    assert.match(adminScriptText, /Access groups/);
    assert.match(adminScriptText, /\/v1\/requests\/recent/);
    assert.match(adminScriptText, /'Activity unavailable'/);
    // Contract identifiers (jellyseerrImportAvailable, importToJellyseerr, error codes) keep their names; no user-facing "Jellyseerr" text.
    assert.doesNotMatch(adminScriptText, /\bJellyseerr/);
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
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'Admin', password: 'wrong-password' }),
    });
    assert.equal(badLogin.status, 401);
    await badLogin.json();

    const nonAdminLogin = await fetch(`${bridgeUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'Alice', password: 'user-password' }),
    });
    assert.equal(nonAdminLogin.status, 401);
    await nonAdminLogin.json();

    const login = await fetch(`${bridgeUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'Admin', password: 'admin-password' }),
    });
    assert.equal(login.status, 200);
    await login.json();
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /^__Host-jellypass_session=/);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie.split(', ')[0], /Domain=/i);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    assert.equal(jellyfin.logoutCount, 2);
    const sessionCookie = setCookie.split(';')[0];
    // What the admin UI's own fetches carry: the cookie, over HTTPS behind the proxy, from the admin origin.
    const sessionHeaders = { Cookie: sessionCookie, 'X-Forwarded-Proto': 'https', 'Sec-Fetch-Site': 'same-origin' };

    const sessionUsers = await fetch(`${bridgeUrl}/v1/users`, { headers: { ...sessionHeaders } });
    assert.equal(sessionUsers.status, 200);
    const sessionUsersBody = await sessionUsers.json();
    assert.deepEqual(sessionUsersBody.users.map((user) => user.name), ['Admin', 'Alice', 'Bob']);
    assert.equal(sessionUsersBody.jellyseerrImportAvailable, true);
    const groups = await fetch(`${bridgeUrl}/v1/groups`, { headers: { ...sessionHeaders } });
    assert.equal(groups.status, 200);
    assert.equal((await groups.json()).groups[0].householdUrl, 'https://jelly-grove.example.test');

    const shortPassword = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Charlie', password: 'short', groupId: 'grove' }),
    });
    assert.equal(shortPassword.status, 400);
    assert.match((await shortPassword.json()).error, /empty or contain between 8 and 256/);

    const missingGroup = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Charlie', password: 'charlie-password', groupId: 'missing' }),
    });
    assert.equal(missingGroup.status, 404);
    assert.equal((await missingGroup.json()).error, 'group not found: missing');

    const createdUser = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Charlie', password: '', groupId: 'grove' }),
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
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'charlie', password: 'another-password', groupId: 'grove' }),
    });
    assert.equal(duplicateUser.status, 400);
    assert.equal((await duplicateUser.json()).error, 'username is already in use');

    const importedUser = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Dana', password: 'dana-password', groupId: 'grove', importToJellyseerr: true }),
    });
    assert.equal(importedUser.status, 201);
    const importedBody = await importedUser.json();
    assert.deepEqual(importedBody.jellyseerr, { status: 'imported', userId: 44 });
    assert.deepEqual(importedUserIds, ['dana-id']);
    const protectedUserLogin = await fetchWithHost(memberUrl, '/Users/AuthenticateByName', 'jelly-grove.example.test', {
      method: 'POST',
      headers: { Authorization: jellyfinAuthorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'Dana', Pw: 'dana-password' }),
    });
    assert.equal(protectedUserLogin.status, 200);
    assert.equal((await protectedUserLogin.json()).User.Name, 'Dana');

    const failedImport = await fetch(`${bridgeUrl}/v1/users`, {
      method: 'POST',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Import Failure', password: 'failure-password', groupId: 'grove', importToJellyseerr: true }),
    });
    assert.equal(failedImport.status, 502);
    const failedImportBody = await failedImport.json();
    assert.equal(failedImportBody.code, 'user_created_jellyseerr_import_failed');
    assert.deepEqual(failedImportBody.user, { id: 'import-failure-id', name: 'Import Failure', isAdministrator: false });
    assert.equal(failedImportBody.group.id, 'grove');
    assert.match(failedImportBody.error, /created and assigned.*Seerr import failed/);
    assert.doesNotMatch(failedImportBody.error, /Jellyseerr/i);
    const updatedHouseholdUsers = await fetchWithHost(memberUrl, '/Users/Public', 'jelly-grove.example.test');
    const updatedHouseholdUsersBody = await updatedHouseholdUsers.json();
    assert.deepEqual(updatedHouseholdUsersBody.map((user) => user.Name), ['Alice', 'Bob', 'Charlie', 'Dana', 'Import Failure']);
    assert.deepEqual(updatedHouseholdUsersBody.map((user) => user.HasPassword), [true, true, false, true, true]);
    assert.equal(updatedHouseholdUsersBody[2].HasConfiguredPassword, false);

    const markAlice = await fetch(`${bridgeUrl}/v1/users/alice-id/sign-in`, {
      method: 'PUT',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordless: true }),
    });
    assert.equal(markAlice.status, 200);
    assert.deepEqual((await markAlice.json()).user, { id: 'alice-id', passwordless: true });
    const markedUsers = await fetch(`${bridgeUrl}/v1/users`, { headers: { ...sessionHeaders } });
    assert.deepEqual(
      (await markedUsers.json()).users.filter((user) => user.passwordless).map((user) => user.name),
      ['Alice', 'Charlie'],
    );
    const markedHouseholdUsers = await fetchWithHost(memberUrl, '/Users/Public', 'jelly-grove.example.test');
    assert.deepEqual((await markedHouseholdUsers.json()).map((user) => user.HasPassword), [false, true, false, true, true]);
    const directPublicUsers = await fetch(`${jellyfin.url}/Users/Public`);
    assert.ok((await directPublicUsers.json()).every((user) => user.HasPassword === true));
    const unmarkAlice = await fetch(`${bridgeUrl}/v1/users/alice-id/sign-in`, {
      method: 'PUT',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordless: false }),
    });
    assert.equal(unmarkAlice.status, 200);
    const unmarkedHouseholdUsers = await fetchWithHost(memberUrl, '/Users/Public', 'jelly-grove.example.test');
    assert.deepEqual((await unmarkedHouseholdUsers.json()).map((user) => user.HasPassword), [true, true, false, true, true]);
    const markAdmin = await fetch(`${bridgeUrl}/v1/users/admin-id/sign-in`, {
      method: 'PUT',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordless: true }),
    });
    assert.equal(markAdmin.status, 400);
    const markMissing = await fetch(`${bridgeUrl}/v1/users/missing-id/sign-in`, {
      method: 'PUT',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordless: true }),
    });
    assert.equal(markMissing.status, 404);
    const invalidMark = await fetch(`${bridgeUrl}/v1/users/alice-id/sign-in`, {
      method: 'PUT',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordless: 'yes' }),
    });
    assert.equal(invalidMark.status, 400);
    const newUserLogin = await fetchWithHost(memberUrl, '/Users/AuthenticateByName', 'jelly-grove.example.test', {
      method: 'POST',
      headers: { Authorization: jellyfinAuthorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'Charlie', Pw: '' }),
    });
    assert.equal(newUserLogin.status, 200);
    assert.equal((await newUserLogin.json()).User.Name, 'Charlie');

    const librarySearch = await fetch(`${bridgeUrl}/v1/library/search?q=Second`, { headers: { ...sessionHeaders } });
    assert.equal(librarySearch.status, 200);
    assert.deepEqual((await librarySearch.json()).items, [{ id: 'item-2', name: 'Second Movie', mediaType: 'movie', productionYear: 2026 }]);

    const catalogSync = await fetch(`${bridgeUrl}/v1/library/sync`, { method: 'POST', headers: { ...sessionHeaders } });
    assert.equal(catalogSync.status, 200);
    assert.equal((await catalogSync.json()).items.length, 2);
    const catalog = await fetch(`${bridgeUrl}/v1/library`, { headers: { ...sessionHeaders } });
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).items.length, 2);
    const libraryPoster = await fetch(`${bridgeUrl}/v1/library/poster?itemId=item-1`, { headers: { ...sessionHeaders } });
    assert.equal(libraryPoster.status, 200);
    assert.equal(libraryPoster.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(new Uint8Array(await libraryPoster.arrayBuffer()), new Uint8Array([255, 216, 255, 217]));

    const recentRequests = await fetch(`${bridgeUrl}/v1/requests/recent`, { headers: { ...sessionHeaders } });
    assert.equal(recentRequests.status, 200);
    assert.equal((await recentRequests.json()).requests[0].title, 'Recent Series');
    const requestPoster = await fetch(`${bridgeUrl}/v1/requests/poster?path=%2Fposter.jpg`, { headers: { ...sessionHeaders } });
    assert.equal(requestPoster.status, 200);
    assert.equal(requestPoster.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(new Uint8Array(await requestPoster.arrayBuffer()), new Uint8Array([255, 216, 255, 217]));

    const manualBody = JSON.stringify({ itemIds: ['item-2'], userIds: ['bob-id'], groupIds: [] });
    const manualPreview = await fetch(`${bridgeUrl}/v1/library/access?dryRun=true`, {
      method: 'PUT',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: manualBody,
    });
    assert.equal(manualPreview.status, 200);
    assert.equal((await manualPreview.json()).result.plans[0].item.action, 'add_tag');
    assert.deepEqual(jellyfin.itemById('item-2').Tags, []);

    const manualImport = await fetch(`${bridgeUrl}/v1/library/access`, {
      method: 'PUT',
      headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
      body: manualBody,
    });
    assert.equal(manualImport.status, 200);
    assert.deepEqual((await manualImport.json()).result.currents[0].manualUserIds, ['bob-id']);
    assert.deepEqual(jellyfin.itemById('item-2').Tags, ['jfa:private:item-2']);
    assert.deepEqual(jellyfin.user('alice-id').Policy.BlockedTags, ['jfa:private:item-2']);

    const unauthorized = await fetch(`${bridgeUrl}/webhooks/seerr`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    await unauthorized.json();

    const adminHeaders = { Authorization: 'Bearer admin-secret' };
    const readMetrics = async () => (await fetch(bridgeUrl + '/metrics', { headers: adminHeaders })).text();
    const status = async () => (await fetch(bridgeUrl + '/v1/webhooks/status', { headers: adminHeaders })).json();
    const metricsBefore = await readMetrics();
    const statusBefore = await status();
    for (const token of ['wrong', 'wrong-secret!!']) {
      const wrongQuery = await fetch(bridgeUrl + '/webhooks/seerr?token=' + token, { method: 'POST', body: '{}' });
      assert.equal(wrongQuery.status, 400);
      await wrongQuery.json();
      assert.equal(await readMetrics(), metricsBefore);
      assert.deepEqual(await status(), statusBefore);
    }

    const queryAuthenticated = await fetch(`${bridgeUrl}/webhooks/seerr?token=webhook-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationType: 'TEST_NOTIFICATION', request: { id: '1' } }),
    });
    assert.equal(queryAuthenticated.status, 400);
    assert.deepEqual(await queryAuthenticated.json(), { error: 'webhook_query_token_removed_use_authorization_header' });

    assert.match(await readMetrics(), /jfa_webhooks_total\{result="removed_form"\} 1/);
    assert.deepEqual((await readMetrics()).match(/^jfa_last_webhook_received_timestamp_seconds .+$/m)?.[0], metricsBefore.match(/^jfa_last_webhook_received_timestamp_seconds .+$/m)?.[0]);
    assert.equal(typeof (await status()).lastRemovedFormAt, 'number');
    let receipts = 0;
    const recordReceipt = service.recordWebhookReceived.bind(service);
    service.recordWebhookReceived = () => { receipts++; recordReceipt(); };
    try {
      const reduced = await fetch(bridgeUrl + '/webhooks/seerr', {
        method: 'POST',
        headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationType: 'MEDIA_AVAILABLE', request: { id: '1' } }),
      });
      assert.equal(reduced.status, 400);
      assert.deepEqual(await reduced.json(), { error: 'webhook_payload_removed_use_current_seerr_template' });
      assert.equal(receipts, 1);
      assert.match(await readMetrics(), /jfa_webhooks_total\{result="removed_form"\} 2/);
    } finally {
      service.recordWebhookReceived = recordReceipt;
    }

    const seerrTest = await fetch(`${bridgeUrl}/webhooks/seerr`, {
      method: 'POST',
      headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationType: 'TEST_NOTIFICATION', event: '', media: {}, request: { id: '', requestedBy: { jellyfinUserId: '', username: '' } } }),
    });
    assert.equal(seerrTest.status, 202);
    assert.deepEqual(await seerrTest.json(), { status: 'ignored' });
    assert.deepEqual(await status(), { lastRemovedFormAt: null });

    const unknownType = await fetch(`${bridgeUrl}/webhooks/seerr`, {
      method: 'POST',
      headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationType: 'MEDIA_PENDING' }),
    });
    assert.equal(unknownType.status, 202);
    assert.deepEqual(await unknownType.json(), { status: 'ignored' });

    const unauthorizedTest = await fetch(`${bridgeUrl}/webhooks/seerr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationType: 'TEST_NOTIFICATION' }),
    });
    assert.equal(unauthorizedTest.status, 401);
    await unauthorizedTest.json();

    const emptyAvailableId = await fetch(`${bridgeUrl}/webhooks/seerr`, {
      method: 'POST',
      headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationType: 'MEDIA_AVAILABLE', request: { id: '' } }),
    });
    assert.equal(emptyAvailableId.status, 400);
    assert.deepEqual(await emptyAvailableId.json(), { error: 'id must be a non-empty string' });

    const unfilledType = await fetch(`${bridgeUrl}/webhooks/seerr`, {
      method: 'POST',
      headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationType: '{{notification_type}}', request: { id: '' } }),
    });
    assert.equal(unfilledType.status, 400);
    assert.deepEqual(await unfilledType.json(), { error: 'notificationType is invalid' });

    const malformed = await fetch(`${bridgeUrl}/webhooks/seerr`, {
      method: 'POST',
      headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
      body: 'eyJub3RpZmljYXRpb25UeXBlIjoi',
    });
    assert.equal(malformed.status, 400);
    await malformed.json();

    const response = await fetch(`${bridgeUrl}/webhooks/seerr`, {
      method: 'POST',
      headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notificationType: 'MEDIA_AVAILABLE',
        event: 'Movie Request Now Available',
        media: { jellyfinMediaId: 'item-1', mediaType: 'movie' },
        request: { id: '17', requestedBy: { jellyfinUserId: 'alice-id' } },
      }),
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.deepEqual(jellyfin.item.Tags, ['existing', 'jfa:private:item-1']);
    assert.deepEqual(jellyfin.itemById('trailer-1').Tags, ['jfa:private:item-1']);
    // Bob shares Alice's household, so Alice's request is visible to him too.
    assert.deepEqual(jellyfin.user('bob-id').Policy.BlockedTags, []);

    const ownerStream = await fetchWithHost(memberUrl, '/Videos/trailer-1/stream?Static=true', 'jelly-grove.example.test', {
      headers: { Authorization: jellyfinAuthorization(householdAuthentication.AccessToken), Range: 'bytes=0-0' },
    });
    assert.equal(ownerStream.status, 206, await ownerStream.text());
    const ownerPlaylist = await fetchWithHost(
      memberUrl,
      `/Videos/trailer-1/master.m3u8?ApiKey=${encodeURIComponent(householdAuthentication.AccessToken)}`,
      'jelly-grove.example.test',
    );
    assert.equal(ownerPlaylist.status, 200, await ownerPlaylist.text());
    const memberLogin = await fetchWithHost(memberUrl, '/Users/AuthenticateByName', 'jelly-grove.example.test', {
      method: 'POST',
      headers: { Authorization: jellyfinAuthorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'Bob', Pw: 'user-password' }),
    });
    const memberAuthentication = await memberLogin.json();
    const memberStream = await fetchWithHost(memberUrl, '/Videos/trailer-1/stream?Static=true', 'jelly-grove.example.test', {
      headers: { Authorization: jellyfinAuthorization(memberAuthentication.AccessToken), Range: 'bytes=0-0' },
    });
    assert.equal(memberStream.status, 206, await memberStream.text());

    const metrics = await fetch(`${bridgeUrl}/metrics`, { headers: { Authorization: 'Bearer admin-secret' } });
    assert.equal(metrics.status, 200);
    const metricsText = await metrics.text();
    assert.match(metricsText, /jfa_webhooks_total\{result="granted"\} 1/);
    assert.match(metricsText, /jfa_webhooks_total\{result="ignored"\} 2/);
    assert.match(metricsText, /jfa_webhooks_total\{result="invalid"\} 3/);
    assert.match(metricsText, /jfa_last_webhook_received_timestamp_seconds \d{10}/);

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
    // The household attached by the request stays until an administrator removes it.
    assert.deepEqual(jellyfin.item.Tags, ['existing', 'jfa:private:item-1']);
    const clearGroups = await fetch(`${bridgeUrl}/v1/grants/item-1/groups`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds: [] }),
    });
    assert.equal(clearGroups.status, 200);
    await clearGroups.json();
    assert.deepEqual(jellyfin.item.Tags, ['existing']);
    assert.deepEqual(jellyfin.itemById('trailer-1').Tags, []);
    assert.deepEqual(jellyfin.user('bob-id').Policy.BlockedTags, []);
  });

  it('returns 401 without and 404 with admin credentials for the removed JellyQuest routes', async () => {
    const removed = [
      ['GET', '/jellyquest-bridge/bridge.html'],
      ['GET', '/jellyquest-bridge/health'],
      ['POST', '/jellyquest-bridge/session'],
      ['POST', '/jellyquest-bridge/eligibility'],
      ['POST', '/jellyquest-bridge/proxy'],
      ['GET', '/jellyquest/access?mediaType=movie&tmdbId=101'],
      ['POST', '/jellyquest/access'],
      ['GET', '/jellyquest/access/claims'],
    ];
    for (const [method, pathname] of removed) {
      const anonymous = await fetch(`${bridgeUrl}${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      assert.equal(anonymous.status, 401, `${method} ${pathname} without credentials`);
      assert.deepEqual(await anonymous.json(), { error: 'unauthorized' });
      const response = await fetch(`${bridgeUrl}${pathname}`, {
        method,
        headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      assert.equal(response.status, 404, `${method} ${pathname}`);
      await response.arrayBuffer();
    }
  });

  it('refuses removed bridge paths on household hostnames', async () => {
    const response = await fetchWithHost(memberUrl, '/jellyquest-bridge/health', 'jelly-grove.example.test');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.notEqual(jellyfin.requestedPaths.at(-1), '/jellyquest-bridge/health');
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

function jellyfinAuthorization(token) {
  return `MediaBrowser Client="JellyPass Test", Device="Test", DeviceId="jellypass-http-test", Version="1.0.0"${token ? `, Token="${encodeURIComponent(token)}"` : ''}`;
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

describe('webhook resolution errors over HTTP', { timeout: 5_000 }, () => {
  const servers = [];

  async function webhookServer(seerr) {
    const store = new GrantStore(path.join(await makeTempDir(null, 'jfa-http-webhook-'), 'grants.json'));
    await store.load();
    const service = new AccessService(new JellyfinClient('http://127.0.0.1:9', 'test-key'), store, undefined, seerr);
    const server = makeServers(service, { webhook: 'webhook-secret', admin: 'admin-secret' }).admin;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const send = async (body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/seerr`, {
        method: 'POST',
        headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    send.service = service;
    return send;
  }

  after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  const available = (id, event) => ({
    notificationType: 'MEDIA_AVAILABLE',
    event,
    media: { jellyfinMediaId: 'item-1', mediaType: 'movie' },
    request: { id, requestedBy: { jellyfinUserId: 'alice-id' } },
  });

  it('returns 400 for a request without its Jellyfin media ID, HD or 4K alike', async () => {
    const send = await webhookServer({
      async getRequest(requestId) {
        return requestId === '4'
          ? { id: 4, is4k: true, requestedBy: { jellyfinUserId: 'alice-id' }, media: { jellyfinMediaId: 'item-1' } }
          : { id: 5, is4k: false, requestedBy: { jellyfinUserId: 'alice-id' }, media: {} };
      },
    });
    assert.deepEqual(await send(available('4', '4K Movie Request Now Available')), {
      status: 400, body: { error: 'Seerr request 4 is missing a 4K Jellyfin media ID' },
    });
    const hd = available('5', 'Movie Request Now Available');
    delete hd.media.jellyfinMediaId;
    assert.deepEqual(await send(hd), { status: 400, body: { error: 'Seerr request 5 is missing a Jellyfin media ID' } });
  });

  it('counts a malformed or invalid body once as invalid and never as an error', async () => {
    const send = await webhookServer(undefined);
    assert.equal((await send('{"notificationType":')).status, 400);
    assert.equal((await send({ notificationType: 'MEDIA_AVAILABLE', request: { id: '{{request_id}}' } })).status, 400);
    const metrics = send.service.renderMetrics();
    assert.match(metrics, /jfa_webhooks_total\{result="invalid"\} 2\n/);
    assert.doesNotMatch(metrics, /result="error"/);
  });

  it('returns 202 ignored for a replayed webhook whose request an administrator revoked', async () => {
    const jellyfin = {
      item: { Id: 'item-1', Name: 'Movie', Tags: [] },
      users: [
        { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
        { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: [] } },
      ],
      async getItem() { return structuredClone(this.item); },
      async getUsers() { return structuredClone(this.users); },
      async getLocalTrailers() { return []; },
      async updateItem(item) { this.item = structuredClone(item); },
      async updatePolicy(userId, policy) { this.users.find((user) => user.Id === userId).Policy = structuredClone(policy); },
    };
    // Kept until the file finishes: the server using it is closed in the suite's after hook, not by this test.
    const store = new GrantStore(path.join(await makeTempDir(null, 'jfa-http-replay-'), 'grants.json'));
    await store.load();
    const service = new AccessService(jellyfin, store);
    const server = makeServers(service, { webhook: 'webhook-secret', admin: 'admin-secret' }).admin;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const send = async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/seerr`, {
        method: 'POST',
        headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify(available('17', 'Movie Request Now Available')),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await send()).status, 200);
    await service.revokeRequest('item-1', '17');
    assert.deepEqual(await send(), { status: 202, body: { status: 'ignored' } });
    assert.deepEqual(jellyfin.item.Tags, []);
  });

  it('applies a stored grant when Seerr retries a webhook whose Jellyfin update failed', async () => {
    const jellyfin = {
      item: { Id: 'item-1', Name: 'Movie', Tags: [] },
      failUpdates: true,
      users: [
        { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
        { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: [] } },
        { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: [] } },
      ],
      async getItem() { return structuredClone(this.item); },
      async getUsers() { return structuredClone(this.users); },
      async getLocalTrailers() { return []; },
      async updateItem(item) {
        if (this.failUpdates) throw new Error('Jellyfin unavailable');
        this.item = structuredClone(item);
      },
      async updatePolicy(userId, policy) { this.users.find((user) => user.Id === userId).Policy = structuredClone(policy); },
    };
    // Kept until the file finishes: the server using it is closed in the suite's after hook, not by this test.
    const store = new GrantStore(path.join(await makeTempDir(null, 'jfa-http-retry-'), 'grants.json'));
    await store.load();
    const service = new AccessService(jellyfin, store);
    const server = makeServers(service, { webhook: 'webhook-secret', admin: 'admin-secret' }).admin;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const send = async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/seerr`, {
        method: 'POST',
        headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify(available('17', 'Movie Request Now Available')),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual(await send(), { status: 502, body: { error: 'Jellyfin unavailable' } });
    assert.equal(store.get('item-1').sync.state, 'error');

    jellyfin.failUpdates = false;
    const retried = await send();
    assert.equal(retried.status, 200);
    assert.equal(retried.body.grant.sync.state, 'synced');
    assert.deepEqual(retried.body.grant.requests, { '17': 'alice-id' });
    assert.deepEqual(jellyfin.item.Tags, ['jfa:private:item-1']);
    assert.deepEqual(jellyfin.users.find((user) => user.Id === 'bob-id').Policy.BlockedTags, ['jfa:private:item-1']);
    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_webhooks_total\{result="error"\} 1\n/);
    assert.match(metrics, /jfa_webhooks_total\{result="granted"\} 1\n/);
  });

  it('returns 502 for a 4K event when Seerr lookup is not configured', async () => {
    const send = await webhookServer(undefined);
    assert.deepEqual(await send(available('6', '4K Movie Now Available')), {
      status: 502, body: { error: 'webhook is for a 4K request and Seerr lookup is not configured' },
    });
  });

  it('returns 502 for an event that does not name an HD request when Seerr lookup is not configured', async () => {
    const send = await webhookServer(undefined);
    for (const [id, event] of [['8', ''], ['9', '{{event}}'], ['10', 'Something Else']]) {
      assert.deepEqual(await send(available(id, event)), {
        status: 502, body: { error: 'webhook event does not name an HD request and Seerr lookup is not configured' },
      }, String(event));
    }
  });
});
