/**
 * cross-hive-outbox-drain.test.ts — unit tests for the backoff-aware drain
 * (hive-network-surface-2026-06-11 P-001, brief B-01): the pure per-peer
 * planning (eligibility from attempt_count/last_attempt_at, force-peer
 * override, oldest-first grouping) and the executor's no-hot-loop discipline
 * (one dial per offline peer per pass; later peers unaffected).
 */
import { describe, expect, it } from 'vitest';
import {
  DRAIN_BACKOFF_BASE_MS,
  DRAIN_BACKOFF_CAP_MS,
  drainBackoffMs,
  drainCrossHiveOutboxOnce,
  planOutboxDrain,
  type DrainableOutbox,
} from './cross-hive-outbox-drain';
import type { CrossHiveWireEnvelope } from './cross-hive-transport';
import type { DetailedPendingEnvelope } from './cross-hive-outbox-pg';

const env = (id: string, to: string): CrossHiveWireEnvelope => ({
  id,
  fromHivePubkey: 'self',
  toHivePubkey: to,
  kind: 'ask',
  subject: `s-${id}`,
  body: `b-${id}`,
  sig: 'sig',
});

const row = (id: string, to: string, attemptCount = 0, lastAttemptAt = 0): DetailedPendingEnvelope => ({
  env: env(id, to),
  attemptCount,
  lastAttemptAt,
});

function fakeOutbox(rows: DetailedPendingEnvelope[]) {
  const delivered: string[] = [];
  const attempts: string[] = [];
  const outbox: DrainableOutbox = {
    async pendingDetailed() {
      return rows;
    },
    async markDelivered(id) {
      delivered.push(id);
    },
    async noteAttempt(id) {
      attempts.push(id);
    },
  };
  return { outbox, delivered, attempts };
}

/** A transport whose reachability is per-peer; records every send attempt. */
function fakeTransport(upPeers: Set<string>) {
  const sends: Array<{ to: string; id: string }> = [];
  return {
    sends,
    transport: {
      async send(to: string, e: CrossHiveWireEnvelope) {
        sends.push({ to, id: e.id });
        if (!upPeers.has(to)) throw new Error('peer offline');
      },
    },
  };
}

describe('drainBackoffMs — exponential from attempt_count, capped', () => {
  it('is 0 before any failed attempt, base after one, doubling, capped', () => {
    expect(drainBackoffMs(0)).toBe(0);
    expect(drainBackoffMs(1)).toBe(DRAIN_BACKOFF_BASE_MS);
    expect(drainBackoffMs(2)).toBe(2 * DRAIN_BACKOFF_BASE_MS);
    expect(drainBackoffMs(3)).toBe(4 * DRAIN_BACKOFF_BASE_MS);
    expect(drainBackoffMs(50)).toBe(DRAIN_BACKOFF_CAP_MS);
  });
  it('honors custom base/cap', () => {
    expect(drainBackoffMs(2, 100, 1000)).toBe(200);
    expect(drainBackoffMs(10, 100, 1000)).toBe(1000);
  });
});

describe('planOutboxDrain — per-peer eligibility windows', () => {
  it('never-attempted peers are eligible immediately, grouped oldest-first', () => {
    const plan = planOutboxDrain([row('m1', 'P'), row('m2', 'P'), row('n1', 'Q')], { nowMs: 1000 });
    expect([...plan.attempts.keys()].sort()).toEqual(['P', 'Q']);
    expect(plan.attempts.get('P')!.map((e) => e.id)).toEqual(['m1', 'm2']);
    expect(plan.backedOff).toEqual([]);
  });

  it('a peer inside its backoff window is skipped; past the window it is eligible', () => {
    const failedAt = 100_000;
    const rows = [row('m1', 'P', 1, failedAt), row('m2', 'P')];
    const inside = planOutboxDrain(rows, { nowMs: failedAt + DRAIN_BACKOFF_BASE_MS - 1 });
    expect(inside.attempts.size).toBe(0);
    expect(inside.backedOff).toEqual(['P']);
    const past = planOutboxDrain(rows, { nowMs: failedAt + DRAIN_BACKOFF_BASE_MS });
    expect(past.attempts.get('P')!.map((e) => e.id)).toEqual(['m1', 'm2']);
  });

  it("the window derives from the peer's MAX attempt_count + most recent last_attempt_at", () => {
    const rows = [row('m1', 'P', 3, 50_000), row('m2', 'P', 1, 90_000)];
    // attempts=3 → 4×base window, anchored at the most recent attempt (90s).
    const justInside = planOutboxDrain(rows, { nowMs: 90_000 + 4 * DRAIN_BACKOFF_BASE_MS - 1 });
    expect(justInside.backedOff).toEqual(['P']);
    const justPast = planOutboxDrain(rows, { nowMs: 90_000 + 4 * DRAIN_BACKOFF_BASE_MS });
    expect(justPast.attempts.has('P')).toBe(true);
  });

  it('forcePeers (the reconnect trigger) overrides the backoff window', () => {
    const rows = [row('m1', 'P', 5, 100_000), row('n1', 'Q', 5, 100_000)];
    const plan = planOutboxDrain(rows, { nowMs: 100_001, forcePeers: new Set(['P']) });
    expect([...plan.attempts.keys()]).toEqual(['P']);
    expect(plan.backedOff).toEqual(['Q']);
  });
});

