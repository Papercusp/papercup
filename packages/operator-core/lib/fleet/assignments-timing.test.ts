import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ended: vi.fn(),
  live: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: vi.fn(),
}));
vi.mock('../adv-sessions', () => ({
  endedRecordedOwnerIds: state.ended,
  recordedLiveOwnerIds: state.live,
}));

import { getOrgPg } from '@papercusp/db-org';
import { mockOrgPgSql } from '../testing/mock-org-pg';
import { namedQueryStageTimings, withNamedQueryDiagnosticContext } from '../agent-tools/db-diagnostic-correlation-wiring';
import { listFleetAssignments } from './assignments';

const rows = [{
  source: 'work_item_claim', workspace_id: 'test-roster-timing', agent_id: 'owner-a',
  holder_present: true, holder_alive: true, orphaned: false, claim_active: true,
}];

beforeEach(() => {
  vi.clearAllMocks();
  state.ended.mockResolvedValue(new Set());
  state.live.mockResolvedValue(new Set());
  state.sql.mockResolvedValue(rows);
  mockOrgPgSql(vi.mocked(getOrgPg), state.sql);
});

it('distinguishes a pending assignment query from owner hydration on the same request', async () => {
  let release!: (value: typeof rows) => void;
  state.sql.mockReturnValue(new Promise<typeof rows>(resolve => { release = resolve; }));
  await withNamedQueryDiagnosticContext('advRoster.list', async () => {
    const pending = listFleetAssignments({ workspaceId: 'test-roster-timing' });
    expect(namedQueryStageTimings()?.stages).toEqual([
      expect.objectContaining({ stage: 'fleet-assignments-sql', outcome: 'pending' }),
    ]);
    expect(state.ended).not.toHaveBeenCalled();
    expect(state.live).not.toHaveBeenCalled();
    release(rows);
    expect(await pending).toMatchObject([{ agentId: 'owner-a', holderAlive: true, orphaned: false }]);
    expect(namedQueryStageTimings()?.stages.map(({ stage, outcome }) => ({ stage, outcome }))).toEqual([
      { stage: 'fleet-assignments-sql', outcome: 'fulfilled' },
      { stage: 'fleet-assignments-ended-owners', outcome: 'fulfilled' },
      { stage: 'fleet-assignments-live-owners', outcome: 'fulfilled' },
    ]);
  });
});

it('retains the pending hydration leg after its SQL and independent sibling have finished', async () => {
  let release!: (value: Set<string>) => void;
  state.ended.mockReturnValueOnce(new Promise<Set<string>>(resolve => { release = resolve; }));
  await withNamedQueryDiagnosticContext('advRoster.list', async () => {
    const pending = listFleetAssignments({ workspaceId: 'test-roster-timing' });
    await vi.waitFor(() => expect(namedQueryStageTimings()?.stages).toContainEqual(
      expect.objectContaining({ stage: 'fleet-assignments-live-owners', outcome: 'fulfilled' }),
    ));
    expect(namedQueryStageTimings()?.stages).toContainEqual(
      expect.objectContaining({ stage: 'fleet-assignments-sql', outcome: 'fulfilled' }),
    );
    expect(namedQueryStageTimings()?.stages).toContainEqual(
      expect.objectContaining({ stage: 'fleet-assignments-ended-owners', outcome: 'pending' }),
    );
    release(new Set());
    expect(await pending).toMatchObject([{ agentId: 'owner-a', holderAlive: true, orphaned: false }]);
  });
});

it('preserves a query failure and does not report unstarted hydration as successful', async () => {
  const failure = new Error('assignment read failed');
  state.sql.mockImplementation(() => { throw failure; });
  await withNamedQueryDiagnosticContext('advRoster.list', async () => {
    await expect(listFleetAssignments()).rejects.toBe(failure);
    expect(namedQueryStageTimings()?.stages).toEqual([
      expect.objectContaining({ stage: 'fleet-assignments-sql', outcome: 'rejected' }),
    ]);
    expect(state.ended).not.toHaveBeenCalled();
    expect(state.live).not.toHaveBeenCalled();
  });
});
