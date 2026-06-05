import { describe, expect, it } from 'vitest';
import { computeNextState, DEFAULT_SPEND_STATE, type TtsSpendState } from './tts-spend';

const D = (date: string) => Date.parse(`${date}T12:00:00.000Z`);

describe('tts-spend computeNextState', () => {
  it('initializes spend on first call', () => {
    const u = computeNextState(DEFAULT_SPEND_STATE, 1000, D('2026-05-02'));
    expect(u.next.lastSpendDate).toBe('2026-05-02');
    expect(u.next.spend[0].chars).toBe(1000);
    expect(u.next.spend[0].estimatedUsd).toBeCloseTo(0.18, 3);
    expect(u.todayUsd).toBeCloseTo(0.18, 3);
    expect(u.fireSoftCap).toBe(false);
    expect(u.hardCapTripped).toBe(false);
  });

  it('accumulates within the same UTC day', () => {
    const s1 = computeNextState(DEFAULT_SPEND_STATE, 1000, D('2026-05-02')).next;
    const u2 = computeNextState(s1, 2000, D('2026-05-02'));
    expect(u2.next.spend[0].chars).toBe(3000);
    expect(u2.next.spend.length).toBe(1);
  });

  it('rolls over on UTC date change (prepends new day)', () => {
    const s1 = computeNextState(DEFAULT_SPEND_STATE, 1000, D('2026-05-02')).next;
    const u2 = computeNextState(s1, 500, D('2026-05-03'));
    expect(u2.next.spend[0].date).toBe('2026-05-03');
    expect(u2.next.spend[0].chars).toBe(500);
    expect(u2.next.spend[1].date).toBe('2026-05-02');
    expect(u2.next.spend[1].chars).toBe(1000);
  });

  it('caps spend history at 7 days', () => {
    let s: TtsSpendState = DEFAULT_SPEND_STATE;
    for (let i = 1; i <= 9; i++) {
      const date = `2026-05-0${i}`;
      s = computeNextState(s, 100, D(date)).next;
    }
    expect(s.spend.length).toBe(7);
    expect(s.spend[0].date).toBe('2026-05-09');
  });

  it('fires soft-cap toast on first crossing', () => {
    const cur: TtsSpendState = { ...DEFAULT_SPEND_STATE, softCapUsd: 1, hardCapUsd: 100 };
    // 1000 chars * $0.18/1k = $0.18. Need 5556 chars to cross $1.
    const u1 = computeNextState(cur, 5000, D('2026-05-02'));
    expect(u1.fireSoftCap).toBe(false);
    const u2 = computeNextState(u1.next, 1000, D('2026-05-02'));
    expect(u2.todayUsd).toBeGreaterThan(1);
    expect(u2.fireSoftCap).toBe(true);
    expect(u2.next.softCapAcknowledgedDate).toBe('2026-05-02');
  });

  it('does NOT re-fire soft-cap on subsequent same-day calls', () => {
    const cur: TtsSpendState = { ...DEFAULT_SPEND_STATE, softCapUsd: 1, hardCapUsd: 100 };
    const u1 = computeNextState(cur, 6000, D('2026-05-02'));
    expect(u1.fireSoftCap).toBe(true);
    const u2 = computeNextState(u1.next, 1000, D('2026-05-02'));
    expect(u2.fireSoftCap).toBe(false); // already ack'd today
  });

  it('soft-cap re-arms on date rollover', () => {
    const cur: TtsSpendState = { ...DEFAULT_SPEND_STATE, softCapUsd: 1, hardCapUsd: 100 };
    const u1 = computeNextState(cur, 6000, D('2026-05-02'));
    expect(u1.fireSoftCap).toBe(true);
    // Next day, fresh first call that crosses again
    const u2 = computeNextState(u1.next, 6000, D('2026-05-03'));
    expect(u2.fireSoftCap).toBe(true);
    expect(u2.next.softCapAcknowledgedDate).toBe('2026-05-03');
  });

  it('hard-cap trips on threshold crossing (caller decides to fall back)', () => {
    const cur: TtsSpendState = { ...DEFAULT_SPEND_STATE, softCapUsd: 1, hardCapUsd: 5 };
    const u1 = computeNextState(cur, 30000, D('2026-05-02'));
    expect(u1.todayUsd).toBeGreaterThan(5);
    expect(u1.hardCapTripped).toBe(true);
  });

  it('catches sleep-through-midnight via lastSpendDate field', () => {
    // Simulate machine asleep through 5/2 → wakes 5/3 12:00 UTC
    const cur = computeNextState(DEFAULT_SPEND_STATE, 1000, D('2026-05-02')).next;
    expect(cur.lastSpendDate).toBe('2026-05-02');
    const u = computeNextState(cur, 500, D('2026-05-04'));
    expect(u.next.lastSpendDate).toBe('2026-05-04');
    expect(u.next.spend[0].date).toBe('2026-05-04');
    expect(u.next.spend[0].chars).toBe(500);
  });

  it('respects user-overridden perKCharRate', () => {
    const cur: TtsSpendState = { ...DEFAULT_SPEND_STATE, perKCharRate: 0.30 }; // Starter tier
    const u = computeNextState(cur, 1000, D('2026-05-02'));
    expect(u.next.spend[0].estimatedUsd).toBeCloseTo(0.30, 3);
  });
});
