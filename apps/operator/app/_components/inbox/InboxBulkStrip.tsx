/**
 * InboxBulkStrip — the Inbox's BULK RESOLVE command strip
 * (inbox-bulk-resolve-2026-08-23, P-006; owner-approved direction A, D-003).
 *
 * ONE SLOT, THREE STATES, directly under the "Needs you" masthead and above the
 * search/filter toolbar. Which state renders is derived from the run's PHASE, so
 * the strip cannot show a stale state after a reload — the phase is in Postgres,
 * not in component state (Requirement 7):
 *
 *   IDLE    — one button: "Bulk resolve N filtered items", N = the pane's CURRENT
 *             visible set. Disabled at 0. The sub-label names what will happen,
 *             because a bulk action whose behavior the owner has to guess at is
 *             one they are right not to press.
 *   RUNNING — progress bar + resolved / for-review / left counts + Stop.
 *   REVIEW  — "N need your call · M auto-resolved", Review decisions, Dismiss.
 *             Review hands the exact persisted run to the grouped report; the
 *             narrow strip never applies a batch without showing its reasons.
 *
 * WHY THE CLIENT POSTS ITEM IDS. `visible` is a snapshot of a live, SSE-updated
 * feed. Re-deriving the filtered set server-side would resolve against a set that
 * has moved since the owner looked, so the run could act on an item they never
 * saw — the one thing a bulk action must never do. The ids the pane is rendering
 * are posted verbatim, with the filters riding along as provenance only.
 *
 * A FAILED START IS SHOWN, NOT SWALLOWED. Both failure shapes surface in the
 * strip itself: a request that never created a run, and a run created whose
 * resolver could not be launched (the route returns the run either way). Every
 * item stays individually resolvable by hand in both cases.
 */
