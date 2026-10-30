import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changelogSection } from '../scripts/changelog-section.mjs';

const CHANGELOG_PATH = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/changelog-section.mjs', import.meta.url));
const CHANGELOG = readFileSync(CHANGELOG_PATH, 'utf8');

const DEFINITION = /^\[([^\]]+)\]: /;

function split(notes) {
  const lines = notes.trimEnd().split('\n');
  const definitions = lines.filter((line) => DEFINITION.test(line));
  const body = lines.filter((line) => !DEFINITION.test(line)).join('\n').trimEnd();
  return { body, definitions };
}

function definedLabels(changelog) {
  return new Set(changelog.split('\n').map((line) => DEFINITION.exec(line)?.[1]).filter(Boolean));
}

// Every reference-style link in the body that the changelog defines is appended,
// and nothing else is.
function assertDefinitionsMatchReferences(notes) {
  const { body, definitions } = split(notes);
  const defined = definedLabels(CHANGELOG);
  const referenced = [...new Set([...body.matchAll(/\[([^\]]+)\](?!\()/g)].map((match) => match[1]))]
    .filter((label) => defined.has(label));
  assert.deepEqual(
    definitions.map((line) => DEFINITION.exec(line)[1]).sort(),
    referenced.sort(),
  );
}

function assertSection(notes, { version, nextVersion, subheadings }) {
  const { body, definitions } = split(notes);
  assert.ok(body.length > 0);
  assert.doesNotMatch(body, /^\s/, 'starts with content, not blank lines');
  assert.doesNotMatch(body, /^## /m, 'has no version heading');
  for (const subheading of subheadings) assert.match(body, new RegExp(`^### ${subheading}$`, 'm'));
  assert.ok(!definitions.some((line) => line.startsWith(`[${version}]:`)), 'no definition for its own heading');
  if (nextVersion) {
    const next = changelogSection(CHANGELOG, nextVersion);
    assert.ok(!body.includes(split(next).body), `stops before ${nextVersion}`);
  }
  assert.ok(!definitions.some((line) => line.startsWith('[Unreleased]:')));
  assertDefinitionsMatchReferences(notes);
}

describe('changelogSection with the real CHANGELOG.md', () => {
  it('extracts 3.9.0 without its heading, up to the 3.8.1 section', () => {
    const notes = changelogSection(CHANGELOG, '3.9.0');
    assertSection(notes, {
      version: '3.9.0',
      nextVersion: '3.8.1',
      subheadings: ['Added'],
    });
    assert.match(notes, /^This is a minor release for the TV add-on/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*unless `TV_ADDON_ENABLED` is set, nothing changes\*\* on any host/);
    assert.match(flat, /This is a minor release because the add-on gains pages/);
    assert.match(flat, /the gateway are as in 3\.8\.1/);
    assert.match(flat, /\*\*Nothing to configure\.\*\* No setting is new/);
    assert.match(flat, /\*\*The state file is unchanged\*\* \(schema v7, with the same fields as 3\.8\.1\), so 3\.8\.1 reads a state file written by 3\.9\.0/);
    assert.match(flat, /both names change in this release/);
    assert.match(flat, /\*\*It has been tested in a real Jellyfin 12\.3 container,\*\* .* \*\*The See all pages have not been seen on a physical TV\*\*/);
    assert.match(flat, /gets the new add-on at its next start\. Nothing is reinstalled on the TV/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.8\.1`/);
    assert.match(flat, /No state-file or setting change is needed/);
    assert.match(flat, /`mobile\/CHANGELOG\.md`/);
    assert.match(flat, /\*\*TV add-on: See all on the Discover rows\.\*\*/);
    assert.match(flat, /`#\/jellypass\/list\/<list>`/);
    assert.match(flat, /\*\*TV add-on: a Back button on JellyPass pages in the desktop layout,\*\*/);
    assert.match(flat, /belongs to the session: after a sign-out, another member's sign-in or a new token, Back goes to Home/);
    const added = notes.indexOf('### Added');
    for (const note of [
      '**Nothing to configure.**',
      '**The state file is unchanged**',
      '**No CDN purge is needed.**',
      '**It has been tested in a real Jellyfin 12.3 container,**',
      '**The Samsung app picks it up by itself.**',
      '**To roll back,**',
      '**The iPhone, iPad and Android app ships separately;**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < added, `upgrade note ${note} comes first`);
    }
    assert.equal(notes.match(/^- \*\*TV add-on: /gm)?.length, 2, 'one entry per change, none repeated');
    assert.doesNotMatch(notes, /### (?:Security|Changed|Fixed|TV add-on)/);
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b|Jest/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]|design-ref|farmhouse|TU7000|sdb\b/i, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.8.1 without its heading, up to the 3.8.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.8.1');
    assertSection(notes, {
      version: '3.8.1',
      nextVersion: '3.8.0',
      subheadings: ['Changed'],
    });
    assert.match(notes, /^This is a patch release for the TV add-on/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*unless `TV_ADDON_ENABLED` is set, nothing changes\*\* on any host/);
    assert.match(flat, /the gateway are as in 3\.8\.0\. Only the add-on's script changes/);
    assert.match(flat, /\*\*Nothing to configure\.\*\* No setting is new/);
    assert.match(flat, /\*\*The state file is unchanged\*\* \(schema v7, with the same fields as 3\.8\.0\), so 3\.8\.0 reads a state file written by 3\.8\.1/);
    assert.match(flat, /the script's name changes in this release and the stylesheet, which is unchanged, keeps its name/);
    assert.match(flat, /gets the new add-on at its next start\. Nothing is reinstalled on the TV/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.8\.0`/);
    assert.match(flat, /No state-file or setting change is needed/);
    assert.match(flat, /`mobile\/CHANGELOG\.md`/);
    assert.match(flat, /\*\*TV add-on: the "Hide what I have" toggle is now called "New only"\.\*\*/);
    assert.match(flat, /"New only: show only titles you don't have or haven't requested"/);
    const changed = notes.indexOf('### Changed');
    for (const note of [
      '**Nothing to configure.**',
      '**The state file is unchanged**',
      '**No CDN purge is needed.**',
      '**The Samsung app picks it up by itself.**',
      '**To roll back,**',
      '**The iPhone, iPad and Android app ships separately;**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < changed, `upgrade note ${note} comes first`);
    }
    assert.equal(notes.match(/^- \*\*TV add-on: /gm)?.length, 1, 'one entry, not repeated');
    assert.doesNotMatch(notes, /### (?:Security|Added|Fixed)/);
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b|Jest/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]|design-ref|farmhouse|TU7000|sdb\b/i, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.8.0 without its heading, up to the 3.7.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.8.0');
    assertSection(notes, {
      version: '3.8.0',
      nextVersion: '3.7.0',
      subheadings: ['Added', 'Changed'],
    });
    assert.match(notes, /^This is a minor release for the TV add-on/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*unless `TV_ADDON_ENABLED` is set, nothing changes\*\* on any host/);
    assert.match(flat, /This is a minor release because the add-on gains pages/);
    assert.match(flat, /the gateway are as in 3\.7\.0/);
    assert.match(flat, /\*\*Nothing to configure\.\*\* No setting is new/);
    assert.match(flat, /\*\*The state file is unchanged\*\* \(schema v7, with the same fields as 3\.7\.0\), so 3\.7\.0 reads a state file written by 3\.8\.0/);
    assert.match(flat, /both names change in this release/);
    assert.match(flat, /\*\*It has been tested in a real Jellyfin 12\.3 container,\*\* .* \*\*On real Samsung TVs only what 3\.7\.0 added has been seen\*\*/);
    assert.match(flat, /\*\*the new card sizes have not been seen on a physical TV\*\*/);
    assert.match(flat, /gets the new add-on at its next start\. Nothing is reinstalled on the TV/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.7\.0`/);
    assert.match(flat, /`mobile\/CHANGELOG\.md`/);
    assert.match(flat, /\*\*TV add-on: service and studio pages\.\*\*/);
    assert.match(flat, /`#\/jellypass\/service\/<id>`, `#\/jellypass\/studio\/<id>`/);
    assert.match(flat, /\*\*TV add-on: Hide what I have is on when the Discover page opens,\*\*/);
    assert.match(flat, /\*\*TV add-on: the add-on's cards are the size of Jellyfin web's own\*\*/);
    assert.match(flat, /\*\*In library\*\*, \*\*Requested\*\*, \*\*Get this\*\* or \*\*Can't get\*\*/);
    const added = notes.indexOf('### Added');
    for (const note of [
      '**Nothing to configure.**',
      '**The state file is unchanged**',
      '**Hide what I have is now on when the Discover page opens.**',
      '**No CDN purge is needed.**',
      '**It has been tested in a real Jellyfin 12.3 container,**',
      '**The Samsung app picks it up by itself.**',
      '**To roll back,**',
      '**The iPhone, iPad and Android app ships separately.**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < added, `upgrade note ${note} comes first`);
    }
    assert.ok(added < notes.indexOf('### Changed'), 'Added comes before Changed');
    assert.equal(flat.match(/Hide what I have\*\* \(the same choice/g)?.length, 1, 'the service pages\' toggle is listed once');
    assert.equal(notes.match(/^- \*\*TV add-on: /gm)?.length, 4, 'one entry per change, none repeated');
    assert.doesNotMatch(notes, /### (?:Security|Fixed)/);
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b|Jest/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]|design-ref|farmhouse|TU7000|sdb\b/i, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.7.0 without its heading, up to the 3.6.1 section', () => {
    const notes = changelogSection(CHANGELOG, '3.7.0');
    assertSection(notes, {
      version: '3.7.0',
      nextVersion: '3.6.1',
      subheadings: ['Added'],
    });
    assert.match(notes, /^This is a minor release for the TV add-on/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*unless `TV_ADDON_ENABLED` is set, nothing changes\*\* on any host/);
    assert.match(flat, /This is a minor release because the add-on gains a page/);
    assert.match(flat, /\*\*Nothing to configure\.\*\* No setting is new/);
    assert.match(flat, /\*\*The state file is unchanged\*\* \(schema v7, with the same fields as 3\.6\.1\), so 3\.6\.1 reads a state file written by 3\.7\.0/);
    assert.match(flat, /immediately before Search\. On Jellyfin web 12\.3 it is drawn in both the TV layout and the desktop layout\. Jellyfin web 10\.11 in a desktop browser gets no button/);
    assert.match(flat, /the button does not appear, and \*\*there is no other way in\*\*/);
    assert.match(flat, /\*\*The services' headings and the studios' tiles are not links yet\.\*\*/);
    assert.match(flat, /both names change in this release/);
    assert.match(flat, /\*\*It has been tested in a real Jellyfin 12\.3 container,\*\* .* \*\*not on a real TV\*\*/);
    assert.match(flat, /\*\*Memory on a 2019 Samsung is a real-TV check:\*\*/);
    assert.match(flat, /gets the new add-on at its next start\. Nothing is reinstalled on the TV/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.6\.1`/);
    assert.match(flat, /\*\*TV add-on: the Discover page\.\*\*/);
    assert.match(flat, /\*\*In your library\*\*, \*\*Requested\*\*, \*\*Available to get\*\* or \*\*Can't request\*\*/);
    assert.match(flat, /asks for 5 things when it opens on All and 10 more/);
    const added = notes.indexOf('### Added');
    for (const note of [
      '**Nothing to configure.**',
      '**The state file is unchanged**',
      '**The Discover page is reached only from the compass button**',
      '**The services\' headings and the studios\' tiles are not links yet.**',
      '**No CDN purge is needed.**',
      '**It has been tested in a real Jellyfin 12.3 container,**',
      '**The Samsung app picks it up by itself.**',
      '**To roll back,**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < added, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### (?:Security|Changed|Fixed)/);
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /groundwork|nothing of it is visible/i, 'the groundwork entry is folded into the page');
    assert.doesNotMatch(notes, /Mobile app|mobile\/CHANGELOG/, 'mobile/ is unchanged since 3.6.1');
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]|design-ref|farmhouse/i, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.6.1 without its heading, up to the 3.6.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.6.1');
    assertSection(notes, {
      version: '3.6.1',
      nextVersion: '3.6.0',
      subheadings: ['Fixed'],
    });
    assert.match(notes, /^This is a patch release for the TV add-on/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*unless `TV_ADDON_ENABLED` is set, nothing changes\*\* on any host/);
    assert.match(flat, /\*\*Nothing to configure\.\*\* No setting is new/);
    assert.match(flat, /\*\*The state file is unchanged\*\* \(schema v7, with the same fields as 3\.6\.0\), so 3\.6\.0 reads a state file written by 3\.6\.1/);
    assert.match(flat, /both names change in this release/);
    assert.match(flat, /\*\*It has been tested in a real Jellyfin 12\.3 container,\*\* .* \*\*not on a real TV\*\*/);
    assert.match(flat, /gets the new add-on at its next start\. Nothing is reinstalled on the TV/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.6\.0`/);
    assert.match(flat, /No state-file or setting change is needed/);
    assert.match(flat, /\*\*TV add-on: the add-on's cards show a focus ring\.\*\*/);
    assert.match(flat, /uses `:focus` \(so it works on the older TVs' browsers\) and adds no key handling/);
    const fixed = notes.indexOf('### Fixed');
    for (const note of [
      '**Nothing to configure.**',
      '**The state file is unchanged**',
      '**No CDN purge is needed.**',
      '**It has been tested in a real Jellyfin 12.3 container,**',
      '**The Samsung app picks it up by itself.**',
      '**To roll back,**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < fixed, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### (?:Security|Added|Changed)/);
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /Mobile app|mobile\/CHANGELOG/, 'mobile/ is unchanged since 3.6.0');
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]|design-ref|farmhouse/i, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.6.0 without its heading, up to the 3.5.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.6.0');
    assertSection(notes, {
      version: '3.6.0',
      nextVersion: '3.5.0',
      subheadings: ['Added', 'Fixed'],
    });
    assert.match(notes, /^This is a minor release for the TV add-on/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*unless `TV_ADDON_ENABLED` is set, nothing changes\*\* on any host/);
    assert.match(flat, /\*\*Nothing to configure\.\*\* No setting is new/);
    assert.match(flat, /\*\*The state file is unchanged\*\* \(schema v7, with the same fields as 3\.5\.0\), so 3\.5\.0 reads a state file written by 3\.6\.0/);
    assert.match(flat, /both names change in this release/);
    assert.match(flat, /\*\*It has been tested in a real Jellyfin 12\.3 container,\*\* .* \*\*not on a real TV\*\*/);
    assert.match(flat, /gets the new add-on at its next start\. Nothing is reinstalled on the TV/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.5\.0`/);
    assert.match(flat, /No state-file or setting change is needed/);
    assert.match(flat, /Its 1\.1\.0 release .* is out, and its notes are in `mobile\/CHANGELOG\.md`/);
    assert.match(flat, /\*\*TV add-on: My requests\.\*\* .* \(`#\/jellypass\/requests`/);
    assert.match(flat, /pinned in `docs\/app-api\/fetch-budget\.json` \(`tv-requests`\)/);
    assert.match(flat, /\*\*TV add-on: an answer that comes back after a sign-out or a new sign-in is dropped\.\*\*/);
    const added = notes.indexOf('### Added');
    for (const note of [
      '**Nothing to configure.**',
      '**The state file is unchanged**',
      '**No CDN purge is needed.**',
      '**It has been tested in a real Jellyfin 12.3 container,**',
      '**The Samsung app picks it up by itself.**',
      '**To roll back,**',
      '**The iPhone, iPad and Android app ships separately.**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < added, `upgrade note ${note} comes first`);
    }
    assert.ok(added < notes.indexOf('### Fixed'));
    assert.doesNotMatch(notes, /### (?:Security|Changed)/);
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]|design-ref|farmhouse/i, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.5.0 without its heading, up to the 3.4.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.5.0');
    assertSection(notes, {
      version: '3.5.0',
      nextVersion: '3.4.0',
      subheadings: ['Added', 'Changed'],
    });
    assert.match(notes, /^This is a minor release\. Members can cancel their own requests/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*Nothing to configure\.\*\* No setting is new/);
    assert.match(flat, /\*\*unless `TV_ADDON_ENABLED` is set, nothing about the TV changes\*\* on any host/);
    assert.match(flat, /\*\*The state file stays at schema v7 and needs no migration\.\*\* .* gains `appWithdrawals`/);
    assert.match(flat, /A state file written by 3\.5\.0 loads in 3\.4\.0/);
    assert.match(flat, /fails to sync \("Jellyfin user not found"\) and keeps what it last applied/);
    assert.match(flat, /block `POST \/jellypass\/app\/v1\/requests\/\*\/cancel`/);
    assert.match(flat, /`DELETE \/v1\/grants\/\{itemId\}\/requests\/\{requestId\}`/);
    assert.match(flat, /answers `"clear": true`: set `JELLYPASS_IMAGE` to `ghcr\.io\/nicklongmore86\/jellypass:3\.4\.0`/);
    assert.match(flat, /about one reconciliation interval \(`RECONCILE_INTERVAL_SECONDS`, 5 minutes by default\) from the later of the delete and the arrival/);
    assert.match(flat, /\(`RECONCILE_INTERVAL_SECONDS=0`\), when it has no bound/);
    assert.match(flat, /JellyPass's image does not contain it, and upgrading the server installs nothing on a TV/);
    assert.match(flat, /`mobile\/CHANGELOG\.md` \(Unreleased\) and arrive with the app's own next release/);
    assert.match(flat, /`POST \/jellypass\/app\/v1\/requests\/\{id\}\/cancel` always answers the same `202 \{"status":"accepted"\}`/);
    assert.match(flat, /`apiVersion` in `GET \/me` is now `2`/);
    assert.match(flat, /`POST \/v1\/app\/held\/\{requestId\}\/release`/);
    assert.match(flat, /limited to 60 a minute \(`429 too_many_requests`\)/);
    assert.match(flat, /\*\*My requests in the household web app can be filtered\.\*\*/);
    assert.match(flat, /`GET`\/`HEAD \/jellypass\/tv\/manifest\.json`/);
    assert.match(flat, /now sends every household following it back to Get this/);
    assert.doesNotMatch(flat, /come in a later release/, 'the apps\' Cancel buttons ship in this release');
    const added = notes.indexOf('### Added');
    for (const note of [
      '**Nothing to configure.**',
      '**The state file stays at schema v7 and needs no migration.**',
      '**Rolling back to 3.4.0 loses the cancel\'s protection.**',
      '**No CDN purge is needed.**',
      '**Administrators should cancel through the Requests tab, not by deleting a',
      '**A residual window remains.**',
      '**The Samsung app is a separate, sideloaded build.**',
      '**The iPhone, iPad and Android app ships separately.**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < added, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### (?:Security|Fixed)/);
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]|design-ref/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.4.0 without its heading, up to the 3.3.1 section', () => {
    const notes = changelogSection(CHANGELOG, '3.4.0');
    assertSection(notes, {
      version: '3.4.0',
      nextVersion: '3.3.1',
      subheadings: ['Added', 'Changed'],
    });
    assert.match(notes, /^This is a minor release\. It redesigns the TV add-on/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*unless `TV_ADDON_ENABLED` is set, nothing changes\*\* on any host/);
    assert.match(flat, /3\.3\.1 reads a state file written by 3\.4\.0/);
    assert.match(flat, /not part of the public interface described at the top of this file, so redesigning them is not a breaking change/);
    assert.match(flat, /The Home row is now headed \*\*Discover\*\* and shows only titles that can be had/);
    assert.match(flat, /at `#\/jellypass\/title\/<movie\|tv>\/<id>`, under Jellyfin's header/);
    assert.match(flat, /\*\*Back is Jellyfin's\*\*/);
    assert.match(flat, /tested in a real Jellyfin 12\.3 container,\*\* in the TV layout and the desktop layout/);
    assert.match(flat, /\*\*not on a real TV\*\*/);
    assert.match(flat, /then on an LG TV/);
    assert.match(flat, /\*\*Samsung TVs still show nothing:\*\* .* loader app/);
    assert.match(flat, /\*\*No CDN purge is needed:\*\* .* sent `no-store` .* named for a hash of their content/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.3\.1`/);
    assert.match(flat, /at most 2147483647\) shows "Not found" and makes no call/);
    assert.doesNotMatch(flat, /itemsContainer|\.pause\(\)/, 'a fix to an unreleased change is not listed');
    const added = notes.indexOf('### Added');
    for (const note of [
      '**What changes for households the add-on is on for:**',
      '**It has been tested in a real Jellyfin 12.3 container,**',
      '**Samsung TVs still show nothing:**',
      '**No CDN purge is needed:**',
      '**To roll back,**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < added, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### (?:Security|Fixed)/);
    assert.doesNotMatch(notes, /Mobile app/, 'mobile/ is unchanged since 3.3.1');
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]|design-ref/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.3.1 without its heading, up to the 3.3.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.3.1');
    assertSection(notes, {
      version: '3.3.1',
      nextVersion: '3.3.0',
      subheadings: ['Security'],
    });
    assert.match(notes, /^This is a security patch release for household hostnames/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /The main Jellyfin site and the admin host are unaffected/);
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /3\.3\.0 reads a state file written by 3\.3\.1/);
    assert.match(flat, /\*\*No CDN purge is needed:\*\*/);
    assert.match(flat, /no longer works on another household's hostname/);
    assert.match(flat, /with no token, or with a token that is not one of the household's members', gets `401 \{"error":"unauthorized"\}`/);
    assert.match(flat, /`502 \{"error":"jellyfin_unavailable"\}` and is not sent to Jellyfin/);
    assert.match(flat, /show only the household's own members/);
    assert.match(flat, /SyncPlay's WebSocket messages are not filtered/);
    assert.match(flat, /remembered for up to a minute/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.3\.0`/);
    assert.match(flat, /rolling back reopens both gaps/);
    assert.match(flat, /no longer show one household another's members/);
    assert.match(flat, /now works only with its own members' tokens/);
    assert.equal(flat.match(/Allowed in a patch release by the household-check rule at the top of this file/g)?.length, 1);
    assert.equal(flat.match(/Allowed in a patch release by the same household-check rule/g)?.length, 4);
    const security = notes.indexOf('### Security');
    for (const note of [
      '**No CDN purge is needed:**',
      '**Clients may notice these changes, on household hostnames only:**',
      '**Two gaps remain, by design:**',
      '**To roll back,**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < security, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### (?:Added|Changed|Fixed)/);
    assert.doesNotMatch(notes, /Mobile app/, 'mobile/ is unchanged since 3.3.0');
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.3.0 without its heading, up to the 3.2.4 section', () => {
    const notes = changelogSection(CHANGELOG, '3.3.0');
    assertSection(notes, {
      version: '3.3.0',
      nextVersion: '3.2.4',
      subheadings: ['Added'],
    });
    assert.match(notes, /^This is a minor release\. It adds the TV add-on/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*It is off by default: unless `TV_ADDON_ENABLED` is set, nothing changes\*\*/);
    assert.match(flat, /3\.2\.4 reads a state file written by 3\.3\.0/);
    assert.match(flat, /\*\*It needs the household app:\*\* `HOUSEHOLD_APP_ENABLED=true`/);
    assert.match(flat, /tested only against Jellyfin web 10\.11 and in simulated browsers/);
    assert.match(flat, /in a desktop browser on that household's address .* then on an LG TV/);
    assert.match(flat, /purge Cloudflare's cache once/);
    assert.match(flat, /\*\*Samsung TVs show nothing yet:\*\*/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.2\.4`/);
    assert.match(flat, /3\.2\.4 ignores `TV_ADDON_ENABLED` and `TV_ADDON_HOUSEHOLDS`/);
    assert.match(flat, /\*\*TV add-on, step 1 \(off by default\)\.\*\*/);
    assert.match(flat, /\*\*TV add-on, step 2: title pages and "Get this"/);
    const added = notes.indexOf('### Added');
    for (const note of [
      '**To switch it on for some households,**',
      '**It needs the household app:**',
      '**It has been tested only against Jellyfin web 10.11',
      '**You may need to purge Cloudflare\'s cache once**',
      '**Samsung TVs show nothing yet:**',
      '**To roll back,**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < added, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### Security/);
    assert.doesNotMatch(notes, /Mobile app/, 'mobile/ is unchanged since 3.2.4');
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b|\bjelly(?:-[a-z0-9-]+)?\.(?!example\.)[a-z0-9-]+\.[a-z]/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.2.4 without its heading, up to the 3.2.3 section', () => {
    const notes = changelogSection(CHANGELOG, '3.2.4');
    assertSection(notes, {
      version: '3.2.4',
      nextVersion: '3.2.3',
      subheadings: ['Security'],
    });
    assert.match(notes, /^This is a security patch release for household hostnames/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /Jellyfin Enhanced 12\.13 and 12\.14, whose routes are the same/);
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /3\.2\.3 reads a state file written by 3\.2\.4/);
    assert.match(flat, /\*\*No CDN purge is needed:\*\*/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.2\.3`/);
    assert.match(flat, /rolling back relays the routes below to Jellyfin again/);
    assert.match(flat, /turn off its Jellyseerr integration/);
    assert.match(flat, /`ActiveStreamsAllUsers`\) off/);
    assert.match(flat, /`ActivityFeedOwnOnlyForNonAdmins`\) on/);
    assert.match(flat, /no longer relay the Jellyfin Enhanced plugin's Seerr routes/);
    assert.match(flat, /no longer relay the Jellyfin Enhanced plugin's reviews or its lookup of library items by provider ID/);
    assert.equal(flat.match(/Allowed in a patch release by the household-check rule at the top of this file/g)?.length, 2);
    const security = notes.indexOf('### Security');
    for (const note of ['**No CDN purge is needed:**', '**To roll back,**', '**If you use Jellyfin Enhanced,**']) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < security, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /Mobile app/, 'mobile/ is unchanged since 3.2.3');
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.2.3 without its heading, up to the 3.2.2 section', () => {
    const notes = changelogSection(CHANGELOG, '3.2.3');
    assertSection(notes, {
      version: '3.2.3',
      nextVersion: '3.2.2',
      subheadings: ['Changed', 'Fixed'],
    });
    assert.match(notes, /^This is a patch release for the household app/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /3\.2\.2 reads a state file written by 3\.2\.3/);
    assert.match(flat, /webhook payloads, the administrator API and the admin UI are unchanged/);
    assert.match(flat, /\*\*No CDN purge is needed:\*\*/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.2\.2`/);
    assert.match(flat, /No state-file or setting change is needed/);
    assert.match(flat, /It is documentation: the API is unchanged/);
    assert.match(flat, /\*\*Mobile app \(not in the server image\)\.\*\*/);
    assert.match(flat, /first release, 1\.0\.0, since 3\.2\.2/);
    assert.match(flat, /\[changelog\]\(mobile\/CHANGELOG\.md\)/);
    assert.match(flat, /one status pill per request on My requests/);
    assert.match(flat, /My requests reuses the titles it has already read/);
    assert.match(flat, /a "Get this" request is no longer dropped/);
    const changed = notes.indexOf('### Changed');
    assert.ok(changed < notes.indexOf('### Fixed'), 'the My requests changes come first');
    for (const note of ['**Close and reopen the installed app**', '**No CDN purge is needed:**', '**To roll back,**']) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < changed, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /eas-cli|workflow|\btests?\b/i, 'no tests or CI');
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.2.2 without its heading, up to the 3.2.1 section', () => {
    const notes = changelogSection(CHANGELOG, '3.2.2');
    assertSection(notes, {
      version: '3.2.2',
      nextVersion: '3.2.1',
      subheadings: ['Changed', 'Fixed'],
    });
    assert.match(notes, /^This is a patch release for the household app/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /3\.2\.1 reads a state file written by 3\.2\.2/);
    assert.match(flat, /the administrator API and the admin UI are unchanged/);
    assert.match(flat, /\*\*No CDN purge is needed:\*\*/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.2\.1`/);
    assert.match(flat, /No state-file or setting change is needed/);
    assert.match(flat, /documents what the app already did; neither the app's calls nor the server changed/);
    assert.match(flat, /mobile app's source \(`mobile\/`\) also changed since 3\.2\.1\. It is not part of this release/);
    assert.match(flat, /card rows settle with a card centred/);
    assert.match(flat, /a card reached with Tab is no longer clipped by its row/);
    const changed = notes.indexOf('### Changed');
    assert.ok(changed < notes.indexOf('### Fixed'), 'the row snapping comes first');
    for (const note of ['**Close and reopen the installed app**', '**No CDN purge is needed:**', '**To roll back,**']) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < changed, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.2.1 without its heading, up to the 3.2.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.2.1');
    assertSection(notes, {
      version: '3.2.1',
      nextVersion: '3.2.0',
      subheadings: ['Fixed'],
    });
    assert.match(notes, /^This is a patch release for the household app/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /3\.2\.0 reads a state file written by 3\.2\.1/);
    assert.match(flat, /the administrator API and the admin UI are unchanged/);
    assert.match(flat, /\*\*No CDN purge is needed:\*\*/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.2\.0`/);
    assert.match(flat, /No state-file or setting change is needed/);
    assert.match(flat, /mobile app's source \(`mobile\/`\) also changed since 3\.2\.0\. It is not part of this release/);
    assert.match(flat, /shows \*\*Requested\*\* right after \*\*Get this\*\* is accepted/);
    assert.match(flat, /the server is unchanged/);
    const fixed = notes.indexOf('### Fixed');
    for (const note of ['**Close and reopen the installed app**', '**No CDN purge is needed:**', '**To roll back,**']) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < fixed, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.2.0 without its heading, up to the 3.1.1 section', () => {
    const notes = changelogSection(CHANGELOG, '3.2.0');
    assertSection(notes, {
      version: '3.2.0',
      nextVersion: '3.1.1',
      subheadings: ['Security', 'Added'],
    });
    assert.match(notes, /^This is a security release for household hostnames, and a minor release\./);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /\*\*Upgrading is strongly recommended\*\*/);
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /3\.1\.1 reads a state file written by 3\.2\.0/);
    assert.match(flat, /\*\*What 3\.1\.1 and earlier exposed on household hostnames\.\*\*/);
    assert.match(flat, /None of them needs a setting or a change to Jellyfin/);
    assert.match(flat, /mobile app \(`mobile\/`\)\. It is not part of this release/);
    assert.match(flat, /\*\*Why this is a minor release\.\*\*/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.1\.1`/);
    assert.match(flat, /rolling back re-opens every issue listed above/);
    assert.match(flat, /`POST \/LiveTv\/Programs`/);
    assert.match(flat, /A short identity cache/);
    const security = notes.indexOf('### Security');
    const order = [
      '**What 3.1.1 and earlier exposed on household hostnames.**',
      '**Why this is a minor release.**',
      '**Fonts embedded in subtitles no longer load on household hostnames.**',
      '**Quick Connect stops working on household hostnames.**',
      '**Playlist sharing is not refused.**',
      '**Oddly encoded paths get `400`.**',
      '**Some household requests take one more round trip to Jellyfin.**',
      '**To roll back,**',
      'Known follow-ups, for a later release:',
    ];
    for (const [index, note] of order.entries()) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < security, `${note} comes before Security`);
      if (index) assert.ok(notes.indexOf(order[index - 1]) < notes.indexOf(note), `${note} comes after ${order[index - 1]}`);
    }
    assert.ok(security < notes.indexOf('### Added'));
    assert.ok((notes.match(/household-check rule/g) ?? []).length >= 10, 'each refusal cites the rule');
    assert.match(flat, /`GET`\/`POST`\/`DELETE \/Playlists\/\{id\}\/Users\/\{userId\}`\) is relayed to Jellyfin unchanged/);
    assert.doesNotMatch(flat, /can no longer be shared/);
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.1.1 without its heading, up to the 3.1.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.1.1');
    assertSection(notes, {
      version: '3.1.1',
      nextVersion: '3.1.0',
      subheadings: ['Fixed'],
    });
    assert.match(notes, /^This is a patch release for the admin UI only/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /3\.1\.0 reads a state file written by 3\.1\.1/);
    assert.match(flat, /no file of the household app and none of the household gateway or app API code changed/);
    assert.match(flat, /restarting JellyPass to upgrade signs every administrator out/);
    assert.match(flat, /Your session has ended\. Sign in again\./);
    assert.match(flat, /That username or password was not accepted\./);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.1\.0`/);
    assert.match(flat, /No state-file or setting change is needed/);
    const fixed = notes.indexOf('### Fixed');
    for (const note of ['**Administrators sign in again', '**To roll back,**']) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < fixed, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.1.0 without its heading, up to the 3.0.1 section', () => {
    const notes = changelogSection(CHANGELOG, '3.1.0');
    assertSection(notes, {
      version: '3.1.0',
      nextVersion: '3.0.1',
      subheadings: ['Changed'],
    });
    assert.match(notes, /^This is a minor release for the household app/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /3\.0\.1 reads a state file written by 3\.1\.0/);
    assert.match(flat, /the administrator API and the admin UI are unchanged/);
    assert.match(flat, /`#000b25`/);
    assert.match(flat, /`#00a4dc`/);
    assert.match(flat, /`GET \/discover\/top-movies` and `GET \/discover\/top-tv`, are kept/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.0\.1`/);
    assert.match(flat, /No state-file or setting change is needed/);
    assert.match(flat, /not yet on a physical phone/);
    const changed = notes.indexOf('### Changed');
    for (const note of [
      '**The household app looks different.**',
      '**The All-time great rows are no longer on Home,**',
      '**On iPhone, close and reopen the installed app**',
      '**No CDN purge is needed:**',
      '**To roll back,**',
    ]) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < changed, `upgrade note ${note} comes first`);
    }
    assert.ok(notes.indexOf('the Tidepool look, part 2') < notes.indexOf('the Tidepool look, part 1'));
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.0.1 without its heading, up to the 3.0.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.0.1');
    assertSection(notes, {
      version: '3.0.1',
      nextVersion: '3.0.0',
      subheadings: ['Fixed'],
    });
    assert.match(notes, /^This is a patch release for the admin UI and the administrator API/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /3\.0\.0 reads a state file written by 3\.0\.1/);
    assert.match(flat, /no file of the household app and none of the household gateway or app API code changed/);
    assert.match(flat, /restarting JellyPass to upgrade signs every administrator out/);
    assert.match(flat, /Jellyfin is temporarily unavailable — retrying…/);
    assert.match(flat, /`503 \{"error":"session_check_unavailable"\}`/);
    assert.match(flat, /`415 \{"error":"unsupported_media_type"\}`/);
    assert.match(flat, /`404 \{"error":"not_found"\}`/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:3\.0\.0`/);
    assert.match(flat, /No state-file or setting change is needed/);
    const fixed = notes.indexOf('### Fixed');
    for (const note of ['**Administrators sign in again', '**Scripts that send a non-JSON body', '**To roll back,**']) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < fixed, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 3.0.0 without its heading, up to the 2.7.0 section', () => {
    const notes = changelogSection(CHANGELOG, '3.0.0');
    assertSection(notes, {
      version: '3.0.0',
      nextVersion: '2.7.0',
      subheadings: ['Security'],
    });
    assert.match(notes, /^This is a major release for the administrator API and the admin UI/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /the versioning policy's one exception \(at the top of CHANGELOG\.md\) covers only failure responses on endpoints relayed to Jellyfin/);
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /2\.7\.0 reads a state file written by 3\.0\.0/);
    assert.match(flat, /Every administrator must sign in again after upgrading/);
    assert.match(flat, /`__Host-jellypass_session`/);
    assert.match(flat, /should use `ADMIN_TOKEN`/);
    assert.match(flat, /`403 \{"error":"cross_origin_request_refused"\}`/);
    assert.match(flat, /`415 \{"error":"unsupported_media_type"\}`/);
    assert.match(flat, /`proxy_set_header X-Forwarded-Host \$host;`/);
    assert.match(flat, /The admin URL is not gated by default/);
    assert.match(flat, /Cloudflare Access/);
    assert.match(flat, /missing fields included \(2\.7\.0 answered `400`\)/);
    assert.match(flat, /`429 \{"error":"too_many_login_attempts"\}`/);
    assert.match(flat, /`503 \{"error":"session_check_unavailable"\}`/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:2\.7\.0`/);
    assert.match(flat, /No state-file or setting change is needed/);
    const security = notes.indexOf('### Security');
    for (const note of ['**Every administrator must sign in again', '**A reverse proxy must pass `Host` unchanged.**', '**To roll back,**']) {
      assert.ok(notes.indexOf(note) >= 0 && notes.indexOf(note) < security, `upgrade note ${note} comes first`);
    }
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.doesNotMatch(notes, /\b(?:\d{1,3}\.){3}\d{1,3}\b|LXC|\.local\b/, 'no server-specific details');
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.7.0 without its heading, up to the 2.6.0 section', () => {
    const notes = changelogSection(CHANGELOG, '2.7.0');
    assertSection(notes, {
      version: '2.7.0',
      nextVersion: '2.6.0',
      subheadings: ['Added', 'Changed'],
    });
    assert.match(notes, /^This is a minor release for the household app/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /2\.6\.0 reads a state file written by 2\.7\.0/);
    assert.match(flat, /\*\*Movies\*\* makes four and \*\*TV\*\* three/);
    assert.match(flat, /Where-to-watch data is for the US only/);
    assert.match(flat, /JustWatch is credited/);
    assert.match(flat, /`\/discover\/network\/213\/2`/);
    assert.match(flat, /is still `404 not_found`, before TMDB is asked/);
    assert.doesNotMatch(flat, /instead of `404 not_found`/);
    assert.match(flat, /`w780` and `w1280` \(a `srcset`\), both already used in 2\.6\.0/);
    assert.match(flat, /No CDN purge is needed/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:2\.6\.0`/);
    assert.match(flat, /`GET \/jellypass\/app\/v1\/discover\/network\/:id\/films\?page=`/);
    assert.match(flat, /`hasFilms: true`/);
    assert.ok(notes.indexOf('**More TMDB calls as members scroll and switch filters.**') < notes.indexOf('### Added'), 'upgrade notes come first');
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.6.0 without its heading, up to the 2.5.0 section', () => {
    const notes = changelogSection(CHANGELOG, '2.6.0');
    assertSection(notes, {
      version: '2.6.0',
      nextVersion: '2.5.0',
      subheadings: ['Added', 'Fixed'],
    });
    assert.match(notes, /^This is a minor release for the household app/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /There is nothing to configure/);
    assert.match(flat, /2\.5\.0 reads a state file written by 2\.6\.0/);
    assert.match(flat, /same four TMDB calls before anything is drawn/);
    assert.match(flat, /`https:\/\/image\.tmdb\.org\/t\/p\/w300`/);
    assert.match(flat, /No CDN purge is needed/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:2\.5\.0`/);
    assert.match(flat, /`GET \/jellypass\/app\/v1\/discover\/sources`/);
    assert.match(flat, /`with_networks=3186\|49`|`3186\|49`/);
    assert.ok(notes.indexOf('**More TMDB calls, but only as members scroll.**') < notes.indexOf('### Added'), 'upgrade notes come first');
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.5.0 without its heading, up to the 2.4.1 section', () => {
    const notes = changelogSection(CHANGELOG, '2.5.0');
    assertSection(notes, {
      version: '2.5.0',
      nextVersion: '2.4.1',
      subheadings: ['Fixed', 'Changed'],
    });
    assert.match(notes, /^This is a minor release for the household app/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /keeps those outside the public interface/);
    assert.match(flat, /`413` \(`request_too_large`\)/);
    assert.match(flat, /`503` \(`too_many_sign_outs`\) with `Retry-After: 1`/);
    assert.match(flat, /add it again from Safari to see the new one/);
    assert.match(flat, /No CDN purge is needed/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:2\.4\.1`/);
    assert.match(flat, /not yet on a physical phone/);
    assert.ok(notes.indexOf('**The app looks and navigates differently.**') < notes.indexOf('### Fixed'), 'upgrade notes come first');
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.4.1 without its heading, up to the 2.4.0 section', () => {
    const notes = changelogSection(CHANGELOG, '2.4.1');
    assertSection(notes, {
      version: '2.4.1',
      nextVersion: '2.4.0',
      subheadings: ['Fixed', 'Changed'],
    });
    assert.match(notes, /^This is a patch release/);
    const flat = notes.replace(/\s+/g, ' ');
    assert.match(flat, /There is nothing to do when upgrading from 2\.4\.0/);
    assert.match(flat, /`ghcr\.io\/nicklongmore86\/jellypass:2\.4\.0`/);
    assert.match(flat, /not yet on a physical iPhone/);
    assert.doesNotMatch(notes, /### Upgrading from/);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.4.0 without its heading, up to the 2.3.0 section', () => {
    const notes = changelogSection(CHANGELOG, '2.4.0');
    assertSection(notes, {
      version: '2.4.0',
      nextVersion: '2.3.0',
      subheadings: ['Added', 'Fixed', 'Upgrading from 2\\.3\\.0', 'Rolling back to 2\\.3\\.0'],
    });
    assert.match(notes, /^This is a minor release\./);
    const flat = notes.replace(/\s+/g, ' ');
    // What upgraders must know comes before the first subheading.
    const intro = flat.slice(0, flat.indexOf('### Added'));
    for (const must of [
      /HOUSEHOLD_APP_ENABLED=true/,
      /Can't request/,
      /late-request risk remains/,
      /step 4/,
      /`400` \(`invalid_request`\)/,
      /no sooner than one second/,
      /\*\*wrong name or password\*\*/,
      /purge your CDN's cache for `\/jellypass\/app\/\*` once/,
      /schema v7/,
      /GET \/v1\/app\/outstanding/,
      /\*\*No new settings\.\*\*/,
    ]) assert.match(intro, must);
    assert.match(flat, /\*\*Back up the state file\*\* first/);
    assert.ok(flat.indexOf('Back up the state file') < flat.indexOf('**Upgrade:**'), 'the backup comes before the upgrade');
    assert.doesNotMatch(notes, /not yet released/);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.3.0 without its heading, up to the 2.2.1 section', () => {
    const notes = changelogSection(CHANGELOG, '2.3.0');
    assertSection(notes, {
      version: '2.3.0',
      nextVersion: '2.2.1',
      subheadings: ['Added', 'Upgrading from 2\\.2\\.1', 'Rolling back to 2\\.2\\.1'],
    });
    assert.match(notes, /^This is a minor release\./);
    // The household limit applies only with the app enabled, so it is not a change for every deployment.
    assert.doesNotMatch(notes, /^### Changed$/m);
    assert.doesNotMatch(notes, /every deployment/);
    assert.match(notes, /\*\*At most 100 households while the household app is enabled\.\*\*/);
    assert.doesNotMatch(notes, /^This is a patch release/m);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.2.1 without its heading, up to the 2.2.0 section', () => {
    const notes = changelogSection(CHANGELOG, '2.2.1');
    assertSection(notes, {
      version: '2.2.1',
      nextVersion: '2.2.0',
      subheadings: ['Fixed'],
    });
    assert.match(notes, /^This is a patch release/);
    assert.doesNotMatch(notes, /### Upgrading from 2\.1\.1/);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.2.0 without its heading, up to the 2.1.1 section', () => {
    const notes = changelogSection(CHANGELOG, '2.2.0');
    assertSection(notes, {
      version: '2.2.0',
      nextVersion: '2.1.1',
      subheadings: ['Added', 'Changed', 'Fixed', 'Upgrading from 2\\.1\\.1', 'Rolling back to 2\\.1\\.1'],
    });
    assert.match(notes, /^This is a minor release\./);
    assert.doesNotMatch(notes, /### Upgrading from 2\.0\.0/);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.1.1 without its heading, up to the 2.1.0 section', () => {
    const notes = changelogSection(CHANGELOG, '2.1.1');
    assertSection(notes, {
      version: '2.1.1',
      nextVersion: '2.1.0',
      subheadings: ['Changed', 'Fixed'],
    });
    assert.doesNotMatch(notes, /### Upgrading from 2\.0\.0/);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.1.0 without its heading, up to the 2.0.0 section', () => {
    const notes = changelogSection(CHANGELOG, '2.1.0');
    assertSection(notes, {
      version: '2.1.0',
      nextVersion: '2.0.0',
      subheadings: ['Added', 'Changed', 'Fixed', 'Upgrading from 2\\.0\\.0'],
    });
    assert.doesNotMatch(notes, /### Upgrading from 1\.1\.0/);
    assert.deepEqual(split(notes).definitions, []);
  });

  it('extracts 2.0.0 without its heading, up to the 1.1.0 section', () => {
    const notes = changelogSection(CHANGELOG, '2.0.0');
    assertSection(notes, {
      version: '2.0.0',
      nextVersion: '1.1.0',
      subheadings: ['Removed', 'Changed', 'Upgrading from 1\\.1\\.0'],
    });
    assert.doesNotMatch(notes, /### Upgrading from 1\.0\.0/);
  });

  it('extracts 1.1.0 with the [#N] definitions it references', () => {
    const notes = changelogSection(CHANGELOG, '1.1.0');
    assertSection(notes, {
      version: '1.1.0',
      nextVersion: '1.0.0',
      subheadings: ['Security', 'Fixed', 'Added', 'Upgrading from 1\\.0\\.0'],
    });
    assert.ok(split(notes).definitions.length > 0);
    assert.ok(split(notes).definitions.every((line) => /^\[#\d+\]: https:\/\/github\.com\//.test(line)));
  });

  it('extracts 1.0.0, the last section, without the trailing link definitions', () => {
    const notes = changelogSection(CHANGELOG, '1.0.0');
    assertSection(notes, { version: '1.0.0', subheadings: [] });
    assert.deepEqual(split(notes).definitions, []);
  });

  it('accepts a tag name with a leading v', () => {
    assert.equal(changelogSection(CHANGELOG, 'v1.1.0'), changelogSection(CHANGELOG, '1.1.0'));
  });

  it('fails for a version without a section', () => {
    assert.throws(() => changelogSection(CHANGELOG, '9.9.9'), /no "## \[9\.9\.9\]" section/);
    assert.throws(() => changelogSection(CHANGELOG, '2.0'), /no "## \[2\.0\]" section/);
  });
});

describe('changelogSection with fixtures', () => {
  const LINKS = '[1.2.0]: https://example.test/1.2.0\n[1.1.0]: https://example.test/1.1.0\n[#1]: https://example.test/1\n[#2]: https://example.test/2\n';

  it('fails for an empty section', () => {
    const changelog = `# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-01-02\n\n- Two.\n\n${LINKS}`;
    assert.throws(() => changelogSection(changelog, 'Unreleased'), /"## \[Unreleased\]" is empty/);
  });

  it('fails for a heading-only last section', () => {
    assert.throws(() => changelogSection('## [1.2.0] - 2026-01-02\n', '1.2.0'), /"## \[1\.2\.0\]" is empty/);
    assert.throws(() => changelogSection(`## [1.2.0] - 2026-01-02\n\n${LINKS}`, '1.2.0'), /is empty/);
  });

  it('extracts a section whatever the Unreleased section holds', () => {
    const changelog = `## [Unreleased]\n\n- Work in progress [#2].\n\n## [1.2.0] - 2026-01-02\n\n- Two.\n\n${LINKS}`;
    assert.equal(changelogSection(changelog, '1.2.0'), '- Two.\n');
    assert.equal(changelogSection(changelog, 'Unreleased'), '- Work in progress [#2].\n\n[#2]: https://example.test/2\n');
  });

  it('ignores headings and references inside fenced code blocks', () => {
    const changelog = [
      '## [1.2.0] - 2026-01-02',
      '',
      '```md',
      '## [1.1.0] - not a heading',
      'See [#1].',
      '```',
      '',
      '~~~~',
      '## [1.0.0]',
      '```',
      '~~~~',
      '',
      'After the fences [#2].',
      '',
      '## [1.1.0] - 2026-01-01',
      '',
      '- One.',
      '',
      LINKS,
    ].join('\n');
    const notes = changelogSection(changelog, '1.2.0');
    assert.ok(notes.startsWith('```md\n## [1.1.0] - not a heading\n'));
    assert.match(notes, /~~~~\n## \[1\.0\.0\]\n```\n~~~~\n\nAfter the fences \[#2\]\.\n\n\[#2\]: /);
    assert.doesNotMatch(notes, /- One\./);
    assert.deepEqual(split(notes).definitions, ['[#2]: https://example.test/2']);
    assert.throws(() => changelogSection('```\n## [3.0.0]\n```\n', '3.0.0'), /no "## \[3\.0\.0\]" section/);
  });

  it('appends definitions only for reference-style links, not inline links', () => {
    const changelog = `## [1.2.0] - 2026-01-02\n\n- Inline [#1](https://example.test/inline), reference [#2], see [1.1.0](#110).\n\n${LINKS}`;
    assert.deepEqual(split(changelogSection(changelog, '1.2.0')).definitions, ['[#2]: https://example.test/2']);
  });
});

describe('changelog-section command line', () => {
  const directory = mkdtempSync(join(tmpdir(), 'changelog-section-'));
  after(() => rmSync(directory, { recursive: true, force: true }));

  function run(version, { path = CHANGELOG_PATH, githubActions = '' } = {}) {
    return spawnSync(process.execPath, [SCRIPT_PATH, version, path], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: githubActions },
    });
  }

  it('prints the notes for a tag', () => {
    const result = run('v2.0.0');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, changelogSection(CHANGELOG, '2.0.0'));
  });

  it('reads the changelog path it is given', () => {
    const path = join(directory, 'CHANGELOG.md');
    writeFileSync(path, '## [1.2.0] - 2026-01-02\n\n- Two.\n');
    const result = run('v1.2.0', { path });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '- Two.\n');
  });

  it('exits 1 with a message for a missing version', () => {
    const result = run('v9.9.9');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'changelog-section: CHANGELOG.md has no "## [9.9.9]" section\n');
  });

  it('exits 1 with an error annotation on GitHub Actions', () => {
    const result = run('v9.9.9', { githubActions: 'true' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '::error title=Release notes::CHANGELOG.md has no "## [9.9.9]" section\n');
  });
});
