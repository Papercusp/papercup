/** Bounded continuation over the existing checkpoint and spec-evidence stores. */
import { createHash } from 'node:crypto';
import { compareWorkItemSubjectFingerprint, parseCarryNote, shortCarryHash, type WorkItemSubject } from '../../carry-note';
import { getWorkItemCheckpointWithMeta, getWorkItemCheckpointFreshness, type WorkItemCheckpointWithMeta } from '../../work-item-checkpoint';
import { ADHOC_WORK_ITEM_SPEC_SCOPE, listSpecEvidence } from '../plans/spec-evidence-store';
import { compactTaskBrief, getClaimTimeTaskBrief, type TaskBrief } from '../../code-intelligence/task-brief';
import { admissionActionability } from '../../work-items-admission';
import { projectBlockerResolution } from '../../blocker-resolution-decision';

export const RESUME_PACKET_BUDGET = 5_000;
const EVIDENCE_READ_LIMIT = 9;
type ResumeItem = { id: string; harness?: string | null; state?: string | null; assignee?: string | null; payload?: unknown } & Partial<Pick<WorkItemSubject, 'kind' | 'title' | 'summary'>>;
type Checkpoint = WorkItemCheckpointWithMeta;
type Evidence = Awaited<ReturnType<typeof listSpecEvidence>>;
type ResumeDeps = {
  checkpoint: typeof getWorkItemCheckpointWithMeta;
  freshness: typeof getWorkItemCheckpointFreshness;
  evidence: typeof listSpecEvidence;
  taskBrief?: typeof getClaimTimeTaskBrief;
};

function planOf(item: ResumeItem): { slug: string; item: string | null } | null {
  const payload = item.payload as { plan_item?: { plan_slug?: unknown; item_id?: unknown } } | null;
  const plan = payload?.plan_item;
  return typeof plan?.plan_slug === 'string'
    ? { slug: plan.plan_slug, item: typeof plan.item_id === 'string' ? plan.item_id : null }
    : null;
}

/**
 * EI-26988974367709614: the SAME contract the self-select `admission_hold` floor applies, so
 * a row the scheduler serves is never one resume forbids acting on. A hold blocks; a pending
 * post-hoc review on a fail-open row is a caution, because that row is claimable by design.
 */
function admissionActionBlocker(item: ResumeItem): string | null {
  const verdict = admissionActionability(item.payload);
  return verdict.actionable ? null : verdict.reason;
}

function admissionCaution(item: ResumeItem): string | null {
  const verdict = admissionActionability(item.payload);
  return verdict.actionable ? verdict.caution : null;
}

