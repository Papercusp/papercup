/**
 * load-drain-stats.test.ts — EI-1618 / EI-1599 (Brief M / G-004).
 *
 * The drain-health read that makes the federation-status surface honest about
 * SYNC, not just boot/reach: a row undrained for a long time = content captured
 * but NOT federating (the EI-681 silent-stall boot-health hides). Assertions are
 * teeth-shaped — neuter the age math or the undrained filter and a test goes RED.
 */
import { describe, it, expect, vi } from 'vitest';
import { loadSubstrateDrainStats } from './load-drain-stats';

const NOW = 1_700_000_000_000;

describe('loadSubstrateDrainStats', () => {
  it('maps each (workspace, harness) to undrainedCount + age = now - MIN(ts)', async () => {
    const runQuery = vi.fn(async () => [
      { workspace_id: 'ws', harness_slug: 'a', undrained: '4', oldest_ts: String(NOW - 120_000) },
      { workspace_id: 'ws', harness_slug: 'b', undrained: '1', oldest_ts: String(NOW - 5_000) },
    ]);
    const map = await loadSubstrateDrainStats({ runQuery, nowMs: NOW });
    expect(map.get('ws::a')).toEqual({ undrainedCount: 4, oldestUndrainedAgeMs: 120_000 });
    expect(map.get('ws::b')).toEqual({ undrainedCount: 1, oldestUndrainedAgeMs: 5_000 });
  });

  it('queries ONLY undrained rows (drained_at IS NULL) grouped by scope', async () => {
    const runQuery = vi.fn(async () => []);
    await loadSubstrateDrainStats({ runQuery, nowMs: NOW });
    const sql = runQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/substrate_outbox/);
    expect(sql).toMatch(/drained_at IS NULL/);
    expect(sql).toMatch(/MIN\(ts\)/); // the real column is `ts`, NOT created_ts/captured_ts
    expect(sql).toMatch(/GROUP BY workspace_id, harness_slug/);
  });

  it('skips harnesses with a fully-drained outbox (0 undrained → absent from the map)', async () => {
    const runQuery = vi.fn(async () => [
      { workspace_id: 'ws', harness_slug: 'clean', undrained: '0', oldest_ts: null },
    ]);
    const map = await loadSubstrateDrainStats({ runQuery, nowMs: NOW });
    expect(map.has('ws::clean')).toBe(false);
  });

  it('clamps clock skew (capture ts ahead of now) to age 0, never negative', async () => {
    const runQuery = vi.fn(async () => [
      { workspace_id: 'ws', harness_slug: 'skew', undrained: '2', oldest_ts: String(NOW + 3_000) },
    ]);
    const map = await loadSubstrateDrainStats({ runQuery, nowMs: NOW });
    expect(map.get('ws::skew')).toEqual({ undrainedCount: 2, oldestUndrainedAgeMs: 0 });
  });

  it('null oldest_ts → undrained counted, age null (not measured)', async () => {
    const runQuery = vi.fn(async () => [
      { workspace_id: 'ws', harness_slug: 'n', undrained: '3', oldest_ts: null },
    ]);
    const map = await loadSubstrateDrainStats({ runQuery, nowMs: NOW });
    expect(map.get('ws::n')).toEqual({ undrainedCount: 3, oldestUndrainedAgeMs: null });
  });

  it('defensive: a query error → empty map (honest zero-drain, never throws)', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('relation "substrate_outbox" does not exist');
    });
    const map = await loadSubstrateDrainStats({ runQuery, nowMs: NOW });
    expect(map.size).toBe(0);
  });
});
