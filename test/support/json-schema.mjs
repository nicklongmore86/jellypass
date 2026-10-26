// A small JSON Schema (2020-12) validator for the app API's OpenAPI document, so its test needs no dependency. It
// knows only the keywords below; `keywordsOf` lets a test refuse a schema that uses any other, so a keyword is never
// silently ignored.

/** The validation keywords understood, and the annotations that are allowed and ignored. */
export const VALIDATION_KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
]);
export const ANNOTATIONS = new Set(['description', 'title']);

/** Every keyword a schema uses, nested schemas included (property names are not keywords). */
export function keywordsOf(schema, found = new Set()) {
  if (!schema || typeof schema !== 'object') return found;
  for (const [key, value] of Object.entries(schema)) {
    found.add(key);
    if (key === 'properties') for (const nested of Object.values(value)) keywordsOf(nested, found);
    else if (key === 'anyOf') for (const nested of value) keywordsOf(nested, found);
    else if (key === 'items' || key === 'additionalProperties') keywordsOf(value, found);
  }
  return found;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * The ways `value` breaks `schema`, each as `path: problem`; none means it is valid. `$ref` is resolved in `root` (a
 * JSON pointer such as `#/components/schemas/Card`).
 */
export function validate(value, schema, root, path = '$') {
  const errors = [];
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], root);
    if (!target) return [`${path}: unresolved ${schema.$ref}`];
    errors.push(...validate(value, target, root, path));
  }
  const type = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = [schema.type].flat();
    if (!allowed.includes(type) && !(type === 'integer' && allowed.includes('number'))) return [...errors, `${path}: ${type}, not ${allowed.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if ('const' in schema && schema.const !== value) errors.push(`${path}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  if (schema.anyOf && !schema.anyOf.some((option) => validate(value, option, root, path).length === 0)) {
    errors.push(`${path}: matches none of anyOf (${schema.anyOf.map((option) => validate(value, option, root, path).join('; ')).join(' | ')})`);
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}: missing ${key}`);
    for (const [key, nested] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...validate(nested, schema.properties[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
    }
  }
  if (type === 'array') {
    if (schema.items) value.forEach((item, index) => errors.push(...validate(item, schema.items, root, `${path}[${index}]`)));
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}: items repeat`);
  }
  if (type === 'integer' || type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > ${schema.maximum}`);
  }
  if (type === 'string') {
    // Lengths in code points, as JSON Schema counts them.
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  return errors;
}
