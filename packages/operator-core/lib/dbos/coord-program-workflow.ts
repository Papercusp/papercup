/**
 * `coordProgramWorkflow` — the durable executor for a coord-op **program**
 * (`coordination-ops-as-blueprint-primitives-2026-06-04` P-005 / D-005). The
 * program-mode sibling of `featurePipelineImpl`: where that runs a decider loop
 * (`deriveNext`), this runs a declarative `steps` + `gate` program (the pure
 * `runProgramCore`), invoking each coord op as a checkpointed DBOS step. So a
 * deliberation (open thread → spawn voters → collect → aggregate → resolve)
 * **survives a restart** — a crash mid-collect resumes from the last completed
 * step (D-003), the durability the plan calls load-bearing.
 *
 * Two entry surfaces share `runProgramCore` (P-005):
 *   - **durable top-level** — `startCoordProgram` → this workflow → DBOS-step runOp.
 *     The event-triggered / fire-and-forget deliberation path (D-007).
 *   - **inline** — `coord:vote`/`coord:deliberate` ops → `caps.runProgram` → inline
 *     runOp. The direct-call (D-009) + recursion (D-008) path.
 *
 * Flag-gated like the orchestrator workflow: registered only when the DBOS
 * bootstrap imports it. The agent spawn runner is injected
 * (`setCoordSpawnRunner`, prod-caps.ts), so this module pulls in no agent-spawn
 * plumbing and the workflow stays directly testable.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { loadBuiltinBlueprint, type Blueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js'; // register every coord op
import '../blueprint-steps/index.js'; // register every deterministic step-op (P-010)
import { requireCoordOp } from '../coord-ops/registry.js';
import { runProgramCore, type RunOp } from '../coord-ops/program-runner.js';
import { buildCoordOpCtx, setProgramBlueprintResolver, type ProgramBlueprintResolver } from '../coord-ops/prod-caps.js';
import type { ProgramOutcome } from '../coord-ops/types.js';

export interface CoordProgramInput {
  /** Built-in (vote/deliberate) or resolved blueprint id whose program runs. */
  blueprintId: string;
  /** The decision payload (question, options, lenses, quorum, …). */
  payload: Record<string, unknown>;
  /** The agent/owner who invoked the program (resolve notifies them). */
  callerId: string;
  callerLabel?: string;
  workspaceId?: string;
  harnessSlug?: string;
  /** The decision work-item id this program resolves (optional). */
  workItemId?: string;
  /** A stable run id for the workflow id / dedup. */
  runId: string;
  /** Composition depth (top-level = 0). */
  depth?: number;
}

/**
 * The blueprint resolver the workflow uses (also installed as the prod-caps
 * resolver so nested `runProgram` calls resolve the same way). Default: built-in
 * vote/deliberate. The operator can override with a PG-cache / forked resolver.
 */
let _resolver: ProgramBlueprintResolver = async (id) => loadBuiltinBlueprint(id).blueprint;
export function setCoordProgramBlueprintResolver(fn: ProgramBlueprintResolver): void {
  _resolver = fn;
  setProgramBlueprintResolver(fn);
}

async function coordProgramImpl(input: CoordProgramInput): Promise<ProgramOutcome> {
  const blueprint: Blueprint = await _resolver(input.blueprintId, {
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
  });

  const ctx = buildCoordOpCtx({
    identity: { ownerId: input.callerId, ownerLabel: input.callerLabel },
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    callerId: input.callerId,
    workItemId: input.workItemId,
    depth: input.depth ?? 0,
  });

  // Top-level runOp: each op is a checkpointed DBOS step (durable + replay-safe).
  // The step name is the program-unique `op-<id>` / `gate-<op>` label.
  const runOp: RunOp = (call, c) =>
    DBOS.runStep(
      async () => {
        const op = requireCoordOp(call.op);
        const parsed = op.argsSchema.parse(call.args);
        return op.run(parsed, c);
      },
      { name: call.label },
    );

  const outcome = await runProgramCore({ blueprint, payload: input.payload, ctx, runOp });
  // Drop the (potentially large) scope from the durable workflow's recorded
  // output — the decision + outcome are what matters to the caller.
  return { outcome: outcome.outcome, resolved: outcome.resolved, decision: outcome.decision };
}

export const coordProgramWorkflow = DBOS.registerWorkflow(coordProgramImpl, {
  name: 'coordProgram',
  maxRecoveryAttempts: 10,
});

export const coordProgramQueue = new WorkflowQueue('coord-program', { concurrency: 4 });

/**
 * Start (or resume) a durable coord-op program. The workflow id is deterministic
 * per (harness, runId, blueprint), so a re-dispatch resumes the same run; the
 * dedup id guards a concurrent double-start. Returns the workflow id (fire-and-
 * forget — the event-trigger path doesn't block on the deliberation lifetime).
 */
export async function startCoordProgram(input: CoordProgramInput): Promise<string> {
  const workflowID = `coord-program:${input.harnessSlug ?? 'op'}:${input.runId}:${input.blueprintId}`;
  await DBOS.startWorkflow(coordProgramWorkflow, {
    workflowID,
    queueName: coordProgramQueue.name,
    enqueueOptions: { deduplicationID: workflowID },
  })(input);
  return workflowID;
}

/**
 * The event-rule firing seam (D-007): resolve an event key (e.g.
 * `coordination-op:vote`) to its program blueprint and start a durable run. This
 * is the function an [[event-reaction-system-2026-06-04]] rule's `fire` invokes —
 * "when <condition>, fire coordination-op:vote with <derived payload>". Returns
 * the workflow id, or null when no blueprint declares that event key.
 */
export async function startCoordProgramForEvent(
  eventKey: string,
  input: Omit<CoordProgramInput, 'blueprintId'>,
): Promise<string | null> {
  const { resolveCoordOpTrigger } = await import('../coord-ops/trigger.js');
  const blueprintId = resolveCoordOpTrigger(eventKey);
  if (!blueprintId) {
    console.warn(`[coord-program] no blueprint declares trigger event "${eventKey}"`);
    return null;
  }
  return startCoordProgram({ ...input, blueprintId });
}
