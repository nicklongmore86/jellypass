// Checks a GitHub Actions workflow's jellyfin-integration job against scripts/jellyfin-versions.json: its matrix must
// list exactly the pinned image/version pairs (none missing, none extra, none mispaired), its test step must run on the
// matrix image with nothing that skips it or ignores its failure, and (for the release workflow) the publishing jobs
// must wait for it.
//
// The repository has no YAML parser, so readWorkflow reads the YAML subset the workflows use: one document of block
// mappings and sequences, plain and quoted single-line scalars, one-line flow sequences of those scalars, and literal (`|`)
// block scalars. Anything else (anchors, aliases, tags, merge keys, flow mappings, nested flow collections, folded
// or chomped block scalars, `?` keys, duplicate keys, tabs, CRLF, document markers) is an error rather than a guess.

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
 * Throws, saying why, unless the workflow's matrix is exactly `pinned` (in any order), its one `pnpm test:real` step
 * runs on the matrix image and version and always runs and fails the job, and each of `publishJobs` waits for
 * jellyfin-integration (directly or through another job that does) with no `if` that would run it after a failure.
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
  // Workflow defaults (a shell, a working directory) would change how the test step runs.
  if (Object.hasOwn(workflow, 'defaults')) throw new Error('the workflow must not set defaults');
  const job = workflow.jobs[MATRIX_JOB];
  mustGate(job, MATRIX_JOB);
  onlyKeys(job, ['name', 'runs-on', 'timeout-minutes', 'strategy', 'steps', 'continue-on-error'], MATRIX_JOB);
  onlyKeys(job.strategy, ['fail-fast', 'matrix'], `${MATRIX_JOB} strategy`);
  // fail-fast only cancels the other legs once one fails; the run fails either way.
  if (Object.hasOwn(job.strategy, 'fail-fast') && !['true', 'false'].includes(job.strategy['fail-fast'])) {
    throw new Error(`${MATRIX_JOB} strategy.fail-fast must be true or false`);
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const tests = steps.filter((step) => isMapping(step) && typeof step.run === 'string' && step.run.trim() === 'pnpm test:real');
  if (tests.length > 1) throw new Error(`${MATRIX_JOB} has more than one "pnpm test:real" step`);
  const [test] = tests;
  if (!test || !isMapping(test.env) || Object.keys(test.env).sort().join() !== 'JELLYFIN_IMAGE,JELLYFIN_REAL_VERSION'
    || test.env.JELLYFIN_IMAGE !== '${{ matrix.jellyfin.image }}'
    || test.env.JELLYFIN_REAL_VERSION !== '${{ matrix.jellyfin.version }}') {
    throw new Error(`${MATRIX_JOB} has no "pnpm test:real" step on the matrix image and version`);
  }
  mustGate(test, `${MATRIX_JOB}'s "pnpm test:real" step`);
  onlyKeys(test, ['name', 'run', 'env', 'continue-on-error'], `${MATRIX_JOB}'s "pnpm test:real" step`);

  for (const name of publishJobs) {
    const publish = workflow.jobs[name];
    if (!isMapping(publish)) throw new Error(`no ${name} job`);
    if (Object.hasOwn(publish, 'if') && !waitsForSuccess(publish.if)) {
      throw new Error(`${name} has "if: ${publish.if}", which could run it after ${MATRIX_JOB} fails`);
    }
    if (!gatedBy(workflow.jobs, name)) throw new Error(`${name} does not need ${MATRIX_JOB}`);
  }
}

// An `if` that calls a status function replaces the implicit success() and can run the job after a needed job failed.
function waitsForSuccess(condition) {
  return typeof condition === 'string' && !/\b(?:always|success|failure|cancelled)\b/i.test(condition);
}

