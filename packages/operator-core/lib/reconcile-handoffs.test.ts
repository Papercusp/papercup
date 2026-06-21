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
  selectRepingableHandoffs,
  STALE_HANDOFF_TTL_MS,
  STALE_HANDOFF_REPING_MS,
  type StalePendingHandoffInput,
  type RepingableHandoffInput,
} from './reconcile-handoffs';

const NOW = Date.parse('2026-06-20T12:00:00Z');
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const minsAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

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

// ── coord-dispatch-reliability P-003: the 30m offerer re-ping selector ──────────
const rh = (over: Partial<RepingableHandoffInput> & { msg_id: string; ts: string }): RepingableHandoffInput => ({
  from: 'su-offerer',
  repinged: false,
  ...over,
});

describe('selectRepingableHandoffs', () => {
  it('selects open handoffs in the [30m, 12h) window, oldest first', () => {
    const opens: RepingableHandoffInput[] = [
      rh({ msg_id: 'fresh-10m', ts: minsAgo(10) }), // too young
      rh({ msg_id: 'just-under-30m', ts: minsAgo(29) }), // too young
      rh({ msg_id: 'win-45m', ts: minsAgo(45) }),
      rh({ msg_id: 'win-3h', ts: hoursAgo(3) }),
      rh({ msg_id: 'expired-13h', ts: hoursAgo(13) }), // past TTL → the EXPIRE pass owns it
    ];
    expect(selectRepingableHandoffs(opens, { nowMs: NOW }).map((s) => s.msg_id)).toEqual([
      'win-3h', // oldest in-window first
      'win-45m',
    ]);
  });

  it('the lower bound is inclusive (age >= repingMs) and the TTL bound is exclusive', () => {
    const atReping = rh({ msg_id: 'at-30m', ts: new Date(NOW - STALE_HANDOFF_REPING_MS).toISOString() });
    const atTtl = rh({ msg_id: 'at-12h', ts: new Date(NOW - STALE_HANDOFF_TTL_MS).toISOString() });
    expect(selectRepingableHandoffs([atReping], { nowMs: NOW }).map((s) => s.msg_id)).toEqual(['at-30m']);
    // exactly at the TTL belongs to the expire pass, not the re-ping pass.
    expect(selectRepingableHandoffs([atTtl], { nowMs: NOW })).toEqual([]);
  });

  it('excludes an already-re-pinged handoff (one nudge per handoff)', () => {
    const opens: RepingableHandoffInput[] = [
      rh({ msg_id: 'already', ts: minsAgo(90), repinged: true }),
      rh({ msg_id: 'not-yet', ts: minsAgo(90), repinged: false }),
    ];
    expect(selectRepingableHandoffs(opens, { nowMs: NOW }).map((s) => s.msg_id)).toEqual(['not-yet']);
  });

  it('respects custom repingMs / ttlMs overrides', () => {
    const opens: RepingableHandoffInput[] = [rh({ msg_id: 'h10m', ts: minsAgo(10) })];
    // 5m re-ping window → 10m is in-window
    expect(selectRepingableHandoffs(opens, { nowMs: NOW, repingMs: 5 * 60_000 })).toHaveLength(1);
    // 20m re-ping window → 10m too young
    expect(selectRepingableHandoffs(opens, { nowMs: NOW, repingMs: 20 * 60_000 })).toHaveLength(0);
    // a tight ttl that falls below the age excludes it from re-ping (expire pass owns it)
    expect(
      selectRepingableHandoffs(opens, { nowMs: NOW, repingMs: 5 * 60_000, ttlMs: 8 * 60_000 }),
    ).toHaveLength(0);
  });

  it('honours the batch limit via slice at the call site (selector returns all, sorted)', () => {
    const opens: RepingableHandoffInput[] = [
      rh({ msg_id: 'a', ts: minsAgo(40) }),
      rh({ msg_id: 'b', ts: minsAgo(60) }),
      rh({ msg_id: 'c', ts: minsAgo(50) }),
    ];
    const sel = selectRepingableHandoffs(opens, { nowMs: NOW });
    expect(sel.map((s) => s.msg_id)).toEqual(['b', 'c', 'a']); // oldest first
    expect(sel.slice(0, 2).map((s) => s.msg_id)).toEqual(['b', 'c']); // batch-limit honoured at call site
  });

  it('skips a malformed timestamp instead of throwing', () => {
    const opens: RepingableHandoffInput[] = [
      rh({ msg_id: 'bad', ts: 'not-a-date' }),
      rh({ msg_id: 'good', ts: minsAgo(45) }),
    ];
    expect(selectRepingableHandoffs(opens, { nowMs: NOW }).map((s) => s.msg_id)).toEqual(['good']);
  });

  it('carries from/plan_slug/to + ageMinutes through for the re-ping prose', () => {
    const [s] = selectRepingableHandoffs(
      [rh({ msg_id: 'h', ts: minsAgo(45), from: 'su-bob', plan_slug: 'plan-x', to: ['su-alice'] })],
      { nowMs: NOW },
    );
    expect(s).toMatchObject({ msg_id: 'h', from: 'su-bob', plan_slug: 'plan-x', to: ['su-alice'] });
    expect(Math.round(s.ageMinutes)).toBe(45);
  });

  it('returns [] for an empty input', () => {
    expect(selectRepingableHandoffs([], { nowMs: NOW })).toEqual([]);
  });
});
