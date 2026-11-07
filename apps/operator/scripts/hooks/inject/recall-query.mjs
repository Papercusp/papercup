/** Shared measured tool vocabulary; extracted from mid-turn-context.ts for pre-clamp use. */
import { createHash } from 'node:crypto';
import { parse as parseShell } from './shell-quote.mjs';

/** @typedef {{ fields: readonly string[], join?: string, freeform?: boolean }} ToolQuerySpec */
/** @typedef {{ version: 1, ids: string[], symbols: string[], paths: string[], task: string[], search: string[], errors: string[], semantic: string, lexical: string, fingerprint: string }} RecallSignals */

/** @type {Readonly<Record<string, ToolQuerySpec>>} */
export const TOOL_QUERY_VOCABULARY = {
  Bash: { fields: ['command', 'description'], join: ' — ' },
  Grep: { fields: ['pattern', 'path', 'glob'] },
  Glob: { fields: ['pattern', 'path'] },
  Read: { fields: ['file_path'] },
  Edit: { fields: ['file_path'] },
  Write: { fields: ['file_path'] },
  ToolSearch: { fields: ['query'] },
  WebSearch: { fields: ['query'] },
  WebFetch: { fields: ['url', 'prompt'], join: ' — ' },
  AskUserQuestion: { fields: [] },
  Artifact: { fields: [] },
  Skill: { fields: [] },
  Monitor: { fields: [] },
  TaskCreate: { fields: [] },
  TaskUpdate: { fields: [] },
  TaskStop: { fields: [] },
  exec_command: { fields: ['cmd', 'workdir', 'justification'], join: ' — ' },
  apply_patch: { fields: [], freeform: true },
  exec: { fields: [], freeform: true },
  view_image: { fields: ['path'] },
  update_plan: { fields: ['plan'] },
  wait: { fields: [] },
  list_mcp_resources: { fields: [] },
  write_stdin: { fields: [] }, // credential-shaped; see DELIBERATE OMISSIONS
  create_goal: { fields: ['objective'] },
  get_goal: { fields: [] }, // no arguments at all; see DELIBERATE OMISSIONS
  update_goal: { fields: [] }, // `status` enum only; see DELIBERATE OMISSIONS
  bash: { fields: ['command', 'description'], join: ' — ' },
  read: { fields: ['path', 'file_path'] },
  grep: { fields: ['pattern', 'path', 'glob'] },
  glob: { fields: ['pattern', 'path'] },
  find: { fields: ['pattern', 'path', 'glob'] },
  search: { fields: ['pattern', 'path', 'query'] },
  edit: { fields: ['path', 'file_path'] },
  write: { fields: ['path', 'file_path'] },
  ast_grep: { fields: ['pattern', 'path'] },
  ast_edit: { fields: ['pattern', 'path'] },
  yield: { fields: [] },
  submit_result: { fields: [] },
  report_finding: { fields: [] },
};

export const TOOLS_INVOKE = 'tools:invoke';

