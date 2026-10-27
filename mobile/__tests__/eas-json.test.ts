// The release pipeline's promises (mobile/README.md, "Release builds"): eas.json has the two profiles every release
// needs, nothing turns on EAS Update or puts a credential in the repo, and the workflow that drives EAS only runs by
// hand or from a tag, behind the `mobile-release` environment, with exactly the five secrets.
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Profile = {
  distribution?: string;
  autoIncrement?: boolean;
  channel?: string;
  releaseChannel?: string;
  developmentClient?: boolean;
  credentialsSource?: string;
  env?: Record<string, string>;
  ios?: Record<string, unknown>;
  android?: Record<string, unknown>;
};
type EasJson = {
  cli: { version: string; appVersionSource: string };
  build: Record<string, Profile>;
  submit: Record<string, { ios?: Record<string, string>; android?: unknown }>;
};

const easJson = JSON.parse(readFileSync(join(__dirname, '../eas.json'), 'utf8')) as EasJson;
const workflow = readFileSync(join(__dirname, '../../.github/workflows/mobile-release.yaml'), 'utf8');
// The workflow without its comments, so a commented-out line (the schedule) can't satisfy or fail a check.
const code = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .map((line) => line.replace(/\s+#.*$/, ''))
  .join('\n');

describe('eas.json', () => {
  it('keeps build numbers on EAS, which raises them for every build', () => {
    expect(easJson.cli.appVersionSource).toBe('remote');
    expect(easJson.cli.version).toMatch(/^>= \d+\.\d+\.\d+$/);
  });

  it.each(['preview', 'production'])('%s builds iOS for TestFlight and Android as an APK', (name) => {
    const profile = easJson.build[name]!;
    expect(profile).toBeDefined();
    // `store` is an App Store signed build, the only kind TestFlight takes (`internal` would be ad hoc).
    expect(profile.distribution).toBe('store');
    // TestFlight refuses a build number it has seen, and Android installs an update only with a higher versionCode.
    expect(profile.autoIncrement).toBe(true);
    // An AAB installs only from Google Play.
    expect(profile.android?.buildType).toBe('apk');
    expect(profile.ios?.simulator ?? false).toBe(false);
    expect(profile.developmentClient ?? false).toBe(false);
    // Credentials stay on EAS (remote), never a credentials.json in the checkout.
    expect(profile.credentialsSource ?? 'remote').toBe('remote');
  });

  it('has only those two build profiles', () => {
    expect(Object.keys(easJson.build).sort()).toEqual(['preview', 'production']);
  });

  it('never turns on EAS Update or carries build-time secrets', () => {
    for (const profile of Object.values(easJson.build)) {
      expect(profile.channel).toBeUndefined();
      expect(profile.releaseChannel).toBeUndefined();
      expect(profile.env).toBeUndefined();
    }
  });

  it('submits iOS with the App Store Connect API key from the environment, and never submits Android', () => {
    expect(easJson.submit.production?.ios).toEqual({
      ascApiKeyPath: '$EXPO_ASC_API_KEY_PATH',
      ascApiKeyId: '$EXPO_ASC_KEY_ID',
      ascApiKeyIssuerId: '$EXPO_ASC_ISSUER_ID',
    });
    expect(easJson.submit.production?.android).toBeUndefined();
  });
});

// The release job, the last in the file.
const release = /^ {2}release:\n([\s\S]*)$/m.exec(code)?.[1] ?? '';

describe('the mobile-release workflow', () => {
  it('runs only by hand or from a mobile-v* tag, never on a pull request or a branch push', () => {
    const on = /^on:\n([\s\S]*?)^\S/m.exec(code)?.[1] ?? '';
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(['  workflow_dispatch:', '  push:']);
    expect(on).toMatch(/^ {4}tags: \['mobile-v\*'\]$/m);
    expect(code).not.toMatch(/pull_request|branches:/);
  });

  it('offers the platform, profile and TestFlight choices', () => {
    expect(code).toMatch(/platform:[\s\S]*?options: \[all, ios, android\]/);
    expect(code).toMatch(/profile:[\s\S]*?options: \[preview, production\]/);
    expect(code).toMatch(/submit:[\s\S]*?type: boolean/);
  });

  it('can read the repo and nothing more, and keeps its secrets behind the mobile-release environment', () => {
    expect(code).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    // Only the release job may write, and only releases (contents), with no secrets and no environment.
    expect(code.match(/^ +permissions:.*$/gm)).toEqual(['    permissions:']);
    expect(release).toMatch(/^ {4}permissions:\n {6}contents: write\n {4}steps:/m);
    expect(release).not.toMatch(/secrets\.|environment:/);
    expect(code.match(/environment: mobile-release$/gm)).toHaveLength(1);
    const secrets = [...new Set([...code.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]))].sort();
    expect(secrets).toEqual(['APPLE_TEAM_ID', 'ASC_API_ISSUER_ID', 'ASC_API_KEY_ID', 'ASC_API_KEY_P8', 'EXPO_TOKEN']);
    // The job without the environment (the checks) sees none of them.
    const check = /^ {2}check:\n([\s\S]*?)^ {2}build:/m.exec(code)?.[1] ?? '';
    expect(check).not.toMatch(/secrets\./);
  });

  it('pins every action to a full commit SHA and runs on Ubuntu 24.04', () => {
    const uses = [...code.matchAll(/uses: (\S+)/g)].map((match) => match[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    expect([...new Set([...code.matchAll(/runs-on: (\S+)/g)].map((match) => match[1]))]).toEqual(['ubuntu-24.04']);
  });

  it('pins EAS CLI to the version eas.json asks for at least', () => {
    const pinned = /EAS_CLI_VERSION: (\d+\.\d+\.\d+)$/m.exec(code)?.[1];
    expect(pinned).toBeDefined();
    expect(easJson.cli.version).toBe(`>= ${pinned}`);
  });

  it('hides EAS CLI\'s Expo Go advice from the CLI\'s own environment, not a build profile\'s', () => {
    const build = /^ {2}build:\n([\s\S]*?)^ {4}steps:/m.exec(code)?.[1] ?? '';
    expect(build).toMatch(/^ {6}EAS_BUILD_NO_EXPO_GO_WARNING: 'true'$/m);
    for (const profile of Object.values(easJson.build)) expect(profile.env ?? {}).not.toHaveProperty('EAS_BUILD_NO_EXPO_GO_WARNING');
  });

  it('checks the app before building, and builds and submits without prompts', () => {
    expect(code).toMatch(/^ {4}needs: check$/m);
    expect(code).toMatch(/run: pnpm check$/m);
    for (const command of code.match(/\beas (build|submit)\b.*$/gm) ?? []) expect(command).toMatch(/--non-interactive/);
    expect(code).toMatch(/eas build .*--wait/);
    expect(code).toMatch(/eas submit --platform ios --profile production/);
  });

  it('writes the App Store Connect key owner-only, deletes it whatever happens, and never traces a step', () => {
    expect(code).toMatch(/umask 077/);
    expect(code).toMatch(/chmod 600 "\$key_path"/);
    expect(code).toMatch(/if: always\(\)\n\s+run: rm -f "\$\{RUNNER_TEMP\}\/asc-api-key\.p8"/);
    expect(code).not.toMatch(/set -x|set -o xtrace|ACTIONS_STEP_DEBUG/);
    // A secret only ever reaches a step through `env:`, never spliced into a script.
    for (const line of code.match(/^.*secrets\..*$/gm) ?? []) expect(line).toMatch(/^\s+[A-Z0-9_]+: \$\{\{[^}]*\}\}$/);
  });

  it('checks a tag against package.json and mobile/CHANGELOG.md before installing anything', () => {
    const check = /^ {2}check:\n([\s\S]*?)^ {2}build:/m.exec(code)?.[1] ?? '';
    const step = /- name: Check the tag matches[^\n]*\n\s+if: github\.event_name == 'push'\n\s+run: (.*)$/m.exec(check);
    expect(step?.[1]).toBe('node ../scripts/mobile-release-tag.mjs "$GITHUB_REF_NAME" package.json CHANGELOG.md');
    expect(check.indexOf('mobile-release-tag')).toBeLessThan(check.indexOf('pnpm install'));
    // The tag (like the inputs) only ever reaches a script through the environment, never spliced in with an
    // expression: no `${{` anywhere in a run: script, one line or a block.
    const scripts = [...code.matchAll(/^( +)(?:- )?run: (?:\|\n((?:\1 {2}.*\n|\n)*)|(.*)$)/gm)].map((match) => match[2] ?? match[3] ?? '');
    expect(scripts.length).toBeGreaterThan(10);
    for (const script of scripts) expect(script).not.toMatch(/\$\{\{/);
  });

  it('publishes a tag\'s GitHub release from mobile/CHANGELOG.md once the builds are done, never as Latest', () => {
    expect(release).toMatch(/^ {4}needs: build$/m);
    // Only a tag push publishes: a run by hand on a `mobile-v*` tag is a test build (maybe preview, maybe one app).
    expect(release).toMatch(/^ {4}if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/mobile-v'\)$/m);
    expect(release).toMatch(/node scripts\/changelog-section\.mjs "\$version" mobile\/CHANGELOG\.md/);
    const publishes = release.match(/gh release (create|edit) .*$/gm) ?? [];
    expect(publishes).toHaveLength(2);
    for (const command of publishes) expect(command).toMatch(/--latest=false/);
    expect(release).toMatch(/gh release create .*--verify-tag/);
  });
});

// The token check runs as GitHub runs it (bash -eo pipefail), with `eas` replaced by a script that prints what EAS CLI
// 26.0.0's `eas whoami` would (commands/account/view.js; chalk colours the "limited" part).
describe('the Expo token check', () => {
  const script = /- name: Check the Expo token can build the project\n(?: {8}.*\n)*? {8}run: \|\n((?: {10}.*\n|\n)*)/
    .exec(workflow)?.[1]
    ?.replace(/^ {10}/gm, '');
  let bin: string;
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'eas-stub-'));
    writeFileSync(
      join(bin, 'eas'),
      '#!/bin/sh\ncase "$1" in whoami) printf "%s\\n" "$STUB_WHOAMI" ;; project:info) printf "%s\\n" "$STUB_INFO" ;; esac\n',
    );
    chmodSync(join(bin, 'eas'), 0o755);
  });
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  const run = (accounts: string[]) => {
    const whoami = ['robot (authenticated using EXPO_TOKEN)', 'someone@example.com', '', 'Accounts:', ...accounts].join('\n');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script!], {
      encoding: 'utf8',
      env: {
        NODE_ENV: 'test',
        PATH: `${bin}:${process.env.PATH}`,
        EXPO_TOKEN: 'not-a-real-token',
        STUB_WHOAMI: whoami,
        STUB_INFO: 'fullName  @rtc-services-llc/jellypass',
      },
    });
    return { status: result.status, errors: result.stdout.split('\n').filter((line) => line.startsWith('::error::')), out: result.stdout };
  };

  it('is found in the workflow', () => {
    expect(script).toMatch(/eas whoami/);
  });

  it.each(['Owner', 'Admin', 'Developer', 'Release Manager'])('lets a %s build', (role) => {
    const { status, errors, out } = run(['• someone (Role: Owner)', `• rtc-services-llc (Role: ${role})`]);
    expect(errors).toEqual([]);
    expect(status).toBe(0);
    expect(out).toContain('@rtc-services-llc/jellypass');
    expect(out).not.toContain('@example.com');
  });

  it.each(['Viewer', 'Runner', 'Custom: publish, view', 'No permissions'])('refuses a %s', (role) => {
    const { status, errors } = run([`• rtc-services-llc (Role: ${role})`]);
    expect(status).toBe(1);
    expect(errors).toEqual([expect.stringContaining(`role in rtc-services-llc is ${role}, not one that can start builds`)]);
  });

  it('refuses a token whose permission grant leaves too little, whatever the account\'s role', () => {
    const { status, errors } = run(['• rtc-services-llc (Role: Owner, \x1b[33mlimited to Viewer by the current credentials\x1b[39m)']);
    expect(status).toBe(1);
    expect(errors).toEqual([
      expect.stringContaining("role in rtc-services-llc is Owner, but the token's permission grant limits it to Viewer"),
    ]);
  });

  it('lets a token build when its grant still leaves a build role', () => {
    const { status, errors } = run(['• rtc-services-llc (Role: Owner, \x1b[33mlimited to Developer by the current credentials\x1b[39m)']);
    expect(errors).toEqual([]);
    expect(status).toBe(0);
  });

  it('refuses an account outside the organization', () => {
    const { status, errors } = run(['• someone (Role: Owner)', '• other-org (Role: Developer)']);
    expect(status).toBe(1);
    expect(errors).toEqual([expect.stringContaining('is not a member of the rtc-services-llc Expo organization')]);
  });
});
