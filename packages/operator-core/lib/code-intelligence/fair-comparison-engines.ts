/**
 * P-017 third-party engine adapters (plan `gitnexus-deterministic-integration-
 * 2026-10-05`, D-011, D-013): codegraph and trace-mcp, the permissively
 * licensed candidates the 2026-10-02 harness had no arm for.
 *
 * D-013 rules every adapter here follows:
 *  - RAW answers: the engine's answer is passed through unfiltered. The only
 *    filter is the one the question defines — symbol-search and definition keep
 *    results whose name equals the subject.
 *  - UNIFORM inputs: subject, plus anchorFile and depth when the case has them
 *    and the engine accepts them. Limits are raised so nothing truncates
 *    silently; a truncated answer says so in its note.
 *  - Engine-owned resolution only: a symbol id the engine reports without a line
 *    is resolved with the engine's own lookup, never with ours.
 *  - Isolation: an isolated HOME plus the admission record's telemetry-off env.
 *
 * The output parsers are exported and pure so they are tested against captured
 * engine output without the engine installed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isAbsolute, relative } from 'node:path';
import type { SymbolSite } from './contracts';
import type { PhaseCost } from './engine-comparison';
import { execTimed, phaseOf, type ArmDeps } from './engine-comparison-arms';
import type { ArmCapabilities, FairCase, FairIntent } from './fair-comparison';
import { guardedArm, type AcceptedEngineFault, type FairArm, type RawReply } from './fair-comparison-arms';

export interface EngineArmConfig {
  readonly version: string;
  /** Absolute path of the engine's CLI. */
  readonly bin: string;
  /** The tree the engine indexes and answers about (its own copy, D-013). */
  readonly treeRoot: string;
  /** Isolated HOME: the engine's global state and caches never touch the operator's. */
  readonly home: string;
  /** The admission record's env (telemetry off). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

const posix = (p: string): string => p.split('\\').join('/').replace(/^\.\//, '');
const site = (path: string | undefined, line1: number | null | undefined, kind: string | null | undefined): SymbolSite => ({
  path: posix(path ?? ''),
  line1: typeof line1 === 'number' ? line1 : null,
  kind: kind ? kind.toLowerCase() : null,
});

// ─── codegraph (MIT, npm @colbymchenry/codegraph) ────────────────────────────

export const CODEGRAPH_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact', 'definition', 'symbol-search'];

/** The codegraph CLI call for one case. codegraph has no references or text-search command. */
export function codegraphArgv(kase: FairCase): string[] {
  const file = kase.anchorFile ? ['-f', kase.anchorFile] : [];
  switch (kase.intent) {
    case 'callers':
    case 'callees':
      return [kase.intent, kase.subject, '-j', '-l', '10000', ...file];
    case 'impact':
      return ['impact', kase.subject, '-j', '-d', String(kase.depth ?? 2), ...file];
    case 'definition':
    case 'symbol-search':
      return ['query', kase.subject, '-j', '-l', '1000'];
    default:
      throw new Error(`declined: codegraph has no command for intent '${kase.intent}'`);
  }
}

interface CgNode {
  readonly name?: string;
  readonly kind?: string;
  readonly filePath?: string;
  readonly startLine?: number;
}

/**
 * Parse codegraph's `-j` output. An unknown symbol prints a notice instead of
 * JSON (exit 0): that is an answer — the engine is confident there is nothing —
 * so it returns no sites. Any other non-JSON output, or JSON without the
 * expected array, throws: a changed output shape must surface as a crash.
 */
