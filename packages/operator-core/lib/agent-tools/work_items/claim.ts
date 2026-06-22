/**
 * work_items:claim — Claimable (D-003). Assigns the work-item to an agent
 * (feature-family → taken_by; issue-family → assignee) and subscribes the claimer.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): claim ONE inline
 * ({ id, assignee? }), MANY for the SAME assignee (ids:[…] + assignee?), or MANY
 * heterogeneous (items:[{ id, assignee?, harness? }]) → { ok, results:[{ ok, id,
 * workItem? | error… }], counts }. Each result self-describes its id; a
 * claim_conflict on one item never fails the rest (top-level ok = "the batch ran",
 * counts.failed is the truth — D-005). The claim lifecycle emit fires per claimed
 * item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { claimWorkItem, classifyClaimFailure, getWorkItem } from '../../work-items';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

interface ClaimItem {
  id: string;
  assignee?: string;
  harness?: string;
}

/**
 * Claim ONE item, returning the self-describing result. On the compare-and-claim
 * loss, re-read + classify (EI-2197) so the agent gets an accurate, actionable
 * error (claim_conflict + holder, not_found, or not_claimable) rather than a
 * phantom "not found".
 */
async function claimOne(it: ClaimItem, claimerDefault: string): Promise<BulkItemResult> {
  const claimer = it.assignee ?? claimerDefault;
  const workItem = await claimWorkItem(it.id, claimer, { harness: it.harness });
  if (workItem) return { ok: true, id: it.id, workItem };
  // claimWorkItem returns a bare null for THREE distinct outcomes — re-read + classify.
  const current = await getWorkItem(it.id, it.harness);
  const failure = classifyClaimFailure(current, claimer);
  if (failure.reason === 'not_found') {
    return { ok: false, id: it.id, error: `work_item '${it.id}' not found` };
  }
  if (failure.reason === 'conflict') {
    return {
      ok: false,
      id: it.id,
      error: 'claim_conflict',
      holder: failure.holder,
      workItem: current,
      hint: `Already claimed by ${failure.holder} — the item exists (get/observe/comment/complete resolve it). Coordinate with the holder via coord:send, or pick another item; if that agent is dead, the stale-claim reclaim lane frees it. Do not blind-retry with a different harness.`,
    };
  }
  return {
    ok: false,
    id: it.id,
    error: 'not_claimable',
    workItem: current,
    hint: 'Item exists but the claim was refused by a trust/admission gate, or it was released between the claim and this re-read — re-check with work_items:get / work_items:observe.',
  };
}

export default defineTool({
  name: 'work_items:claim',
  profile: 'engineer',
  description:
    'Claim one OR many work-items (assign to yourself, or to `assignee`). Claiming a feature sets taken_by; an issue sets assignee. Single: { id, assignee? }. Many same assignee: { ids:[…], assignee? }. Many heterogeneous: items:[{ id, assignee?, harness? }]. Returns { ok, results:[{ ok, id, workItem? | error, holder? }], counts } — correlate by id; a claim_conflict on one item never fails the rest.',
  guidance: {
    when: 'You are starting work on work-item(s) — claim so peers do not duplicate. Claim a swath at once via { ids:[…] }.',
    notWhen: 'A per-item `claim_conflict` means a LIVE peer holds it — coordinate with the `holder` (coord:send) or pick another item; do not blind-retry. (If the holder is dead, the stale-claim reclaim lane frees it.)',
    chaining: 'work_items:list → work_items:claim → work_items:set_state → work_items:release/close.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-claim shorthand: the work-item id'),
      assignee: z.string().max(120).optional().describe('default: you. Applies to the inline id / every id in `ids`.'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('claim MANY items for the same `assignee` (homogeneous)'),
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            assignee: z.string().max(120).optional(),
            harness: z.string().max(80).optional(),
          }),
        )
        .min(1)
        .max(200)
        .optional()
        .describe('claim many work-items at once — each { id, assignee?, harness? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list: ClaimItem[] = args.items?.length
      ? args.items.map((it) => ({ id: it.id, assignee: it.assignee ?? args.assignee, harness: it.harness ?? args.harness }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, assignee: args.assignee, harness: args.harness }))
        : [{ id: args.id as string, assignee: args.assignee, harness: args.harness }];
    const env = await runBulk(list, (it) => claimOne(it, ident.ownerId), { keyOf: (it) => ({ id: it.id }) });
    return bulkContent(env);
  },
});
