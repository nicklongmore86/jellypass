// The decoders against every constraint docs/app-api/v1.openapi.json states for an answer. For each answer's schema
// this walks every field the fixtures reach and, for each keyword on it (type, enum, const, required, minimum,
// maximum, minLength, maxLength, pattern, minItems, maxItems, uniqueItems, ...), makes values just inside and just
// outside the limit. Decoding must accept exactly what the schema validator accepts, except where the contract says a
// client is lenient (LENIENT below). A keyword the walker does not know fails the test, and so does a constrained
// field no fixture reaches, so a limit added to the schema without the decoder (or this walker) knowing it fails here.
import { decodeAccepted, decodeMe, decodeMovie, decodePage, DecodeError, decodeRequests, decodeSeason, decodeSeries, decodeSources } from '../src/api/decode';
import { DOC, OPERATIONS, ORIGIN, fixture, type Json } from './support/app-api';
import { ANNOTATIONS, resolve, validate } from './support/json-schema';

type Path = Array<string | number>;

interface Case {
  /** Where the constraint is, as `Component.field` (an inline field keeps its parent's name): the LENIENT key. */
  where: string;
  keyword: string;
  path: Path;
  /** The value to put at `path`; absent means remove the field. */
  value?: unknown;
  remove?: boolean;
}

const context = { origin: ORIGIN };

/** Each success answer's decoder, by fixture. */
const DECODERS: Record<string, (value: unknown) => unknown> = {
  me: decodeMe,
  page: (value) => decodePage(value, context),
  'page-last': (value) => decodePage(value, context),
  sources: decodeSources,
  movie: (value) => decodeMovie(value, context),
  series: (value) => decodeSeries(value, context),
  season: decodeSeason,
  requests: decodeRequests,
  accepted: decodeAccepted,
};

/**
 * Where the contract (docs/app-design.md, "Native clients (contract)", and the schema's own descriptions) has a client
 * accept an answer the schema refuses, and what the decoder makes of it. `*` matches any place.
 */
const LENIENT: Record<string, (decoded: unknown, path: Path) => void> = {
  // "ignores fields it does not know, and never rejects an answer for having one"
  '* additionalProperties': (decoded, path) => expect(Object.hasOwn(at(decoded, path.slice(0, -1)) as Json, path.at(-1) as string)).toBe(false),
  // "treats an unknown state as unavailable, and an unknown coarse status ... as requested"
  'HouseholdState enum': (decoded, path) => expect(at(decoded, path)).toBe('unavailable'),
  'CoarseStatus enum': (decoded, path) => expect(at(decoded, path)).toBe('requested'),
  // "a missing apiVersion is revision 0"
  'Me required apiVersion': (decoded) => expect((decoded as Json).apiVersion).toBe(0),
  // Request fields added in apiVersion 2: a server before it sends neither (and has no cancel).
  'Request required cancellable': (decoded, path) => expect(at(decoded, path)).toBe(false),
  'Request required requestedOn': (decoded, path) => expect(at(decoded, path)).toBeNull(),
  // Play.url: "a client ignores anything else"; the URL is built from itemId, so a bad itemId is ignored the same way.
  'Play.itemId pattern': (decoded, path) => expect(at(decoded, path.slice(0, -1))).toBeNull(),
  'Play.url pattern': (decoded, path) => expect(at(decoded, path.slice(0, -1))).toBeNull(),
  // An image URL off its field's pattern is that one image dropped, as the PWA drops it: never the whole answer.
  ...Object.fromEntries(
    ['Card.posterUrl', 'Card.backdropUrl', 'Movie.posterUrl', 'Movie.backdropUrl', 'Series.posterUrl', 'Series.backdropUrl', 'Source.logoUrl', 'Network.logoUrl'].map(
      (where) => [`${where} pattern`, (decoded: unknown, path: Path) => expect(at(decoded, path)).toBeNull()],
    ),
  ),
};

const WALKED = new Set([
  '$ref', 'type', 'enum', 'const', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
]);

/** One value of each JSON type, for the type checks. */
const OF_TYPE: Record<string, unknown> = { string: 'x', integer: 1, number: 1.5, boolean: true, null: null, array: [], object: {} };

function at(value: unknown, path: Path): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown> | null | undefined)?.[key], value);
}

