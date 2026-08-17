/**
 * goal-owner-report-watchdog (P-009 of goal-mode-design-intent-hardening-2026-08-16) —
 * nudge a goal-mode owner whose ACTIVE goal has gone report-silent past the cadence
 * floor, ONCE per silence, with the report skeleton the GOAL contract demands.
 *
 * THE BUG THIS CLOSES, measured (WI-39348, 2026-08-16): the graded run reported
 * exemplarily for 2.5h, then went silent for 5h — INCLUDING at goal-met. The GOAL
 * contract's reporting clause ("REPORT on a standing cadence via coord:escalate /
 * notifyAttention: what moved, what it cost, what is owner-walled, and what you
 * killed") is prose, and prose did not hold; this instrument replaces it (D-001:
 * structural > detector > prose — this is the detector tier, with the D-016 floor
 * discipline below keeping it from decaying into decoration).
 *
 * THE INSTRUMENT reads the same rails the contract names, so a compliant owner is
 * never nagged and no self-report is trusted:
 *  - `coord_event_log` surface='escalations' rows whose body `from` is the owner —
 *    coord:escalate is the contract's primary reporting rail, and openEscalation
 *    stamps the raising identity server-side;
 *  - `attention_notifications` rows whose `data` names this goal or this owner —
 *    the notifyAttention rail records no author column (WI-36644 made it an audit
 *    trail, not an attribution surface), so attribution rides on the payload when
 *    the call site provided it. This leg can only SUPPRESS an alarm, so a call
 *    site that omitted the ids degrades toward a (deduped) nudge, never a miss.
 * A report by any OTHER channel (a coord:send the owner chose instead) is not
 * measured — the nudge teaches the contract's rail rather than chasing every
 * channel an agent might improvise on.
 *
 * EXACTLY ONE CLASSIFIER SPEAKS PER GOAL (the family rule): this one fires ONLY on
 * a goal whose owner is POSITIVELY alive. A dead / unresolved owner is
 * goal-liveness-watchdog's territory — nudging a corpse is noise, and the
 * conservative rule (a degraded read suppresses, never false-alarms) applies to the
 * liveness read exactly as it does in the drain-fleet sibling.
 *
 * ONE NUDGE PER SILENCE, structurally: the escalation of record is PG-deduped per
 * (workspace, goal, owner), and the directed wake fires only when that escalation
 * was NEWLY OPENED — a coalesced repeat keeps the record's repeatCount honest
 * without re-waking the owner every tick. A new report moves the reference
 * timestamp, the overdue condition clears, and the next silence opens a fresh cycle
 * once the previous escalation resolves.
 *
 * D-016 (unified-agent-state-plane-2026-07-27): "a detector without a floor is
 * prose exhortation in a costume" — and a floor with no consequence is how the
 * feature quietly dies. The cadence floor below therefore carries its measured
 * WHY and a REVIEW-BY date; the guard suite fails once that date passes, forcing
 * the number to be re-litigated against fresh evidence instead of fossilizing.
 *
 * Runtime gate: FLAGS.GOAL_OWNER_REPORT_WATCHDOG (default ON; kill-switch at
 * /admin/features), checked per tick like its siblings.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  resolveSessionStates,
  type LivenessVerdict,
} from '../agent-tools/coordination/liveness-oracle';
import { holderCountsAsAlive } from './goal-liveness-watchdog';

/** Hours-scale detection needs no seconds-scale sweep: one tick per 10 minutes
 *  bounds the worst-case detection lag to ~4% of the floor. */
export const GOAL_OWNER_REPORT_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * THE CADENCE FLOOR (D-016): silence longer than this is overdue.
 *
 * Why 4 hours — the measured basis (WI-39348, the run this plan hardens against):
 * healthy operation reported at a ≤2.5h cadence; the failure was a 5h silence that
 * swallowed goal-met itself. 4h sits strictly ABOVE the measured healthy cadence
 * (a compliant owner is never nagged) and strictly BELOW the measured failure
 * (the observed silence would have been caught an hour before it ended). The
 * guard suite pins both inequalities, so a future retune that breaks either
 * relation has to bring new measurements, not a mood.
 */
export const GOAL_OWNER_REPORT_MAX_SILENCE_MS = 4 * 3600_000;

/** The measured healthy cadence (ms) the floor must stay ABOVE — see the floor's
 *  doc. Exported so the guard test pins the relation, not a copied number. */
