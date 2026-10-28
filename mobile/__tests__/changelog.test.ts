// The GitHub release notes a mobile-v<version> tag publishes: the release job's own command
// (`node scripts/changelog-section.mjs "$version" mobile/CHANGELOG.md`, eas-json.test.ts) run on the real changelog.
// The root tests never read mobile/ (README), so the app's notes are checked here.
import { spawnSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '../..');

function releaseNotes(version: string): string {
  const result = spawnSync(process.execPath, ['scripts/changelog-section.mjs', version, 'mobile/CHANGELOG.md'], { cwd: ROOT, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('mobile release notes', () => {
  it('extracts 1.1.0 without its heading, up to the 1.0.0 section', () => {
    const notes = releaseNotes('1.1.0');
    expect(notes).toMatch(/^A minor release: My requests can be filtered, and a member can cancel a request/);
    expect(notes).not.toMatch(/^## /m);
    expect(notes).toMatch(/^### Added$/m);
    expect(notes).toMatch(/^### Changed$/m);
    expect(notes).not.toMatch(/^### (?:Removed|Fixed|Security)$/m);
    expect(notes).not.toContain(releaseNotes('1.0.0').split('\n')[0]);
    expect(notes).not.toMatch(/^\[[^\]]+\]: /m);
    const flat = notes.replace(/\s+/g, ' ');
    // The server it needs comes first, before the entries.
    const added = flat.indexOf('### Added');
    for (const note of ['**JellyPass server 3.2.0 or later**', '**Cancel request and the day each title was requested need JellyPass server 3.5.0 or later**']) {
      expect(flat.indexOf(note)).toBeGreaterThanOrEqual(0);
      expect(flat.indexOf(note)).toBeLessThan(added);
    }
    expect(flat).toMatch(/on an older server the app shows neither, with no error/);
    expect(flat).toMatch(/\*\*My requests: Cancel request\.\*\*/);
    expect(flat).toMatch(/\*\*My requests can be filtered\.\*\*/);
    expect(flat).toMatch(/\*\*Each entry on My requests shows the day it was requested\*\*/);
    // The Cancel button ships in this release.
    expect(flat).not.toMatch(/later release/);
    expect(notes).not.toMatch(/eas-cli|workflow|\btests?\b/i);
  });
});