describe('drainCrossHiveOutboxOnce — delivery + no-hot-loop discipline', () => {
  it('delivers an up peer oldest-first and removes each envelope', async () => {
    const { outbox, delivered, attempts } = fakeOutbox([row('m1', 'P'), row('m2', 'P')]);
    const t = fakeTransport(new Set(['P']));
    const out = await drainCrossHiveOutboxOnce({ outbox, transport: t.transport, nowMs: 1 });
    expect(out).toMatchObject({ delivered: 2, failedPeers: [], backedOffPeers: [], pending: 0 });
    expect(t.sends.map((s) => s.id)).toEqual(['m1', 'm2']);
    expect(delivered).toEqual(['m1', 'm2']);
    expect(attempts).toEqual([]);
  });

  it('an offline peer costs exactly ONE dial: head envelope noted, queue abandoned, ordering kept', async () => {
    const { outbox, delivered, attempts } = fakeOutbox([row('m1', 'P'), row('m2', 'P'), row('m3', 'P')]);
    const t = fakeTransport(new Set());
    const out = await drainCrossHiveOutboxOnce({ outbox, transport: t.transport, nowMs: 1 });
    expect(out).toMatchObject({ delivered: 0, failedPeers: ['P'], pending: 3 });
    expect(t.sends).toHaveLength(1); // no hot-loop: one dial for the whole queue
    expect(attempts).toEqual(['m1']); // one noteAttempt, on the queue head
    expect(delivered).toEqual([]);
  });

  it("one peer's failure does not stop another peer's delivery", async () => {
    const { outbox, delivered } = fakeOutbox([row('m1', 'P'), row('n1', 'Q'), row('n2', 'Q')]);
    const t = fakeTransport(new Set(['Q']));
    const out = await drainCrossHiveOutboxOnce({ outbox, transport: t.transport, nowMs: 1 });
    expect(out).toMatchObject({ delivered: 2, failedPeers: ['P'], pending: 1 });
    expect(delivered).toEqual(['n1', 'n2']);
  });

  it('a backed-off peer is not dialed at all', async () => {
    const { outbox } = fakeOutbox([row('m1', 'P', 1, 100_000)]);
    const t = fakeTransport(new Set(['P']));
    const out = await drainCrossHiveOutboxOnce({
      outbox,
      transport: t.transport,
      nowMs: 100_000 + DRAIN_BACKOFF_BASE_MS - 1,
    });
    expect(out).toMatchObject({ delivered: 0, backedOffPeers: ['P'], pending: 1 });
    expect(t.sends).toHaveLength(0);
  });

  it('forcePeers drains a backed-off peer immediately (the reconnect path)', async () => {
    const { outbox, delivered } = fakeOutbox([row('m1', 'P', 4, 100_000)]);
    const t = fakeTransport(new Set(['P']));
    const out = await drainCrossHiveOutboxOnce({
      outbox,
      transport: t.transport,
      nowMs: 100_001,
      forcePeers: ['P'],
    });
    expect(out).toMatchObject({ delivered: 1, pending: 0 });
    expect(delivered).toEqual(['m1']);
  });
});
