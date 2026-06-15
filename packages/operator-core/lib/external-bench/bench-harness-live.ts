/**
 * `liveBenchHarnessDriver` + `bindLiveBenchHarness` — the LIVE binding of the {@link BenchHarnessDriver}
 * port (BRIEF 2 / P-019, su-1226c). This is the missing piece that runs a coding harness on ONE
 * benchmark task to DONE, sums its cost, and tears it down — the leaf that makes the impartial-benchmark
 * pilot RUNNABLE. Binding it spends NOTHING; the real LLM spend (the `external-bench` spine running over
 * the cloned task) happens only when the pilot triggers a bounded run at the opus reset (P-009).
 *
 * SHAPE: the same injected-ops orchestration discipline as hive-eval's `makeLiveHivePorts`
 * (`hive-eval/live-ports.ts` + `live-ops.ts`) and its sibling `liveHiveBacklogDriver`
 * (`./hive-backlog-live.ts`): a {@link BenchHarnessOps} interface of single-method IO seams, an
 * orchestration (`liveBenchHarnessDriver`) that is PURE over that seam (so create→feed→drive→cost→teardown
 * ordering + the stop-reason mapping + the never-throws-on-failure contract unit-test with fakes, NO
 * git/PG/LLM), and a real binding (`liveBenchHarnessOps`) that wires the established functions.
 *
 * The FUNCTION MAP (the {@link BenchHarnessDriver} JSDoc in `./run-loop.ts` names these — implemented here):
 *   CREATE   → `createBenchHarness` (the `harness:create` registry+schema scaffold path,
 *              `agent-tools/harness/create.ts` / `createHiveHarness` in `agent-tools/hive/_create.ts`):
 *              register a throwaway harness of `blueprintId` rooted at `checkout.dir`, scaffold its schema.
 *   FEED     → ONE `item_kind='feature'` row into `harness_shared.harness_features_consolidated`
 *              (title/summary = `task.problemStatement`, status 'todo') — the `createWorkItem` INSERT
 *              shape in `blueprint/blueprint-run-action.ts` + `liveHiveOps.seedFeature`.
 *   DRIVE    → `ensureFeaturePipeline` (`dbos/orchestrator-start.ts`) starts the durable pipeline, then
 *              poll the feature's status + the pipeline's DBOS workflow rows until terminal-or-cap (the
 *              `gym/wake-mode.ts` settle pattern). Terminal state → `stopReason`.
 *   COST     → SUM `harness_shared.agent_usage_samples` for the harness slug over the run window:
 *              tokensIn/Out, cost_usd, COUNT(DISTINCT run_id) as turns (the `iq-battery/bee-instance.ts`
 *              pattern). Every agent + turn counts (coordination overhead included — fairness #2).
 *   TEARDOWN → `removeHarnessFromWorkspace` + `dropHarnessSchema` (leave the clone — the caller owns
 *              `checkout.cleanup`).
 *
 * ── REAL-OPS INTEGRATION (verify on the FIRST gated run) ───────────────────────────────────────────
 * `liveBenchHarnessOps` wires real best-effort bodies for every method (NO throwing stubs on the core
 * path — an accidental unbound call is already guarded by run-loop's UNBOUND_DRIVER). The one genuinely
 * uncertain integration — driving a SINGLE feature to DONE synchronously (does the durable pipeline run
 * in THIS host, and what exact statuses does a single feature traverse?) — carries `VERIFY-AT-FIRST-RUN:`
 * comments. The ORCHESTRATION is green over fakes regardless; the pilot trigger confirms the live wires.
 */
import type postgres from 'postgres';
import type {
  BenchHarnessRun,
  BenchTask,
  GenerationBudget,
  GenerationStopReason,
  GenerationTelemetry,
  TaskCheckout,
} from './types';
import {
  setBenchHarnessDriver,
  type BenchHarnessDriver,
  type BenchHarnessRunRequest,
} from './run-loop';

