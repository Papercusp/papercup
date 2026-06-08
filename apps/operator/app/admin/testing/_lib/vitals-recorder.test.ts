// @vitest-environment jsdom
/**
 * Tests for the passive perf-recorder's PURE + store surface.
 *
 * Deliberately does NOT call `startRecorder()` — that wires live
 * PerformanceObservers + patches console.error, which jsdom can't model and
 * which would trip setup-fail-on-console. The unit-testable contract is:
 *  - `rateINP` — the web.dev/INP threshold bucketing (≤200 good, ≤500
 *    needs-improvement, else poor), incl. the exact boundaries;
 *  - `subscribe` — registers a listener, fires it once immediately with the
 *    current buffer, and returns a working unsubscribe;
 *  - `getEvents` — returns a defensive COPY (callers can't mutate the buffer);
 *  - `clearEvents` — empties the buffer, notifies listeners, and persists the
 *    empty buffer;
 *  - the lazy `getState()` buffer hydrate from localStorage (cap to the last
 *    MAX_EVENTS; malformed / non-array → []).
 *
 * The recorder state is a window-singleton, so each test resets it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEvents,
  getEvents,
  rateINP,
  subscribe,
  type PerfEvent,
} from './vitals-recorder';

const LS_KEY = 'papercusp.testing.perf-events.v1';

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

/** Drop the window-singleton so the next read re-hydrates from localStorage. */
function resetRecorder(): void {
  delete (window as { __papercuspPerfRecorder?: unknown }).__papercuspPerfRecorder;
}

function pe(i: number): PerfEvent {
  return { id: `ev-${i}`, kind: 'interaction', route: '/', ts: i, duration: 10, target: 'btn' };
}

beforeEach(() => {
  installLocalStorage();
  resetRecorder();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetRecorder();
});

describe('rateINP', () => {
  it.each([
    [0, 'good'],
    [200, 'good'], // inclusive upper bound of good
    [201, 'needs-improvement'],
    [500, 'needs-improvement'], // inclusive upper bound of needs-improvement
    [501, 'poor'],
    [5000, 'poor'],
  ] as const)('rates %dms as %s', (ms, expected) => {
    expect(rateINP(ms)).toBe(expected);
  });
});

describe('store hydrate (loadFromStorage)', () => {
  it('returns an empty buffer when nothing is stored', () => {
    expect(getEvents()).toEqual([]);
  });

  it('hydrates the buffer from localStorage', () => {
    localStorage.setItem(LS_KEY, JSON.stringify([pe(1), pe(2)]));
    resetRecorder();
    expect(getEvents().map((e) => e.id)).toEqual(['ev-1', 'ev-2']);
  });

  it('caps the hydrated buffer to the last MAX_EVENTS (250)', () => {
    const many = Array.from({ length: 300 }, (_, i) => pe(i));
    localStorage.setItem(LS_KEY, JSON.stringify(many));
    resetRecorder();
    const events = getEvents();
    expect(events).toHaveLength(250);
    expect(events[0].id).toBe('ev-50'); // 300 - 250 = 50 dropped from the front
    expect(events.at(-1)!.id).toBe('ev-299');
  });

  it('tolerates malformed JSON', () => {
    localStorage.setItem(LS_KEY, '{not json');
    resetRecorder();
    expect(getEvents()).toEqual([]);
  });

  it('tolerates a non-array payload', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ not: 'an array' }));
    resetRecorder();
    expect(getEvents()).toEqual([]);
  });
});

describe('getEvents', () => {
  it('returns a defensive copy', () => {
    localStorage.setItem(LS_KEY, JSON.stringify([pe(1)]));
    resetRecorder();
    const a = getEvents();
    a.push(pe(99));
    expect(getEvents()).toHaveLength(1); // buffer unaffected by caller mutation
  });
});

describe('subscribe', () => {
  it('fires immediately with the current buffer and returns an unsubscribe', () => {
    localStorage.setItem(LS_KEY, JSON.stringify([pe(1), pe(2)]));
    resetRecorder();
    const listener = vi.fn();
    const unsub = subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].map((e: PerfEvent) => e.id)).toEqual(['ev-1', 'ev-2']);

    unsub();
    clearEvents(); // would notify a still-registered listener
    expect(listener).toHaveBeenCalledTimes(1); // unsubscribed — no further calls
  });
});

describe('clearEvents', () => {
  it('empties the buffer, notifies listeners, and persists the empty buffer', () => {
    localStorage.setItem(LS_KEY, JSON.stringify([pe(1), pe(2)]));
    resetRecorder();
    const listener = vi.fn();
    subscribe(listener); // immediate call #1
    listener.mockClear();

    clearEvents();
    expect(getEvents()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toEqual([]);
    // The empty buffer was flushed — a fresh hydrate also reads empty.
    resetRecorder();
    expect(getEvents()).toEqual([]);
  });
});
