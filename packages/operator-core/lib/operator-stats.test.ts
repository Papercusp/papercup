import { describe, expect, it, vi } from 'vitest';

vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));

const auditRows: { ts: number; action: string; subject: string; details?: { actor_method?: string } }[] = [];
vi.mock('@papercusp/db-org', () => ({
  withWorkspace: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(((..._args: unknown[]) => auditRows) as unknown),
}));
vi.mock('./operator-budget', () => ({
  loadBudget: () => ({ dailyCapUsd: 20, spend: [{ date: '2026-05-01', usd: 1.5 }, { date: '2026-05-02', usd: 0.5 }] }),
}));

import { readOperatorStats } from './operator-stats';

describe('readOperatorStats', () => {
  it('aggregates counts and computes median ack latency', async () => {
    const now = Date.now();
    auditRows.length = 0;
    auditRows.push(
      // 3 dispatched + 3 consumed pairs at 1s, 2s, 3s latency
      { ts: now - 60_000, action: 'operator.dispatched', subject: 'a' },
      { ts: now - 59_000, action: 'operator.consumed',   subject: 'a' },
      { ts: now - 50_000, action: 'operator.dispatched', subject: 'b' },
      { ts: now - 48_000, action: 'operator.consumed',   subject: 'b' },
      { ts: now - 40_000, action: 'operator.dispatched', subject: 'c' },
      { ts: now - 37_000, action: 'operator.consumed',   subject: 'c' },
      // 1 dismissed
      { ts: now - 30_000, action: 'operator.dismissed', subject: 'd' },
      // 1 escalated (also has a dispatched)
      { ts: now - 20_000, action: 'operator.dispatched', subject: 'e' },
      { ts: now - 10_000, action: 'operator.escalated', subject: 'e' },
    );

    const s = await readOperatorStats();
    expect(s.cardsTotal).toBe(5);
    expect(s.dispatched).toBe(4);
    expect(s.consumed).toBe(3);
    expect(s.dismissed).toBe(1);
    expect(s.escalated).toBe(1);
    expect(s.medianAckLatencyMs).toBe(2_000);
    expect(s.totalSpendUsd).toBe(2);
  });

  it('returns null medianAckLatencyMs with fewer than 3 samples', async () => {
    const now = Date.now();
    auditRows.length = 0;
    auditRows.push(
      { ts: now - 5_000, action: 'operator.dispatched', subject: 'a' },
      { ts: now - 4_000, action: 'operator.consumed', subject: 'a' },
    );
    const s = await readOperatorStats();
    expect(s.medianAckLatencyMs).toBeNull();
  });

  it('flags >25% unconsumed when receivers are slow', async () => {
    const now = Date.now();
    auditRows.length = 0;
    // 4 dispatched > 2 min ago, only 1 consumed → 75% unconsumed
    for (const id of ['a', 'b', 'c', 'd']) {
      auditRows.push({ ts: now - 5 * 60_000, action: 'operator.dispatched', subject: id });
    }
    auditRows.push({ ts: now - 4 * 60_000, action: 'operator.consumed', subject: 'a' });
    const s = await readOperatorStats();
    expect(s.unconsumedFraction).toBeGreaterThan(0.25);
  });

  it('breaks down user actions by actor_method (voice/click/api/unspecified)', async () => {
    const now = Date.now();
    auditRows.length = 0;
    auditRows.push(
      { ts: now - 50_000, action: 'operator.dispatched', subject: 'a', details: { actor_method: 'voice' } },
      { ts: now - 40_000, action: 'operator.dispatched', subject: 'b', details: { actor_method: 'voice' } },
      { ts: now - 30_000, action: 'operator.dispatched', subject: 'c', details: { actor_method: 'click' } },
      { ts: now - 20_000, action: 'operator.dismissed',  subject: 'd', details: { actor_method: 'api' } },
      { ts: now - 10_000, action: 'operator.undo_cancel', subject: 'e' }, // no method
      // Receiving-state flips should NOT count toward user actions:
      { ts: now -  5_000, action: 'operator.consumed',  subject: 'a', details: { actor_method: 'voice' } },
    );
    const s = await readOperatorStats();
    expect(s.byActorMethod).toEqual({ voice: 2, click: 1, api: 1, unspecified: 1 });
  });
});
