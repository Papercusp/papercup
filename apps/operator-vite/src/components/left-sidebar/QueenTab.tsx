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
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useNavigate } from '@tanstack/react-router';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, CalendarClock, Crown, ListChecks, Network, Pause, Play, RotateCcw } from 'lucide-react';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import type { ModelTier } from '@papercusp/operator-core/lib/agent-config-constants';
import { usePlanList, type PlanListRow } from '@/app/admin/plans/plans-api';
import { Checkbox } from '@/app/harness/Checkbox';
import { Tooltip } from '@/app/harness/Tooltip';
import { buildHarnessSelectOptions } from '../adv/AdvShell';
import { ALL_HARNESSES_OPTION } from '../adv/adv-harness-selection';
import ScheduledRoutinesPane from '../adv/ScheduledRoutinesPane';
import QueenHeartbeat from './QueenHeartbeat';
import ModelTiersOverride from './ModelTiersOverride';
import ThrottleSection, { type IdleKind, type IdleToggles, type ThrottleDefaults } from './ThrottleSection';
import AutonomySurfacing, { type DecompMode } from './AutonomySurfacing';
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
  /** Session per-role tier ceilings (D-006); null ⇒ no override. The throttle
   *  "Cap bees at tier" control manages the `bee` key here. */
  tierCeilings?: Record<string, string> | null;
  /** Throttle knobs (P-006 backend / P-007 UI). null ⇒ use the system default. */
  cadenceFloorSec?: number | null;
  maxBees?: number | null;
  idleActivities?: IdleToggles | null;
  autoScaleOut?: boolean | null;
  /** Decomposition aggressiveness (P-009, advisory); null ⇒ default. */
  decomposition?: DecompMode | null;
  /** Read-only system defaults the resolver supplies for the throttle badges (P-006). */
  throttleDefaults?: ThrottleDefaults | null;
}

