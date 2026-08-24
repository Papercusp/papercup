'use client';

/**
 * PlansCleanupStrip (cleanup-report-flows-2026-08-24 P-006) — one command
 * slot under the Plans masthead, following the owner-approved Inbox bulk strip
 * vocabulary exactly: idle → running → review. Review-at-volume itself belongs
 * to P-007; this strip carries the run into that surface through `?opcln=`.
 */
import { useCallback, useState } from 'react';
import {
  BrushCleaning,
  ChevronRight,
  Loader2,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { formatRunElapsed } from '../review-report/bulk-run-time';
import {
  derivePlanCleanupCounts,
  usePlanCleanupOps,
  type PlanCleanupFinding,
  type PlanCleanupRun,
} from './use-plan-cleanup-run';
// Deliberate visual reuse: the approved mockup lifts this exact strip grammar
// from Inbox bulk resolve. Sharing its CSS keeps both flows one learned control
// instead of creating a near-identical style system that can drift.
import '../inbox/inbox-bulk.css';

export interface PlansCleanupStripProps {
  /** Exact click-time set currently rendered by PlansPane. */
  planSlugs: readonly string[];
  filterSnapshot: Record<string, unknown>;
  run: PlanCleanupRun | null;
  findings: PlanCleanupFinding[];
  recommendations: PlanCleanupFinding[];
  pending: PlanCleanupFinding[];
  isRunning: boolean;
  isReview: boolean;
  onRunStarted: (runId: string) => void;
  /** Opens/retains the `?opcln=` report deep link for P-007. */
  onReview: (runId: string) => void;
  /** Clears `?opcln=` after a deliberate dismiss. */
  onRunCleared: () => void;
}

export default function PlansCleanupStrip({
  planSlugs,
  filterSnapshot,
  run,
  findings,
  recommendations,
  pending,
  isRunning,
  isReview,
  onRunStarted,
  onReview,
  onRunCleared,
}: PlansCleanupStripProps) {
  const { start, stop, dismiss } = usePlanCleanupOps();
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const counts = derivePlanCleanupCounts(findings);

  const onStart = useCallback(async () => {
    if (planSlugs.length === 0 || starting) return;
    setStarting(true);
    setNotice(null);
    try {
      const result = await start(planSlugs, filterSnapshot);
      if (!result.ok) {
        setNotice(result.error ?? 'could not start the clean-up run');
        return;
      }
      if (result.runId) onRunStarted(result.runId);
      // The request succeeds once the run is durable even when its supervised
      // resolver did not boot. Surface that persisted failure instead of
      // leaving a run that can never move looking live.
      if (!result.launched) {
        setNotice(
          `resolver could not start${result.launchError ? `: ${result.launchError}` : ''}`,
        );
      }
    } finally {
      setStarting(false);
    }
  }, [planSlugs, starting, start, filterSnapshot, onRunStarted]);

  const onStop = useCallback(async () => {
    if (!run || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await stop(run.runId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [run, busy, stop]);

  const onDismiss = useCallback(async () => {
    if (!run || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await dismiss(run.runId);
      onRunCleared();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [run, busy, dismiss, onRunCleared]);

  if (isRunning && run) {
    const scanOnly = counts.total === 0;
    return (
      <div className="op-inbox__bulk op-inbox__bulk--running" data-testid="plans-cleanup-running">
        <div className="op-inbox__bulk-head">
          <span className="op-inbox__bulk-spin" aria-hidden="true">
            <Loader2 size={15} />
          </span>
          <span className="op-inbox__bulk-title">
            {scanOnly
              ? `Papercup is scanning ${run.totalItems} shown plan${run.totalItems === 1 ? '' : 's'}…`
              : 'Papercup is cleaning up…'}
          </span>
          <span className="op-inbox__bulk-spacer" />
          <button
            type="button"
            className="op-inbox__bulk-ghost"
            data-testid="plans-cleanup-stop"
            disabled={busy}
            onClick={() => void onStop()}
          >
            <Square size={11} aria-hidden="true" />
            Stop
          </button>
        </div>
        <div
          className="op-inbox__bulk-track"
          role="progressbar"
          aria-valuenow={scanOnly ? undefined : counts.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={
            scanOnly
              ? `Scanning ${run.totalItems} plans`
              : `${counts.decided} of ${counts.total} findings decided`
          }
          aria-label="Plan clean-up progress"
        >
          <div
            className="op-inbox__bulk-fill"
            style={{ width: scanOnly ? '2%' : `${counts.percent}%` }}
          />
        </div>
        <div className="op-inbox__bulk-counts" data-testid="plans-cleanup-counts">
          {scanOnly ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" />
              finding stale state and cleared blockers
            </span>
          ) : (
            <>
              <span className="op-inbox__bulk-count op-inbox__bulk-count--good">
                <i aria-hidden="true" />
                {counts.applied} tidied
              </span>
              <span className="op-inbox__bulk-count op-inbox__bulk-count--review">
                <i aria-hidden="true" />
                {counts.forReview} for review
              </span>
              <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
                <i aria-hidden="true" />
                {counts.pending} left
              </span>
            </>
          )}
        </div>
        {notice ? <Notice text={notice} onClose={() => setNotice(null)} /> : null}
      </div>
    );
  }

  if (isReview && run) {
    const elapsed = formatRunElapsed(run.startedAt, run.finishedAt);
    const awaiting = recommendations.length;
    return (
      <div className="op-inbox__bulk op-inbox__bulk--review" data-testid="plans-cleanup-review">
        <div className="op-inbox__bulk-head">
          <span className="op-inbox__bulk-icon op-inbox__bulk-icon--review" aria-hidden="true">
            <Sparkles size={16} />
          </span>
          <span className="op-inbox__bulk-title" data-testid="plans-cleanup-review-headline">
            {awaiting} fix{awaiting === 1 ? '' : 'es'} need your call · {counts.applied} auto-applied
            {pending.length > 0 ? ` · ${pending.length} not reached` : ''}
            {counts.failed > 0 ? ` · ${counts.failed} failed` : ''}
          </span>
          <span className="op-inbox__bulk-spacer" />
          {elapsed ? <span className="op-inbox__bulk-elapsed">run {elapsed}</span> : null}
        </div>
        <div className="op-inbox__bulk-actions">
          <button
            type="button"
            className="op-inbox__bulk-accept-all"
            data-testid="plans-cleanup-open-review"
            disabled={awaiting === 0 || busy}
            onClick={() => onReview(run.runId)}
          >
            <ChevronRight size={14} aria-hidden="true" />
            Review {awaiting} fix{awaiting === 1 ? '' : 'es'}
          </button>
          <button
            type="button"
            className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide"
            data-testid="plans-cleanup-dismiss"
            disabled={busy}
            onClick={() => void onDismiss()}
          >
            Dismiss
          </button>
        </div>
        <p className="op-inbox__bulk-hint">
          Review the findings grouped by fix type, with recorded evidence beside every change.
        </p>
        {notice ? <Notice text={notice} onClose={() => setNotice(null)} /> : null}
      </div>
    );
  }

  const failureNotice = notice ?? (run?.phase === 'failed' ? run.error ?? 'clean-up run failed' : null);
  const count = planSlugs.length;
  return (
    <div className="op-inbox__bulk-slot" data-testid="plans-cleanup-idle">
      <button
        type="button"
        className="op-inbox__bulk-start"
        data-testid="plans-cleanup-start"
        disabled={count === 0 || starting}
        aria-label={`Clean up ${count} shown plan${count === 1 ? '' : 's'}`}
        onClick={() => void onStart()}
      >
        <span className="op-inbox__bulk-icon" aria-hidden="true">
          {starting ? (
            <span className="op-inbox__bulk-spin">
              <Loader2 size={17} />
            </span>
          ) : (
            <BrushCleaning size={17} />
          )}
        </span>
        <span className="op-inbox__bulk-start-copy">
          <span className="op-inbox__bulk-start-title">
            Clean up {count} shown plan{count === 1 ? '' : 's'}
          </span>
          <span className="op-inbox__bulk-start-sub">
            Reconciles stale statuses, cleared blockers &amp; finished work · you review the rest
          </span>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
      {failureNotice ? <Notice text={failureNotice} onClose={() => setNotice(null)} /> : null}
    </div>
  );
}

function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="op-inbox__bulk-notice" role="alert">
      <span>{text}</span>
      <button
        type="button"
        className="op-inbox__bulk-notice-x"
        aria-label="Dismiss clean-up notice"
        onClick={onClose}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
