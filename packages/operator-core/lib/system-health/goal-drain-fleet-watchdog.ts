/**
 * goal-drain-fleet-watchdog (EI-20581099901890760, half 2) — alarm on an ACTIVE,
 * live-held goal that lacks the standing drain fleet the GOAL contract requires.
 *
 * SIBLING of goal-liveness-watchdog, deliberately NOT folded into it (ruling by
 * its author, msg msvb6ydv-0000): that sweep asks "is ANYONE alive working this
 * goal?" and goes silent the moment a live holder exists. This one asks the
 * question that starts exactly there: "this goal IS held — is it held CORRECTLY?"
 * The GOAL contract (modes/registry.ts, mode 'goal') requires ONE STANDING DRAIN
 * FLEET PER GOAL, always maintained: the drain fleet is the cheap correct route
 * that makes never-implement livable (one work_items:create instead of
 * self-editing). In the measured run that motivated this pair (WI-39348,
 * su-b9e0ec11, 2026-08-16), the drain fleet was never established, and the only
 * editing window of the run was also its lowest-supervision window — the exact
 * failure the contract predicts. Prose didn't hold; this instrument replaces it.
 *
 * EXACTLY ONE CLASSIFIER SPEAKS PER GOAL. This one fires ONLY on a goal with a
 * POSITIVELY-alive holder (verdict present and alive). Unheld / abandoned /
 * unresolved-holder goals are the sibling's territory or are suppressed — never
 * double-alarmed from here.
 *
 * THE CONSERVATIVE RULE, inherited from the sibling because it is the trap in
 * this area: an entity the oracle returned NO verdict for is UNKNOWN, not dead.
 * `resolveSessionStates` omits an entry when its wakeability fetch degrades, so
 * reading omission as death would turn one transient DB hiccup into a false
 * alarm on every goal at once. Unknown suppresses — here that applies BOTH to
 * goal holders (no positive alive ⇒ silent) and to drain-fleet members (any
 * member unresolved ⇒ the fleet's liveness is unknown ⇒ silent).
 *
 * Design notes:
 *  - `managedSetInterval`, category 'watchdog' — visible in schedule:inventory.
 *  - Runtime gate: FLAGS.GOAL_DRAIN_FLEET_WATCHDOG (default ON; kill-switch at
 *    /admin/features) — independent of the sibling's flag so either sweep can be
 *    silenced without losing the other.
 *  - Declaration surface: `goals:update { drainFleet }` → goals.metadata.drainFleet
 *    (the fleet slug). Grace window after goal creation covers kickoff — the
 *    contract requires the fleet AT kickoff, not before it.
 *  - REPORTS + EMITS, never launches. The escalation carries the remedy; the
 *    `goal:drain-dead:<goalId>` event is what a goal agent parks on
 *    (events:await) so a dead drain fleet wakes it instead of waiting to be
 *    noticed. Auto-relaunching a fleet is an authority question this deliberately
 *    does not take (same scope choice as the sibling).
 *  - Dedup is delegated to openEscalation's (dedupKind, subjectSignature) PG
 *    dedup — cluster-safe, no new state surface.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
// P-001: holder rows, the alive predicate and the oracle fold all come from the
// ONE goal-holder module. This file used to import the predicate from its
// sibling watchdog, which is how the rule ended up owned by system-health and
// absent from every product surface.
import {
  holderCountsAsAlive,
  readGoalHolderRows,
  resolveHolderLiveness,
  type GoalHolderRow as GoalHolderLike,
} from '../goals/holder';
import { validateClaimSpec } from '../scheduler/claim-spec';

export const GOAL_DRAIN_FLEET_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * How long after goal creation a missing drainFleet declaration stays silent.
 *
 * The contract front-loads the drain fleet into kickoff, and the measured
 * exemplar run completed its whole kickoff gate (kill criterion, tripwires,
 * launchSettings) well inside an hour. One hour of grace covers a legitimate
 * kickoff without letting "I'll set it up later" quietly become never — the
 * failure mode this file exists to catch was a 162-minute run that never did.
 */
export const GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS = 60 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'goal-drain-fleet-watchdog',
  ownerLabel: 'system · goal drain fleet',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One `status='active'` goal, reduced to what THIS verdict needs. */
export interface GoalDrainRowLike {
  goalId: string;
  workspaceId: string;
  title: string;
  /** ms epoch of the goal row's creation — anchors the kickoff grace window. */
  createdAtMs: number;
  /** metadata->>'drainFleet': the declared standing drain fleet's slug, if any. */
  drainFleet: string | null;
}

