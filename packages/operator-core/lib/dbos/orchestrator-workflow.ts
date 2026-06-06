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
import { parseDecisionFor } from '@papercusp/orchestrator';
import { deriveNext, loadBuiltinBlueprint, type BlueprintSpine } from '@papercusp/orchestrator/blueprint';

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
  /**
   * The resolved blueprint spine that drives this pipeline (P-004). Optional —
   * defaults to the built-in `coding` spine (behavior-preserving; every harness
   * today is a coding harness). A non-coding harness (research, Phase E) resolves
   * its own blueprint and passes its spine here, so the SAME durable loop
   * interprets a different declared graph. Plain data → DBOS-serializable.
   */
  spine?: BlueprintSpine;
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
 * Debugger-before-worker gate (P-012 / D-005). Fired immediately BEFORE a
 * `worker` dispatch: when the feature has failed enough times
 * (attempts ≥ `debugger.threshold`) and no debug note exists yet, the hook runs
 * the read-only `debugger` role so the worker then runs with the root-cause
 * analysis in context — making `director.md`'s standing promise true under DBOS.
 *
 * The hook does the guard-check AND the debugger-invoke INTERNALLY so the whole
 * thing is one checkpointed DBOS step (D-014 replay-safety: a guard in step A +
 * an invoke in step B would let a partial replay re-fire the debugger; here a
 * re-run re-checks the note the debugger itself writes, so it fires at most
 * once). Injected by the operator; unwired in tests → the gate is skipped.
 */
export type PipelineDebuggerHook = (input: {
  harnessSlug: string;
  featureId: string;
  workspaceId?: string;
}) => Promise<{ fired: boolean }>;

let _debuggerHook: PipelineDebuggerHook | null = null;
export function setPipelineDebuggerHook(fn: PipelineDebuggerHook): void {
  _debuggerHook = fn;
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

/**
 * Feature-passed hook (non-collaborator-join-fork-pr B3 / P-002). Fired once, as
 * a CHECKPOINTED step, when a feature's pipeline finishes with outcome `done`
 * (the feature shipped). The operator wires this to the fork-mode code→PR path:
 * in fork mode (the local identity lacks upstream write) it pushes the feature
 * branch to the contributor's fork and opens a cross-fork PR; in owner/
 * integration mode it is a no-op. Checkpointed (NOT fire-and-forget like the
 * settled hook) because opening a PR is an outward-facing effect that must run
 * exactly once per completion, not re-fire on workflow replay.
 *
 * MUST NOT THROW — best-effort. The handler swallows its own errors so a PR-open
 * failure never fails the (already-successful) pipeline. Unwired in tests → skipped.
 */
export type PipelineFeaturePassedHook = (input: {
  harnessSlug: string;
  featureId: string;
  workspaceId?: string;
}) => Promise<void>;
let _featurePassedHook: PipelineFeaturePassedHook | null = null;
export function setPipelineFeaturePassedHook(fn: PipelineFeaturePassedHook): void {
  _featurePassedHook = fn;
}

// The blueprint spine drives the dispatch loop: `deriveNext` replaces the legacy
// `classifyDecision` switch (P-004, D-002). Loaded lazily + memoized; every harness
// today is a coding harness, so the built-in `coding` spine is the behavior-preserving
// default — its `deriveNext` output is byte-equivalent to `classifyDecision`, proven
// across the whole verb vocabulary by derive-next-equivalence.test.ts. A non-coding
// harness (research, Phase E) passes its own resolved spine via PipelineInput.spine.
let _codingSpine: BlueprintSpine | null = null;
function codingSpine(): BlueprintSpine {
  return (_codingSpine ??= loadBuiltinBlueprint('coding').blueprint.spine);
}

const key = (slug: string, feature: string, role: string, turn: number): string =>
  `${slug}:${feature}:${role}:t${turn}`;

async function featurePipelineImpl(input: PipelineInput): Promise<string> {
  const spine = input.spine ?? codingSpine();
  // The decider role comes from the blueprint spine (coding → 'director';
  // research → 'research-director'). Behavior-preserving for coding.
  const orchestratorRole = input.orchestratorRole ?? spine.decider;
  // The director's verbs are the spine's OWN vocabulary (the edge keys), so a
  // non-coding harness (research) parses against its own verbs (D-002). For the
  // coding spine this is the same 20 built-in verbs → behavior-preserving.
  // `edges` is optional since the coord-op program model landed (a program-mode
  // spine omits it). A program blueprint routes to `coordProgramWorkflow`, never
  // here, so `?? {}` is purely defensive (a misrouted program spine → no verbs →
  // the decider parse finds nothing → default idle, not a crash).
  const spineVerbs = Object.keys(spine.edges ?? {});
  // MAX_TURNS is now a blueprint knob (spine.maxTurns); the env var stays as an
  // operational override (behavior-preserving: unset → the coding spine's 200).
  const maxTurns = Number(process.env.PAPERCUSP_DBOS_PIPELINE_MAX_TURNS ?? spine.maxTurns);
  let lastVerb = 'NONE';
  // The terminal outcome to finalize after the loop (DONE → curator+documenter+
  // archive; ESCALATE → curator). null for IDLE / unsupported / max-turns (stop,
  // the dispatcher re-scans; no finalization).
  let terminal: { outcome: 'done' | 'escalate'; reason?: string } | null = null;

  for (let turn = 0; turn < maxTurns; turn++) {
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

    const action = deriveNext(spine, parseDecisionFor(spineVerbs, decision.output), input.featureId);

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

    // P-012: before a WORKER run, optionally fire the read-only debugger once
    // (attempts ≥ threshold + no debug note). The hook does the guard-check AND
    // the invoke inside this SINGLE checkpointed step — D-014 replay-safety.
    if (action.role === 'worker' && _debuggerHook) {
      const dh = _debuggerHook;
      const feature = action.feature;
      await DBOS.runStep(
        () => dh({ harnessSlug: input.harnessSlug, featureId: feature, workspaceId: input.workspaceId }),
        { name: `debugger-gate-${turn}` },
      );
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
    // Fork-mode code→PR (B3): in fork mode push the feature branch to the
    // contributor's fork + open a cross-fork PR. Checkpointed → runs exactly
    // once per completion (replay-safe), unlike the fire-and-forget settled
    // hook below. No-op in owner/integration mode and when unwired (tests). The
    // handler is best-effort (never throws), so a PR-open failure cannot fail
    // the already-successful pipeline.
    if (_featurePassedHook) {
      const fph = _featurePassedHook;
      await DBOS.runStep(
        () =>
          fph({
            harnessSlug: input.harnessSlug,
            featureId: input.featureId,
            workspaceId: input.workspaceId,
          }),
        { name: 'feature-passed-pr' },
      );
    }
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