/** Whether the job runs only after jellyfin-integration succeeded: it needs it, or needs a job that does. */
function gatedBy(jobs, name, seen = new Set()) {
  const job = jobs[name];
  if (!isMapping(job) || seen.has(name)) return false;
  if (Object.hasOwn(job, 'if') && !waitsForSuccess(job.if)) return false;
  const needs = typeof job.needs === 'string' ? [job.needs] : job.needs;
  if (!Array.isArray(needs)) return false;
  return needs.includes(MATRIX_JOB) || needs.some((need) => gatedBy(jobs, need, new Set([...seen, name])));
}

/** Throws unless the job or step has no `if` and its `continue-on-error` is absent or false. */
function mustGate(node, what) {
  if (Object.hasOwn(node, 'if')) throw new Error(`${what} must not have an "if"`);
  if (Object.hasOwn(node, 'continue-on-error') && node['continue-on-error'] !== 'false') {
    throw new Error(`${what} must not have "continue-on-error: ${node['continue-on-error']}"`);
  }
}

function onlyKeys(node, allowed, what) {
  const unexpected = Object.keys(node).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${what} has unexpected ${unexpected.map((key) => `"${key}"`).join(', ')}`);
}

function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DOUBLE_QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const SINGLE_QUOTED = String.raw`'(?:[^']|'')*'`;
const KEY = `${DOUBLE_QUOTED}|${SINGLE_QUOTED}|[^\\s"'#\\-?:,[\\]{}&*!|>%@\`][^:]*?|-[^\\s:][^:]*?`;
const KEY_LINE = new RegExp(`^(${KEY}):(?:\\s+(.*))?$`);
// Where a quoted scalar can start: the start of a line, after "- ", or after "key: ".
const SCALAR_START = new RegExp(`^(?:-\\s+)*(?:(?:${KEY}):\\s+)?$`);
const SEQUENCE_ITEM = /^-(\s|$)/;

