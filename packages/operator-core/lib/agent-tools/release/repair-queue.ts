/**
 * Guarded operator read/admit/retire surface for the one persisted frozen repair queue.
 *
 * `admit` (P-002 of frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-004/D-010) is
 * THE door through which a fix reaches a frozen candidate's judged lineage: exactly the named
 * paths, taken from the integration branch, replayed onto the queue's `repairHead` by
 * `admitPathsOntoRepairHead`. Nothing here fast-forwards, merges, or reads the tip as a whole —
 * the pre-D-004 `converge` (fast-forward repairHead to the staging tip) is gone, and `converge`
 * is now only an alias for `admit` so a stale runbook still lands on the right door.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import {
  readFrozenCandidateRepairQueueState,
  retireFrozenCandidateRepairQueue,
  writeFrozenCandidateRepairQueue,
} from '../../harness/routines/release-actions';
import { integrationRoot } from '../../release-deploy-launch';
import { releaseFixerSpawnAlive } from '../../release/fixer-liveness';
import {
  describeUnreadableFrozenCandidateRepairQueue,
  diagnoseFrozenCandidateRepairQueue,
  markFrozenRepairAdmitted,
  type FrozenCandidateRepairQueue,
} from '../../release/frozen-candidate-repair-queue';
import { containmentForPaths, integrationBranch } from '../../release/judged-sha-containment';
import { admitPathsOntoRepairHead, retractAdmission } from '../../release/repair-head-admission';
import { readIdentity } from '../locks/identity';

const json = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const target = () => ({ workspaceId: activeWorkspaceId(), installSlug: operatorHomeHarnessSlug() });
const argsSchema = z.preprocess(
  (value) => {
    // The read branch has no arguments. Treat an omitted op on an otherwise
    // empty object as the read operation, while leaving malformed branch
    // payloads subject to the discriminated-union requirements below.
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      return { op: 'get' };
    }
    return value;
  },
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('admit'),
      /** Repo-relative paths your fix touched — the admission allowlist. REQUIRED: an admission is by explicit path. */
      paths: z.array(z.string().min(1)).min(1).max(50),
      reason: z.string().min(8).max(2000).optional(),
      confirm: z.boolean().optional(),
    }),
    z.object({
      /** Alias of admit, kept so a stale runbook lands on the same door. Identical semantics. */
      op: z.literal('converge'),
      paths: z.array(z.string().min(1)).min(1).max(50),
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
);

export type FrozenRepairFixerAuthorizationStatus =
  | 'not-applicable'
  | 'unsigned-caller'
  | 'missing-spawn-id'
  | 'no-repair-queue'
  | 'wrong-phase'
  | 'queue-unassigned'
  | 'different-fixer'
  | 'queue-unreadable'
  | 'authorized-delegate';

export interface FrozenRepairFixerAuthorization {
  status: FrozenRepairFixerAuthorizationStatus;
  authorized: boolean | null;
  callerSpawnId: string | null;
  queueFixerSpawnId: string | null;
  safeAction: string;
}

/**
 * Authenticate a frozen-candidate release-fixer against the queue that launched it.
 *
 * A live su owns LIVE_GATE_OPS while the queue delegates the file/test repair to one
 * child. The generic ownership cell cannot distinguish that child from an unrelated
 * would-be fixer, so the child used to see the parent's live hold and self-cancel.
 * The signed MCP spawn id is the non-forgeable join: only the queue's current
 * `fixerSpawnId` is the delegated worker. Every missing/mismatched state fails closed.
 */
export function assessFrozenRepairFixerAuthorization(
  queue: FrozenCandidateRepairQueue | null,
  caller: {
    role?: string | null;
    spawnId?: string | null;
    sigVerifiedSpawn?: boolean | null;
    isSuperuser?: boolean | null;
  },
): FrozenRepairFixerAuthorization {
  const callerSpawnId = typeof caller.spawnId === 'string' && caller.spawnId.trim()
    ? caller.spawnId.trim()
    : null;
  const queueFixerSpawnId = queue?.fixerSpawnId ?? null;
  const result = (
    status: FrozenRepairFixerAuthorizationStatus,
    authorized: boolean | null,
    safeAction: string,
  ): FrozenRepairFixerAuthorization => ({
    status,
    authorized,
    callerSpawnId,
    queueFixerSpawnId,
    safeAction,
  });

  // EI-22208176411693669: the superuser-bearer transport (`?superuser=1` + loopback
  // bearer, _mcp-handler.ts's SU-bearer branch) never carries a verified per-spawn
  // signature — sigVerifiedSpawn is unconditionally absent/false there — and its
  // `?role=` query param is DELIBERATELY only a `tools/list` catalog-narrowing hint
  // (token-usage-reduction P-011), never a security identity assertion; dispatch
  // capability on that branch is already unconditional (isSuperuser bypasses role
  // gates platform-wide). So this caller can never legitimately reach
  // 'authorized-delegate' through the signed-spawn check no matter which role its
  // catalog was narrowed to — including 'release-fixer', which previously slipped
  // past the check below and landed on the fail-closed 'unsigned-caller' verdict
  // even when the caller genuinely was the queue's own delegated fixer. Route it to
  // 'not-applicable' like any other non-release-fixer-role caller: the buildReleaseFixerKickoff
  // brief already documents the fallback (compare fixerSpawnId to PAPERCUSP_SPAWN_ID
  // directly), and the converge write-gate independently authorizes this transport tier.
  if (caller.isSuperuser === true) {
    return result(
      'not-applicable',
      null,
      'This caller reached the queue over the superuser-bearer transport, which carries no verified per-spawn signature regardless of its ?role= catalog hint — the signed-delegate check does not apply here. Compare repairQueue.fixerSpawnId directly against your own PAPERCUSP_SPAWN_ID to confirm you remain the delegated fixer; converge is independently authorized for this transport tier.',
    );
  }
  if (caller.role !== 'release-fixer') {
    return result(
      'not-applicable',
      null,
      'This caller is not a release-fixer; use the ordinary operator/su queue policy.',
    );
  }
  if (caller.sigVerifiedSpawn !== true) {
    return result(
      'unsigned-caller',
      false,
      'STOP: the caller has no verified signed-spawn provenance, so it cannot inherit delegated repair authority.',
    );
  }
  if (!callerSpawnId) {
    return result(
      'missing-spawn-id',
      false,
      'STOP: the signed request carried no usable spawn id.',
    );
  }
  if (!queue) {
    return result('no-repair-queue', false, 'STOP: no frozen repair queue currently delegates work.');
  }
  if (queue.phase !== 'awaiting-fixer') {
    return result(
      'wrong-phase',
      false,
      `STOP: the repair queue is ${queue.phase}, not awaiting-fixer.`,
    );
  }
  if (!queue.fixerSpawnId) {
    return result(
      'queue-unassigned',
      false,
      'STOP: the queue has not durably assigned a fixer spawn yet; retry the read after dispatch finalization rather than guessing.',
    );
  }
  if (queue.fixerSpawnId !== callerSpawnId) {
    return result(
      'different-fixer',
      false,
      `STOP: this queue is delegated to ${queue.fixerSpawnId}, not this caller.`,
    );
  }
  return result(
    'authorized-delegate',
    true,
    'Proceed only with the assigned repair: author on the shared staging checkout and land it with op:\'admit\' (path-exact; there is no repair worktree). A separate held-live LIVE_GATE_OPS owner is your delegator, not a competing fixer. Do not claim the gate, launch a checkpoint, mutate deployment, or work outside this queue identity.',
  );
}

async function inspectQueue() {
  const queueTarget = target();
  const read = await readFrozenCandidateRepairQueueState(queueTarget);
  const queue = read.status === 'value' ? read.queue : null;
  let fixerAlive: boolean | null | undefined;
  if (queue?.fixerSpawnId) {
    fixerAlive = await releaseFixerSpawnAlive(getOrgPg().sql, queue.fixerSpawnId).catch(() => null);
  }
  return {
    target: queueTarget,
    read,
    queue,
    fixerAlive,
    diagnostic: diagnoseFrozenCandidateRepairQueue(queue, { nowMs: Date.now(), fixerAlive }),
  };
}

async function inspectFixerLiveness(queue: FrozenCandidateRepairQueue | null) {
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
    'Inspect, admit onto, or retire the operator-home green-checkpoint frozen repair queue. Workspace-global: omit harness/workspace. A present queue this build cannot parse is rendered as unreadable and every mutation refuses; it is never treated as absent. admit{paths} is THE door for landing a gate-red fix on the judged lineage: it replays EXACTLY the named paths from the integration branch onto repairHead as one proved commit (diff-tree == allowlist, or refused); never touches the immutable candidate, never reads the tip as a whole; dry-run unless confirm:true. converge is an alias of admit. retire: dry-run unless confirm:true, exact-identity JSONB CAS.',
  capability: 'operator:write',
  effectForCall: (args) => {
    const op = (args as { op?: unknown }).op;
    return op === undefined || op === 'get' || ((op === 'admit' || op === 'converge') && (args as { confirm?: unknown }).confirm !== true)
      ? 'read'
      : 'write';
  },
  requirePrincipal: false,
  // The release-fixer's runbook uses the read/dry-run and confirmed admit
  // paths; its existing operator:write cap keeps the write branch guarded.
  agentRoles: [...SU_ROLES, 'release-fixer'],
  rolesQuota: { operator: { perRun: 20 } },
  guidance: {
    when:
      'You fixed a gate red on staging (git-sync committed it) and need it on the judged sha — admit{paths} naming exactly the files you changed. Or a release read reports repair-in-progress, a fossil/blocked queue, or a definitely-dead fixer.',
    notWhen:
      'Do not pass harness or workspace: workspace-global, target derived internally. admit is path-exact — never name paths you did not fix to "catch up" to the tip. Never retire a live/unknown fixer, an active dispatch reservation, ready-to-verify work, or merely to make the gate move. Never re-cut a fresh candidate for a phantom red. Does not launch a checkpoint or deploy.',
    chaining:
      'Landing a fix: admit{paths} (dry run) → verdict would-admit + proof → re-call confirm:true → admitted, phase ready-to-verify; the gate re-verifies at the new repairHead next tick. Retiring: get → verify exact identity + retireAllowed → retire with those fields and confirm:true.',
    returns:
      "get: explicit repairQueueRead value|absent|unreadable plus phase/age/fixer/reservation/decision diagnostics and callerAuthorization (a signed release-fixer is delegated only when its spawn id exactly equals repairQueue.fixerSpawnId). An unreadable persisted row renders in-band and admit/retire refuse with repair-queue-unreadable. admit verdicts: no-frozen-queue (nothing frozen — an ordinary staging commit is already the judged lineage) | already-admitted (every named path already has its staging content on repairHead; idempotent) | would-admit (dry run: the commit was built and PROVED but not published — proof.diff is the exact diff-tree name set, proof.unchanged the allowlisted paths with no change, proof.blobs the source blob per path) | admitted (repairHead moved to movedRepairHead.to; persisted, phase ready-to-verify) | refused with reason: paths_required | invalid-paths | stray-paths (the built commit touched paths outside your allowlist — never published) | lineage-ref-moved (a concurrent admission won; re-read and admit onto the current repairHead) | source-unresolvable / repair-head-unresolvable / git-failed | persist_failed (the lineage ref was rolled back so ref and row still agree). containment[] reports, per requested path, whether the judged sha carries staging's current content — equal blobs prove that PATH is current, NOT that the candidate is. retire: refuses a live/unknown fixer and an active dispatch reservation; a CAS miss returns casMiss with the post-write diagnostic under current.",
    seeAlso: ['release:deploy', 'dev:pipeline_position', 'release:trace'],
  },
  args: argsSchema,
  result: z
    .object({
      ok: z.boolean().optional(),
      op: z.enum(['get', 'admit', 'retire']).optional(),
      target: z.unknown().optional(),
      repairQueue: z.unknown().nullable().optional(),
      repairQueueRead: z.unknown().optional(),
      callerAuthorization: z.unknown().optional(),
      verdict: z.string().optional(),
      admitted: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      judgedSha: z.string().nullable().optional(),
      source: z.unknown().optional(),
      nextAction: z.unknown().nullable().optional(),
      containment: z.unknown().nullable().optional(),
      proof: z.unknown().optional(),
      admission: z.unknown().optional(),
      lineageRef: z.string().optional(),
      wouldMoveRepairHead: z.unknown().optional(),
      movedRepairHead: z.unknown().optional(),
      persisted: z.boolean().optional(),
      auditRecorded: z.boolean().optional(),
      note: z.string().optional(),
      reason: z.string().optional(),
      detail: z.string().optional(),
      stray: z.array(z.string()).optional(),
      retired: z.boolean().optional(),
      // WI-1105109: the post-retire procedure statement. Declared rather than left to
      // .passthrough() so it is part of the contract a test can pin.
      nextStep: z.string().optional(),
      alreadyClear: z.boolean().optional(),
      refused: z.boolean().optional(),
      casMiss: z.boolean().optional(),
      current: z.unknown().nullable().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const inspected = await inspectQueue();
    const compactRead = inspected.read.status === 'value'
      ? { status: 'value' as const, schemaVersion: inspected.read.queue.schemaVersion }
      : inspected.read;
    const renderedQueue = inspected.read.status === 'unreadable'
      ? inspected.read
      : inspected.diagnostic;
    const callerAuthorization: FrozenRepairFixerAuthorization =
      inspected.read.status === 'unreadable'
        ? {
            status: 'queue-unreadable',
            authorized: false,
            callerSpawnId: typeof ctx.spawnId === 'string' && ctx.spawnId.trim() ? ctx.spawnId.trim() : null,
            queueFixerSpawnId: null,
            safeAction:
              `STOP: ${describeUnreadableFrozenCandidateRepairQueue(inspected.read)}. ` +
              'Do not infer that the queue is clear; use a reader that understands this schema.',
          }
        : assessFrozenRepairFixerAuthorization(inspected.queue, {
            role: ctx.role,
            spawnId: ctx.spawnId,
            sigVerifiedSpawn: ctx.sigVerifiedSpawn,
            isSuperuser: ctx.isSuperuser,
          });
    if (args.op === 'get') {
      return json({
        ok: true,
        op: 'get',
        target: inspected.target,
        repairQueue: renderedQueue,
        repairQueueRead: compactRead,
        callerAuthorization,
      });
    }
    if (inspected.read.status === 'unreadable') {
      const op = args.op === 'retire' ? 'retire' : 'admit';
      return json({
        ok: false,
        op,
        ...(op === 'retire' ? { retired: false } : { admitted: false }),
        refused: true,
        verdict: 'refused',
        reason: 'repair-queue-unreadable',
        detail:
          `${describeUnreadableFrozenCandidateRepairQueue(inspected.read)}; ` +
          'no queue mutation or moving-tip fallback was attempted',
        target: inspected.target,
        repairQueue: inspected.read,
        repairQueueRead: compactRead,
        callerAuthorization,
      });
    }
    if (args.op === 'admit' || args.op === 'converge') {
      const root = integrationRoot();
      const branch = integrationBranch();
      const queue = inspected.queue;
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string' && p.trim()) : [];
      const base = {
        op: 'admit' as const,
        target: inspected.target,
        source: { ref: branch, root },
        repairQueue: inspected.diagnostic,
        repairQueueRead: compactRead,
        callerAuthorization,
      };
      if (!queue) {
        return json({
          ok: true,
          admitted: false,
          verdict: 'no-frozen-queue',
          judgedSha: null,
          containment: null,
          nextAction:
            'No frozen repair queue. Fix on staging as normal — git-sync commits it and the next ' +
            'candidate is cut from that tip. Do not fire release:checkpoint-run.',
          ...base,
        });
      }
      const containmentAt = (judgedSha: string) =>
        paths.length ? containmentForPaths(paths, judgedSha, root, undefined, branch) : null;
      if (paths.length === 0) {
        return json({
          ok: false,
          admitted: false,
          refused: true,
          verdict: 'refused',
          reason: 'paths_required',
          detail:
            'admit is by explicit path allowlist: name exactly the repo-relative files your fix changed. ' +
            'Nothing is ever admitted by tip, branch or "everything since the candidate".',
          judgedSha: queue.repairHead,
          containment: null,
          ...base,
        });
      }
      // EI-22208176411693669: assessFrozenRepairFixerAuthorization above already routes
      // an isSuperuser caller to 'not-applicable' (never 'authorized-delegate') because
      // the SU-bearer transport carries no verified per-spawn signature regardless of its
      // cosmetic ?role= catalog hint. Without this clause a superuser caller whose ?role=
      // was forwarded as 'release-fixer' would still fail every disjunct here (role!=='su',
      // not an OPERATOR_CONFIG_WRITE_ROLE, authorized!==true) and be wrongly thrown out of
      // admission — even though dispatch capability on that transport is already
      // unconditional (isSuperuser bypasses role gates platform-wide, per
      // tool-projection.ts). Mirror that bypass here explicitly.
      if (
        ctx.role !== 'su' &&
        !isOperatorConfigWriteRole(ctx.role) &&
        ctx.isSuperuser !== true &&
        callerAuthorization.authorized !== true
      ) {
        throw new Error(
          'release:repair-queue admit requires operator, architect, mug, su, or the exact signed release-fixer delegated by this queue',
        );
      }
      const identity = readIdentity(ctx);
      const dryRun = args.confirm !== true;
      const outcome = admitPathsOntoRepairHead({
        root,
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        paths,
        source: { ref: branch },
        actor: identity.ownerId,
        reason: args.reason,
        nowMs: Date.now(),
        dryRun,
      });
      if (!outcome.ok) {
        if (outcome.code === 'nothing-to-admit') {
          return json({
            ok: true,
            admitted: false,
            dryRun,
            verdict: 'already-admitted',
            detail: outcome.detail,
            judgedSha: queue.repairHead,
            containment: containmentAt(queue.repairHead),
            ...base,
          });
        }
        return json({
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          reason: outcome.code,
          detail: outcome.detail,
          ...(outcome.stray ? { stray: outcome.stray } : {}),
          ...(outcome.paths ? { invalidPaths: outcome.paths } : {}),
          ...(outcome.step ? { step: outcome.step } : {}),
          judgedSha: queue.repairHead,
          containment: containmentAt(queue.repairHead),
          ...base,
        });
      }
      const proof = { diff: outcome.diff, unchanged: outcome.unchanged, blobs: outcome.entry.blobs, tree: outcome.tree };
      if (dryRun) {
        return json({
          ok: true,
          admitted: false,
          dryRun: true,
          verdict: 'would-admit',
          judgedSha: queue.repairHead,
          wouldMoveRepairHead: { from: queue.repairHead, to: outcome.commit },
          lineageRef: outcome.lineageRef,
          proof,
          containment: containmentAt(queue.repairHead),
          note:
            `Pass confirm:true to publish admission ${outcome.commit.slice(0, 12)} onto ${outcome.lineageRef} ` +
            'and advance repairHead to it (phase ready-to-verify). The immutable candidate is never touched; ' +
            'the commit carries exactly proof.diff and nothing else from the tip.',
          ...base,
        });
      }
      // Published: the lineage ref now points at the admission. The queue row is the second
      // store; if it cannot be written, retract the ref so the two never disagree.
      let next: FrozenCandidateRepairQueue;
      try {
        next = markFrozenRepairAdmitted(queue, outcome.entry);
      } catch (err) {
        const retracted = retractAdmission({
          root,
          candidate: queue.candidate,
          published: outcome.commit,
          previousRepairHead: queue.repairHead,
        });
        return json({
          ok: false,
          admitted: false,
          refused: true,
          verdict: 'refused',
          reason: 'lineage-ref-moved',
          detail: `${(err as Error).message}${retracted ? ' (lineage ref retracted)' : ' (lineage ref could NOT be retracted — it is at the unrecorded admission; re-read the queue)'}`,
          judgedSha: queue.repairHead,
          containment: containmentAt(queue.repairHead),
          ...base,
        });
      }
      let persisted = true;
      try {
        await writeFrozenCandidateRepairQueue(inspected.target, next);
      } catch {
        persisted = false;
      }
      let retracted: boolean | null = null;
      if (!persisted) {
        retracted = retractAdmission({
          root,
          candidate: queue.candidate,
          published: outcome.commit,
          previousRepairHead: queue.repairHead,
        });
      }
      const auditRecorded = await recordAudit(identity.ownerId, {
        op: 'admit',
        reason: args.reason ?? null,
        candidate: queue.candidate,
        from: queue.repairHead,
        to: outcome.commit,
        source: outcome.entry.source,
        paths: outcome.entry.paths,
        unchanged: outcome.entry.unchanged,
        persisted,
        ...(retracted === null ? {} : { retracted }),
      });
      const judgedSha = persisted ? outcome.commit : queue.repairHead;
      return json({
        ok: persisted,
        admitted: persisted,
        dryRun: false,
        verdict: persisted ? 'admitted' : 'refused',
        judgedSha,
        movedRepairHead: { from: queue.repairHead, to: outcome.commit },
        lineageRef: outcome.lineageRef,
        proof,
        admission: outcome.entry,
        containment: containmentAt(judgedSha),
        persisted,
        auditRecorded,
        ...base,
        repairQueue: persisted
          ? diagnoseFrozenCandidateRepairQueue(next, { nowMs: Date.now(), fixerAlive: inspected.fixerAlive })
          : inspected.diagnostic,
        ...(persisted
          ? {
              nextAction:
                `repairHead is ${outcome.commit.slice(0, 12)} (phase ${next.phase}); the gate re-verifies at that head on its next tick. ` +
                'Do NOT fire release:checkpoint-run and do NOT retire.',
            }
          : {
              refused: true,
              reason: 'persist_failed',
              note: retracted
                ? 'The queue row could not be written, so the lineage ref was retracted to the previous repairHead; nothing moved. Re-run.'
                : 'The queue row could not be written AND the lineage ref could not be retracted: the ref is at the admission but the row is not. Re-read the queue before relying on the judged sha.',
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
    // A broad liveness read can fail-soft to `null` while the exact terminal pair is still
    // durable. Let the transaction-scoped retire helper recheck that case; keep the other safety
    // refusals (live fixer, active reservation, unsafe phase) fail-closed at the read boundary.
    if (
      !inspected.diagnostic.retireAllowed &&
      inspected.diagnostic.retireRefusal !== 'liveness-unknown'
    ) {
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
    const currentFixerAlive =
      result.fixerAlive !== undefined ? result.fixerAlive : await inspectFixerLiveness(result.current);
    const currentDiagnostic = result.current
      ? diagnoseFrozenCandidateRepairQueue(result.current, {
          nowMs: Date.now(),
          fixerAlive: currentFixerAlive,
        })
      : null;
    // The transaction may refuse after taking the routine-row lock because its authoritative
    // liveness/identity differs from the preflight read. This is a safety refusal, not a storage
    // CAS miss, and must remain visible as such so callers do not retry a live/unknown fixer.
    if (!result.retired && result.refusal && result.refusal !== 'identity-mismatch') {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: result.refusal,
        target: inspected.target,
        repairQueue: currentDiagnostic,
      });
    }
    if (!result.retired && result.refusal === 'identity-mismatch') {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: 'exact_queue_identity_mismatch',
        target: inspected.target,
        repairQueue: currentDiagnostic,
      });
    }
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
      current: currentDiagnostic,
      // WI-1105109 [owner 2026-08-30, OWNER-interactive]: "make sure another agent
      // uses the frozen candidate system next and doesn't retire it like you did".
      //
      // A SUCCESSFUL retire is the exact moment the treadmill restarts. The recorded
      // failure was not the retire — that one was correct — it was firing
      // release:checkpoint-run TWICE immediately afterwards, each cutting a FRESH
      // candidate at tip. `notWhen` already forbids retiring "merely to make the gate
      // move", but guidance is read BEFORE the call and the mistake happens AFTER it,
      // so the answer has to travel on the RESULT the caller is holding when they
      // choose their next move.
      nextStep: result.retired
        ? 'The next scheduled green-checkpoint run RE-FREEZES a candidate on its own — retiring does not stall the gate, so nothing needs firing to restart it. Do NOT call release:checkpoint-run to make the gate move: it always cuts a FRESH candidate at the current tip, which is the pre-D-001 re-cut-at-tip treadmill D-007 diagnosed (each cut re-admits the whole sweep and imports breakage faster than fixes land). To land a fix on the judged lineage, use release:repair-queue { op: "admit", paths: [...] }.'
        : undefined,
    });
  },
});
