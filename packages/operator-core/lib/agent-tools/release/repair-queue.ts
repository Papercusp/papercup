/** Guarded operator read/retire surface for the one persisted frozen repair queue. */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import {
  readFrozenCandidateRepairQueue,
  retireFrozenCandidateRepairQueue,
} from '../../harness/routines/release-actions';
import { releaseFixerSpawnAlive } from '../../release/fixer-liveness';
import { diagnoseFrozenCandidateRepairQueue } from '../../release/frozen-candidate-repair-queue';
import { readIdentity } from '../locks/identity';

const json = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const target = () => ({ workspaceId: activeWorkspaceId(), installSlug: operatorHomeHarnessSlug() });

async function inspectQueue() {
  const queueTarget = target();
  const queue = await readFrozenCandidateRepairQueue(queueTarget);
  let fixerAlive: boolean | null | undefined;
  if (queue?.fixerSpawnId) {
    fixerAlive = await releaseFixerSpawnAlive(getOrgPg().sql, queue.fixerSpawnId).catch(() => null);
  }
  return {
    target: queueTarget,
    queue,
    diagnostic: diagnoseFrozenCandidateRepairQueue(queue, { nowMs: Date.now(), fixerAlive }),
  };
}

async function recordAudit(
  actor: string,
  details: Record<string, unknown>,
): Promise<boolean> {
  try {
    const id = `repair-queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await getOrgPg().sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        id,
        Date.now(),
        actor,
        'release:repair-queue',
        'green-checkpoint:repair-queue',
        JSON.stringify(details),
        activeWorkspaceId(),
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export default defineTool({
  name: 'release:repair-queue',
  profile: 'engineer',
  description:
    'Inspect or explicitly retire the operator-home green-checkpoint frozen repair queue. get returns normalized phase/age/fixer/reservation/decision diagnostics. retire is dry-run unless confirm:true, refuses a live or unknown fixer and an active dispatch reservation, and clears only the exact candidate+head+updatedAt queue via full-row JSONB CAS.',
  capability: 'operator:write',
  effectForCall: (args) => (args.op === 'get' ? 'read' : 'write'),
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  guidance: {
    when:
      'A release read reports repair-in-progress, a fossil/blocked repair queue, or a queue whose fixer is definitely dead. Call get first; retire only after independently establishing that this exact queue is terminal.',
    notWhen:
      'Never retire a live/unknown fixer, an active dispatch reservation, ready-to-verify/promote work, or merely to make the gate move. This does not launch a checkpoint or deploy.',
    chaining:
      'release:repair-queue{op:get} → verify the returned exact identity + retireAllowed → retire with those exact fields and confirm:true → let the ordinary scheduled green-checkpoint fire.',
    seeAlso: ['release:deploy', 'dev:pipeline_position', 'release:trace'],
  },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('retire'),
      expectedCandidate: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
      expectedRepairHead: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
      expectedUpdatedAtMs: z.number().int().nonnegative(),
      reason: z.string().min(8).max(2000),
      confirm: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    const inspected = await inspectQueue();
    if (args.op === 'get') {
      return json({ ok: true, op: 'get', target: inspected.target, repairQueue: inspected.diagnostic });
    }
    if (ctx.role !== 'su' && !isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('release:repair-queue retire requires operator, architect, mug, or su authority');
    }
    if (!inspected.queue || !inspected.diagnostic) {
      return json({ ok: true, op: 'retire', retired: false, alreadyClear: true, target: inspected.target });
    }
    const identityMatches =
      inspected.queue.candidate === args.expectedCandidate &&
      inspected.queue.repairHead === args.expectedRepairHead &&
      inspected.queue.updatedAtMs === args.expectedUpdatedAtMs;
    if (!identityMatches) {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: 'exact_queue_identity_mismatch',
        target: inspected.target,
        repairQueue: inspected.diagnostic,
      });
    }
    if (!inspected.diagnostic.retireAllowed) {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: inspected.diagnostic.retireRefusal,
        target: inspected.target,
        repairQueue: inspected.diagnostic,
      });
    }
    if (args.confirm !== true) {
      return json({
        ok: true,
        op: 'retire',
        dryRun: true,
        retired: false,
        target: inspected.target,
        repairQueue: inspected.diagnostic,
        note: 'Pass confirm:true with the same exact identity to execute the compare-and-swap retirement.',
      });
    }

    const result = await retireFrozenCandidateRepairQueue(inspected.target, inspected.queue);
    const identity = readIdentity(ctx);
    const auditRecorded = await recordAudit(identity.ownerId, {
      reason: args.reason,
      expectedCandidate: args.expectedCandidate,
      expectedRepairHead: args.expectedRepairHead,
      expectedUpdatedAtMs: args.expectedUpdatedAtMs,
      retired: result.retired,
      casMiss: !result.retired,
    });
    return json({
      ok: result.retired,
      op: 'retire',
      retired: result.retired,
      casMiss: !result.retired,
      target: inspected.target,
      auditRecorded,
      current: result.current
        ? diagnoseFrozenCandidateRepairQueue(result.current, { nowMs: Date.now() })
        : null,
    });
  },
});
