// @vitest-environment jsdom
/**
 * AgentThinkingStream.test.tsx — coverage for the shared live "thinking" stream
 * primitives (useAgentThinkingStream hook, the Entry timeline renderer, and the
 * pure helpers) reused by AgentInspectorModal.tsx.
 *
 * WI-2346: this test file replaces AgentThinkingPopover.test.tsx after the
 * orphaned default-exported hover-popover component (EI-5917 — zero JSX callers)
 * was deleted. Tests that only exercised THAT component's own presentation
 * (positioning, mouse enter/leave, the "Open full inspector" button, its
 * "N event(s)" footer copy) are dropped along with it — either genuinely
 * dead-weight or already covered via AgentInspectorModal.test.tsx, which
 * renders the SAME shared hook/renderer through the surviving surface. The
 * hook- and renderer-level behaviors that were NOT duplicated there (the
 * corrupted-backfill self-heal/give-up reconnect logic, the onError→disconnected
 * path, the unmount cleanup, and a few Entry-kind renders) are migrated below,
 * now driven directly via `renderHook`/direct `<Entry>` renders instead of
 * through the deleted component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';

/* ── Mock the SSE transport: capture the opts so the test can fire events. ── */
type Handlers = Record<string, (data: string, ev?: unknown) => void>;
let captured: { handlers: Handlers; onError?: (e: Error) => void } | null = null;
const closeSpy = vi.fn();
const reconnectSpy = vi.fn();
vi.mock('@papercusp/sse', () => ({
  // Mirror the transport ceilings consumed by stream-freshness.ts.
  DEFAULT_ZOMBIE_TIMEOUT_MS: 45_000,
  DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS: 32_000,
  createResilientEventSource: (opts: { handlers: Handlers; onError?: (e: Error) => void }) => {
    captured = { handlers: opts.handlers, onError: opts.onError };
    return { close: closeSpy, reconnect: reconnectSpy };
  },
}));

import {
  useAgentThinkingStream,
  waitingMessage,
  STALL_AFTER_MS,
  fmtEntryTime,
  groupEntriesIntoTurns,
  Entry,
  type TimelineEntry,
} from './AgentThinkingStream';

beforeEach(() => { captured = null; closeSpy.mockClear(); reconnectSpy.mockClear(); });
afterEach(cleanup);

