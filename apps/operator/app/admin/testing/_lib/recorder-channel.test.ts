// @vitest-environment jsdom
/**
 * Tests for the chaos/perf recorder-channel persistence + rollup helpers.
 *
 *  - `rollupRoutes` — the PURE per-route aggregation behind the run report:
 *    groups events by route, counts clicks + errors, and derives p50/p95/max
 *    INP from the sorted click-INP samples (percentile = value at
 *    `floor(n * q)`; max = last). Bucketing is index-based, so the exact
 *    fixtures below pin the math.
 *  - `saveRun` / `loadRuns` / `clearRuns` — the localStorage round-trip:
 *    newest-first ordering, the MAX_RUNS cap, malformed-JSON tolerance, and
 *    the quota-fallback that re-stores a compacted (truncated-events /
 *    clipped-detail) copy when the full write throws.
 *
 * jsdom for localStorage; no fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuns,
  loadRuns,
  rollupRoutes,
  saveRun,
  type RecorderEvent,
  type RunSummary,
} from './recorder-channel';

const LS_RUNS_KEY = 'papercusp.testing.chaos-runs.v1';

// The env's bare `localStorage` global is a broken Node experimental shim
// (a stray --localstorage-file), so install a real in-memory one — the same
// pattern the other localStorage tests use (AutoLoginWelcomeToast.component).
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
}

beforeEach(() => {
  installLocalStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function click(route: string, inp?: number): RecorderEvent {
  return { ts: 0, route, kind: 'click', target: 'btn', inp };
}
function err(route: string, kind: 'console-error' | 'unhandled-error'): RecorderEvent {
  return { ts: 0, route, kind, target: '' };
}
function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'r1',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    clicks: 0,
    events: [],
    routes: {},
    ...overrides,
  };
}

describe('rollupRoutes', () => {
  it('returns an empty map for no events', () => {
    expect(rollupRoutes([])).toEqual({});
  });

  it('groups by route and derives index-based percentiles', () => {
    const events: RecorderEvent[] = [
      click('/a', 10),
      click('/a', 30),
      click('/a', 20),
      click('/a'), // click with no INP — counts toward clicks, not the INP samples
      err('/a', 'console-error'),
      err('/b', 'unhandled-error'),
    ];
    const out = rollupRoutes(events);
    // /a: clicks = 4, INP samples sorted = [10,20,30] (n=3)
    //   p50 = inps[floor(3*0.5)=1] = 20
    //   p95 = inps[floor(3*0.95)=2] = 30
    //   max = inps[2] = 30 ; errors = 1
    expect(out['/a']).toEqual({
      route: '/a',
      clicks: 4,
      p50inp: 20,
      p95inp: 30,
      maxInp: 30,
      errors: 1,
    });
    // /b: only an unhandled-error — no clicks, zeroed INP, 1 error
    expect(out['/b']).toEqual({
      route: '/b',
      clicks: 0,
      p50inp: 0,
      p95inp: 0,
      maxInp: 0,
      errors: 1,
    });
  });

  it('counts both console-error and unhandled-error toward errors', () => {
    const out = rollupRoutes([err('/x', 'console-error'), err('/x', 'unhandled-error')]);
    expect(out['/x'].errors).toBe(2);
    expect(out['/x'].clicks).toBe(0);
  });

  it('ignores non-numeric INP when sampling percentiles', () => {
    const out = rollupRoutes([click('/y'), click('/y'), click('/y', 50)]);
    // 3 clicks, but only one numeric INP sample → all percentiles = 50
    expect(out['/y'].clicks).toBe(3);
    expect(out['/y'].maxInp).toBe(50);
    expect(out['/y'].p50inp).toBe(50);
  });
});

describe('saveRun / loadRuns / clearRuns', () => {
  it('round-trips a saved run', () => {
    const r = run({ runId: 'alpha' });
    const returned = saveRun(r);
    expect(returned).toHaveLength(1);
    expect(returned[0].runId).toBe('alpha');
    expect(loadRuns().map((x) => x.runId)).toEqual(['alpha']);
  });

  it('prepends newest-first', () => {
    saveRun(run({ runId: 'first' }));
    const after = saveRun(run({ runId: 'second' }));
    expect(after.map((r) => r.runId)).toEqual(['second', 'first']);
  });

  it('caps the stored list at MAX_RUNS (10)', () => {
    for (let i = 0; i < 14; i++) saveRun(run({ runId: `run-${i}` }));
    const stored = loadRuns();
    expect(stored).toHaveLength(10);
    // Newest (run-13) first, oldest kept is run-4 (4..13 = 10 runs).
    expect(stored[0].runId).toBe('run-13');
    expect(stored.at(-1)!.runId).toBe('run-4');
  });

  it('loadRuns returns [] when nothing is stored', () => {
    expect(loadRuns()).toEqual([]);
  });

  it('loadRuns tolerates malformed JSON', () => {
    localStorage.setItem(LS_RUNS_KEY, '{not json');
    expect(loadRuns()).toEqual([]);
  });

  it('clearRuns removes the stored runs', () => {
    saveRun(run());
    expect(loadRuns()).toHaveLength(1);
    clearRuns();
    expect(loadRuns()).toEqual([]);
  });

  it('falls back to a compacted copy when the full write hits quota', () => {
    const longDetail = 'x'.repeat(300);
    const r = run({ events: [{ ts: 0, route: '/a', kind: 'click', target: 'b', detail: longDetail }] });
    // First setItem (full payload) throws quota; the compaction retry uses
    // the real implementation and succeeds.
    const spy = vi.spyOn(localStorage, 'setItem');
    spy.mockImplementationOnce(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    const returned = saveRun(r);
    expect(returned).toHaveLength(1);
    // compactRun clips event.detail to 200 chars.
    expect(returned[0].events[0].detail).toHaveLength(200);
    // And the compacted copy actually persisted on the retry.
    expect(loadRuns()[0].events[0].detail).toHaveLength(200);
  });
});
