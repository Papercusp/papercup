'use client';

/**
 * Grouped Plans clean-up report (cleanup-report-flows-2026-08-24 P-007).
 * The report is presentation + orchestration only: every selected mutation
 * goes through the same plans-api helper a hand edit uses, and only after that
 * succeeds does the run's `accept` bookkeeping advance.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  setItemStatus,
  setPlanArchived,
  setPlanLifecycleStatus,
  writeError,
} from '@/app/admin/plans/plans-api';
import ReviewReportShell, {
  type ReviewReportGroup,
  type ReviewReportRow,
  type ReviewRowStatus,
} from '../review-report/ReviewReportShell';
import {
  derivePlanCleanupCounts,
  usePlanCleanupOps,
  type PlanCleanupFinding,
  type PlanCleanupRun,
} from './use-plan-cleanup-run';
import './plan-cleanup-report.css';

type ActionableFindingKind =
  | 'flip-to-done'
  | 'cleared-blocker'
  | 'finish-plan'
  | 'archive-candidate';

const ACTIONABLE_KINDS: ReadonlySet<string> = new Set<ActionableFindingKind>([
  'flip-to-done',
  'cleared-blocker',
  'finish-plan',
  'archive-candidate',
]);

const GROUPS: ReadonlyArray<{
  id: string;
  title: string;
  description: string;
  kinds: ReadonlySet<string>;
}> = [
  {
    id: 'flip-to-done',
    title: 'Flip items to done',
    description: 'Plan items whose linked work finished but whose stored status did not move.',
    kinds: new Set(['flip-to-done']),
  },
  {
    id: 'clear-stale-blockers',
    title: 'Clear stale blockers and claims',
    description: 'Blockers that are terminal and expired claims whose holder is gone.',
    kinds: new Set(['cleared-blocker', 'orphaned-claim']),
  },
  {
    id: 'finish-or-archive',
    title: 'Finish or archive plans',
    description: 'Plans whose items are terminal, plus old completed plans recommended for archive.',
    kinds: new Set(['finish-plan', 'archive-candidate']),
  },
  {
    id: 'refresh-now',
    title: 'Refresh Now',
    description: 'Now sections that point only at finished work and other authored recommendations.',
    kinds: new Set(['stale-now', 'semantic']),
  },
];

function reviewStatus(finding: PlanCleanupFinding, locallyApplied: ReadonlySet<string>): ReviewRowStatus {
  if (locallyApplied.has(finding.findingId)) return 'applied';
  if (finding.outcome === 'auto_applied' || finding.outcome === 'accepted') return 'applied';
  if (
    finding.outcome === 'dismissed' ||
    finding.outcome === 'skipped' ||
    finding.outcome === 'failed'
  ) {
    return 'dismissed';
  }
  return 'pending';
}

function manualReason(finding: PlanCleanupFinding): string | null {
  if (finding.outcome === 'pending') return 'The resolver did not reach this finding; no action is available.';
  if (finding.kind === 'stale-now') {
    return 'Open the plan and author its new State / Next text; the scanner records staleness, not replacement prose.';
  }
  if (finding.kind === 'orphaned-claim') {
    return 'Claim release is re-verified by the stale-claim reaper and is not a blind owner-side write.';
  }
  if (!ACTIONABLE_KINDS.has(finding.kind)) {
    return 'This recommendation has no registered hand-edit action and must be handled from its plan.';
  }
  return null;
}

function evidenceLines(finding: PlanCleanupFinding): string[] {
  const lines = finding.evidence.map((entry) =>
    [entry.kind, entry.ref, entry.note].filter(Boolean).join(' · '),
  );
  if (finding.error) lines.push(`error · ${finding.error}`);
  return lines.length > 0 ? lines : ['No evidence was recorded.'];
}

function reportRow(
  finding: PlanCleanupFinding,
  locallyApplied: ReadonlySet<string>,
  localErrors: ReadonlyMap<string, string>,
): ReviewReportRow {
  const status = reviewStatus(finding, locallyApplied);
  const reason = localErrors.get(finding.findingId) ?? manualReason(finding);
  return {
    id: finding.findingId,
    title: `${finding.planSlug}${finding.itemId ? `#${finding.itemId}` : ''} · ${finding.target}`,
    detail: reason ?? `${finding.from} → ${finding.to}`,
    evidence: evidenceLines(finding),
    confidence: finding.confidence,
    status,
    selectable:
      status === 'pending' &&
      finding.outcome === 'recommended' &&
      ACTIONABLE_KINDS.has(finding.kind),
  };
}

/** Pure report projection, exported so grouping/selection policy is pinned
 * independently from React and network behavior. */
export function buildPlanCleanupReviewGroups(
  findings: readonly PlanCleanupFinding[],
  locallyApplied: ReadonlySet<string> = new Set(),
  localErrors: ReadonlyMap<string, string> = new Map(),
): ReviewReportGroup[] {
  const assigned = new Set<string>();
  const groups = GROUPS.map((group) => {
    const rows = findings
      .filter((finding) => group.kinds.has(finding.kind))
      .map((finding) => {
        assigned.add(finding.findingId);
        return reportRow(finding, locallyApplied, localErrors);
      });
    return { ...group, rows };
  }).filter((group) => group.rows.length > 0);

  const other = findings
    .filter((finding) => !assigned.has(finding.findingId))
    .map((finding) => reportRow(finding, locallyApplied, localErrors));
  if (other.length > 0) {
    groups.push({
      id: 'other',
      title: 'Other recommendations',
      description: 'Resolver findings without a first-class hand-edit action.',
      kinds: new Set(),
      rows: other,
    });
  }
  return groups;
}