/**
 * The drain-fleet leg's own liveness verdict, resolved per declared fleet.
 * `unknown` exists so a degraded read suppresses rather than false-alarms.
 */
export type DrainFleetLiveness = 'alive' | 'dead' | 'not-found' | 'unknown';

export type GoalDrainReason =
  | 'no-drain-fleet-declared'
  | 'drain-fleet-not-found'
  | 'drain-fleet-dead'
  | 'drain-fleet-not-goal-scoped';

/**
 * D-005 (goal-mode-design-intent-hardening-2026-08-16): the declared fleet's
 * claim-spec verdict. Before this leg landed, the watchdog verified only that
 * the declared fleet EXISTS and LIVES — a pot-wide fleet satisfied it, and a
 * pot-wide "drain lane" is exactly the shape the owner overruled: it drains
 * everything, so it guarantees nothing about THIS goal's filed work.
 * `unknown` exists for the same reason as everywhere else in this file: a
 * degraded spec read suppresses rather than false-alarms.
 */
export type DrainFleetSpecScope = 'goal-scoped' | 'not-goal-scoped' | 'unknown';

/**
 * PURE: does this filter node constrain EVERY admitted row to the goal?
 *
 * The positive `{field:'goal', op:'='|'in'}` leaf is the only thing that
 * counts, per the WI-37711 trap the claim-spec grammar documents: `goal` is a
 * NULLABLE column, so a `not`/`!=` leaf silently excludes every unstamped row
 * in the SQL compiler — a negated goal leaf is therefore NEVER goal-scoping.
 * Combinators: an `all` is scoped when ANY branch is (AND narrows); an `any`
 * only when EVERY branch is (OR widens past the goal otherwise).
 */
export function claimSpecFilterConstrainsGoal(filter: unknown, goalId: string): boolean {
  return claimSpecFilterConstrainsField(filter, 'goal', goalId);
}

/**
 * PURE: does every row admitted by this filter carry one positive field value?
 *
 * An `all` narrows when any branch pins the value; an `any` pins only when every
 * branch does. Negation never counts. This is the same nullable-field rule the
 * goal-scoped drain-fleet check already used, lifted so the plan-fleet leg does
 * not grow a subtly different parser.
 */
function claimSpecFilterConstrainsField(
  filter: unknown,
  field: 'goal' | 'plan',
  value: string,
): boolean {
  if (!filter || typeof filter !== 'object') return false;
  const node = filter as Record<string, unknown>;
  if (Array.isArray(node.all)) {
    return node.all.some((n) => claimSpecFilterConstrainsField(n, field, value));
  }
  if (Array.isArray(node.any)) {
    return node.any.length > 0 && node.any.every((n) => claimSpecFilterConstrainsField(n, field, value));
  }
  if ('not' in node) return false;
  if (node.field !== field) return false;
  if (node.op === '=') return node.value === value;
  if (node.op === 'in') return Array.isArray(node.value) && node.value.includes(value);
  return false;
}

/** PURE: `claimSpecFilterConstrainsGoal` lifted to a whole stored spec. */
export function claimSpecIsGoalScoped(spec: unknown, goalId: string): boolean {
  if (!spec || typeof spec !== 'object') return false;
  const view = (spec as { view?: { filter?: unknown } }).view;
  return claimSpecFilterConstrainsGoal(view?.filter, goalId);
}

/** PURE: the plan-fleet counterpart of `claimSpecIsGoalScoped`. */
export function claimSpecIsPlanScoped(spec: unknown, planSlug: string): boolean {
  if (!spec || typeof spec !== 'object') return false;
  const view = (spec as { view?: { filter?: unknown } }).view;
  return claimSpecFilterConstrainsField(view?.filter, 'plan', planSlug);
}

export interface GoalPlanFleetTargetLike {
  fleetSlug: string;
  liveness: DrainFleetLiveness;
  /** Live (unexpired) plan-item claims held by members of this fleet. */
  liveClaimItemIds: string[];
}

export interface GoalPlanFleetCoverageLike {
  goalId: string;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** Non-terminal (`done`/`dropped` excluded) normalized plan items. */
  itemIds: string[];
  targetingFleets: GoalPlanFleetTargetLike[];
}

/** A failed canonical read is UNKNOWN, never an empty cohort. */
export type GoalPlanFleetCohort =
  | { status: 'known'; plans: GoalPlanFleetCoverageLike[] }
  | { status: 'unknown'; plans: [] };

