import type { ExpoConfig } from 'expo/config';

// PLACEHOLDER ids, to confirm before the first EAS build: the iOS bundle id and Android package can't be changed
// once a build is in TestFlight or Play, so pick the final reverse-DNS name (a domain the owner controls) first.
const APP_ID = 'io.starrgroup.jellypass';

// Jellyfin navy, the app's --bg: the splash, the root view behind every screen, and the Android icon's backdrop.
const NAVY = '#000b25';

const config: ExpoConfig = {
  name: 'JellyPass',
  slug: 'jellypass',
  version: '0.1.0',
  // Portrait on phones. iPad turns freely: supportsTablet without requireFullScreen lists all four orientations
  // for it (spelled out below too, because App Store validation needs them for iPad multitasking).
  orientation: 'portrait',
  icon: './assets/icon.png',
  // The jellypass:// links a household will hand out to connect the app to its address (the sign-in PR).
  scheme: 'jellypass',
  userInterfaceStyle: 'dark',
  backgroundColor: NAVY,
  ios: {
    bundleIdentifier: APP_ID,
    supportsTablet: true,
    requireFullScreen: false,
    infoPlist: {
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
    package: APP_ID,
    // A placeholder from the PWA icon: its ticket already sits inside the adaptive icon's safe zone.
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: NAVY },
  },
  // No over-the-air updates: expo-updates is not installed and nothing checks Expo's servers at launch.
  updates: { enabled: false },
  plugins: ['expo-router', ['expo-splash-screen', { backgroundColor: NAVY, image: './assets/icon.png', imageWidth: 200 }]],
};

export default config;
