// The client against the server's own contract, docs/app-api/v1.openapi.json, read from the repo rather than copied:
// the types and decoders are written by hand from it, so these fail when the two drift apart. Every operation in the
// document has a client call, every documented answer (the fixtures, checked against the document) decodes to
// exactly the fields the document lists, every error status maps to its kind, and the enums match.
import {
  COARSE_STATUSES,
  DISCOVER_LISTS,
  ERROR_CODES,
  HOUSEHOLD_STATES,
  MEDIA_TYPES,
  type ApiError,
  type ApiErrorKind,
} from '../src/api';
import { decodeAccepted } from '../src/api/decode';
import { BUDGET, DOC, OPERATIONS, answer, clientWith, fixture, sent, type Json } from './support/app-api';
import { ANNOTATIONS, VALIDATION_KEYWORDS, keywordsOf, resolve, validate } from './support/json-schema';

const schemas = DOC.components.schemas;

/** Every operation in the document, as `METHOD /path`. */
const documented = Object.entries(DOC.paths).flatMap(([template, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${template}`));

function operation(key: string): Json & { responses: Record<string, Json>; parameters?: Json[] } {
  const [method, template] = key.split(' ') as [string, string];
  return DOC.paths[template]![method.toLowerCase()]!;
}

/** The schema the document gives for `key`'s answer with `status`. */
function responseSchema(key: string, status: number): Json {
  let response = operation(key).responses[String(status)];
  if (!response) throw new Error(`${key} declares no ${status}`);
  if (typeof response.$ref === 'string') response = resolve(response.$ref, DOC) as Json;
  return (response.content as Record<string, { schema: Json }>)['application/json']!.schema;
}

/** The enum of a component schema. */
function enumOf(name: string): unknown[] {
  return schemas[name]!.enum as unknown[];
}

/**
 * Checks that `value` has exactly the keys `schema` declares, at every level: a field in the document the decoder
 * drops, or one the decoder makes up, fails. `$ref`, `anyOf` (the nullable Play) and arrays are followed.
 */
function expectSameShape(value: unknown, schema: Json, path = '$'): void {
  if (typeof schema.$ref === 'string') return expectSameShape(value, resolve(schema.$ref, DOC) as Json, path);
  if (value === null) return;
  if (Array.isArray(schema.anyOf)) {
    const options = (schema.anyOf as Json[]).map((option) => (typeof option.$ref === 'string' ? (resolve(option.$ref, DOC) as Json) : option));
    return expectSameShape(value, options.find((option) => option.type === 'object') ?? options[0]!, path);
  }
  if (schema.type === 'object') {
    const properties = schema.properties as Record<string, Json>;
    expect({ path, keys: Object.keys(value as Json).sort() }).toEqual({ path, keys: Object.keys(properties).sort() });
    for (const [key, nested] of Object.entries(properties)) expectSameShape((value as Json)[key], nested, `${path}.${key}`);
  }
  if (schema.type === 'array' && Array.isArray(value)) value.forEach((item, index) => expectSameShape(item, schema.items as Json, `${path}[${index}]`));
}

describe('the client against docs/app-api/v1.openapi.json', () => {
  it('reads an OpenAPI 3.1 document for v1 that uses only keywords the validator understands', () => {
    expect(DOC.openapi).toBe('3.1.0');
    expect((DOC.servers as Json[])[0]!.url).toBe('https://{householdHost}/jellypass/app/v1');
    const used = new Set<string>();
    for (const schema of Object.values(schemas)) keywordsOf(schema, used);
    for (const key of documented) {
      for (const parameter of operation(key).parameters ?? []) keywordsOf(parameter.schema, used);
      for (const status of Object.keys(operation(key).responses)) keywordsOf(responseSchema(key, Number(status)), used);
    }
    expect([...used].filter((keyword) => !VALIDATION_KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword))).toEqual([]);
  });

  it('has a client call for every operation in the document, and none the document lacks', () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual(documented.slice().sort());
  });

  it('has the same enums as the document', () => {
    expect([...HOUSEHOLD_STATES].sort()).toEqual(enumOf('HouseholdState').slice().sort());
    expect([...COARSE_STATUSES].sort()).toEqual(enumOf('CoarseStatus').slice().sort());
    expect([...MEDIA_TYPES].sort()).toEqual(enumOf('MediaType').slice().sort());
    expect([...ERROR_CODES].sort()).toEqual((((schemas.Error!.properties as Json).error as Json).enum as string[]).slice().sort());
    const list = operation('GET /discover/{list}').parameters!.find((parameter) => parameter.name === 'list')!;
    expect([...DISCOVER_LISTS]).toEqual((list.schema as Json).enum);
  });

  describe.each(Object.entries(OPERATIONS))('%s', (key, op) => {
    it('sends exactly the documented path, once', async () => {
      const { api, calls } = clientWith(() => answer(op.status, fixture(op.fixture)));
      await op.call(api);
      expect(calls.map(sent)).toEqual([op.sends]);
      const [, template] = key.split(' ') as [string, string];
      expect(op.sends.split(' ')[1]!.replace(/\?.*$/, '')).toMatch(new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`));
    });

    it('decodes its documented answer to exactly the fields the document lists', async () => {
      const body = fixture(op.fixture);
      expect(validate(body, responseSchema(key, op.status), DOC)).toEqual([]);
      const { api } = clientWith(() => answer(op.status, body));
      const decoded = await op.call(api);
      if (op.status === 202) {
        // "Get this" resolves with nothing: the client never reads the answer to tell what happened.
        expect(decoded).toBeUndefined();
        expect(decodeAccepted(body)).toEqual(body);
        return;
      }
      expect(decoded).toEqual(body);
      expectSameShape(decoded, responseSchema(key, op.status));
    });

    const errors: Array<[number, string, ApiErrorKind, boolean]> = [
      [400, 'invalid_request', 'invalid_request', false],
      [401, 'unauthorized', 'unauthorized', false],
      [404, 'not_found', 'not_found', false],
      [404, 'household_not_found', 'not_found', true],
      [429, 'too_many_requests', 'too_many_requests', false],
      [502, 'unavailable', 'unavailable', false],
    ];
    it.each(errors)('maps the documented %i {"error":"%s"} to %s, with one call', async (status, code, kind, householdNotFound) => {
      expect(validate({ error: code }, responseSchema(key, status), DOC)).toEqual([]);
      const { api, calls } = clientWith(() => answer(status, { error: code }));
      const error = (await op.call(api).catch((caught: unknown) => caught)) as ApiError;
      expect({ name: error.name, kind: error.kind, status: error.status, householdNotFound: error.householdNotFound }).toEqual({
        name: 'ApiError',
        kind,
        status,
        householdNotFound,
      });
      expect(calls).toHaveLength(1);
    });

    it('declares exactly the error statuses the client maps', () => {
      expect(Object.keys(operation(key).responses).sort()).toEqual([String(op.status), '400', '401', '404', '429', '502'].sort());
    });
  });
});

