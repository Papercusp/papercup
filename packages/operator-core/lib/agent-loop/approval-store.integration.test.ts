/**
 * approval-store.integration.test.ts — the loop HITL approval round-trip
 * against a REAL fully-migrated Postgres (migration 934).
 *
 * Same rationale as agent-chat-lock.integration.test.ts (its sibling in the
 * same bug class): the cross-worker property this table exists for — the SSE
 * worker polls a decision another worker wrote — is invisible to a mocked-sql
 * unit test BY CONSTRUCTION. The discriminating assertions here are (a) a
 * decision written on an INDEPENDENT connection unblocks a waiter polling on
 * the module's own connection, and (b) direct table reads pin that state
 * actually lives in PG.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const {
  awaitLoopApprovalDecision,
  createLoopApproval,
  listPendingLoopApprovals,
  resolveLoopApproval,
} = await import('./approval-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_loop_approvals`;
});

/** An independent connection — the stand-in for a second cluster worker
 *  serving the approval POST. */
function otherWorker(): Sql {
  return postgres(db.adminDsn, {
    max: 1,
    onnotice: () => {},
    prepare: false,
    connection: { search_path: 'harness_shared, public' },
  });
}

const REQ = {
  chatId: 'chat-1',
  callId: 'call-1',
  workspaceId: 'ws-1',
  toolName: 'capability:bash',
  toolInput: { command: 'echo hi' },
  stepIndex: 0,
};

describe('agent-loop approval store — real Postgres (migration 934)', () => {
  it('create → pending list shows the request with its tool payload', async () => {
    await createLoopApproval(REQ);
    const pending = await listPendingLoopApprovals({ chatId: 'chat-1', workspaceId: 'ws-1' });
    expect(pending).toHaveLength(1);
    expect(pending[0].callId).toBe('call-1');
    expect(pending[0].toolName).toBe('capability:bash');
    expect(pending[0].toolInput).toEqual({ command: 'echo hi' });
  });

  it('a decision resolved on a DIFFERENT connection unblocks the polling waiter (the clustered-worker shape)', async () => {
    await createLoopApproval(REQ);
    const worker2 = otherWorker();
    try {
      const waiter = awaitLoopApprovalDecision({
        chatId: 'chat-1',
        callId: 'call-1',
        workspaceId: 'ws-1',
        pollMs: 60,
        timeoutMs: 10_000,
      });
      // Give the waiter a poll cycle, then resolve from the "other worker".
      await new Promise((r) => setTimeout(r, 150));
      const resolved = await resolveLoopApproval(
        {
          chatId: 'chat-1',
          callId: 'call-1',
          workspaceId: 'ws-1',
          approved: true,
          resolvedBy: 'test:worker2',
        },
        { sql: worker2 },
      );
      expect(resolved).toBe(true);
      const decision = await waiter;
      expect(decision.approved).toBe(true);
      // Consumed: the row is gone after the waiter reads its decision.
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM harness_shared.agent_loop_approvals WHERE chat_id = 'chat-1'`;
      expect(Number(row?.n)).toBe(0);
    } finally {
      await worker2.end({ timeout: 5 });
    }
  });

  it('deny carries the reason through to the waiter', async () => {
    await createLoopApproval(REQ);
    const waiter = awaitLoopApprovalDecision({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      pollMs: 60,
      timeoutMs: 10_000,
    });
    await new Promise((r) => setTimeout(r, 120));
    await resolveLoopApproval({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      approved: false,
      reason: 'too risky',
    });
    const decision = await waiter;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('too risky');
  });

  it('resolve is a one-shot: the second resolve returns false (already resolved)', async () => {
    await createLoopApproval(REQ);
    const first = await resolveLoopApproval({
      chatId: 'chat-1', callId: 'call-1', workspaceId: 'ws-1', approved: true,
    });
    const second = await resolveLoopApproval({
      chatId: 'chat-1', callId: 'call-1', workspaceId: 'ws-1', approved: false,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('resolve refuses a workspace mismatch (scoping is part of the WHERE)', async () => {
    await createLoopApproval(REQ);
    const resolved = await resolveLoopApproval({
      chatId: 'chat-1', callId: 'call-1', workspaceId: 'OTHER-ws', approved: true,
    });
    expect(resolved).toBe(false);
  });

  it('timeout self-denies: the row leaves pending and the waiter gets a deny', async () => {
    await createLoopApproval(REQ);
    const decision = await awaitLoopApprovalDecision({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      pollMs: 40,
      timeoutMs: 120,
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('timed out');
    const pending = await listPendingLoopApprovals({ chatId: 'chat-1', workspaceId: 'ws-1' });
    expect(pending).toHaveLength(0);
  });

  it('abort self-denies promptly', async () => {
    await createLoopApproval(REQ);
    const ctrl = new AbortController();
    const waiter = awaitLoopApprovalDecision({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      pollMs: 40,
      timeoutMs: 10_000,
      signal: ctrl.signal,
    });
    await new Promise((r) => setTimeout(r, 60));
    ctrl.abort();
    const decision = await waiter;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('aborted');
  });

  it('a vanished row (age sweep) reads as an expired deny, never an approve', async () => {
    await createLoopApproval(REQ);
    await sql`DELETE FROM harness_shared.agent_loop_approvals`;
    const decision = await awaitLoopApprovalDecision({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      pollMs: 40,
      timeoutMs: 5_000,
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('expired');
  });
});
