// @vitest-environment jsdom
/**
 * The stale EDGE — when the stream goes quiet, does the pane actually RE-RENDER?
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * The staleness banner is a three-link chain, and until this file the LAST link
 * had no automated guard at all:
 *
 *   1. `classifyStreamFreshness` returns 'stale' for (open, silence ≥ 35s)
 *      → `stream-freshness.test.ts`, by injection.
 *   2. The real transport can actually PRODUCE that pair — it stays 'open' from
 *      35s to its 45s watchdog → `stream-freshness.ladder.test.ts`, by driving
 *      the real `createResilientEventSource`.
 *   3. React RE-RENDERS at that moment, so the classifier is re-run and the
 *      banner appears → this file. ← the link nothing tested.
 *
 * Link 3 is not a formality, because of WHERE the classification happens:
 * `SessionChatModal.tsx:828` computes it DURING RENDER, from `Date.now()`.
 * Nothing in that expression changes on its own. A stream that simply stops
 * delivering produces no events, no state updates, and therefore no render —
 * so freshness is never recomputed and the banner never appears, no matter how
 * correct links 1 and 2 are. The only thing that breaks the silence is
 * `useAgentThinkingStream`'s own watchdog (AgentThinkingStream.tsx ~196-206)
 * bumping a counter purely to force that re-render.
 *
 * That makes this the SAME defect class as the bug that shipped
 * (EI-20265888603098901): a state that is logically reachable but never
 * OBSERVED. There it was the threshold ordering; here it would be a timer that
 * silently stops firing. Both are invisible to a classifier test, and both
 * leave the owner looking at a frozen transcript that claims to be live.
 *
 * ── Why the counter, and not the timestamp ──────────────────────────────────
 *
 * Re-publishing the last-signal timestamp at the stale edge would be a
 * same-value `setState`, which React BAILS OUT of — no re-render, no banner, at
 * exactly the moment the banner is the entire point. The counter always
 * changes. The first assertion below (`renders` strictly increases) is what
 * fails if anyone "simplifies" that back.
 *
 * The transport is faked at the browser-primitive seam only
 * (`../_components/chat/fake-event-source.testkit`, shared with the ladder
 * test). The hook, the wrapper, its watchdog and the classifier are all real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  FakeEventSource,
  latestEventSource as latest,
} from '../_components/chat/fake-event-source.testkit';
import {
  classifyStreamFreshness,
  STREAM_SILENCE_STALE_MS,
} from '../_components/chat/stream-freshness';
import { useAgentThinkingStream } from './AgentThinkingStream';

/** Render the hook while counting renders — the observable this file is about. */
function renderStream() {
  let renders = 0;
  const view = renderHook(() => {
    renders += 1;
    return useAgentThinkingStream('slug', 'phase', 'run-1');
  });
  return {
    ...view,
    renderCount: () => renders,
    /** The pane's exact computation, at the pane's exact seam (SessionChatModal:828). */
    freshness: () =>
      classifyStreamFreshness({
        transport: view.result.current.transport,
        lastSignalAtMs: view.result.current.lastSignalAt,
        nowMs: Date.now(),
      }),
  };
}

describe('useAgentThinkingStream — the silence watchdog', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('re-renders at the stale edge, so the banner can appear at all', () => {
    const view = renderStream();
    act(() => { latest().fireOpen(); });

    expect(view.result.current.transport).toBe('open');
    expect(view.freshness()).toBe('fresh');

    // A healthy stream must NOT re-render on every heartbeat — that would
    // re-parse the whole transcript's markdown four times a minute forever
    // (the regression the burst-coalescing work fixed). Silence up to one ms
    // short of the threshold is free.
    const beforeEdge = view.renderCount();
    act(() => { vi.advanceTimersByTime(STREAM_SILENCE_STALE_MS - 1); });
    expect(view.renderCount()).toBe(beforeEdge);
    expect(view.freshness()).toBe('fresh');

    // ── THE LINK NOTHING TESTED ────────────────────────────────────────────
    // One more millisecond. Nothing arrives; nothing about the hook's data
    // changes. If the watchdog does not force a render here, the classifier is
    // never re-run and 'stale' is unobservable in the running app.
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.renderCount()).toBeGreaterThan(beforeEdge);
    expect(view.result.current.transport).toBe('open');
    expect(view.freshness()).toBe('stale');
  });

  it('re-arms on every signal — the edge tracks the LAST beat, not the connect', () => {
    // A one-shot watchdog armed at connect would fire once, early, and then
    // never again — so a stream that goes quiet an hour into a session would
    // never raise the banner. That failure is invisible to the test above,
    // which never sends a second signal.
    const view = renderStream();
    act(() => { latest().fireOpen(); });

    act(() => {
      vi.advanceTimersByTime(30_000);
      latest().fire('heartbeat', '{"tsMs":1}');
    });
    const afterBeat = view.renderCount();

    // Now 34_999ms of silence — which is ALSO 64_999ms after the connect, well
    // past a watchdog that was never re-armed. Neither a render nor a verdict
    // change may happen here.
    act(() => { vi.advanceTimersByTime(STREAM_SILENCE_STALE_MS - 1); });
    expect(view.renderCount()).toBe(afterBeat);
    expect(view.freshness()).toBe('fresh');

    act(() => { vi.advanceTimersByTime(1); });
    expect(view.renderCount()).toBeGreaterThan(afterBeat);
    expect(view.freshness()).toBe('stale');
  });

  it('a fresh signal after the edge clears the banner', () => {
    // The banner must be recoverable: a stream that comes back has to publish
    // a NEW last-signal timestamp. This is the `wasStale` transition — without
    // it the pane stays bannered forever on a stream that recovered.
    const view = renderStream();
    act(() => { latest().fireOpen(); });
    act(() => { vi.advanceTimersByTime(STREAM_SILENCE_STALE_MS); });
    expect(view.freshness()).toBe('stale');

    act(() => { latest().fire('heartbeat', '{"tsMs":2}'); });
    expect(view.freshness()).toBe('fresh');
  });

  it('stops the watchdog on unmount', () => {
    // The timer outliving the component would fire setState on an unmounted
    // tree — and, worse, keep a closed stream's bookkeeping alive.
    const view = renderStream();
    act(() => { latest().fireOpen(); });
    view.unmount();
    const afterUnmount = view.renderCount();

    act(() => { vi.advanceTimersByTime(STREAM_SILENCE_STALE_MS * 3); });
    expect(view.renderCount()).toBe(afterUnmount);
  });
});
