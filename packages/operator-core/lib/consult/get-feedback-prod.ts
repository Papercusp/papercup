/** Shared production binding for consult lifecycle consumers. No tool recursion. */
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { hostname } from 'node:os';
import { resolveSpawnHostOperatorBaseUrl } from '../mcp-base-url';
import { getBuildInfo } from '../build-info';
import { recordExpertiseRoutingInvocation } from '../endpoint-route/telemetry';
import { BAR_CRITIQUE_POLICY, CONSULT_DEFAULT_POLICY, METHOD_REVIEW_POLICY, RUBRIC_VETTING_POLICY, methodReviewTarget } from './selection-policies';
import type { AcceptedFeedbackResult, GetFeedbackDeps, GetFeedbackError, GetFeedbackRequest, GetFeedbackResult } from './get-feedback-core';
import type { QueryEmbedderAcquisition } from '../agent-tools/search/embedder';

export interface GetFeedbackProdOptions {
    acceptedRequest?: GetFeedbackDeps['acceptedRequest'];
    harnessSlug?: string | null;
    filterRoute?: (route: Awaited<ReturnType<GetFeedbackDeps['route']>>) => Promise<Awaited<ReturnType<GetFeedbackDeps['route']>>>;
    /**
     * D-002: let a caller that only wants RETRIEVAL prevent any launch side
     * effect. Absent/true binds the fork/convert dispatcher; false returns the
     * ranked retrieval menu without entering the dispatch/cascade path. The
     * core reports `retrieval_only`, never a failed launch.
     *
     * (Named `allowRevival` before the dispatcher replaced revive-in-place; the
     * question it answers — "may this consult start a process?" — is unchanged.)
     */
    allowDispatch?: boolean;
}

export interface AcceptFeedbackRequestProdOptions extends Pick<GetFeedbackProdOptions, 'harnessSlug' | 'allowDispatch'> {
    /**
     * Runs after the request row is durable and before the async continuation
     * can dispatch a responder. Hard-blocked callers use this to register the
     * reply waiter before a fast responder can emit it.
     */
    onAccepted?: (accepted: AcceptedFeedbackResult) => Promise<void> | void;
}

/** Review targets may be new; explicit expertise source refs remain separate. */
function isFirstPrinciplesTargetReview(policy: GetFeedbackRequest['policy']): boolean {
    return policy === BAR_CRITIQUE_POLICY || policy === RUBRIC_VETTING_POLICY || policy === METHOD_REVIEW_POLICY;
}

