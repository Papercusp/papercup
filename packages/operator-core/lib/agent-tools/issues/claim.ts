/**
 * issues:claim — take ownership of one OR many issues (Claimable,
 * engineer-issues-2026-06-03). The claimer is auto-subscribed; subscribers are
 * notified.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): claim ONE inline
 * ({ id, assignee? }), MANY for the SAME assignee (ids:[…] + assignee?), or MANY
 * heterogeneous (items:[{ id, assignee? }]) → { ok, results:[{ ok, id, issue? |
 * error… }], counts }. Each result self-describes its id; a claim_conflict on one
 * item never fails the rest (top-level ok = "the batch ran", counts.failed is the
 * truth).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { claimIssue, getIssue } from '../../issues-engineer';
import { classifyClaimFailure } from '../../work-items';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

interface ClaimItem {
  id: string;
  assignee?: string;
}

/**
 * Claim ONE issue, returning the self-describing result. On the compare-and-claim
 * loss, re-read + classify (EI-2197) so the agent gets an accurate, actionable
 * error (claim_conflict + holder, not_found, or not_claimable) rather than a
 * phantom "not found".
 */
async function claimOne(it: ClaimItem, claimerDefault: string): Promise<BulkItemResult> {
  const claimer = it.assignee ?? claimerDefault;
  const issue = await claimIssue(it.id, claimer);
  if (issue) return { ok: true, id: it.id, issue: { id: issue.id, assignee: issue.assignee, state: issue.state } };
  // claimIssue returns null both when the issue is absent AND when it exists but
  // is already held (compare-and-claim lost) — re-read + classify (EI-2197).
  const current = await getIssue(it.id);
  const failure = classifyClaimFailure(current, claimer);
  if (failure.reason === 'not_found') {
    return { ok: false, id: it.id, error: `issue '${it.id}' not found` };
  }
  if (failure.reason === 'conflict') {
    return {
      ok: false,
      id: it.id,
      error: 'claim_conflict',
      holder: failure.holder,
      hint: `Already claimed by ${failure.holder} — coordinate with the holder via coord:send or pick another item; if that agent is dead, the stale-claim reclaim lane frees it.`,
    };
  }
  return {
    ok: false,
    id: it.id,
    error: 'not_claimable',
    hint: 'Issue exists but the claim was refused or it was just released — re-check with issues:get.',
  };
}

export default defineTool({
  name: 'issues:claim',
  profile: 'engineer',
  description:
    'Claim one OR many issues (assign to yourself, or to `assignee`) before fixing, so others know they are owned. Auto-subscribes you. Single: { id, assignee? }. Many same assignee: { ids:[…], assignee? }. Many heterogeneous: items:[{ id, assignee? }]. Returns { ok, results:[{ ok, id, issue? | error, holder? }], counts } — correlate by id; a claim_conflict on one item never fails the rest.',
  guidance: {
    when: 'You are about to start work on issue(s) — claim first so two agents do not duplicate the fix. Claim several at once via ids:[…] or items:[…].',
    notWhen: 'Just reading/triaging (no claim needed). To drop a claim, issues:release. A per-item `claim_conflict` means a LIVE peer already holds it — coordinate with the `holder` (coord:send), do not blind-retry.',
    chaining: 'issues:list → issues:claim → (fix) → issues:close / issues:promote.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-claim shorthand: the issue id'),
      assignee: z.string().optional().describe('default: you. Applies to the inline id / every id in `ids`.'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('claim MANY issues for the same `assignee` (homogeneous)'),
      items: z
        .array(z.object({ id: z.string().min(1), assignee: z.string().optional() }))
        .min(1)
        .max(200)
        .optional()
        .describe('claim many issues at once — each { id, assignee? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list: ClaimItem[] = args.items?.length
      ? args.items.map((it) => ({ id: it.id, assignee: it.assignee ?? args.assignee }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, assignee: args.assignee }))
        : [{ id: args.id as string, assignee: args.assignee }];
    const env = await runBulk(list, (it) => claimOne(it, ident.ownerId), { keyOf: (it) => ({ id: it.id }) });
    return bulkContent(env);
  },
});