/** Default ceiling on the drive poll loop (ms) — a runaway bound on top of the iso-budget cap. */
const DEFAULT_DRIVE_TIMEOUT_MS = 60 * 60 * 1000; // 1h; a bounded pilot task is far under this.
/** Default poll cadence while awaiting the feature's terminal state (ms). */
const DEFAULT_POLL_MS = 5_000;

/** The cost the COST seam sums from `agent_usage_samples` for the throwaway harness slug. */
export interface BenchRunCost {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** COUNT(DISTINCT run_id) — every agent run that touched the harness (coordination overhead included). */
  turns: number;
}

/**
 * How the DRIVE seam terminated — the raw disposition the orchestration maps to a {@link GenerationStopReason}.
 * `done` (the feature reached its terminal `passed` status + the pipeline settled), `escalate` (the feature
 * blocked / escalated — needs human), `budget-exhausted` (the iso-budget $/token cap was hit), `max-turns`
 * (the runaway turn bound), `timeout` (the drive wall-clock ceiling), or `error` (an infra failure).
 */
export type DriveDisposition = 'done' | 'escalate' | 'budget-exhausted' | 'max-turns' | 'timeout' | 'error';

/** What the DRIVE seam returns: the disposition + an optional human-readable detail (the escalate reason / error). */
export interface DriveResult {
  disposition: DriveDisposition;
  detail?: string;
}

/** The opaque handle the CREATE seam returns, threaded to feed/drive/cost/teardown. */
export interface BenchHarnessHandle {
  /** The throwaway harness slug (scratch, unique per run). */
  slug: string;
  /** The single feature id seeded into it (the benchmark task). */
  featureId: string;
  /** The clone the harness edits (=== checkout.dir). */
  worktreePath: string;
}

/**
 * The injected IO seam the orchestration drives — every side effect is ONE method, so the
 * create→feed→drive→cost→teardown ordering + the stop-reason mapping + the never-throws contract are
 * unit-testable with fakes (no git/PG/LLM). The real binding ({@link liveBenchHarnessOps}) wires the
 * established functions; the test injects a fake.
 */
export interface BenchHarnessOps {
  now(): number;
  /** CREATE: register + schema-scaffold a throwaway harness of `blueprintId` rooted at `checkout.dir`. */
  createHarness(input: {
    blueprintId: string;
    checkout: TaskCheckout;
    workspaceId: string;
  }): Promise<BenchHarnessHandle>;
  /** FEED: insert ONE `item_kind='feature'` work_item (title/summary = `problemStatement`, status 'todo'). */
  addFeature(input: {
    handle: BenchHarnessHandle;
    task: BenchTask;
    workspaceId: string;
  }): Promise<void>;
  /**
   * DRIVE: start the feature's pipeline and run it to a terminal state under `budget` (the iso-budget cap
   * bounds $/tokens; `timeoutMs` is the runaway wall-clock bound). Injected so the orchestration is
   * testable WITHOUT spawning real agents. Never throws a budget/escalate as an exception — those are
   * dispositions; a genuine infra failure may throw (the orchestration catches it → 'error' telemetry).
   */
  driveToDone(input: {
    handle: BenchHarnessHandle;
    budget: GenerationBudget;
    timeoutMs: number;
    pollMs: number;
    workspaceId: string;
  }): Promise<DriveResult>;
  /** COST: SUM agent_usage_samples for the harness slug over the run window → tokens/cost/turns. */
  collectCost(input: { handle: BenchHarnessHandle; workspaceId: string }): Promise<BenchRunCost>;
  /** TEARDOWN: unregister + drop the harness schema. Leaves the clone (the caller owns checkout.cleanup). */
  teardown(input: { handle: BenchHarnessHandle; workspaceId: string }): Promise<void>;
}

export interface LiveBenchHarnessOpts {
  workspaceId: string;
  /** Drive wall-clock ceiling (ms). Default 1h; a runaway bound atop the iso-budget cap. */
  driveTimeoutMs?: number;
  /** Drive poll cadence (ms). Default 5s. */
  pollIntervalMs?: number;
  /** A trajectory-ref builder for the row (BRIEF 8 handle). Default `xbench://<slug>`. */
  trajectoryRef?: (handle: BenchHarnessHandle) => string;
}

