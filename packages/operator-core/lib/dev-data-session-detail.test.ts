import { beforeEach, describe, expect, it, vi } from 'vitest';

// getSessionDetail's related_chats block (WI-5383: migrated off getLegacyClient)
// now reads via harnessQuery, while the spawned_agents / tool_invocations /
// children queries still go through getOrgPg()'s tagged-template `sql`. Mock
// both, spreading the real module so any OTHER export dev-data.ts imports from
// '@papercusp/db-org' keeps working (this module is a protected full-replacement-
// mock target per scripts/check-full-replacement-mocks.mjs). The tagged-template
// `sql` fake also carries a `.begin` stub — required by that same script's
// org-pg-sql-double guard (WI-40234), since production org clients support
// transactions even though this function never calls .begin.
const dbMocks = vi.hoisted(() => ({
  harnessQuery: vi.fn(),
  orgSql: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  harnessQuery: dbMocks.harnessQuery,
  getOrgPg: () => ({ sql: Object.assign(dbMocks.orgSql, { begin: vi.fn() }) }),
}));

import { getSessionDetail } from './dev-data';

// The three getOrgPg() tagged-template calls getSessionDetail makes, in order:
// spawned_agents (1), tool_invocations (2), spawned_agents children (3).
const AGENT_ROW = {
  spawn_id: 'spawn-1',
  workspace_id: 'ws-1',
  harness_slug: 'papercusp',
  parent_spawn_id: null,
  parent_role: null,
  child_role: null,
  feature_id: 'F-100',
  chunk_id: null,
  run_id: null,
  status: 'ok',
  started_at: '2026-09-01T00:00:00.000Z',
  finished_at: null,
  duration_ms: null,
  exit_code: null,
  output_tail: null,
  error_message: null,
  cancel_requested: false,
};

describe('getSessionDetail related_chats', () => {
  const unsafe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    unsafe.mockResolvedValue([]);
    // harnessQuery's callback receives a postgres.js-shaped `sql` handle;
    // the related_chats block only calls `.unsafe(text, params)` on it, so a
    // fake exposing just that method is enough to observe what was sent.
    dbMocks.harnessQuery.mockImplementation(async (_slug: string, fn: any) => fn({ unsafe }));
    dbMocks.orgSql
      .mockResolvedValueOnce([AGENT_ROW]) // spawned_agents
      .mockResolvedValueOnce([]) // tool_invocations
      .mockResolvedValueOnce([]); // children
  });

  it('queries agent_chats by feature_id and converts the bigint epoch-ms updated_at to an ISO string', async () => {
    unsafe.mockResolvedValueOnce([
      { id: 'chat-1', role: 'planner', title: 'Plan A', updated_at: 1788400000000n },
    ]);

    const detail = await getSessionDetail('spawn-1');

    expect(dbMocks.harnessQuery).toHaveBeenCalledWith('papercusp', expect.any(Function));
    const sql = String(unsafe.mock.calls[0]?.[0]).replace(/\s+/g, ' ').trim();
    expect(sql).toContain('FROM agent_chats WHERE feature_id = $1');
    // Direct-mode regression: the same single positional bind the old
    // `.prepare(...).all(agent.feature_id)` (`?` placeholder) sent — proving
    // the `?` -> `$1` translation preserved both the SQL text and the bind.
    expect(unsafe.mock.calls[0]?.[1]).toEqual(['F-100']);
    expect(detail?.related_chats).toEqual([
      {
        id: 'chat-1',
        role: 'planner',
        title: 'Plan A',
        updated_at: new Date(1788400000000).toISOString(),
      },
    ]);
  });

  it('maps a null updated_at to an empty string rather than throwing', async () => {
    unsafe.mockResolvedValueOnce([
      { id: 'chat-2', role: 'worker', title: null, updated_at: null },
    ]);

    const detail = await getSessionDetail('spawn-1');

    expect(detail?.related_chats).toEqual([
      { id: 'chat-2', role: 'worker', title: null, updated_at: '' },
    ]);
  });

  it('swallows a query failure and returns an empty related_chats list (behavior unchanged from the getLegacyClient path)', async () => {
    unsafe.mockRejectedValueOnce(new Error('boom'));

    const detail = await getSessionDetail('spawn-1');

    expect(detail?.related_chats).toEqual([]);
  });

  it('skips the harnessQuery lookup entirely when the agent has no feature_id', async () => {
    dbMocks.orgSql.mockReset();
    dbMocks.orgSql
      .mockResolvedValueOnce([{ ...AGENT_ROW, feature_id: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const detail = await getSessionDetail('spawn-1');

    expect(dbMocks.harnessQuery).not.toHaveBeenCalled();
    expect(detail?.related_chats).toEqual([]);
  });
});