describe('the fetch budget (docs/app-api/fetch-budget.json)', () => {
  /** A budget entry with its placeholders filled in. */
  const fill = (entry: string) => entry.replace('{tmdbId}', '900002').replace('{n}', '1').replace('{query}', 'synthetic');
  /** The client call that makes `METHOD /path` from the budget, its placeholders filled in. */
  function callFor(entry: string): (api: ReturnType<typeof clientWith>['api']) => Promise<unknown> {
    const path = fill(entry).replace(/^GET /, '');
    let match: RegExpExecArray | null;
    if (path === '/me') return (api) => api.me();
    if ((match = /^\/search\?q=([a-z]+)&page=(\d+)$/.exec(path))) return (api) => api.search(match![1]!, Number(match![2]));
    if (path === '/requests') return (api) => api.requests();
    if (path === '/discover/sources') return (api) => api.sources();
    if ((match = /^\/discover\/network\/(\d+)(?:\/(films|all))?$/.exec(path))) {
      const [, id, list] = match;
      return (api) => api.network(Number(id), list as 'films' | 'all' | undefined);
    }
    if ((match = /^\/discover\/([a-z-]+)$/.exec(path))) return (api) => api.discover(match![1] as (typeof DISCOVER_LISTS)[number]);
    if ((match = /^\/movie\/(\d+)$/.exec(path))) return (api) => api.movie(Number(match![1]));
    if ((match = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(path))) return (api) => api.season(Number(match![1]), Number(match![2]));
    if ((match = /^\/tv\/(\d+)$/.exec(path))) return (api) => api.tv(Number(match![1]));
    throw new Error(`no client call for ${entry}`);
  }

  it.each(Object.entries(BUDGET.screens))('makes each of %s\'s calls with one request to exactly that path', async (_screen, screen) => {
    const entries = [...screen.atOnce, ...(screen.belowTheFold ?? [])];
    expect(entries).toHaveLength(screen.calls);
    const { api, calls } = clientWith((url) => answer(500, `${url}`));
    for (const entry of entries) await callFor(entry)(api).catch(() => undefined);
    expect(calls.map(sent)).toEqual(entries.map(fill));
  });
});
