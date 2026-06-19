/**
 * Tests for the re-key EPOCH MODEL (Brief RE-KEY / Move 2, K's P1). The hive_settings
 * store is mocked in-memory so these are hermetic + pure (no PG): they exercise MY
 * epoch logic (baseline default, coercion, set-validation, monotonic advance), not the
 * store's federation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
const k = (ws: string, slug: string, key: string) => `${ws}::${slug}::${key}`;

vi.mock('../../hive-settings-store', () => ({
  getHiveSetting: async (ws: string, slug: string, key: string) => {
    const id = k(ws, slug, key);
    return store.has(id)
      ? { workspaceId: ws, hiveHomeSlug: slug, settingKey: key, value: store.get(id), createdAt: 0, updatedAt: 0 }
      : null;
  },
  setHiveSetting: async (input: { workspaceId: string; hiveHomeSlug: string; settingKey: string; value: unknown }) => {
    store.set(k(input.workspaceId, input.hiveHomeSlug, input.settingKey), input.value);
    return { ...input, createdAt: 0, updatedAt: 0 };
  },
}));

const {
  getHiveEpoch,
  setHiveEpoch,
  advanceHiveEpoch,
  EPOCH_SETTING_KEY,
  BASELINE_EPOCH,
} = await import('./hive-epoch-state');

const WS = 'default';
const HIVE = 'hello-world-hive';

beforeEach(() => store.clear());

describe('getHiveEpoch — baseline + coercion', () => {
  it('an unset hive reads as the baseline epoch (0)', async () => {
    expect(await getHiveEpoch(WS, HIVE)).toBe(BASELINE_EPOCH);
    expect(BASELINE_EPOCH).toBe(0);
  });
  it('reads a stored non-negative int', async () => {
    store.set(k(WS, HIVE, EPOCH_SETTING_KEY), 5);
    expect(await getHiveEpoch(WS, HIVE)).toBe(5);
  });
  it('coerces malformed/legacy values (string, negative, float, null) to the baseline', async () => {
    for (const bad of ['7', -1, 1.5, null, {}]) {
      store.set(k(WS, HIVE, EPOCH_SETTING_KEY), bad);
      expect(await getHiveEpoch(WS, HIVE)).toBe(BASELINE_EPOCH);
    }
  });
});

describe('setHiveEpoch — validation + persistence', () => {
  it('persists a valid epoch (federates via hive_settings)', async () => {
    await setHiveEpoch(WS, HIVE, 3);
    expect(store.get(k(WS, HIVE, EPOCH_SETTING_KEY))).toBe(3);
    expect(await getHiveEpoch(WS, HIVE)).toBe(3);
  });
  it('rejects a negative or non-integer epoch', async () => {
    await expect(setHiveEpoch(WS, HIVE, -1)).rejects.toThrow();
    await expect(setHiveEpoch(WS, HIVE, 2.5)).rejects.toThrow();
  });
});

describe('advanceHiveEpoch — monotonic bump (the boundary trigger seam)', () => {
  it('advances 0→1→2 and persists each step', async () => {
    expect(await advanceHiveEpoch(WS, HIVE)).toBe(1);
    expect(await getHiveEpoch(WS, HIVE)).toBe(1);
    expect(await advanceHiveEpoch(WS, HIVE)).toBe(2);
    expect(await getHiveEpoch(WS, HIVE)).toBe(2);
  });
  it('advances from an existing epoch', async () => {
    await setHiveEpoch(WS, HIVE, 9);
    expect(await advanceHiveEpoch(WS, HIVE)).toBe(10);
  });
  it('is per-hive isolated', async () => {
    await advanceHiveEpoch(WS, HIVE);
    expect(await getHiveEpoch(WS, 'other-hive')).toBe(0);
  });
});
