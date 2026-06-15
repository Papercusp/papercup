/**
 * power-user-sessions.integration.test.ts — the OMP power-user revocation surface
 * (`harness_shared.power_user_sessions`) against real Postgres. This is the auth
 * tier's kill-switch: a row's `revoked_at` stops the refresh chain, so its CRUD
 * is security-critical and worth a real-schema round-trip.
 *
 * The runtime routes through `getOrgPg().sql` as the table owner (raw postgres-js
 * client, not drizzle), so we mock it to the fixture's admin (RLS-bypass) client
 * — the established org-fixture pattern (see attention/triage-store.integration.test.ts).
 *
 * Validates: create→get round-trip + last_seen_at bump, revoke stops get +
 * removes from the active list, revoke is idempotent, and the active list is
 * workspace-scoped + newest-first.
 *
 * Part of whole-app-test-coverage-breadth-2026-06-14 P-006 (integration tier).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

// Partial mock: keep `generated` (power-user-token.ts reads it at import time)
// intact while routing getOrgPg().sql to the fixture admin client.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const {
  createPowerUserSession,
  getActivePowerUserSession,
  revokePowerUserSession,
  listActivePowerUserSessions,
} = await import('./power-user-sessions');
const { createOrgTestDb } = await import('../test/_org-test-db');

describe('power_user_sessions store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('creates a session and reads it back (last_seen_at bumped on get)', async () => {
    const { authSessionId } = await createPowerUserSession({ workspaceId: 'ws-pu-a', userId: 'user-1' });
    expect(typeof authSessionId).toBe('string');
    expect(authSessionId.length).toBeGreaterThan(0);

    const row = await getActivePowerUserSession(authSessionId);
    expect(row).not.toBeNull();
    expect(row!.workspaceId).toBe('ws-pu-a');
    expect(row!.userId).toBe('user-1');
    expect(row!.revokedAt).toBeNull();
    expect(typeof row!.lastSeenAt).toBe('string');
  });

  it('returns null for an unknown session id', async () => {
    expect(await getActivePowerUserSession('does-not-exist')).toBeNull();
  });

  it('revoke stops get and removes the row from the active list', async () => {
    const { authSessionId } = await createPowerUserSession({ workspaceId: 'ws-pu-rev', userId: 'user-2' });
    expect(await getActivePowerUserSession(authSessionId)).not.toBeNull();

    await revokePowerUserSession(authSessionId);
    expect(await getActivePowerUserSession(authSessionId)).toBeNull();
    expect(await listActivePowerUserSessions('ws-pu-rev')).toHaveLength(0);
  });

  it('revoke is idempotent (a second revoke is a no-op, not an error)', async () => {
    const { authSessionId } = await createPowerUserSession({ workspaceId: 'ws-pu-idem', userId: 'user-3' });
    await revokePowerUserSession(authSessionId);
    await expect(revokePowerUserSession(authSessionId)).resolves.toBeUndefined();
  });

  it('lists active sessions for a workspace, newest-first, scoped', async () => {
    await createPowerUserSession({ workspaceId: 'ws-pu-list', userId: 'older' });
    await new Promise((r) => setTimeout(r, 25)); // distinct created_at
    await createPowerUserSession({ workspaceId: 'ws-pu-list', userId: 'newer' });
    await createPowerUserSession({ workspaceId: 'ws-pu-other', userId: 'elsewhere' });

    const rows = await listActivePowerUserSessions('ws-pu-list');
    expect(rows).toHaveLength(2);
    expect(rows[0].userId).toBe('newer'); // ORDER BY created_at DESC
    expect(rows[1].userId).toBe('older');
    // the other workspace's session is not included
    expect(rows.every((r) => r.workspaceId === 'ws-pu-list')).toBe(true);
  });
});
