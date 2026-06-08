/**
 * P-022 / D-020 AUTOLOOP RUNNER SERVICE — the runnable that drives the autonomous
 * optimization loop for ONE harness, budget-capped + human-gated, and records each scored
 * candidate as a reviewable proposal the gym UI shows (autoPromote:false).
 *
 * Mirrors `ab-run.ts` (boot a dedicated headless gym-operator on a fresh gym DB, run real
 * pipeline agents, score with the frozen Opus judge), but instead of a fixed A/B grid it runs
 * `runOptimizationLoop` over `buildLoopDeps`: baseline → propose → evaluate → gate → record.
 * Execution data (runs/scores/cycles/variants) → the ephemeral gym DB; the control plane
 * (proposals/autoloop config) → a control-plane DB that the LIVE operator reads (D-020) —
 * `GYM_LOOP_CONTROL_DSN` if set, else the gym DB (standalone / fake).
 *
 * Two modes (env GYM_LOOP_FAKE):
 *   GYM_LOOP_FAKE=1 → fake agent (fixtures/fake-agent.mjs) + fake judge + fake proposer →
 *                     validates the WHOLE loop assembly end-to-end with ZERO LLM spend.
 *   default (real)  → real AGENT_CMD pipeline + real opus-4-8 judge + real proposer. Bounded
 *                     (D-019): GYM_LOOP_MAX_CYCLES (default 1) × a hard GYM_LOOP_BUDGET_USD.
 *
 *   cd apps/operator && set -a; . ./.env.local; set +a; \
 *     GYM_LOOP_FAKE=1 npx tsx lib/gym/gym-loop-run.ts             # zero-LLM assembly check
 *     GYM_LOOP_MAX_CYCLES=1 npx tsx lib/gym/gym-loop-run.ts        # real run (on capacity)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { provisionGymDatabase } from './gym-db-init';
import { buildGymOperatorBootSpec } from './boot-spec';
import { createGymRunnerPorts } from './runner-ports';
import { buildLoopDeps, type LoopTask } from './loop-deps';
import { runOptimizationLoop } from './loop';
import { makeLoopProposalRecorder, setAutoloop, getAutoloop } from './control-plane';
import { makeLoopArchiveRecorder } from './qd/archive-recorder';
import { readPoolAggregates } from './read-api';
import { GYM_JUDGE_RUBRIC_V1, rubricHash } from './judge-scoring';
import type { JudgeLlmCall } from './judge';
import type { GymLlmCall } from './task-generator';

// The gym judge + agents use the CODE backend (the `claude` CLI), not meridian — it paces
// against the subscription session rather than hammering api.anthropic.com (what tripped the
// rate limit). Set before llm-client loads (TEST_BACKEND read at module init). Overridable.
process.env.LLM_TEST_BACKEND = process.env.LLM_TEST_BACKEND ?? 'claude-code';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const FAKE_AGENT = join(__dirname, 'fixtures/fake-agent.mjs');
const PORT = Number(process.env.GYM_LOOP_PORT ?? 3976);
const HEX = randomBytes(4).toString('hex');
const DB_NAME = `papercusp_gym_loop_${HEX}`;
const WS = process.env.GYM_LOOP_WORKSPACE ?? 'gym-loop-ws';
const SLUG = process.env.GYM_LOOP_HARNESS ?? 'gymloopharness';
const FAKE = process.env.GYM_LOOP_FAKE === '1';
const MAX_CYCLES = Math.max(1, Number(process.env.GYM_LOOP_MAX_CYCLES ?? 1));
// P-025: repeats per (task) to average out judge noise. P-014 measured sd≤0.5 → minRepeats≈4,
// so set GYM_LOOP_REPEATS=4 for trustworthy accept decisions; default 1 for the cheap assembly check.
const REPEATS = Math.max(1, Number(process.env.GYM_LOOP_REPEATS ?? 1));
const BUDGET_USD = process.env.GYM_LOOP_BUDGET_USD ? Number(process.env.GYM_LOOP_BUDGET_USD) : FAKE ? null : 50;
const REAL_AGENT_CMD = process.env.GYM_LOOP_AGENT_CMD ?? 'claude -p --model claude-sonnet-4-6';
// The proposer is decorrelated from the judge model (D-015) — judge is opus-4-8, proposer sonnet.
const PROPOSER_MODEL = process.env.GYM_LOOP_PROPOSER_MODEL ?? 'claude-sonnet-4-6';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stdout.write(`[gym-loop] ${m}\n`);
const mask = (s: string) => s.replace(/(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s/]*(@)/g, '$1***$2');

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status > 0) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

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

async function main(): Promise<void> {
  let pgContainer: StartedPostgreSqlContainer | undefined;
  let operator: ChildProcess | undefined;
  let logFd: number | undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'gym-loop-'));
  const substrateDir = join(scratch, 'substrate');
  const opLogPath = join(tmpdir(), `gym-loop-op-${HEX}.log`);
  let gymUri = '';
  let gymSql: postgres.Sql | undefined;
  let controlSql: postgres.Sql | undefined;
  let ok = false;
  const report: Record<string, unknown> = { mode: FAKE ? 'fake (zero-LLM)' : 'real', maxCycles: MAX_CYCLES, repeats: REPEATS, budgetUsd: BUDGET_USD, harnessSlug: SLUG };

  try {
    // 1. Dedicated gym DB (execution data).
    log('provisioning gym DB …');
    pgContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16').withDatabase('papercusp_loop').start();
    ({ databaseUri: gymUri } = await provisionGymDatabase({ maintenanceUri: pgContainer.getConnectionUri(), dbName: DB_NAME }));
    gymSql = postgres(gymUri, { max: 4, onnotice: () => {}, prepare: false });
    // Control plane (proposals/autoloop) → the live operator DB if configured, else the gym DB.
    controlSql = process.env.GYM_LOOP_CONTROL_DSN ? postgres(process.env.GYM_LOOP_CONTROL_DSN, { max: 2, onnotice: () => {}, prepare: false }) : gymSql;

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
    if (!(await waitForHttp(`http://127.0.0.1:${PORT}/llms.txt`, 120_000))) throw new Error(`gym-operator did not come up on :${PORT} (see ${opLogPath})`);
    log('operator up; giving DBOS a moment …');
    await sleep(4000);

    // 4. LLM calls — imported lazily so fake mode never loads the meridian graph.
    const judge: JudgeLlmCall = FAKE ? fakeJudge : (await import('../llm-testing/llm-client')).llmCall;
    const proposer: GymLlmCall = FAKE ? fakeProposer : ((await import('../llm-testing/llm-client')).llmCall as unknown as GymLlmCall);

    // 5. Ports + loop deps.
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    const suToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
    const ports = createGymRunnerPorts({ operatorBaseUrl: `http://127.0.0.1:${PORT}`, gymSql, superuserToken: suToken, workspaceId: WS });
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
      // Human-gated (D-020): the loop records proposals for review; the human promotes via gym:accept.
      recordProposal: makeLoopProposalRecorder(controlSql, { workspaceId: WS, harnessSlug: SLUG }),
      // P-010 (D-008): feed each evaluated variant into the QD novelty/diversity archive.
      recordArchive: makeLoopArchiveRecorder(controlSql, { workspaceId: WS, harnessSlug: SLUG }),
    });

    // 6. Mark autoloop running, run the loop, then settle the status.
    await setAutoloop(controlSql, { workspaceId: WS, harnessSlug: SLUG, enabled: true, budgetUsd: BUDGET_USD, status: 'running' });
    log(`running loop: maxCycles=${MAX_CYCLES} budget=${BUDGET_USD === null ? '∞' : '$' + BUDGET_USD} (autoPromote:false, human-gated) …`);
    const result = await runOptimizationLoop(
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
      },
      deps,
    );

    await setAutoloop(controlSql, {
      workspaceId: WS,
      harnessSlug: SLUG,
      status: result.breakerTripped ? 'paused' : 'idle',
      spentUsd: result.spentUsd,
    });

    report.loop = result;
    report.autoloop = await getAutoloop(controlSql, { workspaceId: WS, harnessSlug: SLUG });
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
    if (controlSql && controlSql !== gymSql) { try { await controlSql.end({ timeout: 5 }); } catch { /* ignore */ } }
    if (gymSql) { try { await gymSql.end({ timeout: 5 }); } catch { /* ignore */ } }
    if (operator?.pid) {
      try { process.kill(-operator.pid, 'SIGTERM'); } catch { /* ignore */ }
      await sleep(2500);
      try { process.kill(-operator.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (logFd !== undefined) { try { report.operatorLogTail = mask(readFileSync(opLogPath, 'utf8').split('\n').slice(-20).join('\n')); } catch { /* ignore */ } }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (pgContainer) await pgContainer.stop(); } catch { /* ignore */ }
  }

  process.stdout.write('\n===== GYM LOOP (P-022 / D-020) REPORT =====\n' + mask(JSON.stringify(report, null, 2)) + '\n');
  process.stdout.write(ok ? '\nGYM-LOOP: OK\n' : '\nGYM-LOOP: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
