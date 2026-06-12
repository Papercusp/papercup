/**
 * runOneAutoloopCycle — the CALLABLE gym-cycle machinery (learning-system-audit
 * P-031), factored out of the old `gym-loop-run.ts` main() so the
 * `system:gym-cycle` routine action can run a cycle IN-PROCESS (no shell-out)
 * and the CLI (`gym-loop-run.ts`) stays a thin wrapper around the same code.
 *
 * One call = one bounded autoloop run for ONE harness: provision a dedicated
 * ephemeral gym PG (testcontainer), seed a tiny substrate repo, boot a headless
 * gym-operator, run `runOptimizationLoop` over `buildLoopDeps` (baseline →
 * propose → evaluate → gate → record), then tear everything down. Execution
 * data lands in the ephemeral gym DB; the control plane (proposals / autoloop
 * config / QD archive) goes to `opts.controlSql` (the LIVE operator DB when
 * called from the routine action) or `GYM_LOOP_CONTROL_DSN`, else the gym DB.
 *
 * Two modes (opts.fake / env GYM_LOOP_FAKE=1): fake agent + fake judge + fake
 * proposer = ZERO-LLM assembly check; real mode runs the real pipeline + the
 * frozen Opus judge, bounded by maxCycles × a hard budgetUsd (D-019).
 *
 * ALWAYS human-gated here: autoPromote is false — the loop records proposals
 * for review and the human promotes via gym:accept (D-020).
 *
 * P-032: `opts.candidateDirections` (triage-routed gym ideas from the
 * improvements backlog) flow into the proposer's context as candidate
 * directions; absent/empty ⇒ byte-identical proposer prompt to before.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { provisionGymDatabase } from './gym-db-init';
import { buildGymOperatorBootSpec } from './boot-spec';
import { createGymRunnerPorts } from './runner-ports';
import { buildLoopDeps, type LoopTask } from './loop-deps';
import { runOptimizationLoop, type LoopResult } from './loop';
import { makeLoopProposalRecorder, setAutoloop, getAutoloop } from './control-plane';
import { gatherChampionOutcomeEntries } from './post-acceptance-outcomes';
import { makeLoopQdSeams } from './qd/archive-recorder';
import { readPoolAggregates } from './read-api';
import { GYM_JUDGE_RUBRIC_V1, rubricHash } from './judge-scoring';
import type { JudgeLlmCall } from './judge';
import type { GymLlmCall } from './task-generator';
import { waitForOperatorReady } from './operator-ready';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const FAKE_AGENT = join(__dirname, 'fixtures/fake-agent.mjs');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mask credentials in postgres DSNs (safe for logs / reports). */
export const maskDsn = (s: string): string => s.replace(/(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s/]*(@)/g, '$1***$2');

/** Two pools on one tiny substrate: a train task (drives the proposer) + a frozen dev-anchor. */
function fixedTasks(): { tasks: LoopTask[]; substrateFiles: Array<{ path: string; content: string }> } {
  const common = { repoUrl: '__SET_AT_RUNTIME__', repoCommit: '__SET_AT_RUNTIME__', projectContext: 'A tiny Node service (index.js) with a minimal HTTP handler.' };
  return {
    tasks: [
      { taskId: 'gym-loop-health', pool: 'train', spec: 'Add a health endpoint so operators can check the service is alive.', intent: 'Operators need a liveness probe for the service.', ...common },
      { taskId: 'gym-loop-version', pool: 'dev-anchor', spec: 'Expose the service version on a /version route.', intent: 'Operators need to see which build is running.', ...common },
      // D-014/P-028 real-anchor: scored every cycle but NEVER optimized (excluded from the
      // train/dev-anchor aggregation in buildLoopDeps.evaluate) — the falsifiability check.
      // NOTE: a faithful real-anchor is a corpus of REAL shipped features with known outcomes;
      // this synthetic stand-in exercises the MECHANISM (pool → scored-not-optimized → read-api
      // surfacing). Populating it with real features is the data-gathering follow-up.
      { taskId: 'gym-loop-ready', pool: 'real-anchor', spec: 'Add a readiness endpoint that reports the service can accept traffic.', intent: 'A representative shipped feature: operators gate traffic on a readiness signal.', ...common },
    ],
    substrateFiles: [
      // Buildable package so the chunk-loop L1 gate (`npm run typecheck`) is meaningful — see ab-run.ts.
      { path: 'package.json', content: JSON.stringify({ name: 'gym-substrate', version: '0.0.0', private: true, type: 'module', scripts: { typecheck: 'node --check index.js' } }, null, 2) + '\n' },
      { path: 'index.js', content: 'export function handle(req){ return { status: 404 }; }\n' },
      { path: 'README.md', content: '# gym loop substrate\nA tiny Node (ESM) service. `npm run typecheck` is the build gate.\n' },
    ],
  };
}

