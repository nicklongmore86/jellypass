// Checks a GitHub Actions workflow's jellyfin-integration job against scripts/jellyfin-versions.json: its matrix must
// list exactly the pinned image/version pairs (none missing, none extra, none mispaired), its test step must run on the
// matrix image, and (for the release workflow) the publishing job must wait for it.
//
// The repository has no YAML parser, so readWorkflow reads the YAML subset the workflows use: block mappings and
// sequences, plain and quoted scalars, flow sequences of scalars, and block scalars. Anything else (anchors, aliases,
// tags, flow mappings, duplicate keys) is an error rather than a guess.

export const MATRIX_JOB = 'jellyfin-integration';

/** The jellyfin-integration matrix entries, as written; throws if the job or its matrix is not shaped as expected. */
export function jellyfinMatrix(workflowText) {
  const job = readWorkflow(workflowText).jobs?.[MATRIX_JOB];
  if (!isMapping(job)) throw new Error(`no ${MATRIX_JOB} job`);
  const matrix = job.strategy?.matrix;
  if (!isMapping(matrix) || Object.keys(matrix).join() !== 'jellyfin') {
    throw new Error(`${MATRIX_JOB} strategy.matrix must have only a "jellyfin" list (no include or exclude)`);
  }
  if (!Array.isArray(matrix.jellyfin)) throw new Error(`${MATRIX_JOB} strategy.matrix.jellyfin is not a list`);
  return matrix.jellyfin.map((entry, index) => {
    if (!isMapping(entry) || Object.keys(entry).sort().join() !== 'image,version'
      || typeof entry.image !== 'string' || typeof entry.version !== 'string') {
      throw new Error(`${MATRIX_JOB} matrix entry ${index + 1} must be exactly { image, version }`);
    }
    return { image: entry.image, version: entry.version };
  });
}

/**
 * Throws, saying why, unless the workflow's matrix is exactly `pinned` (in any order), its `pnpm test:real` step runs on
 * the matrix image and version, and each of `publishJobs` lists jellyfin-integration in its `needs`.
 */
