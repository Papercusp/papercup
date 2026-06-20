/**
 * reconcile-handoffs.test.ts — the PURE stale-pending-handoff selector (F-FIX-037).
 * Pins the 12h TTL gate, oldest-first ordering, the inclusive boundary, custom-TTL
 * override, and malformed-ts skipping. The effectful pass
 * (reconcileStalePendingHandoffsOnce) writes sibling 'handoff_expired' records via the
 * coord log; the open↔expired fold semantics are pinned in the generic foldHandoffs
 * test (pubsub-substrate/src/core/handoffs.test.ts) — here we keep selection honest.
 */
import { describe, expect, it } from 'vitest';
import {
  selectStalePendingHandoffs,
  STALE_HANDOFF_TTL_MS,
  type StalePendingHandoffInput,
} from './reconcile-handoffs';

const NOW = Date.parse('2026-06-20T12:00:00Z');
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

describe('selectStalePendingHandoffs', () => {
  it('selects only handoffs older than the 12h default TTL, oldest first', () => {
    const opens: StalePendingHandoffInput[] = [
      { msg_id: 'fresh-1h', ts: hoursAgo(1) },
      { msg_id: 'edge-just-under', ts: hoursAgo(11.9) },
      { msg_id: 'stale-13h', ts: hoursAgo(13) },
      { msg_id: 'stale-30h', ts: hoursAgo(30) },
    ];
    expect(selectStalePendingHandoffs(opens, { nowMs: NOW }).map((s) => s.msg_id)).toEqual([
      'stale-30h',
      'stale-13h',
    ]);
  });

  it('the TTL boundary is inclusive (age >= ttl is stale)', () => {
    const atTtl: StalePendingHandoffInput[] = [
      { msg_id: 'at-ttl', ts: new Date(NOW - STALE_HANDOFF_TTL_MS).toISOString() },
    ];
    expect(selectStalePendingHandoffs(atTtl, { nowMs: NOW }).map((s) => s.msg_id)).toEqual(['at-ttl']);
  });

  it('respects a custom ttlMs override', () => {
    const opens: StalePendingHandoffInput[] = [{ msg_id: 'h2h', ts: hoursAgo(2) }];
    expect(selectStalePendingHandoffs(opens, { nowMs: NOW, ttlMs: 60 * 60 * 1000 })).toHaveLength(1); // 1h TTL → 2h stale
    expect(selectStalePendingHandoffs(opens, { nowMs: NOW, ttlMs: 24 * 60 * 60 * 1000 })).toHaveLength(0); // 24h TTL → not yet
  });

  it('skips a malformed timestamp instead of throwing', () => {
    const opens: StalePendingHandoffInput[] = [
      { msg_id: 'bad', ts: 'not-a-date' },
      { msg_id: 'good', ts: hoursAgo(20) },
    ];
    expect(selectStalePendingHandoffs(opens, { nowMs: NOW }).map((s) => s.msg_id)).toEqual(['good']);
  });

  it('reports ageHours for a selected handoff', () => {
    const [s] = selectStalePendingHandoffs([{ msg_id: 'h', ts: hoursAgo(20) }], { nowMs: NOW });
    expect(Math.round(s.ageHours)).toBe(20);
  });

  it('returns [] for an empty input', () => {
    expect(selectStalePendingHandoffs([], { nowMs: NOW })).toEqual([]);
  });
});
