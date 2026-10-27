// scripts/mobile-release-tag.mjs on made-up files only: the root tests never read mobile/ (mobile/README.md). The
// app's own package.json and CHANGELOG.md are checked by mobile/__tests__/app-config.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMobileReleaseTag } from '../scripts/mobile-release-tag.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/mobile-release-tag.mjs', import.meta.url));

const PACKAGE = JSON.stringify({ name: 'jellypass-mobile', version: '1.2.3' });
const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.2.3] - 2026-11-01',
  '',
  '### Fixed',
  '',
  '- A fix.',
  '',
  '## [1.2.2] - 2026-10-30',
  '',
  '- Older.',
  '',
].join('\n');

function check(tag, { packageJson = PACKAGE, changelog = CHANGELOG } = {}) {
  return checkMobileReleaseTag({ tag, packageJson, changelog });
}

describe('checkMobileReleaseTag', () => {
  it('accepts a tag that matches package.json and has changelog notes', () => {
    assert.equal(check('mobile-v1.2.3'), '1.2.3');
    assert.equal(check('mobile-v2.0.0-beta.1', {
      packageJson: JSON.stringify({ version: '2.0.0-beta.1' }),
      changelog: '## [2.0.0-beta.1] - 2026-12-01\n\n- Beta.\n',
    }), '2.0.0-beta.1');
  });

  it('refuses a tag that does not match package.json', () => {
    assert.throws(() => check('mobile-v1.2.2'), /tag "mobile-v1\.2\.2" is version 1\.2\.2, but mobile\/package\.json says 1\.2\.3/);
    assert.throws(() => check('mobile-v1.2.4'), /mobile\/package\.json says 1\.2\.3/);
  });

  it('refuses a tag whose version has no changelog section, or an empty one', () => {
    const packageJson = JSON.stringify({ version: '1.3.0' });
    assert.throws(() => check('mobile-v1.3.0', { packageJson }), /mobile\/CHANGELOG\.md: has no "## \[1\.3\.0\]" section\. Add the/);
    const empty = '## [Unreleased]\n\n## [1.2.3] - 2026-11-01\n\n## [1.2.2] - 2026-10-30\n\n- Older.\n';
    assert.throws(() => check('mobile-v1.2.3', { changelog: empty }), /mobile\/CHANGELOG\.md: section "## \[1\.2\.3\]" is empty/);
  });

  it('refuses anything that is not mobile-v<version>', () => {
    for (const tag of ['v1.2.3', '1.2.3', 'mobile-1.2.3', 'mobile-v', 'mobile-v1.2', 'mobile-v01.2.3', 'mobile-v1.2.3+7', 'mobile-vlatest']) {
      assert.throws(() => check(tag), /mobile release tag|is not a version/, tag);
    }
  });

  it('refuses a package.json without a version', () => {
    assert.throws(() => check('mobile-v1.2.3', { packageJson: '{}' }), /mobile\/package\.json has no "version"/);
    assert.throws(() => check('mobile-v1.2.3', { packageJson: '{' }), /mobile\/package\.json is not valid JSON/);
  });
});

describe('scripts/mobile-release-tag.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jellypass-mobile-tag-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const packagePath = join(dir, 'package.json');
  const changelogPath = join(dir, 'CHANGELOG.md');
  writeFileSync(packagePath, PACKAGE);
  writeFileSync(changelogPath, CHANGELOG);

  function run(tag, env = {}) {
    return spawnSync(process.execPath, [SCRIPT_PATH, tag, packagePath, changelogPath], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', ...env },
    });
  }

  it('prints the version and exits 0 when the tag matches', () => {
    const result = run('mobile-v1.2.3');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '1.2.3\n');
  });

  it('exits 1 with the reason, as a workflow error on GitHub Actions', () => {
    const local = run('mobile-v1.2.2');
    assert.equal(local.status, 1);
    assert.equal(local.stdout, '');
    assert.match(local.stderr, /^mobile-release-tag: tag "mobile-v1\.2\.2" is version 1\.2\.2, but .*package\.json says 1\.2\.3/);
    const actions = run('mobile-v1.2.2', { GITHUB_ACTIONS: 'true' });
    assert.equal(actions.status, 1);
    assert.match(actions.stderr, /^::error title=Mobile release tag::tag "mobile-v1\.2\.2"/);
  });

  it('exits 1 when the files are missing', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, 'mobile-v1.2.3', join(dir, 'missing.json'), changelogPath], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
  });
});
