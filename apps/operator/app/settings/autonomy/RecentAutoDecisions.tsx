'use client';

/**
 * The "recent auto-decisions" feed on the autonomy settings page
 * (queen-autonomy-policy-2026-06-13 P-031 / P-113) — a filtered view of the Queen
 * decision ledger's DISPOSITION layer: what she chose for each item she considered
 * (act / defer / reject / route-to-research / no-op), newest first.
 *
 * P-003 (queue-authorization-redesign): the rendering moved to the shared
 * `_components/DecisionLog` so the Queue view's "Queen's log" tab reuses one
 * component (D-002). This is now a thin, settings-flavored wrapper — same title,
 * copy, layer, limit, Undo behavior, and section spacing as before.
 */
import DecisionLog from '../../_components/DecisionLog';

export default function RecentAutoDecisions() {
  return (
    <DecisionLog
      layer="disposition"
      limit={25}
      title="Recent auto-decisions"
      description="What the Queen has decided per item she considered — newest first. A row’s Undo rejects the auto-decision (owner thumbs-down) and demotes that category one step; it appears once a reversible auto-decision has an armed tripwire (the literal action-revert lands with the execution layer)."
      emptyText="No decisions logged yet. As the Queen considers items, her dispositions appear here."
      className="pc-settings-section"
      style={{ marginTop: 28 }}
    />
  );
}