/** Fake judge: deterministic composite from trace length (zero LLM) — assembly check only. */
const fakeJudge: JudgeLlmCall = async (opts) => {
  const userLen = opts.messages.map((m) => m.content).join('').length;
  const c = 5 + (userLen % 5);
  return { text: JSON.stringify({ d1: c, d2: c, d3: c, rationale: 'fake-judge assembly check' }), costUsd: 0, inputTokens: 10, outputTokens: 10 };
};

/** Fake proposer: a fixed prompts-only edit (zero LLM) — assembly check only. */
const fakeProposer: GymLlmCall = async () => ({
  text: JSON.stringify({ promptOverrides: { worker: '# Worker\nBefore finishing, RE-READ the acceptance criteria and confirm each is met.' }, rationale: 'targets the worst train task' }),
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
});

export interface RunOneAutoloopCycleOptions {
  /** Workspace the run is scoped to (default env GYM_LOOP_WORKSPACE / 'gym-loop-ws'). */
  workspaceId?: string;
  /** Fake (zero-LLM) assembly mode (default env GYM_LOOP_FAKE === '1'). */
  fake?: boolean;
  /** Cycles to run this call (default env GYM_LOOP_MAX_CYCLES / 1). */
  maxCycles?: number;
  /** Repeats per (variant × task) — P-025 judge-noise averaging (default env GYM_LOOP_REPEATS / 1). */
  repeats?: number;
  /** Hard spend cap for THIS call (D-019). Default env GYM_LOOP_BUDGET_USD; real mode falls back to $50. */
  budgetUsd?: number | null;
  /** P-032: triage-routed gym ideas, pre-formatted — the proposer's candidate directions. */
  candidateDirections?: string[];
  /**
   * CALLER-OWNED control-plane client (proposals/autoloop/QD live here). Never
   * closed by this call. Takes precedence over controlDsn/GYM_LOOP_CONTROL_DSN.
   */
  controlSql?: Sql;
  /** Control-plane DSN this call opens AND closes itself (default env GYM_LOOP_CONTROL_DSN). */
  controlDsn?: string;
  /**
   * Write the gym_autoloop_config row around the run (the standalone-CLI behavior:
   * enabled:true + budget + running before; idle/paused + spentUsd OVERWRITE after).
   * The routine action passes FALSE — the tick core owns running→idle + spend
   * ACCUMULATION there (autoloop-tick.ts). Default true (CLI compatibility).
   */
  manageAutoloopRow?: boolean;
  /** Gym-operator HTTP port (default env GYM_LOOP_PORT / 3976). */
  port?: number;
  /** Real-mode agent command (default env GYM_LOOP_AGENT_CMD / claude sonnet). */
  agentCmd?: string;
  /** Proposer model — decorrelated from the judge per D-015 (default env / sonnet). */
  proposerModel?: string;
  /** QD novelty weight ∈ [0,1] (P-011/D-008; default env GYM_LOOP_NOVELTY_WEIGHT / 0.3). */
  noveltyWeight?: number;
  log?: (msg: string) => void;
}

export interface AutoloopCycleOutcome {
  /** True iff the loop completed ≥1 cycle without tripping the breaker. */
  ok: boolean;
  /** The loop result (spend/accepts/breaker), or null when the run errored before finishing. */
  result: LoopResult | null;
  /** The full diagnostic report (mode, loop, pool aggregates, error, operator log tail). */
  report: Record<string, unknown>;
}

