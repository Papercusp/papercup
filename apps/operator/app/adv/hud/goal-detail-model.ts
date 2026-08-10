/**
 * The goal DETAIL view's pure model (goal-mode-2026-08-07 P-021).
 *
 * The rail tab is the GLANCE ("is anything on fire"); this is the CATCH-UP view
 * ("I have not looked in three days"). The two answer different questions, so
 * they get different shapes — this one is ordered by the question each section
 * answers, not by how the resolver happened to return them:
 *
 *   1. THIS GOAL ENDS WHEN — the kill criterion verbatim, plus live tripwire
 *      BARS. This is the headline idea of the whole surface: a criterion
 *      written as prose is a promise nobody re-checks; the same criterion as a
 *      readout is something you can act on.
 *   2. PROJECTS — each with ITS OWN kill criterion (contract clause 4) and a
 *      shared-with badge, killed ones kept visible.
 *   3. WAITING ON YOU — the only section the owner can ACT on, so it sits above
 *      the two informational ones.
 *   4. ACTIVITY.
 *   5. SPEND BY DAY, stacked by project.
 *
 * Split out of the component for the reason `hud-entity-board.ts` gives for its
 * own split: the interesting logic here (bar arithmetic, the stacked-spend
 * transform, the killed/active partition) is worth testing without a DOM and
 * without pulling a server module — and therefore `postgres` — into the test.
 *
 * ── The one convention this file imposes on tripwire AUTHORS ────────────────
 * A bar measures CONSUMPTION TOWARD A CEILING: `current` climbs, `threshold` is
 * where the goal should stop. An "at least" metric ("no shipped build yet")
 * must be authored as its complement ("days without a shipped build: 12 of 14")
 * or it renders backwards — 0/1 would fill 0% and read as healthy at exactly
 * the moment it is the thing you needed to see. Deliberately NOT solved with a
 * `direction` field: a second direction doubles the readings of every bar on
 * screen ("is a full bar good here?") to buy an expressiveness the complement
 * form already has. Recorded as goal-mode-2026-08-07#D-022.
 */
import { formatAge } from './hud-board-model';

/* ── The `goals.detail` wire shape, narrowed ──────────────────────────────
   Declared here rather than imported from `sync-resolver/goals.ts` for the
   reason `hud-entity-board.ts` gives for HudGoalInput: this module's whole
   value is being testable without a server module in the import graph. */

export interface GoalDetailTripwire {
  metric: string;
  label: string;
  threshold: number;
  /** Absent until something measures it — renders as an unread bar, not a zero. */
  current?: number | null;
  /** `usd` and `days` get bespoke phrasing; anything else is suffixed as-is. */
  unit?: string | null;
}

