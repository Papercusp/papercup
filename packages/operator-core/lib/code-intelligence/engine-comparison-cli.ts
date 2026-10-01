/**
 * engine-comparison-cli.ts — P-005 four-arm code-intelligence comparison (plan
 * `gitnexus-selective-hardening-and-comparison-2026-09-13`, WI-10001405).
 *
 * Arms (each owns a byte-identical copy of the bounded tree + its own scratch HOME, built by
 * `<bench>/prep.sh` from one git commit, so no arm can see another's index and no real
 * `~/.gitnexus` / `~/.cache` is touched):
 *   baseline-lsp-rg      scripted rg — what an agent without a graph does
 *   gitnexus-installed   the version this workspace serves today
 *   gitnexus-candidate   one pinned upgrade (vendor/gitnexus-<version>)
 *   codebase-memory      isolated CLI of the locally built binary (never `install`, no hooks)
 *
 * USAGE (one arm per process is the recommended shape: each persists `report-<arm>.json`
 * the moment it finishes, so a later crash never loses a finished arm):
 *   npx tsx packages/operator-core/lib/code-intelligence/engine-comparison-cli.ts --arm baseline-lsp-rg
 *   npx tsx …/engine-comparison-cli.ts --arm gitnexus-installed,gitnexus-candidate,codebase-memory
 *   npx tsx …/engine-comparison-cli.ts --aggregate        # evidence markdown + verdict from the report files
 *
 * The cold index of the two GitNexus arms was measured ONCE under `/usr/bin/time -v`
 * (≈15–20 min and 8–10 GB each on this box) and is re-used, never repeated; refresh/update
 * fixtures and every query run LIVE. CBM's cold index runs live on an emptied cache so the
 * detached daemon's peak RSS is sampled (a `time -v` of its client alone reads ~17 MB).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SELECTIVE_ACCEPTANCE_CORPUS } from './selective-corpus';
import type { CodeIntelIntent } from './contracts';
import { gitnexusFacade, gitnexusOpForIntent } from './gitnexus-facade';
import { createGitnexusArm, createRgBaselineArm, execTimed } from './engine-comparison-arms';
import { createCodebaseMemoryArm } from './engine-comparison-cbm';
import { phaseCostFromTimeLogs, withPrecomputedIndex } from './engine-comparison-precomputed';
import { runEngineArm, type ArmReport, type EngineArm, type EngineComparisonDeps, type EngineRunMeta } from './engine-comparison';
import { ARM_ORDER, orderReports, parseCliArgs, preregHash, renderEvidence, type CliArmId } from './engine-comparison-report';

const BENCH = process.env.PAPERCUSP_ENGINE_BENCH_ROOT ?? path.join(os.homedir(), '.papercusp/bench/engine-comparison-2026-10');
const ARM_DIR: Readonly<Record<CliArmId, string>> = {
  'baseline-lsp-rg': 'baseline',
  'gitnexus-installed': 'gitnexus-installed',
  'gitnexus-candidate': 'gitnexus-candidate',
  'codebase-memory': 'codebase-memory',
};
const INSTALLED_GITNEXUS_BIN = path.join(os.homedir(), '.papercusp/vendor/gitnexus/node_modules/.bin/gitnexus');
const CANDIDATE_GITNEXUS_DIR = path.join(BENCH, 'vendor/gitnexus-1.6.12');
const CBM_DIR = path.join(BENCH, 'vendor/cbm');
const CBM_BIN = path.join(CBM_DIR, 'build/bench/codebase-memory-mcp');

const armDir = (id: CliArmId): string => path.join(BENCH, 'arms', ARM_DIR[id]);
const treeOf = (id: CliArmId): string => path.join(armDir(id), 'tree');

const deps: EngineComparisonDeps = {
  now: () => Date.now(),
  loadAvg1: () => os.loadavg()[0] ?? null,
  readFile: (p) => fs.readFile(p, 'utf8'),
  writeFile: (p, c) => fs.writeFile(p, c),
  rm: (p) => fs.rm(p, { recursive: true, force: true }),
  chmod: (p, m) => fs.chmod(p, m),
  gitRestore: async (root, rels) => {
    const r = await execTimed('git', ['checkout', '--', ...rels], { cwd: root });
    if (r.code !== 0) throw new Error(`git checkout exit ${r.code}: ${r.stderr.trim().slice(-200)}`);
  },
  // The tree hash of the arm's baseline commit; `+dirty` if tracked files differ, so a mutated arm can
  // never silently claim parity with a clean one.
  treeFingerprint: async (root) => {
    const tree = await execTimed('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root });
    if (tree.code !== 0) return null;
    const dirty = await execTimed('git', ['diff', '--quiet', 'HEAD'], { cwd: root });
    return `${tree.stdout.trim()}${dirty.code === 0 ? '' : '+dirty'}`;
  },
};

const lastLine = (s: string): string => s.trim().split('\n').pop()?.trim() ?? '';

async function binVersion(bin: string): Promise<string> {
  const r = await execTimed(bin, ['--version'], { cwd: BENCH, timeoutMs: 60_000 });
  return r.code === 0 ? lastLine(r.stdout) || 'unknown' : `unknown (exit ${r.code})`;
}

const precomputed = (id: CliArmId) => async () =>
  phaseCostFromTimeLogs({
    timeV: await fs.readFile(path.join(armDir(id), 'analyze.err'), 'utf8').catch(() => ''),
    stdout: await fs.readFile(path.join(armDir(id), 'analyze.out'), 'utf8').catch(() => ''),
    loadAfter: await fs.readFile(path.join(armDir(id), 'load-after.txt'), 'utf8').catch(() => null),
  });

const opForIntent = (intent: string): string | null => gitnexusOpForIntent(intent as CodeIntelIntent);
// The arm wants a plain (op, args, dispatch) function; the production facade is typed on its own op union.
const facade = (op: string, args: Record<string, unknown>, dispatch: (t: string, a: Record<string, unknown>) => Promise<unknown>) =>
  gitnexusFacade(op as Parameters<typeof gitnexusFacade>[0], args, dispatch as Parameters<typeof gitnexusFacade>[2]);

async function buildArm(id: CliArmId): Promise<EngineArm> {
  const treeRoot = treeOf(id);
  if (id === 'baseline-lsp-rg') return createRgBaselineArm(treeRoot, deps);
  if (id === 'codebase-memory') {
    const home = path.join(armDir(id), 'home');
    const cacheDir = path.join(home, 'cache');
    // Cold from an EMPTY cache so the live index run is a real cold index with daemon RSS sampled.
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.mkdir(cacheDir, { recursive: true });
    const commit = await execTimed('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: CBM_DIR });
    return createCodebaseMemoryArm({ id, version: `dev@${commit.stdout.trim() || 'unknown'}`, bin: CBM_BIN, treeRoot, home, cacheDir }, deps);
  }
  const bin = id === 'gitnexus-installed' ? INSTALLED_GITNEXUS_BIN : path.join(CANDIDATE_GITNEXUS_DIR, 'node_modules/.bin/gitnexus');
  // Measured raw `startLine` base per pinned version (see GitnexusArmConfig.startLineBase): 1.6.9 (installed) is
  // 0-based, 1.6.12 (candidate) is 1-based — the facade's unconditional +1 is only right for the former.
  const startLineBase = id === 'gitnexus-installed' ? 0 : 1;
  const live = createGitnexusArm({ id, version: await binVersion(bin), bin, treeRoot, home: path.join(armDir(id), 'home'), startLineBase }, deps, facade, opForIntent);
  return withPrecomputedIndex(live, precomputed(id));
}

async function runArms(ids: readonly CliArmId[], warmSamples: number, evidenceDir: string): Promise<void> {
  await fs.mkdir(evidenceDir, { recursive: true });
  for (const id of ids) {
    const started = Date.now();
    process.stdout.write(`[${new Date().toISOString()}] arm ${id}: start (load1=${os.loadavg()[0]?.toFixed(1)})\n`);
    const arm = await buildArm(id);
    const report = await runEngineArm(arm, { warmSamples, cases: SELECTIVE_ACCEPTANCE_CORPUS }, deps);
    await fs.writeFile(path.join(evidenceDir, `report-${id}.json`), JSON.stringify(report, null, 2));
    const ok = report.cases.filter((c) => c.correct).length;
    process.stdout.write(`[${new Date().toISOString()}] arm ${id}: done in ${((Date.now() - started) / 1000).toFixed(0)}s — correct ${ok}/${report.cases.length}, fixtures ${report.fixtures.filter((f) => f.pass).length}/${report.fixtures.length}${report.error ? `, ERROR ${report.error}` : ''}\n`);
  }
}

const nodeCounts = (out: string): string | null => {
  const m = /([\d,]+) nodes \| ([\d,]+) edges/.exec(out);
  return m ? `${m[1]} nodes / ${m[2]} edges` : null;
};

async function aggregate(evidenceDir: string): Promise<void> {
  const reports: ArmReport[] = [];
  for (const id of ARM_ORDER) {
    const raw = await fs.readFile(path.join(evidenceDir, `report-${id}.json`), 'utf8').catch(() => null);
    reports.push(
      raw === null
        ? { armId: id, version: 'n/a', unavailable: `no report-${id}.json — arm was not run`, treeFingerprint: null, coldIndex: null, indexBytes: null, cases: [], fixtures: [], error: null }
        : (JSON.parse(raw) as ArmReport),
    );
  }
  const notes: string[] = [
    'GitNexus cold-index wall/RSS are ONE real `/usr/bin/time -v` run each (not repeated), taken under heavy shared-host load; load averages before/after are in arms/<arm>/load-{before,after}.txt. Read them as upper bounds comparable within load noise, never as precise ratios.',
    'CBM cold index ran LIVE on an emptied cache with the detached daemon\'s VmHWM sampled; the earlier `time -v` of its client alone (3:49.74 wall, 17 MB RSS) is kept only as a wall-time cross-check.',
    'Bench mappings are disclosed adapters fixed before the run, not tuned after results: GitNexus `symbol-search` → native `context`, `text-search` declined (its `query` is concept search); CBM routes via `search_graph` / `trace_path` / `search_code`. A declined or missed case is scored incorrect for that arm, same grader for every arm.',
    'Run order and attempt history (disclosed, not hidden): baseline, then codebase-memory, then an ATTEMPT 1 that ran the two GitNexus arms concurrently. Attempt 1 of gitnexus-installed was aborted: an execFile timeout killed the direct child only, and the wrapped grandchild kept running and corrupted the installed `.gitnexus` index (fixed with a `timeout -k` wrapper in `execTimed`, guarded by engine-comparison-exec.test.ts; the installed index was rebuilt cold before its final run). The FINAL gitnexus-installed and gitnexus-candidate reports are SEQUENTIAL SOLO reruns; attempt-1 files are kept beside them as `*.attempt1*`. The box (shared with the whole fleet) carried load average 100–260 throughout, so every wall time is a loaded-host figure. ATTEMPT 2 of gitnexus-installed (solo) was also lost: it was frozen mid-refresh (`gitnexus analyze --skip-agents-md .`, under its 1_800_000ms `timeout -k` wall-clock deadline) by a fleet-wide pause, and the thaw would have tripped that deadline and killed the analyzer mid-write, so it was killed deliberately and the installed index was restored by a cold forced `gitnexus analyze --force` (restore logs kept as `restore-analyze*.{out,err}` beside the arm; node/edge counts within 12 of the original index). The reported gitnexus-installed numbers are the ATTEMPT 3 run on that restored index, started from a pristine snapshot of it; only that attempt\'s measurements are reported, and the only things carried across attempts are the harness and the fixture files, never an index state.',
    'Two grading defects in this harness were found AFTER attempt 1 and fixed for ALL arms by one rule — post-hoc, disclosed; the preregistered case ids, warm samples and disposition bars are untouched (preregHash unchanged). (1) `error` is a caveat channel, not a failure flag: graded as one, it zeroed both GitNexus arms on the edit/delete fixtures by construction, because the bench CLI dispatch has no `list_repos` and so EVERY GitNexus answer carries an "index health UNMEASURED" note. A query now counts as failed only when `error` is set AND no site came back (`answered()`); the note is kept in the fixture detail. (2) The refresh-failure fixture passed VACUOUSLY for an arm with no cold-correct case (`>= 0` holds for any engine); it now reports NOT MEASURABLE and is not a pass. The baseline and codebase-memory reports are invariant under both fixes (every case `error` is null and each has 1 cold-correct case), checked from their report JSON, so they were not rerun.',
    'GitNexus `analyze` skipped files above its default 512 KB cap in BOTH GitNexus arms (packages/operator-core/lib/inference-gateway/gateway.ts and packages/operator-core/lib/work-items.ts); `selective-exact-index-symbol` expects a site in work-items.ts. `GITNEXUS_MAX_FILE_SIZE` was NOT raised (as-installed defaults), so whether raising it changes that case is untested residue, not a finding. `gitnexus analyze` also wrote AGENTS.md/CLAUDE.md/.claude into both GitNexus trees (untracked; symmetric across the two arms, absent in the baseline and CBM trees).',
    'The baseline arm is a scripted `rg` pass, not an LSP session (the arm id is historical). `rg` exits 2 on an unreadable directory and the arm reports that as a query error, which is what drives its refresh-failure fixture result.',
    'The tool-level comparison spends ZERO LLM tokens; `estTokens` is bytes/4 for every arm. This measures the engines, not agent task outcomes.',
  ];
  for (const id of ['gitnexus-installed', 'gitnexus-candidate'] as const) {
    const out = await fs.readFile(path.join(armDir(id), 'analyze.out'), 'utf8').catch(() => '');
    const counts = nodeCounts(out);
    if (counts) notes.push(`${id} graph size from its cold analyze: ${counts}.`);
  }
  const caseIds = SELECTIVE_ACCEPTANCE_CORPUS.map((c) => c.id);
  const meta: EngineRunMeta = { runId: `engine-comparison-${new Date().toISOString().slice(0, 10)}`, seed: 0, createdAt: new Date().toISOString(), preregHash: preregHash(caseIds, 3) };
  const bundle = renderEvidence(orderReports(reports), meta, notes);
  await fs.writeFile(path.join(evidenceDir, 'engine-comparison.md'), bundle.markdown);
  await fs.writeFile(path.join(evidenceDir, 'verdict.json'), bundle.verdictJson);
  await fs.writeFile(path.join(evidenceDir, 'task-runs.json'), bundle.taskRowsJson);
  await fs.writeFile(path.join(evidenceDir, 'fairness-audit.json'), bundle.fairnessJson);
  process.stdout.write(`${bundle.markdown}\n`);
}

const opts = parseCliArgs(process.argv.slice(2));
const evidenceDir = opts.outDir ?? path.join(BENCH, 'evidence');
(opts.mode === 'aggregate' ? aggregate(evidenceDir) : runArms(opts.arms, opts.warmSamples, evidenceDir)).catch((e: unknown) => {
  process.stderr.write(`engine-comparison-cli failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
