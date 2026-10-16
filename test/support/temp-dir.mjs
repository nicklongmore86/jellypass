import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const created = new Set();

// Registered when a test file imports this module, so it runs once every test and hook in that file has finished,
// failed ones included. It removes the directories made without a test context, and again any a late write recreated
// (GrantStore creates its directory before each write).
after(() => Promise.all([...created].map(remove)));

/**
 * Creates a directory under the OS temp directory that is removed when the test `t` finishes, pass or fail. Pass `null`
 * outside a test (in a `before` hook or a shared helper) to remove it when the test file finishes instead. Close
 * anything still using the directory (servers, child processes, stores) within the test, before it is removed.
 */
export async function makeTempDir(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  created.add(directory);
  t?.after(() => remove(directory));
  return directory;
}

function remove(directory) {
  return rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