export function checkJellyfinMatrix(workflowText, pinned, { publishJobs = [] } = {}) {
  const key = ({ image, version }) => `${image} @ ${version}`;
  const wanted = pinned.map(key);
  const found = jellyfinMatrix(workflowText).map(key);
  const duplicate = found.find((entry, index) => found.indexOf(entry) !== index);
  if (duplicate) throw new Error(`${MATRIX_JOB} matrix lists ${duplicate} twice`);
  const missing = wanted.filter((entry) => !found.includes(entry));
  const extra = found.filter((entry) => !wanted.includes(entry));
  if (missing.length || extra.length) {
    throw new Error(`${MATRIX_JOB} matrix differs from scripts/jellyfin-versions.json: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
  }

  const workflow = readWorkflow(workflowText);
  const steps = workflow.jobs[MATRIX_JOB].steps;
  const runsOnMatrix = Array.isArray(steps) && steps.some((step) => isMapping(step)
    && typeof step.run === 'string' && step.run.trim() === 'pnpm test:real'
    && step.env?.JELLYFIN_IMAGE === '${{ matrix.jellyfin.image }}'
    && step.env?.JELLYFIN_REAL_VERSION === '${{ matrix.jellyfin.version }}');
  if (!runsOnMatrix) throw new Error(`${MATRIX_JOB} has no "pnpm test:real" step on the matrix image and version`);

  for (const name of publishJobs) {
    const job = workflow.jobs[name];
    if (!isMapping(job)) throw new Error(`no ${name} job`);
    const needs = typeof job.needs === 'string' ? [job.needs] : job.needs;
    if (!Array.isArray(needs) || !needs.includes(MATRIX_JOB)) throw new Error(`${name} does not need ${MATRIX_JOB}`);
  }
}

function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses the workflow YAML subset described above into plain objects, arrays and strings. */
export function readWorkflow(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((raw, index) => ({ number: index + 1, raw, indent: raw.search(/\S/) }));
  let at = 0;
  const fail = (line, reason) => { throw new Error(`workflow line ${line.number}: ${reason}`); };
  const content = (line) => stripComment(line.raw.slice(line.indent));
  // The next line with content, skipping blank and comment-only lines.
  const peek = () => {
    while (at < lines.length && (lines[at].indent < 0 || content(lines[at]) === '')) at += 1;
    return lines[at];
  };

  function block(indent) {
    const line = peek();
    if (!line || line.indent < indent) return null;
    if (line.raw.includes('\t')) fail(line, 'tab indentation');
    return /^-(\s|$)/.test(content(line)) ? sequence(line.indent) : mapping(line.indent);
  }

  function mapping(indent) {
    const result = {};
    for (let line = peek(); line && line.indent === indent && !/^-(\s|$)/.test(content(line)); line = peek()) {
      const match = /^("[^"]*"|'[^']*'|[^\s"'#\-?:[\]{}&*!|>@`][^:]*?|-[^\s:][^:]*?):(?:\s+(.*))?$/.exec(content(line));
      if (!match) fail(line, `expected "key: value", got "${content(line)}"`);
      const key = unquote(match[1]);
      if (Object.hasOwn(result, key)) fail(line, `duplicate key "${key}"`);
      at += 1;
      result[key] = value(line, match[2] ?? '', indent);
    }
    return result;
  }

  function sequence(indent) {
    const result = [];
    for (let line = peek(); line && line.indent === indent && /^-(\s|$)/.test(content(line)); line = peek()) {
      const rest = content(line).slice(1).trimStart();
      if (rest === '') {
        at += 1;
        result.push(block(indent + 1));
        continue;
      }
      // "- key: value" starts a mapping indented to where "key" stands: reread the line from there.
      const offset = line.raw.indexOf(rest, line.indent + 1);
      if (/^("[^"]*"|'[^']*'|[^\s"'#[\]{}][^:]*?):(\s|$)/.test(rest)) {
        lines[at] = { ...line, indent: offset, raw: `${' '.repeat(offset)}${line.raw.slice(offset)}` };
        result.push(mapping(offset));
      } else {
        at += 1;
        result.push(scalar(line, rest));
      }
    }
    return result;
  }

  function value(line, text, indent) {
    if (/^[|>][+-]?\d?$/.test(text)) return blockScalar(indent, text[0]);
    if (text !== '') return scalar(line, text);
    const next = peek();
    if (next && next.indent > indent) return block(indent + 1);
    // A sequence may sit at its key's own indent.
    if (next && next.indent === indent && /^-(\s|$)/.test(content(next))) return sequence(indent);
    return null;
  }

  function blockScalar(indent, style) {
    const taken = [];
    while (at < lines.length && (lines[at].indent < 0 || lines[at].indent > indent)) taken.push(lines[at++].raw);
    while (taken.length && taken.at(-1).trim() === '') taken.pop();
    const margin = Math.min(...taken.filter((raw) => raw.trim()).map((raw) => raw.search(/\S/)));
    const body = taken.map((raw) => raw.slice(margin));
    return `${style === '>' ? body.join(' ') : body.join('\n')}\n`;
  }

  function scalar(line, text) {
    if (/^[&*!{]/.test(text)) fail(line, `unsupported YAML "${text}"`);
    if (text.startsWith('[')) {
      if (!text.endsWith(']') || /[[\]{}]/.test(text.slice(1, -1))) fail(line, `unsupported flow sequence "${text}"`);
      const inner = text.slice(1, -1).trim();
      return inner === '' ? [] : inner.split(',').map((item) => unquote(item.trim()));
    }
    return unquote(text);
  }

  const result = block(0);
  const left = peek();
  if (left) fail(left, 'unexpected indentation');
  if (!isMapping(result)) throw new Error('workflow is not a mapping');
  return result;
}

/** A line without its trailing comment: a "#" at the start or after whitespace, outside quotes. */
function stripComment(text) {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      if (index === 0 || /[\s:[,-]/.test(text[index - 1])) quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

function unquote(text) {
  if (text.length >= 2 && text[0] === '"' && text.at(-1) === '"') return JSON.parse(text);
  if (text.length >= 2 && text[0] === "'" && text.at(-1) === "'") return text.slice(1, -1).replace(/''/g, "'");
  return text;
}
