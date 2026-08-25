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
 * the `PAPERCUSP_HOME/superuser-token` (or `~/.papercusp/superuser-token`)
 * bearer). That transport already
 * exposes every projected `defineTool` with its `inputSchema` and runs at
 * operator tier (role/capability/quota gates bypassed), so ptool needs no
 * server-side support: discovery (`tools/list`) and invocation
 * (`tools/call`) both ride it.
 *
 * Sibling to `psu` (psu-launcher.mjs) — same conventions: lives in the repo
 * so it resolves `@inquirer/prompts` + the MCP SDK from the operator's
 * node_modules; the on-PATH `ptool` shim (install-standalone-mcp.sh) is a
 * plain `exec node <this file>` — deliberately NOT behind the install:safe
 * mutex, whose reader guard could swallow a completed invocation into an
 * exit-0/near-zero-output no-op (EI-21267836337650976 /
 * EI-21250765620092599); `PAPERCUSP_OPERATOR_URL`
 * overrides the host; the token is read from `--token-file`, then
 * `PAPERCUSP_MCP_TOKEN_FILE`, then `PAPERCUSP_HOME/superuser-token`, then
 * `~/.papercusp/superuser-token`.
 *
 * Interactive:  ptool
 *               ptool <group:verb>                 # skip the pickers, prompt args
 * Scripting:    ptool <group:verb> --json - <<'EOF'          # read JSON from stdin (safe; raw controls in strings are escaped)
 *               {"copy": "it's fine now"}
 *               EOF
 *               ptool <group:verb> --json-file payload.json   # read JSON from a file (safe)
 *               ptool <group:verb> --json '{...}'            # quote-free inline payloads only
 *               ptool code:run --script-file batch.js     # carry script as file data
 *               ptool code:run --script - <<'EOF'          # carry script as stdin data
 *               return await tools.dev.build_status({});
 *               EOF
 *               ptool --list [filter]              # print the catalog
 *               ptool <group:verb> --workspace=<ws> --harness=<slug>
 *
 * Prefer `--json -` (read stdin) or `--json-file <path>` for arbitrary payloads,
 * especially `loop:checkpoint` checks/walls whose recheck text commonly contains
 * shell quotes. Literal control characters inside quoted JSON strings (for example
 * a multiline decision body) are escaped before parsing; a `--json '<inline>'` argument asks the SHELL to carry the JSON
 * through a single-quoted argument — any apostrophe in the payload (a normal
 * English string like "it's") terminates that shell quoting early and the tool
 * never sees valid JSON (EI-14958). For `code:run`, use `--script -` or
 * `--script-file <path>` to carry JavaScript source as data; prefer these for
 * scripts containing nested shell commands, substitutions, or quoted strings.
 *
 * When launched inside a tracked psu session, ptool carries PAPERCUSP_SID as
 * the MCP `client=` identity. That makes it a safe transport fallback when a
 * client has connected to papercusp-su but deferred every MCP tool schema:
 * calls still belong to the current session rather than the shared
 * `su-loopback` fallback identity. Workspace scope is resolved from the
 * explicit flag first, then the session environment/path, so a warm-loop wake
 * whose shell lost `PAPERCUSP_WORKSPACE` does not silently fall back to the
 * default workspace. MCP payloads use the trimmed context tier by default,
 * matching psu launches; set `PAPERCUSP_CONTEXT_TIER=full` for the explicit
 * unshaped-payload escape hatch.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PSU_REQUEST_TIMEOUT_MS } from '../lib/mcp-proxy/budgets.mjs';
import { resolveOperatorBase } from './operator-discovery.mjs';

/** @typedef {Record<string, string | undefined>} EnvironmentMap */
/** @typedef {{name: string, description?: string, inputSchema?: Record<string, unknown>}} ToolCatalogEntry */

// env → ~/.papercusp/operator.json (packaged installs run the operator on a
// per-boot dynamic port; :3070 is dev-box-only) → dev fallback.
const OPERATOR_URL = resolveOperatorBase({}, process.env);

/* ─── arg parsing (pure — exported for tests) ─────────────────────────── */

/**
 * Parse argv into the ptool invocation shape. The first non-flag positional
 * is the tool name (`group:verb`); everything else is a flag. Pure.
 */