export type GoalPlanFleetReason =
  | 'started-plan-no-live-targeting-fleet'
  | 'started-plan-targeting-fleet-zero-live-claims';

export interface GoalPlanFleetAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  reason: GoalPlanFleetReason;
  planSlug: string;
  harnessSlug: string;
  itemIds: string[];
  targetingFleets: GoalPlanFleetTargetLike[];
  liveHolders: string[];
}

/**
 * PURE: classify GOAL obligation #1 from the canonical joined cohort.
 *
 * Exactly one verdict may speak for a goal. Leg A wins deterministically over
 * Leg B when separate plans exhibit both failures. Any unresolved fleet on a
 * non-empty started plan suppresses the whole goal: that fleet may be the live
 * coverage we failed to observe, so treating UNKNOWN as absent would false-alarm.
 */
export function classifyGoalPlanFleetCoverage(
  goal: GoalDrainRowLike,
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  cohort: GoalPlanFleetCohort,
): GoalPlanFleetAlert | null {
  if (cohort.status === 'unknown') return null;

  const liveHolders = holders
    .filter((h) => h.goalId === goal.goalId && h.workspaceId === goal.workspaceId)
    .filter((h) => {
      const verdict = verdicts.get(h.ownerId);
      return verdict ? holderCountsAsAlive(verdict) : false;
    })
    .map((h) => h.ownerId);
  if (liveHolders.length === 0) return null;

  const plans = cohort.plans
    .filter((p) => p.goalId === goal.goalId && p.workspaceId === goal.workspaceId)
    .filter((p) => p.itemIds.length > 0)
    .sort((a, b) => a.planSlug.localeCompare(b.planSlug));
  if (plans.some((p) => p.targetingFleets.some((f) => f.liveness === 'unknown'))) return null;

  const legA = plans.find((p) => !p.targetingFleets.some((f) => f.liveness === 'alive'));
  const legB = plans.find((p) => {
    const alive = p.targetingFleets.filter((f) => f.liveness === 'alive');
    return alive.length > 0 && !alive.some((f) => f.liveClaimItemIds.some((id) => p.itemIds.includes(id)));
  });
  const selected = legA ?? legB;
  if (!selected) return null;

  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    title: goal.title,
    reason: selected === legA
      ? 'started-plan-no-live-targeting-fleet'
      : 'started-plan-targeting-fleet-zero-live-claims',
    planSlug: selected.planSlug,
    harnessSlug: selected.harnessSlug,
    itemIds: selected.itemIds,
    targetingFleets: selected.targetingFleets,
    liveHolders,
  };
}

/**
 * Read the canonical plan-fleet obligation cohort in one fail-closed unit.
 *
 * The join deliberately uses normalized plan items and their TTL-backed claims,
 * plus current fleet membership for claim attribution. A read/validation/oracle
 * failure returns UNKNOWN for the entire leg; it never degrades to "no fleet" or
 * "zero claims". P-002 wires this classifier into escalation/event delivery.
 */
