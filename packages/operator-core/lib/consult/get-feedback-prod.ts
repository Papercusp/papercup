/** Shared production binding for consult lifecycle consumers. No tool recursion. */
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { GetFeedbackDeps, GetFeedbackRequest } from './get-feedback-core';

export async function getFeedbackProd(
  request: GetFeedbackRequest,
  identity: AgentIdentity,
  options: {
    producer?: string;
    harnessSlug?: string | null;
    filterRoute?: (route: Awaited<ReturnType<GetFeedbackDeps['route']>>) => Promise<Awaited<ReturnType<GetFeedbackDeps['route']>>>;
  } = {},
) {
  const [
    { getOrgPg }, { getFeedbackCore }, { routeConsult }, { buildQueryEmbedder },
    { resolveSessionStates }, conversations, { notifyAgents }, { makeConsultReviver },
  ] = await Promise.all([
    import('@papercusp/db-org'), import('./get-feedback-core'), import('./relevance-router'),
    import('../agent-tools/search/embedder'), import('../agent-tools/coordination/liveness-oracle'),
    import('../agent-tools/coordination/conversations'), import('../agent-tools/coordination/notify-agents'),
    import('./revive-responder'),
  ]);
  const embed = await buildQueryEmbedder();
  return getFeedbackCore(request, {
    getSql: () => getOrgPg().sql,
    route: async (params) => {
      const routed = await routeConsult(params, {
        getSql: () => getOrgPg().sql,
        embed,
        getLiveness: async (ownerIds) => {
          const verdicts = await resolveSessionStates(ownerIds.map((ownerId) => ({ ownerId })), {
            hydratePerId: true,
            psuHostPositiveAuthority: true,
          });
          return Object.fromEntries([...verdicts.values()].map((v) => [v.ownerId, {
            sessionState: v.sessionState,
            ...(typeof v.warmIdle === 'boolean' ? { warmIdle: v.warmIdle } : {}),
          }]));
        },
      });
      return options.filterRoute ? options.filterRoute(routed) : routed;
    },
    open: async (input) => {
      const opened = await conversations.openConversation(identity, {
        ...input, producer: options.producer ?? 'consult:get_feedback',
      });
      return { conversation_id: opened.conversation.id, thread_id: opened.thread_id, delivered: opened.delivered };
    },
    reach: async (opts) => {
      const r = await notifyAgents(identity, {
        addressees: [opts.responder],
        objectRef: { kind: 'conversation', ref: opts.conversationId },
        summary: opts.summary, body: opts.body,
        ...(request.harnessSlug ? { harnessSlug: request.harnessSlug } : {}),
        wake: true,
      });
      return { queued: r.queued ?? r.woke, woke: r.woke, pickupConfirmed: r.pickupConfirmed ?? false };
    },
    revive: makeConsultReviver({
      workspaceId: request.workspaceId,
      harnessSlug: request.harnessSlug?.trim() || options.harnessSlug || null,
      launchedBy: identity.ownerId,
    }),
  });
}
