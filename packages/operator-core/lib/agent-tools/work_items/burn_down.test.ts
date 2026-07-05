import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WorkItem } from '../../work-items';

vi.mock('../../work-items', () => ({
  listWorkItems: vi.fn(),
}));

vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listPresence: vi.fn(),
  PRESENCE_STALE_MS: 60_000,
}));

import { listWorkItems } from '../../work-items';
import { listPresence } from '../coordination/presence';
import {
  buildBurnDownResult,
  liveOwnersFromPresence,
} from './burn_down';

const mockListWorkItems = vi.mocked(listWorkItems);
const mockListPresence = vi.mocked(listPresence);
const tool = (await import('./burn_down')).default;

function item(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 'WI-1',
    kind: 'task',
    family: 'issue',
    harness: 'papercusp',
    title: 'title',
    summary: 'summary',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    severity: 'minor',
    parent: null,
    payload: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    createdAt: '2026-07-05T20:00:00.000Z',
    updatedAt: '2026-07-05T20:00:00.000Z',
    ...overrides,
  };
}

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    tool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ data: unknown }> }
  ).handler(args, ctx);
}

describe('work_items:burn_down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies terminal, in-flight, parked, and unclaimed rows', () => {
    const result = buildBurnDownResult(
      [
        item({ id: 'WI-done', state: 'done', updatedAt: '2026-07-05T20:10:00.000Z' }),
        item({ id: 'EI-resolved', state: 'resolved', updatedAt: '2026-07-05T20:20:00.000Z' }),
        item({ id: 'WI-live', assignee: 'su-live', takenAt: '2026-07-05T20:01:00.000Z' }),
        item({ id: 'WI-dead', assignee: 'su-dead' }),
        item({ id: 'WI-blocked', state: 'blocked' }),
        item({ id: 'WI-held', payload: { _claimHold: true } }),
        item({ id: 'WI-open' }),
      ],
      new Set(['su-live']),
      {
        harness: 'papercusp',
        generatedAt: '2026-07-05T20:30:00.000Z',
        since: '2026-07-05T20:15:00.000Z',
      },
    );

    expect(result.terminal).toMatchObject({
      total: 2,
      done: 1,
      resolved: 1,
      delta: 1,
    });
    expect(result.inFlight.map((r) => [r.id, r.assigneeLive])).toEqual([
      ['WI-live', true],
      ['WI-dead', false],
    ]);
    expect(result.parked.map((r) => [r.id, r.mechanism, r.aliasedState])).toEqual([
      ['WI-blocked', 'blocked', undefined],
      ['WI-held', 'claimHold', 'open'],
    ]);
    expect(result.unclaimed.map((r) => r.id)).toEqual(['WI-open']);
    expect(result.counts).toEqual({
      total: 7,
      terminal: 2,
      inFlight: 2,
      parked: 2,
      unclaimed: 1,
    });
  });

  it('derives live owners from non-stale fresh presence rows', () => {
    const live = liveOwnersFromPresence(
      [
        { ownerId: 'fresh', heartbeatAt: '2026-07-05T20:00:59.000Z' },
        { ownerId: 'old', heartbeatAt: '2026-07-05T19:59:00.000Z' },
        { ownerId: 'flagged-stale', heartbeatAt: '2026-07-05T20:00:59.000Z', stale: true },
        { ownerId: 'bad-date', heartbeatAt: 'not-a-date' },
      ],
      Date.parse('2026-07-05T20:01:00.000Z'),
    );
    expect([...live]).toEqual(['fresh']);
  });

  it('wires the tool to list work-items and workspace-scoped presence', async () => {
    mockListWorkItems.mockResolvedValue([item({ id: 'WI-live', assignee: 'su-live' })]);
    mockListPresence.mockResolvedValue([
      {
        ownerId: 'su-live',
        ownerLabel: 'su live',
        heartbeatAt: new Date().toISOString(),
      } as never,
    ]);

    const res = await callTool({ harness: 'papercusp', includeChildren: true }, { workspaceId: 'ws-test' });

    expect(mockListWorkItems).toHaveBeenCalledWith({
      harness: 'papercusp',
      kind: undefined,
      includeChildren: true,
      limit: 2000,
    });
    expect(mockListPresence).toHaveBeenCalledWith({ workspaceId: 'ws-test' });
    expect(res.data).toMatchObject({
      ok: true,
      harness: 'papercusp',
      counts: { total: 1, terminal: 0, inFlight: 1, parked: 0, unclaimed: 0 },
    });
  });
});
