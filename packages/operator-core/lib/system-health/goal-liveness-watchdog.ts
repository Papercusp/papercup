/**
 * goal-liveness-watchdog (system-notices-on-its-own-2026-08-16 P-001) — alarm on
 * an ACTIVE goal that nobody is actually working.
 *
 * WHY THIS EXISTS. Every layer BELOW goal was already watched — engine loops,
 * cadence drift, idle sessions, orphaned MCP processes, supervision units, stale
 * executors, cgroups, green-stall, git-sync-stall, origin-freshness,
 * carry-drill-drop, compaction-compliance, cluster-lag, memory. GOAL, the layer
 * the product has been organized around since mug/kettle/cup was retired in its
 * favor, had NOTHING: `routines:list { q:'goal' }` returned zero rows.
 *
 * Measured on 2026-08-16, the moment this file was written: of the 6 goals with
 * `status='active'` in papercusp-workspace, only 2 had a live holder. The other
 * 4 — including `make-sidestage-web-ios-and-android-ready-for-pub-dd62af` and
 * `the-gui-chat-surface-is-ready-to-ship-to-strange-8fa0ed`, both real product
 * goals — had been dark since 08-14 and 08-11 while every surface reported them
 * healthy. The detection event was a human asking.
 *
 * THE DEFECT THIS MAKES IMPOSSIBLE. A goal's holder is recorded as a row in
 * `harness_shared.agent_modes` (mode='goal', subject=<goal id>). That row is
 * ordinary durable state: it OUTLIVES the session that wrote it. Nothing clears
 * it when the session dies, so "this goal has 1 holder" stays true forever and
 * reads as healthy for a goal nobody has touched in five days. Row presence is
 * not liveness — that is the whole bug, and it is why this sweep resolves every
 * holder through the shared oracle instead of counting rows.
 *
 * WHY TICK-DRIVEN, AND WHY THAT IS THE POINT. The sibling failure that motivated
 * this (blender-steward-heartbeat-2026-08-11 D-005) is a recovery mechanism with
 * a CIRCULAR DEPENDENCY: the heartbeat meant to relaunch a dead steward executes
 * its runs by claiming a work-item, and when the steward is dead there is nobody
 * alive to claim one. It therefore cannot recover the exact failure it exists
 * for. A `managedSetInterval` in the operator host has no such dependency — it is
 * alive precisely when the agents it watches are not. Do not "improve" this into
 * something an agent has to claim.
 *
 * Design notes:
 *  - `managedSetInterval` (never a bare setInterval) — visible in
 *    schedule:inventory, category 'watchdog', like its system-health siblings.
 *  - Runtime gate: FLAGS.GOAL_LIVENESS_WATCHDOG (default ON — flip OFF at
 *    /admin/features; no ad-hoc env boolean per lint:env-feature-gates).
 *  - Liveness comes from `resolveSessionStates` (the ONE oracle behind
 *    coord:presence / fleet:status / leader-brief). Hand-rolling a heartbeat
 *    comparison here would reintroduce exactly the per-surface divergence
 *    presence-derivation-unification-2026-07-17 removed.
 *  - REPORTS, never relaunches. Auto-spawning an agent against a stale goal is a
 *    different and much larger authority question; "nothing notices" is the
 *    defect being fixed, and an escalation fixes it. Deliberate scope choice.
 *  - Dedup is delegated to openEscalation's (dedupKind, subjectSignature) PG
 *    dedup — cluster-safe, no new state surface.
 *
 * P-005 (goal-dag-shared-substrate-2026-08-18): the same sweep also reads each
 * active goal's DAG readiness (derived on read, D-006) and reports — never acts
 * on — two more conditions:
 *  - BECAME-READY: a goal with blocked-by edges whose blockers are now all
 *    satisfied, with nobody alive on it. Readiness at goal level is an
 *    ACTIVATION gate, never dispatch (D-003): becoming ready produces this
 *    surfaced OFFER, and a human or the parent goal's agent decides to start
 *    it. The watchdog never auto-starts.
 *  - PREMISE-INVALIDATED: a goal with a KILLED goal-blocker (D-002 — killed
 *    invalidates the dependent's premise and never silently unblocks). Fired
 *    regardless of holder liveness: a live holder needs the review too.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import {
  goalReadiness,
  blockerStatusKey,
  readGoalBlockedByEdges,
  resolveBlockerStatuses,
  type GoalBlockerView,
  type GoalReadiness,
} from '@papercusp/agent-mcp/goal-deps';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import {
  readGoalHolderRows,
  resolveGoalHoldersFromRows,
  resolveHolderLiveness,
  type GoalHolderRow,
} from '../goals/holder';

/**
 * P-001: `holderCountsAsAlive` moved to `../goals/holder`, which is now the ONE
 * definition of "who holds this goal and is any of them alive". Re-exported here
 * because this file was its original home and the drain-fleet sibling imports it
 * from this path; both now resolve to the shared implementation rather than the
 * watchdog owning a rule the product surfaces had no access to.
 */