export function parseArgs(argv = []) {
  const out = {
    tool: null,
    json: null,
    jsonFile: null,
    script: null,
    scriptFile: null,
    list: false,
    listFilter: null,
    workspace: null,
    harness: null,
    projection: null,
    idempotencyKey: null,
    raw: false,
    url: null,
    tokenFile: null,
    help: false,
  };
  // Value-bearing flags accept BOTH `--flag=value` and `--flag value`. Map a
  // flag name to the out-key it sets (`--args` is an alias for `--json`).
  const valueFlags = {
    '--json': 'json',
    '--args': 'json',
    '--json-file': 'jsonFile',
    '--script': 'script',
    '--script-file': 'scriptFile',
    '--workspace': 'workspace',
    '--harness': 'harness',
    '--projection': 'projection',
    '--idempotency-key': 'idempotencyKey',
    '--url': 'url',
    '--token-file': 'tokenFile',
  };
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

/**
 * Resolve the workspace scope for a ptool session. An explicit CLI flag wins;
 * otherwise mirror the OMP coordination hook's session-local resolution:
 * `PAPERCUSP_WORKSPACE`, then the workspace name embedded in
 * `PAPERCUSP_HOME`/cwd. Returning null when no tracked scope is available is
 * deliberate — ptool must never guess a tenant. Pure when `env` and `cwd` are
 * supplied; both are injectable for tests.
 * @param {{workspace?: string | null, env?: EnvironmentMap, cwd?: string}} [options]
 * @returns {string | null}
 */
export function resolveWorkspaceScope({ workspace = null, env = process.env, cwd } = {}) {
  const explicit = typeof workspace === 'string' ? workspace.trim() : '';
  if (explicit) return explicit;

  const fromEnv = typeof env?.PAPERCUSP_WORKSPACE === 'string' ? env.PAPERCUSP_WORKSPACE.trim() : '';
  if (fromEnv) return fromEnv;

  let currentDir = typeof cwd === 'string' ? cwd : '';
  if (!currentDir) {
    try {
      currentDir = process.cwd();
    } catch {
      currentDir = '';
    }
  }
  for (const candidate of [env?.PAPERCUSP_HOME ?? '', currentDir]) {
    const match = String(candidate).match(/\.papercusp-workspaces[\\/]([^\\/]+)/);
    if (match?.[1] && match[1] !== '.papercusp') return match[1];
  }
  return null;
}

/**
 * Resolve the harness scope for a ptool session. An explicit CLI flag wins;
 * otherwise inherit the harness exported by a tracked su/psu session. A
 * missing harness stays null deliberately — ptool must not guess a project
 * when the caller is not harness-scoped.
 * @param {{harness?: string | null, env?: EnvironmentMap}} [options]
 * @returns {string | null}
 */
export function resolveHarnessScope({ harness = null, env = process.env } = {}) {
  const explicit = typeof harness === 'string' ? harness.trim() : '';
  if (explicit) return explicit;

  const fromEnv = typeof env?.PAPERCUSP_HARNESS_SLUG === 'string'
    ? env.PAPERCUSP_HARNESS_SLUG.trim()
    : '';
  return fromEnv || null;
}

/**
 * Resolve the MCP payload tier for a ptool session. Direct ptool invocations
 * do not inherit psu's URL interpolation, so they must carry the same bounded
 * default themselves. `PAPERCUSP_CONTEXT_TIER=full` is the explicit escape
 * hatch for callers that need the unshaped response. Pure when `env` is
 * supplied; values are passed through so the server remains the authority for
 * the supported tier vocabulary.
 * @param {{contextTier?: string | null, env?: EnvironmentMap}} [options]
 * @returns {string}
 */
export function resolveContextTier({ contextTier = null, env = process.env } = {}) {
  const explicit = typeof contextTier === 'string' ? contextTier.trim() : '';
  if (explicit) return explicit;

  const fromEnv = typeof env?.PAPERCUSP_CONTEXT_TIER === 'string'
    ? env.PAPERCUSP_CONTEXT_TIER.trim()
    : '';
  return fromEnv || 'trimmed';
}

/**
 * Decide where a ptool invocation's JSON args payload comes from, given
 * parsed args. Pure — the actual file/stdin read is impure and lives in
 * `main()`; this just picks the source so the branching is testable without
 * a real filesystem/stdin (EI-14958: a shell-quoted `--json '<inline>'`
 * cannot safely carry an apostrophe, so `file`/`stdin` exist as quoting-free
 * alternatives).
 *   'file'   — `--json-file <path>` was given (takes priority over --json).
 *   'stdin'  — `--json -` (the literal dash sentinel).
 *   'inline' — a normal `--json '<...>'` / `--args '<...>'` value.
 *   null     — no JSON source given; caller should prompt interactively.
 */
export function jsonSourceKind(args) {
  if (args.jsonFile) return 'file';
  if (args.json === '-') return 'stdin';
  if (args.json != null) return 'inline';
  return null;
}

/**
 * Escape literal JSON control characters that occur inside quoted strings.
 * JSON requires those characters to be represented as escapes, but a heredoc
 * is a natural way to author a multiline tool argument and users should not
 * have to hand-escape every line break. Formatting whitespace outside strings
 * is left untouched, as are already-escaped sequences. Pure.
 * @param {string} text
 * @returns {string}
 */
export function escapeJsonStringControls(text) {
  if (typeof text !== 'string') return String(text);

  let inString = false;
  let escaped = false;
  let changed = false;
  let repaired = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (inString) {
      if (escaped) {
        repaired += ch;
        escaped = false;
      } else if (ch === '\\') {
        repaired += ch;
        escaped = true;
      } else if (ch === '"') {
        repaired += ch;
        inString = false;
      } else if (code < 0x20) {
        repaired += `\\u${code.toString(16).padStart(4, '0')}`;
        changed = true;
      } else {
        repaired += ch;
      }
    } else {
      repaired += ch;
      if (ch === '"') inString = true;
    }
  }

  return changed ? repaired : text;
}

/** Parse a ptool JSON payload after normalizing heredoc-friendly string controls. Pure. */
export function parseJsonInput(text) {
  return JSON.parse(escapeJsonStringControls(text));
}

/**
 * Decide where a direct `code:run` script comes from. The file/stdin forms
 * carry JavaScript as data, so the caller's shell never has to quote nested
 * commands or apostrophes (EI-20235746813390458). `--script-file` takes
 * priority over `--script`, mirroring jsonSourceKind's file precedence.
 * Pure — the actual file/stdin read is impure and lives in main().
 *
 *   'file'   — `--script-file <path>` was given.
 *   'stdin'  — `--script -` was given.
 *   'inline' — a normal `--script '<source>'` value.
 *   null     — no direct script source was given.
 */
export function scriptSourceKind(args) {
  if (args.scriptFile) return 'file';
  if (args.script === '-') return 'stdin';
  if (args.script != null) return 'inline';
  return null;
}

/**
 * Decide whether the human-readable invocation line belongs on stderr.
 * Scripted JSON mode must leave stdout/stderr suitable for machine capture;
 * interactive calls retain the line as useful operator feedback. Pure.
 */
export function shouldPrintInvocationLine(jsonKind) {
  return jsonKind == null;
}

/**
 * Scripted JSON calls must keep stdout machine-parseable. The MCP response may
 * contain advisory text after its primary JSON content, so every explicit JSON
 * input uses the raw extractor even when the caller did not spell `--raw`.
 * Interactive calls retain the existing pretty human-readable output unless
 * `--raw` was explicitly requested.
 */
