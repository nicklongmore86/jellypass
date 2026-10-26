// The Account screen's "About & credits", word for word as the PWA's accountView (app/src/render.ts) shows them: what
// JellyPass is, TMDB's required notice, where titles and images come from, and JustWatch's credit for which films each
// streaming service has. Links open in the system browser.
import * as Application from 'expo-application';
import Constants from 'expo-constants';

export const ABOUT_TEXT = 'JellyPass is your household’s way to browse what is in your Jellyfin library and to find more to watch.';

/** TMDB's required notice, exactly as its terms give it. */
export const TMDB_NOTICE = 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.';

export const TMDB_URL = 'https://www.themoviedb.org/';
export const JUSTWATCH_URL = 'https://www.justwatch.com/';

/** A sentence with one link in it: the text before, the link's words and where it goes, and the text after. */
export interface LinkedSentence {
  before: string;
  link: string;
  url: string;
  after: string;
}

export const TMDB_SOURCE: LinkedSentence = { before: 'Titles, overviews and images come from ', link: 'themoviedb.org', url: TMDB_URL, after: '.' };

export const JUSTWATCH_CREDIT: LinkedSentence = {
  before: 'Which films each streaming service has (US availability only, the same for every household) comes from ',
  link: 'JustWatch',
  url: JUSTWATCH_URL,
  after: ', through TMDB.',
};

/** The links the Account screen may open: nothing else is ever handed to the system browser. */
export const CREDIT_URLS: readonly string[] = [TMDB_URL, JUSTWATCH_URL];

/** The installed binary's own version and build number, as the OS reports them (null where there is no binary). */
export interface InstalledVersion {
  version: string | null;
  build: string | null;
}

export function installedVersion(): InstalledVersion {
  return { version: Application.nativeApplicationVersion, build: Application.nativeBuildVersion };
}

/**
 * "JellyPass 0.1.0 (build 12)": the installed app's version and build number (CFBundleShortVersionString and
 * CFBundleVersion on iOS, versionName and versionCode on Android). EAS sets the build number for each build (eas.json's
 * remote version source), so the app config has none; with no native value (a development client) the config's
 * `version` stands in and no build is shown.
 */
export function versionText(installed: InstalledVersion = installedVersion(), config = Constants.expoConfig): string {
  const version = installed.version || config?.version || 'unknown';
  return installed.build ? `JellyPass ${version} (build ${installed.build})` : `JellyPass ${version}`;
}

/** The API revision the household's server speaks, from /me (0 when it does not say). */
export function apiVersionText(apiVersion: number): string {
  return `Household API version ${apiVersion}`;
}
