/**
 * release:checkpoint-cancel — stop one exact detached checkpoint runner.
 *
 * This is intentionally separate from `release:checkpoint-run { replaceStale:true }`:
 * replacement is a guarded recovery heuristic, while cancellation is an operator's
 * explicit response to a known-unsafe candidate. The store CAS requires the logical
 * attempt id and the exact systemd unit recorded on that attempt before it will invoke
 * the protected SIGTERM path. The qualification row and the repair queue are updated
 * independently: only the former is settled, and the queue is never retired here.
 *
 * D-028 (staging-main-safe-changes-and-recovery-2026-11-07#D-028, WI-6554700010048992):
 * `settleUnreachableBlocker:true` with NO unit is the one narrow exception. It settles a
 * RUNNER-FREE attempt whose only obstacle is a stored blocker no production path can clear
 * (QUALIFICATION_BLOCKERS_WITHOUT_CLEAR_PATH), signals nothing, and commits an audit row
 * naming the attempt, the blockers and the caller. Every other attempt is refused.
 */

import { z } from 'zod';
import { defineTool, isOperatorConfigWriteRole, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { resolveCheckpointRouting } from '../../harness/routines/hive-release-env';
import { integrationRoot } from '../../release-deploy-launch';
import {
  checkpointUnitForRoot,
  terminateActiveCheckpointUnit,
} from '../../release-checkpoint-launch';
import {
  cancelStoredQualification,
  QUALIFICATION_UNREACHABLE_BLOCKER_SETTLED_STATUS,
  settleStoredUnreachableBlockedQualification,
  type StoredQualificationCancellation,
  type StoredUnreachableBlockerSettlement,
} from '../../release/checkpoint-qualification-transaction';
import { resolveAgentIdentity } from '../coordination/identity';
import { LIMITS, softText } from '../limits';

const json = (payload: unknown) => ({ data: payload });

type CheckpointCancelContext = {
  harnessSlug?: string | null;
  workspaceId?: unknown;
  role?: string;
  isSuperuser?: boolean;
};

function concreteWorkspace(ctx: CheckpointCancelContext): string {
  const workspace = typeof ctx.workspaceId === 'string' ? ctx.workspaceId.trim() : '';
  return workspace && workspace !== '*' ? workspace : activeWorkspaceId();
}

function baseUnit(unit: string): string {
  return unit.endsWith('.service') ? unit.slice(0, -'.service'.length) : unit;
}

function refused(reason: string, extra: Record<string, unknown> = {}) {
  return json({ ok: false, cancelled: false, refused: true, reason, ...extra });
}

function renderCancellation(
  result: StoredQualificationCancellation,
  args: { attemptId: string; unit: string },
) {
  if (result.status === 'updated') {
    return json({
      ok: true,
      cancelled: true,
      attempt_id: args.attemptId,
      unit: args.unit,
      outcome: result.transaction.outcome,
      repair_queue: 'preserved',
      note: 'The exact detached runner was SIGTERMed and the logical qualification was terminally settled as code-inconclusive. The frozen repair queue was not changed.',
    });
  }
  if (result.status === 'stop-failed') {
    return refused('stop_failed', {
      attempt_id: args.attemptId,
      unit: args.unit,
      error: result.error,
      note: 'The exact qualification row was left unchanged because the protected unit did not confirm a successful SIGTERM. Retry only after checking the exact unit state.',
    });
  }
  if (result.status === 'conflict') {
    return refused('exact_attempt_unit_mismatch', {
      attempt_id: args.attemptId,
      unit: args.unit,
      note: 'NOT cancelled: the durable qualification did not still name this attempt and unit together. No systemd signal was sent.',
    });
  }
  if (result.status === 'terminal') {
    return refused('qualification_terminal', {
      attempt_id: args.attemptId,
      unit: args.unit,
      outcome: result.transaction.outcome,
      note: 'NOT cancelled: this exact logical attempt already has a terminal outcome, so no unit was signalled.',
    });
  }
  return refused(`qualification_${result.status}`, {
    attempt_id: args.attemptId,
    unit: args.unit,
    error: 'error' in result ? result.error : undefined,
    note: 'NOT cancelled: the qualification transaction could not be read safely.',
  });
}

/** Refusal reasons from settleUnreachableBlockedQualification, with the next step for each. */
const SETTLE_REFUSAL_NOTES: Record<string, string> = {
  'attempt-mismatch': 'the stored qualification no longer names this attempt id. Re-read the current attempt before retrying.',
  'runner-held': 'this attempt has a recorded runner. Cancel it by its exact unit instead (release:checkpoint-cancel { attemptId, unit }).',
  'child-scope-custody-held': 'a child scope of this attempt is still held, so its runner may be alive.',
  'no-stored-blocker': 'the attempt carries no stored blocker, so there is nothing unreachable to settle.',
  'blocker-has-clear-path': 'at least one stored blocker has a production clear path. Clear it through that path; this settle is only for blockers in QUALIFICATION_BLOCKERS_WITHOUT_CLEAR_PATH.',
  'reason-and-actor-required': 'a non-empty reason and a verified caller are both required.',
  'pending-head-queue-mismatch': 'the attempt\'s pending repair head disagrees with the frozen queue head. Resolve that first.',
};

function renderUnreachableBlockerSettlement(
  result: StoredUnreachableBlockerSettlement,
  args: { attemptId: string; actor: string },
) {
  if (result.status === 'updated') {
    return json({
      ok: true,
      cancelled: true,
      settled: 'unreachable-blocker',
      attempt_id: args.attemptId,
      actor: args.actor,
      blockers: (result.settledBlockers ?? []).map(blocker => blocker.code),
      outcome: result.transaction.outcome,
      repair_queue: 'preserved',
      audit_event: QUALIFICATION_UNREACHABLE_BLOCKER_SETTLED_STATUS,
      note: 'The runner-free attempt was terminally settled as code-inconclusive and the audit row was committed in the same transaction. No unit was signalled and the frozen repair queue was not changed; the next scheduled fire hands it to a successor attempt.',
    });
  }
  if (result.status === 'terminal') {
    return refused('qualification_terminal', {
      attempt_id: args.attemptId,
      outcome: result.transaction.outcome,
      note: 'NOT settled: this exact logical attempt already has a terminal outcome.',
    });
  }
  if (result.status === 'conflict') {
    const refusal = result.refusalReason ?? 'conflict';
    return refused(`settle_${refusal.replace(/-/g, '_')}`, {
      attempt_id: args.attemptId,
      note: `NOT settled: ${SETTLE_REFUSAL_NOTES[refusal] ?? 'the stored qualification changed under the settle. Re-read it before retrying.'}`,
    });
  }
  return refused(`qualification_${result.status}`, {
    attempt_id: args.attemptId,
    error: 'error' in result ? result.error : undefined,
    note: 'NOT settled: the qualification transaction could not be read safely.',
  });
}

export default defineTool({
  name: 'release:checkpoint-cancel',
  profile: 'engineer',
  description:
    'Cancel one known-unsafe detached green-checkpoint runner by exact logical attempt id and exact recorded systemd unit. The protected SIGTERM path is invoked only after the same-row attempt/unit CAS succeeds; the qualification becomes terminal code-inconclusive and the frozen repair queue is preserved.',
  guidance: {
    when: 'A live detached checkpoint is proven unsafe or is judging a candidate that must not be allowed to produce a verdict. Obtain attemptId and unit from the qualification/run evidence first.',
    notWhen: 'Do not use this as a generic retry or stale-run heuristic. Use release:checkpoint-run { replaceStale:true } for the separately guarded stale-candidate recovery path.',
    chaining: 'read the exact qualification attempt/unit → release:checkpoint-cancel → inspect the inconclusive evidence and preserved repair queue before starting a successor.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'release-fixer', 'release-manager'],
  args: z.object({
    attemptId: z.string().min(1).max(256).describe('the exact logical qualification attempt id currently owning the detached runner'),
    unit: z
      .string()
      .regex(/^(?:papercup-green-checkpoint-manual-[a-z0-9-]+\.service|papercusp-checkpoint-[a-z0-9-]+\.scope)$/)
      .optional()
      .describe('the exact systemd user unit recorded on that attempt: the manual .service, or a scheduled run\'s papercusp-checkpoint-<id>.scope. Required unless settleUnreachableBlocker is true; forbidden with it'),
    settleUnreachableBlocker: z
      .boolean()
      .optional()
      .describe('D-028: settle a RUNNER-FREE attempt whose only stored blockers have no production clear path. Takes no unit, needs a reason, signals nothing'),
    reason: softText(LIMITS.SHORT_TITLE)
      .optional()
      .describe('why this known-unsafe runner is being cancelled; stored as the terminal code-inconclusive reason'),
  }),
  async handler(args, ctx) {
    let actor: string;
    try {
      actor = resolveAgentIdentity(ctx).ownerId;
    } catch {
      return refused('authentication_required', {
        note: 'A verified caller identity is required before a protected checkpoint unit can be signalled.',
      });
    }
    if (ctx.isSuperuser !== true && ctx.role !== 'su' && !isOperatorConfigWriteRole(ctx.role)) {
      return refused('role_forbidden', {
        role: ctx.role ?? 'unknown',
        note: 'release:checkpoint-cancel requires su or an operator-config write role.',
      });
    }

    const workspaceId = concreteWorkspace(ctx);
    const installSlug = operatorHomeHarnessSlug();

    if (args.settleUnreachableBlocker === true) {
      // A settle signals nothing, so naming a unit can only mean the caller thinks a runner
      // exists. That is exactly the case the settle must never touch: refuse instead of guessing.
      if (args.unit !== undefined) {
        return refused('settle_takes_no_unit', {
          attempt_id: args.attemptId,
          unit: args.unit,
          note: 'NOT settled: settleUnreachableBlocker is only for a runner-free attempt. Cancel a recorded runner by its exact unit without settleUnreachableBlocker.',
        });
      }
      const settlement = await settleStoredUnreachableBlockedQualification(
        { workspaceId, installSlug },
        {
          attemptId: args.attemptId,
          reason: args.reason ?? '',
          actor,
          evidenceRefs: ['tool:release:checkpoint-cancel:settle-unreachable-blocker'],
        },
      );
      return renderUnreachableBlockerSettlement(settlement, { attemptId: args.attemptId, actor });
    }
    if (args.unit === undefined) {
      return refused('unit_required', {
        attempt_id: args.attemptId,
        note: 'NOT cancelled: name the exact recorded unit, or pass settleUnreachableBlocker:true for a runner-free attempt held only by an unclearable stored blocker.',
      });
    }
    const unit = args.unit;

    const routing = await resolveCheckpointRouting({ installSlug, workspaceId }, integrationRoot());
    if (routing.skip) {
      return refused('checkpoint_routing_skip', {
        harness: installSlug,
        workspace_id: workspaceId,
        detail: routing.skip.reason,
      });
    }
    const checkpointRoot = routing.extraEnv.PAPERCUSP_INTEGRATION_ROOT ?? routing.root;
    const expectedUnit = `${checkpointUnitForRoot(checkpointRoot)}.service`;
    // WI-6554700010042670: a SCHEDULED run lives in a per-run scope named for its runner, so it has
    // no canonical per-root name to compare against. Exactness still holds: the store's CAS below
    // only signals when the attempt's recorded runner unit equals this exact scope.
    const scheduledScope = unit.endsWith('.scope');
    if (!scheduledScope && unit !== expectedUnit) {
      return refused('unit_mismatch', {
        attempt_id: args.attemptId,
        unit,
        note: 'NOT cancelled: the requested unit is not the canonical unit for this operator-home checkpoint target.',
      });
    }

    const result = await cancelStoredQualification(
      { workspaceId, installSlug },
      {
        attemptId: args.attemptId,
        unit,
        reason: args.reason,
        evidenceRefs: ['tool:release:checkpoint-cancel'],
      },
      () => terminateActiveCheckpointUnit(scheduledScope ? unit : baseUnit(unit)),
    );
    return renderCancellation(result, { attemptId: args.attemptId, unit });
  },
});