/** Parses the workflow YAML subset described above into plain objects, arrays and strings. */
export function readWorkflow(text) {
  const unsupported = /[\t\r﻿]/.exec(text);
  if (unsupported) {
    const name = { '\t': 'a tab', '\r': 'a carriage return (CRLF)', '﻿': 'a byte-order mark' }[unsupported[0]];
    throw new Error(`workflow has ${name}, which this reader does not support`);
  }
  const lines = text.split('\n').map((raw, index) => ({ number: index + 1, raw, indent: raw.search(/\S/) }));
  let at = 0;
  const fail = (line, reason) => { throw new Error(`workflow line ${line.number}: ${reason}`); };
  for (const line of lines) {
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(line.raw) || line.raw.startsWith('%')) {
      fail(line, 'document markers and directives are not supported (one document only)');
    }
  }
  const content = (line) => stripComment(line.raw.slice(line.indent));
  // The next line with content, skipping blank and comment-only lines.
  const peek = () => {
    while (at < lines.length && (lines[at].indent < 0 || content(lines[at]) === '')) at += 1;
    return lines[at];
  };

  function block(indent) {
    const line = peek();
    if (!line || line.indent < indent) return null;
    return SEQUENCE_ITEM.test(content(line)) ? sequence(line.indent) : mapping(line.indent);
  }

  function mapping(indent) {
    const result = {};
    for (let line = peek(); line && line.indent === indent && !SEQUENCE_ITEM.test(content(line)); line = peek()) {
      const match = KEY_LINE.exec(content(line));
      if (!match) fail(line, `expected "key: value", got "${content(line)}"`);
      if (/\s$/.test(match[1])) fail(line, `space before the ":" of "${match[1]}"`);
      const key = /^["']/.test(match[1]) ? quoted(line, match[1]) : match[1];
      if (key === '<<') fail(line, 'merge keys are not supported');
      if (Object.hasOwn(result, key)) fail(line, `duplicate key "${key}"`);
      at += 1;
      Object.defineProperty(result, key, { value: value(line, match[2] ?? '', indent), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }

  function sequence(indent) {
    const result = [];
    for (let line = peek(); line && line.indent === indent && SEQUENCE_ITEM.test(content(line)); line = peek()) {
      const rest = content(line).slice(1).trimStart();
      if (rest === '') {
        at += 1;
        result.push(block(indent + 1));
        continue;
      }
      // "- key: value" starts a mapping indented to where "key" stands: reread the line from there.
      const offset = line.raw.indexOf(rest, line.indent + 1);
      if (KEY_LINE.test(rest)) {
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
    if (text === '|') return literal(line, indent);
    if (text !== '') return scalar(line, text);
    const next = peek();
    if (next && next.indent > indent) return block(indent + 1);
    // A sequence may sit at its key's own indent.
    if (next && next.indent === indent && SEQUENCE_ITEM.test(content(next))) return sequence(indent);
    return null;
  }

  // A `|` block scalar: its lines as written, less the first line's indent, with one final newline.
  function literal(line, indent) {
    const taken = [];
    while (at < lines.length && (lines[at].indent < 0 || lines[at].indent > indent)) taken.push(lines[at++]);
    while (taken.length && taken.at(-1).indent < 0) taken.pop();
    if (!taken.length || taken[0].indent < 0) fail(line, 'a block scalar must start with its first line of text');
    const margin = taken[0].indent;
    const short = taken.find((each) => each.indent >= 0 && each.indent < margin);
    if (short) fail(short, 'block scalar line indented less than its first line');
    return `${taken.map((each) => each.raw.slice(margin)).join('\n')}\n`;
  }

  function scalar(line, text) {
    if (text.startsWith('[')) return flowSequence(line, text);
    if (/^["']/.test(text)) return quoted(line, text);
    if (/^[-?:](\s|$)/.test(text) || /^[,[\]{}#&*!|>%@`]/.test(text)) fail(line, `unsupported YAML "${text}"`);
    if (/:(\s|$)/.test(text)) fail(line, `unsupported YAML "${text}": a plain value cannot contain ": "`);
    return text;
  }

  // A one-line list whose items are each one quoted scalar or a plain word (no quotes, brackets, braces or colons).
  // A comma inside quotes belongs to its item.
  function flowSequence(line, text) {
    const refuse = () => fail(line, `unsupported flow sequence "${text}"`);
    if (!text.endsWith(']')) refuse();
    const inner = text.slice(1, -1);
    if (inner.trim() === '') return [];
    const item = new RegExp(`\\s*(${DOUBLE_QUOTED}|${SINGLE_QUOTED}|[^,]*)\\s*(,|$)`, 'y');
    const result = [];
    for (let match = item.exec(inner); ; match = item.exec(inner)) {
      if (!match) refuse();
      const element = match[1].trim();
      if (/^["']/.test(element)) {
        result.push(quoted(line, element));
      } else if (element === '' || /^[-?](\s|$)/.test(element) || /^[#&*!|>%@`]/.test(element) || /[[\]{}"':]/.test(element)) {
        refuse();
      } else {
        result.push(element);
      }
      if (match[2] === '') return result;
    }
  }

  function quoted(line, text) {
    if (new RegExp(`^${DOUBLE_QUOTED}$`).test(text)) {
      try {
        return JSON.parse(text);
      } catch {
        fail(line, `unsupported escape in ${text}`);
      }
    }
    if (new RegExp(`^${SINGLE_QUOTED}$`).test(text)) return text.slice(1, -1).replace(/''/g, "'");
    return fail(line, `unsupported quoted value ${text} (one line, nothing after the closing quote)`);
  }

  const result = block(0);
  const left = peek();
  if (left) fail(left, 'unexpected indentation');
  if (!isMapping(result)) throw new Error('workflow is not a mapping');
  return result;
}

/** A line without its trailing comment: a "#" at the start or after whitespace, outside a quoted scalar. */
function stripComment(text) {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = '';
    } else if (quote === "'") {
      if (char === "'" && text[index + 1] === "'") index += 1;
      else if (char === "'") quote = '';
    } else if ((char === '"' || char === "'") && SCALAR_START.test(text.slice(0, index))) {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}
