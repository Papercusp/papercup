/**
 * The Learning tab's pot-chip rail model (plan learning-pot-scope-gate-2026-08-30, P-006).
 *
 * Pure and React-free so the rules below are testable without rendering: every
 * one of them is a rule this codebase has already been burned by getting
 * backwards somewhere, so each is asserted directly in learning-pot-rail.test.ts.
 *
 * THE THREE RULES THAT ARE EASY TO INVERT
 *
 * 1. FAIL-OPEN (R-5). `learning_pot_scope` ships EMPTY and an ABSENT row means
 *    ENABLED. A surface that re-derives this and gets it backwards renders every
 *    pot as switched off — which is why the catalog serves `disabledPots`
 *    explicitly rather than an enabled list, and why this module only ever asks
 *    "is it in disabledPots?".
 *
 * 2. `potScope: null` IS NOT AN EMPTY SCOPE. Null means the read FAILED. An
 *    empty scope means "every pot is learning" — a claim this rail must not make
 *    when it never read the table. Null therefore maps to 'unknown', never 'on'.
 *    (Same posture the resolver takes at catalog.ts's degrade path.)
 *
 * 3. A SEGMENT'S STATE IS ITS OWN ARMING, NOT THE EFFECTIVE OUTCOME. Switching a
 *    pot off deliberately leaves each lane's arming untouched so switching it
 *    back on restores exactly what was armed. So `gym`/`lanes` here report what
 *    the lane itself has armed; the master switch is reported separately as
 *    `learning`, and the effective answer is the AND of the two. Collapsing them
 *    would destroy the "restores what was armed" property the store relies on.
 *
 * WHY SCOUT HAS NO SPEND. Scout is gated per-pot (scoutPotGate resolves the
 * install's pot via resolveLearningPotSlug and asks the same switch), but it is
 * ARMED workspace-wide by the scout ceiling, and no per-pot scout spend exists
 * in this read model. Its segment therefore mirrors the master switch and
 * reports `spentUsd: null` — unknown — rather than a fabricated 0. A 0 here
 * would read as "this pot's scout has spent nothing", which we cannot know.
 */