function withChange(base: unknown, change: Case): unknown {
  if (change.path.length === 0) return structuredClone(change.value);
  const copy = structuredClone(base);
  const parent = at(copy, change.path.slice(0, -1)) as Record<string | number, unknown>;
  const key = change.path.at(-1)!;
  if (change.remove) delete parent[key];
  else parent[key] = structuredClone(change.value);
  return copy;
}

/**
 * The cases for `schema`, which applies at each of `places` in the fixture (with the value there). Every
 * `where keyword` the schema has is added to `stated`, reached by a fixture or not.
 */
function walk(schema: Json, places: Array<{ path: Path; value: unknown }>, where: string, cases: Case[], stated: Set<string>): void {
  const unknown = Object.keys(schema).filter((keyword) => !WALKED.has(keyword) && !ANNOTATIONS.has(keyword));
  if (unknown.length) throw new Error(`${where}: no inside/outside values for ${unknown.join(', ')}`);
  const add = (keyword: string, made: Array<Omit<Case, 'where' | 'keyword'>>): void => {
    stated.add(`${where} ${keyword}`);
    for (const change of made) cases.push({ where, keyword, ...change });
  };
  const first = places[0];

  if (typeof schema.$ref === 'string') {
    walk(resolve(schema.$ref, DOC) as Json, places, schema.$ref.split('/').at(-1)!, cases, stated);
  }
  if (Array.isArray(schema.anyOf)) for (const option of schema.anyOf as Json[]) walk(option, places, where, cases, stated);

  if (schema.type !== undefined) {
    const allowed = [schema.type].flat() as string[];
    const others = Object.keys(OF_TYPE).filter((type) => !allowed.includes(type) && !(type === 'integer' && allowed.includes('number')));
    add('type', first ? [...others.map((type) => ({ path: first.path, value: OF_TYPE[type] })), ...(allowed.includes('null') ? [{ path: first.path, value: null }] : [])] : []);
  }
  if (Array.isArray(schema.enum)) add('enum', first ? [...schema.enum.map((value) => ({ path: first.path, value })), { path: first.path, value: 'zz-unknown' }] : []);
  if ('const' in schema) add('const', first ? [{ path: first.path, value: schema.const }, { path: first.path, value: `${String(schema.const)}-other` }] : []);

  const numeric = [schema.type].flat().includes('integer') ? 1 : 0.5;
  if (typeof schema.minimum === 'number') {
    const min = schema.minimum;
    add('minimum', first ? [...new Set([min, min - numeric, min - 1])].map((value) => ({ path: first.path, value })) : []);
  }
  if (typeof schema.maximum === 'number') {
    const max = schema.maximum;
    add('maximum', first ? [...new Set([max, max + numeric, max + 1])].map((value) => ({ path: first.path, value })) : []);
  }
  if (typeof schema.minLength === 'number' || typeof schema.maxLength === 'number') {
    if (typeof schema.pattern === 'string') throw new Error(`${where}: no inside/outside values for a length and a pattern together`);
  }
  for (const keyword of ['minLength', 'maxLength'] as const) {
    if (typeof schema[keyword] !== 'number') continue;
    const limit = schema[keyword];
    // Code points, not UTF-16 units: an astral character is one.
    const lengths = [limit - 1, limit, limit + 1].filter((length) => length >= 0);
    add(keyword, first ? lengths.flatMap((length) => [{ path: first.path, value: 'x'.repeat(length) }, { path: first.path, value: '\u{1F3AC}'.repeat(length) }]) : []);
  }
  if (typeof schema.pattern === 'string') {
    const example = places.find((place) => typeof place.value === 'string');
    if (example) {
      const text = example.value as string;
      const values = [text, `${text}x`, `x${text}`, ` ${text}`, `${text}\n`, text.slice(1), text.slice(0, -1), text.toUpperCase(), ''];
      add('pattern', values.map((value) => ({ path: example.path, value })));
    } else add('pattern', []);
  }

  if (schema.type === 'object' || schema.properties) {
    const objects = places.filter((place) => typeof place.value === 'object' && place.value !== null && !Array.isArray(place.value));
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    for (const key of (schema.required as string[] | undefined) ?? []) add(`required ${key}`, objects[0] ? [{ path: [...objects[0].path, key], remove: true }] : []);
    if (schema.additionalProperties === false) add('additionalProperties', objects[0] ? [{ path: [...objects[0].path, 'futureField'], value: 1 }] : []);
    for (const [key, nested] of Object.entries(properties)) {
      const children = objects.filter((place) => Object.hasOwn(place.value as Json, key)).map((place) => ({ path: [...place.path, key], value: (place.value as Json)[key] }));
      walk(nested, children, `${where}.${key}`, cases, stated);
    }
  }

  if (schema.type === 'array' || schema.items) {
    const arrays = places.filter((place) => Array.isArray(place.value));
    const items = arrays.flatMap((place) => (place.value as unknown[]).map((value, index) => ({ path: [...place.path, index], value })));
    if (schema.items) walk(schema.items as Json, items, `${where}[]`, cases, stated);
    const item = items[0]?.value;
    const target = (items[0] ? arrays.find((place) => (place.value as unknown[]).length > 0) : arrays[0])?.path;
    const sized = (length: number) => ({ path: target!, value: Array.from({ length }, () => item) });
    for (const keyword of ['minItems', 'maxItems'] as const) {
      if (typeof schema[keyword] !== 'number') continue;
      const limit = schema[keyword];
      add(keyword, target && items[0] ? [limit - 1, limit, limit + 1].filter((length) => length >= 0).map(sized) : []);
    }
    if (schema.uniqueItems) add('uniqueItems', target && items[0] ? [sized(2), { path: target, value: [item] }] : []);
  }
}

