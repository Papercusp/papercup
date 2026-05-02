/**
 * CI cross-workspace probe.
 *
 * Phase A acceptance test. Authenticates as workspace B and attempts
 * to read workspace A's data via every workspace-scoped surface,
 * asserting denial.
 *
 * This test exists as a regression guard. The PG-layer RLS policies are
 * the load-bearing enforcement; this test verifies they actually deny
 * the expected accesses.
 *
 * Requires:
 *   - HARNESS_ADMIN_DATABASE_URL pointing at a test database with
 *     migrations 009 + 010 applied.
 *   - Two workspace ids ('ws-a', 'ws-b') with seeded fixtures in
 *     harness_shared.projects, audit_log, etc.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { withWorkspace } from '@restart/papercusp-db/workspace-context';

const ADMIN_URL =
  process.env.HARNESS_ADMIN_DATABASE_URL ??
  'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

const WS_A = 'test-ws-a';
const WS_B = 'test-ws-b';

let admin: postgres.Sql;

async function seed() {
  await admin`
    INSERT INTO harness_shared.projects (id, slug, name, status, created_ts, updated_ts, workspace_id)
    VALUES
      ('proj-a', 'proj-a', 'Workspace A Project', 'active', 0, 0, ${WS_A}),
      ('proj-b', 'proj-b', 'Workspace B Project', 'active', 0, 0, ${WS_B})
    ON CONFLICT (id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id
  `;
  await admin`
    INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
    VALUES
      ('aud-a-1', 0, 'system:test', 'noop', 'proj-a', '{}'::jsonb, ${WS_A}),
      ('aud-b-1', 0, 'system:test', 'noop', 'proj-b', '{}'::jsonb, ${WS_B})
    ON CONFLICT (id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id
  `;
}

async function cleanup() {
  await admin`DELETE FROM harness_shared.projects WHERE id IN ('proj-a', 'proj-b')`;
  await admin`DELETE FROM harness_shared.audit_log WHERE id IN ('aud-a-1', 'aud-b-1')`;
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await seed();
});

afterAll(async () => {
  await cleanup();
  await admin.end({ timeout: 5 });
});

describe('cross-workspace probe (PG-layer RLS)', () => {
  it('cannot SELECT another workspace\'s projects', async () => {
    const visible = await withWorkspace(WS_B, async (tx) => {
      return await tx<Array<{ id: string }>>`
        SELECT id FROM harness_shared.projects WHERE id = 'proj-a'
      `;
    });
    expect(visible).toHaveLength(0);
  });

  it('can SELECT own workspace\'s projects', async () => {
    const visible = await withWorkspace(WS_B, async (tx) => {
      return await tx<Array<{ id: string }>>`
        SELECT id FROM harness_shared.projects WHERE id = 'proj-b'
      `;
    });
    expect(visible).toHaveLength(1);
  });

  it('cannot UPDATE another workspace\'s projects', async () => {
    await withWorkspace(WS_B, async (tx) => {
      await tx`
        UPDATE harness_shared.projects SET name = 'hijacked' WHERE id = 'proj-a'
      `;
    });
    const check = await admin<Array<{ name: string }>>`
      SELECT name FROM harness_shared.projects WHERE id = 'proj-a'
    `;
    expect(check[0]?.name).toBe('Workspace A Project');
  });

  it('audit_log RLS denies cross-workspace reads', async () => {
    const visible = await withWorkspace(WS_B, async (tx) => {
      return await tx<Array<{ id: string }>>`
        SELECT id FROM harness_shared.audit_log WHERE id = 'aud-a-1'
      `;
    });
    expect(visible).toHaveLength(0);
  });

  it('a query without app.workspace_id GUC returns nothing', async () => {
    // Direct postgres call WITHOUT withWorkspace wrapper. RLS predicate
    // workspace_id = current_setting('app.workspace_id', true) is false
    // when the GUC is NULL — so even via harness_app, no rows visible.
    const appUrl =
      process.env.HARNESS_DATABASE_URL ??
      'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
    const app = postgres(appUrl, { onnotice: () => {} });
    try {
      const rows = await app<Array<{ id: string }>>`
        SELECT id FROM harness_shared.projects
         WHERE id IN ('proj-a', 'proj-b')
      `;
      expect(rows).toHaveLength(0);
    } finally {
      await app.end({ timeout: 5 });
    }
  });
});
