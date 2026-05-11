import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory mock of the operator-state-pg layer. The snapshot module
// only uses readOperatorState + writeOperatorState; mock those directly
// instead of re-modeling postgres-js.
const store = new Map<string, unknown>();
vi.mock('./operator-state-pg', () => ({
  readOperatorState: async <T>(table: string) => (store.get(table) as T) ?? null,
  writeOperatorState: async (table: string, payload: unknown) => {
    store.set(table, payload);
  },
}));

import { readSnapshot, writeSnapshot, canShortCircuit } from './operator-idle-snapshot';

beforeEach(() => store.clear());
afterEach(() => store.clear());

describe('operator-idle-snapshot (PG-backed)', () => {
  it('round-trips the basic shape', async () => {
    await writeSnapshot('fp1', [{ id: 'a' }, { id: 'b' }]);
    const got = await readSnapshot();
    expect(got?.fingerprint).toBe('fp1');
    expect(got?.cards).toHaveLength(2);
    expect(got?.perHarness).toBeUndefined();
  });

  it('persists per-harness one-liners alongside cards', async () => {
    await writeSnapshot('fp2', [], [
      { slug: 'foo', status: 'idle', lastTouched: '2026-05-10T00:00:00Z' },
      { slug: 'bar', status: 'running', lastTouched: null },
    ]);
    const got = await readSnapshot();
    expect(got?.perHarness).toHaveLength(2);
    expect(got?.perHarness?.[0].slug).toBe('foo');
    expect(got?.perHarness?.[1].lastTouched).toBeNull();
  });

  it('canShortCircuit returns the snapshot when fingerprint matches', async () => {
    await writeSnapshot('fp3', [{ id: 'x' }]);
    const got = await canShortCircuit('fp3');
    expect(got?.fingerprint).toBe('fp3');
  });

  it('canShortCircuit returns null when fingerprint differs', async () => {
    await writeSnapshot('fp4', []);
    expect(await canShortCircuit('different')).toBeNull();
  });

  it('canShortCircuit returns null past the TTL', async () => {
    // Backdate the row by mutating the in-memory store directly.
    await writeSnapshot('fp5', []);
    const stored = store.get('operator_idle_snapshot') as { computedAt: string };
    stored.computedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    expect(await canShortCircuit('fp5')).toBeNull();
  });

  it('readSnapshot drops invalid perHarness entries', async () => {
    store.set('operator_idle_snapshot', {
      fingerprint: 'fp6',
      computedAt: new Date().toISOString(),
      ttlMs: 30 * 60 * 1000,
      cards: [],
      perHarness: [
        { slug: 'good', status: 'idle', lastTouched: null },
        null,
        { notSlug: 'bad' },
      ],
    });
    const got = await readSnapshot();
    expect(got?.perHarness).toHaveLength(1);
    expect(got?.perHarness?.[0].slug).toBe('good');
  });
});
