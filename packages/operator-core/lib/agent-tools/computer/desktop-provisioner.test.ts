/**
 * desktop-provisioner.test.ts — pure-logic coverage: free-display selection
 * (never :0) and the host-display refusal. The live Xvfb path is exercised by
 * the end-to-end proof script, not here.
 */
import { describe, expect, it } from 'vitest';
import { findFreeDisplayNumber, provisionSandboxDesktop } from './desktop-provisioner';

describe('findFreeDisplayNumber', () => {
  it('returns the lowest free number ≥ base (skips locked displays)', () => {
    const locked = new Set(['/tmp/.X110-lock', '/tmp/.X111-lock']);
    expect(findFreeDisplayNumber(110, 250, (p) => locked.has(p))).toBe(112);
  });

  it('never returns :0 even if base is 0', () => {
    expect(findFreeDisplayNumber(0, 250, () => false)).toBe(1);
  });

  it('throws when the whole range is taken', () => {
    expect(() => findFreeDisplayNumber(110, 112, () => true)).toThrow(/no free X display/);
  });
});

describe('provisionSandboxDesktop — safety', () => {
  it('refuses an explicit host display :0', async () => {
    await expect(provisionSandboxDesktop({ displayNumber: 0 })).rejects.toThrow(/host :0 \/ invalid|refusing/);
  });
  it('refuses a negative display number', async () => {
    await expect(provisionSandboxDesktop({ displayNumber: -5 })).rejects.toThrow(/refusing/);
  });
});
