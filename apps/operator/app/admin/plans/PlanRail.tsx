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
import { forwardRef, useImperativeHandle, useMemo, useCallback, useState } from 'react';
import { Play, Pause, Clock } from 'lucide-react';
import {
  bucketOf,
  startPlan,
  pausePlan,
  type AsyncResult,
  type PlanListRow,
  type ItemStatus,
  type PlanStatus,
  type PlanBucket,
} from './plans-api';
import { type DateWindow } from './PlanFilters';
import { applyPlanFilters } from './plan-filtering';
import { Tooltip } from '@/app/harness/Tooltip';

/** Imperative handle PlansClient uses for J/K keyboard navigation. */
export interface PlanRailHandle {
  /** Move selection to the next visible plan (or first if none selected). */
  next: () => void;
  /** Move selection to the previous visible plan (or last if none selected). */
  prev: () => void;
}

const BUCKET_FILTER_VALUES: PlanBucket[] = ['draft', 'ready', 'running', 'shipped', 'rejected'];

/** Rail sort order: live/actionable buckets first, terminals last. */
const BUCKET_ORDER: Record<PlanBucket, number> = {
  running: 0,
  ready: 1,
  draft: 2,
  shipped: 3,
  rejected: 4,
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
  /** Called after a start/pause action so the parent can re-fetch. */
  onStartToggle?: () => void;
  /** Current harness slug — used to auto-launch the harness when starting a plan. */
  harnessSlug?: string | null;
}

