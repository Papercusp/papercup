/**
 * Unit tests for readOwnerFullAutonomyGrant — the ONE reader of the owner
 * FULL-AUTONOMY grant that lifts the protected-path / keyword TCB bars in the
 * self-improvement implement lane. The load-bearing property is FAIL-DARK: any
 * flag-IO hiccup must return false (never accidentally grant full autonomy), and
 * it must read the flag at the exact `autonomy:<ws>` scope the decider uses (so a
 * single owner flip covers both gates and the scope key can't drift).
 *
 * getFlag is mocked — no real flag store touched.
 *
 * Run: cd packages/operator-core && npx vitest run lib/harness/improvements/full-autonomy-grant.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFlag: vi.fn<(key: string, scope: string) => Promise<boolean>>(() => Promise.resolve(false)),
}));
vi.mock('@papercusp/flags', () => ({ FLAGS: { MUG_FULL_AUTONOMY: 'queen_full_autonomy' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));

import { readOwnerFullAutonomyGrant } from './full-autonomy-grant';

afterEach(() => vi.clearAllMocks());

describe('readOwnerFullAutonomyGrant', () => {
  it('returns true when the grant flag is set', async () => {
    h.getFlag.mockResolvedValueOnce(true);
    expect(await readOwnerFullAutonomyGrant('ws-1')).toBe(true);
  });

  it('returns false when the grant flag is unset', async () => {
    h.getFlag.mockResolvedValueOnce(false);
    expect(await readOwnerFullAutonomyGrant('ws-1')).toBe(false);
  });

  it('reads the flag at the autonomy:<workspace> scope (no drift)', async () => {
    h.getFlag.mockResolvedValueOnce(true);
    await readOwnerFullAutonomyGrant('acme');
    expect(h.getFlag).toHaveBeenCalledWith('queen_full_autonomy', 'autonomy:acme');
  });

  it('fails DARK to false when the flag read throws (a hiccup must never grant autonomy)', async () => {
    h.getFlag.mockRejectedValueOnce(new Error('flag store down'));
    expect(await readOwnerFullAutonomyGrant('ws-1')).toBe(false);
  });
});
