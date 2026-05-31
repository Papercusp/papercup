'use client';

/**
 * PlanItemPreview — the read-only detail pane for the cross-plan item
 * views (Needs Human / Needs Decision / Blocked). Mirrors the Sessions
 * tab's detail pane: a sticky pane that renders the SELECTED item's plan
 * read-only (Vditor preview, no outline) and scrolls to the item.
 *
 * The toolbar carries the per-item actions (moved here from the cramped
 * inline rows): Answer / Resolve / Drop for a needs-human item, a
 * "Chat with agent" button (launches the plan-context agent, same as the
 * plan pages), and "View full plan" on the right.
 *
 * Deliberately NOT the full PlanDetail: no editor / revisions / agents
 * tabs, no status popovers, no outline, no plan-title header bar.
 */

import { useEffect, useRef, useState } from 'react';
import PlanEditor from './PlanEditor';
import { usePlan } from './plans-api';
import { InboxItemActions } from './PlanItemsList';
import PlanChatModal from './PlanChatModal';
import { scrollPlanTarget, stripFrontmatter } from './plan-renderers';

interface Props {
  /** Selected item's parent plan slug, or null when nothing is selected. */
  planSlug: string | null;
  /** Selected item id (P-NNN / D-NNN), or null when nothing is selected. */
  itemId: string | null;
  /** Harness for the selected plan — lets the needs-human actions resume the loop. */
  harnessSlug?: string | null;
  /** Called after a needs-human action (Answer/Resolve/Drop) so the list refetches. */
  onResolved?: () => void;
  /** Hand off to the full PlanDetail view — PlansClient's navPlanTarget. */
  onViewFullPlan: (slug: string, itemId?: string) => void;
}

export default function PlanItemPreview({
  planSlug,
  itemId,
  harnessSlug,
  onResolved,
  onViewFullPlan,
}: Props) {
  const { data, loading, error } = usePlan(planSlug);
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  const raw = data?.raw ?? data?.prose ?? '';

  // Scroll to the selected item once the read-only body has rendered.
  // Vditor.preview renders async (and re-renders on value change), so we
  // retry on a short cadence until the anchor exists — same approach as
  // PlanDetail's `?jump=` effect.
  useEffect(() => {
    if (!itemId || !raw) return;
    let cancelled = false;
    const delays = [60, 160, 320, 600, 1000];
    const timers = delays.map((delay) =>
      window.setTimeout(() => {
        if (cancelled) return;
        if (scrollPlanTarget(scopeRef.current, itemId)) cancelled = true;
      }, delay),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [itemId, raw, planSlug]);

  if (!planSlug || !itemId) {
    return (
      <aside className="pc-items__detail">
        <div className="pc-items__detail-empty">
          Select an item to preview its plan here.
        </div>
      </aside>
    );
  }

  const strippedRaw = data?.legacy ? raw : stripFrontmatter(raw);
  const selected = data?.items?.find((i) => i.id === itemId);
  const isNeedsHuman = selected?.storedStatus === 'needs-human';

  return (
    <aside className="pc-items__detail">
      <PlanChatModal
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        harnessSlug={harnessSlug}
        label={`${planSlug} · ${itemId}`}
      />
      <div className="pc-items__detail-toolbar">
        <span className="pc-items__id">{itemId}</span>
        <div className="pc-items__detail-actions">
          {isNeedsHuman ? (
            <InboxItemActions
              planSlug={planSlug}
              itemId={itemId}
              harnessSlug={harnessSlug ?? undefined}
              onResolved={() => onResolved?.()}
            />
          ) : null}
          <button
            type="button"
            className="pc-items__action-btn pc-items__action-btn--chat"
            onClick={() => setChatOpen(true)}
            title="Open an in-app, plan-context agent chat about this item"
          >
            💬 Chat
          </button>
        </div>
        <button
          type="button"
          className="pc-items__view-full"
          onClick={() => onViewFullPlan(planSlug, itemId)}
          title="Open the full plan, jumped to this item"
        >
          View full plan ↗
        </button>
      </div>
      <div className="pc-items__detail-body" ref={scopeRef}>
        {loading && !data ? (
          <p className="pc-plans__placeholder">Loading plan…</p>
        ) : error ? (
          <p className="pc-plans__placeholder pc-plans__placeholder--error">
            Failed to load plan: {error}
          </p>
        ) : strippedRaw ? (
          <PlanEditor
            value={strippedRaw}
            readOnly
            outline={false}
            items={data?.items}
            slug={planSlug}
          />
        ) : (
          <p className="pc-plans__placeholder">This plan has no content.</p>
        )}
      </div>
    </aside>
  );
}
