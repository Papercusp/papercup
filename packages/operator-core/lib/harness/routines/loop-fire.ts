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
 * B-LOOP-2 (`reconcile-loop-routines.ts`), wired as its own early `loop-rebase-sweep` step
 * in routinesTickImpl (Task-#8, 2026-07-03); this module only delivers the fire.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { checkFireGate as defaultCheckFireGate, recordFire as defaultRecordFire } from '../../autoloop';
import { wakeRecipients as defaultWakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import { checkLoopCostCap as defaultCheckLoopCostCap } from './loop-cost-cap';
import {
  checkLoopDeadMan as defaultCheckLoopDeadMan,
  incrementLoopFireCount as defaultIncrementLoopFireCount,
  readLoopFireCount as defaultReadLoopFireCount,
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
  /** su-cold-auto P-003: read the prior fire count for the cold wakeCount cadence. */
  readFireCount?: typeof defaultReadLoopFireCount;
  deactivateLoop?: (input: { sql?: Sql; installSlug: string; routineName: string }) => Promise<boolean>;
}

export interface LoopFireResult {
  fired: boolean;
  /** Why a fire was withheld (when fired=false). */
  reason?: 'no-target' | 'fire-gate' | 'cost-cap' | 'dead-man' | 'no-session-now';
  woken?: number;
  staged?: number;
  detail?: string;
}

async function defaultDeactivateLoop(input: {
  sql?: Sql;
  installSlug: string;
  routineName: string;
}): Promise<boolean> {
  const sql = input.sql ?? getOrgPg().sql;
  const result = await sql`
    UPDATE harness_shared.routines
       SET active = FALSE, updated_at = now()
     WHERE install_slug = ${input.installSlug}
       AND name = ${input.routineName}
       AND active = TRUE
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
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

/** Read the loop's carry MODE from payload_template (su-cold-auto-mode-2026-07-03 P-003).
 *  'cold' = the opt-in fresh-context cold-auto lifecycle — a cold fire stamps a
 *  {carry:'cold', wakeCount, harness} marker the wake-executor forks on (RESET-CONTEXT /
 *  RECYCLE). Anything else, INCLUDING absent, is today's WARM loop (no payload marker,
 *  byte-identical). The whole cold path is still dormant downstream until the P-007 master
 *  gate (coldAutoEnabled) is wired on in Phase 3 — this only stamps the marker. */
export function readLoopCarry(payloadTemplate: Record<string, unknown> | null): 'warm' | 'cold' {
  return payloadTemplate?.carry === 'cold' ? 'cold' : 'warm';
}

/** Read a positive-number dead-man bound (`maxFires` / `maxDurationSec`) from payload_template. */
export function readLoopPositiveBound(
  payloadTemplate: Record<string, unknown> | null,
  key: 'maxFires' | 'maxDurationSec',
): number | null {
  const v = payloadTemplate?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
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
  const deadMan = deps.deadMan ?? defaultCheckLoopDeadMan;
  const incrementFireCount = deps.incrementFireCount ?? defaultIncrementLoopFireCount;
  const readFireCount = deps.readFireCount ?? defaultReadLoopFireCount;
  const deactivateLoop = deps.deactivateLoop ?? defaultDeactivateLoop;

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

  // Guard 3 — the dead-man bound (loop-wake-rate-limit-robustness P2a): a runaway / forgotten /
  // permanently-dead loop auto-pauses when its total fires or wall-clock-since-arm crosses an
  // optional bound. Config rides payload_template (maxFires / maxDurationSec); no bound ⇒ no read.
  const maxFires = readLoopPositiveBound(input.payloadTemplate, 'maxFires');
  const maxDurationSec = readLoopPositiveBound(input.payloadTemplate, 'maxDurationSec');
  if (maxFires != null || maxDurationSec != null) {
    const dm = await deadMan({ sql: input.sql, routineId: input.routineId, maxFires, maxDurationSec });
    if (dm.breach) {
      // The breach auto-paused the routine; record it as a fire-path error so it is visible in
      // autoloop:status / fire history, and withhold the wake.
      await recordFire(input.installSlug, input.routineName, `dead-man ${dm.reason}`, 'error').catch(() => {});
      return { fired: false, reason: 'dead-man', detail: `dead-man guard tripped: ${dm.reason} — loop auto-paused` };
    }
  }

  // Fire — the WARM coord wake. `wakeRecipients` fires `coord:inbox-wake:<targetOwnerId>` and
  // rides the wake-executor liveness ladder (inject-if-live / `--resume`-if-exited); the loop
  // adds NO resume code (D-005). Pre-record the attempt (preserves the streak counter), then
  // record the outcome.
  await recordFire(input.installSlug, input.routineName, 'firing', 'attempt').catch(() => {});
  const kickoff = readLoopKickoff(input.payloadTemplate) ?? defaultLoopKickoff(input.routineId);

  // su-cold-auto P-003: a COLD loop stamps a marker on the wake DELIVERY so the wake-executor
  // forks to a fresh-context RESET / periodic RECYCLE instead of the warm in-place turn.
  // wakeCount = this fire's 1-based number (priorFires + 1) → the consumer HYBRID cadence
  // recycles every Nth wake; `harness` (the loop's install_slug) is the carry-note scope key.
  // A WARM loop stamps NO payload → byte-identical to today (the whole path is also dormant
  // downstream until the P-007 gate is wired on in Phase 3). Fail-soft: a fire-count read miss
  // ⇒ wakeCount 1 (a RESET), never a throw.
  const carry = readLoopCarry(input.payloadTemplate);
  let coldPayload: { carry: 'cold'; wakeCount: number; harness: string } | undefined;
  if (carry === 'cold') {
    const priorFires = await readFireCount(input.sql, input.routineId).catch(() => 0);
    coldPayload = { carry: 'cold', wakeCount: priorFires + 1, harness: input.installSlug };
  }

  const fan = await wake([input.targetOwnerId], {
    summary: kickoff,
    ...(coldPayload ? { payload: coldPayload } : {}),
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
  if (!reached) {
    const deactivated = await deactivateLoop({
      sql: input.sql,
      installSlug: input.installSlug,
      routineName: input.routineName,
    }).catch(() => false);
    await recordFire(
      input.installSlug,
      input.routineName,
      deactivated ? 'no-session-now:auto-ended' : 'no-session-now',
      'error',
    ).catch(() => {});
    return {
      fired: false,
      reason: 'no-session-now',
      woken: fan.woken,
      staged: fan.staged,
      detail: deactivated
        ? 'loop auto-ended: pinned warm session is no longer wakeable/resumable'
        : 'pinned warm session is no longer wakeable/resumable',
    };
  }
  await recordFire(
    input.installSlug,
    input.routineName,
    'queued',
    'attempt',
  ).catch(() => {});

  // P2a: bump the live fire counter so the dead-man `maxFires` bound can read it on the next
  // fire. Also bumped for a COLD loop (su-cold-auto P-003) so the cold wakeCount cadence
  // advances monotonically across delivered wakes. Only incremented after a REACHED fire, so a
  // non-delivered wake never consumes a wakeCount slot. Best-effort; single-flight per loop.
  if (maxFires != null || carry === 'cold') {
    await incrementFireCount(input.sql ?? undefined, input.routineId).catch(() => {});
  }

  return { fired: true, woken: fan.woken, staged: fan.staged };
}