const PlanRail = forwardRef<PlanRailHandle, Props>(function PlanRail(
  { list, selectedSlug, query, searchHitSlugs, onSelect, onStartToggle, harnessSlug }: Props,
  ref,
) {
  const { data, loading, error, refresh } = list;

  // Filter reads — PlanFilters owns the writes; same nuqs keys.
  const [fBucket] = useQueryState(
    'pBucket',
    parseAsStringEnum<PlanBucket>(BUCKET_FILTER_VALUES),
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
    const filtered = applyPlanFilters(
      plans,
      { date: fDate, owner: fOwner, archived: fArchived, legacy: fLegacy, inbox: fInbox, actionable: fActionable },
      query,
      searchHitSlugs,
    );
    const bucketed = fBucket ? filtered.filter((p) => bucketOf(p) === fBucket) : filtered;
    return [...bucketed].sort((a, b) => {
      const sa = BUCKET_ORDER[bucketOf(a)] ?? 99;
      const sb = BUCKET_ORDER[bucketOf(b)] ?? 99;
      if (sa !== sb) return sa - sb;
      return (b.updated ?? '').localeCompare(a.updated ?? '');
    });
  }, [plans, fBucket, fOwner, fDate, fArchived, fLegacy, fInbox, fActionable, query, searchHitSlugs]);

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
      !!fBucket || !!fOwner || !!fDate || fArchived || fLegacy || fInbox || fActionable;
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
          onStartToggle={onStartToggle}
          harnessSlug={harnessSlug}
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
  onStartToggle,
  harnessSlug,
}: {
  plan: PlanListRow;
  active: boolean;
  onSelect: () => void;
  onStartToggle?: () => void;
  harnessSlug?: string | null;
}) {
  const title = plan.title ?? plan.slug;
  const source = sourceOfDraftPlan(plan);
  const [busy, setBusy] = useState(false);

  const handleStartToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setBusy(true);
      try {
        if (plan.startStatus === 'started') {
          await pausePlan(plan.slug);
        } else {
          await startPlan(plan.slug);
          // Auto-launch the harness process if not already running.
          if (harnessSlug) {
            try {
              await fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/launch?phase=staging`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
              });
            } catch {
              // Non-fatal — harness may already be running.
            }
          }
        }
        onStartToggle?.();
      } finally {
        setBusy(false);
      }
    },
    [plan.slug, plan.startStatus, onStartToggle, harnessSlug],
  );

  const isStarted = plan.startStatus === 'started';
  // Start/Pause only makes sense once a plan is approved — draft plans
  // must be approved first (no start button), and shipped/rejected are
  // terminal. So the inline toggle shows only for ready + running.
  const bucket = bucketOf(plan);
  const showStartToggle = bucket === 'ready' || bucket === 'running';

  return (
    <li className={`pc-plan-rail__item pc-plan-rail__item--${plan.status}${isStarted ? ' pc-plan-rail__item--started' : ''}`}>
      <button
        type="button"
        className={`pc-plan-row ${active ? 'is-active' : ''}`}
        onClick={onSelect}
        aria-label={`Open plan ${title} (${plan.slug})`}
        aria-current={active ? 'page' : undefined}
      >
        <div className="pc-plan-row__head">
          <span className="pc-plan-row__title">{title}</span>
          {showStartToggle ? (
            <button
              type="button"
              className={`pc-plan-row__start-btn${isStarted ? ' is-started' : ''}`}
              disabled={busy}
              onClick={handleStartToggle}
              title={isStarted ? 'Pause plan (orchestrator stops picking features)' : 'Start plan (orchestrator picks features from this plan)'}
              aria-label={isStarted ? `Pause plan ${plan.slug}` : `Start plan ${plan.slug}`}
            >
              {isStarted ? <Pause size={11} /> : <Play size={11} />}
              {isStarted ? 'Pause' : 'Start'}
            </button>
          ) : null}
        </div>
        <div className="pc-plan-row__meta-line">
          {source ? <SourcePill source={source} /> : null}
          {plan.harness ? <HarnessPill harness={plan.harness} /> : null}
          <StatusPill status={plan.status} />
          {plan.updated ? (
            <span
              className="pc-plan-row__updated"
              title={`Last updated ${formatUpdated(plan.updated)}`}
            >
              <Clock size={12} aria-hidden />
              {formatUpdatedShort(plan.updated)}
            </span>
          ) : null}
        </div>
        {plan.itemCounts ? <PlanProgressBar counts={plan.itemCounts} /> : null}
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

/**
 * Harness pill — P-023. Shows the resolved harness slug each plan
 * row lives in so the rail is legible when the user expands the
 * scope to include multiple harnesses (Phase 2 sub-harness scope).
 */
function HarnessPill({ harness }: { harness: string }) {
  return (
    <Tooltip label={`harness: ${harness}`}>
      <span className="pc-pill pc-pill--harness">{harness}</span>
    </Tooltip>
  );
}

/**
 * Whether a draft plan was authored by the user or by the scoper. Mirrors
 * the convention used by the plansDrafts.bySlug resolver so the rail and
 * ProposalsPanel agree on labelling — only draft plans get a source tag
 * (active/shipped plans have outlived the proposal stage).
 */
function sourceOfDraftPlan(plan: PlanListRow): 'user' | 'scoper' | null {
  if (plan.status !== 'draft') return null;
  return plan.slug.startsWith('scoper-proposal-') ? 'scoper' : 'user';
}

function SourcePill({ source }: { source: 'user' | 'scoper' }) {
  return (
    <span
      className={`pc-pill pc-pill--source-${source}`}
      title={source === 'scoper' ? 'Authored by the scoper' : 'Authored by you'}
    >
      {source === 'scoper' ? 'scoper' : 'you'}
    </span>
  );
}

import { formatRelativeUpdated } from '@/lib/format/relative-time';

/**
 * Thin wrapper kept for call-site stability inside this file. The
 * canonical implementation lives at `@/lib/format/relative-time`
 * (P-027 / D-011) so the picker in AdvSessionsClient + any future
 * caller renders the same "Nd ago" string.
 */
function formatUpdated(updated: string): string {
  return formatRelativeUpdated(updated);
}

/**
 * Bare relative time for the row's last-updated chip — drops the
 * trailing " ago" so it reads as a compact "4d" / "today" next to the
 * clock icon (the full "4d ago" stays in the title attribute).
 */
function formatUpdatedShort(updated: string): string {
  return formatRelativeUpdated(updated).replace(/\s*ago$/, '');
}

/** P-023: segmented progress bar showing done / active / remaining proportions. */
function PlanProgressBar({
  counts,
}: {
  counts: Partial<Record<ItemStatus | 'unknown', number>>;
}) {
  const done = counts['done'] ?? 0;
  const active = (counts['wip'] ?? 0) + (counts['needs-human'] ?? 0);
  const remaining = (counts['todo'] ?? 0) + (counts['blocked'] ?? 0) + (counts['unknown'] ?? 0);
  const total = done + active + remaining + (counts['dropped'] ?? 0);
  if (total === 0) return null;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  return (
    <div
      className="pc-plan-row__progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={`${done} of ${total} items done`}
      title={`${done} done · ${active} active · ${remaining} remaining`}
    >
      {done > 0 && <span className="pc-progress__done" style={{ width: pct(done) }} />}
      {active > 0 && <span className="pc-progress__active" style={{ width: pct(active) }} />}
      {remaining > 0 && <span className="pc-progress__remaining" style={{ width: pct(remaining) }} />}
    </div>
  );
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
