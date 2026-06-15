import { describe, it, expect, vi } from 'vitest';
import {
  betFlagRevertHandle,
  revertHandleForRollout,
  makeBetFlagReverter,
  BET_FLAG_REVERT_KIND,
} from './bet-flag-reverter';
import { makeRevertRegistry, executeRevertVia, type RevertHelpers } from '../autonomy/tripwire/revert-executor';

const noHelpers = {} as unknown as RevertHelpers; // reverters here ignore the shared helpers

describe('betFlagRevertHandle / revertHandleForRollout', () => {
  it('builds a flag-override handle', () => {
    expect(betFlagRevertHandle('papercusp-touch-set-exclusion')).toEqual({
      kind: 'flag-override',
      key: 'papercusp-touch-set-exclusion',
    });
  });

  it('produces a handle ONLY for a revert decision', () => {
    const rev = { action: 'revert', from: 'canary', to: 'off', reason: 'r' } as const;
    const adv = { action: 'advance', from: 'off', to: 'canary', reason: 'r' } as const;
    expect(revertHandleForRollout(rev, 'papercusp-x')?.key).toBe('papercusp-x');
    expect(revertHandleForRollout(adv, 'papercusp-x')).toBeNull();
  });
});

describe('makeBetFlagReverter', () => {
  it('sets the flag OFF and reports reverted', async () => {
    const setOff = vi.fn().mockResolvedValue(undefined);
    const out = await makeBetFlagReverter(setOff)({ kind: 'flag-override', key: 'papercusp-x' }, noHelpers);
    expect(setOff).toHaveBeenCalledWith('papercusp-x');
    expect(out).toEqual({ reverted: true, note: expect.stringContaining('papercusp-x') });
  });

  it('returns reverted:false on a handle with no key (no op called)', async () => {
    const setOff = vi.fn();
    const out = await makeBetFlagReverter(setOff)({ kind: 'flag-override' }, noHelpers);
    expect(setOff).not.toHaveBeenCalled();
    expect(out.reverted).toBe(false);
  });
});

describe('end-to-end via the tripwire dispatch', () => {
  it('dispatches a flag-override handle through executeRevertVia', async () => {
    const registry = makeRevertRegistry();
    const seen: string[] = [];
    registry.set(
      BET_FLAG_REVERT_KIND,
      makeBetFlagReverter(async (k) => {
        seen.push(k);
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = { revertHandle: { kind: 'flag-override', key: 'papercusp-touch-set-exclusion' } } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await executeRevertVia(row, registry, {} as any);
    expect(out.reverted).toBe(true);
    expect(seen).toEqual(['papercusp-touch-set-exclusion']);
  });

  it('a throwing op degrades to reverted:false via the executor catch (never wedges the sweep)', async () => {
    const registry = makeRevertRegistry();
    registry.set(
      BET_FLAG_REVERT_KIND,
      makeBetFlagReverter(async () => {
        throw new Error('boom');
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = { revertHandle: { kind: 'flag-override', key: 'papercusp-x' } } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await executeRevertVia(row, registry, {} as any);
    expect(out.reverted).toBe(false);
  });
});
