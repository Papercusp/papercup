/**
 * REAL-QUEEN vs NO-QUEEN COMPARISON (impartial-benchmark-suite-2026-06-15 / P-033, Option B).
 *
 * Drives ONE arm (XBENCH_ARM=hive-realqueen|fifo-noqueen) over the SAME fixed SWE-bench Pro public set
 * through the REAL-Queen backlog driver ({@link ./hive-backlog-realqueen.ts}), collects per-task
 * diff/cost/tokens/turns + the coordEvents trace, and writes a per-arm result JSON in the SAME format
 * _xbench_grade.py + _xbench_report.ts already consume (so grading/reporting are unchanged).
 *
 *   - hive-realqueen → ONE hive over the WHOLE backlog, the REAL Queen persona agent wakes and
 *     places/evicts/re-places/briefs/adaptive-wakes. (The treatment.)
 *   - fifo-noqueen   → the SAME boot, the Queen NEVER wakes; scripted FIFO over the same fleet cap.
 *
 * CONTENTION: set the fleet cap (`maxSimultaneousAgents`) << backlog (~5 for ~13 tasks) BEFORE running,
 * via operator:rate_limit_config (or the launcher's RATE_LIMIT_MAX env probe). Both arms share it.
 *
 * OPUS (load-bearing): the bee floor is haiku, the queen floor is sonnet — so the driver process MUST
 * export AGENT_MODELS='{"bee":"opus:xhigh","queen":"opus:xhigh"}' AND use the `opus` CLI alias (claude
 * v2.1.177 runs opus-4-7 for `--model claude-opus-4-8`). VERIFY agent_usage_samples.model before spend.
 *
 * NOT a committed test (spends real model budget) — a throwaway launcher under lib/external-bench so the
 * workspace-relative imports resolve. Run with:
 *   PAPERCUSP_HONO_PORT=3170 PAPERCUSP_FLEET_SANDBOX=0 PAPERCUSP_SPAWN_BACKEND=claude-code \
 *   AGENT_CMD="claude -p" AGENT_MODELS='{"bee":"opus:xhigh","queen":"opus:xhigh"}' \
 *   XBENCH_ARM=hive-realqueen  npx tsx _xbench_realqueen_compare.ts
 */
import { readFileSync } from 'node:fs';
import { bindRealQueenBacklogDriver, HIVE_REALQUEEN_ARM, FIFO_NOQUEEN_ARM } from './hive-backlog-realqueen';
import { runHiveBacklog, registerFleetPlanner } from './hive-backlog';
import { planFifoPlacement } from './queen-ablation';
import type { BenchTask } from './types';

const WORKSPACE_ID = process.env.XBENCH_WORKSPACE_ID ?? 'papercusp-workspace';
const ARM = (process.env.XBENCH_ARM ?? HIVE_REALQUEEN_ARM) === FIFO_NOQUEEN_ARM ? FIFO_NOQUEEN_ARM : HIVE_REALQUEEN_ARM;
const SAMPLE = process.env.XBENCH_SAMPLE ?? '/tmp/xbench-sample.jsonl';
const REPOS_ROOT = process.env.XBENCH_REPOS_ROOT ?? '/tmp/xbench-repos';
const OUT_DIR = process.env.XBENCH_OUT_DIR ?? '/tmp/xbench-realqueen-out';
const MAX_USD_PER_TASK = Number(process.env.XBENCH_MAX_USD ?? 10);
const MAX_TOKENS_PER_TASK = Number(process.env.XBENCH_MAX_TOKENS ?? 4_000_000);
const MAX_TASKS = process.env.XBENCH_MAX_TASKS ? Number(process.env.XBENCH_MAX_TASKS) : undefined;

interface Row {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  fail_to_pass: string;
  selected_test_files_to_run?: string;
  language?: string;
}

