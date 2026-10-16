#!/usr/bin/env node
// Runs a command with TMPDIR pointing at a fresh, private directory, then fails
// if the command left anything in it: a test that leaks a temporary directory.
//
//   node scripts/check-temp-leaks.mjs <command> [args...]
//
// A private directory, rather than counting entries in the shared temp
// directory, keeps the check exact while test files run in parallel and other
// processes use the shared one. The directory is removed afterwards either way.
// Exits with the command's status if it failed, else 1 on a leak, else 0.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: check-temp-leaks.mjs <command> [args...]');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'jellypass-temp-check-'));
let status;
let leaked;
try {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, TMPDIR: root } });
  if (result.error) throw result.error;
  status = result.status ?? 1;
  leaked = readdirSync(root);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (status !== 0) process.exit(status);
if (leaked.length > 0) {
  console.error(`check-temp-leaks: ${leaked.length} temporary entries left behind:\n${leaked.map((name) => `  ${name}`).join('\n')}`);
  process.exit(1);
}
console.log('check-temp-leaks: no temporary files left behind');