export async function acceptFeedbackRequestProd(
  request: GetFeedbackRequest, identity: AgentIdentity,
    options: AcceptFeedbackRequestProdOptions = {},
) {
    methodReviewTarget(request);
    const [{ getOrgPg }, { acceptFeedbackRequestCore, validateBarCritiquePlanOrigin }, conversations, { publicManualSource }, { expertiseSubject, isToolSubject }] = await Promise.all([
      import('@papercusp/db-org'), import('./get-feedback-core'), import('../agent-tools/coordination/conversations'),
      import('../agent-tools/docs/_public-manual'), import('./relevance-router'),
    ]);
    const sql = getOrgPg().sql;
    const payload = { ...request, harnessSlug: request.harnessSlug || options.harnessSlug || undefined,
      allowDispatch: options.allowDispatch !== false,
      launchOperatorBaseUrl: resolveSpawnHostOperatorBaseUrl(), launchOperatorHost: hostname() };
    const planRefusal = await validateBarCritiquePlanOrigin(payload, sql);
    if (planRefusal) return planRefusal;

    // Governed reviews can introduce a new plan, rubric or method artifact. The target must
    // not also become a requirement for prior reviewer expertise.
    // Keep caller-supplied subject_refs as source constraints, but disable the
    // router's generic question inference when a target review has none.
    const targetReview = isFirstPrinciplesTargetReview(request.policy);
    const inferredSourceRef = targetReview ? null : expertiseSubject(request.question);
    // Caller-supplied refs are hard anchors. Inferred namespace:verb names
    // remain the router's semantic subject; expanding a tool mentioned in
    // workflow prose here would restrict retrieval to literal tool-name matches.
    const sourceRefs = request.subjectRefs?.length ? request.subjectRefs :
      inferredSourceRef && !isToolSubject(inferredSourceRef) ? [inferredSourceRef] : [];
    const subjectExpansion = sourceRefs.length ? await publicManualSource().expandSubjectRefs(sourceRefs) : null;
    const acceptedPayload = { ...payload,
      ...(subjectExpansion ? {
        resolvedSubjectRefs: subjectExpansion.refs,
        unresolvedSubjectRefs: subjectExpansion.unresolvedDocuments,
      } : targetReview ? {
        resolvedSubjectRefs: [],
        unresolvedSubjectRefs: [],
      } : {}) };
    const accepted = await acceptFeedbackRequestCore(acceptedPayload, {
      getSql: () => sql,
      open: async (input) => {
        const result = await conversations.openConversation(identity, { ...input, producer: 'consult:get_feedback' });
        return { conversation_id: result.conversation.id, thread_id: result.thread_id, delivered: result.delivered };
      },
    });
    if (!('error' in accepted)) {
      // Registration must finish before the continuation starts: its responder
      // can post the first reply during dispatch, before this function returns.
      await options.onAccepted?.(accepted);
      // A recovered worker may finish while onAccepted registers its waiter.
      // Recurring reply events do not replay an earlier edge to a late waiter.
      if (accepted.latency_contract === 'hard-blocked') {
        await notifyTerminalFeedbackRequest(request.workspaceId, accepted.conversation_id);
      }
      if (accepted.state === 'routing') {
        // The durable row, not this promise, owns recovery after process death.
        void continueFeedbackRequestProd(request.workspaceId, accepted.conversation_id).catch(() => {});
      }
    }
    return accepted;
}

