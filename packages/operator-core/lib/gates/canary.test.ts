/**
 * canary.test.ts — the gate-canary classification + runner substrate
 * (fleet-reliability-verification-2026-07-10 P-011).
 */
import { describe, it, expect, vi } from 'vitest';
import { classifyGateCanary, runGateCanary, runGateCanaries, type GateCanaryDef } from './canary';

describe('classifyGateCanary', () => {
  it('canaryOk:null (undetermined) is ALWAYS gate-suspect, regardless of systemGreen', () => {
    expect(classifyGateCanary({ canaryOk: null, systemGreen: true })).toMatchObject({ verdict: 'unknown', alarm: 'gate' });
    expect(classifyGateCanary({ canaryOk: null, systemGreen: false })).toMatchObject({ verdict: 'unknown', alarm: 'gate' });
    expect(classifyGateCanary({ canaryOk: null, systemGreen: null })).toMatchObject({ verdict: 'unknown', alarm: 'gate' });
  });

  it('canaryOk:false is ALWAYS gate-broken, regardless of systemGreen (the cause-#10 class)', () => {
    expect(classifyGateCanary({ canaryOk: false, systemGreen: true })).toMatchObject({ verdict: 'gate-broken', alarm: 'gate' });
    expect(classifyGateCanary({ canaryOk: false, systemGreen: false })).toMatchObject({ verdict: 'gate-broken', alarm: 'gate' });
    expect(classifyGateCanary({ canaryOk: false, systemGreen: null })).toMatchObject({ verdict: 'gate-broken', alarm: 'gate' });
  });

  it('canaryOk:true + systemGreen:false => system-broken, alarm system (trust the red)', () => {
    expect(classifyGateCanary({ canaryOk: true, systemGreen: false })).toMatchObject({ verdict: 'system-broken', alarm: 'system' });
  });

  it('canaryOk:true + systemGreen:true => healthy, no alarm', () => {
    expect(classifyGateCanary({ canaryOk: true, systemGreen: true })).toMatchObject({ verdict: 'healthy', alarm: 'none' });
  });

  it('canaryOk:true + systemGreen:null => unknown but NOT alarmed (the gate itself is proven fine; there is just no real verdict yet)', () => {
    expect(classifyGateCanary({ canaryOk: true, systemGreen: null })).toMatchObject({ verdict: 'unknown', alarm: 'none' });
  });
});

describe('runGateCanary', () => {
  const def = (run: GateCanaryDef['run'], extra: Partial<GateCanaryDef> = {}): GateCanaryDef => ({
    id: 'test-canary',
    describe: 'a test canary',
    run,
    ...extra,
  });

  it('a passing canary + green system => healthy report', async () => {
    const report = await runGateCanary(def(async () => ({ ok: true, detail: 'all good' })), true, { nowMs: 1000 });
    expect(report).toMatchObject({
      id: 'test-canary',
      ranAtMs: 1000,
      canaryOk: true,
      canaryDetail: 'all good',
      systemGreen: true,
      classification: { verdict: 'healthy', alarm: 'none' },
    });
  });

  it('a failing canary => gate-broken, regardless of systemGreen', async () => {
    const report = await runGateCanary(def(async () => ({ ok: false, detail: 'stamp refused' })), false);
    expect(report.canaryOk).toBe(false);
    expect(report.classification).toMatchObject({ verdict: 'gate-broken', alarm: 'gate' });
  });

  it('a THROWING canary is caught, not propagated — reads as undetermined (gate-suspect)', async () => {
    const report = await runGateCanary(def(async () => {
      throw new Error('boom');
    }), true);
    expect(report.canaryOk).toBeNull();
    expect(report.canaryDetail).toContain('boom');
    expect(report.classification).toMatchObject({ verdict: 'unknown', alarm: 'gate' });
  });

  it('a canary that never resolves TIMES OUT — never hangs the caller', async () => {
    vi.useFakeTimers();
    try {
      const hung = def(() => new Promise(() => {}), { timeoutMs: 50 });
      const p = runGateCanary(hung, true);
      await vi.advanceTimersByTimeAsync(60);
      const report = await p;
      expect(report.canaryOk).toBeNull();
      expect(report.canaryDetail).toContain('timed out');
      expect(report.classification.alarm).toBe('gate');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a canary omitting detail gets a generic pass/fail note', async () => {
    const ok = await runGateCanary(def(async () => ({ ok: true })), null);
    expect(ok.canaryDetail).toBe('canary passed');
    const fail = await runGateCanary(def(async () => ({ ok: false })), null);
    expect(fail.canaryDetail).toBe('canary failed');
  });

  it('defaults ranAtMs to Date.now() when nowMs is omitted', async () => {
    const before = Date.now();
    const report = await runGateCanary(def(async () => ({ ok: true })), null);
    expect(report.ranAtMs).toBeGreaterThanOrEqual(before);
  });
});

describe('runGateCanaries', () => {
  it('runs many independently, in parallel, correlated by id', async () => {
    const defs = [
      { def: { id: 'a', describe: 'A', run: async () => ({ ok: true }) }, systemGreen: true },
      { def: { id: 'b', describe: 'B', run: async () => ({ ok: false }) }, systemGreen: false },
    ];
    const reports = await runGateCanaries(defs);
    expect(reports.map((r) => r.id)).toEqual(['a', 'b']);
    expect(reports[0].classification.verdict).toBe('healthy');
    expect(reports[1].classification.verdict).toBe('gate-broken'); // canaryOk:false wins regardless of systemGreen
  });

  it('one canary throwing does not prevent siblings from reporting', async () => {
    const defs = [
      { def: { id: 'ok', describe: 'ok', run: async () => ({ ok: true }) }, systemGreen: true },
      {
        def: {
          id: 'throws',
          describe: 'throws',
          run: async () => {
            throw new Error('nope');
          },
        },
        systemGreen: true,
      },
    ];
    const reports = await runGateCanaries(defs);
    expect(reports[0].classification.verdict).toBe('healthy');
    expect(reports[1].canaryOk).toBeNull();
    expect(reports[1].classification.alarm).toBe('gate');
  });
});
