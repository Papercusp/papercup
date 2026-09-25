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
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';
import { BlueprintSchema, loadBuiltinBlueprint, operationFromSpecification, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { FEATURE_TERMINAL_STATES } from '../work-item-dispatch-states';
import { runWithWorkspace } from '../workspace-als';
import '../coord-ops/index.js'; // register every coord op
import '../blueprint-steps/index.js'; // register every deterministic step-op (P-010)
import { requireCoordOp } from '../coord-ops/registry.js';
import { runProgramCore, type RunOp } from '../coord-ops/program-runner.js';
import { buildCoordOpCtx, setProgramBlueprintResolver, type ProgramBlueprintResolver } from '../coord-ops/prod-caps.js';
import type { ProgramOutcome } from '../coord-ops/types.js';
import {
  BLUEPRINT_PROGRAM_COMPLETION_OWNER, blueprintProgramCompletionRef,
  getBlueprintOperationResult, getBlueprintOperationStatus,
  type BlueprintOperationHandle, type BlueprintOperationStatus,
} from '../blueprint/operation-service.js';
import { readBlueprintSpecificationSnapshot } from '../blueprint/project-to-pg.js';
import { setWorkItemState } from '../work-items.js';

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
  /** An accepted operation root runs its retained definition, never today's
   * mutable blueprint pointer. The canonical work item remains the result. */
  acceptedOperation?: BlueprintOperationHandle;
  /** The canonical root row's admission epoch, captured before enqueue and
   * retained in DBOS input. Reopen or unrelated mutation fences a stale run. */
  acceptedAttemptUpdatedTs?: number;
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

/** Resolve an accepted program through its durable receipt and immutable
 * specification. A caller cannot turn an ordinary work item into a program or
 * replace the program definition by moving the harness blueprint pointer. */
export async function loadAcceptedCoordProgramBlueprint(
  sql: Sql,
  handle: BlueprintOperationHandle,
  callerId: string,
): Promise<Blueprint> {
  if (handle.target.kind !== 'work-item') {
    throw new Error('accepted coord program requires a canonical root work item');
  }
  return runWithWorkspace(handle.workspaceId, async () => {
    await getBlueprintOperationStatus(sql, handle, callerId);
    const specification = await readBlueprintSpecificationSnapshot(
      sql, handle.workspaceId, handle.harnessSlug, handle.specificationRevision,
    );
    if (!specification) throw new Error('accepted coord program specification snapshot is missing');
    const { operation } = operationFromSpecification(specification, handle.operationId);
    if (operation.target.kind !== 'work-item' || operation.execution?.kind !== 'program') {
      throw new Error('accepted blueprint operation is not a work-item program');
    }
    if (operation.execution.blueprint) {
      throw new Error('accepted coord program references an unretained external blueprint');
    }
    const blueprint = BlueprintSchema.parse(specification.configuration);
    if (!blueprint.spine.steps) throw new Error('accepted coord program has no program spine');
    return blueprint;
  });
}

/** Admission's canonical receipt is the durable launch intent. This bounded
 * query is the recovery source for the routines tick once root settlement is
 * wired. A DBOS workflow row removes the accepted root from future scans. */
export async function findUnstartedAcceptedCoordPrograms(sql: Sql, limit = 32): Promise<CoordProgramInput[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('program launch scan limit must be 1..100');
  const rows = await sql<Array<{
    receipt_id: string; workspace_id: string; harness_slug: string;
    caller_id: string; operation_id: string; specification_revision: string;
    work_item_id: string; blueprint_id: string; input: unknown; updated_ts: string | number;
  }>>`
    SELECT i.id::text AS receipt_id, i.workspace_id, i.harness_slug,
           i.caller_id, i.operation_id, i.specification_revision,
           wi.feature_id AS work_item_id,
           s.artifact->'configuration'->>'id' AS blueprint_id,
           wi.payload->'blueprintOperation'->'input' AS input,
           wi.updated_ts
      FROM harness_shared.blueprint_operation_invocations i
      JOIN harness_shared.work_items wi
        ON wi.workspace_id = i.workspace_id
       AND wi.harness_slug IN (i.harness_slug, 'harness:' || i.harness_slug)
       AND wi.feature_id = i.target_ref
      JOIN harness_shared.blueprint_specifications s
        ON s.workspace_id = i.workspace_id AND s.harness_slug = i.harness_slug
       AND s.specification_revision = i.specification_revision
      LEFT JOIN dbos.workflow_status wf
        ON wf.workflow_uuid = 'coord-program:operation:' || i.workspace_id || ':' || i.id::text
     WHERE i.target_kind = 'work-item'
       AND wi.status <> ALL(${FEATURE_TERMINAL_STATES as string[]}::text[])
       AND wf.workflow_uuid IS NULL
       AND wi.payload->'blueprintOperation'->>'operationId' = i.operation_id
       AND wi.payload->'blueprintOperation'->>'specificationRevision' = i.specification_revision
       AND jsonb_typeof(wi.payload->'blueprintOperation'->'input') = 'object'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(s.artifact->'configuration'->'operations') op
          WHERE op->>'id' = i.operation_id
            AND op->'execution'->>'kind' = 'program'
            AND op->'target'->>'kind' = 'work-item'
            AND NOT (op->'execution' ? 'blueprint')
       )
     ORDER BY i.id LIMIT ${limit}
  `;
  return rows.map((row) => {
    const receiptId = Number(row.receipt_id);
    if (!Number.isSafeInteger(receiptId) || receiptId <= 0 ||
        !Number.isSafeInteger(Number(row.updated_ts)) ||
        !row.blueprint_id || !row.caller_id || !row.work_item_id) {
      throw new Error('accepted coord program launch candidate is malformed');
    }
    return {
      blueprintId: row.blueprint_id, payload: row.input as Record<string, unknown>,
      callerId: row.caller_id, workspaceId: row.workspace_id,
      harnessSlug: row.harness_slug, workItemId: row.work_item_id,
      runId: `receipt:${receiptId}`,
      acceptedAttemptUpdatedTs: Number(row.updated_ts),
      acceptedOperation: {
        workspaceId: row.workspace_id, harnessSlug: row.harness_slug,
        receiptId, operationId: row.operation_id,
        specificationRevision: row.specification_revision,
        target: { kind: 'work-item', id: row.work_item_id },
      },
    };
  });
}

/** Settle the root through the canonical work-item writer. Its guarded SQL
 * checks receipt, pinned program, admission epoch, reopen history and a
 * concurrent cancellation before it writes output or terminal state. */
export async function settleAcceptedCoordProgram(
  sql: Sql,
  input: CoordProgramInput,
  outcome: ProgramOutcome,
): Promise<BlueprintOperationStatus> {
  const handle = input.acceptedOperation;
  const updatedTs = input.acceptedAttemptUpdatedTs;
  if (!handle || handle.target.kind !== 'work-item' ||
      !Number.isSafeInteger(updatedTs) || !updatedTs ||
      input.workItemId !== handle.target.id || input.workspaceId !== handle.workspaceId ||
      input.harnessSlug !== handle.harnessSlug) {
    throw new Error('accepted coord program settlement has no current root attempt');
  }
  const rootId = handle.target.id;
  return runWithWorkspace(handle.workspaceId, async () => {
    const current = await getBlueprintOperationStatus(sql, handle, input.callerId);
    if (current.phase === 'terminal') return current;
    const attempt = {
      workspaceId: handle.workspaceId, harnessSlug: handle.harnessSlug,
      workItemId: rootId, receiptId: handle.receiptId,
      operationId: handle.operationId, specificationRevision: handle.specificationRevision,
      updatedTs, requireUncancelled: true,
    };
    const cancel = async () => setWorkItemState(rootId, 'dropped', {
      harness: handle.harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
      completionRef: `blueprint-program:cancelled:receipt:${handle.receiptId}`,
      completionAuthority: 'validated',
      acceptedProgramAttempt: { ...attempt, requireUncancelled: false },
    });
    let closed = current.cancellationRequested ? await cancel() : null;
    if (!current.cancellationRequested) {
      if (outcome.resolved) {
        const output = { outcome: outcome.outcome, resolved: true,
          ...(outcome.decision === undefined ? {} : { decision: outcome.decision }) };
        try {
          closed = await setWorkItemState(rootId, 'done', {
            harness: handle.harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
            completionRef: blueprintProgramCompletionRef(handle, 'succeeded'),
            completionAuthority: 'validated', outputPayload: output,
            acceptedProgramAttempt: attempt,
          });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('blueprint operation output is invalid:')) throw error;
        }
      }
      if (!closed) {
        const reread = await getBlueprintOperationStatus(sql, handle, input.callerId);
        if (reread.phase === 'terminal') return reread;
        if (reread.cancellationRequested) closed = await cancel();
        else {
          closed = await setWorkItemState(rootId, 'dropped', {
            harness: handle.harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
            completionRef: blueprintProgramCompletionRef(handle, 'failed'),
            completionAuthority: 'validated', acceptedProgramAttempt: attempt,
          });
        }
      }
    }
    if (!closed) throw new Error('accepted coord program root attempt changed before terminal settlement');
    return getBlueprintOperationStatus(sql, handle, input.callerId);
  });
}