/** Map the DRIVE disposition → the {@link GenerationStopReason} on the row. */
export function stopReasonForDisposition(d: DriveDisposition): GenerationStopReason {
  switch (d) {
    case 'done':
      return 'done';
    case 'escalate':
      return 'escalate';
    case 'budget-exhausted':
      return 'budget-exhausted';
    case 'max-turns':
      return 'max-turns';
    case 'timeout':
      // A wall-clock timeout under an iso-budget run is the runaway turn/time bound being hit — the
      // closest shared-vocabulary stop reason is 'max-turns' (a cap-hit, NOT an infra error → still scored).
      return 'max-turns';
    case 'error':
      return 'error';
  }
}

/**
 * The LIVE {@link BenchHarnessDriver} over the injected {@link BenchHarnessOps}. One method, the whole
 * lifecycle: CREATE a throwaway harness of `blueprintId` at `checkout.dir`, FEED the task as one feature,
 * DRIVE it to DONE under `budget`, COST the run, TEAR DOWN. NEVER throws — a failure returns telemetry
 * with `stopReason: 'error'` + `generationError` (the generation-failure contract `instantiateBenchHarness`
 * relies on; the scoring lib drops an error row, never scores it as a task failure). Cost is still summed
 * + teardown still runs on the failure path (real spend before the failure must be counted; a half-made
 * harness must not linger).
 */
