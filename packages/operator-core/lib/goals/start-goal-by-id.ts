/**
 * start-goal-by-id.ts — ACTIVATE an existing goal: give it a live GOAL-mode
 * holder (work-on-everything-goal-2026-08-23 P-020, D-006).
 *
 * The third start shape. `goals:start` (the tool) and `autoStartGoal` (the
 * Blender rail) both CREATE a goal and spawn its first holder in one call.
 * This one takes a goal that ALREADY EXISTS — filed as a stub, deactivated,
 * or simply never picked up — and starts an agent to pursue it. It is the
 * shared activation core for every machine leg P-020 adds:
 *
 *   - the trigger binding-engine's `start-goal` action (a trigger fires →
 *     the goal it targets gets a holder),
 *   - the readiness watchdog's autoStart leg (a goal `became-ready` and its
 *     launch settings say autoStart → start it),
 *   - goal schedules (`system:goal-start` routine action).
 *
 * DELIBERATELY THIN — it composes primitives the holder-guarantee plan
 * (goal-live-holder-guarantee-2026-08-18) already shipped, rather than
 * re-extracting spawn code from `goals:start`:
 *
 *   launch — `launchGoalHolderSession` (goal-holder-launch-action.ts): the
 *            one existing-goal launch door; resolves the goal's own launch
 *            policy (budget/headcount refusals are HARD) and opens a tracked
 *            headless session through the same launch-su path the GUI uses.
 *   attach — `setMode` with `subject: goalId`, the SAME join `goals:start`
 *            and the goal-holder-respawner write. Launch FIRST, attach only
 *            the pre-pinned identity a successful launch returned — a failed
 *            launch can never leave a phantom holder row.
 *
 * THE IDEMPOTENCE GUARD (D-006) is what makes this safe to wire to triggers,
 * watchdogs and schedules — all of which re-fire:
 *
 *   - status !== 'active'  → refuse. A killed/achieved/paused goal is not
 *     silently resurrected by a stale trigger; reactivation is a deliberate
 *     owner act on the goal row, not a side effect of activation.
 *   - a LIVE holder        → refuse. Starting a held goal double-spawns.
 *   - holder liveness UNKNOWN → refuse. Degraded evidence is not absence
 *     (same rule as the respawner: unknown is non-actionable) — a re-fire
 *     retries once the oracle recovers.
 *
 * Refusals are RESULTS (`ok:false, reason`) because they are expected
 * outcomes a re-firing caller branches on; launch/attach failures THROW
 * because they mean the start should have happened and did not.
 *
 * READINESS is an activation gate here too (goal-dag-shared-substrate D-003):
 * this door is about to spawn an agent to pursue the goal RIGHT NOW, so
 * unsatisfied blocked-by prerequisites refuse — override with `startBlocked`
 * (+ reason) exactly like the sibling doors. The watchdog's autoStart leg
 * passes readiness by construction (it only fires on `became-ready`); the
 * trigger and schedule legs get the gate from here.
 */

import type { Sql } from 'postgres';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import { readGoalReadiness } from '@papercusp/agent-mcp/goal-deps';
import {
  launchGoalHolderSession,
  type GoalHolderLaunchInput,
  type GoalHolderLaunchResult,
} from '../harness/routines/goal-holder-launch-action';
import { resolveGoalHolders, type GoalHolders } from './holder';
import { setMode } from '../modes/store';

export interface StartGoalByIdInput {
  workspaceId: string;
  goalId: string;
  /** Who caused this start (a trigger binding, a schedule, a watchdog) — attribution, never authority. */
  launcherOwnerId?: string | null;
  /**
   * Acknowledge starting DESPITE unsatisfied blocked-by prerequisites — the
   * same override the sibling doors take. Without it an unready goal refuses.
   */
  startBlocked?: boolean;
  /** Why starting blocked is right — echoed on the result as the audit trail. */
  startBlockedReason?: string | null;
  /** Test/probe seam, forwarded to the launch door: record without spawning. */
  deferSpawn?: boolean;
}

export type StartGoalByIdRefusalReason =
  | 'not-found'
  | 'not-active'
  | 'no-harness'
  | 'already-held'
  | 'holder-unknown'
  | 'not-ready';

export type StartGoalByIdResult =
  | {
      ok: true;
      goalId: string;
      /** The pre-pinned coord identity of the spawned GOAL-mode holder. */
      ownerId: string;
      /** Fail-open policy reads and launch warnings, never swallowed. */
      warnings: string[];
      /** Non-null ONLY when the caller overrode the readiness gate. */
      startBlockedOverride: string | null;
    }
  | { ok: false; reason: StartGoalByIdRefusalReason; detail: string };

export interface StartGoalByIdDeps {
  launch: (input: GoalHolderLaunchInput) => Promise<GoalHolderLaunchResult>;
  resolveHolders: (sql: Sql, opts: { workspaceId: string; goalId: string }) => Promise<GoalHolders>;
  readReadiness: (
    sql: Sql,
    workspaceId: string,
    goalId: string,
  ) => ReturnType<typeof readGoalReadiness>;
  /** The holder-row attachment — wraps `setMode` in production. */
  attach: (opts: {
    sql: Sql;
    workspaceId: string;
    goalId: string;
    ownerId: string;
    goalTitle: string;
    setBy: string;
  }) => Promise<{ ok: boolean; error?: string | null }>;
}

