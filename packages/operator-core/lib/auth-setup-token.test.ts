/**
 * auth-setup-token.ts (EI-347): the first-password-setup gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSetupTokenForTests,
  getSetupToken,
  pinSetupTokenForCluster,
  verifySetupToken,
} from './auth-setup-token';

const SETUP_TOKEN_ENV = 'PAPERCUSP_SETUP_TOKEN';

beforeEach(() => {
  // The token now resolves from the fork env first (WI-10001497), so a leaked
  // value would silently pin every case below to the same token.
  delete process.env[SETUP_TOKEN_ENV];
  __resetSetupTokenForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env[SETUP_TOKEN_ENV];
  vi.restoreAllMocks();
});

describe('getSetupToken', () => {
  it('returns a non-trivial, stable-per-process token', () => {
    const a = getSetupToken();
    const b = getSetupToken();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });

  it('two independent processes with NO inherited token get DIFFERENT tokens', () => {
    // Still the correct contract for unclustered hosts: with nothing in the fork
    // env each process mints its own. WI-10001497 is that this ALSO happened to
    // sibling reusePort workers, which must agree — covered in the suite below.
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

describe('pinSetupTokenForCluster (WI-10001497: reusePort workers must agree)', () => {
  it('THE BUG: a worker that mints its own token rejects the code the primary printed', () => {
    // Calibration — proves the assertions below can fail. This is the pre-fix
    // behaviour: primary mints, worker mints independently, codes disagree.
    const primaryToken = getSetupToken();
    __resetSetupTokenForTests(); // a sibling worker process: no shared memory, no env
    expect(verifySetupToken(primaryToken)).toBe(false);
  });

  it('a forked worker adopts the primary token and ACCEPTS the printed code', () => {
    const primaryToken = getSetupToken();
    const forkEnv = pinSetupTokenForCluster(4);
    expect(forkEnv[SETUP_TOKEN_ENV]).toBe(primaryToken);

    // Simulate the worker: fresh process state, primary's env applied.
    __resetSetupTokenForTests();
    process.env[SETUP_TOKEN_ENV] = forkEnv[SETUP_TOKEN_ENV];
    expect(getSetupToken()).toBe(primaryToken);
    expect(verifySetupToken(primaryToken)).toBe(true);
  });

  it('every worker in the fan-out resolves the SAME token', () => {
    const primaryToken = getSetupToken();
    const forkEnv = pinSetupTokenForCluster(6);
    const perWorker = Array.from({ length: 6 }, () => {
      __resetSetupTokenForTests();
      process.env[SETUP_TOKEN_ENV] = forkEnv[SETUP_TOKEN_ENV];
      return getSetupToken();
    });
    expect(new Set(perWorker).size).toBe(1);
    expect(perWorker[0]).toBe(primaryToken);
  });

  it('single-process mode shares nothing (no fork to share WITH)', () => {
    expect(pinSetupTokenForCluster(1)).toEqual({});
    expect(pinSetupTokenForCluster(0)).toEqual({});
    expect(pinSetupTokenForCluster(Number.NaN)).toEqual({});
  });

  it('mints + prints at BOOT, so the code is not first minted by the failing request', () => {
    const spy = vi.spyOn(console, 'log');
    pinSetupTokenForCluster(4);
    const banners = spy.mock.calls.filter((c) => String(c[0]).includes('setup code'));
    expect(banners.length).toBe(1);
  });

  it('an inheriting worker does NOT re-print the banner (one code in the log, not N)', () => {
    const forkEnv = pinSetupTokenForCluster(4);
    __resetSetupTokenForTests();
    process.env[SETUP_TOKEN_ENV] = forkEnv[SETUP_TOKEN_ENV];
    const spy = vi.spyOn(console, 'log');
    // vi.spyOn returns the SAME spy installed in beforeEach, so the primary's
    // banner from the pin call above is already recorded. Drop it — this case
    // counts only what the WORKER prints.
    spy.mockClear();
    getSetupToken();
    getSetupToken();
    const banners = spy.mock.calls.filter((c) => String(c[0]).includes('setup code'));
    expect(banners.length).toBe(0);
  });

  it('ignores a blank/whitespace env value rather than pinning an empty token', () => {
    process.env[SETUP_TOKEN_ENV] = '   ';
    const t = getSetupToken();
    expect(t.length).toBeGreaterThanOrEqual(16);
    expect(verifySetupToken('   ')).toBe(false);
    expect(verifySetupToken(t)).toBe(true);
  });
});
