/**
 * Unit coverage for agent-usage-telemetry (rate-limit-layer-v2 D-002). The two
 * collaborators — org PG (`getOrgPg().sql`) and model pricing (`costFromTokens`)
 * — are mocked so we can assert the *shape* of what gets persisted (or that
 * nothing does) without a real database. The `sql` tagged template captures the
 * interpolated VALUES of the INSERT so we can inspect the finite-guard mapping,
 * cost-source derivation and rate-limit header parsing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above module-scope consts, so the spies must be.
const { sqlCalls, costFromTokens, sqlShouldThrow } = vi.hoisted(() => ({
  // Each tagged-template INSERT pushes { text, values } here.
  sqlCalls: [] as { text: string; values: unknown[] }[],
  costFromTokens: vi.fn((_model: string, _usage: unknown): { usd: number; priced: boolean } => ({
    usd: 0,
    priced: false,
  })),
  // Flip true to make getOrgPg().sql throw, exercising the best-effort swallow.
  sqlShouldThrow: { value: false },
}));

vi.mock('@papercusp/model-pricing', () => ({ costFromTokens }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('@papercusp/db-org', () => {
  // `sql` is used two ways: as a tagged template (the INSERT) and as a plain
  // call `sql(TABLE)` to interpolate the table identifier. We model the latter
  // as a sentinel object that stringifies to the table name inside the captured
  // text, and the former captures the interpolated runtime values.
  function sql(strings: TemplateStringsArray | string, ...values: unknown[]): unknown {
    if (typeof strings === 'string') {
      // sql(TABLE) — identifier interpolation. Return a sentinel that renders
      // the table name when joined into the template text.
      return { __ident: strings, toString: () => strings };
    }
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? String(values[i] ?? '') : ''),
      '',
    );
    if (sqlShouldThrow.value) throw new Error('pg exploded');
    sqlCalls.push({ text, values });
    return Promise.resolve([]);
  }
  return { getOrgPg: () => ({ sql }) };
});

import {
  recordUsageSample,
  recordUsageHeaders,
  recordUsageTokens,
  type UsageSample,
} from './agent-usage-telemetry';

// Column order of the INSERT VALUES(...) — used to read a captured value by name.
const COLS = [
  'workspace_id',
  'ts',
  'bucket_key',
  'provider',
  'model_class',
  'source',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_usd',
  'model',
  'cost_source',
  'harness_slug',
  'run_id',
  'role',
  'rl_requests_limit',
  'rl_requests_remaining',
  'rl_tokens_limit',
  'rl_tokens_remaining',
  'rl_reset_at',
] as const;

type Col = (typeof COLS)[number];

/** Read a persisted column from the (single) captured INSERT. The first
 *  interpolated value is the `${sql(TABLE)}` identifier sentinel, so the column
 *  values start at index 1 and line up with COLS thereafter. */
function lastInsert(): Record<Col, unknown> {
  expect(sqlCalls).toHaveLength(1);
  const cols = sqlCalls[0].values.slice(1);
  const out = {} as Record<Col, unknown>;
  COLS.forEach((c, i) => {
    out[c] = cols[i];
  });
  return out;
}

beforeEach(() => {
  sqlCalls.length = 0;
  sqlShouldThrow.value = false;
  costFromTokens.mockReset();
  costFromTokens.mockReturnValue({ usd: 0, priced: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordUsageTokens (jsonl skip guard)', () => {
  it('returns without writing when inputTokens, outputTokens, and costUsd are all undefined', async () => {
    await recordUsageTokens('b', 'anthropic', 'opus', { cacheReadTokens: 10 });
    expect(sqlCalls).toHaveLength(0);
  });

  it("writes a source:'jsonl' sample when any of the three is present", async () => {
    await recordUsageTokens('bucket', 'anthropic', 'opus', { outputTokens: 5 });
    const row = lastInsert();
    expect(row.source).toBe('jsonl');
    expect(row.bucket_key).toBe('bucket');
    expect(row.output_tokens).toBe(5);
  });

  it('writes when only costUsd is present (zero tokens still a real call)', async () => {
    costFromTokens.mockReturnValue({ usd: 0, priced: false });
    await recordUsageTokens('b', 'anthropic', 'opus', { costUsd: 0.42 });
    const row = lastInsert();
    expect(row.cost_usd).toBe(0.42);
    expect(row.cost_source).toBe('provider');
  });
});

describe('recordUsageHeaders (rate-limit header parsing)', () => {
  it('falls back to anthropic-ratelimit-input-tokens-* when the non-input variants are absent', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'anthropic-ratelimit-input-tokens-limit': '1000',
      'anthropic-ratelimit-input-tokens-remaining': '250',
    });
    const row = lastInsert();
    expect(row.rl_tokens_limit).toBe(1000);
    expect(row.rl_tokens_remaining).toBe(250);
  });

  it('prefers the non-input variants over the input-* fallback when both present', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'anthropic-ratelimit-tokens-limit': '9000',
      'anthropic-ratelimit-input-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '8000',
      'anthropic-ratelimit-input-tokens-remaining': '250',
    });
    const row = lastInsert();
    expect(row.rl_tokens_limit).toBe(9000);
    expect(row.rl_tokens_remaining).toBe(8000);
  });

  it('normalizes mixed-case header keys (lowercases before lookup)', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'Anthropic-RateLimit-Tokens-Limit': '777',
      'ANTHROPIC-RATELIMIT-REQUESTS-LIMIT': '40',
    });
    const row = lastInsert();
    expect(row.rl_tokens_limit).toBe(777);
    expect(row.rl_requests_limit).toBe(40);
  });

  it('parses a valid ISO reset header into an epoch-ms number', async () => {
    const iso = '2026-06-15T12:00:00.000Z';
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'anthropic-ratelimit-tokens-limit': '100',
      'anthropic-ratelimit-tokens-reset': iso,
    });
    const row = lastInsert();
    expect(row.rl_reset_at).toBe(Date.parse(iso));
    expect(typeof row.rl_reset_at).toBe('number');
  });

  it('sets rlResetAt null for an unparseable reset header while still persisting other usage', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'anthropic-ratelimit-tokens-limit': '100',
      'anthropic-ratelimit-tokens-reset': 'not-a-date',
    });
    const row = lastInsert();
    // Date.parse → NaN → undefined sample field → n() persists null.
    expect(row.rl_reset_at).toBeNull();
    expect(row.rl_tokens_limit).toBe(100);
  });

  it('skips a wholly-empty sample (no rl limits AND no tokens AND no costUsd)', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      // remaining without a limit is not enough to trip the guard
      'anthropic-ratelimit-tokens-remaining': '5',
    });
    expect(sqlCalls).toHaveLength(0);
  });

  it('persists when only the caller-supplied tokens are present (no headers at all)', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {}, { inputTokens: 12 });
    const row = lastInsert();
    expect(row.source).toBe('headers');
    expect(row.input_tokens).toBe(12);
  });
});