/**
 * Run ONE bounded, human-gated autoloop cycle for `slug`. Never calls
 * process.exit; never throws for a failed run (inspect `outcome.ok` /
 * `report.error`). All existing in-loop gates apply: the budget cap
 * (runOptimizationLoop's budgetUsd), the rate-limit pause+resume
 * (runWithRatePause inside loop/loop-deps), and the arithmetic circuit
 * breaker (auto-revert + breakerTripped).
 */
export async function runOneAutoloopCycle(
  slug: string,
  opts: RunOneAutoloopCycleOptions = {},
): Promise<AutoloopCycleOutcome> {
  // The gym judge + agents use the CODE backend (the `claude` CLI), not anthropic-direct — it paces
  // against the subscription session rather than hammering api.anthropic.com. Set before the
  // lazy llm-client import below (TEST_BACKEND is read at that module's init). Overridable.
  process.env.LLM_TEST_BACKEND = process.env.LLM_TEST_BACKEND ?? 'claude-code';

  const FAKE = opts.fake ?? process.env.GYM_LOOP_FAKE === '1';
  const PORT = opts.port ?? Number(process.env.GYM_LOOP_PORT ?? 3976);
  const WS = opts.workspaceId ?? process.env.GYM_LOOP_WORKSPACE ?? 'gym-loop-ws';
  const MAX_CYCLES = Math.max(1, opts.maxCycles ?? Number(process.env.GYM_LOOP_MAX_CYCLES ?? 1));
  const REPEATS = Math.max(1, opts.repeats ?? Number(process.env.GYM_LOOP_REPEATS ?? 1));
  const BUDGET_USD =
    opts.budgetUsd !== undefined
      ? opts.budgetUsd
      : process.env.GYM_LOOP_BUDGET_USD
        ? Number(process.env.GYM_LOOP_BUDGET_USD)
        : FAKE
          ? null
          : 50;
  const REAL_AGENT_CMD = opts.agentCmd ?? process.env.GYM_LOOP_AGENT_CMD ?? 'claude -p --model claude-sonnet-4-6';
  const PROPOSER_MODEL = opts.proposerModel ?? process.env.GYM_LOOP_PROPOSER_MODEL ?? 'claude-sonnet-4-6';
  const NOVELTY_WEIGHT = Math.min(1, Math.max(0, opts.noveltyWeight ?? Number(process.env.GYM_LOOP_NOVELTY_WEIGHT ?? 0.3)));
  const manageRow = opts.manageAutoloopRow ?? true;
  const log = opts.log ?? ((m: string) => process.stdout.write(`[gym-loop] ${m}\n`));

  const HEX = randomBytes(4).toString('hex');
  const DB_NAME = `papercusp_gym_loop_${HEX}`;

  let pgContainer: StartedPostgreSqlContainer | undefined;
  let operator: ChildProcess | undefined;
  let logFd: number | undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'gym-loop-'));
  const substrateDir = join(scratch, 'substrate');
  const opLogPath = join(tmpdir(), `gym-loop-op-${HEX}.log`);
  let gymUri = '';
  let gymSql: postgres.Sql | undefined;
  let controlSql: Sql | undefined;
  let ownsControlSql = false;
  let result: LoopResult | null = null;
  let ok = false;
  const report: Record<string, unknown> = {
    mode: FAKE ? 'fake (zero-LLM)' : 'real',
    maxCycles: MAX_CYCLES,
    repeats: REPEATS,
    budgetUsd: BUDGET_USD,
    harnessSlug: slug,
    noveltyWeight: NOVELTY_WEIGHT,
    candidateDirections: opts.candidateDirections?.length ?? 0,
  };

  try {
    // 1. Dedicated gym DB (execution data).
    log('provisioning gym DB …');
    pgContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16').withDatabase('papercusp_loop').start();
    ({ databaseUri: gymUri } = await provisionGymDatabase({ maintenanceUri: pgContainer.getConnectionUri(), dbName: DB_NAME }));
    gymSql = postgres(gymUri, { max: 4, onnotice: () => {}, prepare: false });
    // Control plane (proposals/autoloop/QD) → caller's client, else a DSN we open, else the gym DB.
    const controlDsn = opts.controlDsn ?? process.env.GYM_LOOP_CONTROL_DSN;
    if (opts.controlSql) {
      controlSql = opts.controlSql;
    } else if (controlDsn) {
      controlSql = postgres(controlDsn, { max: 2, onnotice: () => {}, prepare: false });
      ownsControlSql = true;
    } else {
      controlSql = gymSql;
    }

    // 2. Tiny substrate repo, pinned at its seed commit.
    const { tasks, substrateFiles } = fixedTasks();
    mkdirSync(substrateDir, { recursive: true });
    mkdirSync(join(substrateDir, '.papercusp'), { recursive: true });
    // Production-fidelity: the REAL chunk-loop worker model with the L1 gate pointed at the
    // substrate's dependency-free `npm run typecheck`. The substrate is buildable. See ab-run.ts.
    writeFileSync(join(substrateDir, '.papercusp', 'config.json'), JSON.stringify({ worktrees: { enabled: false }, parallelWorkers: { workingStateCheck: 'npm run typecheck' } }));
    for (const f of substrateFiles) writeFileSync(join(substrateDir, f.path), f.content);
    execFileSync('git', ['init', '-q'], { cwd: substrateDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'add', '-A'], { cwd: substrateDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'commit', '-qm', 'seed'], { cwd: substrateDir });
    const substrateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: substrateDir, encoding: 'utf8' }).trim();
    for (const t of tasks) { t.repoUrl = substrateDir; t.repoCommit = substrateCommit; }

    // 3. Boot the gym-operator (fake or real agent).
    const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const spec = buildGymOperatorBootSpec({
      pinnedCheckoutPath: REPO_ROOT,
      harnessCommit,
      gymDatabaseUrl: gymUri,
      honoPort: PORT,
      workspaceId: WS,
      agentCmd: FAKE ? `node ${FAKE_AGENT}` : REAL_AGENT_CMD,
    });
    logFd = openSync(opLogPath, 'w');
    log(`booting gym-operator on :${PORT} (mode=${FAKE ? 'fake' : 'real'}, log → ${opLogPath}) …`);
    operator = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, PAPERCUSP_FLEET_SANDBOX: '0', PAPERCUSP_USE_WORKER_CHUNK_LOOP: '0', NODE_ENV: 'production', PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: 'none' },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    // EI-368: readiness (DBOS launched), not liveness — and fail fast with the
    // boot-log tail if the operator dies mid-migration instead of letting the
    // first pipeline call hit a half-migrated dbos schema.
    await waitForOperatorReady({ baseUrl: `http://127.0.0.1:${PORT}`, child: operator, timeoutMs: 120_000, logPath: opLogPath });
    log('operator ready (DBOS launched)');

    // 4. LLM calls — imported lazily so fake mode never loads the llm-client graph.
    const judge: JudgeLlmCall = FAKE ? fakeJudge : (await import('../llm-testing/llm-client')).llmCall;
    const proposer: GymLlmCall = FAKE ? fakeProposer : ((await import('../llm-testing/llm-client')).llmCall as unknown as GymLlmCall);

    // 5. Ports + loop deps.
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    const suToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
    const ports = createGymRunnerPorts({ operatorBaseUrl: `http://127.0.0.1:${PORT}`, gymSql, superuserToken: suToken, workspaceId: WS });
    // P-010/P-011 (D-008): the QD record + novelty seams over ONE live archive (+ a shared
    // variantId→descriptor cache), so noveltyForVariant's reads see recordArchive's writes.
    const qdSeams = makeLoopQdSeams(controlSql, { workspaceId: WS, harnessSlug: slug });
    // P-030 (B-09): measured post-acceptance outcomes of past champions prime the
    // proposer. Defensive — a read failure yields [] and the cycle proceeds.
    const championOutcomes = await gatherChampionOutcomeEntries(controlSql, { workspaceId: WS, harnessSlug: slug });
    report.championOutcomes = championOutcomes.length;
    const deps = buildLoopDeps({
      gymSql,
      ports,
      judgeCall: judge,
      proposerCall: proposer,
      proposerModel: PROPOSER_MODEL,
      tasks,
      rubric: GYM_JUDGE_RUBRIC_V1,
      baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
      harnessCommit,
      workspaceId: WS,
      scratchRoot: scratch,
      timeoutMs: FAKE ? 240_000 : 1_200_000,
      pollIntervalMs: 3000,
      maxDistillChars: 60_000,
      repeats: REPEATS, // P-025
      // P-032: triage-routed gym ideas → the proposer's candidate directions (additive).
      candidateDirections: opts.candidateDirections,
      // P-030: recent champion post-acceptance outcome lines (additive priming).
      championOutcomes,
      // Human-gated (D-020): the loop records proposals for review; the human promotes via gym:accept.
      recordProposal: makeLoopProposalRecorder(controlSql, { workspaceId: WS, harnessSlug: slug }),
      // P-010 (D-008): feed each evaluated variant into the QD novelty/diversity archive.
      recordArchive: qdSeams.recordArchive,
      // P-011 (D-008): the distance-from-archive novelty signal for QD parent selection.
      noveltyForVariant: qdSeams.noveltyForVariant,
    });

    // 6. (CLI mode) mark autoloop running, run the loop, then settle the status.
    if (manageRow) {
      await setAutoloop(controlSql, { workspaceId: WS, harnessSlug: slug, enabled: true, budgetUsd: BUDGET_USD, status: 'running' });
    }
    log(`running loop: maxCycles=${MAX_CYCLES} budget=${BUDGET_USD === null ? '∞' : '$' + BUDGET_USD} (autoPromote:false, human-gated) …`);
    result = await runOptimizationLoop(
      {
        // ε/δ are placeholders until P-014 derives them from measured variance; the human gate
        // reviews each proposal anyway, so these only steer the loop's advisory verdict.
        thresholds: { epsilon: 0.1, delta: 0.5, costCeiling: 3 },
        baselineMeanCost: 1,
        baselineOfRecord: 0,
        dropThreshold: 1000,
        maxCycles: MAX_CYCLES,
        budgetUsd: BUDGET_USD,
        proposerModel: PROPOSER_MODEL,
        autoPromote: false,
        // P-011 (D-008): quality-diversity parent selection when a novelty weight is set (>0);
        // unset ⇒ the loop falls back to legacy fitness-headroom selection (unchanged).
        ...(NOVELTY_WEIGHT > 0 ? { qualityDiversity: { noveltyWeight: NOVELTY_WEIGHT } } : {}),
      },
      deps,
    );

    if (manageRow) {
      await setAutoloop(controlSql, {
        workspaceId: WS,
        harnessSlug: slug,
        status: result.breakerTripped ? 'paused' : 'idle',
        spentUsd: result.spentUsd,
      });
    }

    report.loop = result;
    report.autoloop = await getAutoloop(controlSql, { workspaceId: WS, harnessSlug: slug });
    // D-014/P-028 falsifiability surface: train vs real-anchor composite per variant. If the
    // train aggregate climbs across variants while the real-anchor stays flat, the loop is
    // optimizing a proxy (the real-anchor is scored every cycle but never optimized).
    const rh = rubricHash(GYM_JUDGE_RUBRIC_V1);
    report.trainByVariant = await readPoolAggregates(gymSql, 'train', rh);
    report.realAnchorByVariant = await readPoolAggregates(gymSql, 'real-anchor', rh);
    ok = result.cycles >= 1 && !result.breakerTripped;
  } catch (err) {
    report.error = String(err);
  } finally {
    if (controlSql && ownsControlSql) { try { await controlSql.end({ timeout: 5 }); } catch { /* ignore */ } }
    if (gymSql) { try { await gymSql.end({ timeout: 5 }); } catch { /* ignore */ } }
    if (operator?.pid) {
      try { process.kill(-operator.pid, 'SIGTERM'); } catch { /* ignore */ }
      await sleep(2500);
      try { process.kill(-operator.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (logFd !== undefined) { try { report.operatorLogTail = maskDsn(readFileSync(opLogPath, 'utf8').split('\n').slice(-20).join('\n')); } catch { /* ignore */ } }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (pgContainer) await pgContainer.stop(); } catch { /* ignore */ }
  }

  return { ok, result, report };
}