describe('useAgentThinkingStream (shared live thinking-stream hook)', () => {
  it('self-heals a corrupted backfill via a bounded reconnect (the backfill is one-shot)', () => {
    // A backfill that fails to parse (e.g. a stream that dropped mid-event and
    // resumed) is unrecoverable in-band — the server only sends it once per
    // connection. The hook must force a clean reconnect (which re-sends it)
    // instead of silently wedging on "connecting…".
    const { result } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    act(() => { captured!.handlers.backfill!('[{"kind":"text","te…GARBAGE'); });
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    // Still connecting (not error) — the retry is in flight.
    expect(result.current.status).toBe('connecting');
    // The reconnected stream re-sends a clean backfill → recovers to live.
    act(() => { captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'recovered' }])); });
    expect(result.current.status).toBe('live');
    expect(result.current.events).toEqual([{ kind: 'text', text: 'recovered' }]);
  });

  it('gives up to the error state after repeated corrupted backfills (no eternal spinner)', () => {
    const { result } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    for (let i = 0; i < 4; i++) {
      act(() => { captured!.handlers.backfill!('not json'); });
    }
    // 3 bounded retries, then error — never an unbounded reconnect storm.
    expect(reconnectSpy).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe('error');
  });

  it('keeps valid backfill records while dropping schema-drifted records fail-soft', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'text', text: 'kept' },
        { kind: 'future-kind', text: 'secret' },
      ]));
    });
    expect(result.current.status).toBe('live');
    expect(result.current.events).toEqual([{ kind: 'text', text: 'kept' }]);
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[cross-boundary-contract-drift]',
      'agent-timeline-entry',
      'kind is unknown',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    warn.mockRestore();
  });

  it('appends a single streamed event onto the existing timeline', async () => {
    const { result } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    act(() => { captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'a' }])); });
    act(() => { captured!.handlers.event!(JSON.stringify({ kind: 'text', text: 'b' })); });
    // WI-6502: streamed entries commit on the next frame, not synchronously.
    await waitFor(() => {
      expect(result.current.events).toEqual([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]);
    });
  });

  it('coalesces a BURST of streamed events into ONE commit (WI-6502)', async () => {
    // The server follows the transcript on a 1Hz poll and emits one `event` per
    // appended entry, so entries arrive in bursts. Committing them one at a time
    // made each burst K renders — and each render re-parses the live message's
    // markdown (12ms at 8KB, 24ms at 16KB), which is what keystrokes queued
    // behind. The whole burst must land as a SINGLE state update.
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAgentThinkingStream('my-harness', 'production', 'run-1');
    });
    act(() => { captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'seed' }])); });
    const rendersAfterBackfill = renders;

    const BURST = 20;
    act(() => {
      for (let i = 0; i < BURST; i++) {
        captured!.handlers.event!(JSON.stringify({ kind: 'text', text: `e${i}` }));
      }
    });
    // Nothing committed yet — the burst is still buffered.
    expect(result.current.events).toHaveLength(1);

    await waitFor(() => { expect(result.current.events).toHaveLength(1 + BURST); });
    // …and it arrived as ONE commit, not 20. This is the assertion that actually
    // guards the fix: without coalescing this is BURST renders.
    expect(renders - rendersAfterBackfill).toBe(1);
    expect(result.current.events[BURST]).toEqual({ kind: 'text', text: `e${BURST - 1}` });
  });

  it('drops buffered entries when a reconnect re-sends the backfill snapshot', async () => {
    // A backfill is a whole-timeline snapshot sent once per connection. Entries
    // buffered from the connection that just dropped must NOT be replayed on top
    // of the fresh snapshot, or the pane shows duplicated//out-of-order tail.
    const { result } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    act(() => { captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'old' }])); });
    act(() => { captured!.handlers.event!(JSON.stringify({ kind: 'text', text: 'stale-tail' })); });
    // Reconnect lands before the buffered entry ever flushed.
    act(() => { captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'fresh' }])); });

    await waitFor(() => { expect(result.current.status).toBe('live'); });
    expect(result.current.events).toEqual([{ kind: 'text', text: 'fresh' }]);
  });

  it('flushes a buffered tail when the stream reports done (no lost final burst)', async () => {
    const { result } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    act(() => { captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'a' }])); });
    act(() => {
      captured!.handlers.event!(JSON.stringify({ kind: 'text', text: 'tail' }));
      captured!.handlers.done!('{}');
    });
    expect(result.current.status).toBe('done');
    await waitFor(() => {
      expect(result.current.events).toEqual([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'tail' }]);
    });
  });

  it('flips status to disconnected/error when onError fires', () => {
    const { result } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    act(() => { captured!.onError?.(new Error('boom')); });
    expect(result.current.status).toBe('error');
    expect(result.current.thinking).toBe(false);
  });

  it('closes the EventSource on unmount', () => {
    const { unmount } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    unmount();
    expect(closeSpy).toHaveBeenCalled();
  });

  it('tracks the thinking status event independently of the backfill/event stream', async () => {
    const { result } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    act(() => { captured!.handlers.thinking!(JSON.stringify({ active: true })); });
    await waitFor(() => expect(result.current.thinking).toBe(true));
    act(() => { captured!.handlers.thinking!(JSON.stringify({ active: false })); });
    await waitFor(() => expect(result.current.thinking).toBe(false));
  });

  it('publishes stable-owner history pagination metadata without changing timeline entries', () => {
    const { result } = renderHook(() => useAgentThinkingStream('my-harness', 'production', 'run-1'));
    act(() => { captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'current page' }])); });
    act(() => { captured!.handlers.history!(JSON.stringify({ hasMore: true, cursor: 'opaque-cursor' })); });
    expect(result.current.history).toEqual({ hasMore: true, cursor: 'opaque-cursor' });
    expect(result.current.events).toEqual([{ kind: 'text', text: 'current page' }]);

    // A hasMore claim without the cursor needed to act on it is ignored.
    act(() => { captured!.handlers.history!(JSON.stringify({ hasMore: true, cursor: null })); });
    expect(result.current.history).toEqual({ hasMore: true, cursor: 'opaque-cursor' });
  });
});

