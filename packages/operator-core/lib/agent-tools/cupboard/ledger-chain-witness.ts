/**
 * cupboard:ledger-chain-witness — chain a pot's governance events that have no
 * hash-chain link yet (agent-economy-flywheel-2026-08-30 P-040). Local appends
 * are witnessed automatically; this covers events that arrived from federated
 * peers and any append whose after-witness pass failed. Idempotent.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:ledger-chain-witness',
  capability: 'harness:write',
  description:
    "Append hash-chain links for a pot's plan-admission governance events that are not chained yet (peer-federated events, or a failed after-append pass), in fold order. Idempotent: a chained entry is never re-linked, and an edited entry stays flagged by verify rather than being re-chained.",
  guidance: {
    when: 'cupboard:ledger-chain verify reported unchainedCount > 0.',
    notWhen: 'Repairing a broken chain: a firstBreak is evidence of tampering and is not repairable by witnessing.',
    seeAlso: ['cupboard:ledger-chain'],
  },
  args: z.object({
    pot: z.string().min(1).max(200).describe("The pot's home slug."),
  }),
  async handler(args, ctx) {
    const [{ activeWorkspaceId }, store, chain] = await Promise.all([
      import('../../workspace-registry'),
      import('../plans/plan-admission-governance-store'),
      import('../../cupboard/ledger-chain'),
    ]);
    const workspaceId = ctx?.principal?.workspaceId ?? activeWorkspaceId();
    const source = await store.planAdmissionGovernanceLedgerSource({ workspaceId, potHomeSlug: args.pot });
    const result = await chain.witnessLedger(workspaceId, source, chain.pgLedgerChainLinkStore());
    return text({ ok: true, ...result });
  },
});
