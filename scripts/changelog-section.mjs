#!/usr/bin/env node
// Prints the CHANGELOG.md notes for one version, for use as GitHub release notes.
//
//   node scripts/changelog-section.mjs <version|vX.Y.Z> [path/to/CHANGELOG.md]
//
// The notes are the lines after the "## [X.Y.Z]" heading, up to the next
// "## [" heading outside a fenced code block. The heading itself is left out
// (the release title shows the version). The link reference definitions at
// the bottom of the changelog are left out too, except those the notes use as
// reference-style links (such as [#1]), so they still resolve on the release
// page. Exits with 1 if the section is missing or empty.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK_DEFINITION = /^\[([^\]]+)\]:\s*\S/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Returns, for each line, whether it is a fence line or inside a fenced code block.
function fencedLines(lines) {
  let fence = null;
  return lines.map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null) {
      fence = marker ?? null;
      return fence !== null;
    }
    if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    return true;
  });
}

export function changelogSection(changelog, version) {
  const wanted = version.trim().replace(/^v/, '');
  if (!wanted) throw new Error('no version given');
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const heading = `## [${wanted}]`;

  const fenced = fencedLines(lines);
  const start = lines.findIndex((line, index) => !fenced[index] && line.startsWith(heading));
  if (start === -1) throw new Error(`CHANGELOG.md has no "${heading}" section`);
  let end = lines.findIndex((line, index) => index > start && !fenced[index] && line.startsWith('## ['));
  if (end === -1) end = lines.length;

  const body = [];
  const used = new Set();
  for (let index = start + 1; index < end; index++) {
    const line = lines[index];
    if (!fenced[index] && LINK_DEFINITION.test(line)) continue;
    body.push(line);
    if (fenced[index]) continue;
    for (const match of line.matchAll(/\[([^\]]+)\](?!\()/g)) used.add(match[1].toLowerCase());
  }
  while (body.length > 0 && body[0].trim() === '') body.shift();
  while (body.length > 0 && body.at(-1).trim() === '') body.pop();
  if (body.length === 0) throw new Error(`CHANGELOG.md section "${heading}" is empty`);

  const definitions = lines.filter((line, index) => {
    const match = fenced[index] ? null : LINK_DEFINITION.exec(line);
    return match !== null && used.has(match[1].toLowerCase());
  });
  const text = body.join('\n');
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