export async function readGoalPlanFleetCohort(
  sql: Sql,
  goals: readonly GoalDrainRowLike[],
  resolveFleetLiveness: GoalDrainFleetSweepDeps['resolveFleetLiveness'],
): Promise<GoalPlanFleetCohort> {
  if (goals.length === 0) return { status: 'known', plans: [] };
  try {
    const goalIds = [...new Set(goals.map((g) => g.goalId))];
    const workspaceIds = [...new Set(goals.map((g) => g.workspaceId))];
    const planRows = await sql<{
      workspace_id: string;
      harness_slug: string;
      plan_slug: string;
      goal_id: string;
    }[]>`
      SELECT workspace_id, harness_slug, plan_slug, goal_id
        FROM harness_shared.harness_plans
       WHERE workspace_id = ANY(${workspaceIds}::text[])
         AND goal_id = ANY(${goalIds}::text[])
         AND op_status = 'started'
         AND archived = false`;
    const activeGoalKeys = new Set(goals.map((g) => fleetKey(g.workspaceId, g.goalId)));
    const relevantPlans = planRows.filter((p) => activeGoalKeys.has(fleetKey(p.workspace_id, p.goal_id)));
    if (relevantPlans.length === 0) return { status: 'known', plans: [] };

    const planSlugs = [...new Set(relevantPlans.map((p) => p.plan_slug))];
    const [itemRows, claimRows, specRows] = await Promise.all([
      sql<{ workspace_id: string; harness_slug: string; plan_slug: string; item_id: string }[]>`
        SELECT workspace_id, harness_slug, plan_slug, item_id
          FROM harness_shared.plan_items
         WHERE workspace_id = ANY(${workspaceIds}::text[])
           AND plan_slug = ANY(${planSlugs}::text[])
           AND status NOT IN ('done', 'dropped')`,
      sql<{ workspace_id: string; harness_slug: string; plan_slug: string; item_id: string; owner: string }[]>`
        SELECT workspace_id, harness_slug, plan_slug, item_id, owner
          FROM harness_shared.plan_item_claims
         WHERE workspace_id = ANY(${workspaceIds}::text[])
           AND plan_slug = ANY(${planSlugs}::text[])
           AND expires_ts > clock_timestamp()`,
      sql<{ workspace_id: string; bee_id: string; spec: unknown }[]>`
        SELECT workspace_id, bee_id, spec
          FROM harness_shared.cup_claim_specs
         WHERE workspace_id = ANY(${workspaceIds}::text[])
           AND bee_id LIKE 'fleet:%'`,
    ]);

    const validSpecs = specRows.flatMap((row) => {
      const checked = validateClaimSpec(row.spec);
      if (!checked.ok || !checked.spec) return [];
      return [{ workspaceId: row.workspace_id, fleetSlug: row.bee_id.slice('fleet:'.length), spec: checked.spec }];
    });
    const targetPairs = relevantPlans.flatMap((plan) =>
      validSpecs
        .filter((spec) => spec.workspaceId === plan.workspace_id && claimSpecIsPlanScoped(spec.spec, plan.plan_slug))
        .map((spec) => ({ workspaceId: plan.workspace_id, fleetSlug: spec.fleetSlug })),
    );
    const uniqueTargets = [...new Map(targetPairs.map((p) => [fleetKey(p.workspaceId, p.fleetSlug), p])).values()];
    const fleetLiveness = await resolveFleetLiveness(uniqueTargets);
    const targetSlugs = [...new Set(uniqueTargets.map((p) => p.fleetSlug))];
    const memberRows = targetSlugs.length === 0
      ? []
      : await sql<{ workspace_id: string; fleet_slug: string; owner_id: string }[]>`
          SELECT workspace_id, fleet_slug, owner_id
            FROM harness_shared.coord_presence
           WHERE workspace_id = ANY(${workspaceIds}::text[])
             AND fleet_slug = ANY(${targetSlugs}::text[])`;

    const planKey = (workspaceId: string, harnessSlug: string, planSlug: string) =>
      `${workspaceId}\u0000${harnessSlug}\u0000${planSlug}`;
    return {
      status: 'known',
      plans: relevantPlans.map((plan) => {
        const key = planKey(plan.workspace_id, plan.harness_slug, plan.plan_slug);
        const itemIds = itemRows
          .filter((item) => planKey(item.workspace_id, item.harness_slug, item.plan_slug) === key)
          .map((item) => item.item_id);
        const targeting = validSpecs.filter(
          (spec) => spec.workspaceId === plan.workspace_id && claimSpecIsPlanScoped(spec.spec, plan.plan_slug),
        );
        return {
          goalId: plan.goal_id,
          workspaceId: plan.workspace_id,
          harnessSlug: plan.harness_slug,
          planSlug: plan.plan_slug,
          itemIds,
          targetingFleets: targeting.map((target) => {
            const members = new Set(
              memberRows
                .filter((m) => m.workspace_id === plan.workspace_id && m.fleet_slug === target.fleetSlug)
                .map((m) => m.owner_id),
            );
            return {
              fleetSlug: target.fleetSlug,
              liveness: fleetLiveness.get(fleetKey(plan.workspace_id, target.fleetSlug)) ?? 'unknown',
              liveClaimItemIds: claimRows
                .filter((claim) => planKey(claim.workspace_id, claim.harness_slug, claim.plan_slug) === key)
                .filter((claim) => members.has(claim.owner))
                .map((claim) => claim.item_id),
            };
          }),
        };
      }),
    };
  } catch {
    return { status: 'unknown', plans: [] };
  }
}

export interface GoalDrainAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  drainFleet: string | null;
  reason: GoalDrainReason;
  /** The positively-alive holders that make this goal "held" (owner ids). */
  liveHolders: string[];
}

