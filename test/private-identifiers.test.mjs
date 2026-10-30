import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadPrivateDenylist, privateMatchCount } from '../scripts/private-identifiers.mjs';

const root = new URL('../', import.meta.url);
const terms = loadPrivateDenylist();
test('tracked files contain no private deployment identifiers', {
  skip: terms ? false : 'NOTICE: no private deny-list configured; set JELLYPASS_PRIVATE_DENYLIST',
}, () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  let matches = 0;
  for (const file of files) {
    matches += privateMatchCount(readFileSync(new URL(file, root), 'utf8'), terms);
  }
  assert.equal(matches, 0, 'Private identifier matching-line count must be zero');
});

test('literal matching ignores case and counts each matching line once', () => {
  assert.equal(privateMatchCount('GROVE.example.org grove\nother\nHeath', ['grove', 'heath']), 2);
  assert.equal(privateMatchCount('groveXexampleYorg', ['grove.example.org']), 0);
});
