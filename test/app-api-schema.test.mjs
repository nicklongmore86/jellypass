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
/** A TMDB ID past 2147483647 (2^31 - 1), which a card may carry. */
const HIGH_TMDB_ID = 2147483648;
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

/**
 * Every schema in the document: the components' and each operation's own (parameters, request bodies and answers given
 * inline rather than by `$ref`).
 */
function schemasOf(doc) {
  const bodies = (content) => Object.values(content ?? {}).map((media) => media.schema);
  return [
    ...Object.values(doc.components.schemas),
    ...Object.values(doc.components.responses).flatMap((response) => bodies(response.content)),
    ...Object.values(doc.paths).flatMap((item) => Object.values(item)).flatMap((operation) => [
      ...(operation.parameters ?? []).map((parameter) => parameter.schema),
      ...bodies(operation.requestBody?.content),
      ...Object.values(operation.responses).flatMap((response) => bodies(response.content)),
    ]),
  ];
}

/** The keywords the document's schemas use that the validator neither checks nor ignores as an annotation. */
function unknownKeywords(doc) {
  const used = new Set(schemasOf(doc).flatMap((schema) => [...keywordsOf(schema)]));
  return [...used].filter((keyword) => !VALIDATION_KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword));
}

/** Each error status and the codes its body may carry, as docs/app-design.md lists them ("Answers."). */
const ERROR_CODES = {
  400: ['invalid_request'],
  401: ['unauthorized'],
  404: ['not_found', 'household_not_found'],
  409: ['hidden_limit_reached'],
  429: ['too_many_requests'],
  502: ['unavailable'],
};
/** The error statuses every operation declares; 409 only hiding does. */
const COMMON_ERRORS = ['400', '401', '404', '429', '502'];
/** The operations that hide a title, the only ones that can answer 409. */
const HIDING = ['POST /hidden/movie/{tmdbId}', 'POST /hidden/tv/{tmdbId}'];

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
    assert.deepEqual(unknownKeywords(DOC), [], 'a keyword the validator would ignore');
    // Every object is closed and lists every property as required: the API sends every key (null or "" when empty).
    const objects = [];
    const visit = (schema) => {
      if (!schema || typeof schema !== 'object') return;
      if (schema.type === 'object') objects.push(schema);
      for (const nested of [...Object.values(schema.properties ?? {}), ...(schema.anyOf ?? []), schema.items]) visit(nested);
    };
    for (const schema of schemasOf(DOC)) visit(schema);
    for (const schema of objects) {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(schema.properties).sort());
    }
  });

  it('finds a keyword it does not understand wherever a schema is, inline ones included', () => {
    const withKeyword = (place) => {
      const doc = structuredClone(DOC);
      place(doc);
      return unknownKeywords(doc);
    };
    assert.deepEqual(withKeyword((doc) => { doc.paths['/movie/{tmdbId}'].get.parameters[0].schema.format = 'int64'; }), ['format']);
    assert.deepEqual(withKeyword((doc) => {
      doc.paths['/tv/{tmdbId}/get'].post.requestBody.content['application/json'].schema = { type: 'object', minProperties: 1 };
    }), ['minProperties']);
    assert.deepEqual(withKeyword((doc) => {
      doc.paths['/me'].get.responses['200'].content['application/json'].schema = { type: 'object', propertyNames: { pattern: '^a' } };
    }), ['propertyNames']);
  });

  it('gives each error status its own codes, and refuses a code with another status', () => {
    const operation = OPERATIONS.find((candidate) => candidate.key === 'GET /me');
    const codes = Object.values(ERROR_CODES).flat();
    assert.deepEqual(DOC.components.schemas.Error.properties.error.enum.slice().sort(), codes.slice().sort());
    for (const [status, allowed] of Object.entries(ERROR_CODES)) {
      for (const code of codes) {
        const errors = validate({ error: code }, responseSchema(status === '409' ? OPERATIONS.find((candidate) => candidate.key === HIDING[0]) : operation, status), DOC);
        assert.equal(errors.length === 0, allowed.includes(code), `${status} {"error":"${code}"}: ${errors.join('; ')}`);
      }
    }
    assert.notDeepEqual(validate({ error: 'unavailable' }, responseSchema(operation, 401), DOC), []);
    // Every operation declares every common error status, with the same answers; only hiding declares 409.
    const hiding = OPERATIONS.find((candidate) => candidate.key === HIDING[0]);
    for (const candidate of OPERATIONS) {
      for (const status of COMMON_ERRORS) assert.equal(responseSchema(candidate, status), responseSchema(operation, status), `${candidate.key} ${status}`);
      assert.equal('409' in candidate.operation.responses, HIDING.includes(candidate.key), `${candidate.key} 409`);
      if (HIDING.includes(candidate.key)) assert.equal(responseSchema(candidate, 409), responseSchema(hiding, 409), `${candidate.key} 409`);
    }
    // The design doc's list of fixed error bodies is the same pairing.
    const design = readFileSync(path.join(ROOT, 'docs', 'app-design.md'), 'utf8');
    const answers = design.slice(design.indexOf('- **Answers.**'), design.indexOf('\n- **', design.indexOf('- **Answers.**') + 1));
    const listed = {};
    for (const [, status, code] of answers.matchAll(/`([0-9]{3}) \{"error":"([a-z_]+)"\}`/g)) (listed[status] ??= []).push(code);
    assert.deepEqual(listed, Object.fromEntries(Object.entries(ERROR_CODES).map(([status, list]) => [status, list.slice()])));
  });

  it('bounds each TMDB ID as the server does: any positive safe integer in a card, at most 2147483647 in a path', () => {
    const card = { mediaType: 'movie', tmdbId: 1, title: 'T', year: null, overview: '', posterUrl: null, backdropUrl: null, rating: null, state: 'get_this', play: null, hidden: false };
    const cardSchema = { $ref: '#/components/schemas/Card' };
    for (const tmdbId of [1, 2147483647, 2147483648, Number.MAX_SAFE_INTEGER]) assert.deepEqual(validate({ ...card, tmdbId }, cardSchema, DOC), [], String(tmdbId));
    for (const tmdbId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) assert.notDeepEqual(validate({ ...card, tmdbId }, cardSchema, DOC), [], String(tmdbId));
    // A title's own page, season and request echo the path's ID, which the server takes only up to 2147483647.
    for (const name of ['Movie', 'Series', 'Season', 'Request', 'HiddenTitle']) {
      assert.equal(DOC.components.schemas[name].properties.tmdbId.maximum, 2147483647, name);
      assert.equal(DOC.components.schemas[name].properties.tmdbId.minimum, 1, name);
    }
  });

  it('allows exactly the parameters and request bodies the server accepts, at each bound', async (t) => {
    const app = await startApp(t, world());
    // A path or query value as the document reads it: a canonical integer as a number, anything else as a string.
    const valueOf = (raw) => (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw) ? Number(raw) : raw);
    const parameters = (operation, pathname, query) => {
      const names = [...operation.template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const values = pathname.slice(APP.length).match(operation.pattern.source.replace(/\[\^\/\]\+/g, '([^/]+)'))?.slice(1) ?? [];
      const given = Object.fromEntries(names.map((name, index) => [name, values[index]]));
      for (const [name, value] of query) given[name] = value;
      return (operation.operation.parameters ?? []).flatMap((parameter) => {
        if (!(parameter.name in given)) return parameter.required ? [`missing ${parameter.name}`] : [];
        const raw = given[parameter.name];
        return validate(parameter.schema.type === 'string' ? raw : valueOf(raw), parameter.schema, DOC, parameter.name);
      });
    };
    const id = (value) => `${APP}/movie/${value}`;
    const reads = [
      ...['1', '2147483647', '2147483648', '0', '-1', '1.5', '9999999999', 'abc'].map(id),
      ...['0', '999', '1000', '-1', '2.5'].map((n) => `${APP}/tv/${T_TV}/season/${n}`),
      ...['1', '500', '501', '0', '-1', '1.5'].map((page) => `${APP}/discover/trending?page=${page}`),
      `${APP}/search?q=${'a'.repeat(100)}`,
      `${APP}/search?q=${'a'.repeat(101)}`,
      `${APP}/search?q=a`,
      ...['1', '40', '500', '501', '0', 'x'].map((page) => `${APP}/hidden?page=${page}`),
    ];
    for (const target of reads) {
      const url = new URL(target, 'https://household.invalid');
      const errors = parameters(operationFor('GET', url.pathname), url.pathname, url.searchParams);
      const answer = await app.get(target);
      assert.equal(answer.status === 400, errors.length > 0, `GET ${target} is ${answer.status}; the document says ${errors.join('; ') || 'valid'}`);
    }
    const seasons = Array.from({ length: 101 }, (_, index) => index + 1);
    const bodies = [
      [`${APP}/movie/${T_MOVIE}/get`, {}],
      [`${APP}/movie/${T_MOVIE}/get`, { seasons: [1] }],
      [`${APP}/tv/${T_TV}/get`, { seasons: [999] }],
      [`${APP}/tv/${T_TV}/get`, { seasons: seasons.slice(0, 100) }],
      [`${APP}/tv/${T_TV}/get`, { seasons }],
      [`${APP}/tv/${T_TV}/get`, { seasons: [] }],
      [`${APP}/tv/${T_TV}/get`, { seasons: [0] }],
      [`${APP}/tv/${T_TV}/get`, { seasons: [1000] }],
      [`${APP}/tv/${T_TV}/get`, { seasons: [1.5] }],
      [`${APP}/tv/${T_TV}/get`, { seasons: [1, 1] }],
      [`${APP}/tv/${T_TV}/get`, { seasons: [1], extra: true }],
      [`${APP}/requests/${'A'.repeat(22)}/cancel`, {}],
      [`${APP}/requests/${'A'.repeat(22)}/cancel`, { seasons: [1] }],
      [`${APP}/requests/${'A'.repeat(21)}/cancel`, {}],
      [`${APP}/requests/${'A'.repeat(23)}/cancel`, {}],
      [`${APP}/requests/${'A'.repeat(21)}=/cancel`, {}],
      ...['1', '2147483647', '2147483648', '0', 'abc'].map((value) => [`${APP}/hidden/movie/${value}`, {}]),
      [`${APP}/hidden/tv/${T_TV}`, {}],
      [`${APP}/hidden/tv/${T_TV}`, { seasons: [1] }],
    ];
    const deletes = bodies.filter(([target]) => target.startsWith(`${APP}/hidden/`)).map(([target, body]) => ['DELETE', target, body]);
    for (const [method, target, body] of [...bodies.map(([target, body]) => ['POST', target, body]), ...deletes]) {
      const operation = operationFor(method, target);
      const errors = [
        ...parameters(operation, target, []),
        ...validate(body, operation.operation.requestBody.content['application/json'].schema, DOC),
      ];
      const answer = await app.post(target, body, { method });
      assert.equal(answer.status === 400, errors.length > 0, `${method} ${target} ${JSON.stringify(body).slice(0, 60)} is ${answer.status}; the document says ${errors.join('; ') || 'valid'}`);
    }
    await app.background.settled();
  });

  it('lists the same endpoints as the README\'s API table', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const rows = [...readme.matchAll(/^\| `(GET|POST|DELETE)` \| `\/jellypass\/app\/v1([^`?]+)(?:\?[^`]*)?` \|/gm)].map((row) => `${row[1]} ${row[2]}`);
    assert.ok(rows.length > 0, 'the table was found');
    assert.deepEqual(rows.sort(), OPERATIONS.map((operation) => operation.key).sort());
  });

  it('refuses an answer with a field it does not declare, or without one it requires', () => {
    const card = { mediaType: 'movie', tmdbId: 1, title: 'T', year: null, overview: '', posterUrl: null, backdropUrl: null, rating: null, state: 'get_this', play: null, hidden: false };
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
    const app = await startApp(t, world({ blocklist: [{ mediaType: 'movie', tmdbId: 900010 }], tmdbMovies: { 900010: { title: 'Synthetic Movie Ten', release_date: '2021-01-01' }, [HIGH_TMDB_ID]: { title: 'Synthetic Movie High', release_date: '2022-01-01' } } }), { stateFile: SEED });
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
      // A card's TMDB ID can be past 2147483647: the server keeps any positive safe integer TMDB gives.
      if (pathname === `${APP}/search?q=synthetic`) assert.ok(answer.json().results.some((card) => card.tmdbId === HIGH_TMDB_ID), 'the high ID is listed');
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
    // Cancelling one of them, and an ID the household does not list: the same answer.
    const [listedEntry] = (await app.get(`${APP}/requests`)).json().results;
    for (const id of [listedEntry.id, 'Z'.repeat(22)]) {
      const pathname = `${APP}/requests/${id}/cancel`;
      const answer = await app.post(pathname, undefined);
      assert.equal(answer.status, 202);
      check(covered, 'POST', pathname, answer);
    }
    await app.background.settled();
    check(covered, 'GET', `${APP}/requests`, await app.get(`${APP}/requests`));
    // Hiding and unhiding each kind, twice (the same answers), and the caller's own list, empty, full and past its end,
    // in an app of their own (the household's burst budget is spent below).
    const hiding = await startApp(t, world(), { stateFile: SEED });
    check(covered, 'GET', `${APP}/hidden`, await hiding.get(`${APP}/hidden`));
    for (const method of ['POST', 'POST', 'DELETE', 'DELETE', 'POST']) {
      for (const pathname of [`${APP}/hidden/movie/${T_MOVIE}`, `${APP}/hidden/tv/${T_TV}`]) {
        const answer = await hiding.post(pathname, undefined, { method });
        assert.equal(answer.status, 200, `${method} ${pathname}`);
        check(covered, method, pathname, answer);
      }
    }
    for (const pathname of [`${APP}/hidden`, `${APP}/hidden?page=2`, `${APP}/search?q=synthetic`, `${APP}/movie/${T_MOVIE}`, `${APP}/tv/${T_TV}`, `${APP}/discover/trending`]) {
      const answer = await hiding.get(pathname);
      check(covered, 'GET', pathname, answer);
      if (pathname === `${APP}/hidden`) assert.equal(answer.json().results.length, 2);
    }
    assert.deepEqual([...states].sort(), DOC.components.schemas.HouseholdState.enum.slice().sort(), 'every state was checked');
    // Another household and member: the same document.
    check(covered, 'GET', `${APP}/me`, await app.get(`${APP}/me`, { host: HOST_B, user: BOB }));

    // The fixed errors.
    const errors = [
      ['GET', `${APP}/movie/abc`, 400],
      ['GET', `${APP}/search?q=`, 400],
      ['POST', `${APP}/tv/${T_TV}/get`, 400, { seasons: [] }],
      ['POST', `${APP}/requests/not-an-id/cancel`, 400, {}],
      ['GET', `${APP}/me`, 401, undefined, { user: null }],
      ['GET', `${APP}/me`, 401, undefined, { host: HOST_B, user: ALICE }],
      ['GET', `${APP}/movie/123456`, 404],
      ['GET', `${APP}/discover/nonsense`, 404],
      // A household address no household has: before any token is checked, with or without one.
      ['GET', `${APP}/me`, 404, undefined, { host: 'jelly-missing.example.test' }],
      ['GET', `${APP}/me`, 404, undefined, { host: 'jelly-missing.example.test', user: null }],
      ['POST', `${APP}/movie/${T_MOVIE}/get`, 404, {}, { host: 'jelly-missing.example.test' }],
    ];
    for (const [method, pathname, status, body, options] of errors) {
      const answer = method === 'GET' ? await app.get(pathname, options) : await app.post(pathname, body, { ...options, method });
      assert.equal(answer.status, status, `${method} ${pathname}`);
      // An unknown path still answers in the document's one error shape.
      if (status === 404 && pathname.endsWith('nonsense')) {
        assert.deepEqual(validate(answer.json(), { $ref: '#/components/schemas/NotFoundError' }, DOC), []);
        continue;
      }
      if (options?.host === 'jelly-missing.example.test') assert.deepEqual(answer.json(), { error: 'household_not_found' });
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
    for (const [method, pathname] of [['POST', `${APP}/hidden/movie/0`], ['DELETE', `${APP}/hidden/tv/x`], ['GET', `${APP}/hidden?page=0`]]) {
      const answer = method === 'GET' ? await hiding.get(pathname) : await hiding.post(pathname, {}, { method });
      assert.equal(answer.status, 400, `${method} ${pathname}`);
      check(covered, method, pathname, answer);
    }
    // A title at the limit: 2000 hidden by the store, then one more through the API.
    await Promise.all(Array.from({ length: 2000 }, (_, index) =>
      hiding.store.hideTitle({ householdId: 'grove', userId: ALICE, mediaType: 'movie', tmdbId: index + 1, at: '2026-10-30T00:00:00.000Z' })));
    const full = await hiding.post(`${APP}/hidden/tv/2147483647`, undefined);
    assert.equal(full.status, 409);
    check(covered, 'POST', `${APP}/hidden/tv/2147483647`, full);
    for (const operation of OPERATIONS) {
      const success = Object.keys(operation.operation.responses).find((status) => status.startsWith('2'));
      assert.ok(covered.has(`${operation.key} ${success}`), `${operation.key} ${success} was checked`);
    }
    for (const status of [400, 401, 404, 409, 429, 502]) assert.ok([...covered].some((entry) => entry.endsWith(` ${status}`)), `a ${status} was checked`);
  });
});