export const GOAL_OWNER_REPORT_MEASURED_HEALTHY_CADENCE_MS = 2.5 * 3600_000;

/** The measured failure silence (ms) the floor must stay AT-OR-BELOW. */
export const GOAL_OWNER_REPORT_MEASURED_FAILURE_SILENCE_MS = 5 * 3600_000;

/**
 * D-016's consequence clause: past this date the guard suite FAILS until whoever
 * finds it re-litigates the 4h floor against current evidence (rubric trends,
 * scorecard cadence data) and bumps this date with an updated WHY above. A floor
 * that can never demand review is a comment.
 */
export const GOAL_OWNER_REPORT_REVIEW_BY = '2026-09-17';

/** True when `reviewBy` (an ISO date) is strictly before `now`. Exported for the
 *  guard test so the comparison the test runs is the one shipped here. */
export function isPastReportFloorReview(reviewBy: string, now: Date): boolean {
  const t = Date.parse(reviewBy);
  if (Number.isNaN(t)) return true; // an unparseable date must fail review, not skate
  return t < now.getTime();
}

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'goal-owner-report-watchdog',
  ownerLabel: 'system · goal owner reports',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One goal-mode registration on an ACTIVE goal, with its report timestamps. */
export interface GoalOwnerReportRowLike {
  workspaceId: string;
  goalId: string;
  /** The goal-mode owner (agent_modes.owner_id). */
  agentId: string;
  /** Grace baseline: GREATEST(goal created_at, mode set_at) — no report is
   *  expected before the goal existed or before this owner took it on. */
  baselineTsMs: number;
  /** Newest report on either measured rail, or null when neither has one. */
  lastReportTsMs: number | null;
}

/** One overdue verdict. */
export interface GoalOwnerReportAlert {
  workspaceId: string;
  goalId: string;
  agentId: string;
  /** The timestamp silence is measured FROM (last report, floored at baseline). */
  referenceTsMs: number;
  silentMs: number;
}

/**
 * PURE: which owners are overdue. The reference point is the last report, but
 * never earlier than the baseline — a report that PREDATES this goal/mode
 * registration proves nothing about it, and a freshly-taken goal earns the full
 * grace window before its first nudge. Strictly-greater comparison: silence
 * exactly AT the floor is not yet past it.
 */
export function findOverdueReports(
  rows: readonly GoalOwnerReportRowLike[],
  nowMs: number,
  maxSilenceMs: number = GOAL_OWNER_REPORT_MAX_SILENCE_MS,
): GoalOwnerReportAlert[] {
  const out: GoalOwnerReportAlert[] = [];
  for (const row of rows) {
    const referenceTsMs = Math.max(row.baselineTsMs, row.lastReportTsMs ?? row.baselineTsMs);
    const silentMs = nowMs - referenceTsMs;
    if (silentMs > maxSilenceMs) {
      out.push({
        workspaceId: row.workspaceId,
        goalId: row.goalId,
        agentId: row.agentId,
        referenceTsMs,
        silentMs,
      });
    }
  }
  return out;
}

/** The contract's report shape, handed to the owner as a fill-in skeleton rather
 *  than a bare scold — the four fields are the GOAL contract's own list. */
export function buildReportSkeleton(alert: GoalOwnerReportAlert): Record<string, string> {
  return {
    channel:
      "coord:escalate (or notifyAttention with { goalId } in data) — the GOAL contract's standing-cadence rail",
    whatMoved: `<plans / fleets / work-items that advanced for goal '${alert.goalId}', with ids>`,
    whatItCost:
      '<measured spend: goals:pots rollup vs the declared ceiling — never an invented spentCents (D-003)>',
    ownerWalled: '<queued owner asks: app-store, payments, domains, real spend, approvals>',
    whatYouKilled: '<pots/fleets killed or wound down, each with the criterion that tripped>',
  };
}

