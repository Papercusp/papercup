import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STT_SPEND_STATE,
  computeNextSttState,
  type SttSpendState,
} from './stt-spend';

const T0 = Date.UTC(2026, 4, 2, 12, 0, 0);
const T1 = Date.UTC(2026, 4, 3, 12, 0, 0);

function fresh(): SttSpendState {
  return { ...DEFAULT_STT_SPEND_STATE };
}

describe('computeNextSttState', () => {
  it('accumulates minutes within the same day', () => {
    const a = computeNextSttState(fresh(), 10, T0);
    const b = computeNextSttState(a.next, 5, T0);
    expect(b.next.spend[0].minutes).toBe(15);
    expect(b.todayUsd).toBeCloseTo(15 * 0.0043, 6);
  });

  it('rolls over on UTC date change', () => {
    const a = computeNextSttState(fresh(), 100, T0);
    const b = computeNextSttState(a.next, 1, T1);
    expect(b.next.spend.length).toBe(2);
    expect(b.next.spend[0].date).toBe('2026-05-03');
    expect(b.next.spend[1].date).toBe('2026-05-02');
  });

  it('fires soft-cap exactly once per day', () => {
    let s = fresh();
    s = computeNextSttState(s, 230, T0).next; // ~$0.989, below $1
    const cross = computeNextSttState(s, 5, T0); // ~$1.01, above $1
    expect(cross.fireSoftCap).toBe(true);
    expect(cross.next.softCapAcknowledgedDate).toBe('2026-05-02');
    const after = computeNextSttState(cross.next, 1, T0);
    expect(after.fireSoftCap).toBe(false);
  });

  it('re-arms soft-cap after rollover', () => {
    let s = fresh();
    s = computeNextSttState(s, 250, T0).next; // crosses
    s = computeNextSttState(s, 1, T0).next;   // ack'd same-day
    const day2 = computeNextSttState(s, 250, T1);
    expect(day2.fireSoftCap).toBe(true);
  });

  it('flags hard cap independent of ack', () => {
    let s = fresh();
    const r = computeNextSttState(s, 1300, T0); // ~$5.59
    expect(r.hardCapTripped).toBe(true);
  });

  it('caps spend list at 7 days', () => {
    let s = fresh();
    let day = T0;
    for (let i = 0; i < 10; i++) {
      s = computeNextSttState(s, 1, day).next;
      day += 86400000;
    }
    expect(s.spend.length).toBe(7);
  });

  it('respects custom perMinuteRate', () => {
    const cur: SttSpendState = { ...fresh(), perMinuteRate: 0.01 };
    const r = computeNextSttState(cur, 10, T0);
    expect(r.todayUsd).toBeCloseTo(0.1, 6);
  });
});
