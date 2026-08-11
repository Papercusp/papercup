/**
 * p2p:trace — assemble the cross-machine P2P timeline
 * (p2p-work-distribution-2026-07-02 P-004, M21).
 *
 * SKELETON scope (P-004): the receipt timeline + the M15 refused-op counter
 * snapshot. Every receipt row federates (mig 468), so this ONE tool run on ANY
 * member machine sees BOTH sides' receipts for an offer — the origin column
 * says which rows were authored locally vs applied from a peer. As the offer
 * lifecycle lands (P-102 signed offers, P-103 puller, P-106 reaping), their
 * events join this timeline keyed by the SAME offer_id (M21: the offer-id
 * threads through every receipt/audit/log line on both sides).
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { listP2pReceipts, listRefusedOpCounters } from '../../p2p/receipts';
import { resolveP2pGrantWorkspace } from '../../p2p/grant-store';
import { resolveDelegatedSpawnOutcome } from '../../p2p/delegated-spawn-outcome-resolve';

export default defineTool({
  name: 'p2p:trace',
  profile: 'engineer',
  description:
    "Assemble the cross-machine P2P timeline for a pot (optionally one offer): receipts from BOTH sides (federated p2p_receipts facts, M21 offer-id threaded) + the local M15 refused-op counter snapshot. Read `kind`: 'refusal' is a refused action (carries refusalCode/missing); 'excused-breach' is a preemption-class interruption (X8), excluded from reliability signals; 'honored' is a SUCCESS fact, NOT a failure. Current D-029 honored receipts prove a post-start tool-backed first turn and synthesize `honored-first-turn-proven`; legacy launch-only receipts remain `honored-unverified`. No 'honored' receipt is ambiguous, not failed: the peer may predate that kind (EI-19333624101736074). With `offerId` on a delegated SPAWN request you also get `spawnRequestOutcome`, the synthesized verdict; `memberEvidenceAvailable:false` makes `indeterminate` mean \"unknowable from here\", never \"nobody honored it\".",
  guidance: {
    when: 'Debugging a refused/silent-looking cross-peer action ("why did my offer/wake/spawn not run on peer X?"): pass the pot (and offerId when you have one) to see every receipt both sides produced, ordered by event time, plus the unauthenticated-refusal counters. The receipt names the EXACT missing capability/budget.',
    notWhen:
      'Inspecting grant STATE (who may do what right now) — read the grants surface / checkP2pCapability instead; trace is the event TIMELINE, not the authorization table. General coord message history — coord:feed / coord:catch-up.',
    chaining: 'p2p:trace (you) → fix the named gap (grant a capability, raise a cap, re-attest a device) → retry the action.',
    seeAlso: ['audit:list (the local audit rows the receipts also land in)'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120, describe: 'the pot HOME slug whose P2P timeline to read' }),
    offerId: z
      .string()
      .min(1)
      .optional()
      .describe('M21 thread key — restrict the timeline to one offer lifecycle'),
    limit: z.number().int().positive().max(500).optional().describe('max receipts (default 100)'),
  }),
  async handler(args, ctx) {
    const json = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    });
    const ident = resolveAgentIdentity(ctx);
    const ws = resolveP2pGrantWorkspace(ident.workspaceId);
    if (!ws) {
      return json({
        ok: false,
        error: 'workspace_unresolved',
        detail:
          "p2p:trace needs a concrete workspace partition (WI-1564) — an un-scoped session can't name which hive-home partition to read. Re-run from a workspace-scoped session or pass a scoped identity.",
      });
    }
    const [receipts, counters, spawnOutcome] = await Promise.all([
      listP2pReceipts({ workspaceId: ws, potSlug: args.pot, offerId: args.offerId ?? null, limit: args.limit }),
      listRefusedOpCounters({ workspaceId: ws, potSlug: args.pot }),
      // WI-7042: the SYNTHESIZED verdict, only meaningful for one offer's
      // lifecycle. Best-effort: this is an enrichment on a debugging read, so a
      // failure here must degrade to the raw timeline (which is still the whole
      // pre-WI-7042 value of the tool) rather than fail the call.
      args.offerId
        ? resolveDelegatedSpawnOutcome({
            workspaceId: ws,
            potSlug: args.pot,
            offerId: args.offerId,
          }).catch((err) => {
            console.error(`[p2p:trace] spawn-outcome reconciliation failed for ${args.offerId}:`, err);
            return null;
          })
        : Promise.resolve(null),
    ]);
    return json({
      ok: true,
      pot: args.pot,
      offerId: args.offerId ?? null,
      // Ascending event time when tracing one offer (a lifecycle reads forward);
      // listP2pReceipts already orders ASC for offerId reads, DESC otherwise.
      receipts: receipts.map((r) => ({
        ts: r.receiptTs,
        kind: r.kind,
        action: r.action,
        offerId: r.offerId,
        refusalCode: r.refusalCode,
        missing: r.missingCapability,
        budgetAxis: r.budgetAxis,
        requester: r.requesterKind ? `${r.requesterKind}:${r.requesterRef}` : null,
        responder: r.responderGithubUserId,
        origin: r.origin,
        detail: r.detail,
        receiptId: r.receiptId,
      })),
      // M15: unauthenticated refusals have no receipt — the counters are their
      // only trace. reason format: '<surface>:<reason>' (e.g. 'grant-apply:grantor_mismatch').
      refusedOpCounters: counters,
      // WI-7042: present ONLY when `offerId` names a delegated spawn request.
      // Absent for a seat/work offer or an unknown id — there is genuinely no
      // spawn outcome for those, and an error-shaped field would read as a
      // finding. `memberEvidenceAvailable:false` is the honest caveat, not a
      // fault: for a REMOTE honor this host holds no member evidence at all, so
      // `indeterminate` means "unknowable from here", never "nobody honored it".
      spawnRequestOutcome: spawnOutcome
        ? {
            verdict: spawnOutcome.outcome.verdict,
            detail: spawnOutcome.outcome.detail,
            attribution: spawnOutcome.outcome.attribution,
            members: spawnOutcome.outcome.members,
            shortfall: spawnOutcome.outcome.shortfall,
            refusalCode: spawnOutcome.outcome.refusalCode,
            actionable: spawnOutcome.outcome.actionable,
            fleetSlug: spawnOutcome.request.fleetSlug,
            requestedSeats: spawnOutcome.request.count,
            requestedAtMs: spawnOutcome.request.requestedAtMs,
            targetOfferId: spawnOutcome.targetOfferId,
            honoringDevicePubkey: spawnOutcome.honoringDevicePubkey,
            memberEvidenceAvailable: spawnOutcome.memberEvidenceAvailable,
            concurrentRequests: spawnOutcome.concurrentRequests,
            requesterOwnerId: spawnOutcome.requesterOwnerId,
            planSlug: spawnOutcome.planSlug,
          }
        : undefined,
      note:
        receipts.length === 0 && counters.length === 0
          ? 'no P2P receipts or refused-op counters for this scope — either nothing was refused, or the action predates mig 468.'
          : undefined,
    });
  },
});
