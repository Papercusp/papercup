/**
 * owner-steering — contract C-1 store (queen-steering-panel-2026-06-15 B-01).
 *
 * The hive_settings KV is mocked at the module boundary, so this exercises the C-1
 * DECODE / DEFAULT / normalize logic + the write-patch fan-out without PG.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `...args` so the mock factory's `(...a) => fn(...a)` spreads type-check + `.mock.calls` index.
const listHiveSettings = vi.fn<(...a: unknown[]) => unknown>();
const setHiveSetting = vi.fn(async (..._a: unknown[]) => ({}));
const deleteHiveSetting = vi.fn(async (..._a: unknown[]) => {});

vi.mock('./hive-settings-store', () => ({
  listHiveSettings: (...a: unknown[]) => listHiveSettings(...a),
  setHiveSetting: (...a: unknown[]) => setHiveSetting(...a),
  deleteHiveSetting: (...a: unknown[]) => deleteHiveSetting(...a),
}));

import {
  getOwnerSteering,
  setOwnerSteering,
  isPausedNow,
  DEFAULT_OWNER_STEERING,
  OWNER_STEERING_KEYS,
  type OwnerSteering,
} from './owner-steering';

function rows(map: Record<string, unknown>) {
  return Object.entries(map).map(([settingKey, value]) => ({ settingKey, value }));
}

beforeEach(() => {
  listHiveSettings.mockReset();
  setHiveSetting.mockReset().mockResolvedValue({});
  deleteHiveSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('getOwnerSteering — decode + defaults', () => {
  it('an un-steered Hive (no keys) returns the default no-restriction state', async () => {
    listHiveSettings.mockResolvedValue([]);
    expect(await getOwnerSteering('ws', 'hive')).toEqual(DEFAULT_OWNER_STEERING);
  });

  it('decodes a fully-set steering state', async () => {
    listHiveSettings.mockResolvedValue(
      rows({
        [OWNER_STEERING_KEYS.directive]: 'focus on the migration',
        [OWNER_STEERING_KEYS.eligiblePlans]: ['plan-a', 'plan-b'],
        [OWNER_STEERING_KEYS.pauseNewWork]: true,
        [OWNER_STEERING_KEYS.pausedUntil]: 1_900_000_000_000,
      }),
    );
    expect(await getOwnerSteering('ws', 'hive')).toEqual({
      directive: 'focus on the migration',
      eligiblePlans: ['plan-a', 'plan-b'],
      eligibleHives: [],
      pauseNewWork: true,
      pausedUntil: 1_900_000_000_000,
      modelTiers: null,
      tierCeilings: null,
    } satisfies OwnerSteering);
  });

  it('decodes a model-tier session override (D-006) + drops malformed tiers', async () => {
    listHiveSettings.mockResolvedValue(
      rows({
        [OWNER_STEERING_KEYS.modelTiers]: [{ name: 'fast', spec: 'haiku' }, { name: 'bad' }, { spec: 'no-name' }],
        [OWNER_STEERING_KEYS.tierCeilings]: { worker: 'opus', '': '', queen: 7 },
      }),
    );
    const s = await getOwnerSteering('ws', 'hive');
    expect(s.modelTiers).toEqual([{ name: 'fast', spec: 'haiku' }]);
    expect(s.tierCeilings).toEqual({ worker: 'opus' });
  });

  it('writes the model-tier override when provided (D-006)', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { modelTiers: [{ name: 'fast', spec: 'opus:xhigh' }] });
    expect(setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', hiveHomeSlug: 'hive', settingKey: OWNER_STEERING_KEYS.modelTiers, value: [{ name: 'fast', spec: 'opus:xhigh' }] },
      undefined,
    );
  });

  it('decodes eligibleHives (the placement scope, B-04 round-2)', async () => {
    listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.eligibleHives]: ['hive-a', 'hive-b'] }));
    expect((await getOwnerSteering('ws', 'hive')).eligibleHives).toEqual(['hive-a', 'hive-b']);
  });

  it('is fail-soft on junk values — each bad key falls back to its default', async () => {
    listHiveSettings.mockResolvedValue(
      rows({
        [OWNER_STEERING_KEYS.directive]: '   ', // whitespace-only ⇒ null
        [OWNER_STEERING_KEYS.eligiblePlans]: 'not-an-array', // ⇒ []
        [OWNER_STEERING_KEYS.pauseNewWork]: 'true', // string, not boolean true ⇒ false
        [OWNER_STEERING_KEYS.pausedUntil]: 'whenever', // ⇒ null
      }),
    );
    expect(await getOwnerSteering('ws', 'hive')).toEqual(DEFAULT_OWNER_STEERING);
  });

  it('keeps only string entries in eligiblePlans', async () => {
    listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.eligiblePlans]: ['ok', 3, null, 'also'] }));
    expect((await getOwnerSteering('ws', 'hive')).eligiblePlans).toEqual(['ok', 'also']);
  });
});

describe('setOwnerSteering — write fan-out', () => {
  it('writes ONLY the provided fields (omitted left untouched)', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { pauseNewWork: true });
    expect(setHiveSetting).toHaveBeenCalledTimes(1);
    expect(setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', hiveHomeSlug: 'hive', settingKey: OWNER_STEERING_KEYS.pauseNewWork, value: true },
      undefined,
    );
    expect(deleteHiveSetting).not.toHaveBeenCalled();
  });

  it('writes every provided field with the normalized value', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', {
      directive: 'x',
      eligiblePlans: ['p1'],
      pauseNewWork: false,
      pausedUntil: 123,
    });
    const wrote = setHiveSetting.mock.calls.map((c) => [(c[0] as { settingKey: string }).settingKey, (c[0] as { value: unknown }).value]);
    expect(wrote).toEqual([
      [OWNER_STEERING_KEYS.directive, 'x'],
      [OWNER_STEERING_KEYS.eligiblePlans, ['p1']],
      [OWNER_STEERING_KEYS.pauseNewWork, false],
      [OWNER_STEERING_KEYS.pausedUntil, 123],
    ]);
  });

  it('writes eligibleHives (the placement scope) when provided (B-04 round-2)', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { eligibleHives: ['hive-a', 'hive-b'] });
    expect(setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', hiveHomeSlug: 'hive', settingKey: OWNER_STEERING_KEYS.eligibleHives, value: ['hive-a', 'hive-b'] },
      undefined,
    );
  });

  it('normalizes a blank directive + bad pausedUntil to the cleared value on write', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { directive: '  ', pausedUntil: Number.NaN });
    const wrote = Object.fromEntries(setHiveSetting.mock.calls.map((c) => [(c[0] as { settingKey: string }).settingKey, (c[0] as { value: unknown }).value]));
    expect(wrote[OWNER_STEERING_KEYS.directive]).toBeNull();
    expect(wrote[OWNER_STEERING_KEYS.pausedUntil]).toBeNull();
  });

  it('clear:true deletes ALL steering keys and returns the default', async () => {
    const out = await setOwnerSteering('ws', 'hive', { clear: true });
    expect(deleteHiveSetting).toHaveBeenCalledTimes(Object.keys(OWNER_STEERING_KEYS).length);
    expect(deleteHiveSetting.mock.calls.map((c) => c[2])).toEqual(Object.values(OWNER_STEERING_KEYS));
    expect(setHiveSetting).not.toHaveBeenCalled();
    expect(out).toEqual(DEFAULT_OWNER_STEERING);
  });
});

describe('isPausedNow', () => {
  const base = DEFAULT_OWNER_STEERING;
  it('explicit pauseNewWork pauses regardless of time', () => {
    expect(isPausedNow({ ...base, pauseNewWork: true }, 1_000)).toBe(true);
  });
  it('an un-expired pausedUntil pauses; an elapsed one does not', () => {
    expect(isPausedNow({ ...base, pausedUntil: 2_000 }, 1_000)).toBe(true);
    expect(isPausedNow({ ...base, pausedUntil: 2_000 }, 2_000)).toBe(false);
    expect(isPausedNow({ ...base, pausedUntil: 2_000 }, 3_000)).toBe(false);
  });
  it('the default state is never paused', () => {
    expect(isPausedNow(base, 9_999)).toBe(false);
  });
});
