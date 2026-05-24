'use client';

/**
 * Plan rail — the left-hand list of every plan, fed by usePlanList.
 *
 * P-102 deliverable. Sort: active first, then by `updated` desc.
 * Search input (managed by PlansClient via the `q` nuqs key) filters
 * rows client-side over title + slug; full cross-plan search is P-104.
 *
 * Per-row visuals: title, slug (secondary), plan status pill,
 * item counts by effectiveStatus (wip / needs-human / blocked / todo /
 * done / dropped), the `## Now` Next: line, last-updated date.
 */

import { useQueryState, parseAsBoolean, parseAsString, parseAsStringEnum } from 'nuqs';
import { forwardRef, useImperativeHandle, useMemo } from 'react';
import { type AsyncResult, type PlanListRow, type ItemStatus, type PlanStatus } from './plans-api';
import { withinDateWindow, type DateWindow } from './PlanFilters';
import { Tooltip } from '@/app/harness/Tooltip';

/** Imperative handle PlansClient uses for J/K keyboard navigation. */
export interface PlanRailHandle {
  /** Move selection to the next visible plan (or first if none selected). */
  next: () => void;
  /** Move selection to the previous visible plan (or last if none selected). */
  prev: () => void;
}

const STATUS_FILTER_VALUES: PlanStatus[] = [
  'active',
  'draft',
  'blocked',
  'shipped',
  'superseded',
  'unknown',
];

const STATUS_ORDER: Record<string, number> = {
  active: 0,
  draft: 1,
  blocked: 2,
  shipped: 3,
  superseded: 4,
  unknown: 5,
};

const COUNT_ORDER: Array<ItemStatus | 'unknown'> = [
  'wip',
  'needs-human',
  'blocked',
  'todo',
  'done',
  'dropped',
  'unknown',
];

const COUNT_LABELS: Record<ItemStatus | 'unknown', string> = {
  wip: 'wip',
  'needs-human': 'human',
  blocked: 'blocked',
  todo: 'todo',
  done: 'done',
  dropped: 'dropped',
  unknown: 'unknown',
};

interface Props {
  list: AsyncResult<{ plans: PlanListRow[] }>;
  selectedSlug: string | null;
  query: string;
  /** Plan slugs the server-side cross-plan search returned. The rail
   *  unions these with the title/slug substring match so a search for
   *  body-only text ("memory" / "mem0") still surfaces matching plans
   *  instead of looking like "0 results". */
  searchHitSlugs?: ReadonlySet<string>;
  onSelect: (slug: string) => void;
}

