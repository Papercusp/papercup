/** Durable caller recovery uses the existing carry-note store. Only its opaque
 * return reference crosses into target context; caller history stays here. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getCarryNote, setCarryNoteWithPrior } from './carry-note';
import { getWakeModeOverride, resolveWakeMode } from './agent-tools/coordination/wake-mode';
import { listActiveAwaits } from './events/await/store';
import { loopRoutineName } from './harness/routines/loop';
import { acquireClaim, getClaim, listClaimsForOwner, releaseClaim } from './plan-items/claims';
import { readAssumeCaller } from './session-assume-preparation';
import { claimWorkItem, getWorkItem, releaseWorkItem } from './work-items';
import { getWorkItemCheckpointWithMeta } from './work-item-checkpoint';
import { runWithWorkspace } from './workspace-als';
import { assumeCallerPause, clearAssumeCallerPause, installAssumeCallerPause, ownsAssumeCallerPause, readAssumeCallerPause } from './session-assume-pause';
import { assumePreparationSchema, assumeTransitionKey, type AssumeCaller, type AssumeCallerRecovery, type AssumePreparation, type AssumeTransitionDeps } from './session-assume';

export interface AssumeCallerCheckpoint {
  version: 1;
  transitionKey: string;
  caller: AssumeCaller;
  capturedAt: number;
  carryNotes: Array<{ scope: string; note: string; revision: string }>;
  work: Array<{ id: string; harness: string | null; checkpoint: string; updatedAtMs: number; claimStamp: string | null }>;
  planClaims: Awaited<ReturnType<typeof listClaimsForOwner>>;
  awaits: Awaited<ReturnType<typeof listActiveAwaits>>;
  wakeMode: Awaited<ReturnType<typeof resolveWakeMode>>;
  wakeModeOverride: Awaited<ReturnType<typeof getWakeModeOverride>>;
  /** Raw existing loop projection, including its exact payload and revision,
   * so rollback can restore configuration without inventing a new loop. */
  loops: Array<{ id: string; active: boolean; revision: string; configuration: Record<string, unknown> }>;
  inbox: 'retained';
  directives: 'retained';
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const scopeFor = (plan: AssumePreparation) => `${assumeTransitionKey(plan)}:caller`;

export function assumeCallerRecovery(plan: AssumePreparation, body: string): AssumeCallerRecovery {
  return { checkpointRef: `carry-note:${scopeFor(plan)}`, checkpointSha256: sha256(body),
    returnRef: { ownerId: plan.caller.ownerId, workspaceId: plan.caller.workspaceId,
      nativeSessionId: plan.caller.nativeSessionId, incarnation: plan.caller.incarnation } };
}

/** Read and authenticate an existing recovery snapshot before any restoration.
 * The snapshot contains caller-only data and is never returned by preview. */
export async function readAssumeCallerCheckpoint(
  plan: AssumePreparation, recovery: AssumeCallerRecovery,
): Promise<AssumeCallerCheckpoint> {
  if (recovery.checkpointRef !== `carry-note:${scopeFor(plan)}` ||
      JSON.stringify(recovery.returnRef) !== JSON.stringify(assumeCallerRecovery(plan, '').returnRef)) {
    throw new Error('assume-caller-recovery-invalid');
  }
  const body = await getCarryNote({ workspaceId: plan.caller.workspaceId, scope: scopeFor(plan) });
  if (!body || sha256(body) !== recovery.checkpointSha256) throw new Error('assume-caller-recovery-changed');
  const snapshot = JSON.parse(body) as AssumeCallerCheckpoint;
  const caller = assumePreparationSchema.shape.caller.safeParse(snapshot.caller);
  if (snapshot.version !== 1 || snapshot.transitionKey !== assumeTransitionKey(plan) ||
      !caller.success || JSON.stringify(caller.data) !==
      JSON.stringify(assumePreparationSchema.shape.caller.parse(plan.caller))) throw new Error('assume-caller-recovery-invalid');
  return snapshot;
}

/** Preserve evidence before any caller claim/wake mutation. A retry adopts the
 * acknowledged snapshot and never overwrites the original recovery body. */