/** Key a fleet-liveness map the same way the fleets table is keyed. */
export function fleetKey(workspaceId: string, fleetSlug: string): string {
  return `${workspaceId}:${fleetSlug}`;
}

/**
 * PURE: classify one goal. Returns null when the goal is healthy, when it is not
 * positively held alive (the sibling watchdog's territory), or when the evidence
 * is insufficient to call the drain fleet dark.
 */
export function classifyGoalDrainFleet(
  goal: GoalDrainRowLike,
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  fleetLiveness: ReadonlyMap<string, DrainFleetLiveness>,
  /** D-005: per-GOAL claim-spec scope verdicts (keyed by goalId — the pair being
   *  judged is (goal, its declared fleet), and two goals may declare one fleet). */
  specScopes: ReadonlyMap<string, DrainFleetSpecScope>,
  nowMs: number,
  graceMs: number = GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
): GoalDrainAlert | null {
  const mine = holders.filter(
    (h) => h.goalId === goal.goalId && h.workspaceId === goal.workspaceId,
  );
  // POSITIVE liveness required: a holder with no verdict is unknown, and unknown
  // never promotes to "held" here — if nobody is provably working the goal, the
  // drain-fleet question is moot and the liveness sibling owns the alarm.
  const liveHolders = mine
    .filter((h) => {
      const v = verdicts.get(h.ownerId);
      return v ? holderCountsAsAlive(v) : false;
    })
    .map((h) => h.ownerId);
  if (liveHolders.length === 0) return null;

  const base = {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    title: goal.title,
    drainFleet: goal.drainFleet,
    liveHolders,
  };

  if (goal.drainFleet === null) {
    const sinceCreation = nowMs - goal.createdAtMs;
    if (!Number.isFinite(sinceCreation) || sinceCreation < graceMs) return null;
    return { ...base, reason: 'no-drain-fleet-declared' };
  }

  const verdict =
    fleetLiveness.get(fleetKey(goal.workspaceId, goal.drainFleet)) ?? 'unknown';
  if (verdict === 'unknown') return null;
  if (verdict !== 'alive') {
    return {
      ...base,
      reason: verdict === 'not-found' ? 'drain-fleet-not-found' : 'drain-fleet-dead',
    };
  }
  // ALIVE — the pre-D-005 verdict stopped here, which let a pot-wide fleet
  // pass. Held correctly now also means SCOPED correctly: the lane's claim
  // spec must positively constrain admitted rows to THIS goal. Unknown (a
  // degraded spec read) suppresses, same as every other leg.
  const scope = specScopes.get(goal.goalId) ?? 'unknown';
  if (scope === 'not-goal-scoped') return { ...base, reason: 'drain-fleet-not-goal-scoped' };
  return null;
}

/** PURE: classify a whole batch. Exported for tests and future read-side surfaces. */
export function scanGoalDrainFleets(
  goals: readonly GoalDrainRowLike[],
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  fleetLiveness: ReadonlyMap<string, DrainFleetLiveness>,
  specScopes: ReadonlyMap<string, DrainFleetSpecScope>,
  nowMs: number,
  graceMs: number = GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
): GoalDrainAlert[] {
  const out: GoalDrainAlert[] = [];
  for (const g of goals) {
    const alert = classifyGoalDrainFleet(g, holders, verdicts, fleetLiveness, specScopes, nowMs, graceMs);
    if (alert) out.push(alert);
  }
  return out;
}