export { holderCountsAsAlive } from '../goals/holder';

export const GOAL_LIVENESS_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * How long a goal may show no live holder before it is called abandoned.
 *
 * This threshold is what separates "between sessions" from "dark". A goal is a
 * long-lived intent worked across many sessions, so an instantaneous gap is
 * NORMAL and alarming on it would make this watchdog noise. Six hours sits well
 * inside the signal without touching the normal case: the four goals that
 * motivated this file had been dark for 2 to 5 DAYS, and a legitimate handoff
 * gap on an actively-pursued goal is minutes to an hour or two.
 */
export const GOAL_LIVENESS_GRACE_MS = 6 * 60 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'goal-liveness-watchdog',
  ownerLabel: 'system · goal liveness',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One `status='active'` goal, reduced to what the verdict needs. */
export interface GoalRowLike {
  goalId: string;
  workspaceId: string;
  title: string;
  /** ms epoch of the goal row's last update. */
  updatedAtMs: number;
}

/**
 * One `agent_modes` goal-mode row pointing at a goal.
 *
 * P-001: this is now an ALIAS of the shared `GoalHolderRow` rather than a
 * parallel shape — a second structural definition of "a holder row" is how the
 * liveness join came to exist here and nowhere else.
 */
export type GoalHolderLike = GoalHolderRow;

/**
 * Why a goal is being reported.
 *
 * `unheld` (no goal-mode row at all) and `abandoned` (rows exist but no holder is
 * alive) are kept apart because they call for different remedies — the first was
 * never picked up, the second was dropped mid-flight — and because collapsing
 * them would hide which one is happening.
 */
export type GoalLivenessReason = 'unheld' | 'abandoned';

export interface GoalLivenessAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  reason: GoalLivenessReason;
  /** Most recent evidence anyone touched this goal (ms epoch). */
  lastEvidenceMs: number;
  darkMs: number;
  /** Holders and the verdict each resolved to, for the escalation body. */
  holders: { ownerId: string; sessionState: string }[];
}

/**
 * PURE: classify one goal. Returns null when the goal is healthy OR when the
 * evidence is insufficient to call it dark.
 *
 * THE CONSERVATIVE RULE, stated explicitly because it is the difference between a
 * useful watchdog and a nuisance: a holder for whom the oracle returned NO
 * verdict is UNKNOWN, not dead. `resolveSessionStates` omits an entry when its
 * wakeability fetch degraded, so treating a missing entry as death would turn a
 * transient DB hiccup into a wave of false abandonment alarms across every goal
 * at once. An unresolvable holder therefore suppresses the alert entirely — this
 * is `resolveGoalHolders`' `liveness: 'unknown'` verdict, which the shared module
 * keeps distinct from `'lost'` for exactly this reason (P-001).
 */
export function classifyGoalLiveness(
  goal: GoalRowLike,
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  nowMs: number,
  graceMs: number = GOAL_LIVENESS_GRACE_MS,
): GoalLivenessAlert | null {
  const resolved = resolveGoalHoldersFromRows(
    goal.goalId,
    goal.workspaceId,
    holders,
    verdicts,
  );
  // 'held' → someone is on it. 'unknown' → at least one holder is unresolvable,
  // which is not evidence of death. Only 'unheld' / 'lost' are reportable.
  if (resolved.liveness === 'held' || resolved.liveness === 'unknown') return null;
  const mine = resolved.holders;

  const lastEvidenceMs = Math.max(goal.updatedAtMs, ...mine.map((h) => h.setAtMs), 0);
  const darkMs = nowMs - lastEvidenceMs;
  if (!Number.isFinite(darkMs) || darkMs < graceMs) return null;

  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    title: goal.title,
    reason: resolved.liveness === 'unheld' ? 'unheld' : 'abandoned',
    lastEvidenceMs,
    darkMs,
    holders: mine.map((h) => ({
      ownerId: h.ownerId,
      sessionState: h.sessionState ?? 'unknown',
    })),
  };
}

/* ── P-005: the readiness leg ─────────────────────────────────────────────── */

export type GoalReadinessAlertKind = 'became-ready' | 'premise-invalidated';

