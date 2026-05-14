/**
 * Passive perf recorder — collects PerformanceObserver events into a ring
 * buffer that the Live Metrics tab + Routes tab read from.
 *
 * Single global instance keyed off `window`, started lazily on first read.
 * Survives client-side navigation (the App Router never tears down the
 * browser window). Persists the buffer to localStorage every 5s + on
 * `visibilitychange`.
 */

export type PerfEventKind = 'interaction' | 'longtask' | 'layout-shift' | 'console-error' | 'unhandled-error';

export interface PerfEvent {
  id: string;
  kind: PerfEventKind;
  route: string;
  ts: number;          // Date.now()
  /** ms — duration for interaction/longtask, score*1000 for layout-shift, 0 for errors */
  duration: number;
  /** CSS-ish selector for the interaction target, or error message */
  target: string;
  /** For interactions: the event type (click, keydown, …) */
  eventType?: string;
  /** Console-error / unhandled-error stack snippet, truncated */
  detail?: string;
}

const LS_KEY = 'papercusp.testing.perf-events.v1';
const MAX_EVENTS = 1000;
const FLUSH_INTERVAL_MS = 5_000;

interface RecorderState {
  events: PerfEvent[];
  listeners: Set<(events: PerfEvent[]) => void>;
  observers: PerformanceObserver[];
  flushTimer?: ReturnType<typeof setInterval>;
  started: boolean;
  consoleErrorOrig?: typeof console.error;
}

declare global {
  interface Window { __papercuspPerfRecorder?: RecorderState }
}

function getState(): RecorderState {
  if (!window.__papercuspPerfRecorder) {
    window.__papercuspPerfRecorder = {
      events: loadFromStorage(),
      listeners: new Set(),
      observers: [],
      started: false,
    };
  }
  return window.__papercuspPerfRecorder;
}

function loadFromStorage(): PerfEvent[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PerfEvent[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

function flushToStorage(state: RecorderState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state.events.slice(-MAX_EVENTS)));
  } catch {
    // localStorage full or unavailable — quietly drop, the in-memory buffer is fine
  }
}

function addEvent(state: RecorderState, ev: PerfEvent) {
  state.events.push(ev);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  state.listeners.forEach((l) => l(state.events));
}

function describeTarget(node: Node | null): string {
  if (!node || !(node instanceof Element)) return '(unknown)';
  const el = node as Element;
  const role = el.getAttribute('role');
  const aria = el.getAttribute('aria-label');
  const text = (el.textContent ?? '').trim().slice(0, 40);
  const tag = el.tagName.toLowerCase();
  if (aria) return `${tag}[aria-label="${aria}"]`;
  if (text) return `${tag} "${text}"`;
  if (role) return `${tag}[role=${role}]`;
  return tag;
}

export function startRecorder(): void {
  const state = getState();
  if (state.started) return;
  state.started = true;

  // Interaction latency — the killer metric.
  try {
    const intObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEventTiming;
        if (e.duration < 40) continue; // ignore fast interactions
        addEvent(state, {
          id: `${e.startTime}-${e.name}`,
          kind: 'interaction',
          route: window.location.pathname,
          ts: Date.now(),
          duration: Math.round(e.duration),
          target: describeTarget(e.target ?? null),
          eventType: e.name,
        });
      }
    });
    intObs.observe({ type: 'event', buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
    state.observers.push(intObs);
  } catch { /* event type not supported */ }

  // Long tasks — blocking the main thread > 50ms.
  try {
    const ltObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        addEvent(state, {
          id: `lt-${entry.startTime}`,
          kind: 'longtask',
          route: window.location.pathname,
          ts: Date.now(),
          duration: Math.round(entry.duration),
          target: 'main-thread',
        });
      }
    });
    ltObs.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
    state.observers.push(ltObs);
  } catch { /* longtask not supported in WebKit */ }

  // Layout shifts.
  try {
    const lsObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ls = entry as PerformanceEntry & { value: number; hadRecentInput?: boolean };
        if (ls.hadRecentInput) continue;
        if (ls.value < 0.01) continue;
        addEvent(state, {
          id: `ls-${entry.startTime}`,
          kind: 'layout-shift',
          route: window.location.pathname,
          ts: Date.now(),
          duration: Math.round(ls.value * 1000),
          target: 'viewport',
        });
      }
    });
    lsObs.observe({ type: 'layout-shift', buffered: true } as PerformanceObserverInit);
    state.observers.push(lsObs);
  } catch { /* not supported */ }

  // Console errors — useful signal during chaos runs and ambient usage.
  state.consoleErrorOrig = console.error;
  console.error = (...args: unknown[]) => {
    state.consoleErrorOrig?.(...args);
    const msg = args.map((a) => (typeof a === 'string' ? a : (a as Error)?.message ?? String(a))).join(' ').slice(0, 200);
    addEvent(state, {
      id: `err-${Date.now()}-${Math.random()}`,
      kind: 'console-error',
      route: window.location.pathname,
      ts: Date.now(),
      duration: 0,
      target: 'console',
      detail: msg,
    });
  };

  window.addEventListener('error', (e) => {
    addEvent(state, {
      id: `werr-${Date.now()}`,
      kind: 'unhandled-error',
      route: window.location.pathname,
      ts: Date.now(),
      duration: 0,
      target: e.filename ?? 'window',
      detail: (e.message ?? '').slice(0, 200),
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    addEvent(state, {
      id: `prej-${Date.now()}`,
      kind: 'unhandled-error',
      route: window.location.pathname,
      ts: Date.now(),
      duration: 0,
      target: 'promise',
      detail: String(e.reason).slice(0, 200),
    });
  });

  state.flushTimer = setInterval(() => flushToStorage(state), FLUSH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushToStorage(state);
  });
}

export function subscribe(listener: (events: PerfEvent[]) => void): () => void {
  const state = getState();
  state.listeners.add(listener);
  listener(state.events);
  return () => state.listeners.delete(listener);
}

export function getEvents(): PerfEvent[] {
  return getState().events.slice();
}

export function clearEvents(): void {
  const state = getState();
  state.events = [];
  flushToStorage(state);
  state.listeners.forEach((l) => l(state.events));
}

/** INP rating thresholds per web.dev/inp */
export function rateINP(ms: number): 'good' | 'needs-improvement' | 'poor' {
  if (ms <= 200) return 'good';
  if (ms <= 500) return 'needs-improvement';
  return 'poor';
}
