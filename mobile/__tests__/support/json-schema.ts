// A TypeScript copy of the server's test/support/json-schema.mjs: a small JSON Schema (2020-12) validator for
// docs/app-api/v1.openapi.json, so the contract tests need no dependency. It knows only the keywords below, and
// api-schema.test.ts refuses a document that uses any other, so a keyword is never silently ignored.

type Schema = Record<string, unknown>;

/** The validation keywords understood, and the annotations that are allowed and ignored. */
export const VALIDATION_KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
]);
export const ANNOTATIONS = new Set(['description', 'title']);

/** Every keyword a schema uses, nested schemas included (property names are not keywords). */
export function keywordsOf(schema: unknown, found = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== 'object') return found;
  for (const [key, value] of Object.entries(schema)) {
    found.add(key);
    if (key === 'properties') for (const nested of Object.values(value as Schema)) keywordsOf(nested, found);
    else if (key === 'anyOf') for (const nested of value as unknown[]) keywordsOf(nested, found);
    else if (key === 'items' || key === 'additionalProperties') keywordsOf(value, found);
  }
  return found;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** A `#/...` JSON pointer resolved in `root`. */
export function resolve(ref: string, root: unknown): unknown {
  return ref.replace(/^#\//, '').split('/').reduce<unknown>((node, key) => (node as Schema | undefined)?.[key], root);
}

/** The ways `value` breaks `schema`, each as `path: problem`; none means it is valid. */
export function validate(value: unknown, schema: Schema, root: unknown, path = '$'): string[] {
  const errors: string[] = [];
  if (typeof schema.$ref === 'string') {
    const target = resolve(schema.$ref, root) as Schema | undefined;
    if (!target) return [`${path}: unresolved ${schema.$ref}`];
    errors.push(...validate(value, target, root, path));
  }
  const type = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = [schema.type].flat() as string[];
    if (!allowed.includes(type) && !(type === 'integer' && allowed.includes('number'))) return [...errors, `${path}: ${type}, not ${allowed.join(' or ')}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if ('const' in schema && schema.const !== value) errors.push(`${path}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((option: Schema) => validate(value, option, root, path).length === 0)) {
    errors.push(`${path}: matches none of anyOf`);
  }
  if (type === 'object') {
    const record = value as Schema;
    const properties = schema.properties as Record<string, Schema> | undefined;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!Object.hasOwn(record, key)) errors.push(`${path}: missing ${key}`);
    for (const [key, nested] of Object.entries(record)) {
      if (properties && Object.hasOwn(properties, key)) errors.push(...validate(nested, properties[key]!, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
    }
  }
  if (type === 'array') {
    const list = value as unknown[];
    if (schema.items) list.forEach((item, index) => errors.push(...validate(item, schema.items as Schema, root, `${path}[${index}]`)));
    if (typeof schema.minItems === 'number' && list.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && list.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(list.map((item) => JSON.stringify(item))).size !== list.length) errors.push(`${path}: items repeat`);
  }
  if (type === 'integer' || type === 'number') {
    const number = value as number;
    if (typeof schema.minimum === 'number' && number < schema.minimum) errors.push(`${path}: ${number} < ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && number > schema.maximum) errors.push(`${path}: ${number} > ${schema.maximum}`);
  }
  if (type === 'string') {
    const text = value as string;
    // Lengths in code points, as JSON Schema counts them.
    const length = [...text].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(text)) errors.push(`${path}: ${JSON.stringify(text)} does not match ${schema.pattern}`);
  }
  return errors;
}
