#!/usr/bin/env node
// Checks a mobile release tag against the app it would build, before any build is spent.
//
//   node scripts/mobile-release-tag.mjs <tag> [path/to/package.json] [path/to/CHANGELOG.md]
//
// The tag must be `mobile-v<version>`, where <version> is exactly `version` in
// the app's package.json (mobile/package.json by default), and the app's
// changelog (mobile/CHANGELOG.md by default) must have a non-empty
// "## [<version>]" section (read with changelog-section.mjs, as the server's
// release notes are). Prints the version and exits 0, or exits 1 saying why.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection } from './changelog-section.mjs';

const PREFIX = 'mobile-v';
// Semantic Versioning 2.0.0's own pattern, without build metadata (EAS sets the build number).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function checkMobileReleaseTag({ tag, packageJson, changelog, packagePath = 'mobile/package.json', changelogPath = 'mobile/CHANGELOG.md' }) {
  if (!tag.startsWith(PREFIX)) throw new Error(`tag "${tag}" is not a mobile release tag (${PREFIX}<version>)`);
  const tagged = tag.slice(PREFIX.length);
  if (!SEMVER.test(tagged)) throw new Error(`tag "${tag}": "${tagged}" is not a version (MAJOR.MINOR.PATCH)`);

  let version;
  try {
    version = JSON.parse(packageJson).version;
  } catch {
    throw new Error(`${packagePath} is not valid JSON`);
  }
  if (typeof version !== 'string' || !version) throw new Error(`${packagePath} has no "version"`);
  if (tagged !== version) {
    throw new Error(`tag "${tag}" is version ${tagged}, but ${packagePath} says ${version}: tag the commit that bumps it, as ${PREFIX}${version}`);
  }

  try {
    changelogSection(changelog, version);
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/^CHANGELOG\.md /, '') : String(error);
    throw new Error(`${changelogPath}: ${reason}. Add the "## [${version}] - <date>" notes before tagging`);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag = '', packagePath = 'mobile/package.json', changelogPath = 'mobile/CHANGELOG.md'] = process.argv.slice(2);
  try {
    const version = checkMobileReleaseTag({
      tag,
      packageJson: readFileSync(packagePath, 'utf8'),
      changelog: readFileSync(changelogPath, 'utf8'),
      packagePath,
      changelogPath,
    });
    process.stdout.write(`${version}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error title=Mobile release tag::${message}`);
    else console.error(`mobile-release-tag: ${message}`);
    process.exitCode = 1;
  }
}
