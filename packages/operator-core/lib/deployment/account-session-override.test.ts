/**
 * account-session-override — the owner's session-now account override (accounts-pool-tab
 * P-004; workspace-level via operator-state, D-015). The operator-state store is mocked at
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

  // ── default-deploy-account-2026-08-08 D-003 ────────────────────────────────
  // A default is a FALLBACK preference, not a restriction. Both assertions below
  // pin CURRENT behaviour deliberately: `isOverrideEmpty` gates the candidate-
  // narrowing branch in account-pool-store (`isOverrideEmpty(o) ? wholePool :
  // applyAccountOverride(...)`), so folding the default into either function would
  // make "I picked a default" mean "narrow the pool to one account" — silently
  // killing 429 failover. If one of these ever fails, the fix is NOT to update the
  // expectation.
  it('a default alone does NOT make the override non-empty (it must not narrow the pool)', () => {
    expect(isOverrideEmpty({ forcedAccounts: [], excludeAccounts: [], defaultAccountId: 'acct-1' })).toBe(true);
  });
  it('applyAccountOverride ignores the default — every candidate survives as failover', () => {
    expect(applyAccountOverride(ids, { forcedAccounts: [], excludeAccounts: [], defaultAccountId: 'c' })).toEqual(ids);
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

  it('decodes defaultAccountId (trimmed) alongside the two lists', async () => {
    readOperatorState.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [], defaultAccountId: '  acct-1 ' });
    expect(await getAccountOverride('ws')).toEqual({
      forcedAccounts: [],
      excludeAccounts: [],
      defaultAccountId: 'acct-1',
    });
  });

  // The key is OMITTED rather than set to undefined so the decoded shape matches
  // DEFAULT_ACCOUNT_OVERRIDE exactly — existing callers/tests compare with toEqual.
  it.each([
    ['absent', {}],
    ['empty string', { defaultAccountId: '' }],
    ['whitespace only', { defaultAccountId: '   ' }],
    ['not a string', { defaultAccountId: 42 }],
  ])('omits the defaultAccountId key entirely when %s', async (_label, row) => {
    readOperatorState.mockResolvedValue(row);
    const out = await getAccountOverride('ws');
    expect('defaultAccountId' in out).toBe(false);
    expect(out).toEqual(DEFAULT_ACCOUNT_OVERRIDE);
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

  it('rejects an override that names an account outside the persisted pool before writing', async () => {
    readOperatorState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accounts: [{ id: 'acct-a' }, { id: 'acct-b' }] });

    await expect(setAccountOverride('ws', { forcedAccounts: ['avistorewolf.com'] })).rejects.toThrow(
      /not present in the account pool: avistorewolf\.com/,
    );
    expect(writeOperatorState).not.toHaveBeenCalled();
  });

  it('rejects an account listed in both forcedAccounts and excludeAccounts before writing', async () => {
    readOperatorState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accounts: [{ id: 'acct-a' }, { id: 'acct-b' }] });

    await expect(
      setAccountOverride('ws', { forcedAccounts: ['acct-a'], excludeAccounts: ['acct-a'] }),
    ).rejects.toThrow(/both forcedAccounts and excludeAccounts: acct-a/);
    expect(writeOperatorState).not.toHaveBeenCalled();
  });

  it('rejects a non-empty-pool collapse unless confirmCollapse is explicit', async () => {
    readOperatorState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accounts: [{ id: 'acct-a' }, { id: 'acct-b' }] });

    await expect(
      setAccountOverride('ws', { excludeAccounts: ['acct-a', 'acct-b'] }),
    ).rejects.toThrow(/collapse the non-empty account pool/);
    expect(writeOperatorState).not.toHaveBeenCalled();
  });

  it('allows an intentional non-empty-pool collapse only with confirmCollapse', async () => {
    readOperatorState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accounts: [{ id: 'acct-a' }, { id: 'acct-b' }] });

    await expect(
      setAccountOverride('ws', { excludeAccounts: ['acct-a', 'acct-b'], confirmCollapse: true }),
    ).resolves.toEqual({ forcedAccounts: [], excludeAccounts: ['acct-a', 'acct-b'] });
    expect(writeOperatorState).toHaveBeenCalledWith(
      'operator_account_override',
      { forcedAccounts: [], excludeAccounts: ['acct-a', 'acct-b'] },
      'ws',
    );
  });

  // ── defaultAccountId: set / clear / untouched are three distinct outcomes ───
  // `?: string | null` exists precisely so `null` (clear) is distinguishable from
  // omission (keep) — a `?: string` field could only ever express two of the three.
  it('sets the default, preserving both lists', async () => {
    readOperatorState.mockResolvedValue({ forcedAccounts: ['keep'], excludeAccounts: ['flaky'] });
    const out = await setAccountOverride('ws', { defaultAccountId: 'acct-1' });
    expect(out).toEqual({ forcedAccounts: ['keep'], excludeAccounts: ['flaky'], defaultAccountId: 'acct-1' });
    expect(writeOperatorState).toHaveBeenCalledWith(
      'operator_account_override',
      { forcedAccounts: ['keep'], excludeAccounts: ['flaky'], defaultAccountId: 'acct-1' },
      'ws',
    );
  });

  it('defaultAccountId:null CLEARS it (back to the ~/.claude login) without touching the lists', async () => {
    readOperatorState.mockResolvedValue({ forcedAccounts: ['keep'], excludeAccounts: [], defaultAccountId: 'acct-1' });
    const out = await setAccountOverride('ws', { defaultAccountId: null });
    expect('defaultAccountId' in out).toBe(false);
    expect(out).toEqual({ forcedAccounts: ['keep'], excludeAccounts: [] });
    expect(writeOperatorState).toHaveBeenCalledWith(
      'operator_account_override',
      { forcedAccounts: ['keep'], excludeAccounts: [] },
      'ws',
    );
  });

  it('an omitted defaultAccountId leaves an existing default UNTOUCHED', async () => {
    readOperatorState.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [], defaultAccountId: 'acct-1' });
    const out = await setAccountOverride('ws', { excludeAccounts: ['flaky'] });
    expect(out).toEqual({ forcedAccounts: [], excludeAccounts: ['flaky'], defaultAccountId: 'acct-1' });
  });

  it('a blank/whitespace defaultAccountId clears rather than storing an unusable id', async () => {
    readOperatorState.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [], defaultAccountId: 'acct-1' });
    expect('defaultAccountId' in (await setAccountOverride('ws', { defaultAccountId: '   ' }))).toBe(false);
  });

  it('clear:true wipes the default too, not just the two lists', async () => {
    readOperatorState.mockResolvedValue({ forcedAccounts: ['a'], excludeAccounts: ['b'], defaultAccountId: 'acct-1' });
    const out = await setAccountOverride('ws', { clear: true });
    expect('defaultAccountId' in out).toBe(false);
    expect(writeOperatorState).toHaveBeenCalledWith('operator_account_override', DEFAULT_ACCOUNT_OVERRIDE, 'ws');
  });
});
