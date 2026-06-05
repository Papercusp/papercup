/**
 * notify-gc.ts — GC the `notify` firehose from the coord event log.
 *
 * The subscribe→inject fan-out (coordination-substrate Phase 2) writes one
 * durable `notify` row per subscriber into the coord_event_log 'messages'
 * surface. Those are ephemeral injected notices — once consumed they need not
 * persist — so a daily DBOS scheduled tick (periodic-workflows) deletes notify
 * rows older than `retentionDays`. (Relocated here when the legacy path-glob
 * coord:watch model + its subscriptions.ts were retired; the GC predicate
 * `kind='notify'` covers the fan-out notices unchanged.)
 *
 * Returns the number deleted. Best-effort caller (the tick) tolerates errors.
 */

import { getOrgPg } from '@papercusp/db-org';

export async function gcOldNotifies(retentionDays = 3): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH d AS (
      DELETE FROM harness_shared.coord_event_log
       WHERE surface = 'messages'
         AND body->>'kind' = 'notify'
         AND ts < now() - make_interval(days => ${retentionDays})
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}
