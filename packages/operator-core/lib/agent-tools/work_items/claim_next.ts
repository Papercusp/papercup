/**
 * work_items:claim_next — self-selection over central assignment (D-004 / D-007).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The tuple-space associative `in`:
 * atomically claim the OLDEST unclaimed work-item in a harness via SELECT … FOR UPDATE
 * SKIP LOCKED. Competing idle agents each grab a different item (no double-claim), and
 * oldest-first steals the most-starved tail of the queue. Leaning to self-selection
 * (the Oct-2025 LLM-blackboard result: +13–57% task success) — named assignment stays
 * the deliberate exception (work_items:claim with an explicit assignee).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  CLAIM_STATES_ALLOWLIST,
  claimNextWorkItem,
  releaseWorkItem,
  diagnoseClaimNextMiss,
} from '../../work-items';
import { workItemClaimLeaseEnabled, leaseClaimedWorkItem } from '../../work-item-claim-lease-wiring';
import { workItemRedundancyEnabled } from '../../work-item-redundancy';
import { localSwarmId } from '../../fleet/swarm-identity';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'work_items:claim_next',
  profile: 'engineer',
  description:
    'Self-select: atomically claim the OLDEST unclaimed work-item in a harness (tuple-space `in` via SKIP LOCKED + work-stealing). Competing agents never double-claim. Returns the claimed item, or on a miss a SELF-DESCRIBING result: `{ ok:false, drained, pendingUnclaimed, readyUnclaimed, error }`. drained:true ⇒ the queue is genuinely empty (idle is correct); drained:false ⇒ unclaimed items EXIST but are gated out of self-select (blocked / affinity-elsewhere / redundant / just-raced) — do NOT idle.',
  guidance: {
    when: 'You are an idle agent picking up work — prefer this self-selection over waiting to be assigned. Returns the oldest claimable feature-family item, now yours.',
    notWhen: 'When a SPECIFIC item must go to a SPECIFIC agent — that is work_items:claim with an explicit assignee (named assignment, the exception — it deliberately bypasses the status/readiness floors self-select enforces, so an item claimable by id can still legitimately miss here).',
    chaining: 'work_items:claim_next → work_items:set_state → work_items:release. On a MISS, read `drained`: drained:true means the queue is empty (message leader + idle); drained:false means work exists but is currently blocked/gated (pendingUnclaimed>0) — do NOT idle, re-check shortly or help unblock the backlog rather than reporting the queue drained.',
    // EI-6981: this self-selects the OLDEST unclaimed item HARNESS-WIDE, not just your
    // fleet/plan — a peer's "solo takeover" of an item they haven't formally
    // work_items:claim'd (declared only in a coord message / the item's own summary
    // prose, assignee field still empty/stale) is INVISIBLE to this atomic claim and can
    // get self-selected out from under them (observed live: WI-1729). Before acting on a
    // freshly-claimed item, skim its title/summary for an existing "taken over by <owner>"
    // / "solo takeover" note — if you find one, work_items:release it immediately rather
    // than proceeding, and prefer a narrower harness/kind filter (or a leader-set
    // claim-spec / scheduler:get_next) when you know you're one of several fleets sharing
    // one harness.
    seeAlso: [
      'work_items:claim (by-id / named-assignee claim — the exception to self-select)',
      'work_items:list (on a drained:false miss, see which items are blocked/gated)',
      'work_items:set_state (advance the item you just claimed)',
    ],
  },
  capability: 'work_items:write',
  // tool-call-batching-wrappers-2026-06-21 P-011 — composite marker: atomic self-select
  // replaces a manual work_items:claim (find-oldest + claim, race-free).
  replaces: ['work_items:claim'],
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1),
    kind: z.enum(['feature', 'research-task', 'chunk']).optional(),
    assignee: z.string().max(120).optional().describe('default: you'),
    // WI-1912: clamped to the claimable allowlist — same wall as scheduler:get_next; a
    // free-string `states` let a caller widen past the resolver-owned blocked/cursed floors.
    states: z
      .array(z.enum(CLAIM_STATES_ALLOWLIST as unknown as [string, ...string[]]))
      .max(20)
      .optional()
      .describe(
        "claimable states — subset of ['todo','open','failing'] (default ['todo']). 'blocked'/'cursed' are resolver-owned floors (blocked items are leader-triage-only) and terminal states are settled — neither is requestable (D-002 / WI-1912).",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe(
        'How many of the OLDEST unclaimed items to claim (default 1, max 25). >1 loops the same race-free SKIP-LOCKED claim path N times, stopping at the first miss — so you may get FEWER than `count` when the queue runs dry. count>1 returns { ok, claimed: [...] }; omitted/1 keeps the single-item { ok, workItem } shape (backward-compatible).',
      ),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const assignee = args.assignee ?? ident.ownerId;
    // P-002 co-location lever: under the per-Hive claim lease, honor each item's
    // swarm_affinity by passing THIS Swarm's id — the claim then skips work affined to
    // another Swarm and prefers work affined to us. Flag OFF (default) ⇒ swarmId omitted
    // ⇒ affinity-blind, claim is byte-identical to before.
    const leaseOn = workItemClaimLeaseEnabled();
    const swarmId = leaseOn ? localSwarmId(activeWorkspaceId(), args.harness) : undefined;
    // P-014: under the redundancy flag, skip high-stakes items here — they fan out to N
    // Swarms via work_items:claim_replica, not an exactly-once claim. Flag OFF ⇒ omitted.
    const excludeRedundant = workItemRedundancyEnabled();

    // EI-6480: when claimOne claims a row locally but LOSES the per-Hive authority lease, the
    // item is released back to the pool yet the lease-arbitration loss is invisible to the miss
    // diagnosis — which then misreports it as a peer race ("retry"). A stale lease surviving a
    // non-terminal release (the reaper / issue-requeue path) keeps the item reading as unclaimed
    // while it fails arbitration for everyone but its dead prior owner. Capture the last such loss
    // so missResult can name it truthfully. Observability ONLY — no claim/release-semantics change.
    let lastLeaseLoss: { id: string } | null = null;
    /** One race-free claim (the existing path) incl. the cross-Swarm lease arbitration.
     *  Returns the claimed item, or null when nothing was (or could be) claimed. */
    const claimOne = async () => {
      const wi = await claimNextWorkItem({
        harness: args.harness,
        assignee,
        kind: args.kind,
        states: args.states,
        swarmId,
        excludeRedundant,
      });
      // P-004 / D-002 (D-007 hybrid), flag-gated default-OFF: once the owner ratifies
      // (the WORKITEM_CLAIM_LEASE flag), the local SKIP-LOCKED claim is arbitrated by
      // the per-Hive authority lease. On a single box this is a no-op (authority = self);
      // cross-Swarm, only one Swarm wins the Hive lease — the loser releases its local
      // claim so the item returns to the backlog (work-stealing across machines).
      if (wi && leaseOn) {
        const leased = await leaseClaimedWorkItem({ harness: args.harness, workItemId: wi.id, owner: assignee });
        if (!leased) {
          await releaseWorkItem(wi.id, { harness: args.harness });
          lastLeaseLoss = { id: wi.id }; // EI-6480: record the arbitration loss for a truthful miss
          return null;
        }
      }
      return wi;
    };

    /** EI-5919: a bare null CONFLATES "queue drained" with "items exist but none are
     *  self-selectable now" (blocked / affinity-elsewhere / redundant / just-claimed). A bee
     *  reading "no claimable work-item" then idles on a FULL-but-blocked backlog (the EI-5803
     *  "fleet saturated with work still queued" signal). On a miss we run a read-only diagnosis
     *  and return a SELF-DESCRIBING result so the caller distinguishes drained (idle is correct)
     *  from pending-but-gated (do NOT idle). Self-select being stricter than a NAMED
     *  work_items:claim(id) is BY DESIGN — the named claim bypasses the status/readiness floors. */
    const missResult = async () => {
      const diag = await diagnoseClaimNextMiss({
        harness: args.harness,
        assignee,
        kind: args.kind,
        states: args.states,
        swarmId,
        excludeRedundant,
      });
      // EI-6480: a lease-ARBITRATION loss is NOT a peer race. When claimOne claimed a row
      // locally but lost the per-Hive authority lease, the misleading 'retry' hint sent callers
      // into a busy-idle against an item that keeps reading unclaimed until the stale lease is
      // cleaned up (the reaper/issue-requeue lease-cleanup fix) or lapses. Name it truthfully so
      // the miss is DISTINGUISHABLE from a genuine race.
      if (lastLeaseLoss) {
        return {
          ok: false as const,
          error:
            `no claimable work-item RIGHT NOW: you claimed item ${lastLeaseLoss.id} locally but LOST the ` +
            `per-Hive authority-lease ARBITRATION for it (held by another owner's unexpired lease — the ` +
            `EI-6480 stale-lease class). It will keep reading as unclaimed until that lease is cleaned up ` +
            `or lapses, so a blind retry may not help. ${diag.readyUnclaimed} ready / ${diag.pendingUnclaimed} ` +
            `unclaimed pending — NOT a peer race and NOT drained; surface this rather than spin.`,
          drained: diag.drained,
          pendingUnclaimed: diag.pendingUnclaimed,
          readyUnclaimed: diag.readyUnclaimed,
          leaseArbitrationLoss: true as const,
        };
      }
      const error = diag.drained
        ? 'no claimable work-item: queue DRAINED (no unclaimed work in a claimable state for this harness) — idling is correct'
        : `no claimable work-item RIGHT NOW: ${diag.pendingUnclaimed} unclaimed item(s) exist but are gated out of self-select (blocked / affinity-elsewhere / redundant / just-claimed)${diag.readyUnclaimed > 0 ? ` — ${diag.readyUnclaimed} are ready but a peer likely raced you (retry)` : ''}. The queue is NOT drained — do NOT idle; re-check shortly or unblock the backlog.`;
      return { ok: false as const, error, drained: diag.drained, pendingUnclaimed: diag.pendingUnclaimed, readyUnclaimed: diag.readyUnclaimed };
    };

    const count = args.count ?? 1;
    // Backward-compatible single-item shape when count is omitted/1.
    if (count === 1) {
      const wi = await claimOne();
      const result = wi ? { ok: true as const, workItem: wi } : await missResult();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    // count>1: loop the same atomic claim up to N times, STOPPING at the first miss
    // (queue dry / all leases lost) — each iteration claims a DIFFERENT oldest row
    // (SKIP LOCKED), so this batches a self-select sweep without a double-claim. Returns
    // an array (possibly shorter than `count`, possibly empty).
    const claimed = [];
    for (let i = 0; i < count; i += 1) {
      const wi = await claimOne();
      if (!wi) break;
      claimed.push(wi);
    }
    // EI-5919: on an EMPTY sweep, attach the same drained-vs-pending diagnosis so a batch
    // caller can also distinguish a truly-drained queue from a full-but-gated backlog.
    if (claimed.length === 0) {
      const miss = await missResult();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...miss, claimed }) }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, claimed }) }] };
  },
});