describe('Entry (timeline entry renderer)', () => {
  it('renders a tool_result entry with its text', () => {
    render(<Entry entry={{ kind: 'tool_result', text: 'file contents here' }} />);
    expect(screen.getByText(/tool_result/)).toBeTruthy();
    expect(screen.getByText('file contents here')).toBeTruthy();
  });

  it('renders a result entry with its cost/token/duration meta', () => {
    render(
      <Entry
        entry={{ kind: 'result', text: 'done', costUsd: 0.1234, inputTokens: 10, outputTokens: 20, durationMs: 2000 }}
      />,
    );
    expect(screen.getByText('done')).toBeTruthy();
    // meta = "$0.1234 · 10/20 tok · 2.0s"
    expect(screen.getByText(/\$0\.1234/)).toBeTruthy();
    expect(screen.getByText(/10\/20 tok/)).toBeTruthy();
    expect(screen.getByText(/2\.0s/)).toBeTruthy();
  });

  it('renders a per-entry header timestamp when the entry carries one', () => {
    const ts = '2026-07-01T02:14:43.029Z';
    render(<Entry entry={{ kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, ts }} />);
    const expected = fmtEntryTime(ts)!;
    expect(expected).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(screen.getByText(expected)).toBeTruthy();
  });
});

describe('groupEntriesIntoTurns (pure — turn boundaries)', () => {
  const E = (o: Partial<TimelineEntry>): TimelineEntry => ({ kind: 'text', ...o }) as TimelineEntry;
  it('splits on prompt boundaries; leading entries form a partial (prompt-less) turn', () => {
    const turns = groupEntriesIntoTurns([
      E({ kind: 'text', text: 'leftover' }),
      E({ kind: 'prompt', text: 'wake A', ts: 't1' }),
      E({ kind: 'tool_use', toolName: 'Bash' }),
      E({ kind: 'prompt', text: 'wake B', ts: 't2' }),
      E({ kind: 'text', text: 'working on B' }),
    ]);
    expect(turns).toHaveLength(3);
    expect(turns[0].prompt).toBeNull();
    expect(turns[0].entries.map((e) => e.text)).toEqual(['leftover']);
    expect(turns[1].prompt?.text).toBe('wake A');
    expect(turns[1].entries).toHaveLength(1);
    expect(turns[2].prompt?.text).toBe('wake B');
    expect(turns[2].entries.map((e) => e.text)).toEqual(['working on B']);
    expect(turns[2].seq).toBe(2); // higher seq = later turn (UI shows highest at top)
  });
  it('empty timeline → no turns', () => {
    expect(groupEntriesIntoTurns([])).toEqual([]);
  });
});

describe('fmtEntryTime (per-entry header time)', () => {
  it('formats an ISO timestamp as local HH:MM:SS', () => {
    const ts = '2026-07-01T02:14:43.029Z';
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    expect(fmtEntryTime(ts)).toBe(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
  });
  it('returns null for a missing or unparseable timestamp', () => {
    expect(fmtEntryTime(undefined)).toBeNull();
    expect(fmtEntryTime('not a date')).toBeNull();
  });
});

describe('waitingMessage (empty-timeline label)', () => {
  it('connecting → Connecting…, never stalled', () => {
    expect(waitingMessage('connecting', null)).toEqual({ text: 'Connecting…', stalled: false });
    expect(waitingMessage('connecting', 999_999)).toEqual({ text: 'Connecting…', stalled: false });
  });
  it('live under the threshold → waiting + elapsed, not stalled', () => {
    const r = waitingMessage('live', 5_000);
    expect(r.stalled).toBe(false);
    expect(r.text).toMatch(/Waiting for first output/);
    expect(r.text).toMatch(/5s/);
  });
  it('live at/over the threshold → stalled warning', () => {
    const r = waitingMessage('live', STALL_AFTER_MS + 1);
    expect(r.stalled).toBe(true);
    expect(r.text).toMatch(/No output for/);
  });
  it('done with no output → terminal message, stalled flag set', () => {
    const r = waitingMessage('done', 90_000);
    expect(r.stalled).toBe(true);
    expect(r.text).toMatch(/Run ended/);
  });
  it('error → disconnected/retrying message', () => {
    expect(waitingMessage('error', null).text).toMatch(/Disconnected/);
  });
  it('live with null elapsed (no startedAt) → plain waiting, no counter', () => {
    expect(waitingMessage('live', null)).toEqual({
      text: 'Waiting for first output from the agent…',
      stalled: false,
    });
  });
});
