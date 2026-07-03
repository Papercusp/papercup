import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateUnreachableTerminalGuard,
  terminalUnreachableMs,
  minStuckFiresForTermination,
  checkUnreachableTerminalGuard,
  DEFAULT_TERMINAL_UNREACHABLE_MS,
  DEFAULT_MIN_STUCK_FIRES,
} from './loop-unreachable-guard';
import type { WakeReachabilityVerdict } from '../../events/await/wake-reachability';

describe('evaluateUnreachableTerminalGuard (WI-1399 — pure decision)', () => {
  const base = { reachable: false, parkedForMs: DEFAULT_TERMINAL_UNREACHABLE_MS + 1, intervalMs: 60_000, stuckFireCount: DEFAULT_MIN_STUCK_FIRES };

  it('reachable owner → never breaches, regardless of duration/fire-count', () => {
    const v = evaluateUnreachableTerminalGuard({ ...base, reachable: true, parkedForMs: 1e12, stuckFireCount: 1e6 });
    expect(v.breach).toBe(false);
    expect(v.reason).toBeUndefined();
  });

  it('unreachable but not yet past the terminal window → no breach', () => {
    const v = evaluateUnreachableTerminalGuard({ ...base, parkedForMs: DEFAULT_TERMINAL_UNREACHABLE_MS - 1 });
    expect(v.breach).toBe(false);
  });

  it('unreachable + past the window but under the minimum stuck-fire count → no breach', () => {
    const v = evaluateUnreachableTerminalGuard({ ...base, stuckFireCount: DEFAULT_MIN_STUCK_FIRES - 1 });
    expect(v.breach).toBe(false);
  });

  it('unreachable + past the window + at the minimum stuck-fire count → breaches with an explanatory reason', () => {
    const v = evaluateUnreachableTerminalGuard(base);
    expect(v.breach).toBe(true);
    expect(v.reason).toContain('unreachable');
    expect(v.reason).toContain('WI-1399');
    expect(v.reason).toMatch(/\d+ consecutive stuck-backstop fires/);
  });

  it('a single blip (stuckFireCount=1) never breaches at the default minimum', () => {
    const v = evaluateUnreachableTerminalGuard({ ...base, stuckFireCount: 1 });
    expect(v.breach).toBe(false);
  });
});

describe('evaluateUnreachableTerminalGuard — circuit-open fast path (EI-7006 Route A/C)', () => {
  it('circuit-open + unreachable + ≥min-fires → breaches even with parkedForMs FAR below the 2h dwell window', () => {
    // parkedForMs=1s is nowhere near the 2h floor — the classic path would NOT breach here. The
    // whole point of the fix: a circuit-open dead loop terminates without waiting out a dwell window
    // the hourly circuit probe never lets `parkedForMs` reach.
    const v = evaluateUnreachableTerminalGuard({
      reachable: false,
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: 8,
      circuitOpen: true,
    });
    expect(v.breach).toBe(true);
    expect(v.reason).toContain('circuit-open');
    expect(v.reason).toContain('WI-1399');
    expect(v.reason).toContain('EI-7006');
  });

  it('circuit-open still respects reachability — a reachable owner never breaches (healthy long turn protected)', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: 999,
      circuitOpen: true,
    });
    expect(v.breach).toBe(false);
  });

  it('circuit-open still respects the min-fires floor', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: false,
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: 1,
      circuitOpen: true,
    });
    expect(v.breach).toBe(false);
  });

  it('the classic (circuit-closed) path is byte-unchanged — the dwell window is still enforced', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: false,
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: 8,
      circuitOpen: false, // window NOT decoupled → 1s << 2h → no breach
    });
    expect(v.breach).toBe(false);
  });
});

describe('terminalUnreachableMs / minStuckFiresForTermination — env overrides + floors', () => {
  const ORIG_TERMINAL_MS = process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS;
  const ORIG_MIN_FIRES = process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES;

  beforeEach(() => {
    delete process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS;
    delete process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES;
  });
  afterEach(() => {
    if (ORIG_TERMINAL_MS === undefined) delete process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS;
    else process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS = ORIG_TERMINAL_MS;
    if (ORIG_MIN_FIRES === undefined) delete process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES;
    else process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES = ORIG_MIN_FIRES;
  });

  it('defaults to the 2h constant when no env override and interval is small', () => {
    expect(terminalUnreachableMs(60_000)).toBe(DEFAULT_TERMINAL_UNREACHABLE_MS);
  });

  it('floors at 8× a large interval even with the default base', () => {
    const bigIntervalMs = 2_000_000_000; // ~23 days — 8x dwarfs the 2h default
    expect(terminalUnreachableMs(bigIntervalMs)).toBe(bigIntervalMs * 8);
  });

  it('respects a positive env override (still floored at 8×interval)', () => {
    process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS = String(10 * 3600_000);
    expect(terminalUnreachableMs(60_000)).toBe(10 * 3600_000);
  });

  it('minStuckFiresForTermination defaults to DEFAULT_MIN_STUCK_FIRES and respects env override', () => {
    expect(minStuckFiresForTermination()).toBe(DEFAULT_MIN_STUCK_FIRES);
    process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES = '5';
    expect(minStuckFiresForTermination()).toBe(5);
  });
});

function verdict(reachable: boolean): WakeReachabilityVerdict {
  return {
    reachable,
    channel: reachable ? 'psu-socket' : 'none',
    durableWhileAlive: reachable,
    summary: reachable ? 'live' : 'dead',
  };
}

describe('checkUnreachableTerminalGuard (WI-1399 — IO wrapper)', () => {
  const input = {
    sql: {} as never,
    routineId: 'rt-1',
    targetOwnerId: 'su-dead',
    parkedForMs: DEFAULT_TERMINAL_UNREACHABLE_MS + 1,
    intervalMs: 60_000,
    stuckFireCount: DEFAULT_MIN_STUCK_FIRES,
  };

  it('auto-pauses when the probe reports unreachable and the pure decision breaches', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => verdict(false));
    const res = await checkUnreachableTerminalGuard(input, { autoPause, probeReachability });
    expect(res.breach).toBe(true);
    expect(res.reason).toContain('WI-1399');
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledWith(input.sql, 'rt-1', expect.stringContaining('WI-1399'));
    expect(probeReachability).toHaveBeenCalledWith('su-dead');
  });

  it('does NOT auto-pause when the probe reports reachable', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => verdict(true));
    const res = await checkUnreachableTerminalGuard(input, { autoPause, probeReachability });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('does NOT auto-pause while under the terminal window even if unreachable', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => verdict(false));
    const res = await checkUnreachableTerminalGuard({ ...input, parkedForMs: 1000 }, { autoPause, probeReachability });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('fail-soft: a reachability probe error never throws and never pauses', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await checkUnreachableTerminalGuard(input, { autoPause, probeReachability });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });
});
