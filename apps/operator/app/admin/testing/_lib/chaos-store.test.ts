// @vitest-environment jsdom
/**
 * Tests for the module-level chaos run store (chaos-store.ts).
 *
 * The store exists so a run's state survives the React tree being torn down
 * + recreated when launch() opens a Tauri WebviewWindow. So the load-bearing
 * invariants are: (1) every mutation emits to subscribers, (2) every mutation
 * publishes a NEW snapshot reference (useSyncExternalStore compares by
 * identity — a mutated-in-place snapshot would silently not re-render), and
 * (3) finalize/refresh round-trip history through localStorage while
 * idleReset/clearHistory keep the right slices.
 *
 * It's a singleton, so each test resets to a clean baseline first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHistory,
  finalizeRun,
  getChaosSnapshot,
  idleReset,
  pushLiveEvent,
  refreshHistory,
  resetForNewRun,
  setProgress,
  setRunState,
  subscribeChaos,
} from './chaos-store';
import { clearRuns, loadRuns, type RecorderEvent, type RunSummary } from './recorder-channel';

// The env's bare `localStorage` global is a broken Node experimental shim;
// install a real in-memory one so finalize/refresh actually round-trip
// (matches AutoLoginWelcomeToast.component's pattern).
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
  installLocalStorage(); // fresh empty persisted store
  clearRuns(); // belt-and-suspenders: wipe persisted history
  idleReset(); // reset transient state (keeps lastSummary/history)
  clearHistory(); // drop in-memory history + lastSummary
});

function summary(runId: string): RunSummary {
  return {
    runId,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    clicks: 0,
    events: [],
    routes: {},
  };
}
const ev: RecorderEvent = { ts: 1, route: '/', kind: 'click', target: 'btn' };

describe('chaos-store baseline', () => {
  it('starts idle with empty transient state', () => {
    const s = getChaosSnapshot();
    expect(s.runState).toBe('idle');
    expect(s.runId).toBeNull();
    expect(s.liveEvents).toEqual([]);
    expect(s.lastSummary).toBeNull();
  });
});

describe('subscribeChaos', () => {
  it('notifies on mutation and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsub = subscribeChaos(listener);
    setRunState('recording');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    setRunState('finishing');
    expect(listener).toHaveBeenCalledTimes(1); // no further calls
  });

  it('does not emit when setRunState is a no-op', () => {
    setRunState('recording');
    const listener = vi.fn();
    subscribeChaos(listener);
    setRunState('recording'); // same value — early return, no emit
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('snapshot immutability (useSyncExternalStore contract)', () => {
  it('publishes a fresh snapshot reference on every mutation', () => {
    const a = getChaosSnapshot();
    setRunState('recording');
    const b = getChaosSnapshot();
    expect(b).not.toBe(a);

    setProgress({ clicks: 3, elapsedMs: 100 });
    const c = getChaosSnapshot();
    expect(c).not.toBe(b);

    pushLiveEvent(ev);
    const d = getChaosSnapshot();
    expect(d).not.toBe(c);
    // pushLiveEvent must not mutate the prior liveEvents array in place.
    expect(c.liveEvents).not.toBe(d.liveEvents);
  });
});

describe('mutations', () => {
  it('resetForNewRun arms a launching run and clears transient state', () => {
    pushLiveEvent(ev);
    resetForNewRun('run-42');
    const s = getChaosSnapshot();
    expect(s.runId).toBe('run-42');
    expect(s.runState).toBe('launching');
    expect(s.progress).toEqual({ clicks: 0, elapsedMs: 0 });
    expect(s.liveEvents).toEqual([]);
    expect(s.lastSummary).toBeNull();
  });

  it('setProgress and pushLiveEvent accumulate', () => {
    setProgress({ clicks: 5, elapsedMs: 250 });
    pushLiveEvent(ev);
    pushLiveEvent(ev);
    const s = getChaosSnapshot();
    expect(s.progress).toEqual({ clicks: 5, elapsedMs: 250 });
    expect(s.liveEvents).toHaveLength(2);
  });

  it('finalizeRun persists to history and returns to idle', () => {
    resetForNewRun('run-final');
    setRunState('finishing');
    finalizeRun(summary('run-final'));
    const s = getChaosSnapshot();
    expect(s.runState).toBe('idle');
    expect(s.lastSummary?.runId).toBe('run-final');
    expect(s.history.map((r) => r.runId)).toEqual(['run-final']);
    // ...and it actually hit localStorage.
    expect(loadRuns().map((r) => r.runId)).toEqual(['run-final']);
  });

  it('idleReset clears transient state but keeps lastSummary + history', () => {
    // finalizeRun records lastSummary + history; note resetForNewRun would
    // NULL lastSummary (covered above), so this drives the post-run path.
    finalizeRun(summary('keep-me'));
    setRunState('recording');
    setProgress({ clicks: 9, elapsedMs: 500 });
    pushLiveEvent(ev);
    idleReset();
    const s = getChaosSnapshot();
    expect(s.runId).toBeNull();
    expect(s.runState).toBe('idle');
    expect(s.progress).toEqual({ clicks: 0, elapsedMs: 0 });
    expect(s.liveEvents).toEqual([]);
    expect(s.lastSummary?.runId).toBe('keep-me'); // preserved
    expect(s.history.map((r) => r.runId)).toEqual(['keep-me']); // preserved
  });

  it('clearHistory drops in-memory history but leaves localStorage; refreshHistory reloads it', () => {
    finalizeRun(summary('persisted'));
    expect(getChaosSnapshot().history).toHaveLength(1);

    clearHistory();
    expect(getChaosSnapshot().history).toEqual([]);
    expect(getChaosSnapshot().lastSummary).toBeNull();
    // clearHistory is in-memory only — the run is still persisted.
    expect(loadRuns()).toHaveLength(1);

    refreshHistory();
    expect(getChaosSnapshot().history.map((r) => r.runId)).toEqual(['persisted']);
  });
});
