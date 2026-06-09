import { describe, it, expect, vi } from 'vitest';
import {
  planWatchdogCaptures,
  collectServiceDownSignals,
  runWatchdogTick,
  isImprovementLoopTool,
  toolErrorSignalsFromRows,
  isServiceHealthStale,
  serviceDownCollectorResult,
  DEFAULT_SERVICE_HEALTH_MAX_STALE_MS,
  planSelfEscalations,
  withWatchdogTickLock,
  type WatchdogSignal,
  type WatchdogCollector,
  type WatchdogTickRecord,
  type RecentTick,
  type CollectorStatus,
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

describe('service-down freshness gate (watchdog-robustness P-004)', () => {
  const probe = (p: Partial<ProbeResult> & { name: string }): ProbeResult => ({
    up: true,
    status: 200,
    latencyMs: 5,
    ...p,
  });

  it('isServiceHealthStale: never-probed (null) is stale; fresh is not; beyond the window is', () => {
    const now = 1_000_000;
    const maxStale = 120_000;
    expect(isServiceHealthStale(null, now, maxStale)).toBe(true);
    expect(isServiceHealthStale(now - 30_000, now, maxStale)).toBe(false);
    expect(isServiceHealthStale(now - 200_000, now, maxStale)).toBe(true);
    expect(isServiceHealthStale(now, now, maxStale)).toBe(false);
  });

  it('a FRESH snapshot yields the down signals as before', () => {
    const now = 1_000_000;
    const res = serviceDownCollectorResult({
      results: [probe({ name: 'vite', up: false, status: null })],
      at: now - 10_000,
      now,
      maxStaleMs: 120_000,
    });
    expect(res.signals.map((s) => s.key)).toEqual(['vite']);
    expect(res.note).toBeUndefined();
  });

  it('a STALE snapshot yields NO signals + a stale-service-health note', () => {
    const now = 1_000_000;
    const res = serviceDownCollectorResult({
      results: [probe({ name: 'vite', up: false, status: null })],
      at: now - 200_000, // older than the 120s window
      now,
      maxStaleMs: 120_000,
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/stale-service-health/);
    expect(res.note).toMatch(/200s old/);
  });

  it('a NEVER-populated snapshot (at=null) skips with a "never populated" note', () => {
    const res = serviceDownCollectorResult({ results: [], at: null, now: 1_000_000, maxStaleMs: 120_000 });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/never populated/);
  });

  it('default window is 2× the 60s probe interval', () => {
    expect(DEFAULT_SERVICE_HEALTH_MAX_STALE_MS).toBe(120_000);
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

describe('planSelfEscalations — the watchdog watches itself (watchdog-robustness P-002)', () => {
  const fail = (name: string): CollectorStatus => ({ name, ok: false, signalCount: 0, error: 'boom' });
  const okc = (name: string): CollectorStatus => ({ name, ok: true, signalCount: 1 });
  const tick = (collectors: CollectorStatus[], status: 'ran' | 'skipped' = 'ran'): RecentTick => ({ status, collectors });

  it('escalates a collector failing this tick + the (need-1) prior ticks', () => {
    const out = planSelfEscalations([fail('bad')], [tick([fail('bad')]), tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual(['bad']);
  });

  it('does NOT escalate before the streak is reached', () => {
    const out = planSelfEscalations([fail('bad')], [tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]); // streak = 2 < 3
  });

  it('a recovered (ok) prior tick breaks the streak', () => {
    const out = planSelfEscalations([fail('bad')], [tick([okc('bad')]), tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]); // most-recent prior shows it recovered → streak resets
  });

  it('a skipped prior tick (no sweep) breaks the streak', () => {
    const out = planSelfEscalations([fail('bad')], [tick([], 'skipped'), tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]);
  });

  it('a collector healthy this tick never escalates', () => {
    const out = planSelfEscalations([okc('good')], [tick([fail('good')]), tick([fail('good')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]);
  });

  it('failStreakToEscalate=1 escalates on the first failing tick', () => {
    expect(planSelfEscalations([fail('bad')], [], { failStreakToEscalate: 1 })).toEqual(['bad']);
  });
});

describe('runWatchdogTick — self-escalation through the shared core (P-002)', () => {
  const throwingCollector: WatchdogCollector = {
    name: 'papercusp-red-test',
    collect: async () => { throw new Error('relation test_runs does not exist'); },
  };
  const priorFails = (n: number): RecentTick[] =>
    Array.from({ length: n }, () => ({ status: 'ran' as const, collectors: [{ name: 'papercusp-red-test', ok: false, signalCount: 0, error: 'x' }] }));

  function captureRecorder(result: Partial<CaptureImprovementResult> = {}) {
    const calls: unknown[] = [];
    const capture = async (input: unknown): Promise<CaptureImprovementResult> => {
      calls.push(input);
      return {
        ok: true,
        created: result.created ?? true,
        reason: result.reason,
        issue: result.created === false ? undefined : ({ id: 'EI-SELF' } as never),
        possibleDuplicates: [],
        ...result,
      } as CaptureImprovementResult;
    };
    return { calls, capture };
  }

  it('files exactly one kind=bug self-escalation when a collector hits the fail streak', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRecorder();
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, {
        collectors: [throwingCollector],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => priorFails(2), // 2 priors + this tick = streak 3
      });
      expect(res.selfEscalations).toEqual(['EI-SELF']);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        kind: 'bug',
        dedupScope: 'open',
        sourceRole: 'system',
        title: 'Watchdog collector "papercusp-red-test" is failing',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT self-escalate before the streak (no prior failing ticks)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRecorder();
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, {
        collectors: [throwingCollector],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => [], // no priors → streak 1 < 3
      });
      expect(res.selfEscalations).toEqual([]);
      expect(calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('an OPEN-duplicate self-escalation is not re-filed (dedup across ticks)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { capture } = captureRecorder({ created: false, reason: 'likely-duplicate' });
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, {
        collectors: [throwingCollector],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => priorFails(3),
      });
      expect(res.selfEscalations).toEqual([]); // declined as an open duplicate
    } finally {
      warn.mockRestore();
    }
  });

  it('a healthy tick does not read recent ticks or self-escalate', async () => {
    let readCalled = false;
    const { calls, capture } = captureRecorder();
    const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, {
      collect: async () => [sig({ key: 'a' })], // injected → collectors = [{injected, ok:true}]
      capture,
      recordTick: async () => {},
      readRecentTicks: async () => { readCalled = true; return []; },
    });
    expect(res.selfEscalations).toEqual([]);
    expect(readCalled).toBe(false); // short-circuited: nothing failed this tick
    expect(calls).toHaveLength(1); // only the real signal capture
  });

  it('caps self-escalations per tick (maxSelfEscalationsPerTick)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRecorder();
      const twoBad: WatchdogCollector[] = [
        { name: 'col-a', collect: async () => { throw new Error('a'); } },
        { name: 'col-b', collect: async () => { throw new Error('b'); } },
      ];
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 1, maxSelfEscalationsPerTick: 1 }, {
        collectors: twoBad,
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
      });
      expect(res.selfEscalations).toHaveLength(1); // both crossed, but capped at 1
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runWatchdogTick — cross-host lock (watchdog-robustness P-003)', () => {
  const captureOk = (counter: { n: number }) =>
    async (): Promise<CaptureImprovementResult> => {
      counter.n += 1;
      return { ok: true, created: true, issue: { id: `EI-${counter.n}` } as never, possibleDuplicates: [] } as CaptureImprovementResult;
    };

  it('runs the tick (and captures) when it HOLDS the lock', async () => {
    const counter = { n: 0 };
    const res = await runWatchdogTick('ws', {}, {
      collect: async () => [sig({ key: 'a' })],
      capture: captureOk(counter),
      recordTick: async () => {},
      withTickLock: async (_ws, fn) => ({ ran: true, value: await fn() }),
    });
    expect(res.status).toBe('ran');
    expect(res.captured).toEqual(['EI-1']);
    expect(counter.n).toBe(1);
  });

  it('SKIPS the tick (zero captures) + records a skipped tick when another host holds the lock', async () => {
    const counter = { n: 0 };
    const records: WatchdogTickRecord[] = [];
    const res = await runWatchdogTick('ws', { installSlug: 'papercup' }, {
      collect: async () => [sig({ key: 'a' })],
      capture: captureOk(counter),
      recordTick: async (r) => { records.push(r); },
      withTickLock: async () => ({ ran: false }), // another host owns it
    });
    expect(res.status).toBe('skipped');
    expect(res.captured).toEqual([]);
    expect(counter.n).toBe(0); // body never ran → nothing captured (no duplicate race)
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'skipped', installSlug: 'papercup', signals: 0 });
  });

  it('default lock FAILS OPEN when the DB is unavailable (runs fn unlocked, never double-runs)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let runs = 0;
      const out = await withWatchdogTickLock('ws', async () => { runs += 1; return 42; });
      expect(out).toEqual({ ran: true, value: 42 });
      expect(runs).toBe(1); // ran exactly once (fail-open, no double-run)
    } finally {
      warn.mockRestore();
    }
  });

  it('default lock propagates a fn error without double-running it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let runs = 0;
      await expect(
        withWatchdogTickLock('ws', async () => { runs += 1; throw new Error('body boom'); }),
      ).rejects.toThrow('body boom');
      expect(runs).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
