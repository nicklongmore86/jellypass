// The app's identity and the promises the README makes about it: iPad support, no telemetry or update service,
// and no household address built in.
import { readFileSync } from 'fs';
import { join } from 'path';

import config from '../app.config';

describe('app config', () => {
  it('is JellyPass, on iPhone, iPad and Android, with the final ids, owned by the Expo organization', () => {
    expect(config.name).toBe('JellyPass');
    expect(config.owner).toBe('rtc-services-llc');
    expect(config.ios?.supportsTablet).toBe(true);
    // Permanent: a different id is a different app for every member.
    expect(config.ios?.bundleIdentifier).toBe('com.rtc-services.jellypass');
    expect(config.android?.package).toBe('com.rtcservices.jellypass');
    expect(config.android?.adaptiveIcon?.backgroundColor).toBe('#000b25');
  });

  it('has a valid Android applicationId and iOS bundle id', () => {
    const segments = config.android!.package!.split('.');
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const segment of segments) expect(segment).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
    expect(config.ios!.bundleIdentifier).toMatch(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/);
  });

  it('is the rtc-services-llc/jellypass project on EAS', () => {
    // Permanent, like the app ids: EAS keeps the signing keys and build numbers under this project, owner and slug.
    expect(config.extra?.eas).toEqual({ projectId: '1db20c4d-4270-404e-acf4-31a8bd6dd591' });
    expect(config.owner).toBe('rtc-services-llc');
    expect(config.slug).toBe('jellypass');
  });

  it('is portrait on phones, and turns on iPad and Android tablets', () => {
    // 'default' is Android's `unspecified`, so tablets rotate (an Android phone is locked to portrait at launch:
    // orientation.test.ts); on iOS the infoPlist keys below win.
    expect(config.orientation).toBe('default');
    expect(config.ios?.infoPlist?.UISupportedInterfaceOrientations).toEqual(['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown']);
    expect(config.ios?.requireFullScreen).toBe(false);
    expect(config.ios?.infoPlist?.['UISupportedInterfaceOrientations~ipad']).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationPortraitUpsideDown',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ]);
  });

  it('is the version in package.json, the one place a release bumps it', () => {
    // EAS keeps only the build numbers (appVersionSource "remote"); the version members see is this one, and a
    // `mobile-v<version>` tag must match it (scripts/mobile-release-tag.mjs).
    const pkg = require('../package.json') as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(config.version).toBe(pkg.version);
    expect(readFileSync(join(__dirname, '../app.config.ts'), 'utf8')).not.toMatch(/version: '/);
  });

  it('has release notes in CHANGELOG.md for that version, as a mobile-v<version> tag requires', () => {
    // What scripts/mobile-release-tag.mjs asks of a tag: a dated, non-empty "## [<version>]" section, with its link.
    const { version } = require('../package.json') as { version: string };
    const changelog = readFileSync(join(__dirname, '../CHANGELOG.md'), 'utf8');
    // The sections, each from its "## [" heading to the next.
    const sections = changelog.split(/^(?=## \[)/m);
    const section = sections.find((text) => text.startsWith(`## [${version}] - `)) ?? '';
    expect(section).toMatch(/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\n/);
    const notes = section.split('\n').slice(1).filter((line) => !/^\[[^\]]+\]: /.test(line));
    expect(notes.join('').trim()).not.toBe('');
    expect(changelog).toMatch(/^## \[Unreleased\]$/m);
    expect(changelog).toContain(`[${version}]: https://github.com/nicklongmore86/jellypass/releases/tag/mobile-v${version}`);
  });

  it('leaves the build numbers to EAS', () => {
    // eas.json's appVersionSource "remote" and autoIncrement: EAS sets both for every build, and the Account screen
    // reads the installed binary's own (src/credits.ts). A number here would only drift from the real one.
    expect(Object.keys(config.ios ?? {})).not.toContain('buildNumber');
    expect(Object.keys(config.android ?? {})).not.toContain('versionCode');
  });

  it('declares only exempt encryption, so a TestFlight build never waits on export compliance', () => {
    // Standard HTTPS through the OS only: Expo writes ITSAppUsesNonExemptEncryption = false into the Info.plist.
    expect(config.ios?.config?.usesNonExemptEncryption).toBe(false);
  });

  it('opens jellypass:// setup links, and keeps the sign-in out of Android backups', () => {
    expect(config.scheme).toBe('jellypass');
    expect(config.android?.allowBackup).toBe(false);
    // The secure-store plugin would add a Face ID usage string for biometrics the app does not use.
    expect(JSON.stringify(config.plugins)).not.toMatch(/expo-secure-store/);
  });

  it('has no update service, analytics or tracking, and no household address', () => {
    const pkg = require('../package.json') as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((name) => /updates|analytics|tracking|sentry|segment|amplitude|firebase|insights|bugsnag|datadog/i.test(name))).toEqual([]);
    expect(config.updates?.enabled).toBe(false);
    expect(config.ios?.infoPlist?.NSPrivacyTracking ?? false).toBe(false);
    // The only addresses in it are the three jellypass.app store pages (store-links.test.tsx).
    expect([...JSON.stringify(config).matchAll(/https?:\/\/[^"]*/g)].map(([url]) => url)).toEqual([
      'https://jellypass.app/privacy/',
      'https://jellypass.app/support/',
      'https://jellypass.app/',
    ]);
  });
});
