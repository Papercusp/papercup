/**
 * semantic-dedup-probe-alarm — EI-22170937574367219: dedup screens fail OPEN
 * by design when a search leg is unavailable. That is correct for ordinary
 * captures: a filing must never be blocked by embedding or search health.
 *
 * But improvements:capture had no publisher for a degraded result: the response
 * included `dedupCoverage`, yet no durable signal identified repeated failures.
 * A separate work_items:create path already had an advisory for an unavailable
 * semantic probe because goal-mode creates can refuse under P-004.
 *
 * This module publishes a best-effort, deduplicated advisory for both paths:
 * `_create-core.ts` reports an unavailable semantic verdict, and
 * improvements:capture reports any `dedupCoverage.degraded` result. It reuses
 * the same dedup-by-(kind, signature) escalation primitive as the adjacent
 * embedding-desync alarm, so repeated occurrences bump one record's repeat
 * count instead of opening a new record per failed capture.
 *
 * Deliberately:
 *  - NEVER throws and NEVER rejects (internal try/catch; callers still treat
 *    the returned promise as fire-and-forget — see the call site).
 *  - NEVER logs via console. This codebase fails a vitest run on an
 *    unexpected console.warn/error (see
 *    `_create-core.goal-dedup-gate.test.ts`'s comment on the goal-context
 *    stamp for the precedent), and this path is exercised by ~15 existing
 *    dedup-gate test cases that mock `findSemanticDupes` to resolve `null`.
 *  - A NO-OP under vitest (checked first, before touching any real
 *    infrastructure) — mirrors the same-file convention in
 *    `semantic-dupe-guard.ts` (`if (process.env.VITEST && !deps) return
 *    null;`). This means the existing create-path test suites need no new
 *    mocking to stay green; this module's own behaviour is covered by its
 *    dedicated test file instead.
 */
import { openEscalation } from '../coordination/escalations';
import type { AgentIdentity } from '../coordination/identity';

const IDENTITY: AgentIdentity = {
  ownerId: 'system:semantic-dedup-probe-alarm',
  ownerLabel: 'system · semantic-dedup-probe-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

// Durable escalation dedup identity — bumps one open record's repeat count on
// every re-occurrence rather than opening a new one (same shape as
// embed-space-self-check.ts's DEDUP_KIND/SUBJECT_SIGNATURE).
const DEDUP_KIND = 'work-item-dedup-coverage-degraded';
const SUBJECT_SIGNATURE = 'papercusp-work-item-dedup';

export interface DedupCoverageDegradedDetail {
  source: 'work_items:create' | 'improvements:capture';
  /** The harness the degraded capture targeted, if known. */
  harnessSlug?: string;
  coverage?: { lexical?: string; semantic?: string; degraded?: boolean };
}

/**
 * Fire-and-forget: publish incomplete dedup coverage from any filing path.
 * The escalation is advisory and deduplicated so repeated failures raise the
 * same record's repeat count instead of opening one record per capture.
 */
export async function reportDedupCoverageDegraded(
  detail: DedupCoverageDegradedDetail,
): Promise<void> {
  if (process.env.VITEST) return; // never touch real infra under test — see file header
  try {
    await openEscalation(IDENTITY, {
      severity: 'advisory',
      summary:
        'Papercusp work-item dedup coverage is incomplete — empty duplicate results may miss existing work.',
      body:
        `A dedup screening attempt from ${detail.source}` +
        (detail.harnessSlug ? ` in harness '${detail.harnessSlug}'` : '') +
        ` reported incomplete coverage (lexical=${detail.coverage?.lexical ?? 'unknown'}, ` +
        `semantic=${detail.coverage?.semantic ?? 'unknown'}, degraded=${detail.coverage?.degraded ?? true}). ` +
        `An empty possibleDuplicates list is inconclusive while coverage is degraded. ` +
        `improvements:capture continues to accept filings by design; goal-mode work_items:create ` +
        `may refuse when its required probe is unavailable. Repeated observations are folded into ` +
        `this advisory. Check the embedding provider, query path, and coverage readings to identify ` +
        `the cause; this alert does not distinguish among them.`,
      meta: { dedupKind: DEDUP_KIND, subjectSignature: SUBJECT_SIGNATURE },
    });
  } catch {
    /* an alarm-send failure must never crash the request worker */
  }
}

/** Compatibility wrapper for the existing work_items:create call site. */
export async function reportSemanticDedupProbeUnavailable(detail: {
  harnessSlug?: string;
}): Promise<void> {
  await reportDedupCoverageDegraded({
    source: 'work_items:create',
    ...detail,
    coverage: { semantic: 'unavailable', degraded: true },
  });
}
