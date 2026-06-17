/**
 * QueenTab — the owner's Queen steering panel, docked in the Colony left sidebar
 * (queen-steering-panel-2026-06-15 B-04 / P-004; owner-review rounds 1–2, 2026-06-15).
 *
 * The owner steers the workspace's HOME Queen WITHOUT an interactive session.
 * Owner-review layout (top→bottom): Pause new work · Focus directive · Model
 * tiers (session override — #4, lands here once its backend field exists) ·
 * Eligible Hives · Eligible Plans.
 *
 * Two steering axes, both per-hive checkbox multi-selects (D-002 — eligibility is
 * DISTINCT from lifecycle status / membership):
 *  - Eligible PLANS — which plans she may pick up NOW. Empty ⇒ any plan.
 *  - Eligible HIVES — the placement SCOPE (which hives/harnesses she may place
 *    into → the survey's `allowedHarnesses`, enforced by C-2). Empty ⇒ anywhere.
 * Empty selection ⇒ NO restriction (today's behaviour) — surfaced loudly so an
 * empty list never reads as "nothing is eligible".
 *
 * There is NO "which hive to steer" picker (owner-review round 2): the tab always
 * steers the workspace's HOME Queen. The hive set is rendered as the Eligible
 * Hives SCOPE checkboxes instead of a confusing dropdown.
 *
 * Lives in the Colony left sidebar (LeftSidebar.tsx) — a narrow, collapsible
 * rail — as the DEFAULT-OPEN, leftmost tab. Rendered only while active.
 *
 * Data (CONTRACT C-1, su-81fe / B-01 + the round-2 `eligibleHives` extension):
 *  - hive set ← `harnessProjects.lite` via useSyncQuery (the SAME set the main
 *    AdvShell selector shows — buildHarnessSelectOptions).
 *  - steering ← `hive.steering` via useSyncQuery (the home hive's row).
 *  - writes   → `hive:set-steering` via /api/agent-mcp/run-tool (invalidates
 *    `hive.steering` + wakes the Queen).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, CalendarClock, Crown, ListChecks, Network, Pause, Play, RotateCcw } from 'lucide-react';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import type { ModelTier } from '@papercusp/operator-core/lib/agent-config-constants';
import { usePlanList, type PlanListRow } from '@/app/admin/plans/plans-api';
import { Checkbox } from '@/app/harness/Checkbox';
import { buildHarnessSelectOptions } from '../adv/AdvShell';
import { ALL_HARNESSES_OPTION } from '../adv/adv-harness-selection';
import ScheduledRoutinesPane from '../adv/ScheduledRoutinesPane';
import QueenHeartbeat from './QueenHeartbeat';
import ModelTiersOverride from './ModelTiersOverride';
import HiveSteeringTree from './HiveSteeringTree';
import {
  buildSteeringTree,
  detectIllegalEligiblePlans,
  indexPlansByHive,
  setAllHives as treeSetAllHivesFn,
  setHivePlans as treeSetHivePlansFn,
  toggleHive as treeToggleHiveFn,
  togglePlan as treeTogglePlanFn,
  type SteeringSelection,
  type TreePlanInput,
} from './hive-steering-tree';

/** One row of the `hive.steering` sync query (C-1, B-01 + round-2 eligibleHives). */
export interface HiveSteeringRow {
  slug: string;
  directive: string | null;
  eligiblePlans: string[];
  eligibleHives: string[];
  pauseNewWork: boolean;
  pausedUntil: number | null;
  /** Session model-tier override (D-006); null ⇒ workspace default. */
  modelTiers?: ModelTier[] | null;
}

const DEFAULT_STEERING: Omit<HiveSteeringRow, 'slug'> = {
  directive: null,
  eligiblePlans: [],
  eligibleHives: [],
  pauseNewWork: false,
  pausedUntil: null,
  modelTiers: null,
};

const EMPTY_PLANS: readonly PlanListRow[] = [];

type LiteProject = { slug: string; parent_slug?: string | null; harness_kind?: string | null };

export interface SteerPlanRow {
  slug: string;
  title: string;
  status: string | null;
  startStatus: string | null;
  inActive: boolean;
  eligible: boolean;
}

function planRank(p: PlanListRow): number {
  return p.startStatus === 'started' ? 0 : p.status === 'active' ? 1 : p.status === 'ready' ? 2 : 3;
}

/** Eligibility CANDIDATES: non-terminal plans (draft/ready/active), in-flight first. Pure. */
export function selectSteerablePlans(rows: readonly PlanListRow[]): PlanListRow[] {
  return rows
    .filter((p) => p.status !== 'shipped' && p.status !== 'superseded' && !p.archived)
    .slice()
    .sort((a, b) => planRank(a) - planRank(b) || (b.updated ?? '').localeCompare(a.updated ?? ''));
}