import type {
  AutomationArming,
  AutomationGymArm,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';

/**
 * 'absent' is deliberately distinct from 'off': a pot with no gym row has not
 * been switched off, it has never been configured. Collapsing the two would
 * report "gym off" for a pot whose gym was never set up, which invites someone
 * to go looking for a switch that does not exist.
 */
export type PotSegmentState = 'on' | 'off' | 'absent' | 'unknown';

export interface PotRailSegment {
  state: PotSegmentState;
  /** null = NOT MEASURABLE from this read. Never coerced to 0 — see module header. */
  spentUsd: number | null;
  /** Short human reason, safe to use as a title/tooltip. */
  detail: string;
}

export interface PotRailLaneSegment extends PotRailSegment {
  armed: number;
  total: number;
}

export interface LearningPotChip {
  potSlug: string;
  /** The per-pot master switch. 'unknown' when the scope read failed. */
  learning: PotSegmentState;
  scout: PotRailSegment;
  gym: PotRailSegment;
  lanes: PotRailLaneSegment;
  /**
   * Total of the spend we can actually attribute to this pot (gym + lanes).
   * Scout is excluded because it is not per-pot measurable, so this is a floor,
   * not a complete cost — `spendComplete` says so rather than leaving a caller
   * to assume the number is whole.
   */
  spentUsd: number;
  spendComplete: false;
}

function laneBelongsToPot(lane: AutomationLaneArm, potSlug: string): boolean {
  return lane.potSlug === potSlug;
}

/**
 * The pots the rail shows: those with a learning PRESENCE — a gym autoloop row
 * or at least one governor lane.
 *
 * NOTE ON "only pots that are learning" (P-006): this is read as presence, not
 * as master-switch-on. A pot that has been switched OFF still appears, dimmed,
 * because the rail chip is what opens the per-pot popover that can switch it
 * back on; dropping it from the rail the moment it is disabled would strand it
 * behind the separate every-pot picker. The picker is the "every pot in the
 * workspace" surface by its own definition; this rail is the "pots that do
 * learning" surface.
 */
export function learningPotSlugs(arming: AutomationArming): string[] {
  const slugs = new Set<string>();
  for (const g of arming.gymPots) if (g.harnessSlug) slugs.add(g.harnessSlug);
  for (const l of arming.lanes) if (l.potSlug) slugs.add(l.potSlug);
  return [...slugs];
}

function masterSwitch(arming: AutomationArming, potSlug: string): PotSegmentState {
  // Rule 2: a failed read is 'unknown', never 'on'.
  if (arming.potScope === null) return 'unknown';
  // Rule 1: ask only about ABSENCE from disabledPots.
  return arming.potScope.disabledPots.includes(potSlug) ? 'off' : 'on';
}

function gymSegment(row: AutomationGymArm | undefined): PotRailSegment {
  if (!row) {
    return { state: 'absent', spentUsd: null, detail: 'No gym autoloop configured for this pot' };
  }
  return {
    state: row.enabled ? 'on' : 'off',
    spentUsd: row.spentUsd,
    detail: row.enabled
      ? `Gym armed — status ${row.status}`
      : `Gym disarmed — status ${row.status}`,
  };
}

function laneSegment(lanes: AutomationLaneArm[]): PotRailLaneSegment {
  if (lanes.length === 0) {
    return { state: 'absent', spentUsd: null, detail: 'No governor lanes for this pot', armed: 0, total: 0 };
  }
  const armed = lanes.filter((l) => l.enabled).length;
  const spentUsd = lanes.reduce((sum, l) => sum + (Number.isFinite(l.spentUsd) ? l.spentUsd : 0), 0);
  return {
    state: armed > 0 ? 'on' : 'off',
    spentUsd,
    detail: `${armed} of ${lanes.length} governor ${lanes.length === 1 ? 'lane' : 'lanes'} armed`,
    armed,
    total: lanes.length,
  };
}

function scoutSegment(master: PotSegmentState): PotRailSegment {
  if (master === 'unknown') {
    return { state: 'unknown', spentUsd: null, detail: 'Pot switch unreadable — scout state unknown' };
  }
  return {
    state: master,
    spentUsd: null,
    detail:
      master === 'on'
        ? 'Scout runs for this pot; it is armed workspace-wide by the scout ceiling, so no per-pot scout spend is attributable here'
        : 'Scout is gated off for this pot by the pot switch',
  };
}

/**
 * Build the rail. Ordering is deterministic — enabled first, then heaviest
 * spend, then slug — mirroring the `enabled DESC, slug ASC` the arming reads
 * already use, so the rail does not reshuffle between polls.
 */
export function buildLearningPotRail(arming: AutomationArming | null | undefined): LearningPotChip[] {
  if (!arming) return [];
  const gymBySlug = new Map(arming.gymPots.map((g) => [g.harnessSlug, g] as const));
  const chips = learningPotSlugs(arming).map<LearningPotChip>((potSlug) => {
    const learning = masterSwitch(arming, potSlug);
    const gym = gymSegment(gymBySlug.get(potSlug));
    const lanes = laneSegment(arming.lanes.filter((l) => laneBelongsToPot(l, potSlug)));
    return {
      potSlug,
      learning,
      scout: scoutSegment(learning),
      gym,
      lanes,
      spentUsd: (gym.spentUsd ?? 0) + (lanes.spentUsd ?? 0),
      spendComplete: false,
    };
  });
  return chips.sort((a, b) => {
    const rank = (c: LearningPotChip) => (c.learning === 'off' ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (b.spentUsd !== a.spentUsd) return b.spentUsd - a.spentUsd;
    return a.potSlug.localeCompare(b.potSlug);
  });
}
