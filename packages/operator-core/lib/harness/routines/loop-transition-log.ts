/**
 * Append-only engine-loop transition log — EI-19411045952024591.
 *
 * WHY THIS EXISTS
 * On 2026-08-03 five live fleet members stopped receiving loop fires for ~45min. Both
 * candidate root causes were refuted with primary evidence, and the investigation then
 * dead-ended — not for lack of effort, but because the fault is UNDIAGNOSABLE with the
 * state the system keeps. The two last-fire stores (`routines.last_fired_at` and
 * `harness_shared.autoloop_state`) are BOTH overwritten single-row state, so a loop that
 * parks and is never re-armed looks identical to one that fired and was swallowed.
 *
 * This records the transitions those single-row stores overwrite: `parked` (claimed and
 * parked at the 'infinity' in-flight sentinel), `rearmed` (moved back to a concrete fire
 * time), `disarmed` (deactivated). The diagnostic value is in the ABSENCE — a `parked`
 * row with no subsequent `rearmed` row IS the fault, and `actor` names the last code path
 * that touched the routine.
 *
 * INVARIANT: this is EVIDENCE, never an input to scheduling. Nothing in the fire path may
 * read it, and a write failure here must never perturb the path it reports on — the whole
 * point is an instrument that cannot break the thing it measures. Every write is
 * fire-and-forget and swallows its own errors.
 */
import type { Sql } from 'postgres';
import os from 'node:os';

/** The loop lifecycle transitions worth a durable row. */
export type LoopTransitionEvent = 'parked' | 'rearmed' | 'disarmed';

export interface LoopTransitionInput {
  workspaceId: string;
  installSlug: string;
  routineId: string;
  routineName?: string | null;
  targetRole?: string | null;
  targetOwnerId?: string | null;
  event: LoopTransitionEvent;
  /** The code path making the transition, e.g. 'claim-due-routine'. */
  actor: string;
  /**
   * The next_fire_at this transition WROTE. Pass the literal string 'infinity' for a park
   * (postgres-js binds it straight into timestamptz), an ISO instant for a re-arm, or null
   * for a disarm.
   */
  newNextFireAt?: string | null;
  intervalSec?: number | null;
  detail?: Record<string, unknown> | null;
}

/**
 * How long a transition row is retained. A loop cycle writes 2 rows (park + re-arm), so a
 * ~20-loop fleet at mixed intervals produces low tens of thousands of rows/day — cheap to
 * keep for a forensic window, pointless to keep forever. Env-overridable, floored at 1 day
 * so a misconfigured value can never disable the very evidence this table exists to hold.
 */
export function transitionRetentionDays(): number {
  const n = Number(process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS ?? 7);
  return Number.isFinite(n) && n >= 1 ? n : 7;
}

/** Throttle gate for the piggybacked prune — same shape as autoloop's maybePruneStaleFireState. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAtMs = 0;

/** Test seam: reset the prune throttle so a test can observe the prune deterministically. */
export function __resetPruneThrottleForTest(): void {
  lastPruneAtMs = 0;
}

/**
 * Retire transition rows past the retention window. Piggybacked on the write path (the
 * established autoloop F6 hygiene pattern) so the table self-maintains WITHOUT adding a
 * new scheduled routine — deliberately reusing that mechanism rather than introducing a
 * second one. Time-gated and fire-and-forget: adds no per-transition cost in the common
 * case and can never block or fail a transition.
 */
function maybePrune(sql: Sql, nowMs: number): void {
  if (nowMs - lastPruneAtMs < PRUNE_INTERVAL_MS) return;
  lastPruneAtMs = nowMs;
  const days = transitionRetentionDays();
  void (async () => {
    try {
      await sql`
        DELETE FROM harness_shared.routine_loop_transitions
         WHERE at < now() - ${`${days} days`}::interval
      `;
    } catch {
      // Hygiene only — a failed prune is never worth a log line on the fire path.
    }
  })();
}

/**
 * Append one loop transition. Fire-and-forget by construction: returns a promise that
 * always resolves, and callers on the hot fire path should NOT await it (see the two
 * call sites in claim.ts / reconcile-loop-routines.ts).
 */
export async function recordLoopTransition(sql: Sql, input: LoopTransitionInput): Promise<void> {
  try {
    await sql`
      INSERT INTO harness_shared.routine_loop_transitions
        (workspace_id, install_slug, routine_id, routine_name, target_role, target_owner_id,
         event, actor, new_next_fire_at, interval_sec, detail, host)
      VALUES (
        ${input.workspaceId},
        ${input.installSlug},
        ${input.routineId},
        ${input.routineName ?? null},
        ${input.targetRole ?? null},
        ${input.targetOwnerId ?? null},
        ${input.event},
        ${input.actor},
        ${input.newNextFireAt ?? null}::timestamptz,
        ${input.intervalSec ?? null},
        ${input.detail ? JSON.stringify(input.detail) : null}::jsonb,
        ${os.hostname()}
      )
    `;
    maybePrune(sql, Date.now());
  } catch (e) {
    // Fail-soft: the instrument must never break the fire path it measures. A missing
    // transition row degrades diagnosis; a thrown error here would degrade scheduling.
    console.warn(
      `[loop-transition-log] record failed (${input.event}/${input.actor}/${input.routineId}):`,
      e instanceof Error ? e.message : e,
    );
  }
}
