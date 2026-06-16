import { describe, it, expect } from 'vitest';
import { selectStaleEscalations, type StaleEscalationInput } from './reconcile-escalations';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY; // a fixed "now" far from epoch
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ttl = 3 * DAY;

function row(over: Partial<StaleEscalationInput>): StaleEscalationInput {
  return { msg_id: 'm', from: 'system:hive-placement-watchdog', options: [], ts: iso(10 * DAY), ...over };
}

describe('selectStaleEscalations (P-003/P-005)', () => {
  it('selects an operational system escalation older than the TTL', () => {
    const r = selectStaleEscalations([row({ msg_id: 'old' })], { nowMs: NOW, ttlMs: ttl });
    expect(r.map((x) => x.msg_id)).toEqual(['old']);
    expect(r[0].ageDays).toBeCloseTo(10, 1);
  });

  it('skips an operational escalation younger than the TTL', () => {
    const r = selectStaleEscalations([row({ msg_id: 'fresh', ts: iso(1 * DAY) })], { nowMs: NOW, ttlMs: ttl });
    expect(r).toEqual([]);
  });

  it('NEVER selects a genuine agent escalation (non-system sender), even if ancient', () => {
    const r = selectStaleEscalations([row({ msg_id: 'agent', from: 'bee-7', ts: iso(99 * DAY) })], { nowMs: NOW, ttlMs: ttl });
    expect(r).toEqual([]);
  });

  it('NEVER selects a system escalation that carries options (a real choice)', () => {
    const r = selectStaleEscalations(
      [row({ msg_id: 'choice', options: [{ id: 'a' }], ts: iso(99 * DAY) })],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r).toEqual([]);
  });

  it('treats both bare `system` and `system:<emitter>` as operational', () => {
    const r = selectStaleEscalations(
      [row({ msg_id: 'bare', from: 'system' }), row({ msg_id: 'wd', from: 'system:hive-placement-watchdog' })],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id).sort()).toEqual(['bare', 'wd']);
  });

  it('skips rows with an unparseable timestamp (no crash)', () => {
    const r = selectStaleEscalations([row({ msg_id: 'bad', ts: 'not-a-date' })], { nowMs: NOW, ttlMs: ttl });
    expect(r).toEqual([]);
  });

  it('returns oldest-first so a batch-limited sweep drains the longest-stale first', () => {
    const r = selectStaleEscalations(
      [row({ msg_id: 'a', ts: iso(5 * DAY) }), row({ msg_id: 'b', ts: iso(40 * DAY) }), row({ msg_id: 'c', ts: iso(12 * DAY) })],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id)).toEqual(['b', 'c', 'a']);
  });
});
