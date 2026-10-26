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

describe('rollback notes for household app "Get this"', () => {
  const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  const DESIGN = readFileSync(fileURLToPath(new URL('../docs/app-design.md', import.meta.url)), 'utf8');
  const released = changelogSection(CHANGELOG, '2.4.0');
  const drain = DESIGN.slice(DESIGN.indexOf('**Drain before rolling back.**'), DESIGN.indexOf('A state file written by an unreleased build'));
  const readme = README.slice(README.indexOf('Drain before rolling back'), README.indexOf('Rolling back from\n2.2.0'));

  it('send the operator to the admin readout and roll back only once it is clear', () => {
    for (const [name, text] of [['CHANGELOG 2.4.0', released], ['README', readme], ['design doc', drain]]) {
      const flat = text.replace(/\s+/g, ' ');
      assert.match(flat, /GET \/v1\/app\/outstanding/, name);
      assert.match(flat, /"clear": true/, name);
      assert.match(flat, /2\.3\.x or 2\.2\.1/, name);
    }
  });

  it('never say a safety marker lasts only 30 days: one naming an unhandled request lasts up to 400', () => {
    for (const [name, text] of [['CHANGELOG 2.4.0', released], ['README', readme], ['design doc', drain]]) {
      assert.match(text.replace(/\s+/g, ' '), /up to 400 days/, name);
      assert.doesNotMatch(text.replace(/\s+/g, ' '), /\(they last 30 days\)/, name);
    }
  });
});
