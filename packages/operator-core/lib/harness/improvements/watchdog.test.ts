import { describe, it, expect, vi } from 'vitest';
import {
  planWatchdogCaptures,
  collectServiceDownSignals,
  runWatchdogTick,
  isImprovementLoopTool,
  toolErrorSignalsFromRows,
  type WatchdogSignal,
  type WatchdogCollector,
  type WatchdogTickRecord,
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

describe('tool-error sweep excludes the loop’s own tools (watchdog-robustness P-006)', () => {
  it('isImprovementLoopTool matches improvements:* and system:improvement-* only', () => {
    expect(isImprovementLoopTool('improvements:capture')).toBe(true);
    expect(isImprovementLoopTool('improvements:resolve')).toBe(true);
    expect(isImprovementLoopTool('system:improvement-watchdog')).toBe(true);
    expect(isImprovementLoopTool('system:improvement-implement')).toBe(true);
    // unrelated tools are NOT excluded
    expect(isImprovementLoopTool('git:status')).toBe(false);
    expect(isImprovementLoopTool('plans:get')).toBe(false);
    expect(isImprovementLoopTool('improvement-runner')).toBe(false); // no colon prefix
  });

  it('a synthetic improvements:capture error row is not turned into a signal; an unrelated tool still is', () => {
    const rows = [
      { tool_name: 'improvements:capture', n: 9, sample: 'pg hiccup' },
      { tool_name: 'system:improvement-watchdog', n: 12, sample: 'boom' },
      { tool_name: 'docs:get', n: 7, sample: 'timeout' },
    ];
    const signals = toolErrorSignalsFromRows(rows, 60);
    expect(signals.map((s) => s.key)).toEqual(['docs:get']);
    expect(signals[0].source).toBe('repeated-tool-error');
  });

  it('severity escalates to major at high counts', () => {
    const signals = toolErrorSignalsFromRows(
      [
        { tool_name: 'a:x', n: 25, sample: null },
        { tool_name: 'b:y', n: 6, sample: null },
      ],
      60,
    );
    expect(signals.find((s) => s.key === 'a:x')?.severity).toBe('major');
    expect(signals.find((s) => s.key === 'b:y')?.severity).toBe('minor');
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
  /** No-op tick sink so unit tests never touch PG (the default recordTick writes PG). */
  const noopRecord = async (): Promise<void> => {};

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
    const res = await runWatchdogTick('ws', {}, { collect: async () => signals, capture, recordTick: noopRecord });
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
    const res = await runWatchdogTick('ws', {}, { collect: async () => [sig({ key: 'x' })], capture, recordTick: noopRecord });
    expect(res.captured).toHaveLength(0);
    expect(res.declinedDuplicates).toBe(1);
  });

  it('respects the per-tick cap (deferred surfaces in the result)', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' })];
    const res = await runWatchdogTick('ws', { maxPerTick: 1 }, { collect: async () => signals, capture, recordTick: noopRecord });
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
      const res = await runWatchdogTick('ws', {}, { collect: async () => [sig({ key: 'a' }), sig({ key: 'b' })], capture, recordTick: noopRecord });
      expect(res.captured).toEqual(['EI-9']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/capture failed for red-test:a/));
    } finally {
      warn.mockRestore();
    }
  });

  it('(P-011) accepts pluggable per-target collectors', async () => {
    const { calls, capture } = captureRecorder();
    const customCollectors: WatchdogCollector[] = [
      {
        name: 'my-project-integration-tests',
        collect: async () => [
          sig({ key: 'integration-test', source: 'red-test', title: 'My project integration test failing' }),
        ],
      },
      {
        name: 'my-project-smoke',
        collect: async () => [sig({ key: 'smoke', source: 'smoke-fail', title: 'My project smoke test failing' })],
      },
    ];
    const res = await runWatchdogTick('ws', {}, { collectors: customCollectors, capture, recordTick: noopRecord });
    expect(res.captured).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ title: 'My project integration test failing' });
    expect(calls[1]).toMatchObject({ title: 'My project smoke test failing' });
  });

  it('(P-011) collector failures are caught + logged but do not abort the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { capture } = captureRecorder();
      const collectors: WatchdogCollector[] = [
        {
          name: 'good-collector',
          collect: async () => [sig({ key: 'good', title: 'Good signal' })],
        },
        {
          name: 'bad-collector',
          collect: async () => {
            throw new Error('connection timeout');
          },
        },
      ];
      const res = await runWatchdogTick('ws', {}, { collectors, capture, recordTick: noopRecord });
      expect(res.signals).toBe(1); // only the good signal
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/collector "bad-collector" failed/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runWatchdogTick — tick record (watchdog-robustness P-001)', () => {
  function captureOk() {
    let i = 0;
    return async (): Promise<CaptureImprovementResult> =>
      ({ ok: true, created: true, issue: { id: `EI-${++i}` } as never, possibleDuplicates: [] }) as CaptureImprovementResult;
  }

  it('writes one tick record with status, captured ids, and per-collector statuses', async () => {
    const records: WatchdogTickRecord[] = [];
    const collectors: WatchdogCollector[] = [
      { name: 'good', collect: async () => [sig({ key: 'a', title: 'A' })] },
      { name: 'bad', collect: async () => { throw new Error('boom'); } },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runWatchdogTick('ws-1', {}, {
        collectors,
        capture: captureOk(),
        recordTick: async (r) => { records.push(r); },
      });
      expect(records).toHaveLength(1);
      const rec = records[0];
      expect(rec).toMatchObject({ workspaceId: 'ws-1', status: 'ran', signals: 1 });
      expect(rec.captured).toEqual(res.captured);
      // per-collector status reflects the good + failed collector
      expect(rec.collectors).toEqual([
        { name: 'good', ok: true, signalCount: 1 },
        { name: 'bad', ok: false, signalCount: 0, error: 'boom' },
      ]);
      expect(rec.selfEscalations).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('records the installSlug when given', async () => {
    const records: WatchdogTickRecord[] = [];
    await runWatchdogTick('ws-2', { installSlug: 'papercup' }, {
      collect: async () => [],
      capture: captureOk(),
      recordTick: async (r) => { records.push(r); },
    });
    expect(records[0].installSlug).toBe('papercup');
  });

  it('a tick-record failure does NOT abort the tick (best-effort bookkeeping)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runWatchdogTick('ws-3', {}, {
        collect: async () => [sig({ key: 'a' })],
        capture: captureOk(),
        recordTick: async () => { throw new Error('pg down'); },
      });
      expect(res.captured).toHaveLength(1); // tick still completed + returned
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tick record failed: pg down/));
    } finally {
      warn.mockRestore();
    }
  });
});
