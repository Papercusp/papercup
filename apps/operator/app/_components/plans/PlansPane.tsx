'use client';

/**
 * PlansPane (owner-plans-single-pane-2026-07-17 P-001/P-002) — the simplified
 * plan-tracking face of the op-chat sidebar (`?opcv=plans`), beside the Inbox
 * face. The owner's ask: plan tracking is too complicated — so this pane is a
 * STATUS GLANCE, not a browser:
 *
 *   - ACTIVE plans only by default (bucketOf ∈ draft/ready/running); one
 *     search box; ONE "show finished" toggle. None of the Create dock's 11
 *     filter facets — authoring/power-filtering stays in /adv Create.
 *   - Every row answers "does this need me?" without opening it: a needs-you
 *     badge (decision-tier attention count), a live-agents count, item
 *     progress (done/total), and last-activity recency.
 *   - Sorted needs-you first, then most recently active.
 *   - Clicking a row opens the plan in a POPUP (PlanPopupModal → the same
 *     PlanDetail the Create tab renders, read-first) — never a navigation.
 *
 * REUSE, not re-derivation:
 *   - plan rows: the SAME `plans.list` sync feed (usePlanList) the Create
 *     dock + /admin/plans read (shared cache entry, SSE-invalidated);
 *   - needs-you counts: the SAME `plans.attention` feed the Inbox badge and
 *     Queue read (useInboxAttention → effectiveTier === 'decision');
 *   - live-agent counts: the SAME `advRoster.list` sync feed the Sessions
 *     roster reads (active entries' currentPlanSlug).
 *
 * State lives in the URL (nuqs) so the pane is deep-linkable and
 * agent-driveable: `?plq` search, `?plf` show-finished, `?pplan` popup plan,
 * `?ppv` popup tab (see PlanPopupModal).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Archive, ClipboardList } from 'lucide-react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { Tooltip } from '@/app/harness/Tooltip';
import { useDebouncedValue } from '@/app/harness/picker-kit';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { preloadVditor } from '@/app/_components/MarkdownEditor';
import { beginInteraction, PERF_INTERACTIONS } from '@/app/_components/perf/perf-marks';
import {
  bucketOf,
  setPlanArchived,
  usePlanList,
  type PlanBucket,
  type PlanListRow,
} from '@/app/admin/plans/plans-api';
import { effectiveTier, useInboxAttention } from '../inbox/use-inbox-pending';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import PlanPopupModal from './PlanPopupModal';
import './plans-pane.css';
import { advRosterArgs } from '@/lib/adv-roster-args';

/** Buckets shown by default — "not started + started", never the finished. */
const ACTIVE_BUCKETS: ReadonlySet<PlanBucket> = new Set(['draft', 'ready', 'running']);

/** An active plan with no real activity for this long reads as "stale" — a
 *  visibility nudge against plan sprawl (owner-plans-single-pane P-008). */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A literal kitchen-blender glyph (owner: "should be an icon of a blender").
 * Hand-drawn because lucide-react has NO blender — checked, not assumed: 5,849
 * exports, and its `Blend` is the blend-MODE overlapping-circles glyph, an
 * unrelated meaning that would have read as wrong rather than merely plain.
 *
 * Drawn to lucide's own contract (24×24, fill:none, stroke:currentColor,
 * width 2, round cap/join) so it inherits sizing + colour exactly like the
 * `Archive`/`ClipboardList` icons beside it and needs no special-casing.
 *
 * The four strokes are lid / tapered jar / HANDLE / flared motor base, and each
 * earned its place by being rendered and looked at rather than reasoned about:
 *   - an earlier draft tapered straight into a narrow base and read as a FUNNEL,
 *     because the silhouette ran wide→narrow→narrower. A blender's profile is
 *     wide jar → waist → WIDER squat base, so the flare is what says "appliance";
 *   - without the handle the flared version still read as a cocktail shaker or a
 *     trophy. The handle is the single cue that makes it a jug, and a jug on a
 *     motor base is unambiguously a blender.
 * Size defaults to 16, not the 13 of the first cut: rasterised at 13 the handle
 * collapsed into a two-pixel blob. 16 is the smallest size at which all three
 * cues survive, and it serves the "hard to miss" ask at the same time.
 */
function BlenderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 3h12" />
      <path d="M6 3 7.5 13h6L15 3" />
      <path d="M15.5 4.5a3 3 0 0 1 0 6" />
      <path d="M6.5 13h8v3.5a2.5 2.5 0 0 1-2.5 2.5H9a2.5 2.5 0 0 1-2.5-2.5z" />
    </svg>
  );
}

/** True when an active plan hasn't been touched in ≥ STALE_MS. Pure. */
export function isStale(updated: string | null | undefined, now = Date.now()): boolean {
  if (!updated) return false;
  const t = Date.parse(updated);
  return Number.isFinite(t) && now - t >= STALE_MS;
}

