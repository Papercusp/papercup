/** Guarded operator read/retire surface for the one persisted frozen repair queue. */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import {
  readFrozenCandidateRepairQueue,
  retireFrozenCandidateRepairQueue,
  writeFrozenCandidateRepairQueue,
} from '../../harness/routines/release-actions';
import { releaseFixerSpawnAlive } from '../../release/fixer-liveness';
import { diagnoseFrozenCandidateRepairQueue } from '../../release/frozen-candidate-repair-queue';
import {
  assessConvergeRepairHead,
  containmentForPaths,
} from '../../release/converge-repair-head';
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
    fixerAlive,
    diagnostic: diagnoseFrozenCandidateRepairQueue(queue, { nowMs: Date.now(), fixerAlive }),
  };
}

async function inspectFixerLiveness(queue: Awaited<ReturnType<typeof readFrozenCandidateRepairQueue>>) {
  if (!queue?.fixerSpawnId) return null;
  return releaseFixerSpawnAlive(getOrgPg().sql, queue.fixerSpawnId).catch(() => null);
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
    'Inspect, converge, or retire the operator-home green-checkpoint frozen repair queue. Workspace-global: omit harness/workspace. get returns phase/age/fixer/reservation/decision diagnostics. converge is THE sanctioned route for landing a gate-red fix on the judged lineage: it fast-forwards the movable repairHead to the staging tip while that is still safe, never touches the immutable candidate, and with paths reports whether the judged sha carries your fix. retire is dry-run unless confirm:true and clears only the exact candidate+head+updatedAt queue via full-row JSONB CAS.',
  capability: 'operator:write',
  effectForCall: (args) =>
    args.op === 'get' || (args.op === 'converge' && args.confirm !== true) ? 'read' : 'write',
  requirePrincipal: false,
  // The release-fixer's runbook uses the read/dry-run and confirmed converge
  // paths; its existing operator:write cap keeps the write branch guarded.
  agentRoles: [...SU_ROLES, 'release-fixer'],
  rolesQuota: { operator: { perRun: 20 } },
  guidance: {
    when:
      'You fixed a gate red and need it on the judged sha — call converge{paths}. Or a release read reports repair-in-progress, a fossil/blocked queue, or a definitely-dead fixer.',
    notWhen:
      'Do not pass harness or workspace: this tool is workspace-global and derives the operator-home target internally. Never retire a live/unknown fixer, an active dispatch reservation, ready-to-verify work, or merely to make the gate move. Never re-cut a fresh candidate for a phantom red. Does not launch a checkpoint or deploy.',
    chaining:
      'Landing a fix: converge{paths} → read verdict + containment → re-call confirm:true if it says would-converge. Retiring: get → verify exact identity + retireAllowed → retire with those fields and confirm:true.',
    returns:
      "converge verdicts: no-frozen-queue (nothing frozen — an ordinary staging commit is already the judged lineage) | already-converged (repairHead is the staging tip; your fix is on the judged sha) | would-converge (dry run; re-call with confirm:true to fast-forward) | converged (repairHead moved; check persisted) | diverged-merge-required (a repair fixer has committed, so fast-forward would discard it — merge staging into the worktree named in nextAction) | ancestry-unverifiable (the git probe failed; fails closed to today's behaviour, never a guess). containment[] reports, per requested path, whether the judged sha carries staging's current content — equal blobs prove that PATH is current, NOT that the candidate is, so a submodule-backed subject still needs a gitlink diff. retire: dry-run unless confirm:true; refuses a live/unknown fixer and an active dispatch reservation; a CAS miss returns casMiss with the post-write diagnostic under current.",
    seeAlso: ['release:deploy', 'dev:pipeline_position', 'release:trace'],
  },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('converge'),
      /** Repo-relative paths your fix touched; each is reported as contained or not. */
      paths: z.array(z.string().min(1)).max(50).optional(),
      reason: z.string().min(8).max(2000).optional(),
      confirm: z.boolean().optional(),
    }),
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
    if (args.op === 'converge') {
      const assessment = assessConvergeRepairHead(inspected.queue);
      const containment =
        args.paths?.length && assessment.judgedSha
          ? containmentForPaths(args.paths, assessment.judgedSha, assessment.root, undefined, assessment.branch)
          : null;
      const base = {
        op: 'converge' as const,
        target: inspected.target,
        verdict: assessment.verdict,
        judgedSha: assessment.judgedSha,
        stagingTip: assessment.stagingTip,
        nextAction: assessment.nextAction,
        containment,
        repairQueue: inspected.diagnostic,
      };
      // Only 'would-converge' is a state change; every other verdict is a read.
      if (assessment.verdict !== 'would-converge' || !assessment.newRepairHead || !inspected.queue) {
        return json({ ok: true, converged: false, ...base });
      }
      if (ctx.role !== 'su' && !isOperatorConfigWriteRole(ctx.role)) {
        throw new Error('release:repair-queue converge requires operator, architect, mug, or su authority');
      }
      if (args.confirm !== true) {
        return json({
          ok: true,
          converged: false,
          dryRun: true,
          ...base,
          wouldMoveRepairHead: { from: inspected.queue.repairHead, to: assessment.newRepairHead },
          note:
            'Pass confirm:true to fast-forward repairHead to the staging tip. The immutable ' +
            'candidate is never touched. Every commit absorbed is already committed on staging.',
        });
      }
      const converged = { ...inspected.queue, repairHead: assessment.newRepairHead };
      let persisted = true;
      try {
        await writeFrozenCandidateRepairQueue(inspected.target, converged);
      } catch {
        persisted = false;
      }
      const identity = readIdentity(ctx);
      const auditRecorded = await recordAudit(identity.ownerId, {
        op: 'converge',
        reason: args.reason ?? null,
        from: inspected.queue.repairHead,
        to: assessment.newRepairHead,
        persisted,
      });
      return json({
        ok: persisted,
        converged: persisted,
        ...base,
        verdict: persisted ? ('converged' as const) : assessment.verdict,
        movedRepairHead: { from: inspected.queue.repairHead, to: assessment.newRepairHead },
        persisted,
        auditRecorded,
        ...(persisted
          ? {}
          : {
              reason: 'persist_failed',
              note: 'repairHead was NOT durably moved; re-run before relying on the judged sha.',
            }),
      });
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
    const currentFixerAlive = await inspectFixerLiveness(result.current);
    const casMiss = !result.retired;
    const identity = readIdentity(ctx);
    const auditRecorded = await recordAudit(identity.ownerId, {
      reason: args.reason,
      expectedCandidate: args.expectedCandidate,
      expectedRepairHead: args.expectedRepairHead,
      expectedUpdatedAtMs: args.expectedUpdatedAtMs,
      retired: result.retired,
      casMiss,
    });
    // A CAS miss is a storage outcome, not a liveness refusal. The nested `current`
    // diagnostic describes the row after the failed write; it must not become the
    // operation's headline reason.
    return json({
      ok: result.retired,
      op: 'retire',
      retired: result.retired,
      casMiss,
      reason: casMiss ? 'cas-miss' : undefined,
      target: inspected.target,
      auditRecorded,
      current: result.current
        ? diagnoseFrozenCandidateRepairQueue(result.current, {
            nowMs: Date.now(),
            fixerAlive: currentFixerAlive,
          })
        : null,
    });
  },
});
