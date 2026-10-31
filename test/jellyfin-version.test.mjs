// JellyPass supports the current and the previous Jellyfin release. On any other version, 3.x warns (the log, the admin
// site, the admin API and metrics) and household hosts keep serving until an administrator confirms that exact version;
// when enforcing (4.0.0), they answer a fixed 503 instead. Supported versions are served as before. The admin site keeps
// working throughout, so the administrator can see the version and confirm it.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService } from '../dist/access-service.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import {
  JELLYFIN_VERSION_ENFORCEMENT,
  JellyfinVersionGate,
  SUPPORTED_JELLYFIN_RELEASES,
  UNKNOWN_VERSION_MESSAGE,
  UNTESTED_VERSION_MESSAGE,
  isSupportedJellyfinVersion,
} from '../dist/jellyfin-version.js';
import { makeServers } from '../dist/server.js';
import { checkJellyfinMatrix, jellyfinMatrix } from '../scripts/jellyfin-matrix.mjs';
import { GrantStore } from '../dist/store.js';
import { get, halfOpen } from './support/household-app.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const HOST = 'jelly-grove.example.test';
const MAPPED_HOST = 'media.example.com';
const ADMIN = { Authorization: 'Bearer admin-secret' };
const RELAYED = 'jellyfin web page';
// CI runs on every pull request and every push to main; the release workflow on every release tag.
const CI_ON = { pull_request: {}, push: { branches: 'main' } };
const RELEASE_ON = { push: { tags: 'v*.*.*' } };

