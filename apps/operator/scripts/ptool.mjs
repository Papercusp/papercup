#!/usr/bin/env node
/**
 * ptool.mjs — the `ptool` command.
 *
 * An interactive CLI for invoking any `defineTool` endpoint from the
 * terminal. You pick a service, then an endpoint, then ptool prompts for
 * each argument (derived from the tool's `inputSchema`) and calls it.
 *
 * It talks to the operator over the SAME superuser surface the engineer
 * shells use — the MCP transport at `/api/mcp?superuser=1` (loopback +
 * the `~/.papercusp/superuser-token` bearer). That transport already
 * exposes every projected `defineTool` with its `inputSchema` and runs at
 * operator tier (role/capability/quota gates bypassed), so ptool needs no
 * server-side support: discovery (`tools/list`) and invocation
 * (`tools/call`) both ride it.
 *
 * Sibling to `psu` (psu-launcher.mjs) — same conventions: lives in the repo
 * so it resolves `@inquirer/prompts` + the MCP SDK from the operator's
 * node_modules; the on-PATH `ptool` shim (install-standalone-mcp.sh) is a
 * one-liner exec'ing this file by absolute path; `PAPERCUSP_OPERATOR_URL`
 * overrides the host; the token is read from `~/.papercusp/superuser-token`.
 *
 * Interactive:  ptool
 *               ptool <group:verb>                 # skip the pickers, prompt args
 * Scripting:    ptool <group:verb> --json '{...}'  # call directly
 *               ptool --list [filter]              # print the catalog
 *               ptool <group:verb> --workspace=<ws> --harness=<slug>
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OPERATOR_URL = process.env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070';

/* ─── arg parsing (pure — exported for tests) ─────────────────────────── */

/**
 * Parse argv into the ptool invocation shape. The first non-flag positional
 * is the tool name (`group:verb`); everything else is a flag. Pure.
 */
export function parseArgs(argv) {
  const out = {
    tool: null,
    json: null,
    list: false,
    listFilter: null,
    workspace: null,
    harness: null,
    raw: false,
    url: null,
    help: false,
  };
  // Value-bearing flags accept BOTH `--flag=value` and `--flag value`. Map a
  // flag name to the out-key it sets (`--args` is an alias for `--json`).
  const valueFlags = { '--json': 'json', '--args': 'json', '--workspace': 'workspace', '--harness': 'harness', '--url': 'url' };
  let sawList = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--raw') { out.raw = true; continue; }
    if (a === '--list' || a === '-l') { out.list = true; sawList = true; continue; }
    // `--flag=value`
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      const key = valueFlags[a.slice(0, eq)];
      if (key) { out[key] = a.slice(eq + 1); continue; }
    }
    // `--flag value` (consume the next token)
    if (valueFlags[a] && i + 1 < argv.length) {
      out[valueFlags[a]] = argv[++i];
      continue;
    }
    // A bare positional: the tool name first, then (if --list was given) a
    // catalog filter term.
    if (!a.startsWith('-')) {
      if (!out.tool && !sawList) out.tool = a;
      else if (sawList && !out.listFilter) out.listFilter = a;
      else if (!out.tool) out.tool = a;
    }
  }
  return out;
}

/* ─── catalog grouping (pure — exported for tests) ────────────────────── */

/** The service a tool belongs to — the segment before the first `:`
 *  (`work_items:list` → `work_items`). Colon-less names group under
 *  `(misc)`. Pure. */
export function serviceOf(name) {
  const i = name.indexOf(':');
  return i > 0 ? name.slice(0, i) : '(misc)';
}

/**
 * Group a tools array into `{ service: tool[] }`, services and tools each
 * sorted by name. Pure — exported for tests. Each tool keeps its original
 * `{ name, description, inputSchema }`.
 */