export interface GoalDetailGoalInput {
  id: string;
  title: string;
  body?: string | null;
  status: string;
  killCriterion?: string | null;
  tripwires?: GoalDetailTripwire[] | null;
  budgetCents?: number | null;
  spendUsd?: number | null;
  openWorkItems?: number | null;
  needsHuman?: number | null;
  projectCount?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface GoalDetailProjectInput {
  harnessSlug: string;
  role: string;
  killCriterion?: string | null;
  note?: string | null;
  addedAt?: string | null;
  /** Non-null ⇒ detached/killed. The row STAYS on the page — see partitionProjects. */
  removedAt?: string | null;
  servesGoals?: number | null;
  spendUsd?: number | null;
  openWorkItems?: number | null;
}

export interface GoalDetailWaitingInput {
  id: string;
  title: string;
  harnessSlug?: string | null;
  updatedAt?: string | null;
}

export interface GoalDetailActivityInput {
  id: string;
  title: string;
  harnessSlug?: string | null;
  status?: string | null;
  closedAt?: string | null;
  updatedAt?: string | null;
}

export interface GoalDetailSpendDayInput {
  day: string;
  harnessSlug?: string | null;
  costUsd?: number | null;
}

/** One derived plan row for the work rail (P-019). Shape mirrors the resolver's
 *  `GoalPlanCard` — see D-010 for WHY a goal's plans are derived through its
 *  stamped work items rather than through its projects' harnesses. */
export interface GoalDetailPlanInput {
  planSlug: string;
  harnessSlug: string;
  title?: string | null;
  status?: string | null;
  archived?: boolean | null;
  items?: number | null;
  openItems?: number | null;
  updatedAt?: string | null;
}

/** An agent RUNNING this goal — `agent_modes.subject`, the marker D-007 found
 *  already existed. A list, not a scalar: D-006 makes one the normal case, but
 *  a goal carrying two stamps is a coordination fault worth seeing. */
export interface GoalDetailAgentInput {
  ownerId: string;
  setAt?: string | null;
  setBy?: string | null;
}

/**
 * A subdirective of the open goal (P-017 / D-006).
 *
 * id/title/status and nothing else. A child steers its parent's agent rather
 * than owning one, so there is no separable spend, ceiling or session to carry —
 * the absent fields are the decision, not an oversight.
 */
export interface GoalDetailSubGoalInput {
  id: string;
  title: string;
  status: string;
}

export interface GoalDetailInput {
  goal: GoalDetailGoalInput | null;
  /** Empty array = none; absent/null = a payload from before P-017. */
  subGoals?: GoalDetailSubGoalInput[] | null;
  /** Set only when the open goal is itself a subdirective. */
  parent?: { id: string; title: string } | null;
  projects?: GoalDetailProjectInput[] | null;
  plans?: GoalDetailPlanInput[] | null;
  agents?: GoalDetailAgentInput[] | null;
  waitingOnYou?: GoalDetailWaitingInput[] | null;
  activity?: GoalDetailActivityInput[] | null;
  spendByDay?: GoalDetailSpendDayInput[] | null;
  spendLabel?: string | null;
  spendNote?: string | null;
}

/* ── Tripwire bars ───────────────────────────────────────────────────────── */

export type TripwireTone = 'ok' | 'warn' | 'breached' | 'unread';

export interface TripwireBar {
  key: string;
  label: string;
  /** `$310 of $500`, `day 12 of 30`, `12 of 30 builds`. */
  valueText: string;
  /**
   * 0-100, clamped. Null when there is no bar to fill — which happens for TWO
   * different reasons: nothing has measured this yet, OR there is a reading but
   * no usable threshold to measure it against.
   *
   * So `pct == null` is NOT "unmeasured", and must never be used to answer that
   * question. Read `measured` instead.
   */
  pct: number | null;
  /**
   * Did anyone actually take a reading? This is the ONE field that separates
   * "unmeasured" from "measured at zero" — the distinction this whole surface
   * exists to preserve — and it is stated explicitly rather than left to be
   * re-derived from `pct` or `tone`, because both have other reasons to take
   * the value a caller would read as absent.
   */
  measured: boolean;
  tone: TripwireTone;
  /** Hover text spelling out what crossing this bar means. */
  title: string;
}

/** At and past the ceiling. Below it, the last fifth is the warning band —
 *  early enough to redirect the goal, late enough not to cry wolf all run. */
const WARN_AT_PCT = 80;

function moneyish(n: number): string {
  // Whole dollars: a goal ceiling is a four-figure decision, and cents on a
  // progress bar are noise that makes two bars harder to compare at a glance.
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function numberish(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * One tripwire → one bar. Pure.
 *
 * A tripwire with no `current` is NOT rendered as zero: zero is a reading, and
 * showing one where none was taken is the failure this whole surface exists to
 * prevent. It renders as an explicitly unread bar instead.
 */
export function tripwireBar(t: GoalDetailTripwire): TripwireBar {
  const unit = (t.unit ?? '').trim().toLowerCase();
  const label = t.label?.trim() || t.metric;
  const threshold = Number(t.threshold);
  const hasThreshold = Number.isFinite(threshold) && threshold > 0;
  const current = t.current == null ? null : Number(t.current);
  const hasCurrent = current != null && Number.isFinite(current);

  const fmt = (n: number): string => (unit === 'usd' ? moneyish(n) : numberish(n));

  let valueText: string;
  if (!hasCurrent) {
    valueText = hasThreshold ? `not measured yet — limit ${fmt(threshold)}` : 'not measured yet';
  } else if (unit === 'days') {
    valueText = hasThreshold ? `day ${fmt(current)} of ${fmt(threshold)}` : `day ${fmt(current)}`;
  } else {
    const suffix = unit && unit !== 'usd' ? ` ${t.unit?.trim()}` : '';
    valueText = hasThreshold
      ? `${fmt(current)} of ${fmt(threshold)}${suffix}`
      : `${fmt(current)}${suffix}`;
  }

  // A tripwire with no usable threshold has no bar to fill — it still shows its
  // reading, because the number is the point even when the limit is missing.
  const pct =
    hasCurrent && hasThreshold
      ? Math.max(0, Math.min(100, Math.round((current / threshold) * 100)))
      : null;

  let tone: TripwireTone;
  if (!hasCurrent) tone = 'unread';
  else if (pct == null) tone = 'ok';
  else if (pct >= 100) tone = 'breached';
  else if (pct >= WARN_AT_PCT) tone = 'warn';
  else tone = 'ok';

  const title =
    tone === 'breached'
      ? `${label}: past its limit — this is a reason to stop the goal`
      : tone === 'unread'
        ? `${label}: no reading has been taken yet`
        : `${label}: ${valueText}`;

  return { key: t.metric, label, valueText, pct, measured: hasCurrent, tone, title };
}

/** Every tripwire on the goal, in author order. Empty is the NORMAL case — a
 *  free-text kill criterion with no bars is fully supported, and renders as
 *  prose alone. */
export function tripwireBars(goal: GoalDetailGoalInput | null): TripwireBar[] {
  const raw = goal?.tripwires;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t) => t && typeof t.metric === 'string').map(tripwireBar);
}

/**
 * The one-line verdict above the bars.
 *
 * A goal with NO kill criterion is the case worth shouting about: nothing can
 * ever stop it, which is precisely the failure mode GOAL mode exists to bound.
 * It is stated outright rather than left as an empty section that reads as
 * merely uninformative.
 */
export function killCriterionLine(goal: GoalDetailGoalInput | null): {
  text: string;
  missing: boolean;
} {
  const text = goal?.killCriterion?.trim();
  if (text) return { text, missing: false };
  return {
    text: 'No kill criterion was set — nothing can stop this goal. Ask the agent to set one.',
    missing: true,
  };
}

/* ── Projects ────────────────────────────────────────────────────────────── */

export interface GoalDetailProject extends GoalDetailProjectInput {
  removed: boolean;
  /** `shared with 2 other goals`, or null when this goal is its only claimant. */
  sharedBadge: string | null;
  /** Clause 4 requires one per project; its absence is shown, not hidden. */
  killCriterionText: string;
  killCriterionMissing: boolean;
}

function decorate(p: GoalDetailProjectInput): GoalDetailProject {
  const removed = p.removedAt != null;
  const serves = p.servesGoals ?? 0;
  const crit = p.killCriterion?.trim();
  return {
    ...p,
    removed,
    // `servesGoals` counts THIS goal too, so the shared count is one less.
    sharedBadge: serves > 1 ? `shared with ${serves - 1} other goal${serves === 2 ? '' : 's'}` : null,
    killCriterionText: crit || 'No kill criterion for this project',
    killCriterionMissing: !crit,
  };
}

/**
 * Active and removed projects, both kept.
 *
 * Removed projects STAY on the page, greyed. If kills vanished, the page would
 * only ever show growth — and "the agent actually closes things" (clause 4: an
 * agent that only ever creates is a ratchet) would become invisible at exactly
 * the moment it is working. The resolver deliberately does not filter them
 * either; this is the same decision held on both sides of the wire.
 */
export function partitionProjects(projects: GoalDetailProjectInput[] | null | undefined): {
  active: GoalDetailProject[];
  removed: GoalDetailProject[];
} {
  const all = (projects ?? []).map(decorate);
  return {
    active: all.filter((p) => !p.removed),
    removed: all.filter((p) => p.removed),
  };
}

/* ── Spend by day, stacked by project ────────────────────────────────────── */

export interface SpendStackSlice {
  harnessSlug: string;
  costUsd: number;
  /** Share of THIS day's column, 0-100 — the slice's height within the stack. */
  pct: number;
}

export interface SpendStackDay {
  day: string;
  totalUsd: number;
  /** Share of the tallest day, 0-100 — the column's own height. */
  heightPct: number;
  slices: SpendStackSlice[];
}

export interface SpendStack {
  days: SpendStackDay[];
  /** Every project appearing anywhere in the window, for a stable legend/colour. */
  harnesses: string[];
  maxDayUsd: number;
  totalUsd: number;
}

/**
 * Bucket the flat (day, project, cost) rows into stacked columns. Pure.
 *
 * The resolver already grouped by day+project, so this is a reshape rather than
 * an aggregation — but it must still SUM on collision, because a caller that
 * passes ungrouped rows (a test, or a resolver that later stops grouping)
 * would otherwise silently keep only the last row of each pair.
 */
export function spendStack(rows: GoalDetailSpendDayInput[] | null | undefined): SpendStack {
  const byDay = new Map<string, Map<string, number>>();
  const harnesses: string[] = [];

  for (const r of rows ?? []) {
    const day = String(r.day ?? '').trim();
    if (!day) continue;
    const slug = (r.harnessSlug ?? '').trim() || 'unattributed';
    const cost = Number(r.costUsd ?? 0);
    if (!Number.isFinite(cost)) continue;
    if (!harnesses.includes(slug)) harnesses.push(slug);
    const bucket = byDay.get(day) ?? new Map<string, number>();
    bucket.set(slug, (bucket.get(slug) ?? 0) + cost);
    byDay.set(day, bucket);
  }

  const days = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, bucket]) => {
      const slices = [...bucket.entries()].map(([harnessSlug, costUsd]) => ({
        harnessSlug,
        costUsd,
        pct: 0,
      }));
      const totalUsd = slices.reduce((acc, s) => acc + s.costUsd, 0);
      for (const s of slices) s.pct = totalUsd > 0 ? (s.costUsd / totalUsd) * 100 : 0;
      slices.sort((a, b) => b.costUsd - a.costUsd || a.harnessSlug.localeCompare(b.harnessSlug));
      return { day, totalUsd, heightPct: 0, slices };
    });

  const maxDayUsd = days.reduce((m, d) => Math.max(m, d.totalUsd), 0);
  for (const d of days) d.heightPct = maxDayUsd > 0 ? (d.totalUsd / maxDayUsd) * 100 : 0;

  return {
    days,
    harnesses: [...harnesses].sort((a, b) => a.localeCompare(b)),
    maxDayUsd,
    totalUsd: days.reduce((acc, d) => acc + d.totalUsd, 0),
  };
}

