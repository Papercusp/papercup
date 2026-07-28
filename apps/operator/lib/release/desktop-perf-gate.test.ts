import { describe, expect, it } from 'vitest';
import {
  evaluateDesktopPerfGate,
  desktopPerfGatePolicyFromFlags,
  runDesktopPerfGate,
  failingMeasures,
  DEFAULT_DESKTOP_PERF_MAX_AGE_MS,
  type DesktopPerfGatePolicy,
} from './desktop-perf-gate';
import type { DesktopPerfRun, DesktopPerfMeasure } from '@papercusp/operator-core/lib/system-health/desktop-perf-runs';

// `createdTs` defaults to NOW because the gate now applies a freshness window: the
// previous fixture value of 1 (epoch+1ms, i.e. 1970) would make every run in this
// file STALE and route all of these cases into the fail-soft branch, quietly
// gutting the suite instead of failing it.
function run(
  measures: DesktopPerfMeasure[],
  status: DesktopPerfRun['status'] = 'pass',
  createdTs: number = Date.now(),
): DesktopPerfRun {
  return { id: 'r1', workspaceId: 'default', createdTs, source: 'admin-suite', status, gitSha: 'abc12345', runId: 'testrun-1', measures };
}
const ok: DesktopPerfMeasure = { key: 'route:harness-warm', value: 900, unit: 'ms', budget: 1500, ok: true };
const breach: DesktopPerfMeasure = { key: 'interaction:plan-popup-open', value: 1800, unit: 'ms', budget: 1500, ok: false };
const WARN_ONLY: DesktopPerfGatePolicy = { enabled: true, block: false, maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS };
const ARMED: DesktopPerfGatePolicy = { enabled: true, block: true, maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS };

describe('evaluateDesktopPerfGate (pure)', () => {
  it('disabled → pass, reads nothing', () => {
    const d = evaluateDesktopPerfGate(
      run([breach]),
      { enabled: false, block: false, maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS },
      'deadbeefcafef00d',
    );
    expect(d.action).toBe('pass');
    expect(d.verdictStatus).toBe('unknown');
    expect(d.summary).toContain('disabled');
  });

  it('no run / no measures → pass (fail-soft unknown)', () => {
    expect(evaluateDesktopPerfGate(null, WARN_ONLY).action).toBe('pass');
    expect(evaluateDesktopPerfGate(null, WARN_ONLY).verdictStatus).toBe('unknown');
    expect(evaluateDesktopPerfGate(run([]), WARN_ONLY).action).toBe('pass');
  });

  // Freshness window (WI-6538). Before this, `readLatestRun` returned the most
  // recent row at ANY age, so ONE run would be re-applied as the verdict for every
  // later candidate forever. That was invisible only because the table was empty.
  describe('freshness window', () => {
    const NOW = 1_800_000_000_000;
    const hoursAgo = (h: number) => NOW - h * 3_600_000;

    it('a run older than the window → fail-soft pass/unknown, never a breach', () => {
      const d = evaluateDesktopPerfGate(run([breach], 'fail', hoursAgo(30)), WARN_ONLY, 'abc123', NOW);
      expect(d.action).toBe('pass');
      expect(d.verdictStatus).toBe('unknown');
      expect(d.summary).toContain('STALE');
      expect(d.summary).toContain('30h old');
      expect(d.reasons).toEqual([]);
    });

    it('staleness outranks block-mode — an armed gate still will not block on old data', () => {
      const d = evaluateDesktopPerfGate(run([breach], 'fail', hoursAgo(72)), ARMED, 'abc123', NOW);
      expect(d.action).toBe('pass');
      expect(d.verdictStatus).toBe('unknown');
    });

    it('a run INSIDE the window is still judged normally', () => {
      const d = evaluateDesktopPerfGate(run([breach], 'fail', hoursAgo(2)), WARN_ONLY, 'abc123', NOW);
      expect(d.action).toBe('warn');
      expect(d.verdictStatus).toBe('crit');
    });

    // The distinction the whole window exists to preserve: an OLD run must not be
    // reported as a healthy pass, because "clean" and "nobody measured in days"
    // are opposite operational facts that a bare `pass` would conflate.
    it('a stale PASSING run is reported unknown, not ok', () => {
      const d = evaluateDesktopPerfGate(run([ok], 'pass', hoursAgo(48)), WARN_ONLY, 'abc123', NOW);
      expect(d.verdictStatus).toBe('unknown');
      expect(d.summary).toContain('STALE');
    });

    it('maxAgeMs of 0 disables the window rather than staling everything', () => {
      const policy: DesktopPerfGatePolicy = { enabled: true, block: false, maxAgeMs: 0 };
      const d = evaluateDesktopPerfGate(run([breach], 'fail', hoursAgo(9000)), policy, 'abc123', NOW);
      expect(d.verdictStatus).toBe('crit');
    });
  });

  it('all budgeted measures met → pass (ok)', () => {
    const d = evaluateDesktopPerfGate(run([ok]), WARN_ONLY);
    expect(d.action).toBe('pass');
    expect(d.verdictStatus).toBe('ok');
  });

  it('a budgeted breach → warn when block-mode not armed (default), crit verdict + reasons', () => {
    const d = evaluateDesktopPerfGate(run([ok, breach]), WARN_ONLY, 'deadbeefcafef00d');
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('crit');
    expect(d.reasons).toEqual(['interaction:plan-popup-open 1800ms > budget 1500ms']);
    expect(d.summary).toContain('deadbeef');
    expect(d.summary).toContain('block-mode not armed');
  });

  it('a budgeted breach → block when block-mode is armed', () => {
    const d = evaluateDesktopPerfGate(run([breach]), ARMED);
    expect(d.action).toBe('block');
    expect(d.verdictStatus).toBe('crit');
    expect(d.summary).toContain('BLOCKED');
  });

  it('an UNBUDGETED failing measure is not a regression → pass', () => {
    const unbudgeted: DesktopPerfMeasure = { key: 'x', value: 999, unit: 'ms', budget: null, ok: false };
    expect(evaluateDesktopPerfGate(run([unbudgeted]), ARMED).action).toBe('pass');
    expect(failingMeasures(run([unbudgeted]))).toEqual([]);
  });

  it('a warned run with no budgeted breach → warn (never block, even armed)', () => {
    const d = evaluateDesktopPerfGate(run([ok], 'warn'), ARMED);
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('warn');
  });

  it('formats kb (RSS) and count budgets in the reason', () => {
    const rss: DesktopPerfMeasure = { key: 'memory:rss-kb', value: 4_194_304, unit: 'kb', budget: 3_670_016, ok: false };
    const drops: DesktopPerfMeasure = { key: 'chaos:frame-drops', value: 12, unit: 'count', budget: 8, ok: false };
    const d = evaluateDesktopPerfGate(run([rss, drops]), WARN_ONLY);
    expect(d.reasons).toEqual(['memory:rss-kb 4096MB > budget 3584MB', 'chaos:frame-drops 12 > budget 8']);
  });
});

