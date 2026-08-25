/** Dedicated, frozen acceptance-grader launch for the plan completion gate. */
import { createHash } from 'node:crypto';
import launchAgentTool from './agent-tools/capability/launch-agent';
import { readPlanBySlug } from './agent-tools/plans/source';
import { getLatestPlanAudit, summarizeCoverage } from './plan-audits';
import { getAcceptanceRubricForPlan } from './rubrics';
import { listWorkItems } from './work-items';
import type { GraderEligibility, GraderEscalation } from './consult/acceptance-grader-select';

type LaunchCtx = Parameters<typeof launchAgentTool.handler>[1];

export type AcceptanceGraderLifecycle = {
  /** 'assigned' (P-011/D-009): an existing above-floor, non-excluded, reachable
   * agent was selected by the relevance router — no fresh judge was launched. */
  state: 'launched' | 'deduped' | 'failed' | 'assigned';
  idempotencyKey: string;
  label: string;
  launch?: unknown;
  error?: string;
  /** D-009 discovery outcome (state 'assigned'): the selected grader. */
  grader?: { ownerId: string; score: number; liveness: string };
  /** D-009 exclusion audit trail (implementers + heavy consult participants +
   * rubric author + shipper) — set whenever discovery ran. */
  excluded?: string[];
  /** Structured discovery counts, including the known post-exclusion pool. */
  eligibility?: GraderEligibility;
  /** Explicit escalation when the measured post-exclusion pool is empty. */
  escalation?: GraderEscalation;
  /** Why discovery fell through to the fresh launch (state launched/deduped). */
  freshReason?: 'no_qualified_non_excluded' | 'all_qualified_dead' | 'degraded' | 'discovery_error';
  /** Wake delivery for an assigned grader ({ woke: 0 } = parked; they read the
   * grading request on their next turn — the subscribe is durable). */
  notified?: { woke: number };
};

const trim = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** Shared label algebra: scorecards:emit uses this exact prefix to reap the judge. */
export function acceptanceGraderLabelPrefix(rubricRef: string): string {
  const safe = rubricRef.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
  return `acceptance-grader:${safe || 'rubric'}:`;
}

function compactSnapshot(input: {
  plan: NonNullable<Awaited<ReturnType<typeof readPlanBySlug>>>;
  rubric: NonNullable<Awaited<ReturnType<typeof getAcceptanceRubricForPlan>>>;
  audit: NonNullable<Awaited<ReturnType<typeof getLatestPlanAudit>>>;
  workItems: Awaited<ReturnType<typeof listWorkItems>>;
}) {
  const { row } = input.plan;
  const rubric = input.rubric as unknown as Record<string, unknown>;
  const criteria = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  return {
    frozenAt: new Date().toISOString(),
    plan: {
      slug: row.planSlug,
      workspaceId: row.workspaceId,
      harnessSlug: row.harnessSlug,
      version: row.version,
      contentHash: row.contentHash,
      items: row.items.map((i) => ({ id: i.id, status: i.status, text: trim(i.text, 180) })),
      decisions: row.decisions.map((d) => ({ id: d.id, title: trim(d.title, 120), body: trim(d.body, 260) })),
    },
    rubric: {
      rubricId: rubric.rubricId,
      title: trim(rubric.title, 180),
      proposedBy: rubric.proposedBy ?? rubric.createdBy ?? null,
      criteria: criteria.map((raw) => {
        const c = (raw ?? {}) as Record<string, unknown>;
        return { key: c.key, title: trim(c.title ?? c.label, 120), description: trim(c.description, 260) };
      }),
    },
    audit: {
      auditSeq: input.audit.auditSeq,
      createdBy: input.audit.createdBy,
      auditedSha: input.audit.auditedSha,
      summary: trim(input.audit.summary, 500),
      coverage: summarizeCoverage(input.audit.items),
      items: input.audit.items.map((i) => ({
        itemId: i.itemId,
        verdict: i.verdict,
        citations: i.citations.map((c) => ({ kind: c.kind, path: c.path, line: c.line, symbol: c.symbol })),
      })),
    },
    terminalWork: input.workItems.map((w) => ({
      id: w.id,
      state: w.state,
      title: trim(w.title, 140),
      terminalOwner: w.terminalOwner,
      completionRef: trim(w.terminalCompletionRef, 220),
      evidence: w.terminalCompletionEvidence,
    })),
  };
}

function boundedSnapshotJson(snapshot: ReturnType<typeof compactSnapshot>): string {
  const full = JSON.stringify(snapshot);
  if (full.length <= 5_800) return full;
  return JSON.stringify({
    ...snapshot,
    plan: {
      ...snapshot.plan,
      items: snapshot.plan.items.map(({ id, status }) => ({ id, status })),
      decisions: snapshot.plan.decisions.map(({ id, title }) => ({ id, title })),
    },
    audit: { ...snapshot.audit, items: snapshot.audit.items.map(({ itemId, verdict }) => ({ itemId, verdict })) },
    terminalWork: snapshot.terminalWork.map(({ id, state, completionRef }) => ({ id, state, completionRef })),
  });
}

