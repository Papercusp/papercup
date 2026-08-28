"use client";

/**
 * PlansCleanupStrip (cleanup-report-flows-2026-08-24 P-006) — one command
 * slot under the Plans masthead, following the owner-approved Inbox bulk strip
 * vocabulary exactly: idle → running → review. Review-at-volume itself belongs
 * to P-007; this strip carries the run into that surface through `?opcln=`.
 */
import { useCallback, useState } from "react";
import {
  BrushCleaning,
  ChevronRight,
  Loader2,
  RotateCw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { formatRunElapsed } from "../review-report/bulk-run-time";
import BulkResolverSettingsControl from "../bulk-resolver/BulkResolverSettingsControl";
import { useBulkResolverSettings } from "../bulk-resolver/bulk-resolver-settings";
import {
  canonicalPlanCleanupDisposition,
  derivePlanCleanupCounts,
  usePlanCleanupOps,
  type PlanCleanupFinding,
  type PlanCleanupRun,
} from "./use-plan-cleanup-run";
// Deliberate visual reuse: the approved mockup lifts this exact strip grammar
// from Inbox bulk resolve. Sharing its CSS keeps both flows one learned control
// instead of creating a near-identical style system that can drift.
import "../inbox/inbox-bulk.css";

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
  isRunning,
  isReview,
  onRunStarted,
  onReview,
  onRunCleared,
}: PlansCleanupStripProps) {
  const { start, stop, restart, resume, reclassify } = usePlanCleanupOps();
  const resolverSettings = useBulkResolverSettings("plan-cleanup");
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const counts = derivePlanCleanupCounts(findings);
  const retryableFindings = findings.filter(
    (finding) =>
      finding.outcome === "pending" ||
      finding.outcome === "failed" ||
      canonicalPlanCleanupDisposition(finding) === "retry_needed",
  );

  const onStart = useCallback(async () => {
    if (planSlugs.length === 0 || starting || !resolverSettings.ready) return;
    setStarting(true);
    setNotice(null);
    try {
      const result = await start(
        planSlugs,
        filterSnapshot,
        null,
        resolverSettings.profile,
      );
      if (!result.ok) {
        setNotice(result.error ?? "could not start the clean-up run");
        return;
      }
      if (result.runId) onRunStarted(result.runId);
      // No LLM is a SUCCESS when the fixed-point deterministic pass cleared
      // every provable finding and no recommendation work remained.
      if (result.resolverNeeded === false && !result.launchError) return;
      // The request succeeds once the run is durable even when its supervised
      // resolver did not boot. Surface that persisted failure instead of
      // leaving a run that can never move looking live.
      if (!result.launched) {
        setNotice(
          `resolver could not start${result.launchError ? `: ${result.launchError}` : ""}`,
        );
      }
    } finally {
      setStarting(false);
    }
  }, [
    planSlugs,
    starting,
    start,
    filterSnapshot,
    onRunStarted,
    resolverSettings,
  ]);

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

  const onRestart = useCallback(async () => {
    if (!run || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await restart(run.runId);
      if (!result.ok) {
        setNotice(result.error ?? "could not restart the resolver");
      } else if (!result.launched) {
        setNotice(
          `resolver could not restart${result.launchError ? `: ${result.launchError}` : ""}`,
        );
      } else {
        setNotice(
          `Resolver restarted · ${result.preservedOutcomes ?? 0} completed outcome${result.preservedOutcomes === 1 ? "" : "s"} preserved`,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [run, busy, restart]);

  const onResume = useCallback(async () => {
    if (!run || busy || retryableFindings.length === 0) return;
    const findingIds = retryableFindings.map((finding) => finding.findingId);
    setBusy(true);
    setNotice(null);
    try {
      const result = await resume(run.runId, findingIds);
      if (!result.ok) {
        setNotice(result.error ?? "could not continue the remaining findings");
      } else if (!result.launched) {
        setNotice(
          `resolver could not continue${result.launchError ? `: ${result.launchError}` : ""}`,
        );
      } else {
        const preserved = result.preservedOutcomes ?? 0;
        setNotice(
          `Continuing ${findingIds.length} remaining · ${preserved} prior outcome${preserved === 1 ? "" : "s"} preserved`,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [busy, retryableFindings, resume, run]);

  const onReclassify = useCallback(async () => {
    if (!run || classifying) return;
    setClassifying(true);
    setNotice(null);
    try {
      const result = await reclassify(run.runId);
      if (!result.ok) {
        setNotice(result.error ?? "could not classify legacy skipped findings");
      } else {
        setNotice(`Classified ${result.preservedOutcomes ?? 0} legacy findings; no outcomes changed`);
      }
    } finally {
      setClassifying(false);
    }
  }, [classifying, reclassify, run]);

  if (isRunning && run) {
    const scanOnly = counts.total === 0;
    return (
      <div
        className="op-inbox__bulk op-inbox__bulk--running"
        data-testid="plans-cleanup-running"
      >
        <BulkResolverSettingsControl
          kind="plan-cleanup"
          settings={resolverSettings}
          effective={run.launchSnapshot ?? {}}
          liveness={run.liveness}
          onRestart={() => void onRestart()}
          restartBusy={busy}
        />
        <div className="op-inbox__bulk-head">
          <span className="op-inbox__bulk-spin" aria-hidden="true">
            <Loader2 size={15} />
          </span>
          <span className="op-inbox__bulk-title">
            {scanOnly
              ? `Papercup is scanning ${run.totalItems} shown plan${run.totalItems === 1 ? "" : "s"}…`
              : "Papercup is cleaning up…"}
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
            style={{ width: scanOnly ? "2%" : `${counts.percent}%` }}
          />
        </div>
        <div
          className="op-inbox__bulk-counts"
          data-testid="plans-cleanup-counts"
        >
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
        {notice ? (
          <Notice text={notice} onClose={() => setNotice(null)} />
        ) : null}
      </div>
    );
  }

  if (isReview && run) {
    const elapsed = formatRunElapsed(run.startedAt, run.finishedAt);
    return (
      <div
        className="op-inbox__bulk op-inbox__bulk--review"
        data-testid="plans-cleanup-review"
      >
        <BulkResolverSettingsControl
          kind="plan-cleanup"
          settings={resolverSettings}
          effective={run.launchSnapshot ?? {}}
        />
        <div className="op-inbox__bulk-head">
          <span
            className="op-inbox__bulk-icon op-inbox__bulk-icon--review"
            aria-hidden="true"
          >
            <Sparkles size={16} />
          </span>
          <span
            className="op-inbox__bulk-title"
            data-testid="plans-cleanup-review-headline"
          >
            {counts.total} assessed · {counts.applied} auto-applied ·{" "}
            {counts.unresolved} still open
          </span>
          <span className="op-inbox__bulk-spacer" />
          {elapsed ? (
            <span className="op-inbox__bulk-elapsed">run {elapsed}</span>
          ) : null}
        </div>
        <div
          className="op-inbox__bulk-counts op-inbox__bulk-counts--accounting"
          data-testid="plans-cleanup-accounting"
          aria-label="Plan cleanup accounting"
        >
          <span className="op-inbox__bulk-count op-inbox__bulk-count--review">
            <i aria-hidden="true" />
            {counts.recommendationTotal} recommendations
          </span>
          {counts.ownerAction > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" /> {counts.ownerAction} owner actions
            </span>
          ) : null}
          {counts.cleanupCandidate > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" /> {counts.cleanupCandidate} cleanup candidates
            </span>
          ) : null}
          {counts.retryNeeded + counts.pending > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" /> {counts.retryNeeded + counts.pending} retry needed
            </span>
          ) : null}
          {counts.routed > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" /> {counts.routed} routed
            </span>
          ) : null}
          {counts.investigate > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" /> {counts.investigate} investigate
            </span>
          ) : null}
          {counts.failed > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" /> {counts.failed} failed
            </span>
          ) : null}
          {counts.legacySkipped > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" /> {counts.legacySkipped} legacy skips to classify
            </span>
          ) : null}
        </div>
        <div className="op-inbox__bulk-actions">
          <button
            type="button"
            className="op-inbox__bulk-accept-all"
            data-testid="plans-cleanup-open-review"
            disabled={counts.unresolved === 0 || busy || classifying}
            onClick={() => onReview(run.runId)}
          >
            <ChevronRight size={14} aria-hidden="true" />
            Review {counts.unresolved} unresolved
          </button>
          {retryableFindings.length > 0 ? (
            <button
              type="button"
              className="op-inbox__bulk-continue"
              data-testid="plans-cleanup-continue"
              disabled={busy || classifying}
              onClick={() => void onResume()}
            >
              {busy ? (
                <span className="op-inbox__bulk-spin" aria-hidden="true">
                  <Loader2 size={14} />
                </span>
              ) : (
                <RotateCw size={14} aria-hidden="true" />
              )}
              {busy ? "Continuing…" : `Continue ${retryableFindings.length} retryable`}
            </button>
          ) : null}
          {counts.legacySkipped > 0 ? (
            <button
              type="button"
              className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide"
              data-testid="plans-cleanup-classify"
              disabled={busy || classifying}
              onClick={() => void onReclassify()}
            >
              {classifying ? "Classifying…" : `Classify ${counts.legacySkipped} legacy skips`}
            </button>
          ) : null}
          <button
            type="button"
            className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide"
            data-testid="plans-cleanup-hide"
            disabled={busy}
            onClick={onRunCleared}
          >
            Hide
          </button>
        </div>
        <p className="op-inbox__bulk-hint">
          Review opens every unresolved finding with its proposed next step.
          Continue retries only unavailable/failed findings through the same
          saved run and preserves every earlier outcome.
        </p>
        {notice ? (
          <Notice text={notice} onClose={() => setNotice(null)} />
        ) : null}
      </div>
    );
  }

  const failureNotice =
    notice ??
    (run?.phase === "failed" ? (run.error ?? "clean-up run failed") : null);
  const count = planSlugs.length;
  return (
    <div className="op-inbox__bulk-slot" data-testid="plans-cleanup-idle">
      <BulkResolverSettingsControl
        kind="plan-cleanup"
        settings={resolverSettings}
      />
      <button
        type="button"
        className="op-inbox__bulk-start"
        data-testid="plans-cleanup-start"
        disabled={count === 0 || starting || !resolverSettings.ready}
        aria-label={`Clean up ${count} shown plan${count === 1 ? "" : "s"}`}
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
            Clean up {count} shown plan{count === 1 ? "" : "s"}
          </span>
          <span className="op-inbox__bulk-start-sub">
            Reconciles stale statuses, cleared blockers &amp; finished work ·
            you review the rest
          </span>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
      {failureNotice ? (
        <Notice text={failureNotice} onClose={() => setNotice(null)} />
      ) : null}
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