/** Compact relative recency — same local convention as the roster/backup panes. */
export function agoLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** done / total-open+done item progress from the list row's itemCounts. */
export function progressOf(row: Pick<PlanListRow, 'itemCounts'>): { done: number; total: number } | null {
  const c = row.itemCounts;
  if (!c) return null;
  let done = 0;
  let total = 0;
  for (const [k, v] of Object.entries(c)) {
    const n = v ?? 0;
    if (k === 'unknown') continue;
    total += n;
    if (k === 'done') done += n;
  }
  return total > 0 ? { done, total } : null;
}

export interface PlanGlanceRow {
  plan: PlanListRow;
  needsYou: number;
  liveAgents: number;
}

/** Filter + decorate + sort the raw plan list into the glance rows.
 *  Pure — exported for unit tests. */
export function buildGlanceRows(opts: {
  plans: readonly PlanListRow[];
  query: string;
  showFinished: boolean;
  needsYouByPlan: ReadonlyMap<string, number>;
  liveByPlan: ReadonlyMap<string, number>;
}): PlanGlanceRow[] {
  const q = opts.query.trim().toLowerCase();
  const rows: PlanGlanceRow[] = [];
  for (const plan of opts.plans) {
    if (plan.archived || plan.isLegacy) continue;
    const bucket = bucketOf(plan);
    if (!opts.showFinished && !ACTIVE_BUCKETS.has(bucket)) continue;
    if (q) {
      const hay = `${plan.title ?? ''} ${plan.slug}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    rows.push({
      plan,
      needsYou: opts.needsYouByPlan.get(plan.slug) ?? 0,
      liveAgents: opts.liveByPlan.get(plan.slug) ?? 0,
    });
  }
  rows.sort((a, b) => {
    if (a.needsYou !== b.needsYou) return b.needsYou - a.needsYou;
    const au = a.plan.updated ? Date.parse(a.plan.updated) : 0;
    const bu = b.plan.updated ? Date.parse(b.plan.updated) : 0;
    return bu - au;
  });
  return rows;
}

/** The advRoster.list payload's one row (subset this pane reads). */
interface RosterPayloadRow {
  active?: Array<{ currentPlanSlug?: string | null }>;
}

export default function PlansPane() {
  const [query, setQuery] = useQueryState('plq', parseAsString.withDefault(''));
  const [showFinished, setShowFinished] = useQueryState('plf', parseAsBoolean.withDefault(false));
  const [popupPlan, setPopupPlan] = useQueryState('pplan', parseAsString);

  // Warm the Vditor stack shortly after the Plans face mounts, so the first
  // plan popup opens WARM (~430ms) instead of paying the ~600ms cold Lute/WASM
  // init on the click (WI-5547 — the "several seconds to load a plan" report).
  // A plain setTimeout (NOT requestIdleCallback — unreliable in the Tauri
  // WebKitGTK webview) guarantees it fires; the 600ms delay yields the mount +
  // initial list render before the warm work runs off the critical path.
  useEffect(() => {
    const t = window.setTimeout(() => void preloadVditor(), 600);
    return () => window.clearTimeout(t);
  }, []);

  // The input updates ?plq on every keystroke (instant), but the EXPENSIVE
  // consumer — buildGlanceRows re-filtering + re-rendering the whole (up to
  // ~500-row) unvirtualized list — reads this DEBOUNCED value, so typing stays
  // responsive and the heavy re-render runs once typing settles. Same lesson
  // the Create dock's PlanRail learned (a fresh filter per keystroke lagged ~1s).
  const debouncedQuery = useDebouncedValue(query, 200);

  const planList = usePlanList({});
  const { items: attentionItems } = useInboxAttention();
  const workspaceId = useWorkspaceId();

  // Live-agent counts: the shared Sessions-roster sync entry (no new query
  // when the roster panel is also mounted). Reading only active[].currentPlanSlug.
  // NB this comment was ASPIRATIONAL until P-026 — the call site omitted
  // `endedLimit`, and an omitted field is a different query key even though the
  // resolver defaults it to the same value. advRosterArgs makes it true.
  const roster = useSyncQuery<RosterPayloadRow>({
    queryName: 'advRoster.list',
    args: advRosterArgs(workspaceId),
  });

  const needsYouByPlan = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of attentionItems) {
      if (!i.planSlug) continue;
      if (effectiveTier(i) !== 'decision') continue;
      m.set(i.planSlug, (m.get(i.planSlug) ?? 0) + 1);
    }
    return m;
  }, [attentionItems]);

  const liveByPlan = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of roster.data?.[0]?.active ?? []) {
      const slug = e.currentPlanSlug;
      if (!slug) continue;
      m.set(slug, (m.get(slug) ?? 0) + 1);
    }
    return m;
  }, [roster.data]);

  const plans = planList.data?.plans;
  const rows = useMemo(
    () =>
      buildGlanceRows({
        plans: plans ?? [],
        query: debouncedQuery,
        showFinished,
        needsYouByPlan,
        liveByPlan,
      }),
    [plans, debouncedQuery, showFinished, needsYouByPlan, liveByPlan],
  );

  const popupRow = popupPlan ? (plans ?? []).find((p) => p.slug === popupPlan) ?? null : null;

  // Stale-plan sweep (P-008 / EI-15304): archive a stale plan in one click,
  // behind a confirm. Archiving flips the PG-canonical harness_plans.archived
  // flag (plans:set-archived) — reversible; the row then drops out of this list
  // because every plan reader filters `archived = false`.
  //
  // We refresh the plan list EXPLICITLY after the write instead of waiting on
  // the harness_plans → plans.list SSE invalidation: live-verified in an
  // isolated shell, the archived row was still rendered 3s after a confirmed
  // write, so relying on the push alone leaves the user staring at a plan they
  // just archived. Same post-write refresh PlansListPanel already does.
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const onArchive = useCallback(
    async (plan: PlanListRow) => {
      const ok = await askConfirm({
        title: 'Archive this plan?',
        body: `“${plan.title ?? plan.slug}” will drop out of your plan lists. You can restore it later — archiving is reversible and never deletes anything.`,
        confirmLabel: 'Archive',
      });
      if (!ok) return;
      try {
        const res = await setPlanArchived({ slug: plan.slug, archived: true, harness: plan.harness });
        if ((res as { ok?: boolean }).ok === false) {
          toast.error(`Could not archive: ${(res as { error?: string }).error ?? 'unknown error'}`);
          return;
        }
        toast.success(`Archived “${plan.title ?? plan.slug}”.`);
        planList.refresh();
      } catch (e) {
        toast.error(`Could not archive: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    },
    [askConfirm, planList],
  );

  // Virtualize the row list (WI-5339): the active set is ~466 rows and up to
  // ~977 with Finished on — rendering them all unvirtualized made a ~89k-px DOM
  // and a ~600ms filter re-render in an always-visible sidebar. Only the rows
  // near the viewport mount now; heights self-correct via measureElement.
  const listRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 52,
    overscan: 10,
    getItemKey: (i) => `${rows[i]!.plan.harness}:${rows[i]!.plan.slug}`,
  });

  return (
    <div className="plans-pane" data-testid="plans-pane">
      <div className="plans-pane__bar">
        <input
          type="search"
          className="plans-pane__search"
          placeholder="Search plans…"
          value={query}
          onChange={(e) => void setQuery(e.target.value || null)}
          aria-label="Search plans"
          data-testid="plans-pane-search"
        />
        <Tooltip label={showFinished ? 'Hide finished plans' : 'Also show shipped / superseded plans'}>
          <button
            type="button"
            className={`plans-pane__finished-toggle${showFinished ? ' is-on' : ''}`}
            onClick={() => void setShowFinished(showFinished ? null : true)}
            aria-pressed={showFinished}
            data-testid="plans-pane-finished-toggle"
          >
            Finished
          </button>
        </Tooltip>
      </div>

      {planList.loading && !plans ? (
        <div className="plans-pane__empty">Loading plans…</div>
      ) : rows.length === 0 ? (
        <div className="plans-pane__empty">
          <ClipboardList size={20} className="plans-pane__empty-icon" aria-hidden="true" />
          <span>
          {debouncedQuery.trim()
            ? 'No plans match the search.'
            : !plans || plans.length === 0
              ? // Feed not yet hydrated (or a genuinely empty workspace) — NEVER
                // the celebratory "all finished" here. On a cold/slow load
                // `plans` is briefly empty (sometimes with loading already
                // false), which used to flash "everything is finished 🎉" over
                // ~466 real active plans before the list populated (WI-5338).
                planList.loading
                ? 'Loading plans…'
                : 'No plans yet.'
              : showFinished
                ? 'No plans yet.'
                : 'No active plans — everything is finished. 🎉'}
          </span>
        </div>
      ) : (
        <div className="plans-pane__list" ref={listRef} role="list" aria-label="Plans">
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const { plan, needsYou, liveAgents } = rows[vi.index]!;
              const progress = progressOf(plan);
              const bucket = bucketOf(plan);
              // WI-5365: left-accent priority — needs-you (red) outranks live (green).
              const accent = needsYou > 0 ? ' plans-pane__row--needs' : liveAgents > 0 ? ' plans-pane__row--live' : '';
              return (
                <div
                  key={vi.key}
                  role="listitem"
                  data-index={vi.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    paddingBottom: 4,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                <button
                  type="button"
                  className={`plans-pane__row${accent}`}
                  onClick={() => {
                    // Time the real "open a plan" interaction (WI-5547): this
                    // start mark is consumed when the plan body renders in
                    // Vditor (PlanEditor.handleParsed → endInteraction).
                    beginInteraction(PERF_INTERACTIONS.planPopupOpen);
                    void setPopupPlan(plan.slug);
                  }}
                  data-testid={`plans-pane-row-${plan.slug}`}
                >
                  <span className="plans-pane__row-main">
                    <span className="plans-pane__row-title">{plan.title ?? plan.slug}</span>
                    <span className="plans-pane__row-sub">
                      {bucket !== 'running' ? (
                        <span className={`plans-pane__bucket plans-pane__bucket--${bucket}`}>{bucket}</span>
                      ) : null}
                      <span className="plans-pane__row-harness">{plan.harness}</span>
                      <span className="plans-pane__row-ago" title={plan.updated ?? undefined}>
                        {agoLabel(plan.updated)}
                      </span>
                    </span>
                  </span>
                  <span className="plans-pane__row-badges">
                    {/* Provenance (WI-39439): marks ONLY plans the Blender/Scout
                        ideation loop routed. Absence means human- or
                        standard-agent-authored — including an su agent's own
                        IDEATE pass (`su-ideate`), which is deliberately NOT
                        marked: the owner's split is Blender vs everything else.
                        `origin` is only ever 'scout' because the server-side
                        derivation filters on it (scout/routed-ledger.ts); do not
                        re-widen this test to "any ledger row" — that was the bug
                        this shipped with, wrong on 75% of the rows it lit. */}
                    {plan.origin === 'scout' ? (
                      <span
                        className="plans-pane__badge plans-pane__badge--blender"
                        title="Blender-made — routed by the Blender/Scout ideation loop"
                        data-testid="plans-pane-blender-badge"
                      >
                        <BlenderIcon />
                        {/* The word ships too (owner: "hard to miss"). It is a REAL
                            label, not sr-only: a lone glyph in a badge strip is
                            exactly what the eye skips, and a blender drawn at 13px
                            is not self-evident on first encounter. */}
                        Blender
                      </span>
                    ) : null}
                    {needsYou > 0 ? (
                      <span
                        className="plans-pane__badge plans-pane__badge--needs"
                        title={`${needsYou} decision${needsYou === 1 ? '' : 's'} need you`}
                        data-testid="plans-pane-needs-badge"
                      >
                        {needsYou}
                      </span>
                    ) : null}
                    {liveAgents > 0 ? (
                      <span
                        className="plans-pane__badge plans-pane__badge--live"
                        title={`${liveAgents} agent${liveAgents === 1 ? '' : 's'} working now`}
                        data-testid="plans-pane-live-badge"
                      >
                        ●&nbsp;{liveAgents}
                      </span>
                    ) : null}
                    {progress ? (
                      <span
                        className="plans-pane__badge plans-pane__badge--progress"
                        title={`${progress.done} of ${progress.total} items done`}
                      >
                        {progress.done}/{progress.total}
                      </span>
                    ) : null}
                    {!showFinished && isStale(plan.updated) ? (
                      <span
                        className="plans-pane__badge plans-pane__badge--stale"
                        title={`No activity since ${plan.updated} — a candidate to archive`}
                        data-testid="plans-pane-stale-badge"
                      >
                        stale
                      </span>
                    ) : null}
                  </span>
                  {progress ? (
                    // WI-5365: glanceable done/total as a 2px strip along the
                    // row's bottom edge (the n/m badge stays the precise read).
                    <span className="plans-pane__progress-track" aria-hidden="true">
                      <span
                        className="plans-pane__progress-fill"
                        style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                      />
                    </span>
                  ) : null}
                </button>
                {/* P-008 / EI-15304: one-click archive for a STALE row — the
                    sprawl sweep. A SIBLING of the row button, never nested
                    (a <button> inside a <button> is invalid HTML — the trap
                    InboxPane already hit). Scoped to stale rows so the
                    ~466-row list stays visually clean. */}
                {!showFinished && isStale(plan.updated) ? (
                  <Tooltip label="Archive this stale plan (reversible)">
                    <button
                      type="button"
                      className="plans-pane__archive"
                      onClick={() => void onArchive(plan)}
                      aria-label={`Archive ${plan.title ?? plan.slug}`}
                      data-testid={`plans-pane-archive-${plan.slug}`}
                    >
                      <Archive size={12} aria-hidden="true" />
                    </button>
                  </Tooltip>
                ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {confirmEl}

      <PlanPopupModal
        planSlug={popupPlan}
        harnessSlug={popupRow?.harness ?? null}
        planTitle={popupRow?.title ?? popupPlan}
        onClose={() => void setPopupPlan(null)}
      />
    </div>
  );
}
