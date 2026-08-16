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
import {
  resolveSessionStates,
  type LivenessVerdict,
} from '../agent-tools/coordination/liveness-oracle';
import {
  holderCountsAsAlive,
  type GoalHolderLike,
} from './goal-liveness-watchdog';

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
  if (!filter || typeof filter !== 'object') return false;
  const node = filter as Record<string, unknown>;
  if (Array.isArray(node.all)) {
    return node.all.some((n) => claimSpecFilterConstrainsGoal(n, goalId));
  }
  if (Array.isArray(node.any)) {
    return node.any.length > 0 && node.any.every((n) => claimSpecFilterConstrainsGoal(n, goalId));
  }
  if ('not' in node) return false;
  if (node.field !== 'goal') return false;
  if (node.op === '=') return node.value === goalId;
  if (node.op === 'in') return Array.isArray(node.value) && node.value.includes(goalId);
  return false;
}

/** PURE: `claimSpecFilterConstrainsGoal` lifted to a whole stored spec. */
export function claimSpecIsGoalScoped(spec: unknown, goalId: string): boolean {
  if (!spec || typeof spec !== 'object') return false;
  const view = (spec as { view?: { filter?: unknown } }).view;
  return claimSpecFilterConstrainsGoal(view?.filter, goalId);
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
  nowMs: number,
  graceMs: number = GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
): GoalDrainAlert[] {
  const out: GoalDrainAlert[] = [];
  for (const g of goals) {
    const alert = classifyGoalDrainFleet(g, holders, verdicts, fleetLiveness, nowMs, graceMs);
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
    const holderRows = await sql<
      { workspace_id: string; subject: string; owner_id: string; set_ms: string }[]
    >`
      SELECT workspace_id, subject, owner_id,
             (extract(epoch FROM set_at) * 1000)::bigint AS set_ms
        FROM harness_shared.agent_modes
       WHERE mode = 'goal' AND subject IS NOT NULL`;
    return {
      goals: goalRows.map((r) => ({
        goalId: r.id,
        workspaceId: r.workspace_id,
        title: r.title,
        createdAtMs: Number(r.created_ms),
        drainFleet: r.drain_fleet,
      })),
      holders: holderRows.map((r) => ({
        goalId: r.subject,
        workspaceId: r.workspace_id,
        ownerId: r.owner_id,
        setAtMs: Number(r.set_ms),
      })),
    };
  };
}

async function defaultResolveLiveness(ownerIds: string[]): Promise<Map<string, LivenessVerdict>> {
  if (ownerIds.length === 0) return new Map();
  return await resolveSessionStates(
    ownerIds.map((ownerId) => ({ ownerId })),
    { hydratePerId: true, selfWake: true },
  );
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

const REASON_PROSE: Record<GoalDrainReason, string> = {
  'no-drain-fleet-declared':
    'has NO standing drain fleet declared (goals metadata.drainFleet is unset)',
  'drain-fleet-not-found':
    'declares a drain fleet that does not exist in agent_fleets',
  'drain-fleet-dead': 'declares a drain fleet with no live member',
};

async function defaultEscalate(alert: GoalDrainAlert): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${alert.goalId}' is live-held but ${
        alert.reason === 'no-drain-fleet-declared'
          ? 'has no standing drain fleet'
          : `its drain fleet '${alert.drainFleet}' is ${alert.reason === 'drain-fleet-not-found' ? 'missing' : 'dead'}`
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
  // waiting to hear its fleet died, not to be nagged about paperwork.
  if (alert.reason === 'no-drain-fleet-declared') return;
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
  const resolveLiveness = overrides.resolveLiveness ?? defaultResolveLiveness;
  return {
    readGoals: makeReadGoals(sql),
    resolveLiveness,
    resolveFleetLiveness: makeResolveFleetLiveness(sql, resolveLiveness),
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

  const declared = goals
    .filter((g): g is GoalDrainRowLike & { drainFleet: string } => g.drainFleet !== null)
    .map((g) => ({ workspaceId: g.workspaceId, fleetSlug: g.drainFleet }));
  const fleetLiveness = await deps.resolveFleetLiveness(declared);

  const alerts = scanGoalDrainFleets(
    goals,
    relevant,
    verdicts,
    fleetLiveness,
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