/* ── Small shared formatting ─────────────────────────────────────────────── */

/** `4h ago` / `just now`, via the HUD's existing age formatter — deliberately
 *  not a fifth relative-time implementation in this app. */
export function agoText(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return `${formatAge(Math.max(0, Math.round((nowMs - t) / 1000)))} ago`;
}

/** The `$310 / $500` ceiling line for the header. Mirrors `goalSpendLabel` on
 *  the card so the detail view and the card it opened from cannot disagree. */
export function ceilingLine(goal: GoalDetailGoalInput | null): {
  text: string;
  pct: number | null;
  over: boolean;
} {
  const spend = goal?.spendUsd ?? 0;
  const ceiling = goal?.budgetCents == null ? null : goal.budgetCents / 100;
  if (ceiling == null || ceiling <= 0) {
    return { text: `${moneyish(spend)} — no ceiling set`, pct: null, over: false };
  }
  return {
    text: `${moneyish(spend)} of ${moneyish(ceiling)}`,
    pct: Math.max(0, Math.min(100, Math.round((spend / ceiling) * 100))),
    over: spend >= ceiling,
  };
}

/* ── The work rail (P-019) ─────────────────────────────────────────────────
   The goal popup's side panel: the goal's PLANS and its WORK ITEMS, mimicking
   the fleet-peers rail the owner pointed at ("the way we have the sidepanel for
   the fleet members, we can mimic that design").

   Derived here, not in the component, for the same reason `fleet-peers.ts` is a
   module beside `FleetPeersRail`: every rule about what appears and in what
   order is a decision worth pinning with a test, and a rail that computes its
   own grouping inline can only be checked by rendering it.

   ⚠ THE DEDUPE IS THE POINT, not a tidy-up. `waitingOnYou` and `activity` are
   two reads of the SAME work_items rows — the resolver filters the first to
   `needsHuman` and leaves the second unfiltered — so an item parked on the owner
   appears in BOTH. Rendering them as separate sections without subtracting
   would show that item twice, and a rail whose whole job is "what is under this
   goal" must not let the reader count one thing as two. */

