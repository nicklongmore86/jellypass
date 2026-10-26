import type { ExpoConfig } from 'expo/config';

// FINAL, PERMANENT app ids (the owner's decision): never change them. A different iOS bundle id or Android package
// is a different app: members would have to install it afresh and sign in again, and TestFlight starts over. Android
// also needs every APK signed with the same key, forever (mobile/README.md). The two are spelled differently because
// an Android package may not contain a hyphen.
const IOS_BUNDLE_ID = 'com.rtc-services.jellypass';
const ANDROID_PACKAGE = 'com.rtcservices.jellypass';

// PLACEHOLDER until the owner creates the EAS project on expo.dev: paste its project ID (a UUID, not a secret) here
// (mobile/README.md, "Release builds"). EAS_PROJECT_ID in the environment wins, for a one-off local `eas` command
// before that commit; EAS's builders don't see it, so release builds need the ID committed here. While both are empty
// the config has no `extra.eas`, which Expo Go and the tests don't need, and the release workflow stops before building.
const EAS_PROJECT_ID = '';

const projectId = process.env.EAS_PROJECT_ID || EAS_PROJECT_ID;
if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId)) {
  throw new Error('The EAS project ID must be the UUID shown on the project page at expo.dev');
}

// Jellyfin navy, the app's --bg: the splash, the root view behind every screen, and the Android icon's backdrop.
const NAVY = '#000b25';

const config: ExpoConfig = {
  name: 'JellyPass',
  slug: 'jellypass',
  // The Expo account the app belongs to, and its EAS project (eas.json has the build profiles).
  owner: 'nicklongmore86',
  ...(projectId ? { extra: { eas: { projectId } } } : {}),
  version: '0.1.0',
  // Turns freely ('default': Android's `unspecified`), so Android tablets rotate; an Android phone is locked to portrait
  // at launch (src/orientation.ts), as Android has no per-form-factor setting. The iPhone stays portrait and the iPad
  // turns all four ways: both are spelled out in infoPlist below, which Expo uses in place of this value on iOS (App
  // Store validation needs all four on iPad for multitasking).
  orientation: 'default',
  icon: './assets/icon.png',
  // The setup links a household hands out, `jellypass://connect?address=https://jelly-<household>.<domain>`: they only
  // offer the address, for the member to confirm (src/app/connect.tsx).
  scheme: 'jellypass',
  userInterfaceStyle: 'dark',
  backgroundColor: NAVY,
  ios: {
    bundleIdentifier: IOS_BUNDLE_ID,
    supportsTablet: true,
    requireFullScreen: false,
    infoPlist: {
      UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown'],
      'UISupportedInterfaceOrientations~ipad': [
        'UIInterfaceOrientationPortrait',
        'UIInterfaceOrientationPortraitUpsideDown',
        'UIInterfaceOrientationLandscapeLeft',
        'UIInterfaceOrientationLandscapeRight',
      ],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: ANDROID_PACKAGE,
    // A placeholder from the PWA icon: its ticket already sits inside the adaptive icon's safe zone.
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: NAVY },
    // No Android backup: the sign-in is only ever on this device (a restored Keystore-encrypted value is unreadable
    // anyway), and the app keeps nothing else worth restoring.
    allowBackup: false,
  },
  // No over-the-air updates: expo-updates is not installed and nothing checks Expo's servers at launch.
  updates: { enabled: false },
  plugins: ['expo-router', ['expo-splash-screen', { backgroundColor: NAVY, image: './assets/icon.png', imageWidth: 200 }]],
};

export default config;
