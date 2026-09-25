import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { LoopStatus } from '../harness/routines/loop';
import type { GoalHolderRow } from './holder';
import {
  readGoalHolderFirstTurnAttestation,
  type GoalHolderAttestationDeps,
} from './holder-attestation';

const holder: GoalHolderRow = {
  workspaceId: 'ws', goalId: 'goal-a', ownerId: 'su-holder', setAtMs: 10_000,
};
const sql = {} as Sql;

function deps(): GoalHolderAttestationDeps {
  return {
    readLoop: vi.fn(async () => ({ active: true, ownerId: 'su-holder', harnessSlug: 'hive' }) as LoopStatus),
    readCheckpoint: vi.fn(async () => ({ note: 'continuing goal-a', updatedAtMs: 11_000, readFailed: false })),
    readAct: vi.fn(async () => ({ tool: 'plans:new', at: new Date(12_000).toISOString() })),
  };
}

describe('GOAL holder first-turn attestation', () => {
  it('requires the typed GOAL subject and accepts an elected holder with loop, checkpoint, and act', async () => {
    const d = deps();
    const complete = await readGoalHolderFirstTurnAttestation(sql, { workspaceId: 'ws', goalId: 'goal-a', holder }, d);
    expect(complete.status).toBe('complete');
    expect(complete.portfolioAct?.tool).toBe('plans:new');
    expect(d.readAct).toHaveBeenCalledWith(sql, 'ws', 'goal-a', 'su-holder', 10_000);

    const wrong = await readGoalHolderFirstTurnAttestation(sql, {
      workspaceId: 'ws', goalId: 'goal-b', holder,
    }, d);
    expect(wrong).toMatchObject({ status: 'partial', missing: ['goal-declaration'] });
    expect(d.readLoop).toHaveBeenCalledTimes(1);
  });

  it('does not accept a pre-election checkpoint or a holder who has only read and reported', async () => {
    const d = deps();
    d.readCheckpoint = vi.fn(async () => ({ note: 'old', updatedAtMs: 9_000, readFailed: false }));
    d.readAct = vi.fn(async () => null);
    const result = await readGoalHolderFirstTurnAttestation(sql, { workspaceId: 'ws', goalId: 'goal-a', holder }, d);
    expect(result).toMatchObject({ status: 'partial', missing: ['checkpoint', 'portfolio-act'] });
  });

  it('preserves unknown when a ledger read fails, even if another leg is missing', async () => {
    const d = deps();
    d.readLoop = vi.fn(async () => null);
    d.readAct = vi.fn(async () => { throw new Error('ledger down'); });
    const result = await readGoalHolderFirstTurnAttestation(sql, { workspaceId: 'ws', goalId: 'goal-a', holder }, d);
    expect(result).toMatchObject({
      status: 'unknown', missing: ['loop', 'checkpoint'], unavailable: ['portfolio-act'],
    });
    expect(d.readCheckpoint).not.toHaveBeenCalled();
  });
});
