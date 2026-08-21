/**
 * decision-owed-source.integration.test.ts — `readDecisionsOwed` against real
 * Postgres (EI-147). Follows the established org-fixture mock pattern (see
 * gate-store.integration.test.ts in this same dir).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

const { openOrTouchGate, closeGate } = await import('./gate-store');
const { readDecisionsOwed } = await import('./decision-owed-source');
const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('readDecisionsOwed (real PG, EI-147)', () => {
  let db: OrgTestDb;
  const ws = 'ws-decision-owed-test';

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function seedAdvSession(sessionId: string, ownerId: string) {
    await db.adminSql`
      INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, session_id, agent)
      VALUES (${ws}, 'console', ${ownerId}, ${sessionId}, 'claude')
    `;
  }

  async function seedDecisionCall(ownerId: string, invokedAt: string, toolName = 'plans:add-decision') {
    await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, invoked_at, status, coord_owner_id)
      VALUES (${ws}, 'papercusp', 'operator-core', ${toolName}, 'operator', 'spawn-1', 'w-1', ${invokedAt}, 'ok', ${ownerId})
    `;
  }

  it('flags a closed ask with no matching decision call, resolving the owner via adv_sessions', async () => {
    await seedAdvSession('sess-owed-1', 'su-owed-1');
    await openOrTouchGate({ workspaceId: ws, sessionId: 'sess-owed-1', client: 'claude', kind: 'ask', refId: 'r1', question: 'Co-locate the Queen?', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 'sess-owed-1', refId: 'r1', reason: 'tool_result_observed' });

    const owed = await readDecisionsOwed({ workspaceId: ws, sessionId: 'sess-owed-1' });
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ sessionId: 'sess-owed-1', refId: 'r1', ownerId: 'su-owed-1', question: 'Co-locate the Queen?' });
  });

  it('clears once the resolved owner calls plans:add-decision after the gate closes', async () => {
    await seedAdvSession('sess-owed-2', 'su-owed-2');
    await openOrTouchGate({ workspaceId: ws, sessionId: 'sess-owed-2', client: 'claude', kind: 'ask', refId: 'r2', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 'sess-owed-2', refId: 'r2', reason: 'tool_result_observed' });
    await seedDecisionCall('su-owed-2', new Date().toISOString());

    const owed = await readDecisionsOwed({ workspaceId: ws, sessionId: 'sess-owed-2' });
    expect(owed).toHaveLength(0);
  });

  it('plans:ratify-decision also counts as a recording call', async () => {
    await seedAdvSession('sess-owed-3', 'su-owed-3');
    await openOrTouchGate({ workspaceId: ws, sessionId: 'sess-owed-3', client: 'claude', kind: 'ask', refId: 'r3', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 'sess-owed-3', refId: 'r3', reason: 'tool_result_observed' });
    await seedDecisionCall('su-owed-3', new Date().toISOString(), 'plans:ratify-decision');

    const owed = await readDecisionsOwed({ workspaceId: ws, sessionId: 'sess-owed-3' });
    expect(owed).toHaveLength(0);
  });

  it('a session with no resolvable adv_sessions row is dropped, not false-flagged', async () => {
    await openOrTouchGate({ workspaceId: ws, sessionId: 'sess-owed-unresolved', client: 'claude', kind: 'ask', refId: 'r4', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 'sess-owed-unresolved', refId: 'r4', reason: 'tool_result_observed' });

    const owed = await readDecisionsOwed({ workspaceId: ws, sessionId: 'sess-owed-unresolved' });
    expect(owed).toHaveLength(0);
  });

  it('an unrelated owner recording a decision does not clear another owner\'s owed gate', async () => {
    await seedAdvSession('sess-owed-5', 'su-owed-5');
    await openOrTouchGate({ workspaceId: ws, sessionId: 'sess-owed-5', client: 'claude', kind: 'ask', refId: 'r5', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 'sess-owed-5', refId: 'r5', reason: 'tool_result_observed' });
    await seedDecisionCall('su-someone-else', new Date().toISOString());

    const owed = await readDecisionsOwed({ workspaceId: ws, sessionId: 'sess-owed-5' });
    expect(owed).toHaveLength(1);
  });

  it('workspace-wide read (no sessionId) returns owed gates across sessions', async () => {
    await seedAdvSession('sess-owed-6a', 'su-owed-6a');
    await seedAdvSession('sess-owed-6b', 'su-owed-6b');
    await openOrTouchGate({ workspaceId: ws, sessionId: 'sess-owed-6a', client: 'claude', kind: 'ask', refId: 'r6a', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 'sess-owed-6a', refId: 'r6a', reason: 'tool_result_observed' });
    await openOrTouchGate({ workspaceId: ws, sessionId: 'sess-owed-6b', client: 'claude', kind: 'ask', refId: 'r6b', source: 'watcher' });
    await closeGate({ workspaceId: ws, sessionId: 'sess-owed-6b', refId: 'r6b', reason: 'tool_result_observed' });

    const owed = await readDecisionsOwed({ workspaceId: ws });
    const refs = owed.map((o) => o.refId);
    expect(refs).toEqual(expect.arrayContaining(['r6a', 'r6b']));
  });
});
