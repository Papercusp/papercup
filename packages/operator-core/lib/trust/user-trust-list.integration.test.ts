/**
 * user-trust-list.integration.test.ts — the owner trust CRUD against a real migrated
 * Postgres (shared-hive-trust-admission-2026-06-14 P-009 / D-001 / D-004). Migration
 * 276 lands; add/list/remove round-trip; and — the SECURITY assertion — the list is
 * EXPLICITLY workspace-scoped even through the admin handle (which BYPASSES RLS), so a
 * user trusted in workspace A never leaks into workspace B (D-004 cross-workspace trust
 * leak = a privilege-escalation hole).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import { listTrustedUsers, addTrustedUser, removeTrustedUser } from './user-trust-list';

const WS_A = 'trust-ws-a';
const WS_B = 'trust-ws-b';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql; // admin handle — bypasses RLS, so explicit ws-scoping is what must hold (D-004)
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('user-trust-list — owner trust CRUD (migration 276)', () => {
  it('add → list round-trips with note + createdTs', async () => {
    const row = await addTrustedUser(WS_A, { githubUserId: 42, note: 'alice@acme', actor: 'su-test', nowMs: 1000 });
    expect(row).toEqual({ githubUserId: 42, note: 'alice@acme', createdTs: 1000 });
    expect(await listTrustedUsers(WS_A)).toContainEqual({ githubUserId: 42, note: 'alice@acme', createdTs: 1000 });
  });

  it('add is idempotent — re-add updates the note but PRESERVES the original created_ts', async () => {
    await addTrustedUser(WS_A, { githubUserId: 7, note: 'first', actor: 'su-test', nowMs: 2000 });
    const re = await addTrustedUser(WS_A, { githubUserId: 7, note: 'updated', actor: 'su-test', nowMs: 9999 });
    expect(re).toEqual({ githubUserId: 7, note: 'updated', createdTs: 2000 });
  });

  it('D-004 SECURITY: a user trusted in workspace A is NOT visible in workspace B (no cross-ws leak via the admin handle)', async () => {
    await addTrustedUser(WS_A, { githubUserId: 555, note: 'only-A', actor: 'su-test', nowMs: 3000 });
    expect((await listTrustedUsers(WS_A)).some((u) => u.githubUserId === 555)).toBe(true);
    expect((await listTrustedUsers(WS_B)).some((u) => u.githubUserId === 555)).toBe(false);
  });

  it('remove deletes (removed:true); a second remove is a no-op (removed:false)', async () => {
    await addTrustedUser(WS_A, { githubUserId: 88, actor: 'su-test', nowMs: 4000 });
    expect(await removeTrustedUser(WS_A, 88, 'su-test')).toEqual({ removed: true });
    expect((await listTrustedUsers(WS_A)).some((u) => u.githubUserId === 88)).toBe(false);
    expect(await removeTrustedUser(WS_A, 88, 'su-test')).toEqual({ removed: false });
  });

  it('remove is workspace-scoped — removing in B never touches A', async () => {
    await addTrustedUser(WS_A, { githubUserId: 999, actor: 'su-test', nowMs: 5000 });
    expect(await removeTrustedUser(WS_B, 999, 'su-test')).toEqual({ removed: false });
    expect((await listTrustedUsers(WS_A)).some((u) => u.githubUserId === 999)).toBe(true);
  });

  it('rejects a non-positive github user id', async () => {
    await expect(addTrustedUser(WS_A, { githubUserId: 0, actor: 'su-test', nowMs: 1 })).rejects.toThrow(/positive integer/);
    await expect(addTrustedUser(WS_A, { githubUserId: -5, actor: 'su-test', nowMs: 1 })).rejects.toThrow(/positive integer/);
  });

  it('writes an audit_log row on add (the security trail)', async () => {
    await addTrustedUser(WS_A, { githubUserId: 314, note: 'pi', actor: 'su-auditor', nowMs: 6000 });
    const [audit] = await db.adminSql`
      SELECT action, subject, actor, workspace_id FROM harness_shared.audit_log
       WHERE action = 'trust:add' AND subject = '314' AND workspace_id = ${WS_A} LIMIT 1`;
    expect(audit).toMatchObject({ action: 'trust:add', subject: '314', actor: 'su-auditor', workspace_id: WS_A });
  });
});
