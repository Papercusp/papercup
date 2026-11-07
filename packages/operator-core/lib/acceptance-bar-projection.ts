import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { specBehaviorNonAtomicReason } from './agent-tools/plans/spec-clause-compiler';

/** A failed check is evidence about this exact candidate, never a reusable pass. */
export class AcceptanceBarCandidateError extends Error {
  readonly candidateValidation: { candidateHash: string; status: 'failed'; issues: string[] };

  constructor(candidate: unknown, issues: string[]) {
    super(`invalid_args: acceptance_bar_candidate_invalid: ${issues.join('; ')}`);
    this.name = 'AcceptanceBarCandidateError';
    this.candidateValidation = {
      candidateHash: acceptanceBarCandidateHash(candidate), status: 'failed', issues,
    };
  }
}

/** Omit only the server-generated time; lifecycle and author remain reviewed. */
export function acceptanceBarCriterionWithoutDeclarationTime(criterion: unknown): unknown {
  if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return criterion;
  const record = criterion as Record<string, unknown>;
  const provenance = record.barProvenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return criterion;
  const { declaredAt: _serverTime, ...reviewedProvenance } = provenance as Record<string, unknown>;
  return { ...record, barProvenance: reviewedProvenance };
}

export function acceptanceBarCandidateHash(candidate: unknown): string {
  // Newly added BARs receive a server declaration timestamp on every preview
  // and again at apply. It is not reviewed meaning; retaining it makes an
  // unchanged candidate fail its own second preflight. Keep the other provenance
  // fields (including lifecycle and actor), source, and generated clauses pinned.
  let reviewedCandidate = candidate;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    const template = record.templateData;
    if (template && typeof template === 'object' && !Array.isArray(template)) {
      const data = template as Record<string, unknown>;
      if (Array.isArray(data.criteria)) reviewedCandidate = {
        ...record,
        templateData: { ...data, criteria: data.criteria.map(acceptanceBarCriterionWithoutDeclarationTime) },
      };
    }
  }
  return createHash('sha256').update(canonicalJson(reviewedCandidate)).digest('hex');
}

export interface AcceptanceBarProjectionText {
  key: string;
  barKey?: string | null;
  title?: string | null;
  model?: string | null;
  role?: string | null;
}

export interface AcceptanceBarAtomicityIssue {
  barKey: string;
  behavior: string;
  reason: string;
}

/** The behavior persisted to AUTO-BAR clauses, after removing a repeated title. */
export function acceptanceBarProjectedBehavior(
  criterion: { title?: string | null; model?: string | null },
): string {
  const model = String(criterion.model ?? '').trim();
  const title = String(criterion.title ?? '').trim().replace(/[.\s]+$/, '');
  if (!model || !title) return model;
  const prefix = `${title}.`;
  if (!model.startsWith(prefix)) return model;
  const rest = model.slice(prefix.length).replace(/^\s+/, '');
  return rest.length > 0 ? rest : model;
}

/**
 * Find added or meaning-changed outcome BARs whose derived AUTO-BAR behavior is
 * non-atomic. Unchanged legacy BAR text is left intact so unrelated rubric edits
 * do not turn old data into a write blocker.
 */
export function acceptanceBarAtomicityIssues(
  next: readonly AcceptanceBarProjectionText[],
  prior: readonly AcceptanceBarProjectionText[] = [],
): AcceptanceBarAtomicityIssue[] {
  const priorOutcomes = new Map(
    prior
      .filter((criterion) => criterion.role !== 'disclosure')
      .map((criterion) => [criterion.barKey?.trim() || criterion.key.trim(), acceptanceBarProjectedBehavior(criterion)]),
  );

  return next.flatMap((criterion) => {
    if (criterion.role === 'disclosure') return [];
    const barKey = criterion.barKey?.trim() || criterion.key.trim();
    const behavior = acceptanceBarProjectedBehavior(criterion);
    if (priorOutcomes.get(barKey) === behavior) return [];
    const reason = specBehaviorNonAtomicReason(behavior);
    return reason ? [{ barKey, behavior, reason }] : [];
  });
}

export function assertChangedAcceptanceBarProjectionsAtomic(
  next: readonly AcceptanceBarProjectionText[],
  prior: readonly AcceptanceBarProjectionText[] = [],
): void {
  const issues = acceptanceBarAtomicityIssues(next, prior);
  if (issues.length === 0) return;
  throw new Error(
    'invalid_args: acceptance_bar_non_atomic_projection — ' +
      issues.map(({ barKey, reason }) => `${barKey}:${reason}`).join('; ') +
      '. Split each added or meaning-changed outcome BAR into one observable behavior before proposing or amending it.',
  );
}
