// The app's identity and the promises the README makes about it: iPad support, no telemetry or update service,
// and no household address built in.
import config from '../app.config';

describe('app config', () => {
  it('is JellyPass, on iPhone, iPad and Android, with the placeholder ids', () => {
    expect(config.name).toBe('JellyPass');
    expect(config.ios?.supportsTablet).toBe(true);
    expect(config.ios?.bundleIdentifier).toBe('io.starrgroup.jellypass');
    expect(config.android?.package).toBe('io.starrgroup.jellypass');
    expect(config.android?.adaptiveIcon?.backgroundColor).toBe('#000b25');
  });

  it('is portrait on iPhone and turns with the iPad', () => {
    expect(config.orientation).toBe('portrait');
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