/** @type {Readonly<Record<string, ToolQuerySpec>>} */
export const PAPERCUSP_TOOL_VOCABULARY = {
  'dev:pg_query': { fields: ['sql', 'describe'] },
  'capability:bash': { fields: ['command', 'description'], join: ' — ' },
  'capability:read': { fields: ['file_path'] },
  'capability:git': { fields: ['args'] },
  'testing:run': { fields: ['files', 'testNamePattern'] },
  'build:typecheck': { fields: ['project', 'files'] },
  'dev:pipeline_position': { fields: ['path'] },
  'tools:find': { fields: ['query', 'intent'] },
  'docs:search': { fields: ['query'] },
  'search:fulltext': { fields: ['query'] },
  'memory:search': { fields: ['query'] },
  'sessions:search': { fields: ['query'] },
  'work_items:search': { fields: ['query'] },
  'fleet:invariant': { fields: ['description', 'sql'], join: ' — ' },
  'code:run': { fields: ['title', 'description'] },
  'improvements:capture': { fields: ['title'] },
  'work_items:create': { fields: ['title'] },
  'loop:checkpoint': { fields: [] },
  'loop:status': { fields: [] },
  'loop:arm': { fields: [] },
  'loop:end': { fields: [] },
  'coord:orient': { fields: [] },
  'coord:send': { fields: [] },
  'coord:inbox': { fields: [] },
  'coord:presence': { fields: [] },
  'coord:glance': { fields: [] },
  'coord:thread': { fields: [] },
  'coord:read': { fields: [] },
  'coord:ack': { fields: [] },
  'coord:whoami': { fields: [] },
  'coord:ask-owner': { fields: [] },
  'work_items:get': { fields: [] },
  'work_items:checkpoint': { fields: [] },
  'work_items:complete': { fields: [] },
  'work_items:comment': { fields: [] },
  'work_items:list': { fields: [] },
  'work_items:claim': { fields: [] },
  'work_items:claim_next': { fields: [] },
  'work_items:claimable': { fields: [] },
  'work_items:release': { fields: [] },
  'work_items:set_state': { fields: [] },
  'work_items:update': { fields: [] },
  'work_items:link': { fields: [] },
  'plans:get': { fields: [] },
  'plans:get-item': { fields: [] },
  'plans:items': { fields: [] },
  'plans:list': { fields: [] },
  'plans:new': { fields: [] },
  'plans:add-item': { fields: [] },
  'plans:add-decision': { fields: [] },
  'plans:set-decision-body': { fields: [] },
  'plans:set-status': { fields: [] },
  'plans:set-now': { fields: [] },
  'facts:assert': { fields: [] },
  'facts:list': { fields: [] },
  'facts:retract': { fields: [] },
  'memory:remember': { fields: [] },
  'sessions:read': { fields: [] },
  'sessions:timeline': { fields: [] },
  'session:request-compaction': { fields: [] },
  'scheduler:get_next': { fields: [] },
  'state:read': { fields: [] },
  'mode:set': { fields: [] },
  'locks:list': { fields: [] },
  'locks:queue': { fields: [] },
  'fleet:leader-brief': { fields: [] },
  'fleet:status': { fields: [] },
  'fleet:wind-down': { fields: [] },
  'db:migrate': { fields: [] },
  'db:next-migration': { fields: [] },
  'conversations:get': { fields: [] },
  'conversations:post': { fields: [] },
  'activity:recent': { fields: [] },
  'journal:recent': { fields: [] },
  'release:deploy': { fields: [] },
  'gateway:status': { fields: [] },
  'capability:bash_output': { fields: [] },
  [TOOLS_INVOKE]: { fields: [] },
};

/** @type {ReadonlyMap<string, string>} */
export const MANGLED_TO_COLON = (() => {
  const map = new Map();
  const register = (mangled, colon) => {
    const prior = map.get(mangled);
    if (prior && prior !== colon) {
      throw new Error(`mid-turn vocabulary: '${prior}' and '${colon}' mangle to the same '${mangled}'`);
    }
    map.set(mangled, colon);
  };
  for (const colon of Object.keys(PAPERCUSP_TOOL_VOCABULARY)) {
    register(colon.replace(/:/g, '_'), colon); // claude / omp
    register(colon.replace(/[:-]/g, '_'), colon); // codex mangles '-' too
  }
  return map;
})();

export function specFor(tool) {
  const direct = TOOL_QUERY_VOCABULARY[tool];
  if (direct) return direct;
  const byColon = PAPERCUSP_TOOL_VOCABULARY[tool];
  if (byColon) return byColon;
  if (!tool.startsWith('mcp__')) return undefined;
  const end = tool.indexOf('__', 'mcp__'.length);
  if (end < 0) return undefined;
  const colon = MANGLED_TO_COLON.get(tool.slice(end + 2));
  return colon ? PAPERCUSP_TOOL_VOCABULARY[colon] : undefined;
}

