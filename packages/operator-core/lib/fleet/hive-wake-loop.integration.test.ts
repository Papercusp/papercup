/**
 * hive-wake-loop.integration.test.ts — the autonomous-loop liveness contract
 * (real PG). Stitches the two halves that, together, let a Queen run hands-off:
 *
 *   bee reaches a terminal state  →  the parent (Queen) is re-woken.
 *
 * Two paths reach `wakeParentOnChildDeath`:
 *   1. the P-011 reclaim sweep (`reclaimOrphanedSpawns`) — a bee whose host died
 *      (stale heartbeat) is flipped to 'failed', then its parent is woken;
 *   2. `finishSpawn` (operator-spawn) on a clean exit — covered by
 *      operator-spawn's own suite; here we exercise the reclaim path end-to-end.
 *
 * THE REGRESSION THIS GUARDS (Stage-B, 2026-06-07): a Queen launched via the
 * invoke route (`bpkind=hive`) lives in `adv_sessions`, NOT `spawned_agents`.
 * The old `wakeParentOnChildDeath` looked the parent up in `spawned_agents`,
 * found nothing, and SILENTLY DROPPED THE WAKE for every Queen placement —
 * leaving the Queen asleep forever on a verdict that never came. The fix wakes
 * `parent_spawn_id` (the coord owner) directly. These tests insert ONLY the
 * child (no parent row) to reproduce the hive case at the integration level.
 *
 * `wakeRecipients` is mocked: the inbox-wake fan is its own unit's contract — we
 * assert the loop FIRES it for the right owner, not the fan's internals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { reclaimOrphanedSpawns } from './spawn-reclaim';

// Spy on the inbox-wake fan so we can assert WHO gets woken without standing up
// the full await/delivery schema. parent-wake.ts imports it from here. The
// factory is hoisted above all imports, so the vi.fn is created inside it and
// read back through the (mocked) import below — never a top-level closure ref.
vi.mock('../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: vi.fn(async () => ({ targets: [] as string[], keys: [] as string[], woken: 1 })),
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
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    -- migration 228 (EI-85 leg c): reclaimOrphanedSpawns SELECTs these for
    -- same-host /proc liveness. This fixture hand-rolls the schema, so it must
    -- mirror them or the SELECT fails "column pid does not exist".
    pid integer, launcher_host text)`;

const WS = 'default';
const STALE = { staleMs: 5 * 60_000 };
let db: FreshPgDb;

/** Insert a running bee with a stale heartbeat (so the reclaim sweep takes it). */
async function insertStaleBee(spawnId: string, parentSpawnId: string | null, sessionOwner: string | null) {
  await db.sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, child_role, run_id, parent_spawn_id, session_owner,
       status, started_at, heartbeat_at)
    VALUES (${spawnId}, ${WS}, 'papercup', 'bee', ${'r-' + spawnId}, ${parentSpawnId ?? null},
            ${sessionOwner ?? null}, 'running', now() - interval '10 minutes',
            now() - interval '10 minutes')`;
}

beforeAll(async () => {
  db = await createFreshPgDb('hive-wake-loop');
  await db.sql.unsafe(SPAWNED_AGENTS_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.spawned_agents`;
  vi.clearAllMocks();
});

describe('hive wake loop: reclaim → parent-wake', () => {
  it('REGRESSION: a reclaimed bee whose parent is a HIVE owner (no spawned_agents row) wakes the parent owner', async () => {
    // The Queen has NO spawned_agents row — she lives in adv_sessions. Only the
    // bee is inserted; its parent_spawn_id IS the Queen's coord owner id.
    await insertStaleBee('bee-1', 's-queen-coord-owner', 'bee-1');

    const r = await reclaimOrphanedSpawns(db.sql, STALE);

    expect(r.reclaimed).toBe(1);
    // The parent-wake is fire-and-forget inside the sweep (void … .catch()), so
    // wait for the async wake to land before asserting. The fix: the Queen (a
    // hive owner with NO spawned_agents row) is woken.
    await vi.waitFor(() => expect(wakeRecipients).toHaveBeenCalledTimes(1));
    expect(wakeRecipients).toHaveBeenCalledWith(
      ['s-queen-coord-owner'],
      expect.objectContaining({ source: 'spawn-finish', workspaceId: WS }),
    );
    // The death notice names the dead bee + its terminal status.
    const call = vi.mocked(wakeRecipients).mock.calls[0][1] as { summary: string; payload: { status: string } };
    expect(call.summary).toContain('bee-1');
    expect(call.payload.status).toBe('failed');
  });

  it('a reclaimed bee with a fleet-spawned parent (session_owner == parent_spawn_id) also wakes it', async () => {
    await insertStaleBee('bee-2', 'parent-bee', 'bee-2');

    await reclaimOrphanedSpawns(db.sql, STALE);

    await vi.waitFor(() =>
      expect(wakeRecipients).toHaveBeenCalledWith(
        ['parent-bee'],
        expect.objectContaining({ source: 'spawn-finish' }),
      ),
    );
  });

  it('a reclaimed bee with NO parent wakes nobody', async () => {
    await insertStaleBee('orphan-bee', null, 'orphan-bee');

    const r = await reclaimOrphanedSpawns(db.sql, STALE);

    expect(r.reclaimed).toBe(1);
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('reclaiming a fan of bees wakes each parent exactly once (no herd)', async () => {
    await insertStaleBee('bee-a', 's-queen', 'bee-a');
    await insertStaleBee('bee-b', 's-queen', 'bee-b');
    await insertStaleBee('bee-c', 's-other-queen', 'bee-c');

    const r = await reclaimOrphanedSpawns(db.sql, STALE);

    expect(r.reclaimed).toBe(3);
    await vi.waitFor(() => expect(wakeRecipients).toHaveBeenCalledTimes(3));
    const wokenOwners = vi.mocked(wakeRecipients).mock.calls.map((c) => (c[0] as string[])[0]).sort();
    expect(wokenOwners).toEqual(['s-other-queen', 's-queen', 's-queen']);
  });

  it('a freshly-heartbeated bee is NOT reclaimed and its parent is NOT woken (no false death)', async () => {
    // Fresh heartbeat (now) → outside the stale window.
    await db.sql`
      INSERT INTO harness_shared.spawned_agents
        (spawn_id, workspace_id, harness_slug, child_role, run_id, parent_spawn_id, status, heartbeat_at)
      VALUES ('live-bee', ${WS}, 'papercup', 'bee', 'r-live', 's-queen', 'running', now())`;

    const r = await reclaimOrphanedSpawns(db.sql, STALE);

    expect(r.reclaimed).toBe(0);
    expect(wakeRecipients).not.toHaveBeenCalled();
  });
});