/** Each distinct success answer schema, with its fixture. */
const answers = new Map<string, { schema: Json; fixtureName: string }>();
for (const [key, op] of Object.entries(OPERATIONS)) {
  const [method, template] = key.split(' ') as [string, string];
  const response = DOC.paths[template]![method.toLowerCase()]!.responses[String(op.status)]!;
  const schema = (response.content as Record<string, { schema: Json }>)['application/json']!.schema;
  answers.set(`${JSON.stringify(schema)} ${op.fixture}`, { schema, fixtureName: op.fixture });
}

const cases: Array<Case & { fixtureName: string; schema: Json }> = [];
const stated = new Set<string>();
for (const { schema, fixtureName } of answers.values()) {
  const found: Case[] = [];
  walk(schema, [{ path: [], value: fixture(fixtureName) }], '$', found, stated);
  cases.push(...found.map((change) => ({ ...change, fixtureName, schema })));
}

function lenientFor(change: Case): ((decoded: unknown, path: Path) => void) | undefined {
  return LENIENT[`${change.where} ${change.keyword}`] ?? LENIENT[`* ${change.keyword}`];
}

describe('decoding against every constraint of docs/app-api/v1.openapi.json', () => {
  it('has a decoder for every success answer', () => {
    expect(Object.keys(DECODERS).sort()).toEqual([...new Set(Object.values(OPERATIONS).map((op) => op.fixture))].sort());
  });

  it('reaches every constrained field with a fixture, so every constraint is tried', () => {
    const tried = new Set(cases.map((change) => `${change.where} ${change.keyword}`));
    expect([...stated].filter((constraint) => !tried.has(constraint))).toEqual([]);
  });

  it('has no lenient case the contract does not name', () => {
    const named = new Set(cases.map((change) => `${change.where} ${change.keyword}`));
    expect(Object.keys(LENIENT).filter((key) => !key.startsWith('* ') && !named.has(key))).toEqual([]);
  });

  it.each(cases.map((change) => [`${change.fixtureName} ${change.where} ${change.keyword} ${change.remove ? '(removed)' : JSON.stringify(change.value)?.slice(0, 60)}`, change] as const))(
    '%s',
    (_name, change) => {
      const body = withChange(fixture(change.fixtureName), change);
      const valid = validate(body, change.schema, DOC).length === 0;
      let decoded: unknown;
      let refused = false;
      try {
        decoded = DECODERS[change.fixtureName]!(body);
      } catch (error) {
        if (!(error instanceof DecodeError)) throw error;
        refused = true;
      }
      const lenient = valid ? undefined : lenientFor(change);
      if (lenient) {
        expect({ refused }).toEqual({ refused: false });
        lenient(decoded, change.path);
        return;
      }
      expect({ refused }).toEqual({ refused: !valid });
      // What is accepted is kept as sent.
      if (!valid || change.remove) return;
      expect(at(decoded, change.path)).toEqual(change.value);
    },
  );
});
