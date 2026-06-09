import { describe, it, expect, vi, afterEach } from 'vitest';
// Side-effect import registers the watchdog + implement actions (and exercises every import path).
import { implementKickoff, intFromEnv } from './improvement-actions';
import { listSystemActions } from './system-actions';

describe('improvement-actions registration', () => {
  it('registers system:improvement-watchdog and system:improvement-implement', () => {
    const actions = listSystemActions();
    expect(actions).toContain('improvement-watchdog');
    expect(actions).toContain('improvement-implement');
  });

  it('does NOT register the removed system:improvement-digest (operator-learning-tab-2026-06-09 D-001)', () => {
    expect(listSystemActions()).not.toContain('improvement-digest');
  });
});

describe('implementKickoff — the dispatch carries the resolve contract (close-loop D-001)', () => {
  it('names the item and the improvements:resolve back-edge', () => {
    const k = implementKickoff({ id: 'EI-12', title: 'null icon lookup crash', attempts: 0 });
    expect(k).toMatch(/EI-12/);
    expect(k).toMatch(/improvements:resolve/);
    expect(k).toMatch(/outcome: 'fixed'/);
    expect(k).toMatch(/could-not-fix/);
    expect(k).toMatch(/needs-human/);
    expect(k).not.toMatch(/Dispatch attempt/); // first attempt → no retry banner
  });

  it('flags a retry so the worker reads earlier attempts first', () => {
    const k = implementKickoff({ id: 'EI-12', title: 'x', attempts: 2 });
    expect(k).toMatch(/Dispatch attempt 3/);
  });
});

describe('intFromEnv — honest env parsing (watchdog-robustness P-005 / D-005)', () => {
  const VAR = 'PAPERCUSP_TEST_INT_FROM_ENV';
  afterEach(() => {
    delete process.env[VAR];
    vi.restoreAllMocks();
  });

  it('returns the fallback when the var is unset', () => {
    expect(intFromEnv(VAR, 3)).toBe(3);
  });

  it('returns the fallback when the var is blank', () => {
    process.env[VAR] = '   ';
    expect(intFromEnv(VAR, 3)).toBe(3);
  });

  it('HONORS an explicit 0 (the old Number()||d idiom mapped it to the default)', () => {
    process.env[VAR] = '0';
    expect(intFromEnv(VAR, 3)).toBe(0);
  });

  it('parses a normal integer', () => {
    process.env[VAR] = '7';
    expect(intFromEnv(VAR, 3)).toBe(7);
  });

  it('warns and falls back on a non-numeric value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[VAR] = 'lots';
    expect(intFromEnv(VAR, 3)).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/is not an integer/));
  });

  it('warns and falls back on a partial-numeric value (e.g. "3abc")', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[VAR] = '3abc';
    expect(intFromEnv(VAR, 5)).toBe(5);
    expect(warn).toHaveBeenCalled();
  });

  it('clamps a value below min', () => {
    process.env[VAR] = '-4';
    expect(intFromEnv(VAR, 3, { min: 0 })).toBe(0);
  });
});