export function liveBenchHarnessDriver(ops: BenchHarnessOps, opts: LiveBenchHarnessOpts): BenchHarnessDriver {
  const ws = opts.workspaceId;
  const timeoutMs = opts.driveTimeoutMs ?? DEFAULT_DRIVE_TIMEOUT_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const trajectoryRefFor = opts.trajectoryRef ?? ((h: BenchHarnessHandle) => `xbench://${h.slug}`);

  return {
    async spinRunAndCost(req: BenchHarnessRunRequest): Promise<BenchHarnessRun> {
      const { blueprintId, task, checkout, budget } = req;
      const startedAtMs = ops.now();

      let handle: BenchHarnessHandle | null = null;
      let disposition: DriveDisposition = 'error';
      let detail: string | undefined;

      try {
        // CREATE → FEED → DRIVE.
        handle = await ops.createHarness({ blueprintId, checkout, workspaceId: ws });
        await ops.addFeature({ handle, task, workspaceId: ws });
        const drive = await ops.driveToDone({ handle, budget, timeoutMs, pollMs, workspaceId: ws });
        disposition = drive.disposition;
        detail = drive.detail;
      } catch (e) {
        // An infra failure during create/feed/drive → 'error' telemetry (never a thrown exception). The
        // cost sum below still runs (any real spend before the failure is counted); teardown still runs.
        disposition = 'error';
        detail = e instanceof Error ? e.message : String(e);
      }

      // COST: always sum what was spent (even on a failure — real spend before a failure must be counted).
      let cost: BenchRunCost = { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 };
      if (handle) {
        cost = await ops.collectCost({ handle, workspaceId: ws }).catch(() => cost);
      }

      // TEARDOWN: best-effort — a teardown hiccup must not mask the run's outcome (mirrors hive-eval's
      // teardown discipline). The caller owns `checkout.cleanup` (we leave the clone).
      if (handle) {
        await ops.teardown({ handle, workspaceId: ws }).catch(() => {});
      }

      const stopReason = stopReasonForDisposition(disposition);
      const telemetry: GenerationTelemetry = {
        tokensIn: cost.tokensIn,
        tokensOut: cost.tokensOut,
        costUsd: cost.costUsd,
        turns: cost.turns,
        wallClockMs: ops.now() - startedAtMs,
        trajectoryRef: handle ? trajectoryRefFor(handle) : '',
        stopReason,
        // `generationError` is the GENERATION-side infra failure marker (excluded from accuracy). Only an
        // 'error' disposition carries it; an escalate/budget/max-turns is a real (scored) terminal, not an
        // infra failure — its `detail` is informational and stays off the error field.
        ...(disposition === 'error' && detail ? { generationError: detail } : {}),
      };

      return { worktreePath: handle?.worktreePath ?? checkout.dir, telemetry };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The REAL binding — wires the established functions (the function map above). */
/* -------------------------------------------------------------------------- */

/** Statuses a feature lands in when its pipeline reached DONE (the worker/validator passed). */
const DONE_STATUSES = new Set(['passed']);
/** Statuses meaning the feature escalated / is blocked on a human — a terminal NON-done disposition. */
const ESCALATE_STATUSES = new Set(['escalated', 'blocked']);
/** DBOS workflow statuses that mean the feature's pipeline is still in flight (owns the feature). */
const LIVE_PIPELINE_STATUSES = ['PENDING', 'ENQUEUED'];

/** A short scratch slug for a throwaway bench harness: `xbench-<rand>` (lowercase alnum, schema-safe). */
function scratchSlug(): string {
  return `xbench-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Bind the live bench-harness driver so `instantiateBenchHarness` is instant-go for the pilot:
 * `setBenchHarnessDriver(liveBenchHarnessDriver(liveBenchHarnessOps(opts), opts))`. `ops` defaults to the
 * real machinery binding; the smoke/test path injects a fake. Pass `null` to `setBenchHarnessDriver`
 * (run-loop.ts) to restore the unbound default.
 */
export function bindLiveBenchHarness(opts: LiveBenchHarnessOpts, ops?: BenchHarnessOps): void {
  setBenchHarnessDriver(liveBenchHarnessDriver(ops ?? liveBenchHarnessOps(opts), opts));
}

/**
 * The REAL {@link BenchHarnessOps} binding — wired from the established functions (the file-header map).
 * Lazy dynamic imports keep this module import-light (the orchestration above carries no PG/registry
 * dependency, so a fake-driven test never loads them). Every method is a real best-effort body; the one
 * genuinely uncertain integration (DRIVE) carries `VERIFY-AT-FIRST-RUN:` flags. The pilot trigger (P-009)
 * confirms these live; the orchestration is green over fakes regardless.
 */
export function liveBenchHarnessOps(opts: LiveBenchHarnessOpts): BenchHarnessOps {
  const sqlClient = async (): Promise<postgres.Sql> => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  };

  return {
    now: () => Date.now(),

    async createHarness({ blueprintId, checkout, workspaceId }) {
      // Register the existing clone (`checkout.dir`) as a throwaway harness of `blueprintId` + scaffold
      // its schema — the registry+schema scaffold path harness:create/createHiveHarness composes. We set
      // the registry entry DIRECTLY (not via the harness:create MCP handler) so the throwaway clone never
      // gets a git-sync routine seeded (it must not federate/push) — exactly the carve-out
      // `liveHiveOps.registerMember` draws. The clone already exists @ base_commit (the caller cloned it),
      // so this is register-an-existing-path, NOT dir-init.
      const slug = scratchSlug();
      const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
      const { scaffoldHarnessSchema } = await import('../scaffold-harness-schema');

      const reg = await loadHarnessRegistry(workspaceId);
      if (!reg.projects.some((p) => p.slug === slug)) {
        reg.projects.push({ slug, path: checkout.dir });
        await saveHarnessRegistry(reg, workspaceId);
      }
      await scaffoldHarnessSchema(slug);

      // VERIFY-AT-FIRST-RUN: the pipeline resolves the harness's spine from its git-canonical
      // `.papercusp/blueprint.yaml` (orchestrator-start.ts:resolveHarnessSpine); a registered-clone with
      // no blueprint file defaults to the built-in `coding` spine. For the FULL arm we must write
      // `.papercusp/blueprint.yaml` (extends `external-bench`) into the clone so the spine is ON — the
      // exact harness:create step 4. Wired here as the git-canonical write so the drive runs the right
      // spine; confirm the clone is a writable git repo (it is — `cloneTaskRepo` git-clones @ base).
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { stringify: stringifyYaml } = await import('yaml');
      const bpDir = join(checkout.dir, '.papercusp');
      mkdirSync(bpDir, { recursive: true });
      writeFileSync(
        join(bpDir, 'blueprint.yaml'),
        stringifyYaml({ id: slug, extends: blueprintId }, { lineWidth: 100 }),
        'utf8',
      );

      const featureId = `xbench-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      return { slug, featureId, worktreePath: checkout.dir };
    },

    async addFeature({ handle, task, workspaceId }) {
      // ONE `item_kind='feature'` row — the exact `createWorkItem` INSERT shape (blueprint-run-action.ts)
      // / `liveHiveOps.seedFeature`. title + summary = the task's problemStatement (the brief the harness
      // works); status 'todo'; the federation/needs-design triggers fire on insert (feature-tuned, fine —
      // this IS a feature). Admin pool with workspace_id explicit (no GUC), ON CONFLICT DO NOTHING (replay-safe).
      const sql = await sqlClient();
      const now = Date.now();
      await sql.unsafe(
        `INSERT INTO harness_shared.harness_features_consolidated (
           harness_slug, feature_id, title, summary, status, attempts,
           item_kind, needs_design, needs_human_review, workspace_id, ts, created_ts, updated_ts
         ) VALUES ($1, $2, $3, $4, 'todo', 0, 'feature', FALSE, FALSE, $5, $6, $7, $8)
         ON CONFLICT (harness_slug, feature_id) DO NOTHING`,
        [
          handle.slug,
          handle.featureId,
          task.problemStatement.slice(0, 200),
          task.problemStatement,
          workspaceId,
          now,
          now,
          now,
        ],
      );
    },

    async driveToDone({ handle, budget, timeoutMs, pollMs, workspaceId }) {
      // DRIVE: start the durable pipeline for the single feature, then poll the feature's status + the
      // pipeline's DBOS workflow rows until terminal-or-cap. This is the canonical "drive one feature to
      // DONE" pattern (gym/wake-mode.ts:480 settle loop): a feature is settled when its status is terminal
      // AND no PENDING/ENQUEUED pipeline workflow remains.
      //
      // VERIFY-AT-FIRST-RUN (the one genuinely-uncertain integration): the durable pipeline is registered
      // + enqueued only when the operator host runs with PAPERCUSP_DBOS_ORCHESTRATOR=1 (orchestrator-start.ts
      // header) AND the invoke runner is wired (orchestrator-runner.ts:wireOrchestratorInvokeRunner). The
      // pilot host satisfies both. If a future caller drives from a host WITHOUT DBOS, `ensureFeaturePipeline`
      // has nothing to enqueue on and the feature never advances → this loop times out ('timeout'
      // disposition, NOT a hang). Confirm at first run that the pilot host is DBOS-on; if a non-DBOS drive
      // is ever needed, swap to a director-loop over `spawnInvokeOnce` (orchestrator-runner.ts) here —
      // same seam, different body. The orchestration above is agnostic to which.
      const { ensureFeaturePipeline } = await import('../dbos/orchestrator-start');
      const sql = await sqlClient();
      const deadline = Date.now() + timeoutMs;

      // Start (or reuse a live) pipeline. Idempotent under concurrency (workflow-id-as-claim).
      await ensureFeaturePipeline(handle.slug, handle.featureId, workspaceId);

      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, pollMs));

        // Iso-budget cap (BRIEF 7): the GENERATION-side $/token ceiling. Read the live cost first so a
        // run that blows the cap stops promptly (the cap bounds spend even before a terminal status).
        const cost = await readBenchRunCost(sql, handle.slug, workspaceId).catch(
          () => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 }),
        );
        if (budget.maxUsd != null && cost.costUsd >= budget.maxUsd) return { disposition: 'budget-exhausted' };
        if (budget.maxTokens != null && cost.tokensIn + cost.tokensOut >= budget.maxTokens) {
          return { disposition: 'budget-exhausted' };
        }

        // Read the feature's current status + whether a pipeline workflow is still in flight.
        const [statusRows, liveRows] = await Promise.all([
          sql<{ status: string }[]>`
            SELECT status FROM harness_shared.harness_features_consolidated
             WHERE workspace_id = ${workspaceId} AND harness_slug = ${handle.slug}
               AND feature_id = ${handle.featureId}
             LIMIT 1`,
          sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM dbos.workflow_status
             WHERE workflow_uuid LIKE ${'pipeline:' + handle.slug + ':' + handle.featureId + ':%'}
               AND status = ANY(${LIVE_PIPELINE_STATUSES})`,
        ]);
        const status = statusRows[0]?.status ?? 'todo';
        const pipelineInFlight = (liveRows[0]?.n ?? 0) > 0;

        // A non-done terminal (escalate/blocked) is terminal regardless of the pipeline rows (the feature
        // won't advance without a human). DONE requires the pipeline to also have settled (the finalizer's
        // curator/documenter ran) — exactly the gym settle predicate.
        if (ESCALATE_STATUSES.has(status)) return { disposition: 'escalate', detail: `feature status=${status}` };
        if (DONE_STATUSES.has(status) && !pipelineInFlight) return { disposition: 'done' };
      }
      return { disposition: 'timeout', detail: `feature did not settle within ${timeoutMs}ms` };
    },

    async collectCost({ handle, workspaceId }) {
      const sql = await sqlClient();
      return readBenchRunCost(sql, handle.slug, workspaceId);
    },

    async teardown({ handle, workspaceId }) {
      // Unregister + drop the schema (the inverse of create). Best-effort throughout (teardown must not
      // mask the run's outcome). LEAVE the clone — the caller owns `checkout.cleanup`.
      const { removeHarnessFromWorkspace } = await import('../harness-membership');
      const { dropHarnessSchema } = await import('../scaffold-harness-schema');
      await removeHarnessFromWorkspace(workspaceId, handle.slug).catch(() => {});
      await dropHarnessSchema(handle.slug).catch(() => {});
    },
  };
}

/**
 * SUM the throwaway harness's `agent_usage_samples` → tokensIn/Out, cost_usd, and turns
 * (COUNT DISTINCT run_id — every agent run that touched the harness, coordination overhead INCLUDED —
 * fairness #2). The `iq-battery/bee-instance.ts` cost-read pattern, scoped by `harness_slug` (the run
 * window is the harness's whole lifetime — it is throwaway + unique, so this is exact attribution, no
 * time window). Exported for the integration test (verifies the SQL + the bigint coercions). The samples
 * carry `harness_slug` (the same column `readMemberRunStats` filters on); cost_usd/tokens may be null
 * (COALESCE → 0) when a sample landed unpriced.
 *
 * VERIFY-AT-FIRST-RUN: confirm `agent_usage_samples` carries `harness_slug` + `run_id` for the spawned
 * worker/validator runs of a bench harness (bee-instance reads by `run_id`; live-ops reads spawn rows by
 * `harness_slug` — both columns exist on the table). If a bench harness's per-turn samples are keyed only
 * by `run_id` with no `harness_slug`, switch this to sum over the harness's `spawned_agents.run_id` set
 * (the `loadCostBySpawn` join) — same table, one extra join.
 */
export async function readBenchRunCost(
  sql: postgres.Sql,
  harnessSlug: string,
  workspaceId: string,
): Promise<BenchRunCost> {
  const rows = await sql<
    { tokens_in: string | null; tokens_out: string | null; cost_usd: string | null; turns: string | null }[]
  >`
    SELECT SUM(COALESCE(input_tokens, 0))::text  AS tokens_in,
           SUM(COALESCE(output_tokens, 0))::text AS tokens_out,
           SUM(COALESCE(cost_usd, 0))::text      AS cost_usd,
           COUNT(DISTINCT run_id)::text          AS turns
      FROM harness_shared.agent_usage_samples
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}`;
  const r = rows[0];
  return {
    tokensIn: Number(r?.tokens_in ?? 0) || 0,
    tokensOut: Number(r?.tokens_out ?? 0) || 0,
    costUsd: Number(r?.cost_usd ?? 0) || 0,
    turns: Number(r?.turns ?? 0) || 0,
  };
}
