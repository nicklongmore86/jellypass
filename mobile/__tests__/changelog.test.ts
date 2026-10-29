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
  it('extracts 1.2.0 without its heading, up to the 1.1.0 section', () => {
    const notes = releaseNotes('1.2.0');
    expect(notes).toMatch(/^A minor release: Home can hide what the household already has/);
    expect(notes).not.toMatch(/^## /m);
    expect(notes).toMatch(/^### Added$/m);
    expect(notes).toMatch(/^### Fixed$/m);
    expect(notes).not.toMatch(/^### (?:Changed|Removed|Security)$/m);
    expect(notes).not.toContain(releaseNotes('1.1.0').split('\n')[0]);
    expect(notes).not.toMatch(/^\[[^\]]+\]: /m);
    const flat = notes.replace(/\s+/g, ' ');
    // The server it needs comes first, before the entries: Hide is client-side, so any supported server will do.
    const added = flat.indexOf('### Added');
    for (const note of [
      '**JellyPass server 3.2.0 or later**',
      '**Hide what I have needs no server change**',
      '**Cancel request and the day each title was requested need JellyPass server 3.5.0 or later**',
    ]) {
      expect(flat.indexOf(note)).toBeGreaterThanOrEqual(0);
      expect(flat.indexOf(note)).toBeLessThan(added);
    }
    expect(flat).toMatch(/\*\*Home: Hide what I have\.\*\* A chip after All \| Movies \| TV, on by default at every sign-in\./);
    expect(flat).toMatch(/never stored on the device, and starts on again after a sign-out, an expired sign-in or a change of household or member/);
    expect(flat).toMatch(/makes no call to the server/);
    expect(flat).toMatch(/network and studio pages have the same chip and share the choice/);
    expect(flat).toMatch(/\*\*Home's hero keeps the title you were on\*\*.*\(turning an iPad\)/);
    expect(flat).toMatch(/\*\*A late sign-out no longer touches a newer sign-in\.\*\*/);
    expect(flat).toMatch(/\*\*The stored sign-in is read, written and deleted one step at a time\*\*/);
    expect(notes).not.toMatch(/eas-cli|workflow|\btests?\b|maxWorkers/i);
  });

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

  it("passes the release job's tag check for mobile-v<version in package.json> (mobile-v1.2.0 when it was cut)", () => {
    const { version } = require('../package.json') as { version: string };
    // `node ../scripts/mobile-release-tag.mjs "$GITHUB_REF_NAME" package.json CHANGELOG.md`, from mobile/ (eas-json.test.ts).
    const check = (tag: string) =>
      spawnSync(process.execPath, ['../scripts/mobile-release-tag.mjs', tag, 'package.json', 'CHANGELOG.md'], {
        cwd: join(ROOT, 'mobile'),
        encoding: 'utf8',
        env: { ...process.env, GITHUB_ACTIONS: '' },
      });
    const accepted = check(`mobile-v${version}`);
    expect(accepted.stderr).toBe('');
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toBe(`${version}\n`);
    // An older release's tag is refused once the version has moved on.
    const old = check('mobile-v1.1.0');
    expect(old.status).toBe(1);
    expect(old.stderr).toContain(`package.json says ${version}`);
  });
});