/** Candidates merged with the eligible set (+ stale eligible slugs not in the list). Pure. */
export function buildSteerRows(active: readonly PlanListRow[], eligible: readonly string[]): SteerPlanRow[] {
  const eligibleSet = new Set(eligible);
  const seen = new Set<string>();
  const out: SteerPlanRow[] = [];
  for (const p of active) {
    seen.add(p.slug);
    out.push({
      slug: p.slug,
      title: p.title ?? p.slug,
      status: p.status ?? null,
      startStatus: p.startStatus ?? null,
      inActive: true,
      eligible: eligibleSet.has(p.slug),
    });
  }
  for (const slug of eligible) {
    if (!seen.has(slug)) out.push({ slug, title: slug, status: null, startStatus: null, inActive: false, eligible: true });
  }
  return out;
}

/** Add/remove a slug from an eligible set (the checkbox toggle). Pure. */
export function toggleEligible(current: readonly string[], slug: string): string[] {
  return current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug];
}

/** The steerable hive set as checkbox options — the SAME set the main AdvShell
 *  selector shows, minus the non-steering "All" + loading rows. Pure. */
export function steerHiveOptions(projects: LiteProject[]): Array<{ value: string; label: string }> {
  // buildHarnessSelectOptions returns SelectEntry[]: the "All" row plus a
  // workspace group wrapping the Hive → member tree. Flatten it to the steerable
  // rows (drop the non-steering "All" + loading rows; keep the member indent).
  const flat: Array<{ value: string; label: string }> = [];
  for (const entry of buildHarnessSelectOptions(projects, null)) {
    const opts = 'kind' in entry && entry.kind === 'group' ? entry.options : [entry];
    for (const o of opts) {
      if (o.value === ALL_HARNESSES_OPTION || o.value === '__loading') continue;
      flat.push({ value: o.value, label: typeof o.label === 'string' ? o.label : String(o.label) });
    }
  }
  return flat;
}

/** The HOME Queen's hive: the first formal hive (kind:'hive'), else the first
 *  steering row. The tab always steers this one (owner-review round 2). Pure. */
export function resolveHomeHive(projects: LiteProject[], rows: readonly HiveSteeringRow[]): string {
  return projects.find((p) => p.harness_kind === 'hive')?.slug || rows[0]?.slug || '';
}

async function runSetSteering(args: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hive:set-steering', args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  const payload = text ? (JSON.parse(text) as { ok?: boolean; message?: string }) : { ok: true };
  if (payload.ok === false) throw new Error(payload.message ?? 'hive:set-steering refused');
}

/** The pause badge state: indefinite pause, a timed pause still in the future,
 *  or "flowing". Pure (now is injected). */