export async function getFeedbackProd(
  request: GetFeedbackRequest, identity: AgentIdentity, options: GetFeedbackProdOptions = {},
) {
  const methodTarget = methodReviewTarget(request);
  // Rebuilt from the durable request on recovery; an in-memory filter closure
  // cannot carry an approval fence across the accepted-request boundary.
  const methodScreen = methodTarget
    ? await import('../rubrics').then(({ resolveAcceptanceBarApproverScreen }) =>
        resolveAcceptanceBarApproverScreen({ rubricId: methodTarget, applierId: request.requesterId }))
    : null;
  const [
    { getOrgPg }, { getFeedbackCore }, { routeConsult }, { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs },
    { resolveProseProfileSelection },
    { resolveSessionStates }, { listLoopStanddownOwners }, conversations, { makeConsultReachDispatcher, continueCascadeDispatchProd },
    { readConsultExpertRoutingSettings, bindConsultExpertRoutingSettings },
  ] = await Promise.all([
    import('@papercusp/db-org'), import('./get-feedback-core'), import('./relevance-router'),
    import('../agent-tools/search/embedder'), import('../search/prose-vector-dims'),
    import('../agent-tools/coordination/liveness-oracle'),
    import('../harness/routines/release-pause-ttl'),
    import('../agent-tools/coordination/conversations'),
    import('./consult-dispatch'),
    import('./expert-routing-settings'),
  ]);
  // This is an interactive MCP path, so a cold/local or rate-limited embedder
  // must degrade to the lexical fallback before the ~55s transport deadline.
  // The shared helper keeps this budget aligned with the other interactive
  // query surfaces (WI-3922); the losing acquisition continues warming the
  // process for a later consult.
  const dispatchDisabled = options.allowDispatch === false;
  // P-005: the PERSISTED expert-routing settings, read ONCE per consult. Once,
  // deliberately: the ranking half-life and the dispatcher's allowlist are two
  // halves of one policy, so re-reading per seam would let a mid-consult settings
  // edit rank against one policy and dispatch against another.
  const routingSettings = await readConsultExpertRoutingSettings(request.workspaceId);
  const expertRouting = bindConsultExpertRoutingSettings(routingSettings);
  let embeddingAcquisition: QueryEmbedderAcquisition | undefined;
  const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs(),
    embeddingDeadlineMs: options.acceptedRequest?.leaseUntilMs,
    onAcquisition: outcome => { embeddingAcquisition = outcome; } });
  const embed = resolved?.embed ?? null;
  const embeddingProfile = resolved
    ? resolveProseProfileSelection(resolved.mode, resolved.profile)
    : null;
  const reviewWithoutSourceRefs = isFirstPrinciplesTargetReview(request.policy)
    && !request.subjectRef && !request.subjectRefs?.length
    && request.resolvedSubjectRefs === undefined;
  return getFeedbackCore({
    ...request,
    ...(reviewWithoutSourceRefs ? { resolvedSubjectRefs: [] } : {}),
    allowDispatch: !dispatchDisabled,
  }, {
    ...(options.acceptedRequest ? { acceptedRequest: options.acceptedRequest } : {}),
    resumeInitialDispatch: (conversationId) => {
      void continueCascadeDispatchProd(request.workspaceId, conversationId, {
        workspaceId: request.workspaceId,
        harnessSlug: request.harnessSlug?.trim() || options.harnessSlug || null,
        launchedBy: identity.ownerId,
        ...(request.launchOperatorBaseUrl ? { launchOperatorBaseUrl: request.launchOperatorBaseUrl,
          launchOperatorHost: request.launchOperatorHost } : {}),
      }, { loadRanks: expertRouting.loadRanks }).catch(() => {});
    },
    getSql: () => getOrgPg().sql,
    route: async (params) => {
      const routed = await routeConsult({
        ...params,
        ...(request.nativeConsult ? { nativeConsult: request.nativeConsult } : {}),
        telemetry: {
          caller: 'consult:get_feedback', policy: request.policy ?? CONSULT_DEFAULT_POLICY, buildSha: getBuildInfo().sha,
          // Accepted preparation runs after the MCP acknowledgement. Keep its
          // stage receipts joinable to the durable request, including failures
          // and recovery attempts; an unrelated random trace loses that join.
          ...(options.acceptedRequest ? { correlationId: options.acceptedRequest.conversation_id } : {}),
        },
        // ⚠ STAGE-2 ONLY [owner 2026-09-22]: "recently should only be considered
        // when comparing... If we have like any expert floor that an agent has to
        // pass, the recency shouldnt be considered for this." This tunes how
        // qualified candidates are RANKED against each other; it never gates
        // qualification, so time away cannot strip an agent of expert status.
        recencyHalfLifeDays: expertRouting.recencyHalfLifeDays,
      }, {
        recordTelemetry: receipt => recordExpertiseRoutingInvocation(receipt, getOrgPg().sql),
        getSql: () => getOrgPg().sql,
        embed,
        embeddingProfile,
        embeddingMode: embeddingProfile && resolved ? resolved.mode : null,
        embeddingAcquisition,
        // Accepted work already acknowledged the MCP caller. Score within its
        // actual recovery lease, rather than the foreground response budget.
        subjectEvidenceDeadline: options.acceptedRequest?.leaseUntilMs,
        getLiveness: async (ownerIds) => {
          const [verdicts, pausedOwners] = await Promise.all([
            resolveSessionStates(ownerIds.map((ownerId) => ({ ownerId })), {
              hydrateBatch: true,
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
      let constrained = routed;
      if (request.nativeConsult) {
        const [{ filterNativeConsultRoute }, { observeNativeConsultSource }] = await Promise.all([
          import('./native-consult'), import('./consult-dispatch'),
        ]);
        constrained = await filterNativeConsultRoute(routed, request.nativeConsult,
          candidate => observeNativeConsultSource(candidate, request.nativeConsult!, undefined, request.workspaceId));
      }
      // WI-6554700010009982: a ranked source whose transcript is gone (no
      // native file, no archive) can never be dispatched; keep it off the menu.
      if (!dispatchDisabled) {
        const { filterDispatchableRoute, probeConsultSourceDispatchable } = await import('./source-dispatchability');
        constrained = await filterDispatchableRoute(constrained, probeConsultSourceDispatchable, {
          workspaceId: request.workspaceId,
        });
      }
      if (options.filterRoute) constrained = await options.filterRoute(constrained);
      if (methodScreen) {
        const { filterAmendmentReviewRoute } = await import('./acceptance-bar-amendment-review');
        constrained = await filterAmendmentReviewRoute(constrained, methodScreen.check);
      }
      return constrained;
    },
    open: async (input) => {
      const opened = await conversations.openConversation(identity, {
        ...input, producer: 'consult:get_feedback',
      });
      return { conversation_id: opened.conversation.id, thread_id: opened.thread_id, delivered: opened.delivered };
    },
    // D-002/D-010: the DELIVERY seam is the fork/convert walk, not notifyAgents.
    // A consult never pings or wakes a live agent — it launches a new session
    // from the routed expert's transcript. `notifyAgents` is deliberately no
    // longer imported here, so this binding cannot silently regain a wake.
    reach: dispatchDisabled
      ? async () => ({ queued: 0, woke: 0, pickupConfirmed: false, answeringOwnerId: null })
      : makeConsultReachDispatcher({
          workspaceId: request.workspaceId,
          harnessSlug: request.harnessSlug?.trim() || options.harnessSlug || null,
          launchedBy: identity.ownerId,
          ...(request.launchOperatorBaseUrl ? { launchOperatorBaseUrl: request.launchOperatorBaseUrl,
            launchOperatorHost: request.launchOperatorHost } : {}),
          // P-005: the walk order is the PERSISTED allowlist (D-004), not the
          // hardcoded seed. loadExpertModelRanks returns null when nothing usable
          // is stored, which lets resolveExpertModelAllowlist fall back to the
          // owner-stated seed on its own terms.
        }, { loadRanks: expertRouting.loadRanks }),
  });
}

/** Existing sweep calls this under the row's saved requester/workspace, with
 * no tool recursion and no new launch mechanism. */
export async function continueFeedbackRequestProd(workspaceId: string, conversationId: string): Promise<boolean> {
  const [{ getOrgPg }, { continueFeedbackRequestCore }] = await Promise.all([
    import('@papercusp/db-org'), import('./get-feedback-core'),
  ]);
  try {
    return await continueFeedbackRequestCore(workspaceId, conversationId, {
      getSql: () => getOrgPg().sql,
      execute: async (request, acceptedRequest) => getFeedbackProd(request,
        { ownerId: request.requesterId, workspaceId } as AgentIdentity,
        { acceptedRequest, harnessSlug: request.harnessSlug, allowDispatch: request.allowDispatch }),
    });
  } finally {
    // Includes exhausted preparation failures. Wake from committed truth,
    // never an in-flight return value or a guessed no-expert verdict.
    await notifyTerminalFeedbackRequest(workspaceId, conversationId);
  }
}

async function notifyTerminalFeedbackRequest(workspaceId: string, conversationId: string): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const rows = await getOrgPg().sql<{
    state: string; result: GetFeedbackResult | GetFeedbackError | null;
  }[]>`
    SELECT state, routing #> '{request,result}' AS result
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
       AND latency_contract = 'hard-blocked'
       AND state NOT IN ('routing', 'awaiting_responder', 'active')
       AND routing #> '{request,result}' IS NOT NULL`;
  const terminal = rows[0];
  if (!terminal?.result) return;
  const [{ emitAwaitedEvent }, { consultParkKey }] = await Promise.all([
    import('../events/await/engine'), import('./get-feedback-core'),
  ]);
  await emitAwaitedEvent({
    key: consultParkKey(conversationId),
    workspaceId,
    source: 'consult-request',
    summary: `Consult ${conversationId}: routing finished (${terminal.state}); read the saved result before deciding what to do next.`,
    payload: { kind: 'routing_complete', conversation_id: conversationId,
      state: terminal.state, result: terminal.result },
  });
}
