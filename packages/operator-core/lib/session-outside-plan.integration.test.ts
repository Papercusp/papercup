import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'authenticated-workspace' }));
import { bindSessionOutsidePlanRef, readSessionOutsidePlanRef } from './session-outside-plan';

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('session-outside-plan');
  h.sql = db.sql;
  await db.sql.unsafe(`CREATE TABLE harness_shared.adv_sessions (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
    plan_slug text, started_at timestamptz NOT NULL DEFAULT now()
  )`);
  await applyMigrationForTest(db.sql, fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/1653-session-outside-plan-ref.sql', import.meta.url)));
}, 90_000);
afterAll(async () => { await db?.cleanup(); });

describe('outside-plan session SQL on a fresh empty database', () => {
  it('persists across readers, isolates workspaces, and refuses conflicting bindings in SQL', async () => {
    const [row] = await db.sql<Array<{ id: number }>>`INSERT INTO harness_shared.adv_sessions
      (workspace_id, coord_owner_id) VALUES ('authenticated-workspace', 'owner') RETURNING id`;
    const input = { ownerId: 'owner', workspaceId: 'authenticated-workspace', advSessionId: row.id, planRef: 'tracker:X' };
    await bindSessionOutsidePlanRef(input);
    await expect(bindSessionOutsidePlanRef(input)).resolves.toBeUndefined();
    expect(await readSessionOutsidePlanRef('owner')).toBe('tracker:X');
    await db.sql.end();
    // A new database connection models the session binding surviving a server restart.
    const { default: postgres } = await import('postgres');
    h.sql = postgres(db.url, { prepare: false });
    try {
      expect(await readSessionOutsidePlanRef('owner')).toBe('tracker:X');
      expect(await readSessionOutsidePlanRef('owner', 'unrelated-workspace')).toBeNull();
      await expect(bindSessionOutsidePlanRef({ ...input, planRef: 'tracker:Y' })).rejects.toThrow(/conflicting/);
      await expect(bindSessionOutsidePlanRef({ ...input, workspaceId: 'unrelated-workspace' })).rejects.toThrow(/conflicting/);
      await expect(h.sql`UPDATE harness_shared.adv_sessions SET plan_slug = 'plan' WHERE id = ${row.id}`).rejects.toMatchObject({ code: '23514' });
    } finally { await h.sql.end(); }
  });
});
