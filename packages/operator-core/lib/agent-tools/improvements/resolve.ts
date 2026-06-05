/**
 * improvements:resolve — the verify-and-mark-done back-edge of the
 * self-improvement loop (close-the-self-improvement-loop-2026-06-05 D-001).
 *
 * The implement worker (and any agent that fixes a captured improvement
 * self/inline) calls this when it finishes an item. `fixed` REQUIRES the
 * verification evidence (testsRun) — a fix is only resolved when verified —
 * and marks the issue resolved so it leaves the auto-implement queue.
 * `could-not-fix` / `needs-human` release the claim and route appropriately.
 * Thin wrapper over `resolveImprovement` (resolve-core.ts).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolveImprovement } from '../../harness/improvements/resolve-core';

export default defineTool({
  name: 'improvements:resolve',
  profile: 'engineer',
  description:
    'Close the loop on a captured papercusp improvement you worked: outcome `fixed` (requires testsRun — the verification evidence) marks it resolved so it leaves the queue; `could-not-fix` releases it for a retry (exhausted retries route to a human); `needs-human` routes it to the human queue permanently.',
  guidance: {
    when: 'You finished working a dispatched/claimed improvement (usually as the implement worker). Fixed + tests green → outcome fixed with the evidence. Could not make it work → could-not-fix with what you tried. The fix would touch a protected surface (operator-core safety / deploy machinery / a migration) or needs judgment → needs-human.',
    notWhen: 'You only want to comment progress — issues:comment. You are closing a non-improvement issue — issues:close. The item was never captured (no EI/WI id) — improvements:capture it first if it is worth tracking.',
    chaining: 'improvements:digest → (dispatch/claim) → implement + test → improvements:resolve { id, outcome, summary, testsRun }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).max(40).describe('the improvement work-unit id (EI-n / WI-n)'),
    outcome: z.enum(['fixed', 'could-not-fix', 'needs-human']),
    summary: z.string().min(10).max(4000).describe('what happened — for fixed: what changed + how it was verified; for the others: why'),
    testsRun: z.string().max(1000).optional().describe('the test command(s) run + result — REQUIRED for outcome fixed'),
    commit: z.string().max(120).optional().describe('commit/branch the fix landed on (it still rides the release gate)'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const result = await resolveImprovement({
      id: args.id,
      outcome: args.outcome,
      summary: args.summary,
      testsRun: args.testsRun,
      commit: args.commit,
      by: id.ownerId,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
