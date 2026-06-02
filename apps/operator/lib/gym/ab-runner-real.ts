/**
 * Real-adapter wiring for the P-014 A/B harness (`ab-runner.ts`).
 *
 * Binds the injected `AbDeps` to the SAME smoke-proven operations the single-run spine
 * uses, so a bounded real A/B reuses validated pieces:
 *   runPipeline       → runGymPipeline (P-001) over real GymRunnerPorts (createGymRunnerPorts)
 *                       + pipelineUsd = Σ agent_runs_consolidated.cost_usd for the harness (P-027)
 *   collectAndDistill → collectTrace (P-002) + distillTrace (P-029) over the gym PG + clone
 *   judge             → the caller's `llmCall` (real meridian opus-4-8, or a fake for tests)
 *   store             → store.ts over the gym PG (createGymStore)
 *
 * `llmCall` is a REQUIRED config field (not imported here) so this module never pulls in
 * the llm-client/meridian graph — the runnable entrypoint passes the real one; tests pass
 * a fake. I/O (git diff, bundle write) uses execFile (no shell) + node:fs.
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { runGymPipeline, type GymRunnerPorts, type GymRunSpec } from './gym-runner';
import { collectTrace } from './collector';
import { distillTrace } from './distill';
import {
  insertVariant,
  insertTask,
  insertRun,
  finishRun as storeFinishRun,
  insertScore,
  compareVariants,
} from './store';
import type { AbStore, AbDeps, AbRunInput, AbRunHandle } from './ab-runner';
import type { JudgeLlmCall } from './judge';

const execFileP = promisify(execFileCb);

/** AbStore backed by the gym PG — a thin adapter over store.ts (P-012/P-013). */
export function createGymStore(sql: Sql): AbStore {
  return {
    async upsertVariant(v) {
      await insertVariant(sql, { variantId: v.variantId, label: v.label, overlay: v.overlay });
    },
    async upsertTask(t) {
      await insertTask(sql, {
        taskId: t.taskId,
        pool: t.pool,
        repoUrl: t.repoUrl,
        repoCommit: t.repoCommit,
        spec: t.spec,
        intent: t.intent,
      });
    },
    async startRun(r) {
      await insertRun(sql, {
        runId: r.runId,
        variantId: r.variantId,
        taskId: r.taskId,
        cycle: r.cycle,
        repeat: r.repeat,
        harnessSlug: r.harnessSlug,
        workflowId: r.workflowId,
      });
    },
    async finishRun(runId, fields) {
      await storeFinishRun(sql, runId, {
        terminalState: fields.terminalState,
        deterministicSignals: fields.deterministicSignals,
        traceRef: fields.traceRef,
      });
    },
    async recordScore(runId, score) {
      await insertScore(sql, runId, score);
    },
    async comparison(a, b, rubricHash) {
      return compareVariants(sql, a, b, rubricHash);
    },
  };
}

export interface RealAbDepsConfig {
  /** A postgres-js client connected to the gym PG. */
  gymSql: Sql;
  /** Real runner ports (clone/register/overlay/file/start/poll) — createGymRunnerPorts(...). */
  ports: GymRunnerPorts;
  /** The judge LLM call — pass the real meridian llmCall for a real run, or a fake in tests. */
  llmCall: JudgeLlmCall;
  /** Hard wall-clock cap per pipeline run. */
  timeoutMs: number;
  /** Delay between status polls. */
  pollIntervalMs: number;
  /** Scratch root for clones + trace bundles. */
  scratchRoot: string;
}

export function buildAbDeps(cfg: RealAbDepsConfig): AbDeps {
  const sql = cfg.gymSql;
  return {
    store: createGymStore(sql),

    async runPipeline(input: AbRunInput): Promise<AbRunHandle> {
      const spec: GymRunSpec = {
        task: {
          id: input.task.taskId,
          source: input.task.repoUrl,
          commit: input.task.repoCommit,
          spec: input.task.spec,
          intent: input.task.intent,
        },
        variant: { id: input.variant.variantId, overlay: input.variant.overlay },
        cycle: input.cycle,
        repeat: input.repeat,
        harnessCommit: input.harnessCommit,
        workspaceId: input.workspaceId,
        scratchRoot: input.scratchRoot,
        timeoutMs: cfg.timeoutMs,
        pollIntervalMs: cfg.pollIntervalMs,
      };
      const result = await runGymPipeline(spec, cfg.ports);
      // pipelineUsd = Σ of the harness's agent-run costs (P-027). Fake agents → 0.
      const rows = await sql<{ c: number }[]>`
        SELECT COALESCE(SUM(cost_usd), 0)::float8 AS c
          FROM harness_shared.agent_runs_consolidated WHERE harness_slug = ${result.harnessSlug}`;
      return {
        harnessSlug: result.harnessSlug,
        clonePath: result.clonePath,
        workflowID: result.workflowID,
        outcome: result.outcome,
        pipelineUsd: Number(rows[0]?.c ?? 0),
      };
    },

    async collectAndDistill({ handle, task, maxChars }) {
      const { rawTrace, traceRef } = await collectTrace(
        {
          harnessSlug: handle.harnessSlug,
          clonePath: handle.clonePath,
          baseCommit: task.repoCommit,
          terminalState: handle.outcome,
        },
        {
          readRunOutputs: async (slug) => {
            const rows = await sql<{ run_id: string; role: string | null; out_body: string }[]>`
              SELECT run_id, role, out_body FROM harness_shared.harness_run_output
               WHERE harness_slug = ${slug} ORDER BY started_at`;
            return rows.map((r) => ({ runId: r.run_id, role: r.role ?? '', outBody: r.out_body }));
          },
          gitDiff: async (clonePath, base) => {
            const { stdout } = await execFileP('git', ['-C', clonePath, 'diff', base, 'HEAD'], {
              maxBuffer: 64 * 1024 * 1024,
            });
            return stdout;
          },
          writeBundle: async (text) => {
            const dir = join(cfg.scratchRoot, 'traces');
            mkdirSync(dir, { recursive: true });
            const p = join(dir, `${handle.harnessSlug}.trace.json`);
            writeFileSync(p, text);
            return p;
          },
        },
      );
      const distilled = distillTrace(rawTrace, { maxChars });
      return { distilledTrace: distilled.text, traceRef, rawSignals: rawTrace.signals ?? {} };
    },

    llmCall: cfg.llmCall,
    newRunId: (v, t, r) => `${v}::${t}::r${r}`,
    now: () => Date.now(),
  };
}
