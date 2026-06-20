/**
 * The routine-claim primitive — carved out of `dbos/routines-workflow.ts` so the
 * claim semantics are testable without importing the DBOS workflow module (which
 * registers workflows + system actions at load).
 *
 * Atomically claim a due routine: advance `next_fire_at` to its next cron time
 * ONLY if it is still active + due. The `WHERE active AND (next_fire_at IS NULL
 * OR next_fire_at <= now())` guard means exactly one racing tick wins the claim;
 * a loser sees zero rows updated and skips.
 *
 * A cron-kind routine with neither a cron nor an rrule expression is a ONE-SHOT (a self-declared
 * wake at an explicit `next_fire_at` — the pot's `pot-wake` routine,
 * autoloop-pot-operator-rebuild D-002): claiming it DEACTIVATES it. Setting
 * `next_fire_at = NULL` while leaving it active would make it due again on the
 * very next tick — an infinite refire loop.
 *
 * A LOOP (loop-routines-interval-recurrence-2026-06-20 P-003) is the THIRD recurrence
 * kind: it has NEITHER a cron NOR an rrule, but it DOES carry `reschedule_interval_sec`
 * — it re-fires N sec AFTER its previous turn completes (the engine-managed replacement
 * for Claude /loop). Claiming a loop must NOT deactivate it (the one-shot trap above) and
 * must NOT set next_fire_at=NULL (the infinite-refire trap above). Instead, on claim it
 * stays active=TRUE and PARKS at `next_fire_at = 'infinity'::timestamptz`: the claim guard
 * `next_fire_at <= now()` never matches infinity, so the loop is not re-claimed while its
 * turn runs — that IS the skip-if-in-flight guard, for free. The completion-rebase (P-002)
 * re-arms it to a real time (completed_at + interval). A routine carrying BOTH a cron and a
 * loop interval (cron+loop) is recurrence (it has a cron), so it takes the normal cron-advance
 * branch below — staying active and advancing to cron-next; P-002 then folds in the loop
 * re-arm by taking the SOONER of cron-next and completed_at+interval.
 */
import type { Sql } from 'postgres';
import type { RoutineRow } from '@papercusp/db-org';
import { computeNextFire } from './schedule-next';

export async function claimDueRoutine(sql: Sql, routine: RoutineRow): Promise<boolean> {
  const cfg = routine.triggerConfig;
  // Recurrence = a cron OR an rrule (scheduled-recurring-plans P-007).
  const hasRecurrence = !!(cfg && (cfg.cron || cfg.rrule));
  // A loop carries an interval (re-fire N sec after the turn completes). A PURE loop
  // (interval set, no cron/rrule) is the THIRD kind; a cron+loop is recurrence (below).
  const isLoop = routine.rescheduleIntervalSec != null;

  // THIRD KIND — pure loop: keep active=TRUE and PARK at 'infinity' (the in-flight
  // sentinel). NOT deactivate, NOT NULL, NEVER touch harness_plans (a loop is not a
  // plan-schedule one-shot). The completion-rebase re-arms it after the turn settles.
  if (isLoop && !hasRecurrence) {
    const rows = await sql<{ id: string }[]>`
      UPDATE harness_shared.routines
         SET last_fired_at = now(),
             next_fire_at = 'infinity'::timestamptz,
             updated_at = now()
       WHERE id = ${routine.id}
         AND active = TRUE
         AND (next_fire_at IS NULL OR next_fire_at <= now())
      RETURNING id
    `;
    return rows.length > 0;
  }

  // No recurrence and not a loop ⇒ a ONE-SHOT (a self-declared wake at an explicit
  // next_fire_at): claiming it DEACTIVATES it.
  if (!hasRecurrence) {
    const rows = await sql<{ id: string }[]>`
      UPDATE harness_shared.routines
         SET last_fired_at = now(),
             next_fire_at = NULL,
             active = FALSE,
             updated_at = now()
       WHERE id = ${routine.id}
         AND active = TRUE
         AND (next_fire_at IS NULL OR next_fire_at <= now())
      RETURNING id
    `;
    const claimed = rows.length > 0;
    // A plan-schedule ONE-SHOT that just auto-deactivated must ALSO un-arm its owning plan —
    // mirror disarmPlanSchedule's two-write — else the plan still reads schedule_active=true
    // ("armed") though its routine is dead and it will never fire again (EI-1371). The routine
    // name (`plan-schedule-<templateSlug>`) + target_role identify a plan-schedule routine; the
    // template slug is the name minus the prefix (cf. materialize-plan-schedule.ts
    // planScheduleRoutineName / PLAN_RUN_ACTION). pot-wake & other one-shots don't match, so they
    // never touch harness_plans.
    if (claimed && routine.targetRole === 'system:plan-run' && routine.name.startsWith('plan-schedule-')) {
      const templateSlug = routine.name.slice('plan-schedule-'.length);
      await sql`
        UPDATE harness_shared.harness_plans
           SET schedule_active = FALSE, updated_at = now()
         WHERE workspace_id = ${routine.workspaceId}
           AND harness_slug = ${routine.installSlug}
           AND plan_slug = ${templateSlug}
      `;
    }
    return claimed;
  }
  const next = computeNextFire(cfg, new Date());
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET last_fired_at = now(),
           next_fire_at = ${next ? next.toISOString() : null}::timestamptz,
           updated_at = now()
     WHERE id = ${routine.id}
       AND active = TRUE
       AND (next_fire_at IS NULL OR next_fire_at <= now())
    RETURNING id
  `;
  return rows.length > 0;
}