export function shouldPrintRawResult(jsonKind, raw) {
  return Boolean(raw || jsonKind != null);
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
 * @param {ToolCatalogEntry[]} tools
 * @returns {Map<string, ToolCatalogEntry[]>}
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
 * @param {Record<string, unknown>} args
 * @param {{workspace?: unknown, harness?: unknown}} convenience
 * @param {{properties?: Record<string, unknown>} | null | undefined} inputSchema
 * @returns {Record<string, unknown>}
 */
export function mergeConvenienceArgs(args, { workspace, harness }, inputSchema) {
  const props = (inputSchema && inputSchema.properties) || {};
  const out = { ...args };
  if (workspace != null && 'workspace' in props && !('workspace' in out)) out.workspace = workspace;
  if (harness != null && 'harness' in props && !('harness' in out)) out.harness = harness;
  return out;
}

/**
 * Add a caller-owned result projection to a direct tool call. The MCP
 * transport reserves `projection` at the dispatch layer, so it must travel
 * alongside the target tool's ordinary arguments rather than being dropped
 * by the CLI parser. An explicit projection already present in JSON wins,
 * matching mergeConvenienceArgs' preserve-explicit-args behavior. Pure.
 */
export function mergeDispatchProjection(args, projection) {
  if (projection === undefined) return args;
  if (args && typeof args === 'object' && !Array.isArray(args) && Object.hasOwn(args, 'projection')) {
    return args;
  }
  const base = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return { ...base, projection };
}

/* ─── result formatting (pure — exported for tests) ───────────────────── */

/**
 * Repair JSON text whose string values contain literal control characters.
 * A tool can return JSON in an MCP text content block, and printing that text
 * unchanged makes `ptool --raw | jq` reject the whole result. Only escape
 * controls found inside structurally quoted spans; preserve ordinary human
 * text and malformed JSON that contains no such controls verbatim. The result
 * door may truncate otherwise-valid JSON, so whole-document validity cannot be
 * a prerequisite for repairing the visible prefix.
 */
export function sanitizeJsonText(text) {
  if (typeof text !== 'string') return String(text);
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[' && first !== '"') return text;

  try {
    JSON.parse(text);
    return text;
  } catch {
    // Continue only for the known text-content serialization defect below.
  }

  return escapeJsonStringControls(text);
}

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

/**
 * Find a complete JSON value at the start of a text block. The MCP result
 * door can append its guidance/truncation notice to the SAME text item as an
 * otherwise-complete JSON payload, so parsing the whole item is too strict.
 * A structurally complete root is safe to return; an actually truncated
 * object/array never reaches a closing root and remains fail-closed. Pure.
 */
function completeJsonPrefix(text) {
  if (typeof text !== 'string') return null;
  const start = text.search(/\S/);
  if (start < 0) return null;
  const first = text[start];

  // Object/array roots need a structural scan so braces inside quoted values
  // and nested containers do not masquerade as the document boundary.
  if (first === '{' || first === '[') {
    const stack = [first === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    for (let i = start + 1; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') {
        if (stack.at(-1) !== ch) return null;
        stack.pop();
        if (stack.length === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  // JSON string roots are uncommon for tool results, but escaped quotes must
  // not terminate the value early.
  if (first === '"') {
    let escaped = false;
    for (let i = start + 1; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  // Scalar roots end at the first whitespace before any appended guidance.
  const end = text.search(/\s/, start + 1);
  const candidate = text.slice(start, end < 0 ? text.length : end);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** Prefer the complete structured result requested by ptool, then fall back to
 *  flattening an MCP tools/call result's `content[]` into one text blob.
 *  Content text may carry result-door truncation markers and is therefore a
 *  human-readable fallback, not the scripting authority. Pure.
 *  @param {any} result
 *  @param {{raw?: boolean}} [options]
 */
export function resultToText(result, { raw = false } = {}) {
  if (result && Object.prototype.hasOwnProperty.call(result, 'structuredContent')) {
    const structuredText = JSON.stringify(result.structuredContent);
    if (typeof structuredText === 'string') return structuredText;
  }

  const parts = Array.isArray(result?.content) ? result.content : [];
  const textParts = parts
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);
  const contentText = parts
    .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');

  // MCP guidance is appended as a separate text item (for example, the
  // `See also:` block on loop:status). It is useful in the interactive
  // display, but contaminates stdout for `ptool --raw | jq`. If the joined
  // body is not JSON, recover the first complete JSON text item as the
  // scripting payload. Sanitize before parsing because tool text can contain
  // literal control characters (see sanitizeJsonText below).
  if (raw) {
    const primaryJson = textParts.find((text) => {
      const sanitized = sanitizeJsonText(text);
      try {
        JSON.parse(sanitized);
        return true;
      } catch {
        return completeJsonPrefix(sanitized) !== null;
      }
    });
    if (primaryJson !== undefined) {
      const sanitized = sanitizeJsonText(primaryJson);
      try {
        JSON.parse(sanitized);
        return sanitized;
      } catch {
        return completeJsonPrefix(sanitized) ?? primaryJson;
      }
    }
  }

  return contentText;
}

/**
 * The result door can splice its truncation notice into a text block before
 * ptool sees it. That leaves a JSON-looking prefix which is not a document;
 * never let that prefix reach a machine-readable stdout stream.
 */
const RESULT_DOOR_TRUNCATION_RE = /\[result-door:[\s\S]{0,2000}\btruncated\b/i;

/**
 * A result-door truncation only tells ptool that the operator's reply is not
 * machine-readable. The tool call may already have executed, which is
 * especially important for writes: retrying blindly can duplicate a
 * non-idempotent mutation. Keep the recovery instruction about execution
 * uncertainty rather than inventing a query/jq pipeline that may not exist.
 */
export const PTOOL_TRUNCATED_RESULT_MESSAGE =
  'ptool: operator reply was truncated before a complete JSON payload; the tool call may have executed — verify its state before retrying. ' +
  'For a large read, retry with a dispatch-level `projection` in the JSON args using paths from the actual payload root; `plans:items` uses `items[].item.id`, `items[].item.status`, and `items[].item.workItemId`. ' +
  'use `payloadTier:"full"` only when you need the unshaped detail and it fits the transport.';

function isInvalidTruncatedJson(text) {
  if (!RESULT_DOOR_TRUNCATION_RE.test(text)) return false;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

/* ─── runtime (impure) ────────────────────────────────────────────────── */

/** Resolve the bearer-token files in precedence order. Pure and injectable for
 * tests: an explicit CLI path wins over the environment. When an isolated
 * `PAPERCUSP_HOME` is configured, its token is preferred, but the normal
 * per-home token remains a fallback when the isolated file is absent. A su
 * session can carry the workspace-scoped HOME even though the shared
 * superuser bearer still lives at `~/.papercusp/superuser-token` (EI-202457).
 * @param {{tokenFile?: string|null, env?: EnvironmentMap, home?: string}} [options]
 */
export function resolveTokenPaths({ tokenFile = null, env = process.env, home = homedir() } = {}) {
  const explicit = typeof tokenFile === 'string' ? tokenFile.trim() : '';
  if (explicit) return [explicit];

  const fromEnv = typeof env?.PAPERCUSP_MCP_TOKEN_FILE === 'string'
    ? env.PAPERCUSP_MCP_TOKEN_FILE.trim()
    : '';
  if (fromEnv) return [fromEnv];

  // Packaged and isolated operators set PAPERCUSP_HOME to the directory that
  // owns operator.json, embedded-pg.json, and superuser-token. Falling back to
  // homedir() here sends the host user's token to an isolated endpoint, which
  // is rejected as superuser_invalid_bearer even though the endpoint is live.
  const isolatedHome = typeof env?.PAPERCUSP_HOME === 'string' ? env.PAPERCUSP_HOME.trim() : '';
  const isolated = isolatedHome ? join(isolatedHome, 'superuser-token') : null;
  const shared = join(home, '.papercusp', 'superuser-token');
  return isolated && isolated !== shared ? [isolated, shared] : [shared];
}

/** Resolve the first bearer-token candidate for callers that need one path.
 * @param {{tokenFile?: string|null, env?: EnvironmentMap, home?: string}} [options]
 */
export function resolveTokenPath(options = {}) {
  return resolveTokenPaths(options)[0];
}

function readToken({ tokenFile = null, env = process.env, home = homedir() } = {}) {
  for (const tokenPath of resolveTokenPaths({ tokenFile, env, home })) {
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      if (token) return token;
    } catch {
      // Try the next candidate. The isolated workspace token is optional for
      // sessions whose shared superuser bearer is still in the host home.
    }
  }
  return '';
}

/** Build the `tools/call` params for a ptool invocation. Pure and exported so
 *  the MCP result negotiation is regression-tested without opening a
 *  transport. Object-rooted output schemas need `_meta.structured` because
 *  the MCP SDK validates their structured response field (EI-13245), EXCEPT
 *  when the caller supplied a dispatch-level `projection`: the projection
 *  deliberately drops the unprojected structured twin so it cannot defeat the
 *  requested reduction. Projected calls therefore negotiate JSON text and use
 *  the schema-neutral request path in callToolWithPressureRetry below.
 *  Array-rooted tools deliberately omit `outputSchema` because MCP requires
 *  `structuredContent` to be an object; ask those tools for JSON text instead
 *  so ptool still emits a lossless scripting payload.
 *  @param {string} toolName
 *  @param {any} callArgs
 *  @param {{outputSchema?: {type?: string}, idempotencyKey?: string}} [options]
 */
export function buildCallToolParams(toolName, callArgs, { outputSchema, idempotencyKey } = {}) {
  const projected = Boolean(
    callArgs &&
    typeof callArgs === 'object' &&
    !Array.isArray(callArgs) &&
    Object.hasOwn(callArgs, 'projection'),
  );
  const objectRooted = outputSchema?.type === 'object' && !projected;
  const meta = objectRooted ? { structured: true } : { format: 'json' };
  if (idempotencyKey) meta.idempotencyKey = idempotencyKey;
  return {
    name: toolName,
    arguments: callArgs,
    _meta: meta,
  };
}

// `tools/list` is a recovery prerequisite for every named ptool call, but it
// is still a remote MCP request and can stall while the operator is under
// pressure. Do not inherit the SDK's 60s default: a CLI that produces no
// output for a minute looks indistinguishable from a dead operator.
export const PTOOL_LIST_TOOLS_TIMEOUT_MS = 10_000;

// The default dev-box endpoint is the resilient MCP proxy. It deliberately
// holds an initialize request through a :3070 restart for up to 90s, then
// returns a typed 503 when that window is exhausted. A shorter client-side
// handshake deadline abandons that response and turns the proxy's bounded
// failure into an opaque retry loop. Reuse the same client/proxy budget psu
// already owns instead of choosing another independent number here.
export const PTOOL_CONNECT_TIMEOUT_MS = PSU_REQUEST_TIMEOUT_MS;

// A named tools/call can otherwise inherit the MCP SDK's 60s timeout, and a
// saturated default operator route can produce no output at all while that
// request is outstanding. Keep the CLI liveness bound below the observed
// stand-down failure window; callers can still opt out for a deliberately
// long-running call by passing timeoutMs: 0 to the exported helper.
export const PTOOL_CALL_TOOL_TIMEOUT_MS = 30_000;

// `fleet:launch-on-plan` opens terminals/processes in waves and then waits for
// bounded first-turn verification. A five-member visible wave has measured
// multi-minute completion time under fleet load; keep ptool from abandoning the
// call at its ordinary 30s ceiling while the server is still doing real work.
export const PTOOL_FLEET_LAUNCH_ON_PLAN_TIMEOUT_MS = 300_000;

// EI-21388931083718076: `fleet:respawn-member` is a bounded drain + relaunch +
// verify orchestration that declares `timeoutSec: 660` server-side
// (RESPAWN_TIMEOUT_SEC, packages/operator-core/lib/agent-tools/fleet_registry/
// respawn-member.ts — EI-21266158571232094 deliberately aligned the dispatch
// stack AND the MCP transport deadline to that same 660s budget, +5s transport
// buffer = 665s effective). The CLIENT was never aligned: the flat 30s deadline
// aborted five concurrent respawns as MCP -32001 outcome-unknown while every one
// of them completed ok server-side at ~29–33s (tool_invocations, 2026-08-25).
// A client deadline tighter than the server's just aborts calls the server would
// have completed (see PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS above and
// /internal/docs/agent-insights/ptool-client-timeout-must-outlive-tool-server-clamp);
// keep it above the 665s effective MCP deadline so the tool's own typed
// success / verified-failure / timeout is always the first outcome observed.
export const PTOOL_RESPAWN_MEMBER_TIMEOUT_MS = 675_000;

// `git-sync:run` is an acknowledged long-running call: its server handler
// bounds the sync fire at 45s and may spend up to 5s each reading HEAD before
// and after that fire. Keep the normal ptool liveness ceiling for ordinary
// calls, but give this mutation enough time to return its durable `in_progress`
// continuation instead of cutting the MCP request off at 30s.
export const PTOOL_GIT_SYNC_RUN_TIMEOUT_MS = 60_000;

// `backup:snapshot_create` has the same continuation contract: its handler
// races the heavyweight kopia snapshot against 45s, then returns the durable
// `snapshotId` while the snapshot continues. The ordinary 30s ptool ceiling
// otherwise wins first and turns a successful, observable mutation into an
// ambiguous transport timeout (EI-20477679208771292).
export const PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS = 60_000;

// `templates:new-app` composes a full pot:create before overlaying the
// template. Under real operator pressure the inner create alone has taken
// 111s. A 30s client deadline is unsafe here: the old reconnect path replayed
// the same still-running write before its result receipt existed.
// EI-21107910194803524: raised 300s -> 900s. The 111s figure above was a baseline,
// not a worst case: a real materialization on 2026-08-21 spent ~290s in pot:create
// alone under fleet load (~55 load average), leaving no room for the template
// overlay inside a 300s client deadline. The server-side budgets were raised to
// 900s to match; a client deadline TIGHTER than the server's just aborts calls the
// server would have completed, which is the failure this constant exists to prevent.
export const PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS = 900_000;

// `scorecards:emit` is also intentionally long-running. Its deterministic
// criterion-check leg owns a 120s test budget inside a 180s tool timeout, then
// still has to persist the card and serialize the response. The ordinary 30s
// ptool deadline abandons that write mid-flight and returns no canonical card
// reference (EI-21179169504957086). Keep the client outside the tool's own
// deadline so the typed success/refusal is always the first outcome observed.
export const PTOOL_SCORECARD_EMIT_TIMEOUT_MS = 195_000;

// EI-21106949380687332: a FOREGROUND-capable tool (testing:run, build:typecheck,
// capability:bash, capability:inspect, code:run) self-clamps its OWN command timeout to
// FOREGROUND_TIMEOUT_CEILING_MS (50s — packages/operator-core/lib/agent-tools/capability/
// foreground-transport-cap.ts) precisely so it can return an actionable "re-run detached"
// hint (with the run's own id) BEFORE the MCP transport's ~55s hard cap (MCP_TRANSPORT_CAP_MS)
// kills the call outright. That design was defeated here: a caller's `timeoutMs` ARGUMENT only
// bounds the SERVER-side handler — it has no effect on THIS CLIENT's own request deadline,
// which fell through to the flat PTOOL_CALL_TOOL_TIMEOUT_MS (30s) regardless of what was asked
// for. So `testing:run { timeoutMs: 240000 }` on a genuinely slow file was abandoned by ptool at
// 30s — before the tool's own 50s self-timeout, let alone the transport's 55s hard cap, could
// ever return — surfacing as an opaque MCP -32001 with no runId delivered, even though the
// handler was executing exactly as designed and its response already carries one. Give every
// tool that applies this clamp (see foreground-transport-cap.test.ts's own enumeration) a client
// deadline that outlives the transport's hard cap with margin, so ptool always sees whichever
// server-side outcome fires first — the tool's actionable hint, or (rarer) the transport's own
// cutoff — instead of pre-empting both.
export const PTOOL_FOREGROUND_TOOL_TIMEOUT_MS = 60_000;

// `events:await` performs a write-side registration after several bounded,
// best-effort state/catalog probes. Under a busy operator those probes can
// legitimately outlive ptool's ordinary 30s deadline; abandoning the call
// then leaves an ambiguous waiter registration that callers may blindly
// retry. Keep the client outside the MCP transport cap so the server's
// structured registration result (or timeout) is observed first.
export const PTOOL_EVENTS_AWAIT_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// `plans:get` is the durable plan-read path used during agent wake/bootstrap. A large
// nested plan response can spend ~28.5s through the MCP proxy even when the direct
// operator read is healthy; the ordinary 30s ptool deadline turns that slow-but-valid
// wrapped read into an ambiguous tools:invoke timeout. Keep the client deadline above
// the observed proxy path without changing the ordinary deadline for unrelated tools.
export const PTOOL_PLANS_GET_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// `work_items:get` performs several independent checkpoint, holder, plan-lane,
// prior-work, and lifecycle reads. Under a busy fleet that compound read can
// outlive the ordinary 30s ptool deadline, especially through tools:invoke;
// keep its client budget aligned with the other durable coordination reads
// (EI-21281814895308307).
export const PTOOL_WORK_ITEMS_GET_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// `locks:heartbeat_resource` may heartbeat multiple lock ids sequentially and
// probe the caller plus special coordination domains for each id. Under a
// serialized package build, each transaction can consume the configured
// contention window; the ordinary 30s ptool deadline can therefore abandon a
// still-running heartbeat batch before its per-lock results are returned.
export const PTOOL_HEARTBEAT_RESOURCE_TIMEOUT_MS = 60_000;

const PTOOL_LONG_RUNNING_TIMEOUTS_MS = new Map([
  ['fleet:launch-on-plan', PTOOL_FLEET_LAUNCH_ON_PLAN_TIMEOUT_MS],
  ['fleet:respawn-member', PTOOL_RESPAWN_MEMBER_TIMEOUT_MS],
  ['git-sync:run', PTOOL_GIT_SYNC_RUN_TIMEOUT_MS],
  ['backup:snapshot_create', PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS],
  ['templates:new-app', PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS],
  ['scorecards:emit', PTOOL_SCORECARD_EMIT_TIMEOUT_MS],
  ['testing:run', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['build:typecheck', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['capability:bash', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['capability:inspect', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21314560074357302: an exact capability:launch-agent resume resolves
  // the target session and saved fleet profile before the headless boot/receipt
  // probe. The ordinary 30s client deadline can expire while that bounded
  // server-side work is still running, especially through tools:invoke. Keep
  // the client outside the MCP transport cap so it observes the typed result
  // instead of returning an ambiguous may-have-executed timeout.
  ['capability:launch-agent', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['code:run', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // Provisioning starts Xvfb, waits for the display, and may launch a window
  // manager plus apps. The ordinary 30s client deadline can return an
  // ambiguous timeout while the lease is still being created; keep the
  // caller outside the transport cap so it receives the structured result.
  ['computer:provision_desktop', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['events:await', PTOOL_EVENTS_AWAIT_TIMEOUT_MS],
  ['plans:get', PTOOL_PLANS_GET_TIMEOUT_MS],
  // EI-21360596114670049: the idempotent plan lifecycle writer evaluates the
  // full completion/audit/spec/rubric gate before taking the plan lock. Under
  // operator pressure that valid pre-write path can outlive the flat 30s
  // client budget. Keep ptool outside the MCP transport cap so callers observe
  // the typed verdict (or idempotent reconciliation) instead of an ambiguous
  // may-have-executed timeout.
  ['plans:set-plan-status', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['work_items:get', PTOOL_WORK_ITEMS_GET_TIMEOUT_MS],
  // EI-21386877660531420: activity:tool-log scans and compacts the activity
  // ledger. In a concurrent projected batch that read can outlive ptool's
  // ordinary 30s deadline even though it is bounded and still progressing.
  // Keep the client outside the transport cap so tools:invoke returns the
  // structured log instead of an ambiguous MCP -32001.
  ['activity:tool-log', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21386877660531420: release:deploy status fans out through the release
  // pipeline and has a 20s server-side status bound. The dispatch queue and
  // projection overhead can consume the ordinary 30s client budget when it
  // runs beside other compound reads; preserve its typed status envelope.
  ['release:deploy', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21385061122156093: these durable writers can each spend the full
  // coordination/serialization window before returning their receipt. A 30s
  // client cutoff abandoned all three calls in one concurrent batch; loop's
  // writer was already covered below, so keep the other two on the same 60s
  // budget and preserve the server's typed result or timeout envelope.
  ['events:cancel', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['work_items:checkpoint', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21269176538636068: these continuity/control-plane calls perform
  // multi-leg coordination reads or writes of their own. Under pool
  // contention they can legitimately outlive the ordinary 30s ptool
  // deadline; cutting the request off first turns a valid typed result into
  // an ambiguous blank/transport failure. Keep the caller outside the MCP
  // transport cap so the server-side result remains observable.
  ['loop:checkpoint', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['loop:end', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['loop:status', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['improvements:capture', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // `coord:orient` is the wake-bootstrap compound read. Its individual legs
  // are bounded, but the full reconciliation can legitimately outlive the
  // ordinary 30s ptool liveness deadline when several legs degrade together.
  // Keep the client deadline above the server transport cap so the caller
  // observes the orient result or its structured fallback instead of an
  // ambiguous client-side -32001 timeout.
  ['coord:orient', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // `release:trace` composes candidate, gate, deploy, and await reads. Under
  // operator pressure that read-only bundle can outlive the ordinary 30s
  // client budget even though it is still progressing; keep the typed trace
  // result observable instead of surfacing an opaque MCP -32001.
  ['release:trace', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21310243062797569: fleet:assignments fans out across presence,
  // claims, and liveness reads. During a BYOC live recheck that placement
  // read can outlive the ordinary 30s client deadline even though the
  // operator is still working and will return a valid response. Keep the
  // ptool client outside the long-read budget so it reports the tool's
  // structured result instead of an ambiguous MCP -32001 timeout.
  ['fleet:assignments', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // `coord:presence` is the live roster read and may enrich rows with
  // coordination/liveness/coupling state. Its bounded multi-leg read can
  // exceed the ordinary 30s client budget during a busy fleet; preserve the
  // server's structured roster or typed timeout instead of -32001.
  ['coord:presence', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21276159817895096: `db:migrate` declares a 1020s server-side timeout,
  // but the client must stay above the MCP transport cap to observe its
  // structured verdict instead of cutting the request off at 30s. The
  // foreground budget is the smallest existing client deadline that does so.
  ['db:migrate', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['locks:heartbeat_resource', PTOOL_HEARTBEAT_RESOURCE_TIMEOUT_MS],
]);

/**
 * @param {string} toolName
 * @param {(Record<string, unknown> & {name?: string}) | undefined} [callArgs]
 */
export function timeoutForTool(toolName, callArgs) {
  // Deferred callers may route the same logical call through tools:invoke.
  // Honor the inner tool's contract there too; budgeting only the wrapper name
  // would recreate the 30s cutoff on the sanctioned fallback path.
  const effectiveToolName = toolName === 'tools:invoke' && typeof callArgs?.name === 'string'
    ? callArgs.name
    : toolName;
  return PTOOL_LONG_RUNNING_TIMEOUTS_MS.get(effectiveToolName) ?? PTOOL_CALL_TOOL_TIMEOUT_MS;
}

/**
 * P-010 admission control may reject a tools/call before dispatch when the
 * operator event loop is critically saturated. That refusal is explicitly
 * retry-safe: the tool never ran. Normal agent traffic traverses mcp-proxy,
 * which absorbs this signal; ptool can connect directly to :3170 during
 * staging/release recovery, so it must provide the same bounded absorption.
 */
export function isLoopPressureShed(error) {
  const text = String(error?.message ?? error ?? '');
  return /loop_pressure_critical|event loop critically saturated/i.test(text);
}

function errorDetail(error) {
  if (error instanceof Error) {
    const message = error.message || error.name || String(error);
    const cause = error.cause;
    if (cause && cause !== error) {
      const code = typeof cause.code === 'string' ? cause.code : '';
      const causeMessage = typeof cause.message === 'string' ? cause.message : '';
      const detail = [code, causeMessage].filter(Boolean).join(': ');
      if (detail && !message.includes(detail)) return `${message} (cause: ${detail})`;
    }
    return message;
  }
  if (typeof error === 'string') return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined ? String(error) : serialized;
  } catch {
    return String(error);
  }
}

/**
 * Format a tools/call failure without implying that the call did not run.
 * Stream transport failures can arrive after the operator has dispatched the
 * tool, so callers must verify mutation state before replaying the payload.
 * The one known pre-dispatch refusal (loop-pressure shedding) is called out
 * separately because that signal is safe to retry and cannot have executed.
 * Pure — exported for focused diagnostics tests.
 */
export function formatToolCallFailure(toolName, error, { idempotencyKey } = {}) {
  const name = typeof toolName === 'string' && toolName ? toolName : '(unknown tool)';
  const detail = errorDetail(error);
  if (isLoopPressureShed(error)) {
    return `ptool: tools/call ${name} was rejected before dispatch: ${detail}; no tool execution occurred.`;
  }
  const receipt = typeof idempotencyKey === 'string' && idempotencyKey
    ? ` outcome=unknown; idempotencyKey=${idempotencyKey}; after reconciling state, replay this logical call with --idempotency-key ${idempotencyKey} instead of creating a new invocation.`
    : '';
  return `ptool: tools/call ${name} failed: ${detail}; the tool call may have executed — verify its state before retrying. Do not blindly retry a mutation.${receipt}`;
}

export async function callToolWithPressureRetry(
  client,
  params,
  {
    maxAttempts = 30,
    retryDelayMs = 1_000,
    timeoutMs = PTOOL_CALL_TOOL_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const requestOptions = timeoutMs > 0
        ? { timeout: timeoutMs, maxTotalTimeout: timeoutMs }
        : undefined;
      const projected = Boolean(
        params?.arguments &&
        typeof params.arguments === 'object' &&
        !Array.isArray(params.arguments) &&
        Object.hasOwn(params.arguments, 'projection'),
      );
      if (projected) {
        // EI-20335329169958057: Client.callTool() performs a SECOND semantic
        // validation using the outputSchema cached from tools/list. A
        // dispatch projection intentionally removes structuredContent (the
        // complete, unprojected payload), so that validator throws
        // "has an output schema but did not return structured content" after
        // the server already returned a valid reduced result. Use the SDK's
        // ordinary request primitive with the protocol CallToolResult schema:
        // wire-shape validation remains, while the incompatible cached
        // full-output-schema check is correctly skipped for this partial view.
        const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
        return await client.request(
          { method: 'tools/call', params },
          CallToolResultSchema,
          requestOptions,
        );
      }
      return await client.callTool(params, undefined, requestOptions);
    } catch (error) {
      lastError = error;
      if (!isLoopPressureShed(error) || attempt === maxAttempts) throw error;
      await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

/**
 * The MCP SDK uses these error codes for a request whose stream closed or whose
 * client-side deadline expired. Network implementations wrap the same failure
 * in ordinary fetch/socket errors, so keep the code and message checks together
 * rather than treating every rejected tools/call as replayable.
 */
export function isTransportFailure(error) {
  const codes = [error?.code, error?.cause?.code];
  if (codes.some((code) => code === -32000 || code === -32001)) return true;
  const detail = errorDetail(error);
  return /(?:fetch failed|econn(?:reset|refused|aborted)|etimedout|epipe|en[et]unreach|und_err_socket|socket (?:hang up|closed|reset|error)|(?:connection|transport|stream) (?:closed|reset|aborted|failed)|other side closed|network error)/i.test(detail);
}

/**
 * An HTTP response proves that the local endpoint answered. Retrying it as a
 * connection failure is both wasteful and misleading: in particular, the MCP
 * proxy's 503 is the authoritative, typed result after it has already spent
 * its full restart-absorption window. Walk `cause` because connect() adds
 * operator guidance around the SDK's StreamableHTTPError.
 */
export function isExplicitHttpConnectFailure(error) {
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    const status = Number(current.code);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return true;
    current = current.cause;
  }
  return false;
}

/**
 * The initial MCP connect only performs the write-free initialize/tools-list
 * handshake. A local resilient MCP proxy can answer that handshake with a 502
 * after an upstream worker accepted the socket but stayed silent; that is a
 * retryable proxy transport failure, not a terminal operator HTTP response.
 * Keep this narrower than `isExplicitHttpConnectFailure`: auth, routing, and
 * the proxy's exhausted refused-upstream 503 must still surface immediately.
 */
export function isRetryableLocalHttpConnectFailure(error) {
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    const status = Number(current.code);
    if (status === 502 && /mcp_proxy_upstream_error/i.test(errorDetail(current))) return true;
    current = current.cause;
  }
  return false;
}

/** Preserve the proxy's HTTP status and typed JSON body in ptool's stderr. */
export function formatOperatorConnectFailure(operatorUrl, error) {
  const status = Number(error?.code);
  const statusPrefix = Number.isInteger(status) && status >= 400 && status <= 599
    ? `HTTP ${status}: `
    : '';
  return (
    `could not reach the operator at ${operatorUrl} (${statusPrefix}${errorDetail(error)}). ` +
    'Is the desktop/operator running? Override with PAPERCUSP_OPERATOR_URL or --url=.'
  );
}

/**
 * Automatic reconnect replays after a connected tools/call are disabled.
 * A key can replay a completed call, but it is not an in-flight claim: an
 * immediate retry can overlap the original handler before its receipt exists.
 */
export const PTOOL_POST_CONNECT_RETRIES = 0;

async function closeClientQuietly(client) {
  try {
    await client?.close?.();
  } catch {
    // The original stream is already broken; its close failure must not prevent
    // the keyed replay from opening a fresh MCP session.
  }
}

/**
 * Call with a stable idempotency key, but do not automatically replay a
 * post-connect transport failure. The reconnect-shaped API remains for callers,
 * with its production retry ceiling clamped to zero.
 *
 * Returns the active client because the successful replay belongs to the new
 * session. A failed replay client is closed before the error is surfaced.
 * @param {any} client
 * @param {any} params
 * @param {{reconnect?: () => Promise<any>, maxAttempts?: number, timeoutMs?: number}} [options]
 */
export async function callToolWithReplayRecovery(
  client,
  params,
  {
    reconnect,
    maxAttempts = PTOOL_POST_CONNECT_RETRIES,
    timeoutMs = PTOOL_CALL_TOOL_TIMEOUT_MS,
  } = {},
) {
  let activeClient = client;
  let retriesUsed = 0;
  const retryBudget = Math.min(maxAttempts, PTOOL_POST_CONNECT_RETRIES);
  while (true) {
    try {
      const result = await callToolWithPressureRetry(activeClient, params, { timeoutMs });
      return { client: activeClient, result };
    } catch (error) {
      if (
        !isTransportFailure(error) ||
        retriesUsed >= retryBudget ||
        typeof reconnect !== 'function'
      ) {
        if (activeClient !== client) await closeClientQuietly(activeClient);
        throw error;
      }
      retriesUsed += 1;
      await closeClientQuietly(activeClient);
      activeClient = await reconnect();
    }
  }
}

/**
 * A local operator restart can make the initial MCP handshake race the brief
 * socket-down window. Retrying the connection is safe because no tool has been
 * dispatched yet; never extend this to a tools/call transport failure, whose
 * mutation status is ambiguous.
 */
export async function connectWithLocalRetry(
  connectOnce,
  operatorUrl,
  scope,
  {
    maxAttempts = 30,
    retryDelayMs = 1_000,
    attemptTimeoutMs = PTOOL_CONNECT_TIMEOUT_MS,
    totalTimeoutMs = PTOOL_CONNECT_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const hostname = new URL(operatorUrl).hostname;
  const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  const startedAt = Date.now();
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let timeout;
    try {
      const remainingTotalMs = totalTimeoutMs > 0
        ? Math.max(1, totalTimeoutMs - (Date.now() - startedAt))
        : null;
      const effectiveAttemptTimeoutMs = attemptTimeoutMs > 0
        ? Math.min(attemptTimeoutMs, remainingTotalMs ?? attemptTimeoutMs)
        : remainingTotalMs;
      const connection = connectOnce(
        operatorUrl,
        scope,
        local && effectiveAttemptTimeoutMs ? { timeoutMs: effectiveAttemptTimeoutMs } : undefined,
      );
      if (!local || !effectiveAttemptTimeoutMs) return await connection;
      return await new Promise((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`local operator connection attempt timed out after ${effectiveAttemptTimeoutMs}ms`)),
          effectiveAttemptTimeoutMs,
        );
        Promise.resolve(connection).then(resolve, reject);
      });
    } catch (error) {
      lastError = error;
      const remainingTotalMs = totalTimeoutMs > 0
        ? totalTimeoutMs - (Date.now() - startedAt)
        : null;
      if (
        !local ||
        (isExplicitHttpConnectFailure(error) && !isRetryableLocalHttpConnectFailure(error)) ||
        attempt === maxAttempts ||
        (remainingTotalMs !== null && remainingTotalMs <= 0)
      ) {
        throw error;
      }
      await sleep(Math.min(retryDelayMs, remainingTotalMs ?? retryDelayMs));
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  throw lastError;
}

/** Build ptool's superuser MCP URL. Pure and exported so the identity and
 * payload-tier contracts are regression-tested without opening a transport.
 * @param {string} operatorUrl
 * @param {{workspace?: string, harness?: string, client?: string, contextTier?: string}} [options]
 */
export function buildMcpUrl(operatorUrl, {
  workspace,
  harness,
  client,
  contextTier = 'trimmed',
} = {}) {
  const url = new URL(operatorUrl + '/api/mcp');
  url.searchParams.set('superuser', '1');
  if (workspace) url.searchParams.set('workspace', workspace);
  if (harness) url.searchParams.set('harness', harness);
  if (client) url.searchParams.set('client', client);
  if (contextTier) url.searchParams.set('ctx_tier', contextTier);
  return url;
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
async function connect(operatorUrl, { workspace, harness, tokenFile } = {}, { timeoutMs } = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const tokenPaths = resolveTokenPaths({ tokenFile });
  const token = readToken({ tokenFile });
  if (!token) {
    throw new Error(`no superuser token at ${tokenPaths.join(' or ')} — is the operator installed? (run apps/operator/scripts/install-standalone-mcp.sh)`);
  }
  const url = buildMcpUrl(operatorUrl, {
    workspace: resolveWorkspaceScope({ workspace }),
    harness,
    client: process.env.PAPERCUSP_SID,
    contextTier: resolveContextTier(),
  });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'ptool', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport, timeoutMs > 0 ? { timeout: timeoutMs } : undefined);
  } catch (e) {
    throw new Error(formatOperatorConnectFailure(operatorUrl, e), { cause: e });
  }
  return client;
}

/** List every tool, following pagination if the server returns a cursor. */
export async function listAllTools(client, { timeoutMs = PTOOL_LIST_TOOLS_TIMEOUT_MS } = {}) {
  const all = [];
  let cursor;
  do {
    const page = await client.listTools(
      cursor ? { cursor } : {},
      timeoutMs > 0 ? { timeout: timeoutMs, maxTotalTimeout: timeoutMs } : undefined,
    );
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

/** The live stdout delivery-failure probe (injectable in printResult for tests).
 *  Node SWALLOWS EPIPE on process.stdout by design: when the consumer of a
 *  captured/piped stdout dies mid-invocation (a wake-harness capture, `| head`),
 *  every later write is silently dropped and the process still exits 0 — which
 *  is exactly the "completed successfully but emitted no JSON or text" shape
 *  filed as EI-21250765620092599. `stream.errored` exposes the swallowed error. */
export function stdoutDeliveryError() {
  if (process.stdout.errored) return process.stdout.errored;
  if (process.stdout.destroyed) return new Error('stdout destroyed before the result was delivered');
  return null;
}

/** Print the result of a tools/call, or its error. Returns the exit code.
 * WI-39692: the @param types are LOAD-BEARING — ptool.d.mts is generated from
 * this JSDoc, and without them tsc infers the options shape from the defaults
 * alone (dropping `raw` entirely, which strands every typed caller).
 * @param {unknown} result
 * @param {{ raw?: boolean, deliveryProbe?: () => (Error | null) }} [options]
 */
export function printResult(result, { raw, deliveryProbe = stdoutDeliveryError } = {}) {
  const text = resultToText(result, { raw });
  if (!text.trim()) {
    console.error('ptool: operator returned an empty MCP result; no content or structuredContent was received');
    return 1;
  }
  const safeText = sanitizeJsonText(text);
  if (result?.isError) {
    console.error('✗ tool returned an error:');
    console.error(raw ? safeText : prettyText(safeText));
    return 1;
  }
  if (raw && isInvalidTruncatedJson(safeText)) {
    console.error(PTOOL_TRUNCATED_RESULT_MESSAGE);
    return 1;
  }
  console.log(raw ? safeText : prettyText(safeText));
  const delivery = deliveryProbe();
  if (delivery) {
    console.error(
      `ptool: result was produced but stdout delivery FAILED (${delivery.code || delivery.message}) — the consumer of stdout went away, so the caller saw nothing. Treat this invocation as failed and re-run. (EI-21250765620092599)`,
    );
    return 1;
  }
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

export const PTOOL_USAGE = `ptool — call any Papercusp defineTool endpoint from the terminal.

  ptool                         interactive: pick service → endpoint → args
  ptool <group:verb>            skip the pickers, prompt for that tool's args
  ptool <group:verb> --json - <<'EOF'  read JSON args from stdin (safe)
  {"copy": "it's fine now"}
  EOF
  ptool <group:verb> --json-file payload.json   read JSON args from a file (safe)
  ptool <group:verb> --json '<args>'   inline, quote-free JSON only
  ptool <group:verb> --projection '<spec>'  bound the result at dispatch time
  ptool code:run --script-file batch.js   read the script from a file
  ptool code:run --script - <<'EOF'      read the script from stdin
  return await tools.dev.build_status({});
  EOF
  ptool --list [filter]         print the catalog (optionally name-filtered)

Prefer --json-file or --json - for any payload that is not a trivial,
quote-free literal — especially loop:checkpoint checks/walls with recheck text.
A shell-quoted --json '<inline>' cannot safely carry an apostrophe (the quote
terminates early). For code:run, prefer --script-file or --script - for source
that contains nested shell commands or quoted strings.

Flags:
  --json <json> / --args <json>   args object for a direct (non-interactive) call;
                                   '-' reads the JSON from stdin instead
  --json-file <path>              read the args JSON from a file (quoting-free)
  --projection <json>             dispatch-level result projection (quote-free JSON)
  --script <source>               direct code:run JavaScript source; '-' reads stdin
  --script-file <path>            direct code:run JavaScript source (quoting-free)
  --workspace <ws>                scope the session (needed for harness:*, features:*, …)
  --harness <slug>                scope the session to a harness
  --idempotency-key <key>         reuse one logical tools/call receipt after reconciling an unknown outcome
  --token-file <path>             bearer token file (default $PAPERCUSP_MCP_TOKEN_FILE, $PAPERCUSP_HOME/superuser-token, or ~/.papercusp/superuser-token)
  PAPERCUSP_CONTEXT_TIER=full     explicit escape hatch for unshaped MCP payloads (default: trimmed)
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
    console.log(PTOOL_USAGE);
    return;
  }
  const operatorUrl = args.url || OPERATOR_URL;
  const workspace = resolveWorkspaceScope({ workspace: args.workspace });
  const harness = resolveHarnessScope({ harness: args.harness });
  const scope = { workspace, harness, tokenFile: args.tokenFile };
  let client = await connectWithLocalRetry(
    connect,
    operatorUrl,
    scope,
  );
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

    // Assemble args: explicit JSON or direct code:run script source, else
    // interactive prompting. Pure source-kind helpers keep shell-hostile
    // scripts on a quoting-free path (EI-20235746813390458).
    let callArgs;
    const jsonKind = jsonSourceKind(args);
    const scriptKind = scriptSourceKind(args);
    if (jsonKind != null && scriptKind != null) {
      console.error('ptool: choose one input source: --json/--json-file or --script/--script-file');
      process.exit(1);
    }
    const inputKind = scriptKind ?? jsonKind;
    if (scriptKind != null) {
      if (toolName !== 'code:run') {
        console.error('ptool: --script/--script-file can only be used with code:run');
        process.exit(1);
      }
      try {
        if (scriptKind === 'file') callArgs = { script: readFileSync(args.scriptFile, 'utf8') };
        else if (scriptKind === 'stdin') callArgs = { script: readFileSync(0, 'utf8') };
        else callArgs = { script: args.script };
      } catch (e) {
        console.error(`ptool: could not read script from ${scriptKind === 'file' ? `--script-file ${args.scriptFile}` : 'stdin'}: ${e.message}`);
        process.exit(1);
      }
    } else if (jsonKind != null) {
      let jsonText;
      try {
        if (jsonKind === 'file') jsonText = readFileSync(args.jsonFile, 'utf8');
        else if (jsonKind === 'stdin') jsonText = readFileSync(0, 'utf8');
        else jsonText = args.json;
      } catch (e) {
        console.error(`ptool: could not read JSON from ${jsonKind === 'file' ? `--json-file ${args.jsonFile}` : 'stdin'}: ${e.message}`);
        process.exit(1);
      }
      try {
        callArgs = parseJsonInput(jsonText);
      } catch (e) {
        console.error(`ptool: --json${jsonKind === 'inline' ? '' : ` (${jsonKind})`} is not valid JSON: ${e.message}`);
        process.exit(1);
      }
    } else {
      callArgs = await collectArgs(tool.inputSchema);
    }
    if (args.projection != null) {
      let projection;
      try {
        projection = JSON.parse(args.projection);
      } catch (e) {
        console.error(`ptool: --projection is not valid JSON: ${e.message}`);
        process.exit(1);
      }
      callArgs = mergeDispatchProjection(callArgs, projection);
    }
    callArgs = mergeConvenienceArgs(callArgs, { workspace, harness }, tool.inputSchema);

    // Interactive confirmation (only when we prompted — a scripted --json/
    // --json-file/stdin call is non-interactive by intent).
    if (inputKind == null && !args.tool) {
      const { confirm } = await import('@inquirer/prompts');
      console.error(`\n→ ${toolName}  ${JSON.stringify(callArgs)}`);
      const go = await confirm({ message: 'Call it?', default: true });
      if (!go) {
        console.error('ptool: cancelled');
        return;
      }
    } else if (shouldPrintInvocationLine(inputKind)) {
      console.error(`→ ${toolName}  ${JSON.stringify(callArgs)}`);
    }

    let result;
    // Keep the receipt outside the try so a transport failure can surface the
    // exact key needed to replay the completed server result.
    const idempotencyKey = args.idempotencyKey || randomUUID();
    try {
      const recovered = await callToolWithReplayRecovery(
        client,
        buildCallToolParams(toolName, callArgs, {
          outputSchema: tool.outputSchema,
          // One key belongs to this logical CLI invocation. Reconnect recovery
          // deliberately reuses these params so the server can deduplicate it.
          idempotencyKey,
        }),
        {
          timeoutMs: timeoutForTool(toolName, callArgs),
          reconnect: () => connectWithLocalRetry(connect, operatorUrl, scope),
        },
      );
      client = recovered.client;
      result = recovered.result;
    } catch (error) {
      console.error(formatToolCallFailure(toolName, error, { idempotencyKey }));
      process.exitCode = 1;
      return;
    }
    const code = printResult(result, { raw: shouldPrintRawResult(inputKind, args.raw) });
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
  // EPIPE backstop (EI-21250765620092599): an EPIPE can surface on the tick
  // AFTER printResult's synchronous probe, so re-check at exit and refuse to
  // report success when the result never reached the consumer. stderr is a
  // separate pipe and usually still deliverable when stdout's consumer died.
  process.on('exit', (code) => {
    if (code === 0 && stdoutDeliveryError()) {
      process.stderr.write(
        'ptool: exiting after a swallowed stdout delivery failure (EPIPE) — the result never reached the consumer; treating this invocation as FAILED (EI-21250765620092599)\n',
      );
      process.exitCode = 1;
    }
  });
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
