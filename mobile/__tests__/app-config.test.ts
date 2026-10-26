// The app's identity and the promises the README makes about it: iPad support, no telemetry or update service,
// and no household address built in.
import config from '../app.config';

describe('app config', () => {
  it('is JellyPass, on iPhone, iPad and Android, with the final ids, owned by the Expo account', () => {
    expect(config.name).toBe('JellyPass');
    expect(config.owner).toBe('nicklongmore86');
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

  it('has no EAS project yet: that comes with the build PR', () => {
    expect(config.extra?.eas).toBeUndefined();
    expect(JSON.stringify(config)).not.toMatch(/projectId/);
  });

  it('is portrait on iPhone, and turns on iPad and Android', () => {
    // 'default' is Android's `unspecified`, so tablets rotate; on iOS the infoPlist keys below win.
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

  it('has no update service, analytics or tracking, and no household address', () => {
    const pkg = require('../package.json') as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((name) => /updates|analytics|tracking|sentry|segment|amplitude|firebase|insights|bugsnag|datadog/i.test(name))).toEqual([]);
    expect(config.updates?.enabled).toBe(false);
    expect(config.ios?.infoPlist?.NSPrivacyTracking ?? false).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(/https?:\/\//);
  });
});
