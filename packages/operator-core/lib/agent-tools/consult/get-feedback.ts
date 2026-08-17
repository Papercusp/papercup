/**
 * consult:get_feedback — the requester-side consult tool (plan
 * get-feedback-relevance-consults-2026-08-16, P-003).
 *
 * PROD BINDING ONLY. All workflow logic lives in
 * lib/consult/get-feedback-core.ts (core/binding split, mirrors
 * conversations-core.ts) — this file wires the prod seams:
 *   route   → routeConsult + buildQueryEmbedder + the liveness oracle
 *   open    → openConversation (kind='consult'; direct_to subscribes BEFORE
 *             fanout, so the responder is reached durably)
 *   reach   → notifyAgents (subscribe + ping + wake — the shared reach-core)
 *
 * Heavy deps are imported INSIDE the handler (probe-capacity style): the
 * embedder/search graph opens PG at import time, and registration must stay
 * cheap (the router module itself documents this constraint).
 *
 * Selection (consult-min-max-and-rubric-vetting-2026-08-17 D-001/D-003):
 * min_agents/max_agents map to the core's minResponders/maxResponders — the
 * selected set is every above-floor qualified candidate plus best-scoring
 * minimum-fill to reach min (labeled via:'minimum'), capped at max. Delivery
 * stays a cascade: the top selectee is woken, the rest are the menu
 * (remaining_candidates). The per-task wake budget is REMOVED (D-005).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { hardText, LIMITS } from '../limits';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'consult:get_feedback',
  description:
    'Ask "who knows more than me about THIS?" — routes your question over real cross-agent transcript history (embedding + recency/verification/authorship blend), opens a bounded consult thread with the top qualified responder, and wakes them with why-they-were-chosen evidence. ARCHIVE-FIRST: a question a closed consult already answered is served instantly from the archive (no wake). Honest by design: below the relevance floor the answer is a first-class no_qualified_responder ("no one knows more than you do — proceed on your own judgment"), never a costumed expert.',
  guidance: {
    when:
      'You face a question a PEER may have real context on — their transcripts, their code, a failure they already debugged — before burning hours re-deriving it. You do not know WHO: the router discovers the responder from evidence.',
    notWhen:
      'Live state (query it: locks:queue / fleet:assignments / work_items:get). An owner decision (coord:ask-owner). A SPECIFIC known agent (coord:send / coord:message-agent — this tool is who-knows DISCOVERY). Assigning work (a consult is advice, never a handoff — requester owns the outcome).',
    chaining:
      "get_feedback → 'served_from_archive'? use the cited answer in `archive`, or re-call with archive_floor: 2 if it does not fit → latency_contract:'hard-blocked' ⇒ events:await { event: park_key } + end turn (reply wakes you) → conversations:get { id: conversation_id } for the thread → declines/expiries advance the cascade server-side (D-005); re-call with exclude:[…] only after a terminal 'declined'/'expired'.",
    returns:
      '{ verdict: routed | no_qualified_responder | served_from_archive, conversation_id, thread_id, responder, responder_via (floor | minimum — minimum = best-available below the relevance floor, weigh as first-principles), remaining_candidates, origin_task_ref, latency_contract, expires_at, wake, park_key, archive? (source consult + responder + sim + structured answer — served_from_archive only), hint }',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    question: hardText(LIMITS.ANNOTATION).describe('The question. Name concrete files/symbols where relevant — authorship of the code in question is a routing signal.'),
    tried: hardText(LIMITS.ANNOTATION).optional().describe('What you already tried (grounds the responder; avoids re-suggesting it).'),
    observed: hardText(LIMITS.ANNOTATION).optional().describe('What you observed (evidence, not interpretation).'),
    decision_at_stake: hardText(LIMITS.ANNOTATION).optional().describe('The decision this consult informs — the requester owns it (advice, not consensus).'),
    latency_contract: z
      .enum(['proceed', 'hard-blocked'])
      .optional()
      .describe("'proceed' (default): continue on your own judgment, reconcile when the reply lands. 'hard-blocked': you will park on the returned park_key event."),
    origin_task_ref: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Work-item/task this consult is attributed to (default: your most recently progressed wip work-item).'),
    exclude: z
      .array(z.string().min(1))
      .max(16)
      .optional()
      .describe("Owners to exclude from candidacy — e.g. the exhausted menu's decliners when re-routing after a terminal 'declined'/'expired' (the cascade itself advances server-side; no per-decline re-call)."),
    parent_consult_id: z
      .string()
      .min(1)
      .optional()
      .describe("Consulting onward from WITHIN a consult you are answering? Pass THAT consult's conversation_id: depth = parent+1 (capped at 2), and the lineage's participants are excluded from routing (cycle refusal, D-005)."),
    max_agents: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe('Cap on the selected cascade menu (default 3). Delivery stays single-wake: the top selectee is woken, the rest are the menu (remaining_candidates).'),
    min_agents: z
      .number()
      .int()
      .min(0)
      .max(8)
      .optional()
      .describe("Select at least this many responders even below the relevance floor (best-available LIVE fill, labeled via:'minimum'; default 1). Pass 0 to restore pure-floor selection."),
    archive_floor: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe(
        'Similarity floor for the archive-first serve (default ~0.8, precision-biased). Pass 2 to bypass the archive entirely (force fresh routing — e.g. when an archived answer did not fit your context); lower it only when a stale-but-close answer beats waking anyone.',
      ),
    topics: z.array(z.string().min(1)).max(8).optional().describe('Area topics to tag the consult with (ambient discoverability).'),
    harness: z.string().optional().describe('Tag the conversation harness-scoped.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    // Heavy prod seams — imported per-call, never at registration (see header).
    const [
      { getOrgPg },
      { getFeedbackCore },
      { routeConsult },
      { buildQueryEmbedder },
      { resolveSessionStates },
      conversations,
      { notifyAgents },
    ] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/get-feedback-core'),
      import('../../consult/relevance-router'),
      import('../search/embedder'),
      import('../coordination/liveness-oracle'),
      import('../coordination/conversations'),
      import('../coordination/notify-agents'),
    ]);

    // The consult_state partition must be the SAME workspace the conversation
    // row lands under — resolve it with the conversations layer's own resolver.
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );

    const embed = await buildQueryEmbedder(); // Embedder | null — null = honest degrade
    const result = await getFeedbackCore(
      {
        workspaceId,
        requesterId: identity.ownerId,
        question: args.question,
        tried: args.tried,
        observed: args.observed,
        decisionAtStake: args.decision_at_stake,
        latencyContract: args.latency_contract,
        ...(args.origin_task_ref !== undefined ? { originTaskRef: args.origin_task_ref } : {}),
        ...(args.parent_consult_id !== undefined ? { parentConsultId: args.parent_consult_id } : {}),
        excludeOwners: args.exclude,
        ...(args.min_agents !== undefined ? { minResponders: args.min_agents } : {}),
        ...(args.max_agents !== undefined ? { maxResponders: args.max_agents } : {}),
        ...(args.archive_floor !== undefined ? { archiveFloor: args.archive_floor } : {}),
        topics: args.topics,
        harnessSlug: args.harness,
      },
      {
        getSql: () => getOrgPg().sql,
        route: (params) =>
          routeConsult(params, {
            getSql: () => getOrgPg().sql,
            embed,
            getLiveness: async (ownerIds) => {
              const verdicts = await resolveSessionStates(
                ownerIds.map((ownerId) => ({ ownerId })),
                { hydratePerId: true },
              );
              return Object.fromEntries(
                [...verdicts.values()].map((v) => [v.ownerId, v.sessionState]),
              );
            },
          }),
        open: async (input) => {
          const opened = await conversations.openConversation(identity, input);
          return {
            conversation_id: opened.conversation.id,
            thread_id: opened.thread_id,
            delivered: opened.delivered,
          };
        },
        reach: async (opts) => {
          const r = await notifyAgents(identity, {
            addressees: [opts.responder],
            objectRef: { kind: 'conversation', ref: opts.conversationId },
            summary: opts.summary,
            body: opts.body,
            ...(args.harness ? { harnessSlug: args.harness } : {}),
            wake: true,
          });
          return { woke: r.woke };
        },
      },
    );

    return ok(result as unknown as Record<string, unknown>);
  },
});
