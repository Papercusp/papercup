import { describe, it, expect, vi, afterEach } from 'vitest';
// Side-effect import registers the watchdog + implement actions (and exercises every import path).
import {
  implementKickoff,
  implementTimeoutMs,
  intFromEnv,
  drainStopsImprovementClaims,
  shouldStopClaimingForDrain,
} from './improvement-actions';
import { isShuttingDown, markShuttingDown, __resetShutdownStateForTest } from '../../shutdown-state';
import { listSystemActions } from './system-actions';
import { DEFAULT_STALE_CLAIM_MS } from '../improvements/plan-implement';
import { dispatchOverdueAfterMs } from '../improvements/dispatch-ledger';

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

describe('implementTimeoutMs — the dispatch worker lifetime (learning-system-audit D-010)', () => {
  const VAR = 'PAPERCUSP_IMPROVEMENT_IMPLEMENT_TIMEOUT_MS';
  const OVERDUE_VAR = 'PAPERCUSP_IMPROVEMENT_DISPATCH_OVERDUE_MS';
  afterEach(() => {
    delete process.env[VAR];
    delete process.env[OVERDUE_VAR];
  });

  it('defaults to 45 min — 280s SIGTERM-killed 51/58 workers mid-fix', () => {
    expect(implementTimeoutMs()).toBe(2_700_000);
  });

  it('stays under the stale-claim window so a timed-out worker is dead before its claim re-dispatches', () => {
    expect(implementTimeoutMs()).toBeLessThan(DEFAULT_STALE_CLAIM_MS);
  });

  it('stays under the orphan threshold so a worker still within its timeout is never false-orphaned (relight P-031)', () => {
    // The orphan collector marks an open dispatch dead past dispatchOverdueAfterMs().
    // If the worker's own timeout reached that threshold, a worker still legitimately
    // running (under its timeout) would be orphaned out from under itself — the
    // false-orphan / dead-lock class the wedge-triad insight warns about. Invariant:
    // worker lifetime < orphan threshold (which is aligned with the stale-claim window).
    expect(implementTimeoutMs()).toBeLessThan(dispatchOverdueAfterMs());
  });

  it('honors the env override, clamped to ≥60s', () => {
    process.env[VAR] = '600000';
    expect(implementTimeoutMs()).toBe(600_000);
    process.env[VAR] = '5';
    expect(implementTimeoutMs()).toBe(60_000);
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

// P-005 (infra round-4): the auto-implement dispatch loop must STOP claiming new
// minutes-long workers once SIGTERM lands, or a deploy SIGKILLs them mid-fix and
// orphans the claim (the 2026-06-19 storm: 51/58 workers exited 143). The guard is
// DEFAULT-OFF — it must not change behavior until armed alongside the lane re-arm.
describe('P-005 drain-stops-claims guard (default-OFF until armed)', () => {
  const VAR = 'PAPERCUSP_IMPROVEMENT_DRAIN_STOPS_CLAIMS';
  afterEach(() => {
    delete process.env[VAR];
    __resetShutdownStateForTest();
  });

  it('drainStopsImprovementClaims is OFF when the env flag is unset', () => {
    expect(drainStopsImprovementClaims({})).toBe(false);
  });

  it('arms on 1/true/on (case-insensitive, whitespace-tolerant); stays off otherwise', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'On', ' 1 ']) {
      expect(drainStopsImprovementClaims({ [VAR]: v })).toBe(true);
    }
    for (const v of ['0', 'false', 'off', '', '   ', 'yes', 'enabled']) {
      expect(drainStopsImprovementClaims({ [VAR]: v })).toBe(false);
    }
  });

  it('DEFAULT-OFF: even while draining, an UNARMED flag does not stop claims (zero behavior change until armed)', () => {
    expect(shouldStopClaimingForDrain({ draining: true, env: {} })).toBe(false);
  });

  it('armed but NOT draining: does not stop claims (only fires during a real drain)', () => {
    expect(shouldStopClaimingForDrain({ draining: false, env: { [VAR]: '1' } })).toBe(false);
  });

  it('armed AND draining: stops claims', () => {
    expect(shouldStopClaimingForDrain({ draining: true, env: { [VAR]: '1' } })).toBe(true);
  });

  it('reads the LIVE process drain flag when `draining` is not passed explicitly', () => {
    process.env[VAR] = '1';
    expect(isShuttingDown()).toBe(false);
    expect(shouldStopClaimingForDrain()).toBe(false); // armed, but not draining yet
    markShuttingDown(); // the SIGTERM handler's call, simulated
    expect(shouldStopClaimingForDrain()).toBe(true); // armed + draining ⇒ stop
  });
});