/**
 * D-009 (get-feedback-relevance-consults-2026-08-16, P-011) — discovery-FIRST
 * grader resolution: route the plan + acceptance rubric through the relevance
 * router with the independence exclusion set (implementers + heavy consult
 * participants + rubric author + shipper); the top non-excluded, reachable
 * candidate above the floor becomes the ASSIGNED grader (woken with the grading
 * request — no fresh judge spent). Below floor / all excluded / all dead /
 * embedder degraded → the pre-existing fresh-session launch (the floor
 * asymmetry: for grading, WRONG context disqualifies and a grader MUST exist,
 * so below-floor mints fresh — "a fresh session agent is better than an agent
 * with THE WRONG context"). Discovery is a service, never a new failure mode:
 * any discovery fault falls through to the fresh launch.
 *
 * Same signature as launchAcceptanceGrader so the set-plan-status seam can use
 * either interchangeably (its tests inject their own).
 */
type GraderDiscoveryResult = {
  verdict: 'assigned' | 'fresh';
  grader?: { ownerId: string; score: number; liveness: string };
  excluded: string[];
  eligibility?: GraderEligibility;
  escalation?: GraderEscalation;
  freshReason?: 'no_qualified_non_excluded' | 'all_qualified_dead' | 'degraded';
};

/** Prod discovery wiring: the P-002 router + embedder + liveness oracle behind
 * selectAcceptanceGrader. Injected as `deps.discover` in tests — this default
 * reaches the org PG, which a unit test must never do. */
async function prodDiscoverGrader(
  plan: NonNullable<Awaited<ReturnType<typeof readPlanBySlug>>>,
  rubric: NonNullable<Awaited<ReturnType<typeof getAcceptanceRubricForPlan>>>,
  ctx: LaunchCtx,
): Promise<GraderDiscoveryResult> {
  const [
    { getOrgPg },
    { routeConsult },
    { buildQueryEmbedder },
    { resolveSessionStates },
    { selectAcceptanceGrader },
  ] = await Promise.all([
    import('@papercusp/db-org'),
    import('./consult/relevance-router'),
    import('./agent-tools/search/embedder'),
    import('./agent-tools/coordination/liveness-oracle'),
    import('./consult/acceptance-grader-select'),
  ]);
  const embed = await buildQueryEmbedder();
  const r = rubric as unknown as {
    rubricId: string;
    title?: string;
    proposedBy?: string | null;
    createdBy?: string | null;
    criteria?: Array<{ key?: string; title?: string; model?: string }>;
  };
  const rubricText = [
    r.title ?? r.rubricId,
    ...(Array.isArray(r.criteria)
      ? r.criteria.map((c) => `${c.key ?? ''}: ${c.title ?? ''} ${c.model ?? ''}`.trim())
      : []),
  ].join('\n');
  let shipperId: string | null = null;
  try {
    const { resolveAgentIdentity } = await import('./agent-tools/coordination/identity');
    shipperId = resolveAgentIdentity(ctx as never).ownerId;
  } catch {
    /* unattributable shipper — the computed set still excludes implementers */
  }
  const selection = await selectAcceptanceGrader(
    {
      workspaceId: plan.row.workspaceId,
      planSlug: plan.row.planSlug,
      planContent: plan.row.content,
      rubricText,
      extraExclusions: [r.proposedBy, r.createdBy, shipperId],
    },
    {
      getSql: () => getOrgPg().sql,
      getCandidateRoles: async (workspaceId, ownerIds) => {
        if (ownerIds.length === 0) return new Map<string, string | null>();
        // coord:send admits only COORD_ROLES. Resolve the durable role in the
        // same workspace before allowing the router to assign a blocking ask;
        // absent rows/roles remain absent and are rejected by the selector.
        const rows = await getOrgPg().sql<Array<{ owner_id: string; agent_role: string | null }>>`
          SELECT owner_id, agent_role
            FROM harness_shared.coord_presence
           WHERE workspace_id = ${workspaceId}
             AND owner_id = ANY(${ownerIds}::text[])
        `;
        return new Map(rows.map((row) => [row.owner_id, row.agent_role] as const));
      },
      route: (params) =>
        routeConsult(params, {
          getSql: () => getOrgPg().sql,
          embed,
          getLiveness: async (ownerIds) => {
            const verdicts = await resolveSessionStates(
              ownerIds.map((ownerId) => ({ ownerId })),
              { hydratePerId: true },
            );
            return Object.fromEntries([...verdicts.values()].map((v) => [v.ownerId, v.sessionState]));
          },
        }),
    },
  );
  return {
    verdict: selection.verdict,
    ...(selection.grader
      ? {
          grader: {
            ownerId: selection.grader.ownerId,
            score: selection.grader.score,
            liveness: selection.grader.liveness,
          },
        }
      : {}),
    excluded: selection.excluded,
    eligibility: selection.eligibility,
    ...(selection.escalation ? { escalation: selection.escalation } : {}),
    ...(selection.freshReason ? { freshReason: selection.freshReason } : {}),
  };
}