export async function checkpointAssumeCaller(plan: AssumePreparation, deps: {
  readCaller?: typeof readAssumeCaller;
} = {}): Promise<AssumeCallerRecovery> {
  const { ownerId, workspaceId } = plan.caller;
  const current = assumePreparationSchema.shape.caller.safeParse(
    await (deps.readCaller ?? readAssumeCaller)({ ownerId, workspaceId }));
  if (!current.success || JSON.stringify(current.data) !==
      JSON.stringify(assumePreparationSchema.shape.caller.parse(plan.caller))) throw new Error('assume-caller-changed');
  const ref = { workspaceId, scope: scopeFor(plan) };
  const prior = await getCarryNote(ref);
  if (prior) {
    const recovery = assumeCallerRecovery(plan, prior);
    await readAssumeCallerCheckpoint(plan, recovery);
    return recovery;
  }
  const { sql } = getOrgPg();
  const [held, planClaims, awaits, carryNotes, wakeMode, wakeModeOverride, loops, awaitCount] = await Promise.all([
    sql<Array<{ id: string; harness: string | null }>>`
      SELECT feature_id AS id, harness_slug AS harness FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId} AND taken_by = ${ownerId}
      UNION ALL
      SELECT issue_id AS id, CASE WHEN scope LIKE 'harness:%' THEN substring(scope FROM 9) ELSE NULL END AS harness
        FROM harness_shared.engineer_issues WHERE workspace_id = ${workspaceId} AND assignee = ${ownerId}
    `,
    listClaimsForOwner(workspaceId, ownerId, 201), listActiveAwaits(ownerId),
    sql<AssumeCallerCheckpoint['carryNotes']>`
      SELECT scope, note, body_ts::text AS revision FROM harness_shared.carry_notes
       WHERE workspace_id = ${workspaceId} AND left(scope, 5) = 'loop:'
         AND right(scope, length(${ownerId}::text) + 1) = ${':' + ownerId} AND note IS NOT NULL
    `,
    resolveWakeMode(ownerId), getWakeModeOverride(ownerId),
    sql<AssumeCallerCheckpoint['loops']>`
      SELECT id, active, updated_at::text AS revision, to_jsonb(routines) AS configuration
        FROM harness_shared.routines WHERE workspace_id = ${workspaceId}
         AND target_owner_id = ${ownerId} AND name = ${loopRoutineName(ownerId)}
    `,
    sql<Array<{ count: string }>>`SELECT count(*) FROM harness_shared.event_awaits
      WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND subscriber_id = ${ownerId}
        AND policy <> 'announce' AND fired_at IS NULL AND cancelled_at IS NULL`,
  ]);
  if (held.length > 1_000 || planClaims.length > 200 || Number(awaitCount[0]?.count) !== awaits.length) {
    throw new Error('assume-caller-snapshot-incomplete');
  }
  const work = await Promise.all(held.map(async item => {
    const [checkpoint, current] = await Promise.all([
      getWorkItemCheckpointWithMeta({ workspaceId, harness: item.harness, workItemId: item.id }),
      runWithWorkspace(workspaceId, () => getWorkItem(item.id, item.harness ?? undefined)),
    ]);
    if (!current || current.assignee !== ownerId) throw new Error('assume-caller-claims-changed');
    if (!checkpoint.checkpoint || checkpoint.updatedAtMs === null) throw new Error('assume-caller-checkpoint-required');
    return { ...item, checkpoint: checkpoint.checkpoint, updatedAtMs: checkpoint.updatedAtMs, claimStamp: current.takenAt };
  }));
  const snapshot: AssumeCallerCheckpoint = { version: 1, transitionKey: assumeTransitionKey(plan),
    caller: plan.caller, capturedAt: Date.now(), carryNotes, work, planClaims, awaits,
    wakeMode, wakeModeOverride, loops, inbox: 'retained', directives: 'retained' };
  const body = JSON.stringify(snapshot);
  const written = await setCarryNoteWithPrior(ref, body, { expectedHash: null });
  if (written.blockedReason || written.stored !== body) throw new Error('assume-caller-checkpoint-conflict');
  return assumeCallerRecovery(plan, body);
}

/** The managed host must serialize this fence with ALL injection/replacement
 * paths and attest the exact caller PID/incarnation/attachment. A mode setting
 * or a socket send without an acknowledgement cannot implement this contract. */
export interface AssumeCallerHostFence {
  freeze(plan: AssumePreparation, recovery: AssumeCallerRecovery): Promise<boolean>;
  thaw(plan: AssumePreparation, recovery: AssumeCallerRecovery): Promise<boolean>;
  readCaller?: typeof readAssumeCaller;
}