export function parseCodegraph(kase: FairCase, stdout: string, stderr = ''): { sites: SymbolSite[]; note: string | null } {
  const start = stdout.search(/^[[{]/m);
  if (start < 0) {
    if (/\bnot found\b/i.test(`${stdout}\n${stderr}`)) return { sites: [], note: 'codegraph: symbol not found' };
    throw new Error(`codegraph printed no JSON: ${`${stdout}${stderr}`.trim().slice(0, 200)}`);
  }
  const json = JSON.parse(stdout.slice(start)) as unknown;
  let nodes: readonly CgNode[] | undefined;
  let truncated = false;
  if (kase.intent === 'definition' || kase.intent === 'symbol-search') {
    if (!Array.isArray(json)) throw new Error('codegraph query: expected a JSON array');
    nodes = (json as Array<{ node?: CgNode }>).map((r) => r.node ?? {}).filter((n) => n.name === kase.subject);
  } else {
    const obj = json as Record<string, unknown>;
    const field = kase.intent === 'impact' ? 'affected' : kase.intent;
    if (!Array.isArray(obj[field])) throw new Error(`codegraph ${kase.intent}: no '${field}' array in output`);
    nodes = obj[field] as CgNode[];
    truncated = obj.truncated === true;
  }
  return { sites: nodes.map((n) => site(n.filePath, n.startLine, n.kind)), note: truncated ? 'codegraph: truncated at --limit' : null };
}

export function createCodegraphArm(cfg: EngineArmConfig, deps: ArmDeps, now?: () => number): FairArm {
  const exec = deps.exec ?? execTimed;
  const env = { ...cfg.env, HOME: cfg.home, NO_COLOR: '1' };
  const run = (args: readonly string[], timeoutMs = cfg.timeoutMs ?? 120_000) => exec(cfg.bin, args, { cwd: cfg.treeRoot, env, timeoutMs });
  const capabilities: ArmCapabilities = { armId: 'codegraph', version: cfg.version, intents: CODEGRAPH_INTENTS, licence: 'permissive' };
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    // `index` rebuilds from scratch; on a tree never initialised it fails, and `init` builds the first index.
    async index(): Promise<PhaseCost> {
      const r = await run(['index', '.'], 4 * 3_600_000);
      return phaseOf(r.code === 0 ? r : await run(['init', '.'], 4 * 3_600_000), deps);
    },
    async ask(kase): Promise<RawReply> {
      const r = await run(codegraphArgv(kase));
      if (r.code !== 0) return { sites: [], error: `codegraph ${kase.intent} exit ${r.code}: ${r.stderr.trim().slice(-300)}` };
      const { sites, note } = parseCodegraph(kase, r.stdout, r.stderr);
      return { sites, error: null, note };
    },
  });
}

// ─── trace-mcp (MIT) — answers only over MCP stdio ───────────────────────────

export const TRACE_MCP_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact', 'definition', 'references', 'symbol-search', 'text-search'];