export interface GoalDrainFleetSweepDeps {
  readGoals: () => Promise<{ goals: GoalDrainRowLike[]; holders: GoalHolderLike[] }>;
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, LivenessVerdict>>;
  /** Resolve every declared drain fleet (by fleetKey) to a liveness verdict. */
  resolveFleetLiveness: (
    fleets: { workspaceId: string; fleetSlug: string }[],
  ) => Promise<Map<string, DrainFleetLiveness>>;
  /** D-005: resolve each (goal, declared fleet) pair to a claim-spec scope
   *  verdict, keyed by goalId. Only consulted for ALIVE fleets. */
  resolveFleetSpecScopes: (
    pairs: { workspaceId: string; fleetSlug: string; goalId: string }[],
  ) => Promise<Map<string, DrainFleetSpecScope>>;
  escalate: (alert: GoalDrainAlert) => Promise<void>;
  /** Emit goal:drain-dead:<goalId> for a DECLARED-but-gone fleet. Fail-soft. */
  emitDrainDead: (alert: GoalDrainAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  graceMs: number;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_DRAIN_FLEET_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

function makeReadGoals(sql: Sql): GoalDrainFleetSweepDeps['readGoals'] {
  return async () => {
    const goalRows = await sql<
      {
        id: string;
        workspace_id: string;
        title: string;
        created_ms: string;
        drain_fleet: string | null;
      }[]
    >`
      SELECT id, workspace_id, title,
             (extract(epoch FROM created_at) * 1000)::bigint AS created_ms,
             metadata->>'drainFleet' AS drain_fleet
        FROM harness_shared.goals
       WHERE status = 'active'`;
    // P-001: the canonical holder read. Unfiltered by goal on purpose — an inner
    // join to active goals would drop the no-holder case.
    const holders = await readGoalHolderRows(sql);
    return {
      goals: goalRows.map((r) => ({
        goalId: r.id,
        workspaceId: r.workspace_id,
        title: r.title,
        createdAtMs: Number(r.created_ms),
        drainFleet: r.drain_fleet,
      })),
      holders,
    };
  };
}

/**
 * A declared fleet is ALIVE when at least one of its current members (the
 * coord_presence fleet_slug projection) resolves alive through the shared
 * oracle. No fleets-table row ⇒ not-found. Members present but every verdict
 * dead ⇒ dead. ANY member the oracle could not resolve ⇒ unknown (suppress) —
 * the same degraded-read rule as everywhere else in this pair of files.
 */
function makeResolveFleetLiveness(
  sql: Sql,
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, LivenessVerdict>>,
): GoalDrainFleetSweepDeps['resolveFleetLiveness'] {
  return async (fleets) => {
    const out = new Map<string, DrainFleetLiveness>();
    if (fleets.length === 0) return out;
    const slugs = [...new Set(fleets.map((f) => f.fleetSlug))];
    const fleetRows = await sql<{ workspace_id: string; fleet_slug: string }[]>`
      SELECT workspace_id, fleet_slug
        FROM harness_shared.agent_fleets
       WHERE fleet_slug = ANY(${slugs}::text[])`;
    const existing = new Set(fleetRows.map((r) => fleetKey(r.workspace_id, r.fleet_slug)));
    const memberRows = await sql<
      { workspace_id: string; fleet_slug: string; owner_id: string }[]
    >`
      SELECT workspace_id, fleet_slug, owner_id
        FROM harness_shared.coord_presence
       WHERE fleet_slug = ANY(${slugs}::text[])`;
    const membersByFleet = new Map<string, string[]>();
    for (const m of memberRows) {
      const k = fleetKey(m.workspace_id, m.fleet_slug);
      const list = membersByFleet.get(k) ?? [];
      list.push(m.owner_id);
      membersByFleet.set(k, list);
    }
    const allMembers = [...new Set(memberRows.map((m) => m.owner_id))];
    const verdicts = allMembers.length > 0 ? await resolveLiveness(allMembers) : new Map<string, LivenessVerdict>();

    for (const f of fleets) {
      const k = fleetKey(f.workspaceId, f.fleetSlug);
      if (!existing.has(k)) {
        out.set(k, 'not-found');
        continue;
      }
      const members = membersByFleet.get(k) ?? [];
      if (members.length === 0) {
        out.set(k, 'dead');
        continue;
      }
      let verdict: DrainFleetLiveness = 'dead';
      for (const ownerId of members) {
        const v = verdicts.get(ownerId);
        if (!v) {
          verdict = 'unknown'; // degraded read — never inferred as dead
          break;
        }
        if (holderCountsAsAlive(v)) {
          verdict = 'alive';
          break;
        }
      }
      out.set(k, verdict);
    }
    return out;
  };
}

/**
 * D-005: resolve each (goal, declared fleet) pair's claim-spec scope. The fleet
 * lane lives on the `fleet:<slug>` sentinel row of cup_claim_specs; NO row means
 * members inherit DEFAULT_CLAIM_SPEC (an empty view), which is truthfully a
 * pot-wide lane — not-goal-scoped, not unknown. The row is looked up first under
 * the goal's own workspace partition, then under ANY partition (WI-1564: legacy
 * writers stored under 'default'; alarming on a partition mismatch would be a
 * false positive about scope). A failed READ is 'unknown' and suppresses.
 */
function makeResolveFleetSpecScopes(sql: Sql): GoalDrainFleetSweepDeps['resolveFleetSpecScopes'] {
  return async (pairs) => {
    const out = new Map<string, DrainFleetSpecScope>();
    if (pairs.length === 0) return out;
    try {
      const { fleetSpecBeeKey } = await import('../scheduler/claim-spec-store');
      const keys = [...new Set(pairs.map((p) => fleetSpecBeeKey(p.fleetSlug)))];
      const rows = await sql<{ workspace_id: string; bee_id: string; spec: unknown }[]>`
        SELECT workspace_id, bee_id, spec
          FROM harness_shared.cup_claim_specs
         WHERE bee_id = ANY(${keys}::text[])`;
      for (const p of pairs) {
        const beeKey = fleetSpecBeeKey(p.fleetSlug);
        const row =
          rows.find((r) => r.bee_id === beeKey && r.workspace_id === p.workspaceId) ??
          rows.find((r) => r.bee_id === beeKey);
        out.set(
          p.goalId,
          claimSpecIsGoalScoped(row?.spec ?? null, p.goalId) ? 'goal-scoped' : 'not-goal-scoped',
        );
      }
    } catch {
      out.clear();
      for (const p of pairs) out.set(p.goalId, 'unknown');
    }
    return out;
  };
}

const REASON_PROSE: Record<GoalDrainReason, string> = {
  'no-drain-fleet-declared':
    'has NO standing drain fleet declared (goals metadata.drainFleet is unset)',
  'drain-fleet-not-found':
    'declares a drain fleet that does not exist in agent_fleets',
  'drain-fleet-dead': 'declares a drain fleet with no live member',
  'drain-fleet-not-goal-scoped':
    "declares a LIVE drain fleet whose claim-spec lane is NOT scoped to this goal — no positive " +
    "{field:'goal',op:'='|'in'} filter constrains what its members pull, so it drains the whole pot " +
    'and guarantees nothing about work filed under THIS goal (D-005)',
};

const SUMMARY_VERDICT: Record<Exclude<GoalDrainReason, 'no-drain-fleet-declared'>, string> = {
  'drain-fleet-not-found': 'missing',
  'drain-fleet-dead': 'dead',
  'drain-fleet-not-goal-scoped': 'not scoped to the goal (D-005)',
};

async function defaultEscalate(alert: GoalDrainAlert): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${alert.goalId}' is live-held but ${
        alert.reason === 'no-drain-fleet-declared'
          ? 'has no standing drain fleet'
          : `its drain fleet '${alert.drainFleet}' is ${SUMMARY_VERDICT[alert.reason]}`
      }`,
    body:
      `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) is ` +
      `actively held (live holder(s): ${alert.liveHolders.join(', ')}) but ` +
      `${REASON_PROSE[alert.reason]}.\n\n` +
      `The GOAL contract requires ONE STANDING DRAIN FLEET PER GOAL, always ` +
      `maintained — the drain fleet is what makes never-implement livable: the goal ` +
      `agent files work (work_items:create) and the fleet drains it, instead of the ` +
      `agent editing code itself. In the run that motivated this watchdog the drain ` +
      `fleet was never established, and the agent's only editing window was also its ` +
      `lowest-supervision window.\n\n` +
      `Remedy — the goal holder should pick ONE now:\n` +
      (alert.reason === 'drain-fleet-not-goal-scoped'
        ? `  • Scope the lane: scheduler:set_claim_spec { fleet: '${alert.drainFleet}', spec } with a ` +
          `POSITIVE { field:'goal', op:'=', value:'${alert.goalId}' } filter leaf. The positive form is ` +
          `load-bearing (WI-37711): the goal column is NULLABLE, so a not/!= leaf silently excludes ` +
          `every unstamped row — and a pot-wide lane drains everything, guaranteeing nothing about ` +
          `THIS goal's filed work.\n`
        : '') +
      `  • Stand the fleet up (fleet:create / fleet:launch-on-plan), then record it: ` +
      `goals:update { id: '${alert.goalId}', drainFleet: '<fleet-slug>' }.\n` +
      `  • Fleet exists under another slug? Fix the record: goals:update { id: '${alert.goalId}', drainFleet: '<actual-slug>' }.\n` +
      `  • Goal no longer worth a fleet? That is a kill-criterion conversation, not a ` +
      `reason to run drainless.\n\n` +
      `Reported + event-emitted (goal:drain-dead), never auto-launched: standing a ` +
      `fleet up is the goal holder's authority, noticing its absence is this watchdog's.`,
    meta: {
      dedupKind: 'goal-drain-fleet',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:${alert.reason}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      reason: alert.reason,
      drainFleet: alert.drainFleet,
      liveHolders: alert.liveHolders,
    },
  });
}

