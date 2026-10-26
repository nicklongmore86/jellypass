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

  describe('EAS project ID', () => {
    const saved = process.env.EAS_PROJECT_ID;
    afterEach(() => {
      if (saved === undefined) delete process.env.EAS_PROJECT_ID;
      else process.env.EAS_PROJECT_ID = saved;
    });

    const load = (projectId?: string): typeof config => {
      if (projectId === undefined) delete process.env.EAS_PROJECT_ID;
      else process.env.EAS_PROJECT_ID = projectId;
      let loaded: typeof config | undefined;
      jest.isolateModules(() => {
        loaded = (require('../app.config') as { default: typeof config }).default;
      });
      return loaded!;
    };

    it('is the committed constant: empty (no extra.eas) until the owner pastes it in, then a UUID', () => {
      const source = require('fs').readFileSync(require('path').join(__dirname, '../app.config.ts'), 'utf8') as string;
      const constant = /^const EAS_PROJECT_ID = '([^']*)';$/m.exec(source)?.[1];
      expect(constant).toBeDefined();
      expect(constant).toMatch(/^$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const loaded = load(undefined);
      if (constant) expect(loaded.extra).toEqual({ eas: { projectId: constant } });
      else expect(loaded.extra).toBeUndefined();
    });

    it('can come from EAS_PROJECT_ID instead, and only ever as extra.eas.projectId', () => {
      const id = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
      const loaded = load(id);
      expect(loaded.extra).toEqual({ eas: { projectId: id } });
      // Only the ID: the config still has no URL and keeps updates off.
      expect(JSON.stringify(loaded)).not.toMatch(/https?:\/\//);
      expect(loaded.updates?.enabled).toBe(false);
    });

    it('refuses anything that is not a project UUID', () => {
      expect(() => load('jellypass')).toThrow(/UUID/);
      expect(() => load('0F1E2D3C-4B5A-4987-8A6B-5C4D3E2F1A0B ')).toThrow(/UUID/);
    });
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
