import { readFileSync } from 'node:fs';

/** The synthetic TMDB v3 responses in test/tmdb-fixtures/3 (made by its generate.mjs). */
export const TMDB_FIXTURES = ['search', 'movie', 'tv', 'season'];

/** A fresh copy of a TMDB fixture. Fields the app does not copy hold canaries (see ./seerr-fixtures.mjs). */
export function tmdbFixture(name) {
  if (!TMDB_FIXTURES.includes(name)) throw new Error(`no TMDB fixture named ${name}`);
  return JSON.parse(readFileSync(new URL(`../tmdb-fixtures/3/${name}.json`, import.meta.url), 'utf8'));
}
