/**
 * gate-store.integration.test.ts — session_pending_gates (migration 619) against
 * real Postgres. Follows the established org-fixture mock pattern (see
 * operator-report-source.integration.test.ts in this same dir).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

const { openOrTouchGate, closeGate, closeGateByToolUseId, listPendingGates, listClosedAskGatesSince } = await import(
  './gate-store'
);
const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('gate-store (real PG)', () => {
  let db: OrgTestDb;
  const ws = 'ws-gate-test';

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('opens a fresh gate and reports it in listPendingGates', async () => {
    const { id, outcome } = await openOrTouchGate({
      workspaceId: ws,
      sessionId: 's1',
      client: 'claude',
      kind: 'ask',
      refId: 'ref-1',
      question: 'Pick one?',
      options: [{ label: 'A' }],
      source: 'watcher',
    });
    expect(outcome).toBe('opened');
    expect(id).toBeTruthy();

    const open = await listPendingGates({ workspaceId: ws, sessionId: 's1' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ session_id: 's1', ref_id: 'ref-1', question: 'Pick one?', closed_at: null });
  });

  it('re-observing the same ref is idempotent (already_open, no duplicate row)', async () => {
    const first = await openOrTouchGate({
      workspaceId: ws,
      sessionId: 's2',
      client: 'claude',
      kind: 'ask',
      refId: 'ref-2',
      source: 'watcher',
    });
    expect(first.outcome).toBe('opened');
    const second = await openOrTouchGate({
      workspaceId: ws,
      sessionId: 's2',
      client: 'claude',
      kind: 'ask',
      refId: 'ref-2',
      source: 'watcher',
    });
    expect(second.outcome).toBe('already_open');
    expect(second.id).toBe(first.id);

    const rows = await listPendingGates({ workspaceId: ws, sessionId: 's2', includeClosed: true });
    expect(rows).toHaveLength(1);
  });

  it('closeGate closes an open gate and is idempotent on a second close', async () => {
    await openOrTouchGate({ workspaceId: ws, sessionId: 's3', client: 'omp', kind: 'permission_wait', refId: 'ref-3', source: 'hook' });
    const closed = await closeGate({ workspaceId: ws, sessionId: 's3', refId: 'ref-3', reason: 'hook_cleared' });
    expect(closed).toBe('closed');
    const again = await closeGate({ workspaceId: ws, sessionId: 's3', refId: 'ref-3', reason: 'hook_cleared' });
    expect(again).toBe('already_closed');

    const open = await listPendingGates({ workspaceId: ws, sessionId: 's3' });
    expect(open).toHaveLength(0);
  });

  it('closeGate on a never-opened ref reports not_found', async () => {
    const result = await closeGate({ workspaceId: ws, sessionId: 's-missing', refId: 'ref-missing', reason: 'hook_cleared' });
    expect(result).toBe('not_found');
  });

  it('a re-observation after close never reopens the gate (WHERE-guarded conflict update)', async () => {
    await openOrTouchGate({ workspaceId: ws, sessionId: 's4', client: 'claude', kind: 'ask', refId: 'ref-4', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 's4', refId: 'ref-4', reason: 'tool_result_observed' });
    const reopenAttempt = await openOrTouchGate({ workspaceId: ws, sessionId: 's4', client: 'claude', kind: 'ask', refId: 'ref-4', source: 'watcher' });
    expect(reopenAttempt.outcome).toBe('already_open');
    const rows = await listPendingGates({ workspaceId: ws, sessionId: 's4', includeClosed: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closed_at).not.toBeNull();
  });

  it('closeGateByToolUseId closes all open gates for a session by ref (watcher path)', async () => {
    await openOrTouchGate({ workspaceId: ws, sessionId: 's5', client: 'claude', kind: 'ask', refId: 'toolu_x', source: 'watcher' });
    const closedCount = await closeGateByToolUseId({ workspaceId: ws, sessionId: 's5', toolUseId: 'toolu_x' });
    expect(closedCount).toBe(1);
    expect(await closeGateByToolUseId({ workspaceId: ws, sessionId: 's5', toolUseId: 'toolu_x' })).toBe(0);
  });

  it('listPendingGates scopes by workspace and orders oldest-first by default', async () => {
    await openOrTouchGate({ workspaceId: ws, sessionId: 's6', client: 'claude', kind: 'ask', refId: 'r-old', source: 'watcher' });
    await new Promise((r) => setTimeout(r, 5));
    await openOrTouchGate({ workspaceId: ws, sessionId: 's6', client: 'claude', kind: 'ask', refId: 'r-new', source: 'watcher' });
    await openOrTouchGate({ workspaceId: 'ws-other', sessionId: 's6', client: 'claude', kind: 'ask', refId: 'r-other-ws', source: 'watcher' });

    const rows = await listPendingGates({ workspaceId: ws, sessionId: 's6' });
    expect(rows.map((r) => r.ref_id)).toEqual(['r-old', 'r-new']);

    const newestFirst = await listPendingGates({ workspaceId: ws, sessionId: 's6', order: 'newest' });
    expect(newestFirst.map((r) => r.ref_id)).toEqual(['r-new', 'r-old']);
  });

  it('listClosedAskGatesSince returns only CLOSED ask gates within the window, newest-first (EI-147)', async () => {
    await openOrTouchGate({ workspaceId: ws, sessionId: 's7', client: 'claude', kind: 'ask', refId: 'r7-open', source: 'watcher' });
    await openOrTouchGate({ workspaceId: ws, sessionId: 's7', client: 'claude', kind: 'ask', refId: 'r7-closed-old', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 's7', refId: 'r7-closed-old', reason: 'tool_result_observed' });
    await new Promise((r) => setTimeout(r, 5));
    await openOrTouchGate({ workspaceId: ws, sessionId: 's7', client: 'claude', kind: 'permission_wait', refId: 'r7-perm', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 's7', refId: 'r7-perm', reason: 'hook_cleared' });
    await new Promise((r) => setTimeout(r, 5));
    await openOrTouchGate({ workspaceId: ws, sessionId: 's7', client: 'claude', kind: 'ask', refId: 'r7-closed-new', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 's7', refId: 'r7-closed-new', reason: 'tool_result_observed' });

    const sinceIso = new Date(Date.now() - 3_600_000).toISOString();
    const rows = await listClosedAskGatesSince({ workspaceId: ws, sinceIso });
    const forS7 = rows.filter((r) => r.session_id === 's7');
    // r7-open is still open (excluded); r7-perm is closed but kind='permission_wait' (excluded).
    expect(forS7.map((r) => r.ref_id)).toEqual(['r7-closed-new', 'r7-closed-old']);
  });

  it('listClosedAskGatesSince excludes closes older than sinceIso', async () => {
    await openOrTouchGate({ workspaceId: ws, sessionId: 's8', client: 'claude', kind: 'ask', refId: 'r8', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 's8', refId: 'r8', reason: 'tool_result_observed' });

    const futureSinceIso = new Date(Date.now() + 3_600_000).toISOString();
    const rows = await listClosedAskGatesSince({ workspaceId: ws, sinceIso: futureSinceIso });
    expect(rows.some((r) => r.session_id === 's8')).toBe(false);
  });
});
