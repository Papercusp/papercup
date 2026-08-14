/** Dedicated, frozen acceptance-grader launch for the plan completion gate. */
import { createHash } from 'node:crypto';
import launchAgentTool from './agent-tools/capability/launch-agent';
import { readPlanBySlug } from './agent-tools/plans/source';
import { getLatestPlanAudit, summarizeCoverage } from './plan-audits';
import { getAcceptanceRubricForPlan } from './rubrics';
import { listWorkItems } from './work-items';

type LaunchCtx = Parameters<typeof launchAgentTool.handler>[1];

export type AcceptanceGraderLifecycle = {
  state: 'launched' | 'deduped' | 'failed';
  idempotencyKey: string;
  label: string;
  launch?: unknown;
  error?: string;
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
