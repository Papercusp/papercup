/**
 * The aside's BRIEFING — what the split-mode `/inbox` page shows when nothing
 * is selected (inbox-three-column-resolver-states-2026-09-06 P-005). The
 * 31 Aug board left this pane empty until selection; the merged spec fills it
 * with the headline count, four tiles, the last resolver run's readout with
 * its grouped disposition rows, and the primary action.
 *
 * Composed ONLY from state the pane already holds (D-002: no new reads):
 *  - the feed's scope counts (`needs`) and the server total (`tracked`);
 *  - the persisted bulk run `useInboxBulkRun` already loads for the rail card —
 *    its item ROWS drive the run-derived tiles, the readout and the grouped
 *    rows through the same `deriveRunCounts` the strips read;
 *  - the P-004 feed block (window strip + foot), mounted last.
 * The RUNNING view is P-006's and the REVIEW/RESUME view is P-007's: while a
 * run is live this briefing shows the tiles and the feed only.
 */
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  deriveRunCounts,
  type BulkRun,
  type BulkRunItem,
} from "./use-inbox-bulk-run";
import { formatRunElapsed } from "../review-report/bulk-run-time";
import { PERF_INTERACTIONS, beginInteraction } from "../perf/perf-marks";

export interface InboxBriefingProps {
  /** Decision-tier rows in the current scope — the "N need you" count. */
  needs: number;
  /** The server-side attention total, independent of the loaded page. */
  tracked: number;
  /** The persisted bulk run the pane already loads (null when none / flag off). */
  run: BulkRun | null;
  runItems: BulkRunItem[];
  /** A live run: the readout is P-006's, so the briefing omits it. */
  isRunning: boolean;
  /** Opens the grouped report for the run — the strip's `onReview` op. */
  onReview: (runId: string) => void;
  /** The P-004 feed block (window strip + foot); rendered last. */
  feed?: ReactNode;
}

export interface InboxRunDispositionRow {
  id: string;
  label: string;
  description: string;
  count: number;
  /** The umbrella row: every `recommended` row, whatever its typed kind. */
  umbrella?: boolean;
}

type RunCounts = ReturnType<typeof deriveRunCounts>;

/**
 * The briefing's grouped disposition rows, from the same `deriveRunCounts`
 * the strips read (so the two surfaces cannot disagree). "Recommendations" is
 * the UMBRELLA — every `recommended` row, whatever its typed disposition — and
 * the owner-action / cleanup rows beneath it are subsets of it, so the rows
 * deliberately do NOT sum: the spec's "143 + 78 + 51 + 6 exceeds 158" is this
 * overlap, labelled instead of hidden.
 */
export function deriveRunDispositionRows(
  counts: RunCounts,
): InboxRunDispositionRow[] {
  const rows: InboxRunDispositionRow[] = [
    {
      id: "recommendations",
      label: "Recommendations",
      description: "every proposed next step — the typed rows below are among them",
      count: counts.recommendationTotal,
      umbrella: true,
    },
  ];
  if (counts.ownerAction > 0) {
    rows.push({
      id: "owner-action",
      label: "Owner actions",
      description: "only you can decide",
      count: counts.ownerAction,
    });
  }
  if (counts.cleanupCandidate > 0) {
    rows.push({
      id: "cleanup-candidate",
      label: "Cleanup candidates",
      description: "safe to close together",
      count: counts.cleanupCandidate,
    });
  }
  if (counts.retryNeeded + counts.pending > 0) {
    rows.push({
      id: "retry-needed",
      label: "Retry needed",
      description: "did not reach a decision",
      count: counts.retryNeeded + counts.pending,
    });
  }
  if (counts.routed > 0) {
    rows.push({
      id: "routed",
      label: "Routed",
      description: "handed to another lane",
      count: counts.routed,
    });
  }
  if (counts.investigate > 0) {
    rows.push({
      id: "investigate",
      label: "Investigate",
      description: "needs a closer look",
      count: counts.investigate,
    });
  }
  if (counts.failed > 0) {
    rows.push({
      id: "failed",
      label: "Failed",
      description: "the resolver errored",
      count: counts.failed,
    });
  }
  return rows;
}

