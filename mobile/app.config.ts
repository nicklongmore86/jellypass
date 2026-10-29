import type { ExpoConfig } from 'expo/config';

// The app's version (CFBundleShortVersionString, Android's versionName), kept in one place: package.json. A release
// bumps it there, with mobile/CHANGELOG.md, and the `mobile-v<version>` tag must match it (mobile/README.md,
// "Versioning"). EAS keeps only the build numbers.
import { version } from './package.json';

// FINAL, PERMANENT app ids (the owner's decision): never change them. A different iOS bundle id or Android package
// is a different app: members would have to install it afresh and sign in again, and TestFlight starts over. Android
// also needs every APK signed with the same key, forever (mobile/README.md). The two are spelled differently because
// an Android package may not contain a hyphen.
const IOS_BUNDLE_ID = 'com.rtc-services.jellypass';
const ANDROID_PACKAGE = 'com.rtcservices.jellypass';

// The EAS project, rtc-services-llc/jellypass on expo.dev (the owner and slug below). The ID is not a secret. Like the
// app ids it is permanent: EAS keeps the signing credentials and build numbers under it.
const EAS_PROJECT_ID = '1db20c4d-4270-404e-acf4-31a8bd6dd591';

// Jellyfin navy, the app's --bg: the splash, the root view behind every screen, and the Android icon's backdrop.
const NAVY = '#000b25';

// The store listing's public pages, https URLs the owner hosts. Each is optional: while one is empty the app hides the
// link that opens it (src/links.ts). Nothing else reads them, and no token or household address is ever sent with them.
//   privacyPolicyUrl: Account → About → "Privacy policy" (the stores require one inside the app)
//   supportUrl:       Account → About → "Support"
//   aboutUrl:         the address screen's "What is JellyPass?"
const PRIVACY_POLICY_URL = '';
const SUPPORT_URL = '';
const ABOUT_URL = '';

const config: ExpoConfig = {
  name: 'JellyPass',
  slug: 'jellypass',
  // The Expo organization the app belongs to, and its EAS project (eas.json has the build profiles). It must be the
  // project's owner on expo.dev, or EAS CLI refuses to run.
  owner: 'rtc-services-llc',
  extra: { eas: { projectId: EAS_PROJECT_ID }, privacyPolicyUrl: PRIVACY_POLICY_URL, supportUrl: SUPPORT_URL, aboutUrl: ABOUT_URL },
  version,
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
    // No buildNumber here: EAS keeps it (eas.json's appVersionSource "remote") and raises it for every build. The
    // Account screen reads the installed binary's own (expo-application).
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
    },
    // The app's only encryption is the standard HTTPS the OS provides (exempt), so App Store Connect asks nothing and a
    // TestFlight build never waits on "Missing Compliance" (ITSAppUsesNonExemptEncryption in the Info.plist).
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: ANDROID_PACKAGE,
    // No versionCode here either: EAS raises it for every APK, so each installs over the last.
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
