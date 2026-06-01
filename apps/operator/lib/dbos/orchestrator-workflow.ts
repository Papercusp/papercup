/**
 * Phase 3 (P-004) of `dbos-durable-jobs-2026-05-31` — the agent pipeline as a
 * DBOS durable workflow (sub-plan `dbos-orchestrator-durability-2026-05-31`).
 *
 * A feature's pipeline is a **dynamic dispatch loop**: each turn an orchestrator
 * agent decides the next role (`NEXT_WORKER` / `NEXT_VALIDATOR` / … / `DONE`), and
 * that role runs. Each agent run is a checkpointed DBOS **step** (driven through
 * `invoke()`'s `idempotencyKey`), so a crash resumes mid-pipeline without
 * re-running completed roles (parent D-019). The dispatch is deterministic given
 * the checkpointed step outputs (`parseDecision` is pure), so workflow replay is
 * safe (D-004) — all agent spawning + the LLM decision live INSIDE steps.
 *
 * Flag-gated by `PAPERCUSP_DBOS_ORCHESTRATOR=1` (registered only when the DBOS
 * bootstrap loads this). The legacy main loop stays the default + A/B fallback
 * (D-006). This handles the COMMON sequential pipeline; parallel lanes / branch
 * isolation / the synthesizer (P-008/P-009) still route through the legacy loop.
 *
 * The agent runner is injected (`setPipelineInvokeRunner`): the operator wires
 * the real `invoke()` (building the InvokeContext via harness-invoke-once);
 * tests inject a stub. This keeps the workflow free of operator/orchestrator
 * ctx-building and directly testable.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { parseDecision } from '@papercusp/orchestrator';
import { classifyDecision } from './orchestrator-decide';

export interface PipelineInput {
  harnessSlug: string;
  featureId: string;
  /** The primary/orchestrator role that decides the next action. Default 'director'. */
  orchestratorRole?: string;
  /**
   * Dispatch-epoch for this pipeline lifetime. DBOS will not re-enqueue a *completed*
   * workflow ID, so a feature-forever ID (`pipeline:<slug>:<feature>`) would let a
   * feature run exactly ONE pipeline ever — re-work after a prior SUCCESS (a reopen,
   * a failed-validation retry, a later feature edit) could never start a fresh
   * pipeline. The epoch — a monotonic per-feature counter the live caller sources
   * from PG — makes the workflow ID unique per lifetime; the `deduplicationID` still
   * guards a concurrent double-start *within* one epoch. See the sub-plan's
   * feature-ownership decision. Defaults to 0.
   */
  epoch?: number;
  /**
   * The workspace this pipeline runs in, CAPTURED at start time. The runner
   * resolves the harness in THIS workspace (not the volatile active one, which
   * can switch mid-pipeline via the desktop UI and break in-flight invokes —
   * observed ERRORing a real auto-dispatched run). Defaults to the active
   * workspace when unset (legacy callers).
   */
  workspaceId?: string;
}

/**
 * One agent run. Returns the agent's final text + exit code. The operator wires
 * the real runner (it builds the InvokeContext + calls `invoke()` with
 * `options.idempotencyKey = key`, so a re-run of a completed agent is reused, not
 * re-spawned — P-015); tests inject a stub. `workspaceId` pins the resolution
 * workspace for the whole pipeline.
 */
export type PipelineInvokeRunner = (
  harnessSlug: string,
  role: string,
  featureId: string,
  idempotencyKey: string,
  /** Complete KEY=value extras for this agent run (e.g. FEATURE_ID=, VAL_ID=). */
  extras: string[],
  workspaceId?: string,
) => Promise<{ output: string; exitCode: number }>;

let _runner: PipelineInvokeRunner | null = null;
export function setPipelineInvokeRunner(fn: PipelineInvokeRunner): void {
  _runner = fn;
}
function runner(): PipelineInvokeRunner {
  if (!_runner) {
    throw new Error('[dbos-orchestrator] invoke runner not wired — call setPipelineInvokeRunner() first');
  }
  return _runner;
}

/**
 * Terminal finalizer (P-001/P-002): runs the post-DONE curator/documenter/archive
 * (or the ESCALATE curator) when the pipeline reaches a terminal outcome. Injected
 * by the operator (orchestrator-runner) so the workflow stays free of I/O; when
 * unwired (tests, or before boot) finalization is skipped.
 */
export type PipelineFinalizer = (input: {
  harnessSlug: string;
  featureId: string;
  workspaceId?: string;
  outcome: 'done' | 'escalate';
  reason?: string;
}) => Promise<void>;

let _finalizer: PipelineFinalizer | null = null;
export function setPipelineFinalizer(fn: PipelineFinalizer): void {
  _finalizer = fn;
}

/**
 * On-completion refill seam (#1 — continuous dispatch). Fired when a feature's
 * pipeline finishes successfully so the freed concurrency slot can be filled
 * with the next queued feature IMMEDIATELY, instead of waiting up to 30s for the
 * periodic tick. Wired by the operator to `refillHarnessOnSettle`; unset in tests
 * (the hook is a no-op there). Deliberately NOT a checkpointed step — it's an
 * idempotent external nudge, harmless if re-fired on workflow replay.
 */
