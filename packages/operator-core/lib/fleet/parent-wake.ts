/**
 * fleet/parent-wake — when a spawn reaches terminal status and has parent_spawn_id,
 * fire the parent's inbox-wake key with a death notice.
 * (EI-108: wake-on-bee-death for Queen oversight)
 *
 * This closes the liveness hole: every Queen placement now re-wakes with verdict
 * (the child's completion message) OR a death certificate (the child died, parent
 * was waiting, now parent knows).
 */

import type { Sql } from 'postgres';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';

interface SpawnRecord {
  spawn_id: string;
  parent_spawn_id: string | null;
  workspace_id: string;
  session_owner: string | null;
  status: string;
  error_message: string | null;
  output_tail: string | null;
  exit_code: number | null;
}

export interface ParentWakeResult {
  parentWoken: boolean;
  parentSpawnId?: string;
  parentOwnerId?: string;
}

/**
 * Fire the parent's inbox-wake key when a spawn reaches terminal status.
 * If the spawn has no parent, returns parentWoken=false silently.
 * Best-effort: errors (DB/inbox/wake) are logged but don't throw.
 */
export async function wakeParentOnChildDeath(
  sql: Sql,
  spawnId: string,
  workspaceId: string,
  childStatus: string,
): Promise<ParentWakeResult> {
  try {
    // Fetch the spawn and its parent (if any)
    const rows = await sql<SpawnRecord[]>`
      SELECT spawn_id, parent_spawn_id, workspace_id, session_owner, status,
             error_message, output_tail, exit_code
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${spawnId} AND workspace_id = ${workspaceId}`;

    if (rows.length === 0) {
      return { parentWoken: false };
    }

    const spawn = rows[0];
    if (!spawn.parent_spawn_id) {
      return { parentWoken: false };
    }

    // Fetch the parent spawn to get the parent's session_owner (ownerId)
    const parentRows = await sql<SpawnRecord[]>`
      SELECT spawn_id, parent_spawn_id, workspace_id, session_owner, status,
             error_message, output_tail, exit_code
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${spawn.parent_spawn_id} AND workspace_id = ${workspaceId}`;

    if (parentRows.length === 0) {
      return { parentWoken: false };
    }

    const parent = parentRows[0];
    if (!parent.session_owner) {
      return { parentWoken: false };
    }

    // Fire the parent's inbox-wake with a death notice
    const deathNotice = `Child spawn ${spawnId} reached terminal status: ${childStatus}`;
    const payload = {
      childSpawnId: spawnId,
      status: childStatus,
      errorMessage: spawn.error_message,
      outputTail: spawn.output_tail,
      exitCode: spawn.exit_code,
    };

    const result = await wakeRecipients([parent.session_owner], {
      summary: deathNotice,
      payload,
      source: 'spawn-finish',
      workspaceId,
    });

    return {
      parentWoken: result.woken > 0,
      parentSpawnId: spawn.parent_spawn_id,
      parentOwnerId: parent.session_owner,
    };
  } catch (err) {
    // Best-effort: log but don't throw. The spawn's terminal status is already
    // durable; a wake fan error downgrades to "parent sees the message on their
    // next natural turn" instead of immediate re-invoke.
    console.warn(
      `[parent-wake] failed to wake parent of spawn ${spawnId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { parentWoken: false };
  }
}
