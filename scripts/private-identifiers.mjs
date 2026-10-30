import { readFileSync } from 'node:fs';

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
