import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface AuditRow {
  id: string;
  ts: number;
  actor: string;
  action: string;
  subject: string;
  details: unknown;
  workspaceId: string;
}
const rows: AuditRow[] = [];

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: async () => {} }));
vi.mock('./operator-standing-candidates', () => ({ refreshCandidates: async () => {} }));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: () => ({
    insert: () => ({
      values: async (row: AuditRow) => {
        rows.push({ ...row, actor: 'system:operator' });
      },
    }),
  }),
}));

vi.mock('@papercusp/db-org', () => ({
  withWorkspace: async (_ws: string, cb: (tx: unknown) => Promise<unknown>) => cb({}),
  generated: { auditLogInHarnessShared: { id: {}, ts: {}, actor: {}, action: {}, subject: {}, details: {}, workspace_id: {} } },
}));

import { writeOperatorAudit } from './operator-audit';

beforeEach(() => { rows.length = 0; });
afterEach(() => { rows.length = 0; });

describe('writeOperatorAudit', () => {
  it('persists a card_id + kind + actor_method tuple', async () => {
    await writeOperatorAudit({ cardId: 'c1', kind: 'accepted', actorMethod: 'click' });
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('c1');
    expect(rows[0].action).toBe('operator.accepted');
    expect(rows[0].actor).toBe('system:operator');
    const d = rows[0].details as Record<string, unknown>;
    expect(d.card_id).toBe('c1');
    expect(d.kind).toBe('accepted');
    expect(d.actor_method).toBe('click');
  });

  it('defaults actor_method to null', async () => {
    await writeOperatorAudit({ cardId: 'c2', kind: 'ignored' });
    const d = rows[0].details as Record<string, unknown>;
    expect(d.actor_method).toBeNull();
  });

  it('merges context into details', async () => {
    await writeOperatorAudit({
      cardId: 'c3',
      kind: 'accept_failed',
      context: { capability: 'messages:write', target: 'foo' },
    });
    const d = rows[0].details as Record<string, unknown>;
    expect(d.capability).toBe('messages:write');
    expect(d.target).toBe('foo');
    // Context can't override the canonical fields:
    expect(d.card_id).toBe('c3');
  });

  it('namespaces the action with operator. prefix per kind', async () => {
    await writeOperatorAudit({ cardId: 'c4', kind: 'undo_cancel' });
    expect(rows[0].action).toBe('operator.undo_cancel');
  });

  it('writes one row per call (multiple invocations accumulate)', async () => {
    await writeOperatorAudit({ cardId: 'a', kind: 'accepted' });
    await writeOperatorAudit({ cardId: 'b', kind: 'ignored' });
    await writeOperatorAudit({ cardId: 'c', kind: 'undo_cancel' });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.subject)).toEqual(['a', 'b', 'c']);
  });

  it('stamps each row with workspace_id', async () => {
    await writeOperatorAudit({ cardId: 'c5', kind: 'accepted' });
    // SUT writes the drizzle camelCase column key `workspaceId` (maps to the
    // snake_case DB column) after the raw-sql→Drizzle migration.
    expect(rows[0].workspaceId).toBe('test-ws');
  });

  it('respects an explicit `at` timestamp in details (not the row ts)', async () => {
    await writeOperatorAudit({ cardId: 'c6', kind: 'accepted', at: '2026-01-01T00:00:00Z' });
    const d = rows[0].details as Record<string, unknown>;
    expect(d.at).toBe('2026-01-01T00:00:00Z');
  });
});
