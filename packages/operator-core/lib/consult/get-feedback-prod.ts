/** Shared production binding for consult lifecycle consumers. No tool recursion. */
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { GetFeedbackDeps, GetFeedbackRequest } from './get-feedback-core';

export async function getFeedbackProd(
  request: GetFeedbackRequest,
  identity: AgentIdentity,
  options: {
    harnessSlug?: string | null;
    filterRoute?: (route: Awaited<ReturnType<GetFeedbackDeps['route']>>) => Promise<Awaited<ReturnType<GetFeedbackDeps['route']>>>;
  } = {},
) {
  const [
    { getOrgPg }, { getFeedbackCore }, { routeConsult }, { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs },
    { resolveProseProfileSelection },
    { resolveSessionStates }, { listLoopStanddownOwners }, conversations, { notifyAgents }, { makeConsultReviver },
  ] = await Promise.all([
    import('@papercusp/db-org'), import('./get-feedback-core'), import('./relevance-router'),
    import('../agent-tools/search/embedder'), import('../search/prose-vector-dims'),
    import('../agent-tools/coordination/liveness-oracle'),
    import('../harness/routines/release-pause-ttl'),
    import('../agent-tools/coordination/conversations'), import('../agent-tools/coordination/notify-agents'),
    import('./revive-responder'),
  ]);
  // This is an interactive MCP path, so a cold/local or rate-limited embedder
  // must degrade to the lexical fallback before the ~55s transport deadline.
  // The shared helper keeps this budget aligned with the other interactive
  // query surfaces (WI-3922); the losing acquisition continues warming the
  // process for a later consult.
  const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() });
  const embed = resolved?.embed ?? null;
  const embeddingProfile = resolved
    ? resolveProseProfileSelection(resolved.mode, resolved.profile)
    : null;
  return getFeedbackCore(request, {
    getSql: () => getOrgPg().sql,
    route: async (params) => {
      const routed = await routeConsult(params, {
        getSql: () => getOrgPg().sql,
        embed,
        embeddingProfile,
        getLiveness: async (ownerIds) => {
          const [verdicts, pausedOwners] = await Promise.all([
            resolveSessionStates(ownerIds.map((ownerId) => ({ ownerId })), {
              hydratePerId: true,
              psuHostPositiveAuthority: true,
            }),
            listLoopStanddownOwners(getOrgPg().sql, { workspaceId: request.workspaceId }),
          ]);
          return Object.fromEntries([...verdicts.values()].map((v) => [v.ownerId, {
            sessionState: v.sessionState,
            ...(typeof v.warmIdle === 'boolean' ? { warmIdle: v.warmIdle } : {}),
            ...(pausedOwners.has(v.ownerId) ? { ownerPaused: true } : {}),
          }]));
        },
      });
      return options.filterRoute ? options.filterRoute(routed) : routed;
    },
    open: async (input) => {
      const opened = await conversations.openConversation(identity, {
        ...input, producer: 'consult:get_feedback',
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
    postQueueLiveness: async (ownerId) => {
      try {
        const verdict = (await resolveSessionStates([{ ownerId }], {
          hydratePerId: true,
          psuHostPositiveAuthority: true,
        })).get(ownerId);
        return verdict ? { sessionState: verdict.sessionState } : null;
      } catch {
        // The wake is already durable; an enrichment failure must preserve the
        // pending delivery rather than infer death and cascade.
        return null;
      }
    },
    revive: makeConsultReviver({
      workspaceId: request.workspaceId,
      harnessSlug: request.harnessSlug?.trim() || options.harnessSlug || null,
      launchedBy: identity.ownerId,
    }),
  });
}