export async function applyPlanCleanupFinding(
  finding: PlanCleanupFinding,
): Promise<{ ok: boolean; error?: string }> {
  const harness = finding.harnessSlug ?? undefined;
  try {
    if (finding.kind === 'flip-to-done' || finding.kind === 'cleared-blocker') {
      if (!finding.itemId) return { ok: false, error: 'finding has no plan item id' };
      const result = await setItemStatus({
        slug: finding.planSlug,
        itemId: finding.itemId,
        status: finding.kind === 'flip-to-done' ? 'done' : 'todo',
        ...(harness ? { harness } : {}),
      });
      const error = writeError(result);
      return error ? { ok: false, error } : { ok: true };
    }
    if (finding.kind === 'finish-plan') {
      return await setPlanLifecycleStatus(finding.planSlug, 'shipped', harness);
    }
    if (finding.kind === 'archive-candidate') {
      const result = await setPlanArchived({
        slug: finding.planSlug,
        archived: true,
        ...(harness ? { harness } : {}),
      });
      const error = writeError(result);
      return error ? { ok: false, error } : { ok: true };
    }
    return { ok: false, error: manualReason(finding) ?? 'finding is not owner-applicable' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface PlanCleanupReportProps {
  run: PlanCleanupRun;
  findings: PlanCleanupFinding[];
  onClose: () => void;
}

export default function PlanCleanupReport({ run, findings, onClose }: PlanCleanupReportProps) {
  const { accept, dismiss } = usePlanCleanupOps();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [locallyApplied, setLocallyApplied] = useState<Set<string>>(() => new Set());
  const [localErrors, setLocalErrors] = useState<Map<string, string>>(() => new Map());
  const byId = useMemo(() => new Map(findings.map((finding) => [finding.findingId, finding])), [findings]);
  const groups = useMemo(
    () => buildPlanCleanupReviewGroups(findings, locallyApplied, localErrors),
    [findings, locallyApplied, localErrors],
  );
  const counts = derivePlanCleanupCounts(findings);
  const planCount = new Set(findings.map((finding) => finding.planSlug)).size;

  const onApply = useCallback(
    async (selectedIds: string[]) => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      let finalPhase: PlanCleanupRun['phase'] | null | undefined;
      try {
        for (const findingId of selectedIds) {
          const finding = byId.get(findingId);
          if (!finding) {
            setLocalErrors((previous) => new Map(previous).set(findingId, 'Finding disappeared from the run.'));
            continue;
          }
          const applied = await applyPlanCleanupFinding(finding);
          if (!applied.ok) {
            setLocalErrors((previous) =>
              new Map(previous).set(findingId, applied.error ?? 'The hand-edit write failed.'),
            );
            continue;
          }

          // Resolve first, record second. Mark local success immediately so a
          // bookkeeping failure cannot invite a second mutation in this view.
          setLocallyApplied((previous) => new Set(previous).add(findingId));
          const recorded = await accept(
            run.runId,
            findingId,
            `Grouped report accepted: ${finding.from} → ${finding.to}`,
          );
          if (!recorded.ok) {
            setLocalErrors((previous) =>
              new Map(previous).set(
                findingId,
                `Change applied, but run bookkeeping failed: ${recorded.error ?? 'unknown error'}`,
              ),
            );
            continue;
          }
          finalPhase = recorded.phase;
        }
        if (finalPhase === 'complete') onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, byId, accept, run.runId, onClose],
  );

  const onDismiss = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await dismiss(run.runId);
      onClose();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy, dismiss, run.runId, onClose]);

  return (
    <ReviewReportShell
      key={run.runId}
      title="Plan clean-up report"
      subtitle={
        <span className="plan-cleanup-report__subtitle">
          <span>
            {counts.forReview} proposed fix{counts.forReview === 1 ? '' : 'es'} across {planCount}{' '}
            plan{planCount === 1 ? '' : 's'} · {counts.applied} already applied
          </span>
          {notice ? <span role="alert" className="plan-cleanup-report__error">{notice}</span> : null}
        </span>
      }
      groups={groups}
      busy={busy}
      applyLabel="Apply selected"
      dismissLabel="Dismiss report"
      onApply={(ids) => void onApply(ids)}
      onDismiss={() => void onDismiss()}
      footer={
        <span>
          <strong>Hand-edit guarantee.</strong> Selected rows dispatch through the existing{' '}
          <code>plans:set-status</code>, <code>plans:set-plan-status</code>, or{' '}
          <code>plans:set-archived</code> client paths before acceptance is recorded. Clear a checkbox
          to skip it in this apply. Rows marked ↗ need authored/manual input and are never selected.
        </span>
      }
    />
  );
}
