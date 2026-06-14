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