export type GoalWorkTone = 'needs-you' | 'open' | 'closed';

export interface GoalWorkRailItem {
  id: string;
  title: string;
  harnessSlug: string | null;
  tone: GoalWorkTone;
  /** The row's meta line: state word + age. Composed here so the row component
   *  stays presentational. */
  metaText: string;
}

export interface GoalWorkRail {
  plans: GoalDetailPlanInput[];
  needsYou: GoalWorkRailItem[];
  open: GoalWorkRailItem[];
  closed: GoalWorkRailItem[];
  /** Nothing at all is under this goal — no plans, no items. The rail renders
   *  ONE sentence saying so instead of three empty headings, which read as a
   *  panel that failed to load rather than a goal nothing has touched yet.
   *  D-010: this is the LIVE state of every goal in this workspace today, so it
   *  is the state most likely to be seen — not an edge case. */
  empty: boolean;
}

function railMeta(state: string, iso: string | null | undefined, nowMs: number): string {
  const age = agoText(iso, nowMs);
  return age ? `${state} · ${age}` : state;
}

export function workRail(
  data: GoalDetailInput | null | undefined,
  nowMs: number,
): GoalWorkRail {
  const plans = (data?.plans ?? []).filter((p) => p != null && Boolean(p.planSlug));
  const waiting = data?.waitingOnYou ?? [];
  const activity = data?.activity ?? [];

  const needsYouIds = new Set(waiting.map((w) => w.id));
  const needsYou: GoalWorkRailItem[] = waiting.map((w) => ({
    id: w.id,
    title: w.title,
    harnessSlug: w.harnessSlug ?? null,
    tone: 'needs-you',
    metaText: railMeta('needs you', w.updatedAt, nowMs),
  }));

  const open: GoalWorkRailItem[] = [];
  const closed: GoalWorkRailItem[] = [];
  for (const a of activity) {
    // See the dedupe note above — never render a needs-you item a second time.
    if (needsYouIds.has(a.id)) continue;
    const isClosed = a.closedAt != null;
    (isClosed ? closed : open).push({
      id: a.id,
      title: a.title,
      harnessSlug: a.harnessSlug ?? null,
      tone: isClosed ? 'closed' : 'open',
      metaText: railMeta(
        isClosed ? 'closed' : (a.status ?? 'open'),
        isClosed ? a.closedAt : a.updatedAt,
        nowMs,
      ),
    });
  }

  return {
    plans,
    needsYou,
    open,
    closed,
    empty:
      plans.length === 0 && needsYou.length === 0 && open.length === 0 && closed.length === 0,
  };
}

/** What a plan row shows as its name. A plan whose row no longer resolves keeps
 *  its slug and is MARKED — see the resolver's `GoalPlanCard` docblock: live
 *  work items pointing at a deleted plan is a state worth seeing, not hiding. */
export function planLabel(plan: GoalDetailPlanInput): { text: string; missing: boolean } {
  const title = plan.title?.trim();
  if (title) return { text: title, missing: false };
  return { text: plan.planSlug, missing: true };
}
