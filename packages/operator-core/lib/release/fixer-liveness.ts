/**
 * Is a dispatched release-fixer still alive? (EI-18672078222841101)
 *
 * WHY THIS IS ITS OWN MODULE. This lived in `harness/routines/release-actions.ts`, which
 * calls `registerSystemAction('green-checkpoint', ...)` / `('release-trigger', ...)` at
 * MODULE SCOPE. Importing it registers those system actions as a side effect — fine for the
 * routine host, wrong for a read-side surface like the pipeline snapshot that only wants to
 * report who owns the current red. Splitting the function out (rather than copying it) keeps
 * ONE liveness definition: the renderer that tells agents "someone is on it" and the
 * dispatcher that decides "don't spawn another one" must never be able to disagree.
 */
import type postgres from 'postgres';
import { STALE_MS } from '../liveness';

/**
 * Is the recorded release-fixer spawn still ALIVE — `running`/`restarting` with a
 * heartbeat inside the shared STALE_MS window (the SAME liveness definition the
 * fleet_assignment view + the stale-claim reconciler use, so they can't drift)?
 * Returns `null` when there's no spawn id to check (a DBOS-durable fire / legacy
 * record), which the decision treats as "presumed covered". Fail-soft: a query
 * error returns null (presumed covered) rather than hammering a re-dispatch.
 */
export async function releaseFixerSpawnAlive(
  sql: postgres.Sql,
  spawnId: string | null | undefined,
): Promise<boolean | null> {
  if (!spawnId) return null;
  const graceSec = Math.max(1, Math.round(STALE_MS / 1000));
  try {
    const rows = (await sql.unsafe(
      `SELECT 1 FROM harness_shared.spawned_agents
        WHERE spawn_id = $1 AND status IN ('running','restarting')
          AND heartbeat_at IS NOT NULL AND (now() - heartbeat_at) < make_interval(secs => $2)
        LIMIT 1`,
      [spawnId, graceSec],
    )) as unknown[];
    return rows.length > 0;
  } catch {
    return null;
  }
}
