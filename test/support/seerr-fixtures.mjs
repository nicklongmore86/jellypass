import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The recorded-shape Seerr 3.5.1 responses in test/seerr-fixtures/3.5.1 (made by its generate.mjs). */
export const SEERR_FIXTURES = ['search', 'movie', 'tv', 'season', 'requests', 'quota', 'watchlist'];

/** A fresh copy of a Seerr 3.5.1 fixture. */
export function seerrFixture(name) {
  if (!SEERR_FIXTURES.includes(name)) throw new Error(`no Seerr fixture named ${name}`);
  return JSON.parse(readFileSync(new URL(`../seerr-fixtures/3.5.1/${name}.json`, import.meta.url), 'utf8'));
}

/**
 * Canaries: the values planted in every user-ish field of the fixtures (names, emails, avatars, Jellyfin user and
 * media IDs, Seerr database IDs, request and media timestamps, issue text, paging totals). None may ever reach a
 * household response, in any form:
 *
 * - strings containing "canary" (any case);
 * - GUIDs starting c0ffee00c0ffee00 (Jellyfin user and item IDs), dashed or not;
 * - numbers from 7300001 to 7399999 (Seerr IDs, counts and totals);
 * - timestamps in 2001 (request, media, issue and user dates).
 */
const CANARY_PATTERNS = [
  ['canary text', /canary/i],
  ['canary GUID', /c0ffee00-?c0ff-?ee00/i],
  ['canary number', /(?<![0-9])73[0-9]{5}(?![0-9])/],
  ['canary timestamp', /2001-[0-9]{2}-[0-9]{2}T/],
];

/** The canaries found in `serialized`, as `kind: match` strings. */
export function findCanaries(serialized) {
  if (typeof serialized !== 'string') throw new TypeError('findCanaries takes a serialized response body');
  return CANARY_PATTERNS.flatMap(([kind, pattern]) =>
    [...serialized.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map((match) => `${kind}: ${match[0]}`));
}

/**
 * Fails if a serialized response (body text, header values, error message: anything a household could see) holds a
 * canary. Pass the exact bytes sent, not a parsed object.
 */
export function assertNoCanaries(serialized, message = 'response leaks Seerr data planted as a canary') {
  const found = findCanaries(serialized);
  assert.deepEqual(found, [], message);
}
