import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadPrivateDenylist, privateMatchCount, privateMatchLocations } from '../scripts/private-identifiers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const terms = loadPrivateDenylist();
test('tracked files contain no private deployment identifiers', {
  skip: terms ? false : 'NOTICE: no private deny-list configured; set JELLYPASS_PRIVATE_DENYLIST',
}, () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const locations = privateMatchLocations(root, files, terms);
  assert.equal(locations.length, 0, `Private identifiers found at:\n${locations.join('\n')}`);
});

test('literal matching ignores case and counts each matching line once', () => {
  assert.equal(privateMatchCount('GROVE.example.org grove\nother\nHeath', ['grove', 'heath']), 2);
  assert.equal(privateMatchCount('groveXexampleYorg', ['grove.example.org']), 0);
});

test('scanner reports locations, skips binary content and tolerates missing files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-identifier-guard-'));
  try {
    writeFileSync(join(directory, 'fixture.txt'), 'safe\r\nGROVE grove\r\nheath');
    writeFileSync(join(directory, 'binary.dat'), Buffer.from('grove\0'));
    writeFileSync(join(directory, 'invalid-utf8.dat'), Buffer.from([0xff, 0x67, 0x72, 0x6f, 0x76, 0x65]));
    assert.deepEqual(privateMatchLocations(directory,
      ['fixture.txt', 'binary.dat', 'invalid-utf8.dat', 'missing.txt'], ['grove', 'heath']),
    ['fixture.txt:2', 'fixture.txt:3']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
