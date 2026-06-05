import { describe, it, expect, vi } from 'vitest';
import {
  planWatchdogCaptures,
  collectServiceDownSignals,
  runWatchdogTick,
  type WatchdogSignal,
} from './watchdog';
import type { CaptureImprovementResult } from './capture-core';
import type { ProbeResult } from '../../service-health';

function sig(p: Partial<WatchdogSignal> & { key: string }): WatchdogSignal {
  return {
    source: 'red-test',
    title: `Test failing repeatedly: ${p.key}`,
    body: 'detail',
    severity: 'major',
    ...p,
  };
}

describe('planWatchdogCaptures — pure anti-flood planning (close-loop D-003)', () => {
  it('caps captures per tick, highest severity first', () => {
    const signals = [
      sig({ key: 'a', severity: 'minor' }),
      sig({ key: 'b', severity: 'critical' }),
      sig({ key: 'c', severity: 'major' }),
    ];
    const plan = planWatchdogCaptures(signals, { maxPerTick: 2 });
    expect(plan.toCapture.map((s) => s.key)).toEqual(['b', 'c']);
    expect(plan.deferred.map((s) => s.key)).toEqual(['a']);
  });

  it('dedupes by source+key within a tick', () => {
    const plan = planWatchdogCaptures([sig({ key: 'a' }), sig({ key: 'a' })], { maxPerTick: 5 });
    expect(plan.toCapture).toHaveLength(1);
  });

  it('same key from DIFFERENT sources are distinct signals', () => {
    const plan = planWatchdogCaptures(
      [sig({ key: 'a', source: 'red-test' }), sig({ key: 'a', source: 'smoke-fail' })],
      { maxPerTick: 5 },
    );
    expect(plan.toCapture).toHaveLength(2);
  });

  it('default cap is 3', () => {
    const plan = planWatchdogCaptures([sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' }), sig({ key: 'd' })]);
    expect(plan.toCapture).toHaveLength(3);
    expect(plan.deferred).toHaveLength(1);
  });
});

describe('collectServiceDownSignals', () => {
  const probe = (p: Partial<ProbeResult> & { name: string }): ProbeResult => ({
    up: true,
    status: 200,
    latencyMs: 5,
    ...p,
  });

  it('captures only DOWN + present services', () => {
    const out = collectServiceDownSignals([
      probe({ name: 'operator' }),
      probe({ name: 'vite', up: false, status: null }),
      probe({ name: 'desktop', up: false, present: false }), // legitimately absent → no signal
    ]);
    expect(out.map((s) => s.key)).toEqual(['vite']);
    expect(out[0].title).toBe('Service vite is down');
    expect(out[0].severity).toBe('major');
  });
});

describe('runWatchdogTick — captures through the shared core', () => {
  function captureRecorder(results: Partial<CaptureImprovementResult>[] = []) {
    const calls: unknown[] = [];
    let i = 0;
    const capture = async (input: unknown): Promise<CaptureImprovementResult> => {
      calls.push(input);
      const r = results[i++] ?? {};
      return {
        ok: true,
        created: r.created ?? true,
        reason: r.reason,
        issue: r.created === false ? undefined : ({ id: `EI-${100 + i}` } as never),
        possibleDuplicates: [],
        ...r,
      } as CaptureImprovementResult;
    };
    return { calls, capture };
  }

  it('captures each planned signal as kind=bug with dedupScope open + the paths', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'lib/a.test.ts', paths: ['lib/a.test.ts'] })];
    const res = await runWatchdogTick('ws', {}, { collect: async () => signals, capture });
    expect(res.captured).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'bug',
      dedupScope: 'open',
      paths: ['lib/a.test.ts'],
      foundDuring: 'improvement-watchdog',
    });
  });

  it('counts declined open-duplicates instead of re-filing (cross-tick dedup)', async () => {
    const { capture } = captureRecorder([{ created: false, reason: 'likely-duplicate' }]);
    const res = await runWatchdogTick('ws', {}, { collect: async () => [sig({ key: 'x' })], capture });
    expect(res.captured).toHaveLength(0);
    expect(res.declinedDuplicates).toBe(1);
  });

  it('respects the per-tick cap (deferred surfaces in the result)', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' })];
    const res = await runWatchdogTick('ws', { maxPerTick: 1 }, { collect: async () => signals, capture });
    expect(calls).toHaveLength(1);
    expect(res.deferred).toBe(2);
  });

  it('a single capture failure does not abort the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let n = 0;
      const capture = async (): Promise<CaptureImprovementResult> => {
        n += 1;
        if (n === 1) throw new Error('pg hiccup');
        return { ok: true, created: true, issue: { id: 'EI-9' } as never, possibleDuplicates: [] };
      };
      const res = await runWatchdogTick('ws', {}, { collect: async () => [sig({ key: 'a' }), sig({ key: 'b' })], capture });
      expect(res.captured).toEqual(['EI-9']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/capture failed for red-test:a/));
    } finally {
      warn.mockRestore();
    }
  });
});