async function requireCaller(plan: AssumePreparation, read: typeof readAssumeCaller): Promise<void> {
  const current = assumePreparationSchema.shape.caller.safeParse(await read(plan.caller));
  if (!current.success || JSON.stringify(current.data) !== JSON.stringify(assumePreparationSchema.shape.caller.parse(plan.caller))) {
    throw new Error('assume-caller-changed');
  }
}

/** Reuse canonical claim writers so claim leases, linked lanes, release events
 * and lifecycle subscriptions retain their existing semantics. Awaits/inbox/
 * directives stay intact; the lifecycle marker pauses delivery, including wakes
 * emitted after the snapshot. Partial effects recover from the immutable body. */
export function createAssumeCallerAdapters(host: AssumeCallerHostFence):
  Pick<AssumeTransitionDeps, 'checkpointCaller' | 'quiesceCaller' | 'restoreCaller'> {
  const readCaller = host.readCaller ?? readAssumeCaller;
  return {
    checkpointCaller: plan => checkpointAssumeCaller(plan, { readCaller }),
    async quiesceCaller(plan, recovery) {
      const saved = await readAssumeCallerCheckpoint(plan, recovery);
      await requireCaller(plan, readCaller);
      // Install first: durable deliveries park even while the host ACK is in
      // flight. Host refusal leaves a recoverable pause, never freed claims.
      await installAssumeCallerPause(plan, recovery);
      if (!await host.freeze(plan, recovery)) throw new Error('assume-caller-host-not-fenced');
      await requireCaller(plan, readCaller);
      const currentPlans = await listClaimsForOwner(plan.caller.workspaceId, plan.caller.ownerId, 201);
      const claimKeys = (claims: typeof saved.planClaims) => claims.map(c => c.claimId).sort().join('\n');
      if (claimKeys(currentPlans) !== claimKeys(saved.planClaims)) throw new Error('assume-caller-claims-changed');
      const { sql } = getOrgPg();
      // All loops pause atomically, and only at the captured configuration.
      await sql.begin(async tx => {
        const pausedLoops: Array<{ id: string; revision: string }> = [];
        for (const loop of saved.loops.filter(loop => loop.active)) {
          const rows = await tx<Array<{ id: string; revision: string }>>`
            UPDATE harness_shared.routines SET active = false, updated_at = now()
             WHERE id = ${loop.id} AND workspace_id = ${plan.caller.workspaceId}
               AND target_owner_id = ${plan.caller.ownerId} AND updated_at::text = ${loop.revision}
            RETURNING id, updated_at::text AS revision
          `;
          if (rows.length !== 1) throw new Error('assume-caller-loop-changed');
          pausedLoops.push(rows[0]);
        }
        const marker = assumeCallerPause(plan, recovery);
        const rows = await tx`UPDATE harness_shared.session_briefs
          SET control_state = jsonb_set(control_state, '{lifecycle,assumeCaller}',
            ${JSON.stringify({ ...marker, pausedLoops })}::text::jsonb),
            control_generation = control_generation + 1, control_updated_at = now()
          WHERE owner_id = ${plan.caller.ownerId} AND workspace_id = ${plan.caller.workspaceId}
            AND control_state #> '{lifecycle,assumeCaller}' = ${JSON.stringify(marker)}::text::jsonb
          RETURNING owner_id`;
        if (rows.length !== 1) throw new Error('assume-caller-pause-changed');
      });
      for (const item of saved.work) {
        const current = await runWithWorkspace(plan.caller.workspaceId, () => getWorkItem(item.id, item.harness ?? undefined));
        const checkpoint = await getWorkItemCheckpointWithMeta({ workspaceId: plan.caller.workspaceId,
          harness: item.harness, workItemId: item.id });
        if (!current || current.assignee !== plan.caller.ownerId || current.takenAt !== item.claimStamp ||
            checkpoint.checkpoint !== item.checkpoint || checkpoint.updatedAtMs !== item.updatedAtMs) {
          throw new Error('assume-caller-claims-changed');
        }
        const released = await runWithWorkspace(plan.caller.workspaceId, () => releaseWorkItem(item.id, { harness: item.harness ?? undefined,
          expectedAssignee: plan.caller.ownerId, releasingOwnerId: plan.caller.ownerId,
          retainPausedCallerBindings: { ownerId: plan.caller.ownerId, transitionKey: assumeTransitionKey(plan) } }));
        if (!released || released.assignee) throw new Error('assume-caller-release-failed');
      }
      for (const claim of saved.planClaims) {
        const current = await getClaim(claim.workspaceId, claim.harnessSlug, claim.planSlug, claim.itemId);
        // releaseWorkItem may already have released this linked plan claim.
        if (current && (current.claimId !== claim.claimId || !await releaseClaim(claim.workspaceId,
          claim.harnessSlug, claim.planSlug, claim.itemId, claim.claimId, claim.owner))) {
          throw new Error('assume-caller-plan-claim-changed');
        }
      }
      const remaining = await sql`
        SELECT feature_id FROM harness_shared.harness_features_consolidated
         WHERE workspace_id = ${plan.caller.workspaceId} AND taken_by = ${plan.caller.ownerId}
        UNION ALL SELECT issue_id FROM harness_shared.engineer_issues
         WHERE workspace_id = ${plan.caller.workspaceId} AND assignee = ${plan.caller.ownerId}
      `;
      if (remaining.length || (await listClaimsForOwner(plan.caller.workspaceId, plan.caller.ownerId, 1)).length) {
        throw new Error('assume-caller-claims-changed');
      }
      return { releasedWorkClaims: saved.work.map(item => ({ id: item.id, checkpointRef: recovery.checkpointRef })),
        releasedPlanClaims: saved.planClaims.map(c => ({ plan: c.planSlug, item: c.itemId, checkpointRef: recovery.checkpointRef })),
        pausedLoopRef: saved.loops.some(loop => loop.active) ? recovery.checkpointRef : null,
        pausedAwaitIds: saved.awaits.map(awaited => awaited.id), inbox: 'retained', directives: 'retained' };
    },
    async restoreCaller(plan, recovery) {
      try {
        const saved = await readAssumeCallerCheckpoint(plan, recovery);
        await requireCaller(plan, readCaller);
        const pause = await readAssumeCallerPause(plan.caller.ownerId);
        if (!ownsAssumeCallerPause(pause, plan, recovery)) return false;
        for (const item of saved.work) {
          const current = await runWithWorkspace(plan.caller.workspaceId, () => getWorkItem(item.id, item.harness ?? undefined));
          const checkpoint = await getWorkItemCheckpointWithMeta({ workspaceId: plan.caller.workspaceId,
            harness: item.harness, workItemId: item.id });
          if (!current || (current.assignee && current.assignee !== plan.caller.ownerId) ||
              checkpoint.checkpoint !== item.checkpoint || checkpoint.updatedAtMs !== item.updatedAtMs) return false;
          if (!current.assignee && !(await runWithWorkspace(plan.caller.workspaceId, () => claimWorkItem(item.id, plan.caller.ownerId,
            { harness: item.harness ?? undefined, assignedBy: plan.caller.ownerId })))) return false;
        }
        for (const claim of saved.planClaims) {
          const current = await getClaim(claim.workspaceId, claim.harnessSlug, claim.planSlug, claim.itemId);
          if (current && current.owner !== claim.owner) return false;
          if (!current && !(await acquireClaim({ ...claim, ttlSec: claim.ttlSec })).ok) return false;
        }
        const { sql } = getOrgPg();
        await sql.begin(async tx => {
          for (const paused of pause!.pausedLoops ?? []) {
            const loop = saved.loops.find(loop => loop.id === paused.id && loop.active);
            if (!loop) throw new Error('assume-caller-loop-invalid');
            const rows = await tx`
              UPDATE harness_shared.routines SET active = true, updated_at = now()
               WHERE id = ${loop.id} AND workspace_id = ${plan.caller.workspaceId}
                 AND target_owner_id = ${plan.caller.ownerId}
                 AND updated_at::text = ${paused.revision} AND active = false
                 AND (to_jsonb(routines) - 'active' - 'updated_at' - 'active_changed_at') =
                     (${JSON.stringify(loop.configuration)}::text::jsonb - 'active' - 'updated_at' - 'active_changed_at')
              RETURNING id
            `;
            if (rows.length !== 1) throw new Error('assume-caller-loop-changed');
          }
        });
        await requireCaller(plan, readCaller);
        if (!await host.thaw(plan, recovery)) return false;
        return clearAssumeCallerPause(plan, recovery);
      } catch { return false; }
    },
  };
}
