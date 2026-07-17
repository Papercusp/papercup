/**
 * auth-setup-token.ts (EI-347): the first-password-setup gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSetupTokenForTests, getSetupToken, verifySetupToken } from './auth-setup-token';

beforeEach(() => {
  __resetSetupTokenForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('getSetupToken', () => {
  it('returns a non-trivial, stable-per-process token', () => {
    const a = getSetupToken();
    const b = getSetupToken();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });

  it('two independent processes (simulated via reset) get DIFFERENT tokens', () => {
    const a = getSetupToken();
    __resetSetupTokenForTests();
    const b = getSetupToken();
    expect(a).not.toBe(b);
  });

  it('prints the token to console exactly once', () => {
    const spy = vi.spyOn(console, 'log');
    getSetupToken();
    getSetupToken();
    getSetupToken();
    const printedCalls = spy.mock.calls.filter((c) => String(c[0]).includes('setup code'));
    expect(printedCalls.length).toBe(1);
  });
});

describe('verifySetupToken', () => {
  it('accepts the exact current token', () => {
    const t = getSetupToken();
    expect(verifySetupToken(t)).toBe(true);
  });

  it('rejects a wrong token', () => {
    getSetupToken();
    expect(verifySetupToken('not-the-token')).toBe(false);
  });

  it('rejects null/undefined/empty', () => {
    getSetupToken();
    expect(verifySetupToken(null)).toBe(false);
    expect(verifySetupToken(undefined)).toBe(false);
    expect(verifySetupToken('')).toBe(false);
  });

  it('rejects a same-length wrong-content candidate (exercises the timing-safe compare path)', () => {
    const t = getSetupToken();
    const wrong = t.slice(0, -1) + (t.at(-1) === 'a' ? 'b' : 'a');
    expect(verifySetupToken(wrong)).toBe(false);
  });
});
