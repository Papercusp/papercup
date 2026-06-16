/**
 * account-session-override — the owner's session-now account override (accounts-pool-tab
 * P-004; workspace-level via operator-state, D-017). The operator-state store is mocked at
 * its boundary; this exercises the decode/default/patch logic AND the pure precedence
 * filter (the live-spawn-path lever).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readOperatorState = vi.fn<(table: string, ws?: string) => Promise<unknown>>();
const writeOperatorState = vi.fn<(table: string, payload: unknown, ws?: string) => Promise<void>>();

vi.mock('../operator-state-pg', () => ({
  readOperatorState: (...a: [string, string?]) => readOperatorState(...a),
  writeOperatorState: (...a: [string, unknown, string?]) => writeOperatorState(...a),
}));

import {
  applyAccountOverride,
  isOverrideEmpty,
  getAccountOverride,
  setAccountOverride,
  DEFAULT_ACCOUNT_OVERRIDE,
} from './account-session-override';

beforeEach(() => {
  readOperatorState.mockReset().mockResolvedValue(null);
  writeOperatorState.mockReset().mockResolvedValue(undefined);
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

describe('getAccountOverride (workspace-level, operator-state backed)', () => {
  it('no row → the default (no restriction), read from operator_account_override', async () => {
    readOperatorState.mockResolvedValue(null);
    expect(await getAccountOverride('ws')).toEqual(DEFAULT_ACCOUNT_OVERRIDE);
    expect(readOperatorState).toHaveBeenCalledWith('operator_account_override', 'ws');
  });
  it('decodes both axes, keeping only non-empty strings', async () => {
    readOperatorState.mockResolvedValue({ forcedAccounts: ['a', '', 3, 'b'], excludeAccounts: ['x'] });
    expect(await getAccountOverride('ws')).toEqual({ forcedAccounts: ['a', 'b'], excludeAccounts: ['x'] });
  });
  it('is fail-soft on a junk value', async () => {
    readOperatorState.mockResolvedValue({ forcedAccounts: 'not-an-array' });
    expect((await getAccountOverride('ws')).forcedAccounts).toEqual([]);
  });
});

describe('setAccountOverride (workspace-level)', () => {
  it('writes only the provided axis, preserving the other', async () => {
    readOperatorState.mockResolvedValue({ forcedAccounts: ['keep'], excludeAccounts: [] });
    const out = await setAccountOverride('ws', { excludeAccounts: ['flaky'] });
    expect(out).toEqual({ forcedAccounts: ['keep'], excludeAccounts: ['flaky'] });
    expect(writeOperatorState).toHaveBeenCalledWith(
      'operator_account_override',
      { forcedAccounts: ['keep'], excludeAccounts: ['flaky'] },
      'ws',
    );
  });
  it('clear:true wipes both axes and returns the default', async () => {
    const out = await setAccountOverride('ws', { clear: true });
    expect(out).toEqual(DEFAULT_ACCOUNT_OVERRIDE);
    expect(writeOperatorState).toHaveBeenCalledWith('operator_account_override', DEFAULT_ACCOUNT_OVERRIDE, 'ws');
  });
});
