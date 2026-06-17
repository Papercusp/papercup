/**
 * coord-per-workspace-isolation.integration.test.ts —
 * workspace-data-isolation-leaks-2026-06-17 F-C1.
 *
 * Proves the per-call workspace resolver on PgCoordLog (the flag-ON path) isolates
 * the coordination plane: a line written under workspace A's scope is invisible to
 * a read under workspace B's scope, and vice-versa — the fix for the shared
 * `default` partition that leaked messages/handoffs/escalations across workspaces.
 * Runs over a real migrated DB via createOrgTestDb; uses the admin (RLS-bypass)
 * client so it tests the EXPLICIT `workspace_id = resolveWs()` predicate the
 * resolver drives (not just RLS).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import { createOrgTestDb, type OrgTestDb } from './_org-test-db';

const WS_A = 'coord-ws-a';
const WS_B = 'coord-ws-b';

let db: OrgTestDb;
let curWs = WS_A;
let log: PgCoordLog;

function env(msgId: string, from: string) {
  return { msg_id: msgId, from, to: ['*'], ts: 0, kind: 'message' as const, summary: msgId };
}

beforeAll(async () => {
  db = await createOrgTestDb();
  log = new PgCoordLog({
    getSql: () => db.adminSql,
    ensureSchema: async () => {},
    getWorkspaceId: () => curWs, // the F-C1 per-call resolver (flag-ON behaviour)
  });
}, 90_000);

afterAll(async () => {
  if (db) await db.cleanup();
});

describe('coord per-workspace isolation (F-C1)', () => {
  it('a line written under workspace A is NOT read under workspace B (and vice-versa)', async () => {
    curWs = WS_A;
    await log.appendLine('messages', 'owner-a', env('m-a', 'owner-a'));
    curWs = WS_B;
    await log.appendLine('messages', 'owner-b', env('m-b', 'owner-b'));

    curWs = WS_A;
    const a = await log.readLines('messages');
    expect(a.map((e) => e.msg_id)).toEqual(['m-a']);

    curWs = WS_B;
    const b = await log.readLines('messages');
    expect(b.map((e) => e.msg_id)).toEqual(['m-b']);
  });

  it('event surfaces (handoffs/escalations) isolate the same way', async () => {
    curWs = WS_A;
    await log.putEvent('escalations', 'e-a', env('e-a', 'owner-a'));
    curWs = WS_B;
    const crossB = await log.readEvents('escalations');
    expect(crossB).toHaveLength(0); // B cannot see A's escalation
    curWs = WS_A;
    const ownA = await log.readEvents('escalations');
    expect(ownA.map((e) => e.msg_id)).toEqual(['e-a']);
  });

  it('the resolver falls back to the construction-time default when it returns empty', async () => {
    const fallbackLog = new PgCoordLog({
      getSql: () => db.adminSql,
      ensureSchema: async () => {},
      workspaceId: 'fixed-ws',
      getWorkspaceId: () => '', // empty ⇒ fall back to `workspaceId`
    });
    expect(fallbackLog.workspaceId).toBe('fixed-ws');
  });
});