export interface GoalOwnerReportSweepDeps {
  /** Every goal-mode registration on an ACTIVE goal, with report timestamps. */
  readGoalModeOwners: () => Promise<GoalOwnerReportRowLike[]>;
  /** Shared liveness oracle — positive-alive gates an alert; missing = unknown = suppress. */
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, LivenessVerdict>>;
  /** Open/coalesce the escalation of record; `coalesced` gates the nudge. */
  escalate: (alert: GoalOwnerReportAlert) => Promise<{ coalesced: boolean }>;
  /** Directed wake of the owner with the report skeleton — fired ONCE per silence. */
  nudge: (alert: GoalOwnerReportAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_OWNER_REPORT_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

function makeReadGoalModeOwners(sql: Sql): GoalOwnerReportSweepDeps['readGoalModeOwners'] {
  return async () => {
    // Population first (goal-mode rows on ACTIVE goals — measured base rate is
    // single-digit owners), then one LATERAL per rail per row. The escalations
    // scan rides the (workspace_id, surface, msg_id) unique index's leading
    // columns; the body->>'from' filter is a heap check over that already-small
    // subset, which a 10-minute cadence absorbs comfortably. GREATEST ignores
    // NULLs in Postgres, so a rail with no rows simply drops out.
    const rows = await sql<
      {
        workspace_id: string;
        goal_id: string;
        owner_id: string;
        baseline_ts_ms: string;
        last_report_ts_ms: string | null;
      }[]
    >`
      SELECT m.workspace_id,
             m.subject AS goal_id,
             m.owner_id,
             (extract(epoch FROM GREATEST(g.created_at, m.set_at)) * 1000)::bigint AS baseline_ts_ms,
             (extract(epoch FROM GREATEST(er.last_escalation_ts, an.last_attention_ts)) * 1000)::bigint AS last_report_ts_ms
        FROM harness_shared.agent_modes m
        JOIN harness_shared.goals g
          ON g.id = m.subject AND g.workspace_id = m.workspace_id AND g.status = 'active'
        LEFT JOIN LATERAL (
          SELECT max(e.ts) AS last_escalation_ts
            FROM harness_shared.coord_event_log e
           WHERE e.workspace_id = m.workspace_id
             AND e.surface = 'escalations'
             AND e.body->>'from' = m.owner_id
        ) er ON true
        LEFT JOIN LATERAL (
          SELECT max(a.created_at) AS last_attention_ts
            FROM harness_shared.attention_notifications a
           WHERE a.workspace_id = m.workspace_id
             AND (a.data->>'goalId' = m.subject OR a.data->>'ownerId' = m.owner_id)
        ) an ON true
       WHERE m.mode = 'goal' AND m.subject IS NOT NULL`;
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      goalId: r.goal_id,
      agentId: r.owner_id,
      baselineTsMs: Number(r.baseline_ts_ms),
      lastReportTsMs: r.last_report_ts_ms === null ? null : Number(r.last_report_ts_ms),
    }));
  };
}

function makeResolveLiveness(): GoalOwnerReportSweepDeps['resolveLiveness'] {
  return async (ownerIds) =>
    resolveSessionStates(
      ownerIds.map((ownerId) => ({ ownerId })),
      { hydratePerId: true, selfWake: true },
    );
}

async function defaultEscalate(alert: GoalOwnerReportAlert): Promise<{ coalesced: boolean }> {
  const silentHours = Math.round((alert.silentMs / 3600_000) * 10) / 10;
  const result = await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal-mode owner ${alert.agentId} is report-silent on active goal '${alert.goalId}' — ` +
      `past the cadence floor with no coord:escalate / notifyAttention report`,
    body:
      `Session ${alert.agentId}, registered in GOAL mode on active goal '${alert.goalId}' ` +
      `(workspace ${alert.workspaceId}), has produced no owner report for ~${silentHours}h ` +
      `(floor: ${GOAL_OWNER_REPORT_MAX_SILENCE_MS / 3600_000}h; last reference ` +
      `${new Date(alert.referenceTsMs).toISOString()}).\n\n` +
      `The GOAL contract's reporting clause: "REPORT on a standing cadence via ` +
      `coord:escalate / notifyAttention: what moved, what it cost, what is owner-walled, ` +
      `and what you killed. Without it the owner learns goal state only by asking." The ` +
      `measured failure this instrument closes (WI-39348): exemplary reporting for 2.5h, ` +
      `then 5h of silence including at goal-met.\n\n` +
      `Remedy (subject ${alert.agentId}): send the report now on the contract's rail — ` +
      `the directed wake accompanying this escalation carries the skeleton. A report on ` +
      `either measured rail clears the condition; this escalation coalesces (never ` +
      `re-wakes) until then.`,
    meta: {
      // WI-7353: the signature carries NO duration or timestamp — one silence,
      // one row, however many ticks observe it.
      dedupKind: 'goal-owner-report-overdue',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:${alert.agentId}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      subjectAgentId: alert.agentId,
      referenceTs: new Date(alert.referenceTsMs).toISOString(),
      silentMs: alert.silentMs,
    },
  });
  return { coalesced: Boolean((result as { coalesced?: boolean } | null)?.coalesced) };
}