/** The JSON body of an MCP tool result. trace-mcp returns one text part holding JSON. */
/** The JSON an MCP tool returned as text content. Non-JSON text throws, so a changed output shape surfaces as a crash. */
export function mcpToolJson(result: unknown, engine: string): { json: Record<string, unknown>; isError: boolean } {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${engine} returned non-JSON: ${text.slice(0, 200)}`);
  }
  return { json, isError: r.isError === true };
}

interface TraceItem {
  readonly symbol_id?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly file?: string;
  readonly line?: number;
}

/** Exact-name symbols from a `search` result, narrowed to anchorFile when any of them lives there. */
export function traceCandidates(kase: FairCase, searchJson: Record<string, unknown>): TraceItem[] {
  const items = ((searchJson.items as TraceItem[] | undefined) ?? []).filter((i) => i.name === kase.subject);
  const inAnchor = kase.anchorFile ? items.filter((i) => posix(i.file ?? '') === kase.anchorFile) : [];
  return inAnchor.length > 0 ? inAnchor : items;
}

/** Sites from a `search_text` result, and whether it hit its result cap. */
export function traceTextSites(json: Record<string, unknown>): { sites: SymbolSite[]; truncated: boolean } {
  const files = (json.files as Array<{ file?: string; hits?: Array<{ line?: number }> }> | undefined) ?? [];
  const sites = files.flatMap((f) => (f.hits ?? []).map((h) => site(f.file, h.line, null)));
  return { sites, truncated: json.truncated === true || json.timed_out === true };
}

/** Sites from `get_call_graph`: `called_by` for callers, `calls` for callees. */
export function traceCallSites(json: Record<string, unknown>, intent: 'callers' | 'callees'): SymbolSite[] {
  const root = json.root as { called_by?: TraceItem[]; calls?: TraceItem[] } | undefined;
  if (!root) throw new Error('trace-mcp get_call_graph: no root in output');
  return ((intent === 'callers' ? root.called_by : root.calls) ?? []).map((n) => site(n.file, n.line, n.kind));
}

/** Sites from `find_usages`. trace-mcp names the referencing symbol; its line is the scope's (D-013 alias rule). */
export function traceUsageSites(json: Record<string, unknown>): SymbolSite[] {
  const refs = (json.references as Array<{ file?: string; line?: number; symbol?: { line_start?: number; kind?: string } }> | undefined) ?? [];
  return refs.map((r) => site(r.file, r.line ?? r.symbol?.line_start, r.symbol?.kind ?? null));
}

/** Symbol ids from `get_change_impact`; trace-mcp gives no lines, so each is resolved with its own get_symbol. */
export function traceImpactSymbolIds(json: Record<string, unknown>): string[] {
  const deps = (json.dependents as Array<{ symbols?: Array<{ symbolId?: string }> }> | undefined) ?? [];
  return deps.flatMap((d) => (d.symbols ?? []).map((s) => s.symbolId).filter((s): s is string => typeof s === 'string'));
}

export interface McpSession {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Start an engine's MCP server in the tree (`<bin> <serveArgs>`) and talk MCP to it over stdio. */
export async function openMcpSession(
  cfg: EngineArmConfig,
  serveArgs: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<McpSession> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  Object.assign(env, cfg.env, extraEnv, { HOME: cfg.home, NO_COLOR: '1' });
  const transport = new StdioClientTransport({ command: cfg.bin, args: [...serveArgs], cwd: cfg.treeRoot, env, stderr: 'ignore' });
  const client = new Client({ name: 'papercusp-fair-comparison', version: '1' });
  await client.connect(transport);
  const timeout = cfg.timeoutMs ?? 120_000;
  return {
    call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout }),
    close: () => client.close(),
  };
}

/** Answer one case through an open trace-mcp session (exported for tests with a fake session). */
export async function askTrace(session: Pick<McpSession, 'call'>, kase: FairCase): Promise<RawReply> {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { json, isError } = mcpToolJson(await session.call(name, args), 'trace-mcp');
    if (isError) {
      const err = json.error as { code?: string; message?: string } | undefined;
      if (err?.code === 'NOT_FOUND') return null;
      throw new Error(`trace-mcp ${name}: ${err?.message ?? JSON.stringify(json).slice(0, 200)}`);
    }
    return json;
  };

  if (kase.intent === 'text-search') {
    const json = await call('search_text', { query: kase.subject, case_sensitive: true, max_results: 200 });
    const { sites, truncated } = json ? traceTextSites(json) : { sites: [], truncated: false };
    return { sites, error: null, note: truncated ? 'trace-mcp: search_text hit its 200-result cap' : null };
  }

  const found = await call('search', { query: kase.subject, limit: 500 });
  const candidates = found ? traceCandidates(kase, found) : [];
  if (kase.intent === 'symbol-search' || kase.intent === 'definition') {
    return { sites: candidates.map((c) => site(c.file, c.line, c.kind)), error: null };
  }
  if (candidates.length === 0) return { sites: [], error: null, note: 'trace-mcp: symbol not found' };

  const sites: SymbolSite[] = [];
  for (const c of candidates) {
    const id = c.symbol_id;
    if (!id) continue;
    if (kase.intent === 'callers' || kase.intent === 'callees') {
      const json = await call('get_call_graph', { symbol_id: id, depth: 1 });
      if (json) sites.push(...traceCallSites(json, kase.intent));
    } else if (kase.intent === 'references') {
      const json = await call('find_usages', { symbol_id: id, limit: 1000 });
      if (json) sites.push(...traceUsageSites(json));
    } else if (kase.intent === 'impact') {
      const json = await call('get_change_impact', { symbol_id: id, depth: kase.depth ?? 2, max_dependents: 5000 });
      for (const dep of json ? traceImpactSymbolIds(json) : []) {
        const sym = await call('get_symbol', { symbol_id: dep, max_lines: 1 });
        sites.push(sym ? site(sym.file as string | undefined, sym.line_start as number | undefined, sym.kind as string | undefined) : site(dep.split('::')[0], null, null));
      }
    }
  }
  return { sites, error: null };
}

export function createTraceMcpArm(cfg: EngineArmConfig, deps: ArmDeps, now?: () => number): FairArm {
  const exec = deps.exec ?? execTimed;
  const capabilities: ArmCapabilities = { armId: 'trace-mcp', version: cfg.version, intents: TRACE_MCP_INTENTS, licence: 'permissive' };
  let session: Promise<McpSession> | null = null;
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    index: async () =>
      phaseOf(await exec(cfg.bin, ['index', '.', '--force'], { cwd: cfg.treeRoot, env: { ...cfg.env, HOME: cfg.home }, timeoutMs: 4 * 3_600_000 }), deps),
    async ask(kase) {
      session ??= openMcpSession(cfg, ['serve']);
      return askTrace(await session, kase);
    },
    async close() {
      if (session) await (await session).close();
      session = null;
    },
  });
}

// ─── CodeGraphContext (MIT, PyPI codegraphcontext) — answers over MCP stdio ──

/**
 * CGC's intents. It has no references query (`analyze variable` covers
 * variables only). Its text search is a full-text index over function sources
 * and docstrings: it answers with the enclosing function, and module-level text
 * is not indexed. That is CGC's text search, so it is declared and measured.
 */
export const CGC_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact', 'definition', 'symbol-search', 'text-search'];

/**
 * CGC caps every tool at 15-50 results by default. It reads `TOOL_RESULT_LIMITS`
 * from its environment, so the arm raises every cap it uses (D-013 rule 2).
 */
export const CGC_RESULT_LIMITS: string = JSON.stringify(
  Object.fromEntries(['find_code', 'analyze_code_relationships', 'find_callers', 'find_callees', 'find_all_callers'].map((k) => [k, 1_000_000])),
);

/** The one CGC tool call for a case. `context` is CGC's own file scope; it resolves a repo-relative path against the server's cwd. */
export function cgcRequest(kase: FairCase): { tool: string; args: Record<string, unknown> } {
  const scope = kase.anchorFile ? { context: kase.anchorFile } : {};
  const relationship = (query_type: string, extra: Record<string, unknown> = {}) => ({
    tool: 'analyze_code_relationships',
    args: { query_type, target: kase.subject, ...scope, ...extra },
  });
  switch (kase.intent) {
    case 'callers':
      return relationship('find_callers');
    case 'callees':
      return relationship('find_callees');
    case 'impact':
      return relationship('find_all_callers', { depth: kase.depth ?? 2 });
    case 'definition':
    case 'symbol-search':
    case 'text-search':
      return { tool: 'find_code', args: { query: kase.subject, fuzzy_search: false } };
    default:
      throw new Error(`declined: CodeGraphContext has no query for intent '${kase.intent}'`);
  }
}

type CgcRow = Record<string, unknown>;
const rows = (v: unknown, what: string): CgcRow[] => {
  if (!Array.isArray(v)) throw new Error(`cgc: expected a '${what}' array`);
  return v as CgcRow[];
};
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** CGC prints absolute paths; the score is on repo-relative ones. A path outside the tree stays absolute and scores as wrong. */
export function cgcPath(treeRoot: string, p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  const rel = relative(treeRoot, p);
  return rel.startsWith('..') || isAbsolute(rel) ? p : rel;
}

/**
 * Read one CGC tool reply (the JSON CGC prints as text content). Raw (D-013):
 * callers keep every reported call line (lines in one scope are aliases of one
 * unit, D-012); callees and impact keep the declaration lines CGC reports;
 * definition and symbol-search keep exact-name symbols; text-search keeps every
 * content match. A query error CGC reports inside a successful envelope is an
 * error, never an empty answer.
 */
export function parseCgc(kase: FairCase, json: Record<string, unknown>, treeRoot: string): RawReply {
  if (json.success === false) return { sites: [], error: `cgc: ${String(json.error ?? json.message ?? 'success=false').slice(0, 300)}` };
  const results = json.results as Record<string, unknown> | undefined;
  if (!results || typeof results !== 'object') throw new Error('cgc: reply has no results object');
  if (typeof results.error === 'string') return { sites: [], error: `cgc ${kase.intent}: ${results.error.slice(0, 300)}` };
  const at = (p: unknown, line: unknown, kind: string | undefined) => site(cgcPath(treeRoot, str(p)), num(line), kind);

  if (kase.intent === 'definition' || kase.intent === 'symbol-search') {
    const buckets: Array<[string, string]> = [['functions_by_name', 'function'], ['classes_by_name', 'class'], ['variables_by_name', 'variable']];
    const sites = buckets.flatMap(([field, kind]) =>
      rows(results[field] ?? [], field).filter((r) => r.name === kase.subject).map((r) => at(r.path, r.line_number, kind)),
    );
    return { sites, error: null };
  }
  if (kase.intent === 'text-search') {
    return { sites: rows(results.content_matches ?? [], 'content_matches').map((r) => at(r.path, r.line_number, str(r.type))), error: null };
  }
  const list = rows(results.results, 'results');
  const truncated = results.truncated === true;
  const sites =
    kase.intent === 'callers'
      ? list.map((r) => at(r.caller_file_path, r.call_line_number, 'call'))
      : kase.intent === 'callees'
        ? list.map((r) => at(r.called_file_path, r.called_line_number, 'function'))
        : list.map((r) => at(r.caller_file_path, r.caller_line_number, 'function'));
  return { sites, error: null, note: truncated ? `cgc: truncated at result_limit ${String(results.result_limit)}` : null };
}

/** Answer one case through an open CGC session (exported for tests with a fake session). */
export async function askCgc(session: Pick<McpSession, 'call'>, kase: FairCase, treeRoot: string): Promise<RawReply> {
  const { tool, args } = cgcRequest(kase);
  const { json, isError } = mcpToolJson(await session.call(tool, args), 'cgc');
  if (isError) return { sites: [], error: `cgc ${tool}: ${JSON.stringify(json).slice(0, 300)}` };
  return parseCgc(kase, json, treeRoot);
}

const CGC_IMPACT_CRASH =
  'CodeGraphContext 0.6.13 find_all_callers fails for every target on its default KuzuDB backend ("Binder exception: Expression in WITH must be aliased"). ' +
  'Reproduced by calling analyze_code_relationships {query_type:"find_all_callers"} on its own MCP server, outside the adapter (2026-10-06).';

/**
 * Micro-repo defects shown to be CGC's own (AcceptedEngineFault): measured on
 * the real corpus like any other answer, never blocking the arm. Each must stop
 * occurring before it is removed; runConformance reports a stale one.
 */
export const CGC_ACCEPTED_FAULTS: readonly AcceptedEngineFault[] = Object.freeze([
  { caseId: 'micro-impact-doubled', outcome: 'crashed', detail: /Binder exception/, evidence: CGC_IMPACT_CRASH },
  { caseId: 'micro-impact-scale', outcome: 'crashed', detail: /Binder exception/, evidence: CGC_IMPACT_CRASH },
  {
    caseId: 'micro-text-search-grand-total',
    outcome: 'wrong',
    evidence:
      'CGC content search is a single-token full-text index over function sources and docstrings. Its own CLI, `cgc find content "grand total"`, ' +
      'also prints "No content matches found"; `cgc find content grand` finds only the enclosing function report (report.ts:19). The literal on ' +
      'report.ts:3 is a module-level constant, which CGC does not index (2026-10-06).',
  },
]);

/**
 * The CGC arm. CGC keeps its graph under `$HOME/.codegraphcontext` in global
 * mode, so `cfg.home` must be unique per tree: two trees under one HOME share a
 * graph and answer for each other.
 */
export function createCgcArm(cfg: EngineArmConfig, deps: ArmDeps, now?: () => number): FairArm {
  const exec = deps.exec ?? execTimed;
  const capabilities: ArmCapabilities = { armId: 'codegraphcontext', version: cfg.version, intents: CGC_INTENTS, licence: 'permissive' };
  const env = { TOOL_RESULT_LIMITS: CGC_RESULT_LIMITS };
  let session: Promise<McpSession> | null = null;
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    index: async () =>
      phaseOf(
        await exec(cfg.bin, ['index', '.', '--force', '--no-progress'], {
          cwd: cfg.treeRoot,
          env: { ...cfg.env, ...env, HOME: cfg.home, NO_COLOR: '1' },
          timeoutMs: 4 * 3_600_000,
        }),
        deps,
      ),
    async ask(kase) {
      session ??= openMcpSession(cfg, ['mcp', 'start'], env);
      return askCgc(await session, kase, cfg.treeRoot);
    },
    async close() {
      if (session) await (await session).close();
      session = null;
    },
  });
}
