/**
 * account-session-override — the owner's session-now account override (accounts-pool-tab
 * P-004). The hive_settings store is mocked at its boundary; this exercises the C-1-style
 * decode/default/write logic AND the pure precedence filter (the live-spawn-path lever).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SetInput = { workspaceId: string; hiveHomeSlug: string; settingKey: string; value: unknown };
const listHiveSettings = vi.fn<(ws: string, hive: string, sql?: unknown) => Promise<Array<{ settingKey: string; value: unknown }>>>();
const setHiveSetting = vi.fn<(input: SetInput, sql?: unknown) => Promise<unknown>>();
const deleteHiveSetting = vi.fn<(ws: string, hive: string, key: string, sql?: unknown) => Promise<void>>();

vi.mock('../hive-settings-store', () => ({
  listHiveSettings: (...a: [string, string, unknown?]) => listHiveSettings(...a),
  setHiveSetting: (...a: [SetInput, unknown?]) => setHiveSetting(...a),
  deleteHiveSetting: (...a: [string, string, string, unknown?]) => deleteHiveSetting(...a),
}));

import {
  applyAccountOverride,
  isOverrideEmpty,
  getAccountSessionOverride,
  setAccountSessionOverride,
  getAccountOverride,
  setAccountOverride,
  DEFAULT_ACCOUNT_OVERRIDE,
  ACCOUNT_OVERRIDE_KEYS,
  ACCOUNT_OVERRIDE_SLUG,
} from './account-session-override';

function rows(map: Record<string, unknown>) {
  return Object.entries(map).map(([settingKey, value]) => ({ settingKey, value }));
}

beforeEach(() => {
  listHiveSettings.mockReset();
  setHiveSetting.mockReset().mockResolvedValue({});
  deleteHiveSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('applyAccountOverride (the live-path filter)', () => {
  const ids = ['a', 'b', 'c'];
  it('empty override is a no-op (today’s behaviour)', () => {
    expect(applyAccountOverride(ids, DEFAULT_ACCOUNT_OVERRIDE)).toEqual(ids);
    expect(isOverrideEmpty(DEFAULT_ACCOUNT_OVERRIDE)).toBe(true);
  });
  it('forced restricts to the allow-list (order preserved)', () => {
    expect(applyAccountOverride(ids, { forcedAccounts: ['c', 'a'], excludeAccounts: [] })).toEqual(['a', 'c']);
  });
  it('exclude drops the named accounts', () => {
    expect(applyAccountOverride(ids, { forcedAccounts: [], excludeAccounts: ['b'] })).toEqual(['a', 'c']);
  });
  it('forced THEN exclude (forced wins the set, exclude trims it)', () => {
    expect(applyAccountOverride(ids, { forcedAccounts: ['a', 'b'], excludeAccounts: ['b'] })).toEqual(['a']);
  });
  it('an over-restrictive override yields [] (caller fails soft to the frame default)', () => {
    expect(applyAccountOverride(ids, { forcedAccounts: ['zzz'], excludeAccounts: [] })).toEqual([]);
    expect(applyAccountOverride(ids, { forcedAccounts: [], excludeAccounts: ['a', 'b', 'c'] })).toEqual([]);
  });
  it('isOverrideEmpty is false when either axis is set', () => {
    expect(isOverrideEmpty({ forcedAccounts: ['a'], excludeAccounts: [] })).toBe(false);
    expect(isOverrideEmpty({ forcedAccounts: [], excludeAccounts: ['a'] })).toBe(false);
  });
});

describe('getAccountSessionOverride', () => {
  it('no keys → the default (no restriction)', async () => {
    listHiveSettings.mockResolvedValue([]);
    expect(await getAccountSessionOverride('ws', 'hive')).toEqual(DEFAULT_ACCOUNT_OVERRIDE);
  });
  it('decodes both axes, keeping only non-empty strings', async () => {
    listHiveSettings.mockResolvedValue(
      rows({
        [ACCOUNT_OVERRIDE_KEYS.forcedAccounts]: ['a', '', 3, 'b'],
        [ACCOUNT_OVERRIDE_KEYS.excludeAccounts]: ['x'],
      }),
    );
    expect(await getAccountSessionOverride('ws', 'hive')).toEqual({ forcedAccounts: ['a', 'b'], excludeAccounts: ['x'] });
  });
  it('is fail-soft on a junk value', async () => {
    listHiveSettings.mockResolvedValue(rows({ [ACCOUNT_OVERRIDE_KEYS.forcedAccounts]: 'not-an-array' }));
    expect((await getAccountSessionOverride('ws', 'hive')).forcedAccounts).toEqual([]);
  });
});

describe('setAccountSessionOverride', () => {
  it('writes only the provided axis', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setAccountSessionOverride('ws', 'hive', { excludeAccounts: ['flaky'] });
    expect(setHiveSetting).toHaveBeenCalledTimes(1);
    expect(setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', hiveHomeSlug: 'hive', settingKey: ACCOUNT_OVERRIDE_KEYS.excludeAccounts, value: ['flaky'] },
      undefined,
    );
  });
  it('clear:true deletes both axes and returns the default', async () => {
    const out = await setAccountSessionOverride('ws', 'hive', { clear: true });
    expect(deleteHiveSetting.mock.calls.map((c) => c[2])).toEqual(Object.values(ACCOUNT_OVERRIDE_KEYS));
    expect(setHiveSetting).not.toHaveBeenCalled();
    expect(out).toEqual(DEFAULT_ACCOUNT_OVERRIDE);
  });
});

// The workspace-level wrappers (D-017): no home hive needed — they key under a stable
// per-workspace pseudo-slug, so write/read always agree (fixes "no_home_harness").
describe('getAccountOverride / setAccountOverride (workspace-level)', () => {
  it('getAccountOverride reads under the per-workspace pseudo-slug', async () => {
    listHiveSettings.mockResolvedValue([]);
    expect(await getAccountOverride('ws')).toEqual(DEFAULT_ACCOUNT_OVERRIDE);
    expect(listHiveSettings).toHaveBeenCalledWith('ws', ACCOUNT_OVERRIDE_SLUG, undefined);
  });
  it('setAccountOverride writes under the SAME pseudo-slug the read uses', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setAccountOverride('ws', { excludeAccounts: ['flaky'] });
    expect(setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', hiveHomeSlug: ACCOUNT_OVERRIDE_SLUG, settingKey: ACCOUNT_OVERRIDE_KEYS.excludeAccounts, value: ['flaky'] },
      undefined,
    );
  });
});