const DEFAULT_STEERING: Omit<HiveSteeringRow, 'slug'> = {
  directive: null,
  eligiblePlans: [],
  eligibleHives: [],
  pauseNewWork: false,
  pausedUntil: null,
  modelTiers: null,
  tierCeilings: null,
  cadenceFloorSec: null,
  maxBees: null,
  idleActivities: null,
  autoScaleOut: null,
  decomposition: null,
  throttleDefaults: null,
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
  const projectsQ = useSyncQuery<LiteProject>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
    staleTime: 60_000,
    enabled: active,
  });
  const plansQ = usePlanList({ includeArchived: false, includeLegacy: false });
  const navigate = useNavigate();

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
  const steerableHiveOptions = useMemo(
    () => hiveOptions.filter((h) => (planIndex.hivePlans.get(h.value)?.length ?? 0) > 0),
    [hiveOptions, planIndex],
  );
  const steeringSelection: SteeringSelection = { eligibleHives: view.eligibleHives, eligiblePlans: view.eligiblePlans };
  const steeringTree = useMemo(
    () => buildSteeringTree(steerableHiveOptions, treePlans, { eligibleHives: view.eligibleHives, eligiblePlans: view.eligiblePlans }),
    [steerableHiveOptions, treePlans, view.eligibleHives, view.eligiblePlans],
  );
  const illegalCount = detectIllegalEligiblePlans(steeringSelection, planIndex.planToHive).length;

  /** Serialized, fail-soft write (the optimistic fields are already in `view`). */
  const enqueue = (patch: Record<string, unknown>) => {
    if (!home) {
      setErr('No home hive found — start a hive first.');
      return;
    }
    inflightRef.current += 1;
    setErr(null);
    chainRef.current = chainRef.current
      .then(() => runSetSteering({ hive: home, ...patch }))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        inflightRef.current -= 1;
        if (inflightRef.current === 0) {
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
  // ── Throttle knobs (P-007) — each writes through hive:set-steering like the
  // other steering fields; reads from the LIVE selection so back-to-back edits
  // accumulate (the overlay-ref pattern). ──
  const setCadenceFloor = (sec: number | null) => {
    overlay({ cadenceFloorSec: sec });
    enqueue({ cadenceFloorSec: sec });
  };
  const setMaxBees = (n: number | null) => {
    overlay({ maxBees: n });
    enqueue({ maxBees: n });
  };
  /** Cap the `bee` role's tier ceiling (tierCeilings.bee), preserving other roles. */
  const setBeeTierCap = (tierName: string | null) => {
    const next = { ...(live().tierCeilings ?? {}) };
    if (tierName) next.bee = tierName;
    else delete next.bee;
    const value = Object.keys(next).length > 0 ? next : null;
    overlay({ tierCeilings: value });
    enqueue({ tierCeilings: value });
  };
  const toggleIdle = (kind: IdleKind, enabled: boolean) => {
    const next: IdleToggles = { ...(live().idleActivities ?? {}), [kind]: enabled };
    overlay({ idleActivities: next });
    enqueue({ idleActivities: next });
  };
  /** Default ON; enabling clears the override (null), disabling stores `false`. */
  const setAutoScaleOut = (enabled: boolean) => {
    const value = enabled ? null : false;
    overlay({ autoScaleOut: value });
    enqueue({ autoScaleOut: value });
  };
  const setDecomposition = (mode: DecompMode | null) => {
    overlay({ decomposition: mode });
    enqueue({ decomposition: mode });
  };
  const onManageAutonomy = () => void navigate({ to: '/settings/autonomy' });
  const onSaveDirective = (text: string) => {
    const directive = text.trim() ? text : null;
    overlay({ directive });
    enqueue({ directive });
  };
  const clearAll = () => {
    overlay({
      directive: null,
      eligiblePlans: [],
      eligibleHives: [],
      pauseNewWork: false,
      pausedUntil: null,
      modelTiers: null,
      tierCeilings: null,
      cadenceFloorSec: null,
      maxBees: null,
      idleActivities: null,
      autoScaleOut: null,
      decomposition: null,
    });
    enqueue({ clear: true });
  };
  // Steering writes are optimistic and serialized through enqueue(); keeping the
  // controls enabled lets the owner continue tuning the Queen immediately while
  // the network write drains in the background.
  const controlsBusy = false;

  // Nested-picker handlers (P-002): compute the next (eligibleHives, eligiblePlans)
  // via the pure toggles from the LIVE selection (the overlay ref, so back-to-back
  // clicks accumulate), then optimistic-write BOTH lists in click order.
  const liveSelection = (): SteeringSelection => {
    const l = live();
    const visibleHives = new Set(steerableHiveOptions.map((h) => h.value));
    return {
      eligibleHives: l.eligibleHives.filter((h) => visibleHives.has(h)),
      eligiblePlans: l.eligiblePlans,
    };
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
    applySteering(treeSetAllHivesFn(liveSelection(), on, steerableHiveOptions, planIndex.planToHive));

  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <div className="pc-queen">
      <header className="pc-queen__bar">
        <Crown size={14} aria-hidden />
        <span className="pc-queen__identity">
          <span className="pc-queen__title">Queen</span>
          <span className="pc-queen__subtitle">Steering controls</span>
        </span>
        {home && (
          <Tooltip label="The home Queen this steers">
            <span className="pc-queen__hive">{home}</span>
          </Tooltip>
        )}
        <span className="pc-queen__spacer" />
        <button type="button" className="pc-queen__reset" onClick={clearAll} disabled={controlsBusy} aria-label="Clear all steering back to default">
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
          disabled={controlsBusy}
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
          <button type="button" className="pc-queen__chip" onClick={pauseForMinutes} disabled={controlsBusy}>apply</button>
          {view.pausedUntil != null && (
            <button type="button" className="pc-queen__chip" onClick={clearPause} disabled={controlsBusy}>clear</button>
          )}
        </div>
        <span className="pc-queen__hint">drives existing placements to terminal, starts nothing new</span>
      </section>

      {/* 2 — Focus directive */}
      <DirectiveEditor
        key={home}
        initial={view.directive ?? ''}
        busy={controlsBusy}
        onSave={onSaveDirective}
      />

      {/* 3 — Model tiers (session override, D-006 / #4) */}
      <ModelTiersOverride override={view.modelTiers ?? null} onWrite={setModelTiers} busy={controlsBusy} />

      {/* 4+5 — Steering scope. The nested hive→plan picker (P-002) makes the
          illegal "eligible plan under an excluded hive" state unrepresentable;
          the flag-OFF fallback is the legacy two flat lists. */}
      {steeringTreeOn ? (
        <HiveSteeringTree
          tree={steeringTree}
          illegalCount={illegalCount}
          busy={controlsBusy}
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
              <button type="button" className="pc-queen__chip" onClick={() => setAllHives(true)} disabled={controlsBusy || hiveOptions.length === 0} aria-label="Select every hive">all</button>
              <button type="button" className="pc-queen__chip" onClick={() => setAllHives(false)} disabled={controlsBusy || !hiveRestricted} aria-label="Clear the hive scope">none</button>
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
              <button type="button" className="pc-queen__chip" onClick={() => setAllPlans(true)} disabled={controlsBusy || planRows.length === 0} aria-label="Select every plan shown">all</button>
              <button type="button" className="pc-queen__chip" onClick={() => setAllPlans(false)} disabled={controlsBusy || !planRestricted} aria-label="Clear the plan restriction">none</button>
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

      {/* 6 — Throttle knobs (P-007): cadence floor, max bees, model-tier pin (the
          bee role's tier ceiling), idle-activity gates, auto-scale-out. The live
          seams + the system throttleDefaults come from P-006 (su-41a5e). */}
      <ThrottleSection
        cadenceFloorSec={view.cadenceFloorSec ?? null}
        maxBees={view.maxBees ?? null}
        tierCeilings={view.tierCeilings ?? null}
        idleActivities={view.idleActivities ?? null}
        autoScaleOut={view.autoScaleOut ?? null}
        defaults={view.throttleDefaults ?? null}
        busy={controlsBusy}
        onSetCadenceFloor={setCadenceFloor}
        onSetMaxBees={setMaxBees}
        onSetBeeTierCap={setBeeTierCap}
        onToggleIdle={toggleIdle}
        onSetAutoScaleOut={setAutoScaleOut}
      />

      {/* 7 — Autonomy + decomposition surfacing (P-009): a read-through to the
          autonomy:policy ceilings (+ deep link), the cursed-item breaker threshold
          (read-only), and the advisory decomposition-aggressiveness knob. */}
      <AutonomySurfacing
        decomposition={view.decomposition ?? null}
        breakerThreshold={view.throttleDefaults?.breakerThreshold ?? null}
        busy={controlsBusy}
        onSetDecomposition={setDecomposition}
        onManageAutonomy={onManageAutonomy}
      />

      {/* 8 — Scheduled routines (the ops glance, scheduled-recurring-plans P-026).
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
      </div>
    </TooltipPrimitive.Provider>
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