async function defaultEmitDrainDead(alert: GoalDrainAlert): Promise<void> {
  // Only a DECLARED-but-gone fleet emits: the goal agent parked on this key is
  // waiting to hear its fleet died, not to be nagged about paperwork — and a
  // mis-SCOPED fleet (D-005) is alive, so it escalates but never emits here.
  if (alert.reason !== 'drain-fleet-not-found' && alert.reason !== 'drain-fleet-dead') return;
  const { emitAwaitedEvent } = await import('../events/await/engine');
  await emitAwaitedEvent({
    key: `goal:drain-dead:${alert.goalId}`,
    workspaceId: alert.workspaceId,
    source: 'goal-drain-fleet-watchdog',
    payload: {
      goalId: alert.goalId,
      drainFleet: alert.drainFleet,
      reason: alert.reason,
    },
  });
}

function sweepDeps(
  sql: Sql,
  overrides: Partial<GoalDrainFleetSweepDeps>,
): GoalDrainFleetSweepDeps {
  const resolveLiveness = overrides.resolveLiveness ?? resolveHolderLiveness;
  return {
    readGoals: makeReadGoals(sql),
    resolveLiveness,
    resolveFleetLiveness: makeResolveFleetLiveness(sql, resolveLiveness),
    resolveFleetSpecScopes: makeResolveFleetSpecScopes(sql),
    escalate: defaultEscalate,
    emitDrainDead: defaultEmitDrainDead,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    graceMs: GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
    ...overrides,
  };
}