/** Omit whole records to fit; never turn a partial next action into an instruction. */
export function buildWorkItemResume(input: {
  item: ResumeItem; checkpoint: Checkpoint; freshness: unknown; evidence: Evidence | null; taskBrief?: TaskBrief;
}) {
  const { item, checkpoint } = input;
  const plan = planOf(item);
  const admissionBlocker = admissionActionBlocker(item);
  const scope = { id: item.id, ...(item.harness && !item.id.startsWith('EI-') ? { harness: item.harness } : {}) };
  const subject = compareWorkItemSubjectFingerprint(item as WorkItemSubject, checkpoint.subjectFingerprint);
  const freshness = input.freshness as { verdict?: string; changed?: unknown[]; unresolvable?: unknown[] } | null;
  const dependenciesCurrent = (freshness?.verdict === 'fresh' || freshness?.verdict === 'recomputed')
    && !freshness.unresolvable?.length;
  const blockerResolution = projectBlockerResolution(item.payload, item);
  const blockerChanged = blockerResolution?.status === 'recorded'
    && Date.parse(blockerResolution.current.recordedAt) > (checkpoint.updatedAtMs ?? 0);
  const fields = checkpoint.readFailed || checkpoint.checkpoint === null ? {} : parseCarryNote(checkpoint.checkpoint);
  const latest = checkpoint.latestUpdate;
  const latestFields = latest?.text ? parseCarryNote(latest.text) : fields;
  const latestNext = latest?.status === 'available' ? latestFields.next?.trim() || null : null;
  const checkpointNext = fields.next?.split(/\n\n---(?:\n|$)/)[0].trim() || null;
  // A newer progress/insight update can supersede the historical action without
  // naming another one. Its hash-bound provenance does not renew an older Next.
  const ambiguous = latest?.status === 'unknown'
    || (!latest && /^---\s*$/m.test(checkpoint.checkpoint ?? ''))
    || (latest?.status === 'available' && latestNext === null && checkpointNext !== null);
  const next = ambiguous ? null : latest?.status === 'available' ? latestNext : checkpointNext;
  // Archive identity never certifies current subject, dependencies or authority.
  // A newer canonical blocker decision takes precedence over the prose it replaces.
  const unknownNext = checkpoint.readFailed || ambiguous || subject.status !== 'current'
    || !dependenciesCurrent || blockerChanged || blockerResolution?.status === 'invalid';
  const resume = {
    schemaVersion: 'work-item-resume-v1',
    taskBrief: undefined as TaskBrief | { status: 'omitted'; recover: TaskBrief['recover'] } | undefined,
    claim: { id: item.id, assignee: item.assignee ?? null, state: item.state ?? null },
    plan,
    blockerResolution,
    authority: {
      status: 'requires-current-control',
      note: 'Continuation text is not execution authority. Resync changed or unknown live control; archive hashes do not renew claim, mode, admission or peer ownership.',
      readRef: { tool: 'coord:orient', args: { afterCompaction: true } },
    },
    nextAction: admissionBlocker
      ? { status: 'blocked', text: null, reason: admissionBlocker }
      : {
        status: next === null && !checkpoint.readFailed && !ambiguous ? 'missing' : unknownNext ? 'unknown' : 'available',
        text: unknownNext ? null : next,
        ...(!unknownNext && latest?.status === 'available' && next !== null
          ? { source: 'next-action' }
          : {}),
        ...(admissionCaution(item) ? { admissionCaution: admissionCaution(item) } : {}),
      },
    checkpoint: {
      status: checkpoint.readFailed ? 'unknown' : checkpoint.checkpoint === null ? 'absent' : 'available',
      updatedAtMs: checkpoint.updatedAtMs,
      contentHash: checkpoint.readFailed || checkpoint.checkpoint === null ? null : shortCarryHash(checkpoint.checkpoint),
      contentSha256: checkpoint.readFailed || checkpoint.checkpoint === null ? null
        : createHash('sha256').update(checkpoint.checkpoint, 'utf8').digest('hex'),
      subjectFingerprint: subject,
      freshness: input.freshness ?? { verdict: 'unknown', reason: 'no measured dependency verdict' },
      // Preserve the continuation mode in the recovery reference. Omitting
      // `resume:true` silently replays an ordinary full-row read, which drops
      // this bounded packet's next action and checkpoint metadata instead of
      // reproducing the continuation view the caller was given.
      readRef: { tool: 'work_items:get', args: { ...scope, resume: true } },
      sourceRef: { tool: 'work_items:get', args: { ...scope, checkpointOnly: true } },
    },
    checks: { rows: [] as unknown[], omitted: fields.checks?.length ?? 0 },
    walls: { rows: [] as unknown[], omitted: fields.walls?.length ?? 0 },
    evidence: {
      status: input.evidence === null ? 'unknown' : 'available', rows: [] as unknown[],
      omittedFromWindow: input.evidence?.length ?? null,
      hasMore: input.evidence === null ? null : input.evidence.length >= EVIDENCE_READ_LIMIT,
      readRef: { tool: 'plans:get-spec-evidence', args: {
        slug: plan?.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE, harness: item.harness ?? undefined,
        workItemIds: [item.id], limit: 100,
      } },
    },
  };
  if (JSON.stringify(resume.checkpoint.freshness).length > 400) {
    resume.checkpoint.freshness = {
      verdict: freshness?.verdict ?? 'unknown', detailsOmitted: true,
      changedCount: freshness?.changed?.length ?? null,
      unresolvableCount: freshness?.unresolvable?.length ?? null,
      readRef: { tool: 'work_items:get', args: { ...scope,
        projection: { pick: ['results[].checkpointFreshness'] } } },
    };
  }
  if (!admissionBlocker && JSON.stringify(resume).length > RESUME_PACKET_BUDGET) {
    resume.nextAction.status = 'oversized';
    resume.nextAction.text = null;
  }
  const append = (target: unknown[], row: unknown): boolean => {
    target.push(row);
    if (JSON.stringify(resume).length <= RESUME_PACKET_BUDGET) return true;
    target.pop();
    return false;
  };
  // Execution constraints precede proof; omitted counts always retain a recovery path.
  for (const wall of fields.walls ?? []) {
    if (append(resume.walls.rows, wall)) resume.walls.omitted -= 1;
  }
  if (resume.walls.omitted && !admissionBlocker) {
    resume.nextAction.status = 'oversized';
    resume.nextAction.text = null;
  }
  if (input.taskBrief) {
    const withoutBrief = JSON.stringify(resume).length;
    resume.taskBrief = input.taskBrief;
    const fieldOverhead = JSON.stringify({ ...resume, taskBrief: null }).length - withoutBrief - 4;
    resume.taskBrief = compactTaskBrief(input.taskBrief, RESUME_PACKET_BUDGET - withoutBrief - fieldOverhead);
    if (JSON.stringify(resume).length > RESUME_PACKET_BUDGET) {
      resume.taskBrief = { status: 'omitted', recover: input.taskBrief.recover };
      if (JSON.stringify(resume).length > RESUME_PACKET_BUDGET) resume.taskBrief = undefined;
    }
  }
  for (const row of (input.evidence ?? []).slice(0, EVIDENCE_READ_LIMIT - 1)) {
    const details = row.details as { adequacy?: { outcome?: unknown; causalPairIds?: unknown } };
    const proof = {
      id: row.id, specId: row.specId, specRevision: row.specRevision,
      evidenceKind: row.evidenceKind, evidenceRef: row.evidenceRef,
      testRunId: row.testRunId, coverageEvidenceRef: row.coverageEvidenceRef,
      currentness: row.currentness.overall, outcome: details.adequacy?.outcome ?? 'unknown',
      ...(details.adequacy?.causalPairIds ? { causalPairIds: details.adequacy.causalPairIds } : {}),
    };
    if (append(resume.evidence.rows, proof)) resume.evidence.omittedFromWindow! -= 1;
  }
  for (const check of fields.checks ?? []) {
    if (append(resume.checks.rows, check)) resume.checks.omitted -= 1;
  }
  return resume;
}

export async function readWorkItemResume(item: ResumeItem, deps: ResumeDeps = {
  checkpoint: getWorkItemCheckpointWithMeta,
  freshness: getWorkItemCheckpointFreshness,
  evidence: listSpecEvidence,
  taskBrief: getClaimTimeTaskBrief,
}) {
  const ref = { harness: item.harness ?? null, workItemId: item.id };
  const [checkpoint, freshness, evidence, source] = await Promise.all([
    deps.checkpoint(ref).catch(() => ({ checkpoint: null, updatedAtMs: null, readFailed: true })),
    deps.freshness(ref).catch(() => ({ verdict: 'unknown', reason: 'dependency read failed' })),
    deps.evidence({ harnessSlug: item.harness ?? undefined,
      planSlugs: [planOf(item)?.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE],
      workItemIds: [item.id], limit: EVIDENCE_READ_LIMIT,
    }).catch(() => null),
    deps.taskBrief?.({ workItem: item }).catch(() => null),
  ]);
  return buildWorkItemResume({ item, checkpoint, freshness, evidence, taskBrief: source?.taskBrief });
}