export function briefingHeadline(needs: number): string {
  if (needs === 0) return "Nothing is waiting on you";
  return `${needs} ${needs === 1 ? "item is" : "items are"} waiting on you`;
}

function Tile({
  id,
  value,
  label,
  em = false,
}: {
  id: string;
  value: number | null;
  label: string;
  em?: boolean;
}) {
  return (
    <div
      className={`op-inbox__briefing-tile${em ? " is-em" : ""}`}
      data-testid={`inbox-briefing-tile-${id}`}
    >
      <strong>{value === null ? "—" : value}</strong>
      <span>{label}</span>
    </div>
  );
}

export default function InboxBriefing({
  needs,
  tracked,
  run,
  runItems,
  isRunning,
  onReview,
  feed,
}: InboxBriefingProps) {
  const counts = run ? deriveRunCounts(runItems, run) : null;
  const showRun = run !== null && counts !== null && !isRunning;
  const rows = counts ? deriveRunDispositionRows(counts) : [];
  const elapsed = run ? formatRunElapsed(run.startedAt, run.finishedAt) : null;
  const openReview = () => {
    if (!run) return;
    // Same gesture boundary as the strip's Review: the report ends it after
    // its first committed render.
    beginInteraction(PERF_INTERACTIONS.inboxBulkReportOpen);
    onReview(run.runId);
  };

  return (
    <div className="op-inbox__briefing" data-testid="inbox-briefing">
      <div className="op-inbox__briefing-head">
        <h2
          className="op-inbox__briefing-title"
          data-testid="inbox-briefing-headline"
        >
          {briefingHeadline(needs)}
        </h2>
        <p className="op-inbox__briefing-lead">
          Nothing is selected. This is where an item opens — until then,{" "}
          {showRun
            ? "what the last resolver run left behind."
            : "the queue at a glance."}
        </p>
      </div>
      <div
        className="op-inbox__briefing-grid"
        role="group"
        aria-label="Inbox at a glance"
        data-testid="inbox-briefing-grid"
      >
        <Tile id="need-you" value={needs} label="Need you" />
        <Tile
          id="still-open"
          value={counts ? counts.unresolved : null}
          label="Still open"
          em
        />
        <Tile
          id="auto-resolved"
          value={counts ? counts.resolved : null}
          label="Auto-resolved"
        />
        <Tile id="tracked" value={tracked} label="Tracked" />
      </div>
      {showRun && run && counts ? (
        <section
          className="op-inbox__briefing-run"
          aria-label="Last resolver run"
          data-testid="inbox-briefing-run"
        >
          <p className="op-inbox__briefing-run-head">
            <em>Last run</em>
            <span className="op-inbox__briefing-run-phase">{run.phase}</span>
            {elapsed ? (
              <span className="op-inbox__briefing-run-elapsed">{elapsed}</span>
            ) : null}
          </p>
          <p
            className="op-inbox__briefing-run-line"
            data-testid="inbox-briefing-run-line"
          >
            {counts.total} assessed · {counts.resolved} auto-resolved ·{" "}
            {counts.unresolved} still open
          </p>
          <ul
            className="op-inbox__briefing-rows"
            data-testid="inbox-briefing-rows"
          >
            {rows.map((r) => (
              <li
                key={r.id}
                className={`op-inbox__briefing-row${r.umbrella ? " is-umbrella" : ""}`}
                data-testid={`inbox-briefing-row-${r.id}`}
              >
                <span className="op-inbox__briefing-row-name">{r.label}</span>
                <span className="op-inbox__briefing-row-desc">
                  {r.description}
                </span>
                <span className="op-inbox__briefing-row-count">{r.count}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="op-inbox__briefing-review"
            data-testid="inbox-briefing-review"
            disabled={counts.unresolved === 0}
            onClick={openReview}
          >
            Review {counts.unresolved} unresolved
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </section>
      ) : null}
      {feed}
    </div>
  );
}
