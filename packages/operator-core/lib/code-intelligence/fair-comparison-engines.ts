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
import type { SymbolSite } from './contracts';
import type { PhaseCost } from './engine-comparison';
import { execTimed, phaseOf, type ArmDeps } from './engine-comparison-arms';
import type { ArmCapabilities, FairCase, FairIntent } from './fair-comparison';
import { guardedArm, type FairArm, type RawReply } from './fair-comparison-arms';

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
export function traceToolJson(result: unknown): { json: Record<string, unknown>; isError: boolean } {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`trace-mcp returned non-JSON: ${text.slice(0, 200)}`);
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

export interface TraceSession {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Start `trace-mcp serve` in the tree and talk MCP to it over stdio. */
export async function openTraceSession(cfg: EngineArmConfig): Promise<TraceSession> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  Object.assign(env, cfg.env, { HOME: cfg.home, NO_COLOR: '1' });
  const transport = new StdioClientTransport({ command: cfg.bin, args: ['serve'], cwd: cfg.treeRoot, env, stderr: 'ignore' });
  const client = new Client({ name: 'papercusp-fair-comparison', version: '1' });
  await client.connect(transport);
  const timeout = cfg.timeoutMs ?? 120_000;
  return {
    call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout }),
    close: () => client.close(),
  };
}

/** Answer one case through an open trace-mcp session (exported for tests with a fake session). */
export async function askTrace(session: Pick<TraceSession, 'call'>, kase: FairCase): Promise<RawReply> {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { json, isError } = traceToolJson(await session.call(name, args));
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
  let session: Promise<TraceSession> | null = null;
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    index: async () =>
      phaseOf(await exec(cfg.bin, ['index', '.', '--force'], { cwd: cfg.treeRoot, env: { ...cfg.env, HOME: cfg.home }, timeoutMs: 4 * 3_600_000 }), deps),
    async ask(kase) {
      session ??= openTraceSession(cfg);
      return askTrace(await session, kase);
    },
    async close() {
      if (session) await (await session).close();
      session = null;
    },
  });
}
