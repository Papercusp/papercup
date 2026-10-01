/**
 * cupboard:ledger-chain — verify or export a pot's hash-chained governance
 * ledger (agent-economy-flywheel-2026-08-30 P-040). Read-only; chaining stragglers
 * is cupboard:ledger-chain-witness. The Cupboard D1 commerce + treasury streams
 * are verified through the Worker's operator routes (/admin/ledger-chain/*).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:ledger-chain',
  capability: 'harness:read',
  description:
    "Verify or export a pot's hash-chained plan-admission governance ledger. `verify` recomputes the chain against the stored events and names the FIRST broken position (an edited, deleted or spliced entry) plus entries not yet chained; pass `expectedHead` from an earlier export to also detect truncation. `export` returns the stable JSONL chain that verifies offline (`npx tsx libs/generic/hash-chain/src/verify-main.ts`).",
  guidance: {
    when: "You need proof a pot's governance history was not altered, or a portable copy of that proof.",
    notWhen: 'Chaining entries that verify reports as unchained (cupboard:ledger-chain-witness).',
    chaining: '`ok:false` with `verdict.ok:true` means only unchained entries; a `verdict.firstBreak` is tampering.',
    seeAlso: ['cupboard:ledger-chain-witness'],
  },
  args: z.object({
    op: z.enum(['verify', 'export']),
    pot: z.string().min(1).max(200).describe("The pot's home slug."),
    expectedHead: z
      .object({ seq: z.number().int().min(0), entryHash: z.string().regex(/^[0-9a-f]{64}$/) })
      .optional()
      .describe('verify only: a head saved from an earlier export.'),
  }),
  async handler(args, ctx) {
    const [{ activeWorkspaceId }, store, chain] = await Promise.all([
      import('../../workspace-registry'),
      import('../plans/plan-admission-governance-store'),
      import('../../cupboard/ledger-chain'),
    ]);
    const workspaceId = ctx?.principal?.workspaceId ?? activeWorkspaceId();
    const source = await store.planAdmissionGovernanceLedgerSource({ workspaceId, potHomeSlug: args.pot });
    const links = chain.pgLedgerChainLinkStore();
    if (args.op === 'export') {
      return text({ ok: true, streamId: source.streamId, export: await chain.exportLedger(workspaceId, source, links) });
    }
    const report = await chain.verifyLedger(workspaceId, source, links, {
      ...(args.expectedHead ? { expectedHead: args.expectedHead } : {}),
    });
    return text({ ...report });
  },
});