async function coordProgramImpl(input: CoordProgramInput): Promise<ProgramOutcome> {
  const accepted = input.acceptedOperation;
  if (accepted && (accepted.target.kind !== 'work-item' ||
      input.workspaceId !== accepted.workspaceId ||
      input.harnessSlug !== accepted.harnessSlug || input.workItemId !== accepted.target.id)) {
    throw new Error('accepted coord program scope differs from its canonical operation handle');
  }
  const blueprint: Blueprint = accepted
    ? await loadAcceptedCoordProgramBlueprint(getOrgPg().sql, accepted, input.callerId)
    : await _resolver(input.blueprintId, {
        workspaceId: input.workspaceId,
        harnessSlug: input.harnessSlug,
      });
  if (accepted && blueprint.id !== input.blueprintId) {
    throw new Error('accepted coord program blueprint id differs from its retained definition');
  }
  if (accepted) {
    // A crash after canonical completion but before DBOS records the workflow
    // return must replay the canonical result, never re-enter the program steps.
    const prior = await getBlueprintOperationResult(getOrgPg().sql, accepted, input.callerId);
    if (prior.state === 'ready') {
      const output = prior.output;
      if (!output || typeof output !== 'object' || Array.isArray(output) ||
          typeof (output as Record<string, unknown>).outcome !== 'string' ||
          (output as Record<string, unknown>).resolved !== true) {
        throw new Error('canonical accepted program result has invalid workflow output');
      }
      return output as ProgramOutcome;
    }
    if (prior.status.phase === 'terminal') {
      return { outcome: prior.status.outcome ?? prior.state, resolved: false };
    }
  }

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
  const runOp: RunOp = async (call, c) => {
    if (accepted) {
      const status = await getBlueprintOperationStatus(getOrgPg().sql, accepted, input.callerId);
      if (status.phase === 'terminal' || status.cancellationRequested) {
        throw new Error('accepted coord program is terminal or cancellation was requested');
      }
    }
    return DBOS.runStep(
      async () => {
        const op = requireCoordOp(call.op);
        const parsed = op.argsSchema.parse(call.args);
        return op.run(parsed, c);
      },
      { name: call.label },
    );
  };

  let outcome: ProgramOutcome;
  try {
    outcome = await runProgramCore({ blueprint, payload: input.payload, ctx, runOp });
  } catch (error) {
    if (!accepted) throw error;
    console.warn(`[coord-program] accepted root ${accepted.receiptId} failed: ${error instanceof Error ? error.message : error}`);
    outcome = { outcome: 'failed', resolved: false };
  }
  if (accepted) {
    await DBOS.runStep(() => settleAcceptedCoordProgram(getOrgPg().sql, input, outcome),
      { name: 'settle-accepted-root' });
  }
  // Drop the (potentially large) scope from the durable workflow's recorded
  // output — the decision + outcome are what matters to the caller.
  return { outcome: outcome.outcome, resolved: outcome.resolved, decision: outcome.decision };
}