export type PipelineSettledHook = (harnessSlug: string, workspaceId?: string) => void;
let _settledHook: PipelineSettledHook | null = null;
export function setPipelineSettledHook(fn: PipelineSettledHook): void {
  _settledHook = fn;
}

const MAX_TURNS = Number(process.env.PAPERCUSP_DBOS_PIPELINE_MAX_TURNS ?? 200);

const key = (slug: string, feature: string, role: string, turn: number): string =>
  `${slug}:${feature}:${role}:t${turn}`;

async function featurePipelineImpl(input: PipelineInput): Promise<string> {
  const orchestratorRole = input.orchestratorRole ?? 'director';
  let lastVerb = 'NONE';
  // The terminal outcome to finalize after the loop (DONE → curator+documenter+
  // archive; ESCALATE → curator). null for IDLE / unsupported / max-turns (stop,
  // the dispatcher re-scans; no finalization).
  let terminal: { outcome: 'done' | 'escalate'; reason?: string } | null = null;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Step: the orchestrator agent decides the next action (checkpointed).
    // A failed/empty invoke must NOT look like a clean terminal decision:
    // parseDecision('') is null, which would break the loop and FALSE-SUCCESS
    // the pipeline with no work done (observed on a transient agent failure in
    // the real-agent gold-standard run). Throw so DBOS retries the step; after
    // the retries are exhausted the workflow ERRORs rather than false-succeeding.
    const decision = await DBOS.runStep(
      async () => {
        const r = await runner()(
          input.harnessSlug,
          orchestratorRole,
          input.featureId,
          key(input.harnessSlug, input.featureId, orchestratorRole, turn),
          [`FEATURE_ID=${input.featureId}`],
          input.workspaceId,
        );
        if (r.exitCode !== 0 || !r.output.trim()) {
          throw new Error(`decide invoke failed (exit=${r.exitCode}, empty=${!r.output.trim()})`);
        }
        return r;
      },
      { name: `decide-${turn}`, retriesAllowed: true, maxAttempts: 3, intervalSeconds: 5, backoffRate: 2 },
    );

    const action = classifyDecision(parseDecision(decision.output), input.featureId);

    if (action.kind === 'terminal') {
      lastVerb = action.outcome.toUpperCase();
      if (action.outcome === 'done' || action.outcome === 'escalate') {
        terminal = { outcome: action.outcome, reason: action.reason };
      }
      break;
    }
    if (action.kind === 'unsupported') {
      // Global-only verb (parallel lanes, NEXT_HARNESS, CEO mode) — deliberately
      // not handled per-feature (D-001). Stop; the dispatcher owns cross-feature work.
      lastVerb = `UNSUPPORTED:${action.verb}`;
      break;
    }

    // dispatch: run the role as an idempotent agent run (checkpointed).
    await DBOS.runStep(
      () =>
        runner()(
          input.harnessSlug,
          action.role,
          action.feature,
          key(input.harnessSlug, action.feature, action.role, turn),
          action.extras,
          input.workspaceId,
        ),
      { name: `invoke-${action.role}-${turn}` },
    );
    lastVerb = action.role.toUpperCase();
  }

  // Finalize a terminal outcome (checkpointed → runs once, not re-run on replay).
  // Skipped cleanly when no finalizer is wired (tests / pre-boot).
  if (terminal && _finalizer) {
    const fin = _finalizer;
    const { outcome, reason } = terminal;
    await DBOS.runStep(
      () =>
        fin({
          harnessSlug: input.harnessSlug,
          featureId: input.featureId,
          workspaceId: input.workspaceId,
          outcome,
          reason,
        }),
      { name: `finalize-${outcome}` },
    );
  }

  // Refill the freed slot immediately on a successful finish (#1). Only on `done`:
  // a done feature leaves the NEEDS_WORK set, so the refill picks the NEXT queued
  // feature (never re-picks this one). escalate/idle/max-turns leave the feature
  // re-pickable, so those fall back to the 30s backstop to avoid a tight re-dispatch
  // loop. Fire-and-forget side effect (not a step) — idempotent if replayed.
  if (terminal?.outcome === 'done') {
    _settledHook?.(input.harnessSlug, input.workspaceId);
  }

  return `pipeline-complete (last=${lastVerb})`;
}

export const featurePipelineWorkflow = DBOS.registerWorkflow(featurePipelineImpl, {
  name: 'featurePipeline',
  maxRecoveryAttempts: 10,
});

export const pipelineQueue = new WorkflowQueue('feature-pipeline', { concurrency: 4 });

/**
 * Start (or resume) a feature's durable pipeline. The workflow ID is deterministic
 * per (feature, epoch), so a re-dispatch *within the same epoch* resumes the same
 * workflow rather than starting a second one (the dedup ID guards concurrent
 * double-dispatch); a new epoch starts a fresh pipeline lifetime after a prior one
 * completed (DBOS will not re-enqueue a completed ID — see `PipelineInput.epoch`).
 */
export async function startFeaturePipeline(input: PipelineInput): Promise<string> {
  const workflowID = `pipeline:${input.harnessSlug}:${input.featureId}:e${input.epoch ?? 0}`;
  await DBOS.startWorkflow(featurePipelineWorkflow, {
    workflowID,
    queueName: pipelineQueue.name,
    enqueueOptions: { deduplicationID: workflowID },
  })(input);
  return workflowID;
}