import { useCallback, useState } from "react";
import {
  ChevronRight,
  Loader2,
  RotateCw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { AttentionItem } from "@/app/admin/plans/plans-api";
import {
  deriveRunCounts,
  useBulkRunOps,
  type BulkRun,
  type BulkRunItem,
  type BulkSeedItem,
} from "./use-inbox-bulk-run";
import { formatRunElapsed } from "../review-report/bulk-run-time";
export { formatRunElapsed } from "../review-report/bulk-run-time";
import BulkResolverSettingsControl from "../bulk-resolver/BulkResolverSettingsControl";
import { useBulkResolverSettings } from "../bulk-resolver/bulk-resolver-settings";
import { PERF_INTERACTIONS, beginInteraction } from "../perf/perf-marks";
import "./inbox-bulk.css";

export interface InboxBulkStripProps {
  /** The pane's CURRENT filtered+sorted set — the exact rows it is showing. */
  visible: AttentionItem[];
  /** Human-readable provenance for the record (tier chip, kinds, search). */
  filterSnapshot: Record<string, unknown>;
  run: BulkRun | null;
  items: BulkRunItem[];
  recommendations: BulkRunItem[];
  unreached: BulkRunItem[];
  isRunning: boolean;
  isReview: boolean;
  /** Called with the new run id so the pane can deep-link it (`?opcbr=`). */
  onRunStarted: (runId: string) => void;
  /** Open the grouped review for this exact persisted run (`?opcbr=<runId>`). */
  onReview: (runId: string) => void;
}

/** The seed the run is created from — the pane's own snapshot of each row. */
export function toBulkSeed(items: AttentionItem[]): BulkSeedItem[] {
  return items.map((i) => ({
    itemId: i.id,
    kind: i.kind,
    title: i.title ?? null,
    ref: i.ref ?? {},
    ownerAgentId: i.ownerAgentId ?? null,
  }));
}

export default function InboxBulkStrip({
  visible,
  filterSnapshot,
  run,
  items,
  recommendations,
  unreached,
  isRunning,
  isReview,
  onRunStarted,
  onReview,
}: InboxBulkStripProps) {
  const { start, stop, restart, resume } = useBulkRunOps();
  const resolverSettings = useBulkResolverSettings("inbox-resolve");
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const counts = deriveRunCounts(items, run);

  const onStart = useCallback(async () => {
    if (visible.length === 0 || starting || !resolverSettings.ready) return;
    setStarting(true);
    setNotice(null);
    try {
      const res = await start(
        toBulkSeed(visible),
        filterSnapshot,
        null,
        resolverSettings.profile,
      );
      if (!res.ok) {
        setNotice(res.error ?? "could not start the run");
        return;
      }
      if (res.runId) onRunStarted(res.runId);
      // The run row exists either way; only the RESOLVER failed to launch. Say
      // so plainly rather than leaving a run that will never move looking live.
      if (!res.launched) {
        setNotice(
          `resolver could not start${res.launchError ? `: ${res.launchError}` : ""}`,
        );
      }
    } finally {
      setStarting(false);
    }
  }, [
    visible,
    starting,
    start,
    filterSnapshot,
    onRunStarted,
    resolverSettings,
  ]);

  const onRestart = useCallback(async () => {
    if (!run || restarting) return;
    setRestarting(true);
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
      setRestarting(false);
    }
  }, [run, restart, restarting]);

  const openReview = useCallback(() => {
    if (!run) return;
    // The real gesture is the start boundary. InboxBulkReport ends this after
    // its first committed render; a deep link with no click simply no-ops.
    beginInteraction(PERF_INTERACTIONS.inboxBulkReportOpen);
    onReview(run.runId);
  }, [onReview, run]);

  const onResume = useCallback(async () => {
    if (!run || resuming || unreached.length === 0) return;
    const itemIds = unreached.map((item) => item.itemId);
    setResuming(true);
    setNotice(null);
    try {
      const result = await resume(run.runId, itemIds);
      if (!result.ok) {
        setNotice(result.error ?? "could not continue the remaining items");
      } else if (!result.launched) {
        setNotice(
          `resolver could not continue${result.launchError ? `: ${result.launchError}` : ""}`,
        );
      } else {
        const preserved = result.preservedOutcomes ?? 0;
        setNotice(
          `Continuing ${itemIds.length} remaining · ${preserved} prior outcome${preserved === 1 ? "" : "s"} preserved`,
        );
      }
    } finally {
      setResuming(false);
    }
  }, [resume, resuming, run, unreached]);

  /* ── RUNNING ─────────────────────────────────────────────────────────── */
  if (isRunning && run) {
    return (
      <div
        className="op-inbox__bulk op-inbox__bulk--running"
        data-testid="inbox-bulk-running"
      >
        <BulkResolverSettingsControl
          kind="inbox-resolve"
          settings={resolverSettings}
          effective={run.launchSnapshot ?? {}}
          liveness={run.liveness}
          onRestart={() => void onRestart()}
          restartBusy={restarting}
        />
        <div className="op-inbox__bulk-head">
          <span className="op-inbox__bulk-spin" aria-hidden="true">
            <Loader2 size={15} />
          </span>
          <span className="op-inbox__bulk-title">Papercup is resolving…</span>
          <span className="op-inbox__bulk-spacer" />
          <button
            type="button"
            className="op-inbox__bulk-ghost"
            data-testid="inbox-bulk-stop"
            onClick={() => void stop(run.runId)}
          >
            <Square size={11} aria-hidden="true" />
            Stop
          </button>
        </div>
        <div
          className="op-inbox__bulk-track"
          role="progressbar"
          aria-valuenow={counts.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Bulk resolve progress: ${counts.decided} of ${counts.total} decided`}
        >
          <div
            className="op-inbox__bulk-fill"
            style={{ width: `${counts.percent}%` }}
          />
        </div>
        <div className="op-inbox__bulk-counts" data-testid="inbox-bulk-counts">
          <span className="op-inbox__bulk-count op-inbox__bulk-count--good">
            <i aria-hidden="true" />
            {counts.resolved} resolved
          </span>
          <span className="op-inbox__bulk-count op-inbox__bulk-count--review">
            <i aria-hidden="true" />
            {counts.forReview} for review
          </span>
          <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
            <i aria-hidden="true" />
            {counts.left} left
          </span>
        </div>
        {notice ? (
          <div className="op-inbox__bulk-notice" role="status">
            {notice}
          </div>
        ) : null}
      </div>
    );
  }

  /* ── REVIEW ──────────────────────────────────────────────────────────── */
  if (isReview && run) {
    const elapsed = formatRunElapsed(run.startedAt, run.finishedAt);
    const retryable = unreached.length;
    return (
      <div
        className="op-inbox__bulk op-inbox__bulk--review"
        data-testid="inbox-bulk-review"
      >
        <BulkResolverSettingsControl
          kind="inbox-resolve"
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
            data-testid="inbox-bulk-review-headline"
          >
            {counts.total} assessed · {counts.resolved} auto-resolved ·{" "}
            {counts.unresolved} still open
          </span>
          <span className="op-inbox__bulk-spacer" />
          {elapsed ? (
            <span className="op-inbox__bulk-elapsed">run {elapsed}</span>
          ) : null}
        </div>
        <div
          className="op-inbox__bulk-counts op-inbox__bulk-counts--accounting"
          data-testid="inbox-bulk-accounting"
          aria-label="Bulk resolve accounting"
        >
          <span className="op-inbox__bulk-count op-inbox__bulk-count--review">
            <i aria-hidden="true" />
            {counts.recommendationTotal} recommendations
          </span>
          {counts.ownerAction > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" />
              {counts.ownerAction} owner action{counts.ownerAction === 1 ? "" : "s"}
            </span>
          ) : null}
          {counts.cleanupCandidate > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" />
              {counts.cleanupCandidate} cleanup candidate{counts.cleanupCandidate === 1 ? "" : "s"}
            </span>
          ) : null}
          {counts.retryNeeded > 0 || counts.pending > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" />
              {counts.retryNeeded + counts.pending} retry needed
            </span>
          ) : null}
          {counts.routed > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" />
              {counts.routed} routed
            </span>
          ) : null}
          {counts.investigate > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" />
              {counts.investigate} investigate
            </span>
          ) : null}
          {counts.failed > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" />
              {counts.failed} failed
            </span>
          ) : null}
          {counts.legacySkipped > 0 ? (
            <span className="op-inbox__bulk-count op-inbox__bulk-count--left">
              <i aria-hidden="true" />
              {counts.legacySkipped} legacy skips classified above
            </span>
          ) : null}
        </div>
        <div className="op-inbox__bulk-actions">
          <button
            type="button"
            className="op-inbox__bulk-accept-all"
            data-testid="inbox-bulk-review-decisions"
            disabled={counts.unresolved === 0 || resuming}
            onClick={openReview}
          >
            Review {counts.unresolved} unresolved
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          {retryable > 0 ? (
            <button
              type="button"
              className="op-inbox__bulk-continue"
              data-testid="inbox-bulk-continue"
              disabled={resuming}
              onClick={() => void onResume()}
            >
              {resuming ? (
                <span className="op-inbox__bulk-spin" aria-hidden="true">
                  <Loader2 size={14} />
                </span>
              ) : (
                <RotateCw size={14} aria-hidden="true" />
              )}
              {resuming
                ? "Continuing…"
                : `Continue ${retryable} retryable`}
            </button>
          ) : null}
        </div>
        <p className="op-inbox__bulk-hint">
          Review opens every unresolved row with its proposed next step.
          Continue retries only rows whose detail was unavailable or whose
          resolver attempt failed; recommendations, owner actions, cleanup
          candidates, and terminal outcomes stay preserved.
        </p>
        {notice ? (
          <div className="op-inbox__bulk-notice" role="status">
            {notice}
          </div>
        ) : null}
      </div>
    );
  }

  /* ── IDLE ────────────────────────────────────────────────────────────── */
  const n = visible.length;
  return (
    <div className="op-inbox__bulk-slot">
      <BulkResolverSettingsControl
        kind="inbox-resolve"
        settings={resolverSettings}
      />
      <button
        type="button"
        className="op-inbox__bulk-start"
        data-testid="inbox-bulk-start"
        disabled={n === 0 || starting || !resolverSettings.ready}
        aria-label={`Bulk resolve ${n} filtered item${n === 1 ? "" : "s"}`}
        onClick={() => void onStart()}
      >
        <span className="op-inbox__bulk-icon" aria-hidden="true">
          {starting ? (
            <span className="op-inbox__bulk-spin">
              <Loader2 size={17} />
            </span>
          ) : (
            <Sparkles size={17} />
          )}
        </span>
        <span className="op-inbox__bulk-start-copy">
          <span className="op-inbox__bulk-start-title">
            {starting
              ? "Starting…"
              : `Bulk resolve ${n} filtered item${n === 1 ? "" : "s"}`}
          </span>
          <span className="op-inbox__bulk-start-sub">
            Papercup resolves what it can · the rest come back pre-recommended
          </span>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
      {/* A failed run is a real, visible state — not a silent no-op. `error` is
          the run's own recorded reason (a launch failure); `notice` is this
          click's. */}
      {notice || (run?.phase === "failed" && run.error) ? (
        <div
          className="op-inbox__bulk-notice"
          role="alert"
          data-testid="inbox-bulk-notice"
        >
          <span>{notice ?? run?.error}</span>
          {notice ? (
            <button
              type="button"
              className="op-inbox__bulk-notice-x"
              aria-label="Dismiss message"
              onClick={() => setNotice(null)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
