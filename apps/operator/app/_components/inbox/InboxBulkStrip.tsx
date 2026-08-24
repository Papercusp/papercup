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
 *   REVIEW  — "N need your call · M auto-resolved", Accept all, Dismiss. The
 *             per-item recommendations render INSIDE their own rows (see
 *             InboxBulkRecommendation) rather than in a separate list, so the
 *             owner reviews each one against the item it belongs to.
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
import { useCallback, useState } from 'react';
import { Check, ChevronRight, Loader2, Sparkles, Square, X } from 'lucide-react';
import type { AttentionItem } from '@/app/admin/plans/plans-api';
import {
  deriveRunCounts,
  useBulkRunOps,
  type BulkRun,
  type BulkRunItem,
  type BulkSeedItem,
} from './use-inbox-bulk-run';
import { formatRunElapsed } from "../review-report/bulk-run-time";
export { formatRunElapsed } from "../review-report/bulk-run-time";
import './inbox-bulk.css';

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
  /** Accept every outstanding recommendation, one item at a time. */
  onAcceptAll: () => Promise<void>;
  /** How many accepts are in flight (drives the Accept-all spinner). */
  acceptingCount: number;
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
  onAcceptAll,
  acceptingCount,
}: InboxBulkStripProps) {
  const { start, stop, dismiss } = useBulkRunOps();
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const counts = deriveRunCounts(items, run);

  const onStart = useCallback(async () => {
    if (visible.length === 0 || starting) return;
    setStarting(true);
    setNotice(null);
    try {
      const res = await start(toBulkSeed(visible), filterSnapshot);
      if (!res.ok) {
        setNotice(res.error ?? 'could not start the run');
        return;
      }
      if (res.runId) onRunStarted(res.runId);
      // The run row exists either way; only the RESOLVER failed to launch. Say
      // so plainly rather than leaving a run that will never move looking live.
      if (!res.launched) {
        setNotice(`resolver could not start${res.launchError ? `: ${res.launchError}` : ''}`);
      }
    } finally {
      setStarting(false);
    }
  }, [visible, starting, start, filterSnapshot, onRunStarted]);

  /* ── RUNNING ─────────────────────────────────────────────────────────── */
  if (isRunning && run) {
    return (
      <div className="op-inbox__bulk op-inbox__bulk--running" data-testid="inbox-bulk-running">
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
          <div className="op-inbox__bulk-fill" style={{ width: `${counts.percent}%` }} />
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
      </div>
    );
  }

  /* ── REVIEW ──────────────────────────────────────────────────────────── */
  if (isReview && run) {
    const elapsed = formatRunElapsed(run.startedAt, run.finishedAt);
    const pending = recommendations.length;
    return (
      <div className="op-inbox__bulk op-inbox__bulk--review" data-testid="inbox-bulk-review">
        <div className="op-inbox__bulk-head">
          <span className="op-inbox__bulk-icon op-inbox__bulk-icon--review" aria-hidden="true">
            <Sparkles size={16} />
          </span>
          <span className="op-inbox__bulk-title" data-testid="inbox-bulk-review-headline">
            {pending} need your call · {counts.resolved} auto-resolved
            {/* Items the resolver never reached are named rather than dropped —
                a run that stopped early must not read as a run that finished. */}
            {unreached.length > 0 ? ` · ${unreached.length} not reached` : ''}
          </span>
          <span className="op-inbox__bulk-spacer" />
          {elapsed ? <span className="op-inbox__bulk-elapsed">run {elapsed}</span> : null}
        </div>
        <div className="op-inbox__bulk-actions">
          <button
            type="button"
            className="op-inbox__bulk-accept-all"
            data-testid="inbox-bulk-accept-all"
            disabled={pending === 0 || acceptingCount > 0}
            onClick={() => void onAcceptAll()}
          >
            {acceptingCount > 0 ? (
              <span className="op-inbox__bulk-spin" aria-hidden="true">
                <Loader2 size={14} />
              </span>
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
            {acceptingCount > 0
              ? `Accepting ${acceptingCount}…`
              : `Accept all ${pending} recommendation${pending === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide"
            data-testid="inbox-bulk-dismiss"
            onClick={() => void dismiss(run.runId)}
          >
            Dismiss
          </button>
        </div>
        <p className="op-inbox__bulk-hint">
          Each recommendation is pre-picked from that item&rsquo;s real options — open a row to
          accept, override or edit it.
        </p>
      </div>
    );
  }

  /* ── IDLE ────────────────────────────────────────────────────────────── */
  const n = visible.length;
  return (
    <div className="op-inbox__bulk-slot">
      <button
        type="button"
        className="op-inbox__bulk-start"
        data-testid="inbox-bulk-start"
        disabled={n === 0 || starting}
        aria-label={`Bulk resolve ${n} filtered item${n === 1 ? '' : 's'}`}
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
            {starting ? 'Starting…' : `Bulk resolve ${n} filtered item${n === 1 ? '' : 's'}`}
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
      {notice || (run?.phase === 'failed' && run.error) ? (
        <div className="op-inbox__bulk-notice" role="alert" data-testid="inbox-bulk-notice">
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