/** Prod wake for an assigned grader (subscribe + ping + wake). Injected as
 * `deps.notifyAssigned` in tests. */
export function buildAssignedAcceptanceGraderBrief(
  planSlug: string,
  harnessSlug: string | null,
  rubricId: string,
): string {
  const planRead = harnessSlug
    ? `plans:get { slug:${JSON.stringify(planSlug)}, harness:${JSON.stringify(harnessSlug)} }`
    : `plans:get { slug:${JSON.stringify(planSlug)} }`;
  const targetHive = harnessSlug ? `, targetHive:${JSON.stringify(harnessSlug)}` : '';
  return (
    `The relevance router selected you to grade plan '${planSlug}' — your transcript history matched the ` +
    `plan + rubric above the precision floor and you are outside its implementer/consult-participant ` +
    `exclusion set (D-009 independence). Because your session may be in a different hive, keep the plan ` +
    `harness explicit: read the plan (${planRead}) + the acceptance rubric '${rubricId}' + the completion ` +
    `evidence, then emit ONE complete scorecard: ` +
    `scorecards:emit { rubricRef:${JSON.stringify(rubricId)}${targetHive}, ratings:{ <every criterion key> } } ` +
    `with concrete evidence per rating. The targetHive makes deterministic checks run against the subject ` +
    `tree rather than the grader's checkout. The verdict is YOURS — consult if you need to, but the grade ` +
    `is not delegable.`
  );
}

async function prodNotifyAssignedGrader(
  planSlug: string,
  harnessSlug: string | null,
  rubricId: string,
  graderOwnerId: string,
  ctx: LaunchCtx,
): Promise<{ woke: number }> {
  const [{ notifyAgents }, { resolveAgentIdentity }] = await Promise.all([
    import('./agent-tools/coordination/notify-agents'),
    import('./agent-tools/coordination/identity'),
  ]);
  const identity = resolveAgentIdentity(ctx as never);
  const res = await notifyAgents(identity, {
    addressees: [graderOwnerId],
    objectRef: { kind: 'plan', ref: planSlug },
    summary: `You are the ASSIGNED acceptance grader for plan ${planSlug} (rubric ${rubricId})`,
    body: buildAssignedAcceptanceGraderBrief(planSlug, harnessSlug, rubricId),
    planSlug,
    ...(harnessSlug ? { harnessSlug } : {}),
    wake: true,
  });
  return { woke: res.woke };
}

export async function resolveAcceptanceGrader(
  planSlug: string,
  ctx: LaunchCtx,
  deps: Parameters<typeof launchAcceptanceGrader>[2] & {
    discover?: typeof prodDiscoverGrader;
    notifyAssigned?: typeof prodNotifyAssignedGrader;
  } = {},
): Promise<AcceptanceGraderLifecycle> {
  let discovery:
    | {
        excluded: string[];
        eligibility?: GraderEligibility;
        escalation?: GraderEscalation;
        freshReason: NonNullable<AcceptanceGraderLifecycle['freshReason']>;
      }
    | undefined;
  try {
    const plan = await (deps.readPlan ?? readPlanBySlug)(planSlug, {
      ...(ctx.harnessSlug && ctx.harnessSlug !== '*' ? { harnessSlug: ctx.harnessSlug } : {}),
      ...(ctx.workspaceId && ctx.workspaceId !== '*' ? { workspaceId: ctx.workspaceId } : {}),
    });
    const rubric = plan ? await (deps.getRubric ?? getAcceptanceRubricForPlan)(planSlug) : null;
    if (plan && rubric) {
      const selection = await (deps.discover ?? prodDiscoverGrader)(plan, rubric, ctx);
      if (selection.verdict === 'assigned' && selection.grader) {
        const rubricId = String((rubric as unknown as { rubricId: string }).rubricId);
        const notified = await (deps.notifyAssigned ?? prodNotifyAssignedGrader)(
          planSlug,
          plan.row.harnessSlug ?? null,
          rubricId,
          selection.grader.ownerId,
          ctx,
        ).catch(() => ({ woke: 0 }));
        // { woke: 0 } is fine: the subscribe is durable — a parked grader reads
        // the grading request on its next turn.
        return {
          state: 'assigned',
          idempotencyKey: '',
          label: '',
          grader: selection.grader,
          excluded: selection.excluded,
          eligibility: selection.eligibility,
          ...(selection.escalation ? { escalation: selection.escalation } : {}),
          notified,
        };
      }
      discovery = {
        excluded: selection.excluded,
        eligibility: selection.eligibility,
        ...(selection.escalation ? { escalation: selection.escalation } : {}),
        freshReason: selection.freshReason ?? 'no_qualified_non_excluded',
      };
    }
  } catch {
    discovery = { excluded: [], freshReason: 'discovery_error' };
  }
  const launched = await launchAcceptanceGrader(planSlug, ctx, deps);
  return { ...launched, ...(discovery ?? {}) };
}

