import { test } from 'vitest';
import assert from 'node:assert/strict';
import { queenWakeEfficiency } from './queen-wake-efficiency';

function rows(...rs: Array<Partial<Record<string, number | string | null>>>) {
  return rs.map((r) => ({
    run_id: (r.run_id as string) ?? 'r',
    ts: r.ts ?? 0,
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    cache_read_tokens: r.cache_read_tokens ?? 0,
    cache_creation_tokens: r.cache_creation_tokens ?? 0,
    cost_usd: r.cost_usd ?? null,
    turn_count: r.turn_count ?? null,
  }));
}

test('queenWakeEfficiency — aggregates tokens + cache-hit ratio across wakes (P-010)', async () => {
  const out = await queenWakeEfficiency('ws', {
    deps: {
      fetchSamples: async () =>
        rows(
          { run_id: 'w1', ts: 200, input_tokens: 1000, cache_read_tokens: 8000, cache_creation_tokens: 1000, output_tokens: 500, cost_usd: 0.12 },
          { run_id: 'w2', ts: 100, input_tokens: 2000, cache_read_tokens: 0, cache_creation_tokens: 5000, output_tokens: 300, cost_usd: 0.20 },
        ),
    },
  });
  assert.equal(out.wakes, 2);
  assert.equal(out.totalInputTokens, 3000);
  assert.equal(out.totalCacheReadTokens, 8000);
  assert.equal(out.totalCacheCreationTokens, 6000);
  assert.equal(out.totalOutputTokens, 800);
  assert.ok(Math.abs(out.totalCostUsd - 0.32) < 1e-9);
  // cache_read / (cache_read + cache_creation + input) = 8000 / (8000+6000+3000) = 8000/17000.
  assert.ok(Math.abs(out.cacheHitRatio - 8000 / 17000) < 1e-9);
});

test('queenWakeEfficiency — cachedWakes counts wakes with non-zero cache_read (P-003 "cache is real" signal)', async () => {
  const out = await queenWakeEfficiency('ws', {
    deps: {
      fetchSamples: async () =>
        rows(
          { run_id: 'w1', cache_read_tokens: 5000, input_tokens: 100 }, // cached
          { run_id: 'w2', cache_read_tokens: 0, cache_creation_tokens: 4000, input_tokens: 200 }, // cold (first wake / TTL expired)
          { run_id: 'w3', cache_read_tokens: 3000, input_tokens: 50 }, // cached
        ),
    },
  });
  assert.equal(out.wakes, 3);
  assert.equal(out.cachedWakes, 2);
});

test('queenWakeEfficiency — avgTurns averages over wakes that reported a turn count (P-010 Win-2)', async () => {
  const out = await queenWakeEfficiency('ws', {
    deps: {
      fetchSamples: async () =>
        rows(
          { run_id: 'w1', turn_count: 3, cache_read_tokens: 100 },
          { run_id: 'w2', turn_count: 5, cache_read_tokens: 100 },
          { run_id: 'w3', turn_count: null, cache_read_tokens: 100 }, // not reported — excluded from avg
        ),
    },
  });
  assert.equal(out.samples[0].turns, 3);
  assert.equal(out.samples[2].turns, null);
  assert.equal(out.avgTurns, 4); // (3+5)/2, the null wake excluded
});

test('queenWakeEfficiency — avgTurns is null when no wake reported a turn count', async () => {
  const out = await queenWakeEfficiency('ws', {
    deps: { fetchSamples: async () => rows({ run_id: 'w1', cache_read_tokens: 100 }) },
  });
  assert.equal(out.avgTurns, null);
});

test('queenWakeEfficiency — empty window is zeros, ratio 0 (never NaN)', async () => {
  const out = await queenWakeEfficiency('ws', { deps: { fetchSamples: async () => [] } });
  assert.equal(out.wakes, 0);
  assert.equal(out.cachedWakes, 0);
  assert.equal(out.cacheHitRatio, 0);
  assert.deepEqual(out.samples, []);
});

test('queenWakeEfficiency — coerces string-typed PG numerics', async () => {
  const out = await queenWakeEfficiency('ws', {
    deps: {
      fetchSamples: async () => rows({ run_id: 'w1', ts: '150', input_tokens: '1000', cache_read_tokens: '9000', cost_usd: '0.5' }),
    },
  });
  assert.equal(out.totalInputTokens, 1000);
  assert.equal(out.totalCacheReadTokens, 9000);
  assert.equal(out.samples[0].tsMs, 150);
  assert.ok(Math.abs(out.totalCostUsd - 0.5) < 1e-9);
  // 9000 / (9000 + 0 + 1000) = 0.9
  assert.ok(Math.abs(out.cacheHitRatio - 0.9) < 1e-9);
});
