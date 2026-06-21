/**
 * issues:claim — take ownership of an issue (Claimable, engineer-issues-2026-06-03).
 * The claimer is auto-subscribed; subscribers are notified.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { claimIssue, getIssue } from '../../issues-engineer';
import { classifyClaimFailure } from '../../work-items';

export default defineTool({
  name: 'issues:claim',
  profile: 'engineer',
  description: 'Claim an issue (assign it to yourself) before you start fixing it, so others know it is owned. Auto-subscribes you. Pass assignee to claim on behalf of another agent.',
  guidance: {
    when: 'You are about to start work on an issue — claim it first so two agents do not duplicate the fix.',
    notWhen: 'Just reading/triaging (no claim needed). To drop a claim, issues:release. A `claim_conflict` means a LIVE peer already holds it — coordinate with the `holder` (coord:send), do not blind-retry.',
    chaining: 'issues:list → issues:claim → (fix) → issues:close / issues:promote.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: z.string().min(1), assignee: z.string().optional().describe('defaults to you') }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const claimer = args.assignee ?? id.ownerId;
    const issue = await claimIssue(args.id, claimer);
    if (issue) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, issue: { id: issue.id, assignee: issue.assignee, state: issue.state } }) }] };
    }
    // EI-2197: claimIssue returns null both when the issue is absent AND when it
    // exists but is already held (compare-and-claim lost) — the old "issue not found"
    // message was misleading for the already-held case. Re-read + classify.
    const current = await getIssue(args.id);
    const failure = classifyClaimFailure(current, claimer);
    if (failure.reason === 'not_found') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `issue '${args.id}' not found` }) }], isError: true };
    }
    if (failure.reason === 'conflict') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: false,
          error: 'claim_conflict',
          id: args.id,
          holder: failure.holder,
          hint: `Already claimed by ${failure.holder} — coordinate with the holder via coord:send or pick another item; if that agent is dead, the stale-claim reclaim lane frees it.`,
        }) }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'not_claimable', id: args.id, hint: 'Issue exists but the claim was refused or it was just released — re-check with issues:get.' }) }],
      isError: true,
    };
  },
});