export async function launchAcceptanceGrader(
  planSlug: string,
  ctx: LaunchCtx,
  deps: {
    readPlan?: typeof readPlanBySlug;
    getRubric?: typeof getAcceptanceRubricForPlan;
    getAudit?: typeof getLatestPlanAudit;
    listWork?: typeof listWorkItems;
    launch?: typeof launchAgentTool.handler;
  } = {},
): Promise<AcceptanceGraderLifecycle> {
  const plan = await (deps.readPlan ?? readPlanBySlug)(planSlug, {
    ...(ctx.harnessSlug && ctx.harnessSlug !== '*' ? { harnessSlug: ctx.harnessSlug } : {}),
    ...(ctx.workspaceId && ctx.workspaceId !== '*' ? { workspaceId: ctx.workspaceId } : {}),
  });
  if (!plan) return { state: 'failed', idempotencyKey: '', label: '', error: `plan '${planSlug}' not found` };
  const [rubric, audit, workItems] = await Promise.all([
    (deps.getRubric ?? getAcceptanceRubricForPlan)(planSlug),
    (deps.getAudit ?? getLatestPlanAudit)(planSlug),
    (deps.listWork ?? listWorkItems)({ harness: plan.row.harnessSlug, sourcePlanSlug: planSlug, includeChildren: true, limit: 2_000 }),
  ]);
  if (!rubric) return { state: 'failed', idempotencyKey: '', label: '', error: `acceptance rubric missing for '${planSlug}'` };
  if (!audit) return { state: 'failed', idempotencyKey: '', label: '', error: `plan audit missing for '${planSlug}'` };

  const rubricRef = String((rubric as unknown as { rubricId: string }).rubricId);
  const identity = createHash('sha256')
    .update([plan.row.workspaceId, plan.row.harnessSlug, planSlug, rubricRef, plan.row.version, plan.row.contentHash].join('\0'))
    .digest('hex');
  const idempotencyKey = `acceptance-grader:${identity}`;
  const label = `${acceptanceGraderLabelPrefix(rubricRef)}${identity.slice(0, 12)}`;
  const snapshot = boundedSnapshotJson(compactSnapshot({ plan, rubric, audit, workItems }));
  const testPaths = audit.items.flatMap((i) => i.citations.filter((c) => c.kind === 'test' && c.path).map((c) => c.path!));
  const rerun = testPaths.length ? `npx vitest run ${[...new Set(testPaths)].join(' ')}` : 'No test citations were recorded; inspect the frozen audit evidence directly.';
  const brief = [
    `You are the dedicated acceptance judge for plan ${planSlug}. Grade rubric ${rubricRef} as a fresh non-implementer.`,
    'Do not modify implementation files, run shell commands, recruit peers, or broaden scope. Inspect the frozen evidence below, spot-check cited source/tests with read-only tools, and emit exactly one complete scorecards:emit verdict with concrete evidence for every criterion. After a successful create or unchanged-evidence result, the scorecard writer terminates this task automatically.',
    `Recorded rerun command (for provenance; your judge policy forbids executing Bash): ${rerun}`,
    `FROZEN_ACCEPTANCE_CONTEXT=${snapshot}`,
  ].join('\n\n');

  try {
    const result = (await (deps.launch ?? launchAgentTool.handler)(
      {
        brief,
        harness: plan.row.harnessSlug,
        headless: true,
        agent: 'claude',
        count: 1,
        members: [{ role: 'judge' }],
        label,
        idempotencyKey,
      } as never,
      ctx,
    )) as { isError?: boolean; content?: Array<{ text?: string }>; data?: { deduped?: boolean; launch?: unknown } };
    if (result.isError) {
      return { state: 'failed', idempotencyKey, label, launch: result.data?.launch, error: result.content?.[0]?.text ?? 'acceptance grader launch failed' };
    }
    return { state: result.data?.deduped ? 'deduped' : 'launched', idempotencyKey, label, launch: result.data?.launch };
  } catch (error) {
    return { state: 'failed', idempotencyKey, label, error: error instanceof Error ? error.message : String(error) };
  }
}
