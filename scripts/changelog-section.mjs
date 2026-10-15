#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, for use as GitHub release notes.
//
//   node scripts/changelog-section.mjs <version|vX.Y.Z> [path/to/CHANGELOG.md]
//
// The section runs from its "## [X.Y.Z]" heading up to the next "## [" heading.
// The link reference definitions at the bottom of the changelog are left out,
// except those the section itself uses (such as [X.Y.Z] or [#1]), so its links
// still resolve on the release page. Exits with 1 if the section is missing or
// empty.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK_DEFINITION = /^\[([^\]]+)\]:\s*\S/;

export function changelogSection(changelog, version) {
  const wanted = version.trim().replace(/^v/, '');
  if (!wanted) throw new Error('no version given');
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const heading = `## [${wanted}]`;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) throw new Error(`CHANGELOG.md has no "${heading}" section`);
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## ['));
  if (end === -1) end = lines.length;

  const body = lines.slice(start, end).filter((line) => !LINK_DEFINITION.test(line));
  while (body.length > 0 && body.at(-1).trim() === '') body.pop();
  if (body.slice(1).every((line) => line.trim() === '')) {
    throw new Error(`CHANGELOG.md section "${heading}" is empty`);
  }

  const text = body.join('\n');
  const used = new Set([...text.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1].toLowerCase()));
  const definitions = lines.filter((line) => {
    const match = LINK_DEFINITION.exec(line);
    return match !== null && used.has(match[1].toLowerCase());
  });
  return definitions.length > 0 ? `${text}\n\n${definitions.join('\n')}\n` : `${text}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version = '', path = 'CHANGELOG.md'] = process.argv.slice(2);
  try {
    process.stdout.write(changelogSection(readFileSync(path, 'utf8'), version));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error title=Release notes::${message}`);
    else console.error(`changelog-section: ${message}`);
    process.exitCode = 1;
  }
}
