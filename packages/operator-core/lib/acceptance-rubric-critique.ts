/** Current independent rubric critique, read from the existing consult/review records. */
import type { Rubric } from './rubrics';
import { pgTimestampToIsoOrNull } from './pg-timestamp';

export interface AcceptanceRubricCritique {
  consultId: string | null;
  workItemId: string | null;
  createdAt: string;
  rubricRevision: number | null;
  criteriaHash: string | null;
  critics: string[];
}

export interface RubricCritiqueCandidate {
  consultId?: string;
  workItemId?: string;
  request: string;
  createdAt: string;
}

/** A subject mention alone never establishes which version was reviewed. */
export function critiqueCoversRubric(request: string, rubric: Rubric, revision: number | null): boolean {
  const escaped = rubric.rubricId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = `(?<![\\w-])${escaped}(?![\\w-])`;
  if (!new RegExp(mention, 'i').test(request)) return false;
  // Prefer the content identity: a cosmetic revision bump does not invalidate critique.
  if (rubric.criteriaHash && request.includes(rubric.criteriaHash)) return true;
  // An explicit revision is usable only when no contradictory content hash was supplied.
  if (/criteriaHash\s*[:=]?\s*[`"']?\w+/i.test(request)) return false;
  // A rubric@revision pin belongs to this rubric, unlike a different plan's
  // "revision" in the same request. Explicit stale or malformed pins must not
  // fall through to that unrelated revision, nor may conflicting pins qualify.
  const pins = [...request.matchAll(new RegExp(`${mention}@`, 'gi'))];
  if (pins.length > 0) {
    return revision != null && pins.every(pin =>
      new RegExp(`^${revision}(?![\\w.@-])`).test(request.slice(pin.index! + pin[0].length)));
  }
  // A prose revision must be attached to this rubric. An amendment request can
  // mention a subject-plan revision or a proposed revision in its embedded delta;
  // neither identifies the rubric that the reviewer actually read.
  const versions = [...request.matchAll(new RegExp(`${mention}[\\s:=(,]*rev(?:ision)?[\\s:=#]*`, 'gi'))];
  return revision != null && versions.length > 0 && versions.every(version =>
    new RegExp(`^${revision}(?![\\w.@-])`).test(request.slice(version.index! + version[0].length)));
}

type RubricReviewWorkItem = {
  id: string;
  title: string;
  summary?: string | null;
  updatedAt: string;
};

type RubricReviewWorkItemList = (filter: {
  q: string; kind: 'task'; includeChildren: true; includePayload: false;
}) => Promise<readonly RubricReviewWorkItem[]>;

type CritiqueDeps = {
  candidates: (rubric: Rubric) => Promise<RubricCritiqueCandidate[]>;
  consultCandidates?: (rubric: Rubric) => Promise<RubricCritiqueCandidate[]>;
  listReviewWorkItems?: RubricReviewWorkItemList;
  consult: (id: string, rubric: Rubric) => Promise<{ exists: boolean; critiquePosts: number; critics: string[] }>;
  workItem: (id: string, rubric: Rubric) => Promise<{ exists: boolean; critiquePosts: number; critics: string[] }>;
};

function workItemCritiqueCandidates(items: readonly RubricReviewWorkItem[]): RubricCritiqueCandidate[] {
  return items.map(item => {
    if (!Number.isFinite(Date.parse(item.updatedAt)))
      throw new Error(`Unreadable acceptance rubric critique candidate: ${item.id}`);
    return {
      workItemId: item.id,
      request: `${item.title}\n${item.summary ?? ''}`,
      createdAt: item.updatedAt,
    };
  });
}

async function defaultCandidates(rubric: Rubric, deps: Partial<CritiqueDeps> = {}): Promise<RubricCritiqueCandidate[]> {
  let candidates: RubricCritiqueCandidate[];
  if (deps.consultCandidates) {
    candidates = await deps.consultCandidates(rubric);
  } else {
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;
    const rows = await sql`
      SELECT cs.conversation_id,
             CASE WHEN cs.outcome->>'source' = 'archive' THEN source.question ELSE cs.question END AS question,
             CASE WHEN cs.outcome->>'source' = 'archive' THEN source.updated_at ELSE cs.updated_at END AS updated_at
        FROM harness_shared.consult_state cs
        LEFT JOIN harness_shared.consult_state source
          ON source.workspace_id = cs.workspace_id
         AND source.conversation_id = cs.outcome->>'source_conversation_id'
       WHERE cs.workspace_id = ${rubric.workspaceId}
         AND cs.question ILIKE ${'%' + rubric.rubricId + '%'}
       ORDER BY cs.updated_at DESC, cs.conversation_id
    `;
    candidates = rows.map(row => {
      const createdAt = pgTimestampToIsoOrNull(row.updated_at);
      if (typeof row.conversation_id !== 'string' || typeof row.question !== 'string'
        || !createdAt || !Number.isFinite(Date.parse(createdAt)))
        throw new Error(`Unreadable acceptance rubric critique candidate: ${row.conversation_id}`);
      return { consultId: row.conversation_id, request: row.question, createdAt };
    });
  }
  // Both populations are complete internal reads, kept off the model transport.
  // A ranked search prefix cannot establish absence of an eligible older review.
  // Reuse the uncapped reader, including child reviews; preserve its full summary
  // because it holds the opening request checked below. No partial cursor survives
  // a failed read: retries re-read both complete sources before deciding absence.
  const listReviews = deps.listReviewWorkItems ?? (await import('./work-items')).listAllWorkItemsForFileExport;
  const reviews = await listReviews({
    q: rubric.rubricId, kind: 'task', includeChildren: true, includePayload: false,
  });
  candidates.push(...workItemCritiqueCandidates(reviews));
  return candidates;
}

export async function readCurrentAcceptanceRubricCritique(
  rubric: Rubric,
  revision: number | null,
  deps: Partial<CritiqueDeps> = {},
): Promise<AcceptanceRubricCritique | null> {
  const candidates = deps.candidates
    ? await deps.candidates(rubric)
    : await defaultCandidates(rubric, deps);
  for (const candidate of candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    if (!critiqueCoversRubric(candidate.request, rubric, revision)) continue;
    let critique: { exists: boolean; critiquePosts: number; critics: string[] } | undefined;
    if (candidate.consultId) {
      if (deps.consult) critique = await deps.consult(candidate.consultId, rubric);
      else {
        const [{ getOrgPg }, { readVettingConsultCritique }] = await Promise.all([
          import('@papercusp/db-org'), import('./consult/get-feedback-core'),
        ]);
        critique = await readVettingConsultCritique(getOrgPg().sql, rubric.workspaceId,
          candidate.consultId, rubric.createdBy ?? rubric.proposedBy ?? '', [rubric.rubricId]);
      }
    } else if (candidate.workItemId) {
      if (deps.workItem) critique = await deps.workItem(candidate.workItemId, rubric);
      else {
        const { readVettingWorkItemCritique } = await import('./work-items');
        critique = await readVettingWorkItemCritique(candidate.workItemId, [rubric.createdBy, rubric.proposedBy]);
      }
    }
    const critics = critique?.critics.filter(id => id !== rubric.createdBy && id !== rubric.proposedBy) ?? [];
    if (!critique?.exists || critique.critiquePosts < 1 || critics.length === 0) continue;
    return { consultId: candidate.consultId ?? null, workItemId: candidate.workItemId ?? null,
      createdAt: candidate.createdAt, rubricRevision: revision, criteriaHash: rubric.criteriaHash ?? null, critics };
  }
  return null;
}