export interface GoalReadinessAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  kind: GoalReadinessAlertKind;
  /** The blockers relevant to the verdict (invalidating ones for premise-invalidated; all for became-ready). */
  blockers: GoalBlockerView[];
}

/** The holder-liveness fold `resolveGoalHoldersFromRows` produces for one goal. */
export type GoalHolderLivenessFold = 'held' | 'unheld' | 'lost' | 'unknown';

/**
 * PURE: classify one goal's DAG readiness into a report, or null.
 *
 * Rules (D-002/D-003):
 *  - No edges ⇒ nothing to say: a goal that never declared prerequisites was
 *    always startable, so "became ready" would be noise for every plain goal.
 *  - PREMISE-INVALIDATED wins over everything: a killed blocker needs review
 *    whether or not somebody is on the goal, so holder liveness is ignored.
 *  - BECAME-READY only when every blocker is satisfied AND nobody is alive on
 *    the goal ('unheld' / 'lost'). 'held' means it is being worked — no offer
 *    needed; 'unknown' suppresses, the same conservative rule as the liveness
 *    leg (an unresolvable holder is not evidence of absence).
 */
export function classifyGoalReadiness(
  goal: GoalRowLike,
  readiness: GoalReadiness | undefined,
  holderLiveness: GoalHolderLivenessFold,
): GoalReadinessAlert | null {
  if (!readiness || readiness.blockers.length === 0) return null;
  if (readiness.premiseInvalidated) {
    return {
      goalId: goal.goalId,
      workspaceId: goal.workspaceId,
      title: goal.title,
      kind: 'premise-invalidated',
      blockers: readiness.blockers.filter((b) => b.verdict === 'invalidating'),
    };
  }
  if (readiness.actionable && (holderLiveness === 'unheld' || holderLiveness === 'lost')) {
    return {
      goalId: goal.goalId,
      workspaceId: goal.workspaceId,
      title: goal.title,
      kind: 'became-ready',
      blockers: readiness.blockers,
    };
  }
  return null;
}

/** PURE: classify a whole batch. Exported for tests and for a future read-side surface. */
export function scanGoalLiveness(
  goals: readonly GoalRowLike[],
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  nowMs: number,
  graceMs: number = GOAL_LIVENESS_GRACE_MS,
): GoalLivenessAlert[] {
  const out: GoalLivenessAlert[] = [];
  for (const g of goals) {
    const alert = classifyGoalLiveness(g, holders, verdicts, nowMs, graceMs);
    if (alert) out.push(alert);
  }
  return out;
}