async function defaultNudge(alert: GoalOwnerReportAlert): Promise<void> {
  const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
  const silentHours = Math.round((alert.silentMs / 3600_000) * 10) / 10;
  await wakeRecipients([alert.agentId], {
    summary:
      `goal-owner-report: goal '${alert.goalId}' has had no owner report for ~${silentHours}h — ` +
      `send one now (skeleton in payload): what moved, what it cost, what is owner-walled, what you killed`,
    payload: {
      goalId: alert.goalId,
      agentId: alert.agentId,
      silentMs: alert.silentMs,
      referenceTs: new Date(alert.referenceTsMs).toISOString(),
      reportSkeleton: buildReportSkeleton(alert),
    },
    source: 'goal-owner-report-watchdog',
    workspaceId: alert.workspaceId,
  });
}

function sweepDeps(sql: Sql, overrides: Partial<GoalOwnerReportSweepDeps>): GoalOwnerReportSweepDeps {
  return {
    readGoalModeOwners: makeReadGoalModeOwners(sql),
    resolveLiveness: makeResolveLiveness(),
    escalate: defaultEscalate,
    nudge: defaultNudge,
    flagEnabled: defaultFlagEnabled,
    ...overrides,
  };
}

/**
 * One sweep. Per-alert containment like the family; the nudge is gated on the
 * escalation being NEWLY opened (one nudge per silence), so an escalate failure
 * skips the nudge for this tick — the deduped retry next tick is the recovery
 * path, and under-nudging beats a nag loop.
 */
export async function runGoalOwnerReportSweepOnce(
  sql: Sql,
  overrides: Partial<GoalOwnerReportSweepDeps> = {},
): Promise<{ scanned: number; overdue: number; nudged: number; skipped: boolean }> {
  const deps = sweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) {
    return { scanned: 0, overdue: 0, nudged: 0, skipped: true };
  }

  const rows = await deps.readGoalModeOwners();
  const candidates = findOverdueReports(rows, Date.now());
  let nudged = 0;
  if (candidates.length === 0) {
    return { scanned: rows.length, overdue: 0, nudged, skipped: false };
  }

  // The liveness gate — a degraded oracle read suppresses EVERY alert this tick
  // (unknown is not dead, and it is definitely not "nudge it"): the sibling rule.
  let verdicts: Map<string, LivenessVerdict>;
  try {
    verdicts = await deps.resolveLiveness([...new Set(candidates.map((a) => a.agentId))]);
  } catch {
    return { scanned: rows.length, overdue: candidates.length, nudged, skipped: false };
  }

  const alerts = candidates.filter((a) => {
    const v = verdicts.get(a.agentId);
    return v ? holderCountsAsAlive(v) : false;
  });

  for (const alert of alerts) {
    let opened = false;
    try {
      const { coalesced } = await deps.escalate(alert);
      opened = !coalesced;
    } catch (e) {
      console.warn(
        `[goal-owner-report-watchdog] escalate failed for ${alert.goalId}/${alert.agentId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!opened) continue; // coalesced repeat (or failed open): the one nudge already went out (or waits for the retry)
    try {
      await deps.nudge(alert);
      nudged += 1;
    } catch (e) {
      console.warn(
        `[goal-owner-report-watchdog] nudge failed for ${alert.goalId}/${alert.agentId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { scanned: rows.length, overdue: alerts.length, nudged, skipped: false };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the goal owner-report watchdog: a recurring process-level sweep. Idempotent.
 * Runtime gate: FLAGS.GOAL_OWNER_REPORT_WATCHDOG (checked per tick).
 */
export function startGoalOwnerReportWatchdog(sql: Sql, opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? GOAL_OWNER_REPORT_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'goal-owner-report-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runGoalOwnerReportSweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[goal-owner-report-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // 'timeout-reaper' like its goal-watchdog siblings: no event fires when a
    // report DOESN'T happen — absence is only observable by a timed sweep.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
