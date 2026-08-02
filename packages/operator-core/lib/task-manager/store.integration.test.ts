/**
 * store.integration.test.ts — task-manager/store.ts against REAL Postgres
 * (task-manager-no-escape-2026-07-27, P-003).
 *
 * EI-18824358724907941: `clearVanishedUnaccounted([])` used to plug a literal NUL
 * byte ('\x00none') into a query parameter as a sentinel to avoid an empty
 * `<> ALL(...)` array — Postgres rejects ANY string containing 0x00 outright
 * ("invalid byte sequence for encoding \"UTF8\": 0x00"), so it failed on EVERY
 * tick with zero currently-unaccounted residue (the common, healthy case), which
 * is what the `task-reconcile` background routine's watchdog failure
 * (EI-18824358724907941) reported. This never showed up in the stubbed unit
 * tests (reconcile-tick.test.ts fakes `clearVanishedUnaccounted` entirely) — it
 * needs a REAL Postgres round-trip to reproduce, hence this integration test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../test/_pg-helpers';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const store = await import('./store');

const WS = 'default';
let db: FreshPgDb;

async function insertUnaccounted(taskId: string, cgroupPath = '/sys/fs/cgroup/foo') {
  await db.sql`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, root_task_id, class, title, argv,
      launched_by, cgroup_path, pid, confined, state, detail
    ) VALUES (
      ${taskId}, ${WS}, ${taskId}, 'other', 'sample cmdline',
      '[]'::jsonb, 'unknown', ${cgroupPath}, 1, false, 'unaccounted', '{}'::jsonb
    )
  `;
}

beforeAll(async () => {
  db = await createFreshPgDb('task-ledger-store');
  h.sql = db.sql;
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '696-task-ledger.sql'));
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '700-task-ledger-bash-job-id-idx.sql'));
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.task_ledger`;
});

describe('clearVanishedUnaccounted (EI-18824358724907941)', () => {
  it('does NOT throw when stillPresent is empty — the common zero-residue tick', async () => {
    await insertUnaccounted('t-1');
    await expect(store.clearVanishedUnaccounted([], { workspaceId: WS })).resolves.toBe(1);
    const row = (await db.sql`SELECT state, exit_reason FROM harness_shared.task_ledger WHERE task_id = 't-1'`)[0];
    expect(row.state).toBe('stranded');
    expect(row.exit_reason).toBe('unaccounted residue no longer present');
  });

  it('closes ALL currently-unaccounted rows when nothing is still present (vacuous-TRUE semantics, not a no-op)', async () => {
    await insertUnaccounted('t-1');
    await insertUnaccounted('t-2', '/sys/fs/cgroup/bar');
    await expect(store.clearVanishedUnaccounted([], { workspaceId: WS })).resolves.toBe(2);
  });

  it('keeps a row named in stillPresent, closes the rest (non-empty path unchanged)', async () => {
    await insertUnaccounted('t-1');
    await insertUnaccounted('t-2', '/sys/fs/cgroup/bar');
    const closed = await store.clearVanishedUnaccounted(['t-1'], { workspaceId: WS });
    expect(closed).toBe(1);
    const rows = await db.sql`SELECT task_id, state FROM harness_shared.task_ledger ORDER BY task_id`;
    expect(rows).toEqual([
      { task_id: 't-1', state: 'unaccounted' },
      { task_id: 't-2', state: 'stranded' },
    ]);
  });

  it('is a no-op when there is nothing unaccounted at all (empty table, empty stillPresent)', async () => {
    await expect(store.clearVanishedUnaccounted([], { workspaceId: WS })).resolves.toBe(0);
  });
});
