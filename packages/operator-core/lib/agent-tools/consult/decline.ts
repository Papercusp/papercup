/**
 * consult:decline — the responder's cheap honest exit (plan
 * get-feedback-relevance-consults-2026-08-16, P-004; D-007(7)).
 *
 * PROD BINDING ONLY — verb logic in lib/consult/consult-verbs-core.ts. A
 * decline posts the reason and ADVANCES the cascade (D-005 always-advance,
 * consult-min-max-and-rubric-vetting-2026-08-17): the next selectee is woken
 * with the feedback so far (reach → notifyAgents). Only when the menu is
 * exhausted does it close consult_state as 'declined' and emit the latched
 * park key (nothing more is coming for a parked requester).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { hardText } from '../limits';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'consult:decline',
  description:
    'Decline a consult routed to you — your context does not cover the question. Honest and cheap by design: posts the reason, closes the consult as declined, wakes the requester, and returns the remaining route candidates so they can cascade (re-call get_feedback with exclude:[you]).',
  guidance: {
    when:
      'You validated the consult (read the cited evidence) and your context genuinely does not cover it. Declining fast is the helpful move — never answer from guesswork.',
    notWhen:
      'You can partially help → consult:reply (clarifying_question / new_fact). You engaged and it is settled → consult:close.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    conversation_id: z.string().min(1).describe('The consult conversation to decline.'),
    reason: hardText(2000).describe("Why your context does not cover it (e.g. 'my transcript touches the file but not this subsystem')."),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const [{ getOrgPg }, { consultDeclineCore }, conversations] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/consult-verbs-core'),
      import('../coordination/conversations'),
    ]);
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );
    const result = await consultDeclineCore(
      {
        workspaceId,
        authorId: identity.ownerId,
        conversationId: args.conversation_id,
        reason: args.reason,
      },
      {
        getSql: () => getOrgPg().sql,
        post: (input) => conversations.postReply(identity, input),
        emitReplyEvent: async (e) => {
          await import('../../events/await/engine')
            .then(({ emitAwaitedEvent }) => emitAwaitedEvent({ ...e, source: identity.ownerId }))
            .catch(() => {});
        },
      },
    );
    return ok(result as unknown as Record<string, unknown>);
  },
});
