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

  // TR2 — empty-workspace guards. listTrustedUsers('') short-circuits WITHOUT
  // touching PG (user-trust-list.ts:38); add/remove REJECT (:61, :80). The empty
  // string is the "no resolved workspace" sentinel — an unscoped write here would
  // be a cross-workspace trust leak, so it must hard-fail, never silently widen.
  it('empty-workspace guards: list → [] without PG; add/remove reject /no workspace/', async () => {
    expect(await listTrustedUsers('')).toEqual([]);
    await expect(addTrustedUser('', { githubUserId: 1, actor: 'su-test', nowMs: 1 })).rejects.toThrow(/no workspace/);
    await expect(removeTrustedUser('', 1, 'su-test')).rejects.toThrow(/no workspace/);
  });

  // TR2 — the SECURITY-CRITICAL fire-safe audit (user-trust-list.ts:111). The
  // trust INSERT has already COMMITTED by the time the audit row is written; a
  // failed audit write must therefore NEVER fail the grant (else a transient
  // audit-table problem would silently break the trust system). We make ONLY the
  // audit_log INSERT throw (the trust INSERT still hits real PG) and assert the
  // grant both RESOLVES with the trusted row AND is durably present.
  it('a FAILED audit write does NOT fail the (already committed) grant — the row survives', async () => {
    const realSql = db.adminSql;
    // A callable tagged-template proxy over the real admin handle: throw only for
    // the audit_log INSERT; delegate every other query (incl. the trust INSERT)
    // verbatim. Object.assign carries postgres-js's own methods (.begin etc.) so
    // the handle stays otherwise intact.
    const failingAuditSql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (Array.isArray(strings) && strings.join('').includes('audit_log')) {
          throw new Error('audit table is down');
        }
        return (realSql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...values);
      },
      realSql,
    ) as unknown as postgres.Sql;

    h.sql = failingAuditSql;
    // The fire-safe path warns instead of throwing; capture the warning explicitly
    // (vitest-fail-on-console would otherwise fail the run, and the warn IS the
    // documented swallow — capturing it proves the catch arm actually ran). We
    // replace console.warn directly (not vi.spyOn, which layers over the
    // fail-on-console interceptor) and record the args ourselves.
    const warnings: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
    let trusted: Awaited<ReturnType<typeof addTrustedUser>>;
    try {
      // Must NOT throw even though the audit INSERT throws inside recordTrustAudit.
      trusted = await addTrustedUser(WS_A, { githubUserId: 4242, note: 'survives', actor: 'su-test', nowMs: 7000 });
    } finally {
      h.sql = realSql; // restore for assertions + later tests
      console.warn = origWarn;
    }
    expect(trusted).toEqual({ githubUserId: 4242, note: 'survives', createdTs: 7000 });
    // The catch arm ran (audit failure was swallowed, not propagated).
    expect(warnings).toContainEqual(['[trust] audit write failed:', 'audit table is down']);
    // The grant is durably present despite the audit failure.
    expect((await listTrustedUsers(WS_A)).some((u) => u.githubUserId === 4242)).toBe(true);
    // ...and no audit row was written for it (proving the injection actually hit).
    const auditRows = await realSql`
      SELECT 1 FROM harness_shared.audit_log
       WHERE action = 'trust:add' AND subject = '4242' AND workspace_id = ${WS_A}`;
    expect(auditRows.length).toBe(0);
  });
});
