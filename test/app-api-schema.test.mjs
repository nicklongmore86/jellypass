// The app API's machine-readable contract (docs/app-api/v1.openapi.json): every answer the API gives in these tests,
// successful or not, from every endpoint, is checked against it. Its schemas are closed, so a field the server sends
// that the document does not declare fails here, as does a declared field the server leaves out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { APP_API_VERSION } from '../dist/app-api.js';
import { ALICE, BOB, HOST_B, OWN_MOVIE, T_MOVIE, T_TV, startApp, world } from './support/household-app.mjs';
import { ANNOTATIONS, VALIDATION_KEYWORDS, keywordsOf, validate } from './support/json-schema.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const DOC = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'app-api', 'v1.openapi.json'), 'utf8'));
const APP = '/jellypass/app/v1';
const SEED = { version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], appIdKey: 'cd'.repeat(32) };

/** Every operation in the document, as `METHOD /path`, with a pattern for the paths it serves. */
const OPERATIONS = Object.entries(DOC.paths).flatMap(([template, item]) => Object.keys(item).map((method) => ({
  key: `${method.toUpperCase()} ${template}`,
  method: method.toUpperCase(),
  template,
  operation: item[method],
  pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`),
  // Fixed segments outrank parameters, as in OpenAPI: `/discover/sources` is not `/discover/{list}`.
  fixed: template.split('/').filter((segment) => segment && !segment.startsWith('{')).length,
})));

/** The operation serving `method pathname` (no query), the most specific one when several match. */
function operationFor(method, pathname) {
  const path = pathname.replace(/\?.*$/, '').slice(APP.length);
  const matching = OPERATIONS.filter((candidate) => candidate.method === method && candidate.pattern.test(path)).sort((a, b) => b.fixed - a.fixed);
  assert.ok(matching.length > 0, `${method} ${pathname} is in the document`);
  return matching[0];
}

/** The schema the document gives for this operation's answer with this status. */
function responseSchema(operation, status) {
  let response = operation.operation.responses[String(status)];
  assert.ok(response, `${operation.key} declares ${status}`);
  if (response.$ref) response = response.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node[key], DOC);
  return response.content['application/json'].schema;
}

/** Checks one answer against the document, and notes which operation and status it covered. */
function check(covered, method, pathname, answer) {
  const operation = operationFor(method, pathname);
  const errors = validate(answer.json(), responseSchema(operation, answer.status), DOC);
  assert.deepEqual(errors, [], `${method} ${pathname} ${answer.status}: ${answer.text.slice(0, 300)}`);
  covered.add(`${operation.key} ${answer.status}`);
}

describe('household app API: the OpenAPI document', { timeout: 60_000 }, () => {
  it('is OpenAPI 3.1 for /jellypass/app/v1, at the version /me reports, using only keywords the test understands', () => {
    assert.equal(DOC.openapi, '3.1.0');
    assert.equal(DOC.info.version, String(APP_API_VERSION));
    assert.equal(DOC.servers[0].url, `https://{householdHost}${APP}`);
    const schemas = [
      ...Object.values(DOC.components.schemas),
      ...Object.values(DOC.components.responses).map((response) => response.content['application/json'].schema),
    ];
    const used = new Set(schemas.flatMap((schema) => [...keywordsOf(schema)]));
    const unknown = [...used].filter((keyword) => !VALIDATION_KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword));
    assert.deepEqual(unknown, [], 'a keyword the validator would ignore');
    // Every object is closed and lists every property as required: the API sends every key (null or "" when empty).
    const objects = [];
    const visit = (schema) => {
      if (!schema || typeof schema !== 'object') return;
      if (schema.type === 'object') objects.push(schema);
      for (const nested of [...Object.values(schema.properties ?? {}), ...(schema.anyOf ?? []), schema.items]) visit(nested);
    };
    for (const schema of Object.values(DOC.components.schemas)) visit(schema);
    for (const schema of objects) {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(schema.properties).sort());
    }
  });

  it('lists the same endpoints as the README\'s API table', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const rows = [...readme.matchAll(/^\| `(GET|POST)` \| `\/jellypass\/app\/v1([^`?]+)(?:\?[^`]*)?` \|/gm)].map((row) => `${row[1]} ${row[2]}`);
    assert.ok(rows.length > 0, 'the table was found');
    assert.deepEqual(rows.sort(), OPERATIONS.map((operation) => operation.key).sort());
  });

  it('refuses an answer with a field it does not declare, or without one it requires', () => {
    const card = { mediaType: 'movie', tmdbId: 1, title: 'T', year: null, overview: '', posterUrl: null, backdropUrl: null, rating: null, state: 'get_this', play: null };
    const page = { $ref: '#/components/schemas/Page' };
    assert.deepEqual(validate({ page: 1, nextPage: null, results: [card] }, page, DOC), []);
    assert.deepEqual(validate({ page: 1, nextPage: null, results: [{ ...card, extra: 1 }] }, page, DOC), ['$.results[0]: unexpected extra']);
    const { play: _, ...withoutPlay } = card;
    assert.deepEqual(validate({ page: 1, nextPage: null, results: [withoutPlay] }, page, DOC), ['$.results[0]: missing play']);
    assert.notDeepEqual(validate({ ...card, state: 'held_elsewhere' }, { $ref: '#/components/schemas/Card' }, DOC), []);
    assert.notDeepEqual(validate({ name: 'A', household: 'B' }, { $ref: '#/components/schemas/Me' }, DOC), []);
  });

  it('describes every answer of every endpoint, in every state, and every error', async (t) => {
    const covered = new Set();
    // Household A: a title in its library, one blocklisted, one it can ask for; then asks for a movie and a series.
    const app = await startApp(t, world({ blocklist: [{ mediaType: 'movie', tmdbId: 900010 }], tmdbMovies: { 900010: { title: 'Synthetic Movie Ten', release_date: '2021-01-01' } } }), { stateFile: SEED });
    const reads = [
      `${APP}/me`,
      `${APP}/search?q=synthetic`,
      `${APP}/search?q=synthetic&page=2`,
      ...['trending', 'trending-movies', 'trending-tv', 'popular-movies', 'popular-tv', 'new-movies', 'upcoming', 'upcoming-tv', 'top-movies', 'top-tv'].map((list) => `${APP}/discover/${list}`),
      `${APP}/discover/upcoming?page=3`,
      `${APP}/discover/sources`,
      `${APP}/discover/network/213`,
      `${APP}/discover/network/213/films`,
      `${APP}/discover/network/213/all`,
      `${APP}/discover/studio/41077?page=2`,
      `${APP}/movie/${T_MOVIE}`,
      `${APP}/movie/${OWN_MOVIE}`,
      `${APP}/movie/900010`,
      `${APP}/tv/${T_TV}`,
      `${APP}/tv/${T_TV}/season/1`,
      `${APP}/tv/${T_TV}/season/2`,
      `${APP}/requests`,
    ];
    const states = new Set();
    const noteStates = (body) => {
      for (const card of [body, ...(body.results ?? []), ...(body.seasons ?? [])]) if (typeof card?.state === 'string') states.add(card.state);
    };
    for (const pathname of reads) {
      const answer = await app.get(pathname);
      assert.equal(answer.status, 200, pathname);
      check(covered, 'GET', pathname, answer);
      noteStates(answer.json());
    }
    for (const [pathname, body] of [[`${APP}/movie/${T_MOVIE}/get`, {}], [`${APP}/movie/${T_MOVIE}/get`, undefined], [`${APP}/tv/${T_TV}/get`, { seasons: [2, 1] }]]) {
      const answer = await app.post(pathname, body);
      assert.equal(answer.status, 202);
      check(covered, 'POST', pathname, answer);
    }
    await app.background.settled();
    // Now with the household's requests: `requested` titles and a list with a movie and a series in it.
    for (const pathname of [`${APP}/requests`, `${APP}/movie/${T_MOVIE}`, `${APP}/tv/${T_TV}`, `${APP}/tv/${T_TV}/season/1`, `${APP}/search?q=synthetic`]) {
      const answer = await app.get(pathname);
      check(covered, 'GET', pathname, answer);
      noteStates(answer.json());
      if (pathname.endsWith('/requests')) assert.deepEqual(answer.json().results.map((entry) => entry.mediaType).sort(), ['movie', 'tv']);
    }
    assert.deepEqual([...states].sort(), DOC.components.schemas.HouseholdState.enum.slice().sort(), 'every state was checked');
    // Another household and member: the same document.
    check(covered, 'GET', `${APP}/me`, await app.get(`${APP}/me`, { host: HOST_B, user: BOB }));

    // The fixed errors.
    const errors = [
      ['GET', `${APP}/movie/abc`, 400],
      ['GET', `${APP}/search?q=`, 400],
      ['POST', `${APP}/tv/${T_TV}/get`, 400, { seasons: [] }],
      ['GET', `${APP}/me`, 401, undefined, { user: null }],
      ['GET', `${APP}/me`, 401, undefined, { host: HOST_B, user: ALICE }],
      ['GET', `${APP}/movie/123456`, 404],
      ['GET', `${APP}/discover/nonsense`, 404],
    ];
    for (const [method, pathname, status, body, options] of errors) {
      const answer = method === 'POST' ? await app.post(pathname, body, options) : await app.get(pathname, options);
      assert.equal(answer.status, status, `${method} ${pathname}`);
      // An unknown path still answers in the document's one error shape.
      if (status === 404 && pathname.endsWith('nonsense')) {
        assert.deepEqual(validate(answer.json(), { $ref: '#/components/schemas/Error' }, DOC), []);
        continue;
      }
      check(covered, method, pathname, answer);
    }
    const failing = await startApp(t, world({ failCatalogue: 500 }));
    check(covered, 'GET', `${APP}/movie/${T_MOVIE}`, await failing.get(`${APP}/movie/${T_MOVIE}`));
    // The household's burst budget (60 in 10 seconds), then one more.
    let limited;
    for (let index = 0; index < 61; index += 1) limited = await failing.get(`${APP}/me`);
    assert.equal(limited.status, 429);
    check(covered, 'GET', `${APP}/me`, limited);

    // Every operation's success was checked, and every error status at least once somewhere.
    for (const operation of OPERATIONS) {
      const success = operation.method === 'POST' ? 202 : 200;
      assert.ok(covered.has(`${operation.key} ${success}`), `${operation.key} ${success} was checked`);
    }
    for (const status of [400, 401, 404, 429, 502]) assert.ok([...covered].some((entry) => entry.endsWith(` ${status}`)), `a ${status} was checked`);
  });
});
