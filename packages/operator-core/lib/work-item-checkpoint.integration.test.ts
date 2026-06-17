/**
 * work-item-checkpoint.integration.test.ts — the bee work-item checkpoint store
 * (bee-context-efficiency-2026-06-14 P-010; D-002/D-003), against real Postgres.
 *
 * Asserts setHiveCarryNote semantics on a WORK-ITEM-scoped store: write→read,
 * replace-on-write, trim, blank/null/undefined ⇒ clear (row deleted), any length,
 * successor-bee inheritance (the checkpoint lives on the work-item, D-002), and
 * workspace isolation. The migration-281 grants/RLS are validated separately by
 * fresh-migrate.integration.test.ts (which seeds the framework roles); the store
 * semantics only need the table, so the inline DDL mirrors migration 281's table.
 * Gated on Docker like the other *-integration tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { setWorkItemCheckpoint, getWorkItemCheckpoint } = await import('./work-item-checkpoint');

const HARNESS = 'h1';

const CHECKPOINTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_checkpoints (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    work_item_id text NOT NULL,
    checkpoint text NOT NULL,
    updated_ts bigint NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('work-item-checkpoint');
  h.sql = db.sql;
  await db.sql.unsafe(CHECKPOINTS_DDL);
}, 60_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_item_checkpoints`;
});

async function rowCount(): Promise<number> {
  const r = await db.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM harness_shared.work_item_checkpoints`;
  return Number(r[0]?.n ?? 0);
}

describe('work-item checkpoint store (P-010, real PG) — setHiveCarryNote semantics', () => {
  it('write → read round-trips', async () => {
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'phase 2 of 5; edited foo.ts')).toBe(
      'phase 2 of 5; edited foo.ts',
    );
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('phase 2 of 5; edited foo.ts');
  });

  it('replace-on-write: the latest write wins (one row, not appended)', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'first');
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'second');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('second');
    expect(await rowCount()).toBe(1);
  });

  it('trims the stored value (mirrors setHiveCarryNote)', async () => {
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, '  padded  ')).toBe('padded');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('padded');
  });

  it('blank / null / undefined ⇒ CLEAR (deletes the row); re-read is null', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'state');
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, '   ')).toBeNull(); // blank clears
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull();
    expect(await rowCount()).toBe(0);

    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'again');
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, null)).toBeNull(); // null clears
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull();

    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'yet again');
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, undefined)).toBeNull(); // undefined clears
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull();
  });

  it('clearing a non-existent checkpoint is a no-op (idempotent)', async () => {
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'NOPE' }, '')).toBeNull();
    expect(await rowCount()).toBe(0);
  });

  it('reading a missing checkpoint returns null', async () => {
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'MISSING' })).toBeNull();
  });

  it('any length — a large compressed blob round-trips (no cap)', async () => {
    const big = 'x'.repeat(200_000);
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-BIG' }, big);
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-BIG' })).toBe(big);
  });

  it('WORK-ITEM-scoped (D-002): a successor reader on the SAME work-item inherits the checkpoint', async () => {
    // The bee that wrote it is irrelevant — the checkpoint lives on the work-item,
    // so any later reader (a re-woken bee OR a successor after eviction) gets it.
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-HANDOFF' }, 'predecessor left this');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-HANDOFF' })).toBe('predecessor left this');
  });

  it('checkpoints are independent per work-item and per harness', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'one');
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-2' }, 'two');
    await setWorkItemCheckpoint({ harness: 'h2', workItemId: 'WI-1' }, 'other-harness');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('one');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-2' })).toBe('two');
    expect(await getWorkItemCheckpoint({ harness: 'h2', workItemId: 'WI-1' })).toBe('other-harness');
  });

  it('workspace-scoped: a checkpoint in another workspace is invisible here', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1', workspaceId: 'other-ws' }, 'theirs');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull(); // default ws
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1', workspaceId: 'other-ws' })).toBe('theirs');
  });
});

// C6 [P3] — concurrency under contention + the cross-workspace PK isolation guarantee.
// The store is a single UPSERT keyed by (workspace_id, harness_slug, work_item_id). Two bees
// (a re-woken one + a successor, or two surfaces of the same bee) can race a write to the SAME
// checkpoint; the ON CONFLICT DO UPDATE must leave EXACTLY ONE coherent row — one writer's full
// value, never an interleaved/corrupted blob, never two rows. And because the PK leads with
// workspace_id, a write/clear in one workspace must NEVER perturb the same (harness, workItem)
// in another — the multi-workspace install isolation (operator_multi_workspace) rides on this.
describe('work-item checkpoint store (C6) — concurrent writes + cross-workspace PK isolation', () => {
  async function rowsFor(workItemId: string): Promise<{ workspace_id: string; checkpoint: string }[]> {
    return db.sql<{ workspace_id: string; checkpoint: string }[]>`
      SELECT workspace_id, checkpoint FROM harness_shared.work_item_checkpoints
       WHERE harness_slug = ${HARNESS} AND work_item_id = ${workItemId} ORDER BY workspace_id`;
  }

  it('two CONCURRENT writes to the same checkpoint → exactly ONE row, value is ONE writer (never corrupted/interleaved)', async () => {
    // Fire N distinct, individually-coherent writers at the same key simultaneously. The UPSERT
    // serializes them; the survivor must be ONE of the inputs verbatim — no row gets a spliced blob.
    const writers = Array.from({ length: 12 }, (_, i) => `writer-${i}-${'='.repeat(i)}|coherent-snapshot`);
    await Promise.all(
      writers.map((cp) => setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RACE' }, cp)),
    );
    const rows = await rowsFor('WI-RACE');
    expect(rows).toHaveLength(1); // exactly one row survives — the PK held under contention
    expect(writers).toContain(rows[0].checkpoint); // it's one writer's WHOLE value, not a merge
    // The read path agrees with the stored row (no torn read).
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RACE' })).toBe(rows[0].checkpoint);
  });

  it('a concurrent write vs clear converges to a single definite state (one row, or none) — never two rows', async () => {
    // A successor writing while a predecessor clears (eviction) is a legitimate race. Whichever
    // lands last wins; either way the table holds 0-or-1 row for the key — never a duplicate.
    await Promise.all([
      setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RC' }, 'successor wrote this'),
      setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RC' }, ''), // clear
      setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RC' }, 'and another'),
    ]);
    const rows = await rowsFor('WI-RC');
    expect(rows.length).toBeLessThanOrEqual(1); // 0 (clear won) or 1 (a write won) — never 2
    if (rows.length === 1) {
      expect(['successor wrote this', 'and another']).toContain(rows[0].checkpoint);
    }
  });

  it('cross-workspace PK isolation: a write/clear in WS-A leaves the SAME (harness, workItem) in WS-B untouched', async () => {
    // Same harness + same work-item id in two workspaces are DISTINCT rows (PK leads with workspace_id).
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' }, 'A-state');
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-b' }, 'B-state');
    expect(await rowsFor('WI-ISO')).toEqual([
      { workspace_id: 'ws-a', checkpoint: 'A-state' },
      { workspace_id: 'ws-b', checkpoint: 'B-state' },
    ]);

    // Re-WRITE in WS-A → WS-B is unchanged.
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' }, 'A-state-2');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-b' })).toBe('B-state');

    // CLEAR in WS-A (delete that row) → WS-B's row is still present + intact.
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' }, null)).toBeNull();
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' })).toBeNull();
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-b' })).toBe('B-state');
    expect(await rowsFor('WI-ISO')).toEqual([{ workspace_id: 'ws-b', checkpoint: 'B-state' }]);
  });
});