describe('recordUsageSample (best-effort persistence + cost honesty)', () => {
  it('swallows a thrown getOrgPg/sql error (resolves without throwing into the agent path)', async () => {
    sqlShouldThrow.value = true;
    await expect(
      recordUsageSample({
        bucketKey: 'b',
        provider: 'anthropic',
        modelClass: 'opus',
        source: 'jsonl',
        inputTokens: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("derives costSource 'provider' when costUsd present and costSource omitted", async () => {
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      costUsd: 1.5,
    });
    const row = lastInsert();
    expect(row.cost_usd).toBe(1.5);
    expect(row.cost_source).toBe('provider');
    expect(costFromTokens).not.toHaveBeenCalled();
  });

  it('keeps an explicitly-supplied costSource (does not override)', async () => {
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      costUsd: 2,
      costSource: 'estimated',
    });
    expect(lastInsert().cost_source).toBe('estimated');
  });

  it('persists null cost_source when neither cost present nor model priceable', async () => {
    costFromTokens.mockReturnValue({ usd: 0, priced: false });
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      inputTokens: 100,
      model: 'mystery-model',
    });
    const row = lastInsert();
    expect(row.cost_usd).toBeNull();
    expect(row.cost_source).toBeNull();
    expect(costFromTokens).toHaveBeenCalledWith('mystery-model', expect.any(Object));
  });

  it("derives 'estimated' only when costUsd null but a known model prices via costFromTokens", async () => {
    costFromTokens.mockReturnValue({ usd: 0.0123, priced: true });
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      inputTokens: 1000,
      outputTokens: 500,
      model: 'claude-opus-4',
    });
    const row = lastInsert();
    expect(row.cost_usd).toBe(0.0123);
    expect(row.cost_source).toBe('estimated');
  });

  it('does NOT estimate when costUsd is already provider-reported, even with a model set', async () => {
    costFromTokens.mockReturnValue({ usd: 99, priced: true });
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      costUsd: 0.5,
      model: 'claude-opus-4',
    });
    const row = lastInsert();
    expect(row.cost_usd).toBe(0.5);
    expect(row.cost_source).toBe('provider');
    expect(costFromTokens).not.toHaveBeenCalled();
  });
});

describe('n() finite-guard on persisted INSERT values', () => {
  it('maps NaN / Infinity / undefined token fields to null (never 0 or a fabricated number)', async () => {
    const sample: UsageSample = {
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      inputTokens: Number.NaN,
      outputTokens: Number.POSITIVE_INFINITY,
      // cacheReadTokens left undefined
      cacheCreationTokens: Number.NEGATIVE_INFINITY,
      costUsd: 0.1, // keeps the row writable (skip guard is on the callers, not here)
    };
    await recordUsageSample(sample);
    const row = lastInsert();
    expect(row.input_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.cache_read_tokens).toBeNull();
    expect(row.cache_creation_tokens).toBeNull();
    // a finite value is preserved as-is, proving null is not a blanket default
    expect(row.cost_usd).toBe(0.1);
  });

  it('preserves finite zero tokens (0 is a real count, not the same as absent)', async () => {
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    const row = lastInsert();
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
  });
});
