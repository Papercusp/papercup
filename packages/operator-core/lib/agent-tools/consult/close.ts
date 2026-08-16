/**
 * consult:close — settle a consult with a STRUCTURED outcome (plan
 * get-feedback-relevance-consults-2026-08-16, P-004; D-001/D-003).
 *
 * PROD BINDING ONLY — verb logic in lib/consult/consult-verbs-core.ts.
 * outcome 'answered' requires the answer (+ optional confidence/evidence);
 * 'cant_help' requires the reason — an honest terminal outcome, not a
 * failure. Either participant may close; a responder close wakes a parked
 * requester via the latched park key.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { hardText } from '../limits';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

const evidenceRef = z.object({
  session_id: z.string().min(1),
  turn_idx: z.number().int().min(0),
  note: z.string().max(500).optional(),
});

export default defineTool({
  name: 'consult:close',
  description:
    "Close a consult with a structured outcome: 'answered' (requires answer; optional confidence 0..1 + evidence) or 'cant_help' (requires reason). Terminal — after the close no further consult posts are accepted. Either participant may close; at the exchange cap this is the only way forward.",
  guidance: {
    when:
      'The consult is settled (answered) — or engaged-but-stuck: you validated relevance yet cannot help (cant_help, with the reason).',
    notWhen:
      'Still exchanging → consult:reply. Never engaged / not your area → consult:decline (keeps the cascade menu alive for the requester).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      conversation_id: z.string().min(1).describe('The consult conversation to close.'),
      outcome: z.enum(['answered', 'cant_help']).describe("'answered' = structured answer below; 'cant_help' = honest can't-help with reason."),
      answer: hardText(8000).optional().describe('The settled answer (required for outcome=answered).'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence in the answer, 0..1 (answered only).'),
      evidence: z.array(evidenceRef).max(16).optional().describe('Transcript grounding [{ session_id, turn_idx, note? }].'),
      reason: hardText(2000).optional().describe("Why it can't be helped (required for outcome=cant_help)."),
    })
    .refine((a) => (a.outcome === 'answered' ? Boolean(a.answer?.trim()) : Boolean(a.reason?.trim())), {
      message: "outcome=answered requires answer; outcome=cant_help requires reason",
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const [{ getOrgPg }, { consultCloseCore }, conversations] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/consult-verbs-core'),
      import('../coordination/conversations'),
    ]);
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );
    const result = await consultCloseCore(
      {
        workspaceId,
        authorId: identity.ownerId,
        conversationId: args.conversation_id,
        outcome: args.outcome,
        answer: args.answer,
        confidence: args.confidence,
        evidence: args.evidence,
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
