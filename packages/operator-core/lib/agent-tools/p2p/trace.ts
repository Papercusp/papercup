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
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { listP2pReceipts, listRefusedOpCounters } from '../../p2p/receipts';
import { resolveP2pGrantWorkspace } from '../../p2p/grant-store';

export default defineTool({
  name: 'p2p:trace',
  profile: 'engineer',
  description:
    "Assemble the cross-machine P2P timeline for a pot (optionally one offer): loud-refusal receipts from BOTH sides (federated p2p_receipts facts, M21 offer-id threaded) + the local M15 refused-op counter snapshot. Receipts with kind='excused-breach' are preemption-class interruptions (X8) — excluded from reliability signals.",
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
    pot: z.string().min(1).describe('the pot HOME slug whose P2P timeline to read'),
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
    const [receipts, counters] = await Promise.all([
      listP2pReceipts({ workspaceId: ws, hiveSlug: args.pot, offerId: args.offerId ?? null, limit: args.limit }),
      listRefusedOpCounters({ workspaceId: ws, hiveSlug: args.pot }),
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
      note:
        receipts.length === 0 && counters.length === 0
          ? 'no P2P receipts or refused-op counters for this scope — either nothing was refused, or the action predates mig 468.'
          : undefined,
    });
  },
});