export function colonNameFor(tool) {
  if (PAPERCUSP_TOOL_VOCABULARY[tool]) return tool;
  if (!tool.startsWith('mcp__')) return tool;
  const end = tool.indexOf('__', 'mcp__'.length);
  return end < 0 ? tool : (MANGLED_TO_COLON.get(tool.slice(end + 2)) ?? tool);
}

const CLASSES = ['ids', 'symbols', 'paths', 'task', 'search', 'errors'];
const MAX_TERM = 160;
const MAX_TERMS = 4;
const QUERY_BUDGET = 1000;
const text = value => typeof value === 'string' ? value.trim() : '';
const record = value => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};
const empty = () => Object.fromEntries(CLASSES.map(key => [key, []]));

function add(out, key, value) {
  const term = text(value).replace(/\s+/g, ' ');
  if (!term || term.length > MAX_TERM || out[key].length >= MAX_TERMS || out[key].includes(term)) return;
  out[key].push(term);
}

function prose(value) {
  const term = text(value);
  // Complete prose fields only. Code, serialized envelopes, substitutions and
  // heredocs cannot become prose by trimming away their punctuation.
  return term && !/[{};`\n\r]|\$\(|<<|=>|^\s*[\[{]|\b(?:const|let|var|import|return|await)\s/.test(term)
    ? term.replace(/\b(?:WI|EI|F|P|R|D)-\d+\b/g, '').replace(/\s+/g, ' ').trim() : '';
}

function identifiers(out, value) {
  for (const match of text(value).matchAll(/\b(?:WI|EI|F|P|R|D)-\d+\b/g)) add(out, 'ids', match[0]);
}

function searchTerm(out, value) {
  const term = text(value);
  if (!term || /[{};`\n\r]|\$\(|<<|=>/.test(term)) return;
  identifiers(out, term);
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(term) && /[a-z][A-Z]|_/.test(term)) add(out, 'symbols', term);
  else add(out, 'search', prose(term));
}

function pathTerm(out, value) {
  const term = text(value);
  if (/^(?:\.?\.?\/|~\/|\/)?[\w.@*\[\]-]+(?:\/[\w.@*\[\]-]+)*\/?$/.test(term)) add(out, 'paths', term);
}

