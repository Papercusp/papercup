/**
 * P-005 — subprocess adapters for the engine comparison (see `engine-comparison.ts`).
 *
 * Every arm is driven through its ONE-SHOT CLI so the four arms see the same
 * invocation shape, each against its OWN copy of the bounded tree and (for the
 * graph engines) its OWN scratch `HOME`, so no arm touches the serving
 * `~/.gitnexus` registry, the serving `.gitnexus` index, or any editor config.
 * `codebase-memory-mcp install` is NEVER invoked: that command writes agent
 * hooks and MCP config, which the plan forbids for this evaluation.
 *
 * Latency caveat recorded with the evidence: a one-shot CLI pays process start
 * + DB open on EVERY query, whereas the served path keeps a long-lived MCP
 * process. Warm numbers are therefore comparable ACROSS arms (same shape) but
 * overstate absolute served latency for the graph engines.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CorpusCase } from './acceptance-corpus';
import type { EngineArm, EngineQueryResult, PhaseCost } from './engine-comparison';
import type { SymbolSite } from './contracts';

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
  readonly peakRssKb: number | null;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Runs `cmd` under `/usr/bin/time -v` so peak RSS is MEASURED, not inferred. */
export async function execTimed(cmd: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-cmp-time-'));
  const timeFile = join(dir, 'time.txt');
  const t0 = performance.now();
  try {
    return await new Promise<ExecResult>((resolve) => {
      execFile(
        '/usr/bin/time', ['-v', '-o', timeFile, cmd, ...args],
        { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs ?? 900_000, maxBuffer: 256 * 1024 * 1024 },
        async (err, stdout, stderr) => {
          const wallMs = performance.now() - t0;
          let peakRssKb: number | null = null;
          try {
            const m = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(await readFile(timeFile, 'utf8'));
            peakRssKb = m ? Number(m[1]) : null;
          } catch { /* time file absent: leave null — a null is "not measured", not zero */ }
          const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr), wallMs, peakRssKb });
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface ArmDeps {
  loadAvg1(): number | null;
}

const phaseOf = (r: ExecResult, deps: ArmDeps, okOverride?: boolean): PhaseCost => ({
  wallMs: r.wallMs,
  peakRssKb: r.peakRssKb,
  ok: okOverride ?? r.code === 0,
  error: (okOverride ?? r.code === 0) ? null : `exit ${r.code}: ${r.stderr.trim().slice(-300)}`,
  loadAvg1: deps.loadAvg1(),
});

const posix = (p: string): string => p.split('\\').join('/').replace(/^\.\//, '');

async function dirBytes(root: string, cwd: string): Promise<number | null> {
  const r = await execTimed('du', ['-sb', root], { cwd });
  const n = Number(r.stdout.split(/\s+/)[0]);
  return r.code === 0 && Number.isFinite(n) ? n : null;
}

// ── baseline: scripted rg ───────────────────────────────────────────────────

const RG_GLOBS = ['-g', '*.ts', '-g', '*.tsx', '-g', '*.mts'] as const;
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'typeof', 'new', 'super', 'import',
  'require', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set', 'Error', 'JSON', 'Math',
  'Date', 'async', 'void', 'delete', 'throw', 'of', 'in', 'as', 'satisfies',
]);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseRgLines(stdout: string, treeRoot: string): SymbolSite[] {
  const sites: SymbolSite[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const path = posix(m[1]!.startsWith(treeRoot) ? m[1]!.slice(treeRoot.length + 1) : m[1]!);
    sites.push({ path, line1: Number(m[2]), kind: null, detail: m[3]!.trim().slice(0, 120) });
  }
  return sites;
}

/** Baseline arm: a scripted `rg` pass — what an agent without a graph does. No index. */
export function createRgBaselineArm(treeRoot: string, deps: ArmDeps, rgBin = process.env.PAPERCUSP_RG_BIN ?? 'rg'): EngineArm {
  const rg = (args: readonly string[]) => execTimed(rgBin, args, { cwd: treeRoot, timeoutMs: 120_000 });
  const defsFor = async (ids: readonly string[]): Promise<ExecResult> => {
    const alt = ids.map(escapeRe).join('|');
    return rg(['-n', '--no-heading', '-e', `^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\s+(${alt})\\b`, '-e', `^\\s*(export\\s+)?(const|class)\\s+(${alt})\\b`, ...RG_GLOBS, '-g', '!*.test.ts', '.']);
  };
  return {
    id: 'baseline-lsp-rg', version: `rg ${rgBin}`, treeRoot, unavailable: null,
    async index() { return { wallMs: 0, peakRssKb: 0, ok: true, error: null, loadAvg1: deps.loadAvg1() }; },
    async refresh() {
      // rg has no index; the freshness scan is a full file walk, which is also
      // where an unreadable directory surfaces (rg exits 2 on permission errors).
      return phaseOf(await rg(['--files', ...RG_GLOBS, '.']), deps);
    },
    async indexBytes() { return 0; },
    async query(kase: CorpusCase): Promise<EngineQueryResult> {
      const q = escapeRe(kase.query);
      let res: ExecResult;
      let sites: SymbolSite[] = [];
      if (kase.intent === 'text-search') {
        res = await rg(['-n', '--no-heading', '-F', kase.query, ...RG_GLOBS, '.']);
        sites = parseRgLines(res.stdout, treeRoot);
      } else if (kase.intent === 'symbol-search') {
        res = await defsFor([kase.query]);
        sites = parseRgLines(res.stdout, treeRoot);
      } else if (kase.intent === 'callers') {
        res = await rg(['-n', '--no-heading', '-e', `\\b${q}\\s*[(<]`, ...RG_GLOBS, '.']);
        sites = parseRgLines(res.stdout, treeRoot).filter((s) => !/\bfunction\s/.test(s.detail ?? ''));
      } else {
        const defs = parseRgLines((await defsFor([kase.query])).stdout, treeRoot);
        const target = defs[0];
        if (!target) return { sites: [], responseBytes: 0, error: null };
        const lines = (await readFile(join(treeRoot, target.path), 'utf8')).split('\n');
        const start = (target.line1 ?? 1) - 1;
        let end = lines.findIndex((l, i) => i > start && l.startsWith('}'));
        if (end < 0) end = lines.length - 1;
        const ids = new Set<string>();
        for (const m of lines.slice(start, end + 1).join('\n').matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
          const id = m[1]!;
          if (id !== kase.query && !KEYWORDS.has(id)) ids.add(id);
          if (ids.size >= 60) break;
        }
        res = ids.size === 0 ? { code: 0, stdout: '', stderr: '', wallMs: 0, peakRssKb: null } : await defsFor([...ids]);
        sites = parseRgLines(res.stdout, treeRoot);
      }
      // rg exits 1 for "no match" — an empty answer, not a failure; 2 is a real error.
      const error = res.code === 2 ? `rg exit 2: ${res.stderr.trim().slice(-200)}` : null;
      return { sites, responseBytes: Buffer.byteLength(res.stdout), error };
    },
  };
}

export { dirBytes, phaseOf, stat };
