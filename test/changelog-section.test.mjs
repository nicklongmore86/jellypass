import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changelogSection } from '../scripts/changelog-section.mjs';

const CHANGELOG_PATH = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/changelog-section.mjs', import.meta.url));
const CHANGELOG = readFileSync(CHANGELOG_PATH, 'utf8');
const REPO = 'https://github.com/nicklongmore86/jellypass';

function definitions(notes) {
  return notes.split('\n').filter((line) => /^\[[^\]]+\]: /.test(line));
}

describe('changelogSection with the real CHANGELOG.md', () => {
  it('extracts 2.0.0 up to the 1.1.0 heading', () => {
    const notes = changelogSection(CHANGELOG, '2.0.0');
    assert.match(notes, /^## \[2\.0\.0\] - 2026-10-15\n\nThis release has three breaking changes\./);
    assert.match(notes, /\n### Upgrading from 1\.1\.0\n/);
    assert.match(notes, /JellyPass cannot tell a 4K request from an HD one\.\n\n\[2\.0\.0\]: /);
    assert.doesNotMatch(notes, /## \[1\.1\.0\]|## \[Unreleased\]/);
    assert.deepEqual(definitions(notes), [`[2.0.0]: ${REPO}/compare/v1.1.0...v2.0.0`]);
    assert.ok(notes.endsWith('v2.0.0\n'));
  });

  it('extracts 1.1.0 with the link definitions it uses', () => {
    const notes = changelogSection(CHANGELOG, '1.1.0');
    assert.match(notes, /^## \[1\.1\.0\] - 2026-10-15\n/);
    assert.match(notes, /\n### Upgrading from 1\.0\.0\n/);
    assert.match(notes, /revoked, as before\.\n\n\[1\.1\.0\]: /);
    assert.doesNotMatch(notes, /## \[1\.0\.0\]|First versioned release/);
    assert.deepEqual(definitions(notes), [
      `[1.1.0]: ${REPO}/compare/v1.0.0...v1.1.0`,
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((number) => `[#${number}]: ${REPO}/pull/${number}`),
    ]);
  });

  it('extracts 1.0.0, the last section, without the trailing link definitions', () => {
    assert.equal(
      changelogSection(CHANGELOG, '1.0.0'),
      `## [1.0.0] - 2026-09-10\n\nFirst versioned release.\n\n[1.0.0]: ${REPO}/releases/tag/v1.0.0\n`,
    );
  });

  it('accepts a tag name with a leading v', () => {
    assert.equal(changelogSection(CHANGELOG, 'v1.1.0'), changelogSection(CHANGELOG, '1.1.0'));
  });

  it('fails for a version without a section', () => {
    assert.throws(() => changelogSection(CHANGELOG, '9.9.9'), /no "## \[9\.9\.9\]" section/);
    assert.throws(() => changelogSection(CHANGELOG, '2.0'), /no "## \[2\.0\]" section/);
  });

  it('fails for an empty section', () => {
    assert.throws(() => changelogSection(CHANGELOG, 'Unreleased'), /"## \[Unreleased\]" is empty/);
  });
});

describe('changelog-section command line', () => {
  function run(...args) {
    return spawnSync(process.execPath, [SCRIPT_PATH, ...args, CHANGELOG_PATH], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '' },
    });
  }

  it('prints the section for a tag', () => {
    const result = run('v2.0.0');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, changelogSection(CHANGELOG, '2.0.0'));
  });

  it('exits 1 with a message for a missing version', () => {
    const result = run('v9.9.9');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /CHANGELOG\.md has no "## \[9\.9\.9\]" section/);
  });
});
