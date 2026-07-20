import { describe, expect, it } from 'vitest';
import {
  evaluateDesktopPerfGate,
  desktopPerfGatePolicyFromFlags,
  runDesktopPerfGate,
  failingMeasures,
  type DesktopPerfGatePolicy,
} from './desktop-perf-gate';
import type { DesktopPerfRun, DesktopPerfMeasure } from '@papercusp/operator-core/lib/system-health/desktop-perf-runs';

function run(measures: DesktopPerfMeasure[], status: DesktopPerfRun['status'] = 'pass'): DesktopPerfRun {
  return { id: 'r1', workspaceId: 'default', createdTs: 1, source: 'admin-suite', status, gitSha: 'abc12345', runId: 'testrun-1', measures };
}
const ok: DesktopPerfMeasure = { key: 'route:harness-warm', value: 900, unit: 'ms', budget: 1500, ok: true };
const breach: DesktopPerfMeasure = { key: 'interaction:plan-popup-open', value: 1800, unit: 'ms', budget: 1500, ok: false };
const WARN_ONLY: DesktopPerfGatePolicy = { enabled: true, block: false };
const ARMED: DesktopPerfGatePolicy = { enabled: true, block: true };

describe('evaluateDesktopPerfGate (pure)', () => {
  it('disabled → pass, reads nothing', () => {
    const d = evaluateDesktopPerfGate(run([breach]), { enabled: false, block: false }, 'deadbeefcafef00d');
    expect(d.action).toBe('pass');
    expect(d.verdictStatus).toBe('unknown');
    expect(d.summary).toContain('disabled');
  });

  it('no run / no measures → pass (fail-soft unknown)', () => {
    expect(evaluateDesktopPerfGate(null, WARN_ONLY).action).toBe('pass');
    expect(evaluateDesktopPerfGate(null, WARN_ONLY).verdictStatus).toBe('unknown');
    expect(evaluateDesktopPerfGate(run([]), WARN_ONLY).action).toBe('pass');
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
  it('enabled tracks the flag; block is always false in V1', async () => {
    expect(await desktopPerfGatePolicyFromFlags(async () => true)).toEqual({ enabled: true, block: false });
    expect(await desktopPerfGatePolicyFromFlags(async () => false)).toEqual({ enabled: false, block: false });
  });
  it('a flag-read error fails safe to disabled', async () => {
    expect(await desktopPerfGatePolicyFromFlags(async () => { throw new Error('boom'); })).toEqual({ enabled: false, block: false });
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