function commandSignals(out, command) {
  const raw = text(command);
  if (!raw || raw.length > 100_000 || /[<>`\n\r]|\$\(|\$\{|[{}]/.test(raw)) return;
  let tokens;
  try { tokens = parseShell(raw, () => ''); } catch { return; }
  // Never interpret script bodies, JSON payloads, shell setup or interpreter
  // programs. Read/search commands have a small literal-argument grammar.
  const end = tokens.findIndex(token => typeof token !== 'string');
  const words = (end < 0 ? tokens : tokens.slice(0, end));
  const program = words.shift()?.split('/').pop();
  if (program === 'rg' || program === 'grep') {
    let pattern = false;
    for (let i = 0; i < words.length; i++) {
      const arg = words[i];
      if (['-g', '--glob', '--type', '-t', '--type-not', '-T', '-m', '--max-count', '-A', '-B', '-C'].includes(arg)) { i++; continue; }
      if (arg === '-e' || arg === '--regexp') { searchTerm(out, words[++i]); pattern = true; continue; }
      if (arg.startsWith('-')) continue;
      if (!pattern && !words.includes('--files')) { searchTerm(out, arg); pattern = true; }
      else pathTerm(out, arg);
    }
  } else if (['cat', 'head', 'tail', 'ls', 'find'].includes(program)) {
    for (const word of words) if (!word.startsWith('-') && /\/|\.[A-Za-z]/.test(word)) pathTerm(out, word);
  }
}

/** @returns {RecallSignals} */
function finish(out) {
  // Stable, whole-term packing gives exact identifiers priority over prose.
  // No field, ID or path is sliced into a different query term.
  const normalized = empty();
  let remaining = QUERY_BUDGET;
  for (const key of CLASSES) for (const value of out[key]) {
    if (value.length + 1 > remaining) continue;
    add(normalized, key, value);
    remaining -= value.length + 1;
  }
  const semantic = [...normalized.task, ...normalized.search, ...normalized.errors].join(' ');
  const lexical = CLASSES.flatMap(key => normalized[key]).join(' ');
  const fingerprint = createHash('sha256').update(JSON.stringify({ version: 1, ...normalized, semantic, lexical })).digest('hex');
  return { version: 1, ...normalized, semantic, lexical, fingerprint };
}

/** Pure, shared pre-clamp extraction for all native adapters and direct calls.
 * @param {string} tool
 * @param {unknown} input
 * @param {unknown} [response]
 * @param {number} [depth]
 * @returns {RecallSignals}
 */
export function extractRecallSignals(tool, input, response, depth = 0) {
  const out = empty();
  if (depth >= 4) return finish(out);
  const spec = specFor(tool);
  if (!spec) return finish(out);
  const io = record(input);
  if (colonNameFor(tool) === TOOLS_INVOKE) {
    return io ? extractRecallSignals(text(io.name), io.args, response, depth + 1) : finish(out);
  }
  if (tool === 'write' && text(io?.path).startsWith('xd://mcp__')) {
    const suffix = text(io.path).replace(/^xd:\/\/mcp__papercusp_su_/, '');
    return extractRecallSignals(MANGLED_TO_COLON.get(suffix) || '', io.content, response, depth + 1);
  }
  if (spec.freeform) {
    if (tool === 'apply_patch') for (const match of text(input).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) pathTerm(out, match[1]);
    return finish(out);
  }
  if (!io) return finish(out);
  for (const field of spec.fields) {
    const value = io[field];
    if (['command', 'cmd'].includes(field)) commandSignals(out, value);
    else if (['path', 'file_path', 'workdir', 'filePath'].includes(field)) pathTerm(out, value);
    else if (['pattern', 'query', 'search'].includes(field)) searchTerm(out, value);
    else if (['description', 'justification', 'prompt', 'objective', 'intent'].includes(field)) { identifiers(out, value); add(out, 'task', prose(value)); }
    else if (['symbol', 'symbolName', 'name'].includes(field)) add(out, 'symbols', /^[\w$.]+$/.test(text(value)) ? value : '');
    // Raw SQL, code, file bodies, URLs and lifecycle bookkeeping stay out.
  }
  if (spec.fields.length && text(response).length <= 100_000) {
    for (const match of text(response).matchAll(/\b(?:[A-Z][A-Za-z]*Error|E[A-Z_]{2,}|TS\d{3,})\b/g)) add(out, 'errors', match[0]);
  }
  return finish(out);
}

/** Validate the normalized wire form; partial or altered manifests abstain.
 * @param {unknown} value
 * @returns {RecallSignals | null}
 */
export function readRecallSignals(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const out = empty();
  for (const key of CLASSES) {
    if (!Array.isArray(value[key]) || value[key].length > MAX_TERMS) return null;
    for (const term of value[key]) {
      if (typeof term !== 'string' || !term || term.length > MAX_TERM || term !== term.trim() || /[\n\r]/.test(term)) return null;
      add(out, key, term);
    }
  }
  const normalized = finish(out);
  return normalized.fingerprint === value.fingerprint && normalized.semantic === value.semantic && normalized.lexical === value.lexical ? normalized : null;
}

/** @param {RecallSignals[]} values @returns {RecallSignals} */
export function combineRecallSignals(values) {
  const out = empty();
  for (const value of values) for (const key of CLASSES) for (const term of value[key]) add(out, key, term);
  return finish(out);
}