function pyList(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s.replace(/'/g, '"'));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function dockerhubTag(instanceId: string, repo: string): string {
  const [repoBase, repoNameRaw] = repo.toLowerCase().split('/');
  let repoNameOnly = repoNameRaw;
  let hsh = instanceId.replace(/^instance_/, '');
  if (instanceId === 'instance_element-hq__element-web-ec0f940ef0e8e3b61078f145f34dc40d1938e6c5-vnan') {
    repoNameOnly = 'element-web';
  } else if (repo.toLowerCase().includes('element-hq') && repo.toLowerCase().includes('element-web')) {
    repoNameOnly = 'element';
    if (hsh.endsWith('-vnan')) hsh = hsh.slice(0, -5);
  } else if (hsh.endsWith('-vnan')) {
    hsh = hsh.slice(0, -5);
  }
  let tag = `${repoBase}.${repoNameOnly}-${hsh}`;
  if (tag.length > 128) tag = tag.slice(0, 128);
  return tag;
}

function shortName(instanceId: string): string {
  return instanceId.replace(/^instance_/, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
}

function loadTasks(): BenchTask[] {
  const lines = readFileSync(SAMPLE, 'utf8').trim().split('\n');
  let tasks = lines.map((line) => {
    const r = JSON.parse(line) as Row;
    const localRepo = `${REPOS_ROOT}/${shortName(r.instance_id)}`;
    return {
      benchmark: 'swe-bench-pro',
      instanceId: r.instance_id,
      problemStatement: r.problem_statement,
      repo: localRepo,
      baseCommit: r.base_commit,
      language: r.language,
      graderMeta: {
        dockerhub_tag: dockerhubTag(r.instance_id, r.repo),
        FAIL_TO_PASS: pyList(r.fail_to_pass),
        PASS_TO_PASS: [],
        testFiles: pyList(r.selected_test_files_to_run),
      },
    } satisfies BenchTask;
  });
  if (MAX_TASKS != null) tasks = tasks.slice(0, MAX_TASKS);
  return tasks;
}

async function main() {
  const tasks = loadTasks();
  console.log(`[realqueen] arm=${ARM} ws=${WORKSPACE_ID} tasks=${tasks.length} port=${process.env.PAPERCUSP_HONO_PORT ?? '(default)'}`);
  console.log(`[realqueen] AGENT_MODELS=${process.env.AGENT_MODELS ?? '(unset — bees/queen fall to role floor!)'} AGENT_CMD=${process.env.AGENT_CMD ?? '(unset)'}`);
  for (const t of tasks) console.log(`  - ${t.instanceId} (repo=${t.repo})`);

  // CONTENTION CAP (load-bearing): this driver spawns bees IN-PROCESS via operator-spawn,
  // whose `spawnConcurrencyCeiling()` reads the module-cached rate-limit config. A fresh
  // node process boots that cache to the DEFAULT (16) — it does NOT auto-read the
  // persisted `operator_rate_limit_config` the :3170 PUT set. So WITHOUT this, the
  // in-process headroom reports ~16 and the Queen over-places, defeating the saturated-
  // fleet contention (cap << backlog). Honor RATE_LIMIT_MAX (explicit) else load the
  // persisted value, and apply it to THIS process's cache before any placement.
  {
    const { writeRateLimitConfig, initRateLimitConfig, getCachedRateLimitConfig } = await import('../rate-limit-config');
    const envMax = process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : undefined;
    if (envMax && Number.isFinite(envMax)) {
      await writeRateLimitConfig({ maxSimultaneousAgents: envMax }); // persist + apply to this cache
    } else {
      await initRateLimitConfig(); // load the persisted operator_rate_limit_config into this cache
    }
    console.log(`[realqueen] fleet cap (in-process ceiling) = ${getCachedRateLimitConfig().maxSimultaneousAgents} (RATE_LIMIT_MAX=${process.env.RATE_LIMIT_MAX ?? '(unset → persisted)'})`);
  }

  // The FIFO arm needs its scripted planner registered; the real-Queen arm needs none (the Queen places).
  registerFleetPlanner(FIFO_NOQUEEN_ARM, planFifoPlacement);

  bindRealQueenBacklogDriver({
    workspaceId: WORKSPACE_ID,
    fleetTimeoutMs: Number(process.env.XBENCH_FLEET_TIMEOUT_MS ?? 120 * 60 * 1000),
    pollIntervalMs: Number(process.env.XBENCH_POLL_MS ?? 20_000),
  });

  const budget = { maxUsd: MAX_USD_PER_TASK, maxTokens: MAX_TOKENS_PER_TASK };
  const runId = `xbench-rq-${ARM}-${Date.now()}`;
  const startedAt = Date.now();
  console.log(`[realqueen] runId=${runId} budget/task=${JSON.stringify(budget)} starting ${new Date().toISOString()}`);

  const result = await runHiveBacklog({ arm: ARM, suite: 'swe-bench-pro', runId, seed: 1, backlog: tasks, budget });
  const wallMs = Date.now() - startedAt;

  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(`${OUT_DIR}/diffs-${ARM}`, { recursive: true });

  const perTask = result.taskResults.map((tr) => {
    const a = tr.attempt;
    const diff = a.diff ?? '';
    writeFileSync(`${OUT_DIR}/diffs-${ARM}/${a.instanceId}.diff`, diff, 'utf8');
    return {
      instanceId: a.instanceId,
      beeId: tr.beeId,
      disposition: tr.disposition,
      stopReason: a.stopReason,
      generationError: a.generationError ?? null,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      costUsd: a.costUsd,
      turns: a.turns,
      wallClockMs: a.wallClockMs,
      diffBytes: Buffer.byteLength(diff, 'utf8'),
      armMeta: a.armMeta ?? null,
    };
  });

  const totalCost = perTask.reduce((s, t) => s + (t.costUsd || 0), 0);
  const totalTokIn = perTask.reduce((s, t) => s + (t.tokensIn || 0), 0);
  const totalTokOut = perTask.reduce((s, t) => s + (t.tokensOut || 0), 0);
  const nonEmptyDiffs = perTask.filter((t) => t.diffBytes > 0).length;

  const out = {
    arm: ARM,
    runId,
    runError: result.runError ?? null,
    startedAt: new Date(startedAt).toISOString(),
    wallMs,
    peakConcurrentBees: result.peakConcurrentBees,
    taskCount: perTask.length,
    nonEmptyDiffs,
    totals: { costUsd: totalCost, tokensIn: totalTokIn, tokensOut: totalTokOut },
    perTask,
    coordEvents: result.coordEvents,
  };
  writeFileSync(`${OUT_DIR}/${ARM}.json`, JSON.stringify(out, null, 2), 'utf8');

  console.log('\n===== ARM RUN SUMMARY =====');
  console.log(JSON.stringify({
    arm: ARM, runId, runError: out.runError, wallMs,
    peakConcurrentBees: out.peakConcurrentBees, taskCount: out.taskCount, nonEmptyDiffs,
    totals: out.totals, coordEventCount: result.coordEvents.length,
    coordKinds: tally(result.coordEvents.map((e) => e.kind)),
  }, null, 2));
  console.log(`\n[realqueen] wrote ${OUT_DIR}/${ARM}.json + ${perTask.length} diffs under diffs-${ARM}/`);
  process.exit(0);
}

function tally(xs: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}

main().catch((e) => {
  console.error('[realqueen] FATAL', e instanceof Error ? e.stack : e);
  process.exit(1);
});
