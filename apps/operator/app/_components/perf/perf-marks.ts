/**
 * Desktop-performance instrumentation — page-relative interaction timings via
 * the User Timing API (performance.mark / performance.measure).
 *
 * WHY (EI-18128922194224210): measuring a real UI interaction by driving a
 * long-lived dev shell with `tauri-agent-tools eval` is unreliable —
 * performance.now() never resets across client navigations, so a wall-clock
 * delta captured from OUTSIDE the page is confounded (it reads 62s, 88s, … at
 * the "start" of the next eval, never a page-relative small number). A
 * `performance.measure` is PAGE-RELATIVE: its startTime + duration come from
 * the one monotonic timeline regardless of how long the page has been alive,
 * and it is readable BOTH from inside the app (the vitals recorder, via a
 * PerformanceObserver on 'measure') AND from a driver (via
 * performance.getEntriesByName). This module is the ONE place that names and
 * emits those measures, so the in-app desktop-performance suite and the
 * packaged-binary wdio runner read a single canonical timing source.
 *
 * Part of desktop-performance-suite-2026-07-20 (P-001). Dependency-free +
 * SSR-safe + never-throws: a begin/end on the real UI path must never break
 * the interaction it is timing.
 */

/** The curated set of named interactions we budget + measure. Keep this small
 *  and intentional — one entry per user-perceived interaction worth a budget. */
export const PERF_INTERACTIONS = {
  /** Sidebar Plans face: row click → plan body rendered in Vditor. The "several
   *  seconds to load a plan" path (WI-5547); the measure spans click → the
   *  first Vditor.preview parse of the plan body. */
  planPopupOpen: 'plan-popup-open',
  /** Global command palette (⌘K/Ctrl+P): open toggle → the lazy cmdk+Radix
   *  chunk loads and the palette content first renders. First-open pays the
   *  dynamic-import cost, so this guards a regression in that chunk. */
  commandPaletteOpen: 'command-palette-open',
  /** Op-chat sidebar Inbox face: a filter/facet click re-scopes the virtualized
   *  attention list → the row virtualizer re-renders + settles. Guards a
   *  regression in the large-list filter/settle path (WI-5339). */
  inboxListSettle: 'inbox-list-settle',
  /** A conversation is opened (chatId set) → the agent_chats detail resolves
   *  and the thread transcript first renders. The "open a conversation and wait
   *  for it to load" path. */
  conversationThreadLoad: 'conversation-thread-load',
  /** Harness dock (/adv, /workbench): mount → the dockview API binds after the
   *  PG layout hydrates and panels are created. Guards the dock-hydration cost. */
  harnessDockOpen: 'harness-dock-open',
} as const;

export type PerfInteractionName =
  (typeof PERF_INTERACTIONS)[keyof typeof PERF_INTERACTIONS];

/** A start mark older than this (ms) is STALE — a begin whose end never fired
 *  (e.g. the popup was closed before it rendered). endInteraction discards such
 *  a start instead of emitting a garbage multi-second measure against a much
 *  later, unrelated render on a shared code path. */
export const STALE_START_MS = 30_000;

const START_SUFFIX = ':start';

/** The User Timing surface, or null when unavailable (SSR / stripped env). */
function perf(): Performance | null {
  if (typeof performance === 'undefined') return null;
  return typeof performance.mark === 'function' &&
    typeof performance.measure === 'function'
    ? performance
    : null;
}

function latestMeasureDuration(p: Performance, name: string): number | null {
  try {
    const entries = p.getEntriesByName(name, 'measure');
    const last = entries[entries.length - 1];
    return last ? last.duration : null;
  } catch {
    return null;
  }
}

/**
 * Begin timing a named interaction. Records a `<name>:start` mark, replacing
 * any prior (unconsumed) start for the same name. Never throws.
 */
export function beginInteraction(name: PerfInteractionName | string): void {
  const p = perf();
  if (!p) return;
  try {
    p.clearMarks?.(name + START_SUFFIX);
    p.mark(name + START_SUFFIX);
  } catch {
    /* never break the interaction we are trying to measure */
  }
}

/**
 * End timing a named interaction: emit a `performance.measure` named `name`
 * from its start mark to now, then CONSUME the start mark (measure-once).
 * Returns the rounded duration in ms, or null when there was no fresh start.
 *
 * No-op + null when no matching start mark exists — so it is SAFE to call
 * unconditionally from a SHARED render path (only a matching beginInteraction
 * produces a measure; the other mount contexts of a shared component emit
 * nothing).
 */
export function endInteraction(name: PerfInteractionName | string): number | null {
  const p = perf();
  if (!p) return null;
  const startName = name + START_SUFFIX;
  try {
    const starts = p.getEntriesByName(startName, 'mark');
    const start = starts[starts.length - 1];
    if (!start) return null;
    // Discard a stale start (a begin whose timely end never came).
    if (p.now() - start.startTime > STALE_START_MS) {
      p.clearMarks?.(startName);
      return null;
    }
    const measure = p.measure(name, startName);
    p.clearMarks?.(startName);
    const duration =
      measure && typeof (measure as PerformanceMeasure).duration === 'number'
        ? (measure as PerformanceMeasure).duration
        : latestMeasureDuration(p, name);
    return typeof duration === 'number' ? Math.round(duration) : null;
  } catch {
    return null;
  }
}

/**
 * Latest measured duration (ms) for a named interaction, or null. Lets the
 * packaged-binary wdio runner + unit tests read the timing synchronously
 * (via performance.getEntriesByName under the hood).
 */
export function getLatestMeasure(name: PerfInteractionName | string): number | null {
  const p = perf();
  if (!p) return null;
  const d = latestMeasureDuration(p, name);
  // Round at the public boundary so this matches endInteraction()'s return and
  // the recorder's stored duration (both Math.round the same measure).
  return d === null ? null : Math.round(d);
}

/** Drop any pending start mark for a name (the interaction was aborted). */
export function clearInteraction(name: PerfInteractionName | string): void {
  const p = perf();
  if (!p) return;
  try {
    p.clearMarks?.(name + START_SUFFIX);
  } catch {
    /* noop */
  }
}