const DEFAULT_DEPS: StartGoalByIdDeps = {
  launch: launchGoalHolderSession,
  resolveHolders: resolveGoalHolders,
  // The structural GoalSqlTag/Sql mismatch is bridged HERE, once — the same
  // cast goal-auto-start.ts makes at its call site (postgres' PendingQuery is
  // Promise-like but the generic signatures are not mutually assignable).
  readReadiness: (sql, workspaceId, goalId) =>
    readGoalReadiness(sql as unknown as GoalSqlTag, workspaceId, goalId),
  attach: async ({ sql, workspaceId, goalId, ownerId, goalTitle, setBy }) => {
    const result = await setMode({
      workspaceId,
      ownerId,
      modeId: 'goal',
      enabled: true,
      reason: `activated goal ${goalId} — ${goalTitle.slice(0, 120)}`,
      setBy,
      ownerDirected: false,
      subject: goalId,
      sql,
    });
    return {
      ok: result.ok,
      error: !result.ok && 'error' in result ? (result.error ?? null) : null,
    };
  },
};

/**
 * Start a holder for one existing goal. See the header for the guard and
 * refuse-vs-throw contract.
 */
export async function startGoalById(
  sql: Sql,
  input: StartGoalByIdInput,
  deps: StartGoalByIdDeps = DEFAULT_DEPS,
): Promise<StartGoalByIdResult> {
  const workspaceId = input.workspaceId?.trim();
  const goalId = input.goalId?.trim();
  if (!workspaceId) throw new Error('startGoalById requires workspaceId');
  if (!goalId) throw new Error('startGoalById requires goalId');

  // ── the goal row ────────────────────────────────────────────────────────
  const rows = await sql<
    { id: string; title: string; status: string; install_slug: string | null }[]
  >`
    SELECT id, title, status, install_slug
      FROM harness_shared.goals
     WHERE workspace_id = ${workspaceId} AND id = ${goalId}`;
  const goal = rows[0];
  if (!goal) {
    return { ok: false, reason: 'not-found', detail: `no goal '${goalId}' in workspace ${workspaceId}` };
  }
  if (goal.status !== 'active') {
    return {
      ok: false,
      reason: 'not-active',
      detail:
        `goal '${goalId}' is '${goal.status}', not 'active' — activation never resurrects a ` +
        `killed/achieved/paused goal; change the goal's status deliberately first`,
    };
  }
  const harnessSlug = goal.install_slug?.trim();
  if (!harnessSlug) {
    return {
      ok: false,
      reason: 'no-harness',
      detail: `goal '${goalId}' has no install_slug — a holder cannot be launched without a harness`,
    };
  }

  // ── the idempotence guard: who holds it right now ───────────────────────
  const holders = await deps.resolveHolders(sql, { workspaceId, goalId });
  if (holders.liveness === 'held') {
    const live = holders.live[0]?.ownerId ?? 'unknown owner';
    return {
      ok: false,
      reason: 'already-held',
      detail: `goal '${goalId}' already has a live holder (${live}) — starting again would double-spawn`,
    };
  }
  if (holders.liveness === 'unknown') {
    return {
      ok: false,
      reason: 'holder-unknown',
      detail:
        `goal '${goalId}' holder liveness is UNKNOWN (degraded evidence, not absence) — ` +
        `refusing to spawn against a possibly-live holder; retry when the liveness oracle recovers`,
    };
  }

  // ── the readiness gate (activation, never dispatch — D-003) ─────────────
  let startBlockedOverride: string | null = null;
  const readiness = await deps.readReadiness(sql, workspaceId, goalId);
  if (!readiness.actionable) {
    const unsatisfied = readiness.blockers
      .filter((b) => b.verdict !== 'satisfied')
      .map((b) => `${b.ref} (${b.kind}/${b.status ?? 'absent'}/${b.verdict})`)
      .join(', ');
    if (!input.startBlocked) {
      return {
        ok: false,
        reason: 'not-ready',
        detail:
          `goal '${goalId}' has unsatisfied blocker(s): ${unsatisfied}. Nothing was spawned. ` +
          `Pass startBlocked: true (+ startBlockedReason) if starting blocked is deliberate.`,
      };
    }
    startBlockedOverride =
      input.startBlockedReason?.trim() || `started despite unsatisfied blocker(s): ${unsatisfied}`;
  }

  // ── launch, then attach (launch failures throw from the launch door) ────
  const launched = await deps.launch({
    workspaceId,
    goalId,
    harnessSlug,
    launcherOwnerId: input.launcherOwnerId ?? null,
    deferSpawn: input.deferSpawn ?? false,
  });

  const attach = await deps.attach({
    sql,
    workspaceId,
    goalId,
    ownerId: launched.ownerId,
    goalTitle: goal.title,
    setBy: input.launcherOwnerId ?? 'goal-start-by-id',
  });
  if (!attach.ok) {
    // The spawn is irreversible; the holder row is what failed. Name the
    // orphan identity so the caller (or the watchdog's next sweep, which will
    // read this goal as holderless) can attach or reap it — never swallow it.
    throw new Error(
      `goal '${goalId}' agent launched (ownerId ${launched.ownerId}) but the GOAL-mode ` +
        `attachment failed (${attach.error ?? 'mode store refused'}) — ` +
        `the session is up without a holder row; attach it or let the liveness watchdog report it`,
    );
  }

  return {
    ok: true,
    goalId,
    ownerId: launched.ownerId,
    warnings: launched.warnings,
    startBlockedOverride,
  };
}