function formatDark(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export interface GoalLivenessSweepDeps {
  readGoals: () => Promise<{ goals: GoalRowLike[]; holders: GoalHolderLike[] }>;
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, LivenessVerdict>>;
  escalate: (alert: GoalLivenessAlert) => Promise<void>;
  /**
   * P-005: each goal's DAG readiness, keyed `workspaceId:goalId` (the
   * `blockerStatusKey` colon convention). Goals with NO edges may be absent.
   */
  readReadiness: (goals: readonly GoalRowLike[]) => Promise<Map<string, GoalReadiness>>;
  escalateReadiness: (alert: GoalReadinessAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  graceMs: number;
}

/** The `readReadiness` map key. Colon-composite, same convention as `blockerStatusKey`. */
export function goalReadinessKey(g: Pick<GoalRowLike, 'workspaceId' | 'goalId'>): string {
  return `${g.workspaceId}:${g.goalId}`;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_LIVENESS_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

function makeReadGoals(sql: Sql): GoalLivenessSweepDeps['readGoals'] {
  return async () => {
    const goalRows = await sql<
      { id: string; workspace_id: string; title: string; updated_ms: string }[]
    >`
      SELECT id, workspace_id, title,
             (extract(epoch FROM updated_at) * 1000)::bigint AS updated_ms
        FROM harness_shared.goals
       WHERE status = 'active'`;
    // Every goal-mode row in one read, via the canonical holder read (P-001);
    // joined in memory so a goal with NO holder row is still visible (an inner
    // join would silently drop the `unheld` case, which is one of the two
    // conditions this watchdog exists to report).
    const holders = await readGoalHolderRows(sql);
    return {
      goals: goalRows.map((r) => ({
        goalId: r.id,
        workspaceId: r.workspace_id,
        title: r.title,
        updatedAtMs: Number(r.updated_ms),
      })),
      holders,
    };
  };
}

/**
 * P-005 default `readReadiness`: derived on read per D-006, batched per
 * workspace (edges in one query, then one status resolve over the union of that
 * workspace's blocker endpoints). FAIL-SOFT by design: readiness is an additive
 * leg, and a degraded DAG read must not cost the liveness sweep — it warns and
 * returns what it has.
 */
function makeReadReadiness(sql: Sql): GoalLivenessSweepDeps['readReadiness'] {
  return async (goals) => {
    const out = new Map<string, GoalReadiness>();
    const tag = sql as unknown as GoalSqlTag;
    const byWorkspace = new Map<string, GoalRowLike[]>();
    for (const g of goals) {
      const arr = byWorkspace.get(g.workspaceId) ?? [];
      arr.push(g);
      byWorkspace.set(g.workspaceId, arr);
    }
    for (const [workspaceId, wsGoals] of byWorkspace) {
      try {
        const edges = await readGoalBlockedByEdges(tag, workspaceId);
        const withEdges = wsGoals.filter((g) => (edges.get(g.goalId) ?? []).length > 0);
        if (withEdges.length === 0) continue;
        // One status resolve over the union — goal cardinality is tiny (D-006).
        const union = new Map<string, { kind: 'goal' | 'issue'; ref: string }>();
        for (const g of withEdges) {
          for (const b of edges.get(g.goalId) ?? []) union.set(blockerStatusKey(b), b);
        }
        const statuses = await resolveBlockerStatuses(tag, workspaceId, [...union.values()]);
        for (const g of withEdges) {
          const blockers = edges.get(g.goalId) ?? [];
          out.set(
            goalReadinessKey(g),
            goalReadiness(
              blockers.map((b) => ({ ...b, status: statuses.get(blockerStatusKey(b)) ?? null })),
            ),
          );
        }
      } catch (e) {
        console.warn(
          `[goal-liveness-watchdog] readiness read failed for workspace ${workspaceId} (non-fatal, leg skipped): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return out;
  };
}

async function defaultEscalate(alert: GoalLivenessAlert): Promise<void> {
  const dark = formatDark(alert.darkMs);
  const holderNote =
    alert.holders.length === 0
      ? 'No goal-mode holder row exists for it at all — it was never picked up.'
      : `Its goal-mode holder(s) resolve DEAD through the shared liveness oracle: ` +
        `${alert.holders.map((h) => `${h.ownerId} [${h.sessionState}]`).join(', ')}. ` +
        `The agent_modes row survives the session that wrote it, so every count-based ` +
        `surface still reports this goal as held.`;
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${alert.goalId}' is status=active but ${alert.reason === 'unheld' ? 'was never picked up' : 'has no live holder'} ` +
      `— dark ${dark}`,
    body:
      `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) has ` +
      `status='active' and nothing is working it. Last evidence anyone touched it: ` +
      `${new Date(alert.lastEvidenceMs).toISOString()} (${dark} ago).\n\n` +
      `${holderNote}\n\n` +
      `Triage — pick ONE, do not leave it in this state:\n` +
      `  • Still wanted? Take it: goals:start / mode:set { mode:'goal', subject:'${alert.goalId}' }.\n` +
      `  • Finished? Close it: goals:update { status:'done' }.\n` +
      `  • Abandoned? Close it against its kill criterion: goals:update { status:'dropped' }.\n\n` +
      `This is reported, never auto-relaunched: spawning an agent against a stale goal is a ` +
      `separate authority question. The defect being fixed is that nobody NOTICED — before this ` +
      `watchdog, the GOAL layer had no detector at all (routines:list { q:'goal' } → 0 rows) and ` +
      `the detection event for a multi-day-dark goal was a human happening to ask.`,
    meta: {
      dedupKind: 'goal-liveness',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:${alert.reason}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      reason: alert.reason,
      darkMs: alert.darkMs,
      holders: alert.holders,
    },
  });
}

/** P-005: the report-only readiness escalations. Same dedup surface as the liveness leg. */
async function defaultEscalateReadiness(alert: GoalReadinessAlert): Promise<void> {
  const blockerList = alert.blockers
    .map((b) => `${b.ref} (${b.kind}/${b.status ?? 'absent'}/${b.verdict})`)
    .join(', ');
  const isPremise = alert.kind === 'premise-invalidated';
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: isPremise
      ? `Goal '${alert.goalId}' premise INVALIDATED — killed blocker(s): ${blockerList}`
      : `Goal '${alert.goalId}' is now ACTIONABLE — every blocker satisfied, and nobody is on it`,
    body: isPremise
      ? `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) is blocked ` +
        `by ${blockerList} — KILLED, which invalidates this goal's premise (D-002: a killed ` +
        `blocker never silently unblocks; achieving and killing a prerequisite mean opposite ` +
        `things downstream).\n\n` +
        `Review — pick ONE, deliberately:\n` +
        `  • Premise survives anyway? Remove the edge: goals:update { blockedBy } without it.\n` +
        `  • Premise is gone? Kill the dependent too: goals:update { status:'killed' }.\n` +
        `  • Retarget: rewrite this goal against the world as it now is.\n\n` +
        `Reported, never auto-resolved: the substrate flags the premise for review and a human ` +
        `or the parent goal's agent decides.`
      : `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) declared ` +
        `prerequisites and they are now ALL satisfied: ${blockerList}. No live holder is on it.\n\n` +
        `This is a surfaced OFFER, not a dispatch (D-003 — readiness at goal level is an ` +
        `activation gate; goals never enter a claim queue and are never auto-started):\n` +
        `  • Start it: goals:start — or mode:set { mode:'goal', subject:'${alert.goalId}' } for an ` +
        `existing session. If it was filed as a stub (D-004), activation is where the full ` +
        `kickoff contract runs — kill criterion, ceiling, consult, drain fleet — against the ` +
        `world as it NOW is.\n` +
        `  • Or leave it deliberately parked / re-scope it. Either is fine; the defect this ` +
        `report prevents is the goal unblocking with nobody NOTICING.`,
    meta: {
      dedupKind: 'goal-readiness',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:${alert.kind}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      kind: alert.kind,
      blockers: alert.blockers,
    },
  });
}

function sweepDeps(
  sql: Sql,
  overrides: Partial<GoalLivenessSweepDeps>,
): GoalLivenessSweepDeps {
  return {
    readGoals: makeReadGoals(sql),
    resolveLiveness: resolveHolderLiveness,
    escalate: defaultEscalate,
    readReadiness: makeReadReadiness(sql),
    escalateReadiness: defaultEscalateReadiness,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...overrides,
  };
}

/**
 * One sweep: read active goals + their holder rows, resolve every holder through
 * the liveness oracle, escalate each goal with nobody alive on it.
 *
 * A failed escalate is swallowed per-alert so one bad row cannot cost the rest of
 * the batch; the escalation-side dedup makes the next tick's retry idempotent.
 * Exported for tests.
 */
export async function runGoalLivenessSweepOnce(
  sql: Sql,
  overrides: Partial<GoalLivenessSweepDeps> = {},
): Promise<{ scanned: number; escalated: number; readinessEscalated: number; skipped: boolean }> {
  const deps = sweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) {
    return { scanned: 0, escalated: 0, readinessEscalated: 0, skipped: true };
  }

  const { goals, holders } = await deps.readGoals();
  if (goals.length === 0) {
    return { scanned: 0, escalated: 0, readinessEscalated: 0, skipped: false };
  }

  // Only resolve holders that actually point at an active goal — the agent_modes
  // read is unfiltered by design (so `unheld` stays visible), but there is no
  // reason to pay oracle cost for rows pointing at closed goals.
  const activeKeys = new Set(goals.map((g) => `${g.workspaceId}:${g.goalId}`));
  const relevant = holders.filter((h) => activeKeys.has(`${h.workspaceId}:${h.goalId}`));
  const verdicts = await deps.resolveLiveness([...new Set(relevant.map((h) => h.ownerId))]);

  const alerts = scanGoalLiveness(goals, relevant, verdicts, deps.now(), deps.graceMs);
  let escalated = 0;
  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
      escalated += 1;
    } catch (e) {
      console.warn(
        `[goal-liveness-watchdog] escalate failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ── P-005: the readiness leg — report-only, same conservative rules ──────
  let readinessEscalated = 0;
  const readiness = await deps.readReadiness(goals);
  for (const g of goals) {
    const fold = resolveGoalHoldersFromRows(g.goalId, g.workspaceId, relevant, verdicts);
    const alert = classifyGoalReadiness(g, readiness.get(goalReadinessKey(g)), fold.liveness);
    if (!alert) continue;
    try {
      await deps.escalateReadiness(alert);
      readinessEscalated += 1;
    } catch (e) {
      console.warn(
        `[goal-liveness-watchdog] readiness escalate failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { scanned: goals.length, escalated, readinessEscalated, skipped: false };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the goal-liveness watchdog: a recurring process-level sweep.
 * Idempotent. Runtime gate: FLAGS.GOAL_LIVENESS_WATCHDOG (checked per tick).
 */
export function startGoalLivenessWatchdog(sql: Sql, opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? GOAL_LIVENESS_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'goal-liveness-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runGoalLivenessSweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[goal-liveness-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // D-004: 'timeout-reaper'. The trigger is ELAPSED TIME with no holder — a goal going
    // quiet emits nothing, and absence-over-a-deadline has no publisher to subscribe to.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
