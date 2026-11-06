import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlTag, state } = vi.hoisted(() => {
  const state: {
    calls: Array<{ text: string; values: unknown[] }>;
    rows: Array<{ id: number }>;
  } = { calls: [], rows: [] };
  const sqlTag = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    state.calls.push({ text: Array.from(parts).join(' ? '), values });
    return state.rows;
  });
  return { sqlTag, state };
});

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: sqlTag }) }));

import { CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE, PgL2Store } from './pg-l2-store';

describe('PgL2Store.sweepExpired', () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.rows = [{ id: 1 }, { id: 2 }];
  });

  it('deletes only the oldest bounded batch and skips rows locked by another sweep', async () => {
    const store = new PgL2Store({ clock: () => 1_000_000 });

    await expect(store.sweepExpired()).resolves.toBe(2);

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0]!;
    expect(call.text).toMatch(/WITH expired AS/);
    expect(call.text).toMatch(/expires_at IS NOT NULL AND expires_at <=\s*\?/);
    expect(call.text).toMatch(/ORDER BY expires_at ASC/);
    expect(call.text).toMatch(/LIMIT\s*\?/);
    expect(call.text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(call.text).toMatch(/DELETE FROM harness_shared\.cache_l2 AS target/);
    expect(call.values).toEqual([new Date(1_000_000), CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE]);
  });

  it('accepts a smaller explicit batch and rejects invalid or oversized limits before querying', async () => {
    const store = new PgL2Store({ clock: () => 1_000_000 });

    await store.sweepExpired(2);
    expect(state.calls[0]?.values.at(-1)).toBe(2);

    state.calls.length = 0;
    for (const batchSize of [0, -1, 1.5, 1_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store.sweepExpired(batchSize)).rejects.toThrow(/batchSize/);
    }
    expect(state.calls).toHaveLength(0);
  });
});
