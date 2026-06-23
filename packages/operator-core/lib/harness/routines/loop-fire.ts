/**
 * Loop fire — a loop routine's fire ACTION (loop-routines-interval-recurrence-2026-06-20
 * P-004 / D-005 / D-006, B-LOOP-3). Carved out of `dbos/routines-workflow.ts` so the fire
 * semantics are testable without importing the DBOS workflow module.
 *
 * A "loop" (su-d5a84's B-LOOP-1 third recurrence kind: `reschedule_interval_sec` set, no
 * cron/rrule, bound to a `target_owner_id`) does NOT spawn a role or run a system action when
 * it fires. It delivers a WARM `coord` wake to its pinned su session — the same session/
 * context continues across iterations (behave like Claude /loop, but engine-tracked). The
 * wake rides the SHIPPED wake-executor liveness ladder (await-event-primitive-2026-06-05
 * P-004): alive+injectable → inject the wake turn; exited → `claude --resume <sid>`; alive-
 * but-uninjectable → park → resume when the pid dies. The loop owns NO resume code (D-005) —
 * `wakeRecipients` fires the recipient's own `coord:inbox-wake:<ownerId>` key and the executor
 * picks the channel. Transcript growth across iterations is the agent harness's job (native
 * compaction), not the loop's.
 *
 * Two guardrails gate the fire (D-006): the EXISTING failure-streak fire-gate (`checkFireGate`,
 * keyed per-loop by the routine name) and the new COST cap (`checkLoopCostCap`). Tracking
 * otherwise piggybacks on the existing layers — routine fire-history (`recordFire`) + the
 * work-queue (the kickoff tells the agent to create + self-assign its work_items) + plan
 * progress — so no per-fire plan_run is minted (D-006).
 *
 * The completion-rebase that re-arms the parked loop after its turn settles is su-15ea2's
 * B-LOOP-2 (`reconcile-loop-routines.ts`), wired into `reconcileAndGovern`; this module only
 * delivers the fire.
 */
