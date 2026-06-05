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
 * A cron-kind routine WITHOUT a cron expression is a ONE-SHOT (a self-declared
 * wake at an explicit `next_fire_at` — the pot's `pot-wake` routine,
 * autoloop-pot-operator-rebuild D-002): claiming it DEACTIVATES it. Setting
 * `next_fire_at = NULL` while leaving it active would make it due again on the
 * very next tick — an infinite refire loop.
 */
import type { Sql } from 'postgres';
import type { RoutineRow } from '@papercusp/db-org';
import { computeNextFireAt } from './cron';

export async function claimDueRoutine(sql: Sql, routine: RoutineRow): Promise<boolean> {
  const cron = routine.triggerConfig?.cron;
  if (!cron) {
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
    return rows.length > 0;
  }
  const next = computeNextFireAt(cron, new Date());
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
