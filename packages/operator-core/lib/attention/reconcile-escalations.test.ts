import { describe, it, expect, vi, beforeEach } from 'vitest';

const listMock = vi.fn();
const batchMock = vi.fn();
vi.mock('../agent-tools/coordination/escalations', () => ({
  listEscalations: (...a: unknown[]) => listMock(...a),
  resolveEscalationsBatch: (...a: unknown[]) => batchMock(...a),
}));

import {
  selectStaleEscalations,
  reconcileStaleEscalationsOnce,
  type StaleEscalationInput,
} from './reconcile-escalations';

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

describe('reconcileStaleEscalationsOnce (P-003)', () => {
  beforeEach(() => {
    listMock.mockReset();
    batchMock.mockReset();
    // Default: the batch resolves everything it is handed.
    batchMock.mockImplementation((items: { msg_id: string }[]) =>
      Promise.resolve({ resolved: items.length, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 }),
    );
  });

  it('resolves only the stale operational escalations and reports counts', async () => {
    listMock.mockResolvedValue([
      row({ msg_id: 'old1', ts: iso(10 * DAY) }), // stale operational → resolve
      row({ msg_id: 'old2', ts: iso(20 * DAY) }), // stale operational → resolve
      row({ msg_id: 'fresh', ts: iso(1 * DAY) }), // too fresh → keep
      row({ msg_id: 'agent', from: 'bee-7', ts: iso(99 * DAY) }), // genuine → never
    ]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ scanned: 4, stale: 2, resolved: 2, truncated: false });
    // EI-1490: the sweep resolves the whole batch in ONE call (was one call per
    // item, each re-loading the entire escalation log — O(n²) over ~13k rows).
    expect(batchMock).toHaveBeenCalledTimes(1);
    const items = batchMock.mock.calls[0][0] as { msg_id: string; resolver: string }[];
    expect(items.map((i) => i.msg_id).sort()).toEqual(['old1', 'old2']);
    // stamps the reconcile owner so the resolution is attributable in the ledger
    expect(items[0].resolver).toBe('system:attention-reconcile');
  });

  it('respects the batch limit and reports truncated=true', async () => {
    listMock.mockResolvedValue([
      row({ msg_id: 'a', ts: iso(10 * DAY) }),
      row({ msg_id: 'b', ts: iso(20 * DAY) }),
      row({ msg_id: 'c', ts: iso(30 * DAY) }),
    ]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl, limit: 2 });
    expect(r).toMatchObject({ stale: 3, resolved: 2, truncated: true });
    // ONE batch call carrying exactly the limit-bounded slice.
    expect(batchMock).toHaveBeenCalledTimes(1);
    expect((batchMock.mock.calls[0][0] as unknown[]).length).toBe(2);
  });

  it('is idempotent: an already-resolved escalation is not counted as resolved', async () => {
    listMock.mockResolvedValue([row({ msg_id: 'gone', ts: iso(10 * DAY) })]);
    batchMock.mockResolvedValue({ resolved: 0, notFound: 0, alreadyResolved: 1, requiresSpawnApprove: 0 });
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 1, resolved: 0 });
  });

  it('makes NO batch call when there is nothing stale (empty sweep)', async () => {
    listMock.mockResolvedValue([row({ msg_id: 'fresh', ts: iso(1 * DAY) })]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
    expect(batchMock).not.toHaveBeenCalled();
  });
});
