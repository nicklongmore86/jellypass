// The app's identity and the promises the README makes about it: iPad support, no telemetry or update service,
// and no household address built in.
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
    expect(config.extra).toEqual({ eas: { projectId: '1db20c4d-4270-404e-acf4-31a8bd6dd591' } });
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
    expect(JSON.stringify(config)).not.toMatch(/https?:\/\//);
  });
});
