/**
 * This build's version, sent to Jellyfin as the client version. The runtime image carries no package.json, so it is
 * kept here; test/setup-wizard.test.mjs fails when it differs from package.json, so a release bump cannot leave it behind.
 */
export const JELLYPASS_VERSION = '4.3.0';
