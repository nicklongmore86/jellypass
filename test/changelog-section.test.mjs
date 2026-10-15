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
