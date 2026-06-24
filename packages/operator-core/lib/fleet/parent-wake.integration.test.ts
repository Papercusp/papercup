/**
 * parent-wake.integration.test.ts — parent inbox-wake on child death (EI-108, real PG).
 *
 * When a spawn reaches terminal status and has a parent, fire the parent's
 * inbox-wake key with a death notice. This closes the liveness hole: every
 * Queen placement re-wakes with verdict OR death certificate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { wakeParentOnChildDeath } from './parent-wake';

vi.mock('../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: vi.fn(async () => ({ targets: ['p-owner'], keys: ['coord:inbox-wake:p-owner'], woken: 1 })),
}));

import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';

const SPAWNED_AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY, workspace_id text NOT NULL, harness_slug text,
    parent_spawn_id text, parent_role text, child_role text NOT NULL,
    feature_id text, chunk_id text, run_id text,
    status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz, duration_ms bigint, exit_code int, output_tail text, error_message text,
    cancel_requested boolean NOT NULL DEFAULT false, session_owner text,
    coordination_domain text NOT NULL DEFAULT 'default', plan_slug text, item_id text,
    model_spec text, model_tier text, brief text,
    restart_strategy text NOT NULL DEFAULT 'one_for_one', restart_count int NOT NULL DEFAULT 0,
    restart_window_start timestamptz, cancel_reason text, cancelled_at timestamptz,
    pid integer, launcher_host text, launcher_boot_id text,
    heartbeat_at timestamptz NOT NULL DEFAULT now())`;

const WS = 'default';
let db: FreshPgDb;

async function insertSpawn(
  spawnId: string,
  parentSpawnId: string | null,
  sessionOwner: string | null,
  opts: { status?: string; errorMessage?: string; outputTail?: string; exitCode?: number } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, parent_spawn_id, parent_role, child_role,
       run_id, session_owner, status, error_message, output_tail, exit_code)
    VALUES (${spawnId}, ${WS}, 'papercup', ${parentSpawnId ?? null}, ${'operator'}, 'worker',
            ${'r-' + spawnId}, ${sessionOwner ?? null}, ${opts.status ?? 'running'},
            ${opts.errorMessage ?? null}, ${opts.outputTail ?? null}, ${opts.exitCode ?? null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('parent-wake');
  await db.sql.unsafe(SPAWNED_AGENTS_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.spawned_agents`;
  vi.clearAllMocks();
});

describe('wakeParentOnChildDeath (EI-108)', () => {
  it('wakes the parent (by parent_spawn_id == coord owner) when a child reaches terminal status', async () => {
    // The child carries parent_spawn_id; that IS the parent's coord owner id.
    await insertSpawn('child-s1', 'parent-s1', 'child-owner', { status: 'done' });

    const result = await wakeParentOnChildDeath(db.sql, 'child-s1', WS, 'done');

    expect(result.parentWoken).toBe(true);
    expect(result.parentSpawnId).toBe('parent-s1');
    expect(result.parentOwnerId).toBe('parent-s1');

    // Verify wakeRecipients was called with the parent's coord owner id directly.
    expect(wakeRecipients).toHaveBeenCalledWith(
      ['parent-s1'],
      expect.objectContaining({
        summary: expect.stringContaining('child-s1'),
        source: 'spawn-finish',
        workspaceId: WS,
      }),
    );
  });

  it('wakes a HIVE/Queen parent that has NO spawned_agents row (the EI-108 hive-parent bug fix)', async () => {
    // A Queen launched via the invoke route (bpkind=hive) lives in adv_sessions,
    // NOT spawned_agents — but her bee's parent_spawn_id == her coord owner id.
    // The old code looked the parent up in spawned_agents, found nothing, and
    // dropped the wake; the fix wakes parent_spawn_id directly. Note: we insert
    // ONLY the child here (no parent row at all).
    await insertSpawn('bee-of-queen', 's-queen-coord-owner', 'bee-of-queen', { status: 'failed' });

    const result = await wakeParentOnChildDeath(db.sql, 'bee-of-queen', WS, 'failed');

    expect(result.parentWoken).toBe(true);
    expect(result.parentOwnerId).toBe('s-queen-coord-owner');
    expect(wakeRecipients).toHaveBeenCalledWith(
      ['s-queen-coord-owner'],
      expect.objectContaining({ source: 'spawn-finish' }),
    );
  });

  it('includes death notice details in the payload', async () => {
    await insertSpawn('child-s2', 'parent-s2', 'child-owner', {
      status: 'failed',
      errorMessage: 'test error',
      outputTail: 'test output',
      exitCode: 1,
    });

    await wakeParentOnChildDeath(db.sql, 'child-s2', WS, 'failed');

    expect(wakeRecipients).toHaveBeenCalledWith(
      ['parent-s2'],
      expect.objectContaining({
        payload: {
          childSpawnId: 'child-s2',
          status: 'failed',
          errorMessage: 'test error',
          outputTail: 'test output',
          exitCode: 1,
        },
      }),
    );
  });

  it('does not wake when spawn has no parent', async () => {
    await insertSpawn('orphan-s1', null, 'orphan-owner', { status: 'done' });

    const result = await wakeParentOnChildDeath(db.sql, 'orphan-s1', WS, 'done');

    expect(result.parentWoken).toBe(false);
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('handles gracefully when spawn does not exist', async () => {
    const result = await wakeParentOnChildDeath(db.sql, 'nonexistent', WS, 'done');

    expect(result.parentWoken).toBe(false);
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('supports all terminal statuses: failed, cancelled, done', async () => {
    const statuses = ['failed', 'cancelled', 'done'];

    for (const status of statuses) {
      vi.clearAllMocks();
      const parentId = `parent-${status}`;
      const childId = `child-${status}`;

      await insertSpawn(childId, parentId, 'child-owner', { status });

      const result = await wakeParentOnChildDeath(db.sql, childId, WS, status);

      expect(result.parentWoken).toBe(true);
      expect(wakeRecipients).toHaveBeenCalledWith(
        [parentId],
        expect.objectContaining({ summary: expect.stringContaining(status) }),
      );
    }
  });
});
