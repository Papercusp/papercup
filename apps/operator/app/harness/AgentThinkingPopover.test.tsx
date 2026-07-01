// @vitest-environment jsdom
/**
 * AgentThinkingPopover.test.tsx — render-tier coverage for the hover popover
 * that streams a Now-running agent's live thinking (whole-app-test-coverage-
 * breadth). The EventSource is mocked: we capture the `handlers` + `onError`
 * passed to createResilientEventSource and drive them manually to exercise the
 * connecting → live → done → error states, the backfill + per-event timeline
 * growth, every Entry kind (text / tool_use / tool_result / status / result),
 * the event-count footer, and the Open-inspector button. The component renders
 * via createPortal into document.body — assertions read from `screen`/document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';

/* ── Mock the SSE transport: capture the opts so the test can fire events. ── */
type Handlers = Record<string, (data: string, ev?: unknown) => void>;
let captured: { handlers: Handlers; onError?: (e: Error) => void } | null = null;
const closeSpy = vi.fn();
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: (opts: { handlers: Handlers; onError?: (e: Error) => void }) => {
    captured = { handlers: opts.handlers, onError: opts.onError };
    return { close: closeSpy };
  },
}));

import AgentThinkingPopover, { waitingMessage, STALL_AFTER_MS, fmtEntryTime } from './AgentThinkingPopover';

function anchor(): DOMRect {
  // A rect well below the viewport top so the popover places "above".
  return { top: 500, bottom: 520, left: 100, right: 200, width: 100, height: 20, x: 100, y: 500, toJSON: () => ({}) } as DOMRect;
}

function renderPopover(over: Partial<React.ComponentProps<typeof AgentThinkingPopover>> = {}) {
  const onMouseEnter = vi.fn();
  const onMouseLeave = vi.fn();
  const onOpenInspector = vi.fn();
  const utils = render(
    <AgentThinkingPopover
      slug="my-harness"
      phase="production"
      runId="run-abcdef0123456789-tail"
      role="worker"
      anchorRect={anchor()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onOpenInspector={onOpenInspector}
      {...over}
    />,
  );
  return { ...utils, onMouseEnter, onMouseLeave, onOpenInspector };
}

beforeEach(() => { captured = null; closeSpy.mockClear(); });
afterEach(cleanup);

describe('AgentThinkingPopover (live agent thinking stream)', () => {
  it('opens an EventSource and shows the connecting empty state', () => {
    renderPopover();
    expect(captured).not.toBeNull();
    // Header role + short runId; status defaults to "connecting…".
    expect(screen.getByText('worker')).toBeTruthy();
    expect(screen.getByText('connecting…')).toBeTruthy();
    expect(screen.getByText('Connecting…')).toBeTruthy();
    // Footer: 0 events (pluralised).
    expect(screen.getByText('0 events')).toBeTruthy();
  });

  it('escalates a live run with zero output past the stall threshold', () => {
    // Run started 60s ago (> STALL_AFTER_MS) and the backfill is empty → the
    // card must flag it as stalled instead of an eternal "Waiting…".
    renderPopover({ startedAtMs: Date.now() - 60_000 });
    act(() => { captured!.handlers.backfill!(JSON.stringify([])); });
    expect(screen.getByText('stalled?')).toBeTruthy();
    expect(screen.getByText(/No output for/)).toBeTruthy();
  });

  it('shows a live elapsed counter before the stall threshold (not stalled)', () => {
    renderPopover({ startedAtMs: Date.now() - 5_000 });
    act(() => { captured!.handlers.backfill!(JSON.stringify([])); });
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText(/Waiting for first output/)).toBeTruthy();
  });

  it('renders the backfill array and flips the status to live', () => {
    renderPopover();
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'text', text: 'first thought' },
        { kind: 'status', text: 'spawning worker' },
      ]));
    });
    expect(screen.getByText('first thought')).toBeTruthy();
    expect(screen.getByText(/spawning worker/)).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText('2 events')).toBeTruthy();
  });

  it('appends a single streamed event onto the existing timeline', () => {
    renderPopover();
    act(() => { captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'a' }])); });
    act(() => { captured!.handlers.event!(JSON.stringify({ kind: 'text', text: 'b' })); });
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
    expect(screen.getByText('2 events')).toBeTruthy();
  });

  it('renders a tool_use entry with its tool name and compacted input', () => {
    renderPopover();
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'tool_use', toolName: 'Read', toolInput: { file: 'x.ts' } },
      ]));
    });
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText(/tool_use/)).toBeTruthy();
    expect(screen.getByText(/"file":"x.ts"/)).toBeTruthy();
  });

  it('renders a tool_result entry with its text', () => {
    renderPopover();
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'tool_result', text: 'file contents here' },
      ]));
    });
    expect(screen.getByText(/tool_result/)).toBeTruthy();
    expect(screen.getByText('file contents here')).toBeTruthy();
  });

  it('renders a result entry with its cost/token/duration meta', () => {
    renderPopover();
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'result', text: 'done', costUsd: 0.1234, inputTokens: 10, outputTokens: 20, durationMs: 2000 },
      ]));
    });
    expect(screen.getByText('done')).toBeTruthy();
    // meta = "$0.1234 · 10/20 tok · 2.0s"
    expect(screen.getByText(/\$0\.1234/)).toBeTruthy();
    expect(screen.getByText(/10\/20 tok/)).toBeTruthy();
    expect(screen.getByText(/2\.0s/)).toBeTruthy();
  });

  it('renders a per-entry header timestamp when the entry carries one', () => {
    renderPopover();
    const ts = '2026-07-01T02:14:43.029Z';
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, ts },
      ]));
    });
    const expected = fmtEntryTime(ts)!;
    expect(expected).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('flips status to done when the done handler fires', () => {
    renderPopover();
    act(() => { captured!.handlers.done!(''); });
    expect(screen.getByText('done')).toBeTruthy();
  });

  it('flips status to disconnected when onError fires', () => {
    renderPopover();
    act(() => { captured!.onError?.(new Error('boom')); });
    expect(screen.getByText('disconnected')).toBeTruthy();
  });

  it('shows the singular "1 event" footer for exactly one event', () => {
    renderPopover();
    act(() => { captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'solo' }])); });
    expect(screen.getByText('1 event')).toBeTruthy();
  });

  it('the Open-inspector button invokes onOpenInspector', () => {
    const { onOpenInspector } = renderPopover();
    fireEvent.click(screen.getByRole('button', { name: /Open full inspector/i }));
    expect(onOpenInspector).toHaveBeenCalledTimes(1);
  });

  it('mouseleave on the popover calls onMouseLeave', () => {
    const { onMouseLeave } = renderPopover();
    fireEvent.mouseLeave(screen.getByRole('tooltip'));
    expect(onMouseLeave).toHaveBeenCalled();
  });

  it('closes the EventSource on unmount', () => {
    const { unmount } = renderPopover();
    unmount();
    expect(closeSpy).toHaveBeenCalled();
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
