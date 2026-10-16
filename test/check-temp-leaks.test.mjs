import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './support/temp-dir.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/check-temp-leaks.mjs', import.meta.url));

describe('check-temp-leaks', () => {
  /** Runs the wrapper around a Node `script`, inside a temp directory of the test's own so its cleanup can be checked. */
  async function run(t, script) {
    const outer = await makeTempDir(t, 'jellypass-leak-check-test-');
    const result = spawnSync(process.execPath, [SCRIPT_PATH, process.execPath, '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: outer, TEMP: outer, TMP: outer },
    });
    return { ...result, outerEntries: readdirSync(outer) };
  }

  const LEAK = "require('node:fs').mkdirSync(require('node:path').join(require('node:os').tmpdir(), 'intentional-leak'));";

  it('exits 0 when the command succeeds and leaves nothing behind', async (t) => {
    const result = await run(t, '');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'check-temp-leaks: no temporary files left behind\n');
    assert.deepEqual(result.outerEntries, []);
  });

  it('exits 1 and lists what a successful command left behind', async (t) => {
    const result = await run(t, LEAK);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'check-temp-leaks: 1 temporary entries left behind:\n  intentional-leak\n');
    assert.deepEqual(result.outerEntries, []);
  });

  it('lists what a failing command left behind and exits with its status', async (t) => {
    const result = await run(t, `${LEAK} process.exit(7);`);
    assert.equal(result.status, 7);
    assert.equal(result.stderr, 'check-temp-leaks: 1 temporary entries left behind:\n  intentional-leak\n');
    assert.deepEqual(result.outerEntries, []);
  });

  it('points TMPDIR, TEMP and TMP at the same private directory', async (t) => {
    const result = await run(t, "console.log(JSON.stringify([process.env.TMPDIR, process.env.TEMP, process.env.TMP, require('node:os').tmpdir()]));");
    assert.equal(result.status, 0, result.stderr);
    const [tmpdir, temp, tmp, nodeTmpdir] = JSON.parse(result.stdout.split('\n')[0]);
    assert.match(path.basename(tmpdir), /^jellypass-temp-check-/);
    assert.deepEqual([temp, tmp, nodeTmpdir], [tmpdir, tmpdir, tmpdir]);
    assert.deepEqual(result.outerEntries, []);
  });
});
