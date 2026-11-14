import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const resolveGoalHolders = vi.hoisted(() => vi.fn());
vi.mock('./goals/holder', () => ({ resolveGoalHolders }));
import {
  makeGoalReportReferenceReads, validateGoalReportReferenceSnapshot,
  type GoalReportReferenceReads,
} from './goal-owner-report-reference';
import { goalOwnerReportFixture } from '../test/fixtures/goal-owner-report';

const workspaceId = 'ws-report';
const goalId = 'goal-report';
const expectedAt = '2026-10-05T21:00:00.000Z';

describe('canonical GOAL report wake ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['loop', 'event'] as const)('refuses a %s wake for a dead or unresolved holder before consulting stale registrations', async (kind) => {
    resolveGoalHolders.mockResolvedValue({ live: [] });
    const sql = vi.fn(async () => [{ id: 1, event_key: 'report-ready', expires_ts: expectedAt }]);
    const reads = makeGoalReportReferenceReads(sql as unknown as Sql, workspaceId, goalId);
    expect(await reads.wake({ kind, ref: 'report-ready', evidenceRef: 'await:1', expectedAt })).toBe(false);
    expect(resolveGoalHolders).toHaveBeenCalledWith(sql, { workspaceId, goalId });
    expect(sql).not.toHaveBeenCalled();
  });

  it.each(['loop', 'event'] as const)('binds a %s registration to the elected live holder', async (kind) => {
    resolveGoalHolders.mockResolvedValue({ live: [{ ownerId: 'live-holder' }] });
    const sql = vi.fn(async () => kind === 'loop'
      ? [{ id: 'routine-report', next_fire_at: expectedAt, updated_at: '2026-10-05T20:00:00.000Z' }]
      : [{ id: 1, event_key: 'report-ready', expires_ts: expectedAt }]);
    const reads = makeGoalReportReferenceReads(sql as unknown as Sql, workspaceId, goalId);
    expect(await reads.wake({ kind, ref: kind === 'loop' ? 'routine-report' : 'report-ready',
      evidenceRef: kind === 'loop' ? 'routine:routine-report@2026-10-05T20:00:00.000Z' : 'await:1', expectedAt })).toBe(true);
    expect(sql.mock.calls[0]).toEqual(expect.arrayContaining([workspaceId, goalId, 'live-holder']));
  });
});

describe('independent report-reference admission controls', () => {
  type Snapshot = ReturnType<typeof goalOwnerReportFixture>;
  const capture = () => {
    // Capture authoritative answers before changing the submitted report. A shared
    // object here would make the negative controls agree with their own tampering.
    const current = structuredClone(goalOwnerReportFixture(workspaceId));
    const submitted = structuredClone(current);
    const reads: GoalReportReferenceReads = {
      source: vi.fn(async (ref) => current.sources.find((source) => source.ref === ref) ?? null),
      cost: vi.fn(async () => current.cost),
      ownerWalls: vi.fn(async () => current.ownerWalls),
      movement: vi.fn(async (ref) => current.moved.find((movement) => movement.ref === ref) ?? null),
      wake: vi.fn(async () => true),
      killed: vi.fn(async () => true),
    };
    return { submitted, reads, now: Date.parse(current.observedAt) + 60_000 };
  };

  it('admits the unchanged valid control against independently captured current reads', async () => {
    const { submitted, reads, now } = capture();
    await expect(validateGoalReportReferenceSnapshot(submitted, reads, now)).resolves.toBeUndefined();
  });

  const cases: Array<{
    name: string;
    change: (submitted: Snapshot, reads: GoalReportReferenceReads) => void;
    oracle: string;
  }> = [
    {
      name: 'a substituted source generation',
      change: (submitted) => { submitted.sources[0]!.revision = 'substituted-generation'; },
      oracle: 'source-generation:goal:goal-expandable-reports',
    },
    {
      name: 'an unreadable critical current source',
      change: (_submitted, reads) => { vi.mocked(reads.source).mockResolvedValue(null); },
      oracle: 'source-generation:goal:goal-expandable-reports',
    },
    {
      name: 'an unmeasured current cost',
      change: (submitted, reads) => {
        vi.mocked(reads.cost).mockResolvedValue({ ...submitted.cost, spentCents: null });
      },
      oracle: 'current-measured-cost',
    },
    {
      name: 'a substituted measured cost',
      change: (submitted) => { submitted.cost.spentCents = 0; },
      oracle: 'current-measured-cost',
    },
    {
      name: 'an omitted current owner action',
      change: (submitted) => { submitted.ownerWalls.pop(); },
      oracle: 'complete-exact-owner-actions',
    },
    {
      name: 'a changed Unicode suffix of an owner action',
      change: (submitted) => { submitted.ownerWalls[2]!.exactAction += ' — 承認'; },
      oracle: 'complete-exact-owner-actions',
    },
    {
      name: 'a substituted successful movement receipt',
      change: (submitted) => {
        submitted.moved[0]!.successfulMutations[0]!.receiptRef = 'receipt:substituted';
      },
      oracle: 'movement-receipts:WI-completed',
    },
    {
      name: 'a wake without a current live registration',
      change: (_submitted, reads) => { vi.mocked(reads.wake).mockResolvedValue(false); },
      oracle: 'next-wake-evidence',
    },
    {
      name: 'an unverifiable historical stop',
      change: (_submitted, reads) => { vi.mocked(reads.killed).mockResolvedValue(false); },
      oracle: 'historical-disposition:plan:old-direction',
    },
  ];

  it.each(cases)('refuses $name against the unchanged current control', async ({ change, oracle }) => {
    const { submitted, reads, now } = capture();
    change(submitted, reads);
    await expect(validateGoalReportReferenceSnapshot(submitted, reads, now)).rejects.toMatchObject({
      code: 'goal-owner-report-untruthful', oracle,
    });
  });
});