describe('supported Jellyfin versions', () => {
  it('supports every 10.11.x and every 12.x, and nothing else', () => {
    assert.deepEqual(SUPPORTED_JELLYFIN_RELEASES, ['10.11', '12']);
    for (const version of ['10.11.0', '10.11.3', '10.11.11', '12.0.0', '12.3.0', '12.4.0', '12.10.2']) {
      assert.equal(isSupportedJellyfinVersion(version), true, version);
    }
    for (const version of ['10.10.7', '10.1.11', '10.110.0', '11.0.0', '13.0.0', '120.0.0', '1.0', '12.0.0-rc1', 'v12.4.0', '', '12.4.0 ']) {
      assert.equal(isSupportedJellyfinVersion(version), false, version);
    }
  });

  it('tests every supported release in CI and before a release, against the same pinned images', async () => {
    const pinned = JSON.parse(await readFile('scripts/jellyfin-versions.json', 'utf8'));
    assert.ok(pinned.length >= 2);
    for (const { image, version } of pinned) {
      assert.match(image, /^jellyfin\/jellyfin:\d[\w.-]*$/, 'an exact tag, never latest or a floating one');
      assert.ok(isSupportedJellyfinVersion(version), version);
    }
    for (const release of SUPPORTED_JELLYFIN_RELEASES) {
      assert.ok(pinned.some(({ version }) => version === release || version.startsWith(`${release}.`)), `no CI image for ${release}`);
    }
    checkJellyfinMatrix(await readFile('.github/workflows/ci.yaml', 'utf8'), pinned, { requiredOn: CI_ON });
    checkJellyfinMatrix(await readFile('.github/workflows/release.yaml', 'utf8'), pinned, { publishJobs: ['container', 'release'], requiredOn: RELEASE_ON });
  });

  it('refuses a workflow matrix that differs from the pinned images in any way', () => {
    const pinned = [{ image: 'jellyfin/jellyfin:12.4.0', version: '12.4.0' }, { image: 'jellyfin/jellyfin:10.11.11', version: '10.11.11' }];
    const workflow = ({ entries = pinned, needs = '[validate, jellyfin-integration]', extraJob = '' } = {}) => [
      'on:',
      '  push:',
      "    tags: ['v*.*.*']",
      'jobs:',
      extraJob,
      '  jellyfin-integration:',
      '    name: jellyfin-integration (${{ matrix.jellyfin.version }})',
      '    strategy:',
      '      fail-fast: false',
      '      matrix:',
      '        jellyfin:',
      ...entries.map(({ image, version }) => `          - image: ${image}\n            version: ${version}`),
      '    steps:',
      '      - uses: actions/checkout@v7',
      '      - run: pnpm test:real # against the matrix image',
      '        env:',
      '          JELLYFIN_IMAGE: ${{ matrix.jellyfin.image }}',
      '          JELLYFIN_REAL_VERSION: ${{ matrix.jellyfin.version }}',
      '  container:',
      `    needs: ${needs}`,
      '    steps:',
      '      - run: |',
      '          echo "# not a comment"',
      '  release:',
      "    if: startsWith(github.ref, 'refs/tags/v')",
      '    needs: container',
      '    steps:',
      '      - run: gh release create',
      '',
    ].join('\n');
    const options = { publishJobs: ['container', 'release'], requiredOn: RELEASE_ON };
    checkJellyfinMatrix(workflow(), pinned, options);
    checkJellyfinMatrix(workflow({ entries: [...pinned].reverse() }), pinned, options);
    assert.deepEqual(jellyfinMatrix(workflow()), pinned);

    const refused = (text, pattern) => assert.throws(() => checkJellyfinMatrix(text, pinned, options), pattern);
    const step = (text) => workflow().replace('        env:\n', `${text}\n        env:\n`);
    const job = (name, text) => workflow().replace(`  ${name}:\n`, `  ${name}:\n${text}\n`);
    refused(workflow({ entries: [...pinned, { image: 'jellyfin/jellyfin:10.10.7', version: '10.10.7' }] }), /extra \[jellyfin\/jellyfin:10\.10\.7 @ 10\.10\.7\]/);
    refused(workflow({ entries: pinned.slice(0, 1) }), /missing \[jellyfin\/jellyfin:10\.11\.11 @ 10\.11\.11\]/);
    refused(workflow({ entries: [{ ...pinned[0], version: '10.11.11' }, { ...pinned[1], version: '12.4.0' }] }), /missing .*extra /);
    refused(workflow({ entries: [pinned[0], pinned[1], pinned[1]] }), /lists jellyfin\/jellyfin:10\.11\.11 @ 10\.11\.11 twice/);
    // The pinned pair written elsewhere in the workflow does not count: only the matrix does.
    const outside = '  other:\n    env:\n      image: jellyfin/jellyfin:10.11.11\n      version: 10.11.11';
    refused(workflow({ entries: pinned.slice(0, 1), extraJob: outside }), /missing \[jellyfin\/jellyfin:10\.11\.11 @ 10\.11\.11\]/);
    refused(workflow().replace('${{ matrix.jellyfin.image }}', 'jellyfin/jellyfin:10.11.11'), /no "pnpm test:real" step on the matrix image/);
    refused(workflow().replace('        jellyfin:\n', '        include:\n'), /must have only a "jellyfin" list/);
    refused(workflow().replace('            version: 12.4.0\n', ''), /entry 1 must be exactly \{ image, version \}/);

    // needs: every form the workflows use passes; anything that does not name the job, as YAML reads it, is refused.
    for (const needs of ['jellyfin-integration', '"jellyfin-integration"', '[validate, jellyfin-integration]', "[validate, 'jellyfin-integration']",
      '\n      - validate\n      - jellyfin-integration', '\n    - validate\n    - jellyfin-integration']) {
      checkJellyfinMatrix(workflow({ needs }), pinned, options);
    }
    refused(workflow({ needs: 'validate' }), /container does not need jellyfin-integration/);
    refused(workflow({ needs: '[validate]' }), /container does not need jellyfin-integration/);
    refused(workflow({ needs: '["validate, jellyfin-integration"]' }), /container does not need jellyfin-integration/);
    refused(workflow({ needs: "['validate, jellyfin-integration, release']" }), /container does not need jellyfin-integration/);
    refused(workflow({ needs: '[validate, [jellyfin-integration]]' }), /unsupported flow sequence/);
    refused(workflow({ needs: '[[validate, jellyfin-integration]]' }), /unsupported flow sequence/);
    refused(workflow({ needs: '[validate, {jellyfin-integration: x}]' }), /unsupported flow sequence/);
    refused(workflow({ needs: '[validate, jellyfin-integration,]' }), /unsupported flow sequence/);
    refused(workflow({ needs: '[validate, jellyfin-integration' }), /unsupported flow sequence/);
    refused(workflow({ needs: '["jellyfin-integration" x]' }), /unsupported quoted value/);

    // The test step and its job must always run, and a failure must fail the run.
    refused(step('        if: false'), /"pnpm test:real" step must not have an "if"/);
    refused(step("        if: github.event_name == 'push'"), /"pnpm test:real" step must not have an "if"/);
    refused(step('        continue-on-error: true'), /step must not have "continue-on-error: true"/);
    checkJellyfinMatrix(step('        continue-on-error: false'), pinned, options);
    refused(step('        shell: true {0}'), /step has unexpected "shell"/);
    refused(step('        working-directory: elsewhere'), /step has unexpected "working-directory"/);
    refused(workflow().replace('          JELLYFIN_REAL_VERSION', '          JELLYFIN_REAL_SKIP: 1\n          JELLYFIN_REAL_VERSION'), /no "pnpm test:real" step on the matrix image/);
    refused(workflow().replace('      - uses: actions/checkout@v7\n', '      - run: pnpm test:real\n'), /more than one "pnpm test:real" step/);
    refused(job('jellyfin-integration', '    if: false'), /^Error: jellyfin-integration must not have an "if"/);
    refused(job('jellyfin-integration', '    continue-on-error: true'), /jellyfin-integration must not have "continue-on-error: true"/);
    refused(job('jellyfin-integration', '    continue-on-error: ${{ matrix.jellyfin.version == \'12.4.0\' }}'), /must not have "continue-on-error/);
    checkJellyfinMatrix(job('jellyfin-integration', '    continue-on-error: false'), pinned, options);
    refused(job('jellyfin-integration', '    needs: validate'), /jellyfin-integration has unexpected "needs"/);
    refused(job('jellyfin-integration', '    defaults:\n      run:\n        shell: true {0}'), /jellyfin-integration has unexpected "defaults"/);
    refused(`defaults:\n  run:\n    shell: true {0}\n${workflow()}`, /workflow must not set defaults/);
    refused(workflow().replace('fail-fast: false', 'fail-fast: ${{ github.ref == \'x\' }}'), /fail-fast must be true or false/);
    checkJellyfinMatrix(workflow().replace('fail-fast: false', 'fail-fast: true'), pinned, options);
    refused(workflow().replace('      fail-fast: false\n', '      fail-fast: false\n      max-parallel: 1\n'), /strategy has unexpected "max-parallel"/);

    // Publishing waits for the matrix: no status function in its if, directly or through the job it needs.
    refused(job('container', '    if: always()'), /container has "if: always\(\)", which could run it after jellyfin-integration fails/);
    refused(job('container', '    if: ${{ !cancelled() }}'), /container has "if: \$\{\{ !cancelled\(\) \}\}"/);
    refused(job('container', '    if: success() || true'), /container has "if: success\(\) \|\| true"/);
    refused(job('container', '    if: Failure()'), /container has "if: Failure\(\)"/);
    checkJellyfinMatrix(job('container', "    if: github.event_name == 'push'"), pinned, options);
    refused(workflow().replace("    if: startsWith(github.ref, 'refs/tags/v')", "    if: always() && startsWith(github.ref, 'refs/tags/v')"), /release has "if: always\(\) && /);
    refused(workflow().replace('    needs: container', '    needs: [container, validate]').replace(/ {2}container:\n {4}needs: .*\n/, '  container:\n    if: always()\n    needs: [validate, jellyfin-integration]\n'), /container has "if: always\(\)"/);
    refused(workflow().replace('    needs: container', '    needs: validate'), /release does not need jellyfin-integration/);
    assert.throws(() => checkJellyfinMatrix(workflow(), pinned, { ...options, publishJobs: ['publish'] }), /no publish job/);
    assert.throws(() => checkJellyfinMatrix(workflow(), pinned, { publishJobs: [] }), /requiredOn must name the triggers/);

    // Triggers: the real forms pass; anything that could skip the runs that matter is refused.
    const on = (text) => {
      const replaced = workflow().replace("on:\n  push:\n    tags: ['v*.*.*']\n", `${text}\n`);
      assert.notEqual(replaced, workflow());
      return replaced;
    };
    const ci = (text) => checkJellyfinMatrix(on(text), pinned, { requiredOn: CI_ON });
    const ciRefused = (text, pattern) => assert.throws(() => ci(text), pattern);
    const release = (text) => checkJellyfinMatrix(on(text), pinned, options);
    const releaseRefused = (text, pattern) => assert.throws(() => release(text), pattern);
    ci('on:\n  push:\n    branches: [main]\n  pull_request:');
    ci('on: [push, pull_request]');
    ci('on:\n  push:\n  pull_request:\n    branches: [main]\n    types: [opened, synchronize, reopened]');
    release("on:\n  push:\n    branches: [main]\n    tags: ['v*.*.*']\n  workflow_dispatch:");
    release('on:\n  push:\n    tags: v*.*.*');
    ciRefused('on: workflow_dispatch', /does not run on pull_request/);
    releaseRefused('on: workflow_dispatch', /does not run on push/);
    ciRefused('on:\n  push:\n    branches: [main]', /does not run on pull_request/);
    ciRefused('on:\n  pull_request:', /does not run on push/);
    ciRefused("on:\n  push:\n    tags: ['v*.*.*']\n  pull_request:", /on\.push does not run for branches main/);
    releaseRefused('on:\n  push:\n    branches: [main]\n  workflow_dispatch:', /on\.push does not run for tags v\*\.\*\.\*/);
    releaseRefused("on:\n  push:\n    tags: ['v*']", /on\.push does not run for tags v\*\.\*\.\*/);
    releaseRefused("on:\n  push:\n    tags: ['v*.*.*', '!v1.*']", /on\.push\.tags must not exclude/);
    ciRefused("on:\n  push:\n    branches: [main]\n  pull_request:\n    paths-ignore: ['src/**']", /on\.pull_request has unexpected "paths-ignore"/);
    ciRefused("on:\n  push:\n    branches: [main]\n    paths: ['docs/**']\n  pull_request:", /on\.push has unexpected "paths"/);
    ciRefused('on:\n  push:\n    branches-ignore: [main]\n  pull_request:', /on\.push has unexpected "branches-ignore"/);
    ciRefused('on:\n  push:\n    branches: [release]\n  pull_request:', /on\.push does not run for branches main/);
    ciRefused('on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [develop]', /on\.pull_request does not run for branches main/);
    ciRefused('on:\n  push:\n    branches: [main]\n  pull_request:\n    types: [closed]', /types must include opened and synchronize/);
    ciRefused('on:\n  push:\n    branches: [main]\n  pull_request: x', /on\.pull_request must be empty or a mapping/);

    // Anything the reader does not fully support is refused rather than guessed at.
    refused(workflow().replace('fail-fast: false', 'fail-fast: &x false'), /unsupported YAML/);
    refused(workflow().replace('fail-fast: false', 'fail-fast: !!str false'), /unsupported YAML/);
    refused(workflow().replace('    steps:\n      - uses', '    strategy: {}\n    steps:\n      - uses'), /duplicate key "strategy"/);
    refused(workflow().replace('          JELLYFIN_REAL_VERSION', '          JELLYFIN_IMAGE: x\n          JELLYFIN_REAL_VERSION'), /duplicate key "JELLYFIN_IMAGE"/);
    refused(workflow().replace('  release:', '  "container":\n    needs: validate\n  release:'), /duplicate key "container"/);
    refused(workflow().replace('  release:', '  <<: {}\n  release:'), /merge keys are not supported/);
    refused(workflow().replace('      fail-fast: false', '      ? fail-fast\n      : false'), /expected "key: value"/);
    refused(workflow().replace('      fail-fast: false', '      fail-fast : false'), /space before the ":"/);
    refused(workflow().replace('      fail-fast: false', '\tfail-fast: false'), /has a tab/);
    refused(workflow().replace(/\n/g, '\r\n'), /carriage return \(CRLF\)/);
    refused(`\uFEFF${workflow()}`, /byte-order mark/);
    refused(`---\n${workflow()}`, /document markers/);
    refused(`${workflow()}---\njobs: {}\n`, /document markers/);
    refused(`${workflow()}...\n`, /document markers/);
    refused(`%YAML 1.2\n${workflow()}`, /document markers and directives/);
    refused(step('        if: >\n          false'), /unsupported YAML ">"/);
    refused(workflow().replace('      - run: |\n', '      - run: |-\n'), /unsupported YAML "\|-"/);
    refused(workflow().replace('- run: pnpm test:real # against the matrix image', '- run: "pnpm test:real" x'), /unsupported quoted value/);
    refused(workflow().replace('- run: pnpm test:real # against the matrix image', '- run: "pnpm test:real\\x00"'), /unsupported escape/);
    refused(workflow().replace('- run: pnpm test:real # against the matrix image', '- run: pnpm test:real: x'), /cannot contain ": "/);
    refused(workflow().replace('- run: pnpm test:real # against the matrix image', '- run: pnpm test:real\n          && exit 0'), /unexpected indentation/);
    refused(workflow().replace('      - run: pnpm test:real # against', '      - - run: pnpm test:real # against'), /unsupported YAML "- run/);
    // Comments and quoting that YAML reads the same way still pass, and so does the literal block form.
    checkJellyfinMatrix(workflow().replace('- run: pnpm test:real # against the matrix image', "- run: 'pnpm test:real' # a # comment"), pinned, options);
    checkJellyfinMatrix(workflow().replace('- run: pnpm test:real # against the matrix image', '- run: |\n          pnpm test:real'), pinned, options);
    checkJellyfinMatrix(workflow().replace('- run: pnpm test:real # against the matrix image', '- run: pnpm test:real #x\n          #y'), pinned, options);
    refused(workflow().replace('- run: pnpm test:real # against the matrix image', '- run: "pnpm test:real # quoted"'), /no "pnpm test:real" step/);
  });
});

describe('Jellyfin version gate, enforcing (the 4.0.0 default)', () => {
  it('serves on a supported version and logs no warning', async () => {
    const { gate, logs } = gateFor({ version: '12.3.0' });
    await gate.check();
    assert.equal(gate.decision(), 'serve');
    assert.equal(gate.status().householdHosts, 'serving');
    assert.equal(logs.filter((entry) => entry.level === 'warn').length, 0);
    gate.stop();
  });

  it('refuses an untested version until that exact version is confirmed, and warns once', async () => {
    const { gate, logs, jellyfin, stored } = gateFor({ version: '13.0.0' });
    await gate.check();
    await gate.check();
    assert.equal(gate.decision(), 'refuse');
    assert.equal(logs.filter((entry) => entry.level === 'warn').length, 1);
    assert.match(logs.find((entry) => entry.level === 'warn').message, /JELLYFIN_UNTESTED_VERSION_OK/);
    await assert.rejects(gate.confirm('13.0.1'), { message: 'jellyfin_version_changed' });
    await gate.confirm('13.0.0');
    assert.equal(stored.value, '13.0.0');
    assert.equal(gate.decision(), 'serve');
    // An upgrade to another untested version asks again.
    jellyfin.version = '13.1.0';
    await gate.check();
    assert.equal(gate.decision(), 'refuse');
    // A supported version needs no confirmation, and one cannot be stored for it.
    jellyfin.version = '12.4.0';
    await gate.check();
    assert.equal(gate.decision(), 'serve');
    await assert.rejects(gate.confirm('12.4.0'), { message: 'jellyfin_version_supported' });
    gate.stop();
  });

  it('serves the exact version JELLYFIN_UNTESTED_VERSION_OK names, and no other', async () => {
    const { gate, jellyfin } = gateFor({ version: '13.0.0', environmentConfirmed: '13.0.0' });
    await gate.check();
    assert.equal(gate.decision(), 'serve');
    jellyfin.version = '13.0.1';
    await gate.check();
    assert.equal(gate.decision(), 'refuse');
    gate.stop();
  });

  it('logs a confirmed untested version once, not again on later reads or requests', async () => {
    const versionLogs = (logs) => logs.filter((entry) => entry.version === '13.0.0' && entry.message !== 'read the Jellyfin version');
    // Confirmed by an administrator: the warning when it was first read, then one line at the confirmation.
    const confirmed = gateFor({ version: '13.0.0' });
    await confirmed.gate.check();
    await confirmed.gate.confirm('13.0.0');
    for (let read = 0; read < 3; read += 1) {
      await confirmed.gate.check();
      assert.equal(await confirmed.gate.householdDecision(), 'serve');
    }
    assert.deepEqual(versionLogs(confirmed.logs).map((entry) => entry.level), ['warn', 'warn']);
    assert.match(versionLogs(confirmed.logs)[1].message, /administrator confirmed/);
    confirmed.gate.stop();

    // JELLYFIN_UNTESTED_VERSION_OK, or a confirmation stored before this start: one info line when it is first read, no warning.
    for (const options of [{ environmentConfirmed: '13.0.0' }, { stored: '13.0.0' }]) {
      const { gate, logs, stored } = gateFor({ version: '13.0.0', ...(options.environmentConfirmed ? { environmentConfirmed: options.environmentConfirmed } : {}) });
      if (options.stored) stored.value = options.stored;
      for (let read = 0; read < 3; read += 1) {
        await gate.check();
        assert.equal(await gate.householdDecision(), 'serve');
      }
      assert.deepEqual(versionLogs(logs).map((entry) => entry.level), ['info'], JSON.stringify(options));
      assert.equal(logs.filter((entry) => entry.level === 'warn').length, 0, JSON.stringify(options));
      gate.stop();
    }

    // Withdrawing a confirmation warns again, once.
    const withdrawn = gateFor({ version: '13.0.0' });
    await withdrawn.gate.check();
    await withdrawn.gate.confirm('13.0.0');
    await withdrawn.gate.clearConfirmation();
    await withdrawn.gate.check();
    await withdrawn.gate.check();
    assert.deepEqual(versionLogs(withdrawn.logs).map((entry) => entry.level), ['warn', 'warn', 'warn']);
    assert.equal(withdrawn.gate.decision(), 'refuse');
    withdrawn.gate.stop();
  });

  it('does not wait for an unreachable Jellyfin: refuses while the version is unknown, and reads it again on demand', async () => {
    let now = 0;
    const { gate, jellyfin } = gateFor({ version: '12.4.0', down: true, now: () => now });
    await gate.check();
    assert.equal(gate.decision(), 'unknown');
    assert.match(gate.status().error, /unreachable/);
    // Within five seconds of the last read a request does not start another.
    now = 4_000;
    assert.equal(await gate.householdDecision(), 'unknown');
    assert.equal(jellyfin.reads, 1);
    jellyfin.down = false;
    now = 5_000;
    assert.equal(await gate.householdDecision(), 'serve');
    assert.equal(jellyfin.reads, 2);
    // A read that fails later forgets the version, so an upgrade during a restart is never served unchecked.
    jellyfin.down = true;
    await gate.check();
    assert.equal(gate.decision(), 'unknown');
    gate.stop();
  });
});

describe('household hosts and the Jellyfin version, enforcing (the 4.0.0 default)', { timeout: 30_000 }, () => {
  it('relays household requests on a supported version, as before', async (t) => {
    const app = await startApp(t, { version: '10.11.11' });
    const answer = await get(app.port, '/web/index.html', { Host: HOST });
    assert.deepEqual([answer.status, answer.text], [200, RELAYED]);
    assert.equal((await get(app.adminPort, '/v1/jellyfin/version', ADMIN)).json().householdHosts, 'serving');
  });

  it('answers a fixed 503 on an untested version and never relays it, while the admin site keeps working', async (t) => {
    const app = await startApp(t, { version: '13.0.0' });
    for (const pathname of ['/web/index.html', '/Users/AuthenticateByName', '/System/Info/Public', '/jellypass/app/v1/me']) {
      const answer = await get(app.port, pathname, { Host: HOST });
      assert.deepEqual([answer.status, answer.text], [503, UNTESTED_VERSION_MESSAGE], pathname);
      assert.equal(answer.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(answer.headers['cache-control'], 'no-store');
      assert.equal(answer.headers['retry-after'], '300');
    }
    assert.deepEqual(app.jellyfin.relayed, [], 'nothing reached Jellyfin from a household host');
    assert.equal(await rawUpgrade(app.port, '/socket', HOST), refusalResponse(UNTESTED_VERSION_MESSAGE, '300'));
    // The same on the household's mapped address, HTTP and WebSocket alike.
    assert.equal((await get(app.port, '/web/index.html', { Host: MAPPED_HOST })).status, 503);
    assert.equal(await rawUpgrade(app.port, '/socket', MAPPED_HOST), refusalResponse(UNTESTED_VERSION_MESSAGE, '300'));
    // A client that keeps its own end open still has the refused connection closed by the server.
    const held = await halfOpen(app.server, `GET /socket HTTP/1.1\r\nHost: ${HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    assert.deepEqual([held.answer, held.closed], [refusalResponse(UNTESTED_VERSION_MESSAGE, '300'), true]);

    assert.equal((await get(app.adminPort, '/health')).status, 200);
    const status = (await get(app.adminPort, '/v1/jellyfin/version', ADMIN)).json();
    assert.deepEqual(
      [status.version, status.supported, status.confirmation, status.enforcement, status.householdHosts, status.confirmedVersion, status.supportedReleases],
      ['13.0.0', false, 'unconfirmed', 'refuse', 'refused', null, ['10.11', '12']],
    );
    const metrics = (await get(app.adminPort, '/metrics', ADMIN)).text;
    assert.match(metrics, /^jfa_jellyfin_version_info\{confirmed="false",supported="false",version="13\.0\.0"\} 1$/m);
    assert.match(metrics, /^jfa_household_hosts_refusing 1$/m);
  });

  it('serves once an administrator confirms the exact version, keeps it across a restart, and asks again after an upgrade', async (t) => {
    const app = await startApp(t, { version: '13.0.0' });
    const wrong = await put(app.adminPort, '/v1/jellyfin/version/confirmation', { version: '13.0.1' });
    assert.deepEqual([wrong.status, wrong.json().error], [409, 'jellyfin_version_changed']);
    const confirmed = await put(app.adminPort, '/v1/jellyfin/version/confirmation', { version: '13.0.0' });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.deepEqual([confirmed.json().confirmedVersion, confirmed.json().householdHosts], ['13.0.0', 'serving']);
    assert.deepEqual([(await get(app.port, '/web/index.html', { Host: HOST })).text], [RELAYED]);
    assert.match((await get(app.adminPort, '/metrics', ADMIN)).text, /^jfa_household_hosts_refusing 0$/m);

    // Stored in the state file, so a restarted JellyPass serves at once.
    assert.equal(JSON.parse(await readFile(app.stateFile, 'utf8')).jellyfinVersionConfirmed, '13.0.0');
    const restarted = await startApp(t, { version: '13.0.0', stateFile: app.stateFile });
    assert.equal((await get(restarted.port, '/web/index.html', { Host: HOST })).text, RELAYED);

    app.jellyfin.version = '13.1.0';
    await app.gate.check();
    const upgraded = await get(app.port, '/web/index.html', { Host: HOST });
    assert.deepEqual([upgraded.status, upgraded.text], [503, UNTESTED_VERSION_MESSAGE]);

    // Withdrawing the confirmation pauses the version it was for again.
    app.jellyfin.version = '13.0.0';
    await app.gate.check();
    const withdrawn = await request(app.adminPort, '/v1/jellyfin/version/confirmation', { method: 'DELETE', headers: ADMIN });
    assert.deepEqual([withdrawn.status, withdrawn.json().householdHosts], [200, 'refused']);
  });

  it('keeps serving after an upgrade from 3.10.0 on the version 3.10.0 had confirmed', async (t) => {
    // 3.10.0's state file: schema v7, with the confirmation it stored.
    const stateFile = path.join(await makeTempDir(t, 'jfa-version-v7-'), 'grants.json');
    await writeFile(stateFile, JSON.stringify({
      version: 7,
      grants: {},
      groups: { grove: { id: 'grove', name: 'Grove', userIds: [], createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' } },
      catalog: { items: {} },
      passwordlessUserIds: [],
      handledRequestIds: [],
      jellyfinVersionConfirmed: '13.0.0',
    }));
    const app = await startApp(t, { version: '13.0.0', stateFile });
    const status = (await get(app.adminPort, '/v1/jellyfin/version', ADMIN)).json();
    assert.deepEqual([status.confirmation, status.confirmedVersion, status.enforcement, status.householdHosts], ['confirmed', '13.0.0', 'refuse', 'serving']);
    assert.deepEqual([(await get(app.port, '/web/index.html', { Host: HOST })).text], [RELAYED]);
    const migrated = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.deepEqual([migrated.version, migrated.jellyfinVersionConfirmed], [9, '13.0.0']);
    // A version 3.10.0 had not confirmed is refused.
    app.jellyfin.version = '13.0.1';
    await app.gate.check();
    assert.equal((await get(app.port, '/web/index.html', { Host: HOST })).status, 503);
  });

  it('answers a fixed 503 while Jellyfin is unreachable at start, and serves once it answers', async (t) => {
    let now = 0;
    const app = await startApp(t, { version: '12.4.0', down: true, now: () => now });
    const waiting = await get(app.port, '/web/index.html', { Host: HOST });
    assert.deepEqual([waiting.status, waiting.text], [503, UNKNOWN_VERSION_MESSAGE]);
    assert.equal(waiting.headers['retry-after'], '5');
    assert.equal(await rawUpgrade(app.port, '/socket', HOST), refusalResponse(UNKNOWN_VERSION_MESSAGE, '5'));
    assert.equal((await get(app.adminPort, '/health')).status, 200);
    assert.equal((await get(app.adminPort, '/v1/jellyfin/version', ADMIN)).json().householdHosts, 'waiting');
    app.jellyfin.down = false;
    now = 10_000;
    assert.equal((await get(app.port, '/web/index.html', { Host: HOST })).text, RELAYED);
  });

  it('keeps household hosts as they were when no version check is configured', async (t) => {
    const app = await startApp(t, { version: '13.0.0', gate: false });
    assert.equal((await get(app.port, '/web/index.html', { Host: HOST })).text, RELAYED);
    assert.equal((await get(app.adminPort, '/v1/jellyfin/version', ADMIN)).status, 404);
  });
});

describe('Jellyfin version gate, warning only (the 3.x default)', () => {
  it('is no longer the default: 4.0.0 refuses', () => {
    assert.equal(JELLYFIN_VERSION_ENFORCEMENT, 'refuse');
    assert.equal(gateFor({ version: '13.0.0' }).gate.status().enforcement, 'refuse');
    const { gate } = gateFor({ version: '13.0.0', enforcement: 'warn' });
    assert.equal(gate.status().enforcement, 'warn');
    gate.stop();
  });

  it('serves an untested version, reports it unconfirmed, and warns once per version until it is confirmed', async () => {
    const { gate, logs, jellyfin, stored } = gateFor({ version: '13.0.0', enforcement: 'warn' });
    await gate.check();
    await gate.check();
    assert.equal(gate.decision(), 'serve');
    assert.equal(await gate.householdDecision(), 'serve');
    assert.deepEqual(
      [gate.status().confirmation, gate.status().householdHosts, gate.status().enforcement],
      ['unconfirmed', 'serving', 'warn'],
    );
    const warnings = () => logs.filter((entry) => entry.level === 'warn');
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0].message, /keep serving/);
    assert.match(warnings()[0].message, /JELLYFIN_UNTESTED_VERSION_OK/);
    assert.match(warnings()[0].message, /4\.0\.0/);
    assert.equal(warnings()[0].version, '13.0.0');

    // Confirming clears the warning; a changed version warns again, once.
    await gate.confirm('13.0.0');
    assert.equal(stored.value, '13.0.0');
    assert.equal(gate.status().confirmation, 'confirmed');
    jellyfin.version = '13.1.0';
    await gate.check();
    await gate.check();
    assert.deepEqual([gate.decision(), gate.status().confirmation], ['serve', 'unconfirmed']);
    assert.equal(warnings().filter((entry) => entry.version === '13.1.0').length, 1);
    jellyfin.version = '12.4.0';
    await gate.check();
    assert.deepEqual([gate.decision(), gate.status().confirmation], ['serve', 'not_needed']);
    gate.stop();
  });

  it('treats any suffixed build as unconfirmed until that exact version is confirmed', async () => {
    for (const version of ['12.4.0-rc1', '12.4.0+build.7', '10.11.11-beta', '12.4.0.20261026-211555x']) {
      const { gate, logs } = gateFor({ version, enforcement: 'warn' });
      await gate.check();
      assert.deepEqual([gate.decision(), gate.status().supported, gate.status().confirmation], ['serve', false, 'unconfirmed'], version);
      assert.equal(logs.filter((entry) => entry.level === 'warn').length, 1, version);
      await gate.confirm(version);
      assert.equal(gate.status().confirmation, 'confirmed', version);
      gate.stop();
    }
    const { gate } = gateFor({ version: '12.4.0-rc1', environmentConfirmed: '12.4.0-rc1', enforcement: 'warn' });
    await gate.check();
    assert.equal(gate.status().confirmation, 'confirmed');
    gate.stop();
  });

  it('serves without waiting while the version is not known', async () => {
    let now = 0;
    const { gate, jellyfin } = gateFor({ version: '13.0.0', down: true, now: () => now, enforcement: 'warn' });
    await gate.check();
    now = 10_000;
    assert.equal(await gate.householdDecision(), 'serve');
    assert.equal(jellyfin.reads, 1, 'a household request does not read the version');
    assert.deepEqual([gate.status().confirmation, gate.status().householdHosts], [null, 'serving']);
    gate.stop();
  });
});

describe('household hosts and the Jellyfin version, warning only (the 3.x default)', { timeout: 30_000 }, () => {
  it('relays household requests and WebSockets on an unconfirmed version, as 3.9.0 did, and reports it to the admin', async (t) => {
    const logs = [];
    const app = await startApp(t, { version: '13.0.0', logs, enforcement: 'warn' });
    for (const pathname of ['/web/index.html', '/Users/AuthenticateByName', '/System/Info/Public']) {
      const answer = await get(app.port, pathname, { Host: HOST });
      assert.deepEqual([answer.status, answer.text], [200, RELAYED], pathname);
    }
    assert.deepEqual(app.jellyfin.relayed, ['/web/index.html', '/Users/AuthenticateByName', '/System/Info/Public']);
    assert.match(await rawUpgrade(app.port, '/socket', HOST), /^HTTP\/1\.1 404 /, 'Jellyfin\'s own answer');
    assert.equal(app.jellyfin.relayed.at(-1), 'upgrade /socket');
    assert.equal(logs.filter((entry) => entry.level === 'warn').length, 1, 'warned once, not per request');

    const status = (await get(app.adminPort, '/v1/jellyfin/version', ADMIN)).json();
    assert.deepEqual(
      [status.version, status.supported, status.confirmation, status.enforcement, status.householdHosts, status.confirmedVersion],
      ['13.0.0', false, 'unconfirmed', 'warn', 'serving', null],
    );
    const metrics = (await get(app.adminPort, '/metrics', ADMIN)).text;
    assert.match(metrics, /^jfa_jellyfin_version_info\{confirmed="false",supported="false",version="13\.0\.0"\} 1$/m);
    assert.match(metrics, /^jfa_household_hosts_refusing 0$/m);

    // Confirming still works and clears the warning; withdrawing brings it back.
    const confirmed = await put(app.adminPort, '/v1/jellyfin/version/confirmation', { version: '13.0.0' });
    assert.deepEqual([confirmed.status, confirmed.json().confirmation, confirmed.json().householdHosts], [200, 'confirmed', 'serving']);
    assert.match((await get(app.adminPort, '/metrics', ADMIN)).text, /^jfa_jellyfin_version_info\{confirmed="true",supported="false",version="13\.0\.0"\} 1$/m);
    const withdrawn = await request(app.adminPort, '/v1/jellyfin/version/confirmation', { method: 'DELETE', headers: ADMIN });
    assert.deepEqual([withdrawn.status, withdrawn.json().confirmation, withdrawn.json().householdHosts], [200, 'unconfirmed', 'serving']);
    assert.equal((await get(app.port, '/web/index.html', { Host: HOST })).text, RELAYED);
  });

  it('reports a version JELLYFIN_UNTESTED_VERSION_OK names as confirmed', async (t) => {
    const app = await startApp(t, { version: '12.4.0+build.7', environmentConfirmed: '12.4.0+build.7', enforcement: 'warn' });
    const status = (await get(app.adminPort, '/v1/jellyfin/version', ADMIN)).json();
    assert.deepEqual([status.confirmation, status.environmentConfirmedVersion], ['confirmed', '12.4.0+build.7']);
    assert.equal((await get(app.port, '/web/index.html', { Host: HOST })).text, RELAYED);
  });

  it('relays household requests while Jellyfin is unreachable at start', async (t) => {
    const app = await startApp(t, { version: '12.4.0', down: true, enforcement: 'warn' });
    assert.equal((await get(app.port, '/web/index.html', { Host: HOST })).text, RELAYED);
    const status = (await get(app.adminPort, '/v1/jellyfin/version', ADMIN)).json();
    assert.deepEqual([status.version, status.confirmation, status.householdHosts], [null, null, 'serving']);
  });

  it('changes nothing on a supported version', async (t) => {
    const app = await startApp(t, { version: '12.4.0', enforcement: 'warn' });
    assert.equal((await get(app.port, '/web/index.html', { Host: HOST })).text, RELAYED);
    const status = (await get(app.adminPort, '/v1/jellyfin/version', ADMIN)).json();
    assert.deepEqual([status.supported, status.confirmation, status.householdHosts], [true, 'not_needed', 'serving']);
  });
});

function gateFor({ version, down = false, environmentConfirmed, now, enforcement }) {
  const jellyfin = { version, down, reads: 0 };
  const stored = { value: undefined };
  const logs = [];
  const gate = new JellyfinVersionGate({
    read: async () => {
      jellyfin.reads += 1;
      if (jellyfin.down) throw new Error('Jellyfin is unreachable');
      return jellyfin.version;
    },
    ...(environmentConfirmed ? { environmentConfirmed } : {}),
    confirmation: { get: () => stored.value, set: async (value) => { stored.value = value; } },
    ...(enforcement ? { enforcement } : {}),
    ...(now ? { now } : {}),
    log: (entry) => logs.push(entry),
  });
  return { gate, logs, jellyfin, stored };
}

/** A Jellyfin that reports `version` (in Jellyfin 12's camelCase) and answers every other path with a fixed page. */
async function startJellyfin(t, { version, down }) {
  const jellyfin = { version, down, relayed: [] };
  const server = createServer((request, response) => {
    if (request.url === '/System/Info/Public' && request.headers.authorization?.includes('Token="jellyfin-key"')) {
      if (jellyfin.down) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ serverName: 'Test', version: jellyfin.version }));
      return;
    }
    jellyfin.relayed.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(RELAYED);
  });
  server.on('upgrade', (request, socket) => {
    jellyfin.relayed.push(`upgrade ${request.url}`);
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  jellyfin.url = `http://127.0.0.1:${server.address().port}`;
  return jellyfin;
}

async function startApp(t, { version, down = false, now, gate: withGate = true, stateFile, enforcement, environmentConfirmed, logs }) {
  const jellyfin = await startJellyfin(t, { version, down });
  const file = stateFile ?? path.join(await makeTempDir(t, 'jfa-version-'), 'grants.json');
  const store = new GrantStore(file);
  await store.load();
  if (!stateFile) {
    await store.upsertGroup({ id: 'grove', name: 'Grove', userIds: [] });
    // Grove's mapped address, besides its legacy one: the gate covers every household address.
    await store.setHouseholdAddresses('grove', { origin: `https://${MAPPED_HOST}`, aliases: [] });
  }
  const client = new JellyfinClient(jellyfin.url, 'jellyfin-key');
  const gate = new JellyfinVersionGate({
    read: () => client.getServerVersion(),
    ...(environmentConfirmed ? { environmentConfirmed } : {}),
    confirmation: { get: () => store.getJellyfinVersionConfirmed(), set: (value) => store.setJellyfinVersionConfirmed(value) },
    ...(enforcement ? { enforcement } : {}),
    ...(now ? { now } : {}),
    log: logs ? (entry) => logs.push(entry) : () => undefined,
  });
  if (withGate) await gate.check();
  const { member: server, admin } = makeServers(new AccessService(client, store), { webhook: 'webhook-secret', admin: 'admin-secret' }, undefined, {
    householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-' },
    ...(withGate ? { jellyfinVersion: gate } : {}),
  });
  await Promise.all([server, admin].map((listener) => new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))));
  t.after(async () => {
    gate.stop();
    for (const listener of [server, admin]) listener.closeAllConnections();
    await Promise.all([server, admin].map((listener) => new Promise((resolve) => listener.close(resolve))));
    await store.close();
  });
  return { port: server.address().port, adminPort: admin.address().port, server, jellyfin, gate, stateFile: file };
}

/** A request to JellyPass, with the Host header given (household hosts are told apart by it). */
function request(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return get(port, pathname, headers, { method, body });
}

function put(port, pathname, body) {
  return request(port, pathname, { method: 'PUT', headers: { ...ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** The whole refused WebSocket upgrade, byte for byte: the HTTP refusal's headers and body, then the connection closes. */
function refusalResponse(message, retryAfter) {
  return [
    'HTTP/1.1 503 Service Unavailable',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(message)}`,
    'Cache-Control: no-store',
    'CDN-Cache-Control: no-store',
    'Cloudflare-CDN-Cache-Control: no-store',
    'X-Content-Type-Options: nosniff',
    `Retry-After: ${retryAfter}`,
    'Connection: close',
    '',
    message,
  ].join('\r\n');
}

function rawUpgrade(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(raw));
    socket.on('close', () => resolve(raw));
  });
}