export const coordProgramWorkflow = idempotentRegisterWorkflow('coordProgram', () =>
  DBOS.registerWorkflow(coordProgramImpl, {
    name: 'coordProgram',
    maxRecoveryAttempts: 10,
  }),
);

// WI-4015: idempotentWorkflowQueue guards the module-top-level-DBOS-singleton class
// (see idempotent-register-workflow.ts's doc comment).
export const coordProgramQueue = idempotentWorkflowQueue('coord-program', () =>
  new WorkflowQueue('coord-program', { concurrency: queueConcurrency(4) }),
);

/**
 * Start (or resume) a durable coord-op program. An accepted operation uses its
 * immutable receipt as the identity; legacy event programs keep their existing
 * harness/run/blueprint key. The dedup id guards a concurrent double-start.
 * Returns the workflow id without blocking on the program lifetime.
 */
export function coordProgramWorkflowId(input: CoordProgramInput): string {
  const accepted = input.acceptedOperation;
  return accepted
    ? `coord-program:operation:${accepted.workspaceId}:${accepted.receiptId}`
    : `coord-program:${input.harnessSlug ?? 'op'}:${input.runId}:${input.blueprintId}`;
}

export async function startCoordProgram(input: CoordProgramInput): Promise<string> {
  const workflowID = coordProgramWorkflowId(input);
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