/**
 * One sweep. Failures are contained per-alert (a bad row cannot cost the batch);
 * escalation-side dedup makes the next tick's retry idempotent. Exported for tests.
 */
export async function runGoalDrainFleetSweepOnce(
  sql: Sql,
  overrides: Partial<GoalDrainFleetSweepDeps> = {},
): Promise<{ scanned: number; escalated: number; skipped: boolean }> {
  const deps = sweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) return { scanned: 0, escalated: 0, skipped: true };

  const { goals, holders } = await deps.readGoals();
  if (goals.length === 0) return { scanned: 0, escalated: 0, skipped: false };

  const activeKeys = new Set(goals.map((g) => fleetKey(g.workspaceId, g.goalId)));
  const relevant = holders.filter((h) => activeKeys.has(fleetKey(h.workspaceId, h.goalId)));
  const verdicts = await deps.resolveLiveness([...new Set(relevant.map((h) => h.ownerId))]);

  const declaredGoals = goals.filter(
    (g): g is GoalDrainRowLike & { drainFleet: string } => g.drainFleet !== null,
  );
  const declared = declaredGoals.map((g) => ({ workspaceId: g.workspaceId, fleetSlug: g.drainFleet }));
  const fleetLiveness = await deps.resolveFleetLiveness(declared);

  // D-005: scope is judged only where it can change the verdict — a fleet that
  // is dead/missing/unknown already has its (more urgent, or suppressed) answer.
  const alivePairs = declaredGoals
    .filter((g) => fleetLiveness.get(fleetKey(g.workspaceId, g.drainFleet)) === 'alive')
    .map((g) => ({ workspaceId: g.workspaceId, fleetSlug: g.drainFleet, goalId: g.goalId }));
  const specScopes = await deps.resolveFleetSpecScopes(alivePairs);

  const alerts = scanGoalDrainFleets(
    goals,
    relevant,
    verdicts,
    fleetLiveness,
    specScopes,
    deps.now(),
    deps.graceMs,
  );
  let escalated = 0;
  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
      escalated += 1;
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] escalate failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      await deps.emitDrainDead(alert);
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] event emit failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { scanned: goals.length, escalated, skipped: false };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the goal-drain-fleet watchdog: a recurring process-level sweep.
 * Idempotent. Runtime gate: FLAGS.GOAL_DRAIN_FLEET_WATCHDOG (checked per tick).
 */
export function startGoalDrainFleetWatchdog(
  sql: Sql,
  opts: { intervalMs?: number } = {},
): void {
  const intervalMs = opts.intervalMs ?? GOAL_DRAIN_FLEET_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'goal-drain-fleet-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runGoalDrainFleetSweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[goal-drain-fleet-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // D-004: 'timeout-reaper'. The alarm condition is a goal held for a WINDOW without
    // the fleet its contract requires — the absence of a fleet emits no event, so the
    // passage of time in that state is the only trigger available.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