const PlanRail = forwardRef<PlanRailHandle, Props>(function PlanRail(
  { list, selectedSlug, query, searchHitSlugs, onSelect }: Props,
  ref,
) {
  const { data, loading, error, refresh } = list;

  // Filter reads — PlanFilters owns the writes; same nuqs keys.
  const [fStatus] = useQueryState(
    'pStatus',
    parseAsStringEnum<PlanStatus>(STATUS_FILTER_VALUES),
  );
  const [fDate] = useQueryState(
    'pDate',
    parseAsStringEnum<DateWindow>(['today', '7d', '30d']),
  );
  const [fOwner] = useQueryState('pOwner', parseAsString);
  const [fArchived] = useQueryState('pArchived', parseAsBoolean.withDefault(false));
  const [fLegacy] = useQueryState('pLegacy', parseAsBoolean.withDefault(false));
  const [fInbox] = useQueryState('pInbox', parseAsBoolean.withDefault(false));
  const [fActionable] = useQueryState('pActionable', parseAsBoolean.withDefault(false));

  const plans = data?.plans ?? [];

  // Apply structured filters → search filter → sort. Memoized so the
  // imperative-handle below sees the same list the body renders.
  const sorted = useMemo<PlanListRow[]>(() => {
    let working: PlanListRow[] = plans;
    if (fStatus) working = working.filter((p) => p.status === fStatus);
    if (fOwner) working = working.filter((p) => p.owner === fOwner);
    if (fDate) working = working.filter((p) => withinDateWindow(p.updated, fDate));
    working = working.filter((p) => (fArchived ? p.archived : !p.archived));
    if (fLegacy) working = working.filter((p) => p.isLegacy);
    if (fInbox) {
      working = working.filter(
        (p) => ((p.itemCounts ?? {})['needs-human'] ?? 0) > 0,
      );
    }
    if (fActionable) {
      working = working.filter((p) => ((p.itemCounts ?? {}).todo ?? 0) > 0);
    }
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? working.filter(
          (p) =>
            (p.title ?? '').toLowerCase().includes(needle) ||
            p.slug.toLowerCase().includes(needle) ||
            (searchHitSlugs?.has(p.slug) ?? false),
        )
      : working;
    return [...filtered].sort((a, b) => {
      const sa = STATUS_ORDER[a.status] ?? 99;
      const sb = STATUS_ORDER[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      return (b.updated ?? '').localeCompare(a.updated ?? '');
    });
  }, [plans, fStatus, fOwner, fDate, fArchived, fLegacy, fInbox, fActionable, query, searchHitSlugs]);

  useImperativeHandle(
    ref,
    () => ({
      next: () => {
        if (!sorted.length) return;
        const i = sorted.findIndex((p) => p.slug === selectedSlug);
        const nextIdx = i < 0 ? 0 : Math.min(i + 1, sorted.length - 1);
        const nxt = sorted[nextIdx];
        if (nxt) onSelect(nxt.slug);
      },
      prev: () => {
        if (!sorted.length) return;
        const i = sorted.findIndex((p) => p.slug === selectedSlug);
        const prevIdx = i < 0 ? sorted.length - 1 : Math.max(i - 1, 0);
        const prv = sorted[prevIdx];
        if (prv) onSelect(prv.slug);
      },
    }),
    [sorted, selectedSlug, onSelect],
  );

  if (loading) {
    return <p className="pc-plans__placeholder">Loading plans…</p>;
  }
  if (error) {
    return (
      <div className="pc-plans__placeholder pc-plans__placeholder--error">
        <p>Failed to load plans:</p>
        <code>{error}</code>
        <button type="button" className="pc-plans__retry" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }
  if (!plans.length) {
    return <p className="pc-plans__placeholder">No plans found.</p>;
  }

  if (!sorted.length) {
    // Distinguish a search miss from a filter miss — `query` is the
    // search box, the rest are the PlanFilters keys.
    const q = query.trim();
    const filtersActive =
      !!fStatus || !!fOwner || !!fDate || fArchived || fLegacy || fInbox || fActionable;
    const msg = q
      ? `No plans match “${q}”.`
      : filtersActive
        ? 'No plans match the active filters.'
        : 'No plans to show.';
    return <p className="pc-plans__placeholder">{msg}</p>;
  }

  return (
    <ul className="pc-plan-rail__rows" role="list">
      {sorted.map((p) => (
        <PlanRow
          key={p.slug}
          plan={p}
          active={p.slug === selectedSlug}
          onSelect={() => onSelect(p.slug)}
        />
      ))}
    </ul>
  );
});

export default PlanRail;

function PlanRow({
  plan,
  active,
  onSelect,
}: {
  plan: PlanListRow;
  active: boolean;
  onSelect: () => void;
}) {
  const title = plan.title ?? plan.slug;
  return (
    <li className={`pc-plan-rail__item pc-plan-rail__item--${plan.status}`}>
      <button
        type="button"
        className={`pc-plan-row ${active ? 'is-active' : ''}`}
        onClick={onSelect}
        aria-label={`Open plan ${title} (${plan.slug})`}
        aria-current={active ? 'page' : undefined}
      >
        <div className="pc-plan-row__head">
          <Tooltip label={title}>
            <span className="pc-plan-row__title">{title}</span>
          </Tooltip>
          <StatusPill status={plan.status} />
        </div>
        <div className="pc-plan-row__meta-line">
          <span className="pc-plan-row__slug">{plan.slug}</span>
          {plan.updated ? (
            <span className="pc-plan-row__updated">updated {formatUpdated(plan.updated)}</span>
          ) : null}
        </div>
        {plan.itemCounts ? <ItemCounts counts={plan.itemCounts} /> : null}
        {plan.nextAction ? (
          <Tooltip label={plan.nextAction}>
            <div className="pc-plan-row__next">
              <span className="pc-plan-row__next-label">Next</span>
              <span className="pc-plan-row__next-text">{plan.nextAction}</span>
            </div>
          </Tooltip>
        ) : null}
      </button>
    </li>
  );
}

function StatusPill({ status }: { status: PlanStatus }) {
  return <span className={`pc-pill pc-pill--${status}`}>{status}</span>;
}

function formatUpdated(updated: string): string {
  const t = Date.parse(updated);
  if (!Number.isFinite(t)) return updated;
  const ageMs = Date.now() - t;
  const day = 86_400_000;
  if (ageMs < day) return 'today';
  if (ageMs < day * 2) return 'yesterday';
  if (ageMs < day * 30) return `${Math.floor(ageMs / day)}d ago`;
  return updated.slice(0, 10);
}

function ItemCounts({
  counts,
}: {
  counts: Partial<Record<ItemStatus | 'unknown', number>>;
}) {
  const present = COUNT_ORDER.filter((k) => (counts[k] ?? 0) > 0);
  if (!present.length) return null;
  return (
    <div className="pc-plan-row__counts">
      {present.map((k) => (
        <span
          key={k}
          className={`pc-count pc-count--${k}`}
          aria-label={`${counts[k]} ${COUNT_LABELS[k]} items`}
        >
          {counts[k]} {COUNT_LABELS[k]}
        </span>
      ))}
    </div>
  );
}
