// The release pipeline's promises (mobile/README.md, "Release builds"): eas.json has the two profiles every release
// needs, nothing turns on EAS Update or puts a credential in the repo, and the workflow that drives EAS only runs by
// hand or from a tag, behind the `mobile-release` environment, with exactly the five secrets.
import { readFileSync } from 'fs';
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
    expect(code.match(/^ +permissions:/gm)).toBeNull();
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
});