describe('desktopPerfGatePolicyFromFlags', () => {
  const V1 = { block: false, maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS };
  it('enabled tracks the flag; block is always false in V1', async () => {
    expect(await desktopPerfGatePolicyFromFlags(async () => true)).toEqual({ enabled: true, ...V1 });
    expect(await desktopPerfGatePolicyFromFlags(async () => false)).toEqual({ enabled: false, ...V1 });
  });
  it('a flag-read error fails safe to disabled', async () => {
    expect(await desktopPerfGatePolicyFromFlags(async () => { throw new Error('boom'); })).toEqual({ enabled: false, ...V1 });
  });
  it('ships a freshness window by default — an unbounded gate re-asserts old runs forever', async () => {
    const policy = await desktopPerfGatePolicyFromFlags(async () => true);
    expect(policy.maxAgeMs).toBeGreaterThan(0);
  });
});

describe('runDesktopPerfGate', () => {
  it('disabled → pass without reading a run', async () => {
    let read = 0;
    const d = await runDesktopPerfGate({ enabled: false, block: false }, {
      io: { readLatestRun: async () => { read += 1; return run([breach]); } },
    });
    expect(d.action).toBe('pass');
    expect(read).toBe(0);
  });

  it('enabled + a regressed latest run → warn', async () => {
    const d = await runDesktopPerfGate(WARN_ONLY, {
      workspaceId: 'default', candidateSha: 'feedface0000',
      io: { readLatestRun: async () => run([breach]) },
    });
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('crit');
  });

  it('a read error degrades to unknown → pass (fail-soft)', async () => {
    const d = await runDesktopPerfGate(WARN_ONLY, {
      io: { readLatestRun: async () => { throw new Error('pg down'); } },
    });
    expect(d.action).toBe('pass');
    expect(d.verdictStatus).toBe('unknown');
  });
});