import type { Sql } from 'postgres';
import { checkFireGate as defaultCheckFireGate, recordFire as defaultRecordFire } from '../../autoloop';
import { wakeRecipients as defaultWakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import { checkLoopCostCap as defaultCheckLoopCostCap } from './loop-cost-cap';
import {
  checkLoopDeadMan as defaultCheckLoopDeadMan,
  incrementLoopFireCount as defaultIncrementLoopFireCount,
} from './loop-dead-man';

/** The wake-turn text delivered when the loop's row carries no explicit kickoff. Mirrors the
 *  D-006 / B-LOOP-5 convention: each wake, create + SELF-ASSIGN this iteration's work_items
 *  (so the loop's work rides the work-queue / fleet:assignments), work them, then end the turn
 *  (the loop re-arms `interval` sec after the turn settles). */
export function defaultLoopKickoff(routineId: string): string {
  return (
    `Loop '${routineId}' fired. Continue working your plan for this iteration: create + ` +
    `self-assign your work_items (work_items:create { assign_to: <your ownerId> }), work them ` +
    `and set_state as you go, update plan progress, then end your turn — the loop re-arms after ` +
    `it settles.`
  );
}

export interface LoopFireInput {
  routineId: string;
  /** The fire-gate role key — the routine NAME gives per-loop failure-streak tracking + a
   *  readable autoloop:status row. */
  routineName: string;
  workspaceId: string;
  installSlug: string;
  /** The pinned session's coord ownerId the warm wake targets (su-d5a84's target_owner_id). */
  targetOwnerId: string;
  /** The routine's payload_template — carries the loop's `kickoff` (wake-turn text) +
   *  optional `costCapCents` (the cost-cap). */
  payloadTemplate: Record<string, unknown> | null;
  /** Seam for the cost-cap's DB reads/writes (defaults to the admin pool). */
  sql?: Sql;
}

export interface LoopFireDeps {
  checkFireGate?: typeof defaultCheckFireGate;
  recordFire?: typeof defaultRecordFire;
  wake?: typeof defaultWakeRecipients;
  costCap?: typeof defaultCheckLoopCostCap;
  deadMan?: typeof defaultCheckLoopDeadMan;
  incrementFireCount?: typeof defaultIncrementLoopFireCount;
}

export interface LoopFireResult {
  fired: boolean;
  /** Why a fire was withheld (when fired=false). */
  reason?: 'no-target' | 'fire-gate' | 'cost-cap';
  woken?: number;
  staged?: number;
  detail?: string;
}

/** Read the loop kickoff (wake-turn text) from the routine's payload_template, if any. */
export function readLoopKickoff(payloadTemplate: Record<string, unknown> | null): string | undefined {
  const k = payloadTemplate?.kickoff;
  return typeof k === 'string' && k.trim() ? k : undefined;
}

/** Read the loop cost-cap (cents) from the routine's payload_template, if a positive number. */
export function readLoopCostCapCents(payloadTemplate: Record<string, unknown> | null): number | null {
  const c = payloadTemplate?.costCapCents;
  return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : null;
}

/**
 * Fire one loop iteration: gate (failure-streak → cost-cap) then deliver the warm coord wake.
 * Never throws — every failure is a result (the routine engine's fire path is fail-soft; a
 * lost fire is re-armed by the completion-rebase / the next interval).
 */
export async function fireLoopWake(input: LoopFireInput, deps: LoopFireDeps = {}): Promise<LoopFireResult> {
  const checkFireGate = deps.checkFireGate ?? defaultCheckFireGate;
  const recordFire = deps.recordFire ?? defaultRecordFire;
  const wake = deps.wake ?? defaultWakeRecipients;
  const costCap = deps.costCap ?? defaultCheckLoopCostCap;

  if (!input.targetOwnerId) {
    return { fired: false, reason: 'no-target', detail: 'loop routine has no target_owner_id to wake' };
  }

  // Guard 1 — failure-streak fire-gate (the existing autoloop backoff/circuit, per-loop).
  const gate = await checkFireGate(input.installSlug, input.routineName);
  if (!gate.allow) {
    return {
      fired: false,
      reason: 'fire-gate',
      detail: `${gate.reason} (consecutive_errors=${gate.consecutiveErrors}, retry in ~${gate.retryAfterSec}s)`,
    };
  }

  // Guard 2 — cost-cap (D-006's one net-new loop guardrail): auto-pause on cumulative breach.
  const capCents = readLoopCostCapCents(input.payloadTemplate);
  if (capCents != null) {
    const c = await costCap({
      sql: input.sql,
      routineId: input.routineId,
      targetOwnerId: input.targetOwnerId,
      capCents,
    });
    if (c.breach) {
      // The breach already auto-paused the routine; record it as a fire-path error so it is
      // visible in autoloop:status / fire history, and withhold the wake.
      await recordFire(input.installSlug, input.routineName, `cost-cap ${c.spendCents}¢>${c.capCents}¢`, 'error').catch(
        () => {},
      );
      return {
        fired: false,
        reason: 'cost-cap',
        detail: `cumulative spend ${c.spendCents}¢ exceeded cap ${c.capCents}¢ — loop auto-paused`,
      };
    }
  }

  // Fire — the WARM coord wake. `wakeRecipients` fires `coord:inbox-wake:<targetOwnerId>` and
  // rides the wake-executor liveness ladder (inject-if-live / `--resume`-if-exited); the loop
  // adds NO resume code (D-005). Pre-record the attempt (preserves the streak counter), then
  // record the outcome.
  await recordFire(input.installSlug, input.routineName, 'firing', 'attempt').catch(() => {});
  const kickoff = readLoopKickoff(input.payloadTemplate) ?? defaultLoopKickoff(input.routineId);
  const fan = await wake([input.targetOwnerId], {
    summary: kickoff,
    source: `loop:${input.routineId}`,
    workspaceId: input.workspaceId,
  });

  // The enqueue is recorded as `attempt`, NOT `ok` (loop-wake-rate-limit-robustness P0b):
  // a queued wake is NOT yet a survived turn. The old `ok`-on-enqueue reset the failure
  // streak the instant a delivery was queued, so a wake whose detached resume turn later
  // 429'd-and-died kept consecutive_errors oscillating 0→1→0 and never opened the circuit.
  // The TURN OUTCOME now owns ok/error: reconcile-loop-routines records `ok` when it sees
  // the turn's completion marker, and the resume-turn-outcome handler / stuck-park backstop
  // record `error` on a death. The enqueue just refreshes last_status (counter PRESERVED).
  const reached = (fan.woken ?? 0) > 0 || (fan.staged ?? 0) > 0;
  await recordFire(
    input.installSlug,
    input.routineName,
    reached ? 'queued' : 'no-session-now',
    'attempt',
  ).catch(() => {});

  return { fired: true, woken: fan.woken, staged: fan.staged };
}