export function groupTools(tools) {
  const byService = new Map();
  for (const t of tools) {
    const svc = serviceOf(t.name);
    if (!byService.has(svc)) byService.set(svc, []);
    byService.get(svc).push(t);
  }
  for (const list of byService.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return new Map([...byService.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** First non-empty line of a (possibly multi-line guidance) description,
 *  trimmed + truncated to `max` chars. Pure. */
export function firstLine(desc, max = 90) {
  if (!desc) return '';
  const line = String(desc).split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/* ─── schema → prompt specs (pure — exported for tests) ───────────────── */

/** Normalize a JSON-schema `type` that may be a string or an array
 *  (`['string','null']`) to the first non-null type. Pure. */
export function normalizeType(type) {
  if (Array.isArray(type)) return type.find((t) => t && t !== 'null') ?? null;
  return type ?? null;
}

/**
 * Derive an ordered list of prompt specs from a tool's JSON `inputSchema`.
 * Required properties come first (in schema order), then optionals. Each
 * spec: `{ name, required, kind, enumValues?, description, default }` where
 * `kind` ∈ enum | boolean | number | integer | string | json. Anything not
 * a plain scalar (arrays, objects, unions, unknown) falls to `json` (raw
 * JSON entry). Pure — exported for tests.
 */
export function promptSpecsFromSchema(inputSchema) {
  const props = (inputSchema && inputSchema.properties) || {};
  const required = new Set(Array.isArray(inputSchema?.required) ? inputSchema.required : []);
  const specs = [];
  for (const [name, raw] of Object.entries(props)) {
    const sub = raw && typeof raw === 'object' ? raw : {};
    const type = normalizeType(sub.type);
    let kind;
    let enumValues;
    if (Array.isArray(sub.enum) && sub.enum.length > 0) {
      kind = 'enum';
      enumValues = sub.enum;
    } else if (type === 'boolean') kind = 'boolean';
    else if (type === 'integer') kind = 'integer';
    else if (type === 'number') kind = 'number';
    else if (type === 'string') kind = 'string';
    else kind = 'json'; // array | object | union (anyOf/oneOf) | unknown
    specs.push({
      name,
      required: required.has(name),
      kind,
      enumValues,
      description: typeof sub.description === 'string' ? sub.description : '',
      default: sub.default,
    });
  }
  // Required first (keep schema order within each group).
  return [...specs.filter((s) => s.required), ...specs.filter((s) => !s.required)];
}

/**
 * Coerce a raw user-entered string to the typed value its spec wants.
 * Throws on a malformed number / JSON so a bad arg fails loudly rather than
 * being sent as the wrong type. `boolean`/`enum` values arrive already typed
 * (from confirm/select) and pass through. Pure — exported for tests.
 */
export function coerceArg(kind, raw) {
  switch (kind) {
    case 'boolean':
    case 'enum':
      return raw; // already a typed value from the prompt widget
    case 'integer': {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`not an integer: "${raw}"`);
      return n;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`not a number: "${raw}"`);
      return n;
    }
    case 'json': {
      try {
        return JSON.parse(raw);
      } catch (e) {
        throw new Error(`not valid JSON: ${e.message}`);
      }
    }
    case 'string':
    default:
      return raw;
  }
}

/**
 * Merge `--workspace`/`--harness` convenience flags into an args object,
 * but ONLY for properties the tool's schema actually declares (so we never
 * inject an arg a tool would reject). Existing keys in `args` win. Pure.
 */
export function mergeConvenienceArgs(args, { workspace, harness }, inputSchema) {
  const props = (inputSchema && inputSchema.properties) || {};
  const out = { ...args };
  if (workspace != null && 'workspace' in props && !('workspace' in out)) out.workspace = workspace;
  if (harness != null && 'harness' in props && !('harness' in out)) out.harness = harness;
  return out;
}

/* ─── result formatting (pure — exported for tests) ───────────────────── */

/** Pretty-print a text payload: if it parses as JSON, indent it; else
 *  return it unchanged. Pure. */
export function prettyText(text) {
  if (typeof text !== 'string') return String(text);
  const t = text.trim();
  if (!t) return text;
  if (t[0] !== '{' && t[0] !== '[') return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

/** Flatten an MCP tools/call result's `content[]` into a single text blob.
 *  Non-text parts are rendered as their JSON. Pure. */
export function resultToText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
}

/* ─── runtime (impure) ────────────────────────────────────────────────── */

function readToken() {
  try {
    return readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Connect an MCP client to the operator's superuser endpoint. Returns the
 *  connected client; caller closes it.
 *
 *  `workspace`/`harness`, when given, scope the SESSION via `?workspace=`/
 *  `?harness=` on the MCP URL — the documented way to scope a superuser MCP
 *  session. This is what lets workspace-scoped legacy first-party tools
 *  (harness:*, features:*, …) get a synthesized workspace transaction, so
 *  it works regardless of whether the host also honors a per-call `workspace`
 *  arg (the newer EI-30 path). The flags are ALSO merged into the args object
 *  (mergeConvenienceArgs) for tools that take `workspace` as a genuine filter. */
async function connect(operatorUrl, { workspace, harness } = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const token = readToken();
  if (!token) {
    throw new Error(`no superuser token at ~/.papercusp/superuser-token — is the operator installed? (run apps/operator/scripts/install-standalone-mcp.sh)`);
  }
  const url = new URL(operatorUrl + '/api/mcp');
  url.searchParams.set('superuser', '1');
  if (workspace) url.searchParams.set('workspace', workspace);
  if (harness) url.searchParams.set('harness', harness);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'ptool', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (e) {
    throw new Error(
      `could not reach the operator at ${operatorUrl} (${e?.message || e}). ` +
        `Is the desktop/operator running? Override with PAPERCUSP_OPERATOR_URL or --url=.`,
    );
  }
  return client;
}

/** List every tool, following pagination if the server returns a cursor. */
async function listAllTools(client) {
  const all = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    if (Array.isArray(page.tools)) all.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** Collect arg values for a tool by prompting per its inputSchema. Returns
 *  the assembled args object. */
async function collectArgs(inputSchema) {
  const { input, confirm, select } = await import('@inquirer/prompts');
  const specs = promptSpecsFromSchema(inputSchema);
  if (specs.length === 0) return {};
  const SKIP = Symbol('skip');
  const args = {};
  for (const spec of specs) {
    const label = `${spec.name}${spec.required ? '' : ' (optional)'}`;
    const hint = spec.description ? `  — ${firstLine(spec.description, 70)}` : '';
    const message = `${label}${hint}`;

    if (spec.kind === 'boolean') {
      if (spec.required) {
        args[spec.name] = await confirm({ message, default: spec.default === true });
      } else {
        const choices = [
          { name: '(skip)', value: SKIP },
          { name: 'true', value: true },
          { name: 'false', value: false },
        ];
        const v = await select({ message, choices, default: spec.default === undefined ? SKIP : spec.default });
        if (v !== SKIP) args[spec.name] = v;
      }
      continue;
    }

    if (spec.kind === 'enum') {
      const base = spec.enumValues.map((e) => ({ name: String(e), value: e }));
      const choices = spec.required ? base : [{ name: '(skip)', value: SKIP }, ...base];
      const def = spec.default !== undefined ? spec.default : spec.required ? base[0].value : SKIP;
      const v = await select({ message, choices, default: def });
      if (v !== SKIP) args[spec.name] = v;
      continue;
    }

    // string | number | integer | json — free text, coerced + validated.
    const placeholder =
      spec.kind === 'json'
        ? '(raw JSON, e.g. {"k":"v"} or ["a","b"])'
        : spec.default !== undefined
          ? `default: ${JSON.stringify(spec.default)}`
          : '';
    const answer = await input({
      message: placeholder ? `${message}\n  ${placeholder}` : message,
      validate: (val) => {
        const v = val.trim();
        if (!v) return spec.required ? 'required' : true;
        try {
          coerceArg(spec.kind, v);
          return true;
        } catch (e) {
          return e.message;
        }
      },
    });
    const trimmed = answer.trim();
    if (!trimmed) continue; // optional + blank → omit
    args[spec.name] = coerceArg(spec.kind, trimmed);
  }
  return args;
}

/** Print the result of a tools/call, or its error. Returns the exit code. */
function printResult(result, { raw }) {
  const text = resultToText(result);
  if (result?.isError) {
    console.error('✗ tool returned an error:');
    console.error(raw ? text : prettyText(text));
    return 1;
  }
  console.log(raw ? text : prettyText(text));
  return 0;
}

function printCatalog(grouped, filter) {
  const term = (filter || '').toLowerCase();
  for (const [svc, tools] of grouped) {
    const matched = term
      ? tools.filter((t) => t.name.toLowerCase().includes(term))
      : tools;
    if (matched.length === 0) continue;
    console.log(`\n${svc}  (${matched.length})`);
    for (const t of matched) {
      console.log(`  ${t.name}`);
      const d = firstLine(t.description, 76);
      if (d) console.log(`      ${d}`);
    }
  }
}

const USAGE = `ptool — call any Papercusp defineTool endpoint from the terminal.

  ptool                         interactive: pick service → endpoint → args
  ptool <group:verb>            skip the pickers, prompt for that tool's args
  ptool <group:verb> --json '<args>'   call directly with a JSON args object
  ptool --list [filter]         print the catalog (optionally name-filtered)

Flags:
  --json <json> / --args <json>   args object for a direct (non-interactive) call
  --workspace <ws>                scope the session (needed for harness:*, features:*, …)
  --harness <slug>                scope the session to a harness
  --raw                           print the raw result text (no JSON pretty-print)
  --url=<http://host:port>        operator URL (default $PAPERCUSP_OPERATOR_URL or :3070)
  -h, --help                      this help
`;

async function pickService(grouped) {
  const { search } = await import('@inquirer/prompts');
  const rows = [...grouped.entries()].map(([svc, tools]) => ({
    name: `${svc}  (${tools.length})`,
    value: svc,
  }));
  return search({
    message: 'Service',
    source: async (term) => {
      const t = (term || '').toLowerCase();
      return t ? rows.filter((r) => r.value.toLowerCase().includes(t)) : rows;
    },
  });
}

async function pickEndpoint(tools) {
  const { search } = await import('@inquirer/prompts');
  const rows = tools.map((t) => ({
    name: t.name + (firstLine(t.description) ? `  —  ${firstLine(t.description)}` : ''),
    value: t.name,
  }));
  return search({
    message: 'Endpoint',
    source: async (term) => {
      const t = (term || '').toLowerCase();
      return t ? rows.filter((r) => r.value.toLowerCase().includes(t)) : rows;
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const operatorUrl = args.url || OPERATOR_URL;
  const client = await connect(operatorUrl, { workspace: args.workspace, harness: args.harness });
  try {
    const tools = await listAllTools(client);
    const grouped = groupTools(tools);
    const byName = new Map(tools.map((t) => [t.name, t]));

    if (args.list) {
      printCatalog(grouped, args.listFilter);
      return;
    }

    // Resolve the target tool: named on the CLI, or picked interactively.
    let toolName = args.tool;
    if (!toolName) {
      const svc = await pickService(grouped);
      toolName = await pickEndpoint(grouped.get(svc));
    }
    const tool = byName.get(toolName);
    if (!tool) {
      console.error(`ptool: no tool named "${toolName}". Try \`ptool --list ${serviceOf(toolName)}\`.`);
      process.exit(1);
    }

    // Assemble args: explicit --json, else interactive prompting.
    let callArgs;
    if (args.json != null) {
      try {
        callArgs = JSON.parse(args.json);
      } catch (e) {
        console.error(`ptool: --json is not valid JSON: ${e.message}`);
        process.exit(1);
      }
    } else {
      callArgs = await collectArgs(tool.inputSchema);
    }
    callArgs = mergeConvenienceArgs(callArgs, { workspace: args.workspace, harness: args.harness }, tool.inputSchema);

    // Interactive confirmation (only when we prompted — a scripted --json
    // call is non-interactive by intent).
    if (args.json == null && !args.tool) {
      const { confirm } = await import('@inquirer/prompts');
      console.error(`\n→ ${toolName}  ${JSON.stringify(callArgs)}`);
      const go = await confirm({ message: 'Call it?', default: true });
      if (!go) {
        console.error('ptool: cancelled');
        return;
      }
    } else {
      console.error(`→ ${toolName}  ${JSON.stringify(callArgs)}`);
    }

    const result = await client.callTool({ name: toolName, arguments: callArgs });
    const code = printResult(result, { raw: args.raw });
    if (code !== 0) process.exitCode = code;
  } finally {
    await client.close().catch(() => {});
  }
}

// Symlink-robust CLI-entry check (WI-1443): node realpaths the entry module's
// import.meta.url while argv[1] keeps the invoked path, so through a symlinked
// checkout (papercup -> papercusp, as the on-PATH `ptool` shim does) the naive
// === is false and main() silently never runs (exit 0, zero output).
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    // @inquirer throws ExitPromptError on Ctrl+C — treat as a clean cancel.
    if (e && (e.name === 'ExitPromptError' || /force closed/i.test(e.message || ''))) {
      console.error('ptool: cancelled');
      process.exit(130);
    }
    const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e));
    console.error('ptool: ' + msg);
    process.exit(1);
  });
}
