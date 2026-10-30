import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadPrivateDenylist() {
  const configured = process.env.JELLYPASS_PRIVATE_DENYLIST;
  try {
    const terms = readFileSync(configured || new URL('../.private-denylist.txt', import.meta.url), 'utf8')
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
      .map((line) => line.toLowerCase());
    if (!terms.length) throw new Error('Private deny-list must contain at least one entry');
    return terms;
  } catch (error) {
    if (!configured && error.code === 'ENOENT') return undefined;
    throw new Error('Unable to load private deny-list');
  }
}

export function privateMatchCount(text, terms) {
  return text.split(/\r?\n/).filter((line) => terms.some((term) => line.toLowerCase().includes(term))).length;
}

// Return locations only: callers must never include source lines or terms in diagnostics.
export function privateMatchLocations(root, files, terms) {
  const locations = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = readFileSync(join(root, file));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (bytes.includes(0)) continue;
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      continue; // Non-UTF-8 binary content.
    }
    text.split(/\r?\n/).forEach((line, index) => {
      if (terms.some((term) => line.toLowerCase().includes(term))) locations.push(`${file}:${index + 1}`);
    });
  }
  return locations;
}