export function pauseStateLabel(row: HiveSteeringRow, nowMs: number): { active: boolean; label: string } {
  if (row.pauseNewWork) return { active: true, label: 'New work PAUSED' };
  if (row.pausedUntil != null && nowMs < row.pausedUntil) {
    const mins = Math.max(1, Math.round((row.pausedUntil - nowMs) / 60000));
    return { active: true, label: `Paused ~${mins}m` };
  }
  return { active: false, label: 'New work flowing' };
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export default function QueenTab({ active }: { active: boolean }) {
  const steeringQ = useSyncQuery<HiveSteeringRow>({ queryName: 'hive.steering', args: {}, staleTime: 15_000 });
  const projectsQ = useSyncQuery<LiteProject>({ queryName: 'harnessProjects.lite', args: {}, staleTime: 60_000, enabled: active });
  const plansQ = usePlanList({ includeArchived: false, includeLegacy: false });
  const navigate = useNavigate();

  const [saving, setSaving] = useState(false);
  // Optimistic overlay over the server steering row (owner bug 2026-06-16). The
  // REF is the synchronous source of truth for back-to-back toggles (React state
  // lags a render, so two clicks in one tick would otherwise both read stale); the
  // STATE drives re-render. overlay() + the reconcile effect keep them in lockstep.
  const [optimistic, setOptimistic] = useState<Partial<Omit<HiveSteeringRow, 'slug'>> | null>(null);
  const optimisticRef = useRef<Partial<Omit<HiveSteeringRow, 'slug'>> | null>(null);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const inflightRef = useRef(0);
  const [err, setErr] = useState<string | null>(null);
  const [pauseMins, setPauseMins] = useState('30');

  const projects = projectsQ.data ?? [];
  const rows = (steeringQ.data ?? []) as HiveSteeringRow[];
  const home = resolveHomeHive(projects, rows);
  const current: HiveSteeringRow = rows.find((r) => r.slug === home) ?? { slug: home, ...DEFAULT_STEERING };
  // The VIEW = the server row + an optimistic overlay. Fast checkbox clicks used
  // to read-modify-write the SERVER array, so a 2nd click before the refetch read
  // the stale array and CLOBBERED the 1st (owner bug 2026-06-16). Every toggle now
  // reads + updates the overlay (never the stale server row), and writes are
  // SERIALIZED so the server applies them in click order.
  const view: HiveSteeringRow = { ...current, ...(optimistic ?? {}) };

  // Once writes drain and fresh server data lands, drop the overlay so the server
  // row is the source of truth again (no permanent divergence).
  useEffect(() => {
    if (inflightRef.current === 0) {
      optimisticRef.current = null;
      setOptimistic(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steeringQ.data]);

  const hiveOptions = useMemo(() => steerHiveOptions(projects), [projects]);
  const sourcePlans = plansQ.data?.plans ?? EMPTY_PLANS;
  const candidates = useMemo(() => selectSteerablePlans(sourcePlans), [sourcePlans]);
  const planRows = useMemo(() => buildSteerRows(candidates, view.eligiblePlans), [candidates, view.eligiblePlans]);
  const planRestricted = view.eligiblePlans.length > 0;
  const hiveRestricted = view.eligibleHives.length > 0;
  const pause = pauseStateLabel(view, Date.now());
  const scopeLabel = hiveRestricted || planRestricted
    ? `${hiveRestricted ? countLabel(view.eligibleHives.length, 'hive') : 'any hive'} · ${planRestricted ? countLabel(view.eligiblePlans.length, 'plan') : 'any plan'}`
    : 'Any hive · any plan';
  const directiveLabel = view.directive?.trim() ? 'Directive set' : 'No directive';
  const tierLabel = view.modelTiers?.length ? `${countLabel(view.modelTiers.length, 'tier')} override` : 'Workspace tiers';

  // ── Nested hive→plan picker (steering-nested-hive-plan-tree-2026-06-17, P-002) ──
  const steeringTreeOn = useFlag(FLAGS.STEERING_HIVE_TREE);
  // Candidates carry `.harness`; eligible slugs NOT in the candidate list are
  // stale → synthetic unassigned rows (harness '') so they stay visible.
  const treePlans: TreePlanInput[] = useMemo(() => {
    const fromCandidates: TreePlanInput[] = candidates.map((p) => ({
      slug: p.slug,
      title: p.title ?? p.slug,
      status: p.status ?? null,
      startStatus: p.startStatus ?? null,
      harness: p.harness,
      inActive: true,
    }));
    const seen = new Set(candidates.map((c) => c.slug));
    const stale: TreePlanInput[] = view.eligiblePlans
      .filter((s) => !seen.has(s))
      .map((slug) => ({ slug, title: slug, status: null, startStatus: null, harness: '', inActive: false }));
    return [...fromCandidates, ...stale];
  }, [candidates, view.eligiblePlans]);
  // hivePlans / planToHive depend only on candidate harnesses (stale eligibles are
  // always unassigned), so the toggle structural map is stable.
  const planIndex = useMemo(() => indexPlansByHive(hiveOptions, treePlans), [hiveOptions, treePlans]);
  const steeringSelection: SteeringSelection = { eligibleHives: view.eligibleHives, eligiblePlans: view.eligiblePlans };
  const steeringTree = useMemo(
    () => buildSteeringTree(hiveOptions, treePlans, { eligibleHives: view.eligibleHives, eligiblePlans: view.eligiblePlans }),
    [hiveOptions, treePlans, view.eligibleHives, view.eligiblePlans],
  );
  const illegalCount = detectIllegalEligiblePlans(steeringSelection, planIndex.planToHive).length;

  /** Serialized, fail-soft write (the optimistic fields are already in `view`). */
  const enqueue = (patch: Record<string, unknown>) => {
    if (!home) {
      setErr('No home hive found — start a hive first.');
      return;
    }
    inflightRef.current += 1;
    setSaving(true);
    setErr(null);
    chainRef.current = chainRef.current
      .then(() => runSetSteering({ hive: home, ...patch }))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        inflightRef.current -= 1;
        if (inflightRef.current === 0) {
          setSaving(false);
          void steeringQ.invalidate?.();
        }
      });
  };
  const overlay = (patch: Partial<Omit<HiveSteeringRow, 'slug'>>) => {
    optimisticRef.current = { ...(optimisticRef.current ?? {}), ...patch };
    setOptimistic(optimisticRef.current);
  };
  /** The LIVE steering (server row + the synchronous overlay ref) — toggles read
   *  THIS so back-to-back clicks in one tick accumulate instead of clobbering. */
  const live = (): HiveSteeringRow => ({ ...current, ...(optimisticRef.current ?? {}) });

  const togglePlan = (slug: string) => {
    const next = toggleEligible(live().eligiblePlans, slug);
    overlay({ eligiblePlans: next });
    enqueue({ eligiblePlans: next });
  };
  const toggleHive = (slug: string) => {
    const next = toggleEligible(live().eligibleHives, slug);
    overlay({ eligibleHives: next });
    enqueue({ eligibleHives: next });
  };
  // Select-all / clear-all for each eligibility axis (owner-requested 2026-06-16).
  const setAllHives = (on: boolean) => {
    const next = on ? hiveOptions.map((h) => h.value) : [];
    overlay({ eligibleHives: next });
    enqueue({ eligibleHives: next });
  };
  const setAllPlans = (on: boolean) => {
    const next = on ? planRows.map((p) => p.slug) : [];
    overlay({ eligiblePlans: next });
    enqueue({ eligiblePlans: next });
  };
  const togglePause = () => {
    const next = !live().pauseNewWork;
    overlay({ pauseNewWork: next, pausedUntil: null });
    enqueue({ pauseNewWork: next, pausedUntil: null });
  };
  const pauseForMinutes = () => {
    const n = Number(pauseMins);
    if (!Number.isFinite(n) || n <= 0) {
      setErr('Enter a positive number of minutes.');
      return;
    }
    const until = Date.now() + Math.round(n) * 60_000;
    overlay({ pauseNewWork: false, pausedUntil: until });
    enqueue({ pauseNewWork: false, pausedUntil: until });
  };
  const clearPause = () => {
    overlay({ pauseNewWork: false, pausedUntil: null });
    enqueue({ pauseNewWork: false, pausedUntil: null });
  };
  const setModelTiers = (mt: ModelTier[] | null) => {
    overlay({ modelTiers: mt });
    enqueue({ modelTiers: mt });
  };
  const onSaveDirective = (text: string) => {
    const directive = text.trim() ? text : null;
    overlay({ directive });
    enqueue({ directive });
  };
  const clearAll = () => {
    overlay({ directive: null, eligiblePlans: [], eligibleHives: [], pauseNewWork: false, pausedUntil: null, modelTiers: null });
    enqueue({ clear: true });
  };

  // Nested-picker handlers (P-002): compute the next (eligibleHives, eligiblePlans)
  // via the pure toggles from the LIVE selection (the overlay ref, so back-to-back
  // clicks accumulate), then optimistic-write BOTH lists in click order.
  const liveSelection = (): SteeringSelection => {
    const l = live();
    return { eligibleHives: l.eligibleHives, eligiblePlans: l.eligiblePlans };
  };
  const applySteering = (next: SteeringSelection) => {
    overlay({ eligibleHives: next.eligibleHives, eligiblePlans: next.eligiblePlans });
    enqueue({ eligibleHives: next.eligibleHives, eligiblePlans: next.eligiblePlans });
  };
  const treeToggleHive = (slug: string) =>
    applySteering(treeToggleHiveFn(liveSelection(), slug, planIndex.hivePlans, planIndex.planToHive));
  const treeTogglePlan = (hiveSlug: string, planSlug: string) =>
    applySteering(treeTogglePlanFn(liveSelection(), hiveSlug, planSlug, planIndex.hivePlans, planIndex.planToHive));
  const treeSetHivePlans = (hiveSlug: string, on: boolean) =>
    applySteering(treeSetHivePlansFn(liveSelection(), hiveSlug, on, planIndex.hivePlans, planIndex.planToHive));
  const treeSetAllHives = (on: boolean) =>
    applySteering(treeSetAllHivesFn(liveSelection(), on, hiveOptions, planIndex.planToHive));

  return (
    <div className="pc-queen">
      <header className="pc-queen__bar">
        <Crown size={14} aria-hidden />
        <span className="pc-queen__identity">
          <span className="pc-queen__title">Queen</span>
          <span className="pc-queen__subtitle">Steering controls</span>
        </span>
        {home && <span className="pc-queen__hive" title="The home Queen this steers">{home}</span>}
        <span className="pc-queen__spacer" />
        <button type="button" className="pc-queen__reset" onClick={clearAll} disabled={saving} aria-label="Clear all steering back to default">
          <RotateCcw size={11} aria-hidden /> reset
        </button>
      </header>

      {/* Queen heartbeat — is she alive? (owner-priority, queen-heartbeat-2026-06-16) */}
      <QueenHeartbeat homeSlug={home} />

      <div className="pc-queen__summary" aria-label="Queen steering summary">
        <div className={`pc-queen__summary-item${pause.active ? ' pc-queen__summary-item--warn' : ' pc-queen__summary-item--good'}`}>
          <span className="pc-queen__summary-label">Work</span>
          <span className="pc-queen__summary-value">{pause.active ? pause.label : 'Flowing'}</span>
        </div>
        <div className={`pc-queen__summary-item${hiveRestricted || planRestricted ? ' pc-queen__summary-item--warn' : ''}`}>
          <span className="pc-queen__summary-label">Scope</span>
          <span className="pc-queen__summary-value">{scopeLabel}</span>
        </div>
        <div className="pc-queen__summary-item">
          <span className="pc-queen__summary-label">Brief</span>
          <span className="pc-queen__summary-value">{directiveLabel}</span>
        </div>
        <div className="pc-queen__summary-item">
          <span className="pc-queen__summary-label">Models</span>
          <span className="pc-queen__summary-value">{tierLabel}</span>
        </div>
      </div>

      {err && (
        <div className="pc-queen__err" role="alert">
          <AlertTriangle size={12} aria-hidden /> {err}
        </div>
      )}

      {/* 1 — Pause new work (TOPMOST, owner-review round 2) */}
      <section className="pc-queen__section pc-queen__section--pause">
        <div className="pc-queen__section-head">
          <span className="pc-queen__section-title">Pause new work</span>
          <span className={`pc-queen__pausebadge${pause.active ? ' pc-queen__pausebadge--on' : ''}`}>{pause.label}</span>
        </div>
        <button
          type="button"
          className={`pc-queen__btn pc-queen__btn--block${view.pauseNewWork ? ' pc-queen__btn--stop' : ' pc-queen__btn--go'}`}
          onClick={togglePause}
          disabled={saving}
        >
          {view.pauseNewWork ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
          {view.pauseNewWork ? 'Resume new work' : 'Pause indefinitely'}
        </button>
        <div className="pc-queen__pausefor">
          <label className="pc-queen__duration">
            <span className="pc-queen__presetlabel">for</span>
            <input type="number" min={1} className="pc-queen__mins" value={pauseMins} onChange={(e) => setPauseMins(e.target.value)} aria-label="Pause duration in minutes" />
            <span className="pc-queen__presetlabel">min</span>
          </label>
          <button type="button" className="pc-queen__chip" onClick={pauseForMinutes} disabled={saving}>apply</button>
          {view.pausedUntil != null && (
            <button type="button" className="pc-queen__chip" onClick={clearPause} disabled={saving}>clear</button>
          )}
        </div>
        <span className="pc-queen__hint">drives existing placements to terminal, starts nothing new</span>
      </section>

      {/* 2 — Focus directive */}
      <DirectiveEditor
        key={home}
        initial={view.directive ?? ''}
        busy={saving}
        onSave={onSaveDirective}
      />

      {/* 3 — Model tiers (session override, D-006 / #4) */}
      <ModelTiersOverride override={view.modelTiers ?? null} onWrite={setModelTiers} busy={saving} />

      {/* 4+5 — Steering scope. The nested hive→plan picker (P-002) makes the
          illegal "eligible plan under an excluded hive" state unrepresentable;
          the flag-OFF fallback is the legacy two flat lists. */}
      {steeringTreeOn ? (
        <HiveSteeringTree
          tree={steeringTree}
          illegalCount={illegalCount}
          busy={saving}
          loading={hiveOptions.length === 0 || (plansQ.loading && !plansQ.data)}
          onToggleHive={treeToggleHive}
          onTogglePlan={treeTogglePlan}
          onSetHivePlans={treeSetHivePlans}
          onSetAllHives={treeSetAllHives}
        />
      ) : (
        <>
          {/* 4 — Eligible Hives (placement scope, owner-review round 2) */}
          <section className="pc-queen__section">
            <div className="pc-queen__section-head">
              <Network size={12} aria-hidden />
              <span className="pc-queen__section-title">Eligible hives</span>
              <span className="pc-queen__count">{hiveRestricted ? `${view.eligibleHives.length} selected` : 'no restriction'}</span>
              <span className="pc-queen__spacer" />
              <button type="button" className="pc-queen__chip" onClick={() => setAllHives(true)} disabled={saving || hiveOptions.length === 0} aria-label="Select every hive">all</button>
              <button type="button" className="pc-queen__chip" onClick={() => setAllHives(false)} disabled={saving || !hiveRestricted} aria-label="Clear the hive scope">none</button>
            </div>
            <div className={`pc-queen__scope${hiveRestricted ? ' pc-queen__scope--restricted' : ''}`}>
              {hiveRestricted
                ? 'Queen may place ONLY into the checked hives. Uncheck all to remove the scope.'
                : 'Nothing checked → Queen may place into ANY hive. Check hives to scope where she places work.'}
            </div>
            {hiveOptions.length === 0 ? (
              <div className="pc-queen__placeholder">Loading hives…</div>
            ) : (
              <ul className="pc-queen__plans">
                {hiveOptions.map((h) => {
                  const on = view.eligibleHives.includes(h.value);
                  return (
                    <li key={h.value} className={`pc-queen__plan${on ? ' pc-queen__plan--on' : ''}`}>
                      <div className="pc-queen__planlabel">
                        <Checkbox className="pc-queen__check" checked={on} onChange={() => toggleHive(h.value)} ariaLabel={h.label} />
                        <span className="pc-queen__planslug" title={h.value}>{h.label}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* 5 — Eligible Plans */}
          <section className="pc-queen__section">
            <div className="pc-queen__section-head">
              <ListChecks size={12} aria-hidden />
              <span className="pc-queen__section-title">Eligible plans</span>
              <span className="pc-queen__count">{planRestricted ? `${view.eligiblePlans.length} selected` : 'no restriction'}</span>
              <span className="pc-queen__spacer" />
              <button type="button" className="pc-queen__chip" onClick={() => setAllPlans(true)} disabled={saving || planRows.length === 0} aria-label="Select every plan shown">all</button>
              <button type="button" className="pc-queen__chip" onClick={() => setAllPlans(false)} disabled={saving || !planRestricted} aria-label="Clear the plan restriction">none</button>
            </div>
            <div className={`pc-queen__scope${planRestricted ? ' pc-queen__scope--restricted' : ''}`}>
              {planRestricted
                ? 'Queen works ONLY the checked plans. Uncheck all to remove the restriction.'
                : 'Nothing selected → Queen may work ANY plan. Check plans to focus her (eligibility ≠ lifecycle status).'}
            </div>
            {plansQ.loading && !plansQ.data ? (
              <div className="pc-queen__placeholder">Loading plans…</div>
            ) : planRows.length === 0 ? (
              <div className="pc-queen__placeholder">No steerable plans.</div>
            ) : (
              <ul className="pc-queen__plans">
                {planRows.map((p) => (
                  <li key={p.slug} className={`pc-queen__plan${p.eligible ? ' pc-queen__plan--on' : ''}`}>
                    <div className="pc-queen__planlabel">
                      <Checkbox className="pc-queen__check" checked={p.eligible} onChange={() => togglePlan(p.slug)} ariaLabel={p.title} />
                      <span className="pc-queen__planslug" title={p.slug}>{p.title}</span>
                    </div>
                    <span className="pc-queen__planstatus" data-status={p.inActive ? (p.startStatus === 'started' ? 'started' : p.status ?? '') : 'stale'}>
                      {p.inActive ? (p.startStatus === 'started' ? 'live' : p.status ?? '') : 'not active'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {/* 6 — Scheduled routines (the ops glance, scheduled-recurring-plans P-026).
          Reads the same plans.scheduledOccurrences ledger the Calendar does; a row
          per scheduled plan with next-fire + armed/paused + last-run outcome. Click
          jumps to the Calendar focused on that plan. */}
      <section className="pc-queen__section">
        <div className="pc-queen__section-head">
          <CalendarClock size={12} aria-hidden />
          <span className="pc-queen__section-title">Scheduled routines</span>
          <span className="pc-queen__count">next 30 days</span>
        </div>
        <ScheduledRoutinesPane
          onSelect={(slug) =>
            void navigate({
              to: '/adv',
              search: (prev) => ({ ...(prev as Record<string, unknown>), tab: 'calendar', calPlan: slug }),
            })
          }
        />
      </section>

      <QueenStyles />
    </div>
  );
}

/** Focus-directive editor — a mid-edit draft (useState) seeded from the saved value; keyed per-hive. */
function DirectiveEditor({ initial, onSave, busy }: { initial: string; onSave: (text: string) => void; busy: boolean }) {
  const [text, setText] = useState(initial);
  const dirty = text !== initial;
  return (
    <section className="pc-queen__section">
      <div className="pc-queen__section-head">
        <span className="pc-queen__section-title">Focus directive</span>
        <span className="pc-queen__count">in every wake brief</span>
      </div>
      <textarea
        className="pc-queen__directive"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Only work the steering + benchmark plans; convert their items to work-items, place those, start nothing new."
        rows={3}
      />
      <div className="pc-queen__directive-actions">
        <button type="button" className="pc-queen__btn pc-queen__btn--save" onClick={() => onSave(text)} disabled={busy || !dirty}>
          {busy ? 'Saving…' : dirty ? 'Save directive' : 'Saved'}
        </button>
        {dirty && (
          <button type="button" className="pc-queen__chip" onClick={() => setText(initial)} disabled={busy}>revert</button>
        )}
      </div>
    </section>
  );
}

function QueenStyles() {
  return (
    <style>{`
      .pc-queen {
        --queen-accent: var(--warn, #fbbf24);
        display: flex; flex-direction: column; gap: 8px; padding: 9px 9px 14px; min-height: 0;
      }
      .pc-queen__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 11px; padding: 7px 2px; }
      .pc-queen__bar {
        display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 7px;
        padding: 2px 1px 4px; border-bottom: 1px solid color-mix(in srgb, var(--queen-accent), transparent 84%);
      }
      .pc-queen__bar svg { color: var(--queen-accent); }
      .pc-queen__identity { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .pc-queen__title { font-size: 13px; font-weight: 780; letter-spacing: 0; color: var(--fg, #e7f7ff); line-height: 1.05; }
      .pc-queen__subtitle { font-size: 10px; color: var(--fg-mute, #7f9bb4); line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pc-queen__hive {
        font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4);
        padding: 2px 6px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: var(--bg-2, rgba(255, 255, 255, 0.04)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 94px;
      }
      .pc-queen__spacer { flex: 1; }
      .pc-queen__reset {
        display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0;
        padding: 4px 7px; border-radius: 6px; cursor: pointer; color: var(--fg-dim, #b9d4e8);
        background: var(--bg-2, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
      }
      .pc-queen__reset:hover:not(:disabled) { color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--queen-accent), transparent 52%); }
      .pc-queen__reset:disabled { opacity: 0.5; cursor: default; }
      .pc-queen__reset:focus-visible,
      .pc-queen__btn:focus-visible,
      .pc-queen__chip:focus-visible,
      .pc-queen__check:focus-visible {
        outline: 1px solid var(--queen-accent); outline-offset: 1px;
      }

      .pc-queen__summary {
        display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px;
      }
      .pc-queen__summary-item {
        min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 6px 7px; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-queen__summary-item--good {
        border-color: color-mix(in srgb, var(--good, #34d399), transparent 62%);
        background: color-mix(in srgb, var(--good, #34d399), transparent 91%);
      }
      .pc-queen__summary-item--warn {
        border-color: color-mix(in srgb, var(--queen-accent), transparent 58%);
        background: color-mix(in srgb, var(--queen-accent), transparent 90%);
      }
      .pc-queen__summary-label {
        font-size: 9.5px; font-weight: 720; letter-spacing: 0; color: var(--fg-mute, #7f9bb4);
      }
      .pc-queen__summary-value {
        min-width: 0; font-size: 11px; font-weight: 680; color: var(--fg, #e7f7ff);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      .pc-queen__err {
        display: flex; align-items: center; gap: 6px; font-size: 11px; color: #fca5a5;
        padding: 6px 9px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--bad, #f43f5e), transparent 58%);
        background: color-mix(in srgb, var(--bad, #f43f5e), transparent 90%);
      }

      .pc-queen__section {
        display: flex; flex-direction: column; gap: 7px; padding: 8px 9px; border-radius: 8px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); border-left-color: color-mix(in srgb, var(--queen-accent), transparent 48%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.04)), transparent 18%);
      }
      .pc-queen__section--pause { border-color: color-mix(in srgb, var(--queen-accent), transparent 68%); border-left-color: var(--queen-accent); }
      .pc-queen__section-head { display: flex; align-items: center; gap: 6px; }
      .pc-queen__section-head svg { color: var(--fg-mute, #7f9bb4); }
      .pc-queen__section-title { font-size: 11px; font-weight: 760; letter-spacing: 0; color: var(--fg, #e7f7ff); }
      .pc-queen__count { margin-left: auto; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); text-align: right; }

      .pc-queen__btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 11.5px; font-weight: 720;
        padding: 7px 10px; border-radius: 7px; cursor: pointer; border: 1px solid transparent;
      }
      .pc-queen__btn--block { width: 100%; }
      .pc-queen__btn:disabled { opacity: 0.55; cursor: default; }
      .pc-queen__btn--go {
        background: color-mix(in srgb, var(--queen-accent), transparent 86%);
        color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--queen-accent), transparent 54%);
      }
      .pc-queen__btn--stop {
        background: color-mix(in srgb, var(--good, #34d399), transparent 86%);
        color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--good, #34d399), transparent 58%);
      }
      .pc-queen__btn--save {
        background: color-mix(in srgb, var(--accent), transparent 86%);
        color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--accent), transparent 58%);
      }
      .pc-queen__btn:hover:not(:disabled),
      .pc-queen__chip:hover:not(:disabled) {
        color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--queen-accent), transparent 48%);
        background: color-mix(in srgb, var(--queen-accent), transparent 88%);
      }
      .pc-queen__chip {
        font-size: 10px; font-weight: 700; padding: 4px 8px; border-radius: 6px; cursor: pointer; color: var(--fg-dim, #b9d4e8);
        background: var(--bg-3, rgba(255, 255, 255, 0.05)); border: 1px solid var(--border, rgba(125, 211, 252, 0.22));
      }
      .pc-queen__chip:disabled { opacity: 0.5; cursor: default; }

      .pc-queen__pausebadge {
        margin-left: auto; font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px;
        color: var(--fg, #e7f7ff); border: 1px solid color-mix(in srgb, var(--good, #34d399), transparent 58%);
        background: color-mix(in srgb, var(--good, #34d399), transparent 90%);
      }
      .pc-queen__pausebadge--on {
        border-color: color-mix(in srgb, var(--queen-accent), transparent 50%);
        background: color-mix(in srgb, var(--queen-accent), transparent 88%);
      }
      .pc-queen__pausefor { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .pc-queen__duration {
        display: inline-flex; align-items: center; gap: 5px; min-height: 27px; padding: 2px 6px; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-queen__presetlabel { font-size: 10px; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
      .pc-queen__mins {
        width: 48px; font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 5px; color: var(--fg, #e7f7ff);
        background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3));
      }
      .pc-queen__mins:focus { outline: none; border-color: color-mix(in srgb, var(--queen-accent), transparent 35%); }
      .pc-queen__hint { font-size: 10px; line-height: 1.3; color: var(--fg-mute, #7f9bb4); }

      .pc-queen__scope {
        font-size: 10.5px; line-height: 1.35; color: var(--fg-dim, #b9d4e8); padding: 6px 8px; border-radius: 7px;
        background: color-mix(in srgb, var(--accent), transparent 94%); border: 1px solid color-mix(in srgb, var(--accent), transparent 82%);
      }
      .pc-queen__scope--restricted {
        color: var(--fg, #e7f7ff); background: color-mix(in srgb, var(--queen-accent), transparent 91%);
        border-color: color-mix(in srgb, var(--queen-accent), transparent 68%);
      }

      .pc-queen__plans { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 260px; overflow-y: auto; }
      .pc-queen__plan {
        display: flex; align-items: center; gap: 7px; padding: 5px 7px; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12)); background: rgba(255, 255, 255, 0.02);
      }
      .pc-queen__plan--on {
        border-color: color-mix(in srgb, var(--queen-accent), transparent 58%);
        background: color-mix(in srgb, var(--queen-accent), transparent 93%);
      }
      .pc-queen__planlabel { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
      .pc-queen__check {
        width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer;
        color: var(--accent-ink, #051827); background: var(--bg-2, rgba(255, 255, 255, 0.04));
        border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3)); border-radius: 4px; flex-shrink: 0;
      }
      .pc-queen__check[data-state='checked'],
      .pc-queen__check[data-state='indeterminate'] {
        background: var(--queen-accent); border-color: var(--queen-accent);
      }
      .pc-queen__check:disabled { cursor: default; opacity: 0.5; }
      .pc-queen__check svg { width: 10px; height: 10px; }
      .pc-queen__planslug { font-size: 11.5px; color: var(--fg, #e7f7ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pc-queen__planstatus {
        flex-shrink: 0; font-size: 8.5px; font-weight: 700; letter-spacing: 0;
        padding: 1px 6px; border-radius: 999px; color: var(--fg-mute, #7f9bb4); border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
      }
      .pc-queen__planstatus[data-status='started'] { color: #86efac; border-color: color-mix(in srgb, var(--good, #34d399), transparent 56%); }
      .pc-queen__planstatus[data-status='active'] { color: var(--accent-soft); border-color: color-mix(in srgb, var(--accent), transparent 60%); }
      .pc-queen__planstatus[data-status='stale'] { color: #fca5a5; border-color: color-mix(in srgb, var(--bad, #f43f5e), transparent 56%); }

      .pc-queen__directive {
        width: 100%; box-sizing: border-box; resize: vertical; font: inherit; font-size: 11.5px; line-height: 1.4;
        min-height: 74px; padding: 7px 9px; border-radius: 7px; color: var(--fg, #e7f7ff);
        background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3));
      }
      .pc-queen__directive::placeholder { color: var(--fg-mute, #7f9bb4); }
      .pc-queen__directive:focus { outline: none; border-color: color-mix(in srgb, var(--accent), transparent 42%); }
      .pc-queen__directive-actions { display: flex; align-items: center; gap: 7px; }
    `}</style>
  );
}
