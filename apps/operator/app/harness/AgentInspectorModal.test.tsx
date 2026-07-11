// @vitest-environment jsdom
/**
 * AgentInspectorModal.test.tsx — the pinned full-inspector modal opened from the
 * Now-running popover's "Open full inspector" button (previously a dead stub).
 * The SSE transport is mocked so we can drive backfill/event/done and assert the
 * modal renders the shared timeline (reused useAgentThinkingStream + Entry).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Handlers = Record<string, (data: string, ev?: unknown) => void>;
let captured: { handlers: Handlers; onError?: (e: Error) => void } | null = null;
const closeSpy = vi.fn();
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: (opts: { handlers: Handlers; onError?: (e: Error) => void }) => {
    captured = { handlers: opts.handlers, onError: opts.onError };
    return { close: closeSpy };
  },
}));

import AgentInspectorModal from './AgentInspectorModal';

function renderModal(over: Partial<React.ComponentProps<typeof AgentInspectorModal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <AgentInspectorModal
      slug="my-harness"
      phase="production"
      runId="run-abcdef0123456789-tail"
      role="worker"
      open
      onClose={onClose}
      {...over}
    />,
  );
  return { ...utils, onClose };
}

beforeEach(() => { captured = null; closeSpy.mockClear(); });
afterEach(cleanup);

describe('AgentInspectorModal (pinned full inspector)', () => {
  it('opens a stream and shows the run header + connecting empty state', () => {
    renderModal();
    expect(captured).not.toBeNull();
    expect(screen.getByText('worker')).toBeTruthy();
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect(screen.getByText(/0 events/)).toBeTruthy();
  });

  it('renders the backfilled timeline and the live event count', () => {
    renderModal();
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'text', text: 'inspector line one' },
        { kind: 'tool_use', toolName: 'Read', toolInput: { file: 'x.ts' } },
      ]));
    });
    expect(screen.getByText('inspector line one')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText(/2 events/)).toBeTruthy();
  });

  it('is not mounted when open=false', () => {
    renderModal({ open: false });
    expect(screen.queryByText('worker')).toBeNull();
  });

  it('groups the timeline into turns (newest-first) with a Live turn on top while thinking', () => {
    renderModal();
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'prompt', text: 'wake one', ts: '2026-07-01T10:00:00Z' },
        { kind: 'tool_use', toolName: 'Bash' },
        { kind: 'prompt', text: 'wake two', ts: '2026-07-01T10:05:00Z' },
        { kind: 'text', text: 'answer two' },
      ]));
    });
    // Two turns, both prompts rendered.
    expect(screen.getByText(/2 turns/)).toBeTruthy();
    expect(screen.getByText('wake one')).toBeTruthy();
    expect(screen.getByText('wake two')).toBeTruthy();
    // Active thinking → the NEWEST turn (wake two) becomes the Live turn at the top.
    act(() => { captured!.handlers.thinking!(JSON.stringify({ active: true })); });
    const live = screen.getByTestId('turn-live');
    expect(live.textContent).toContain('Live turn');
    expect(live.textContent).toContain('wake two');
    // Newest-first: the live turn (wake two) precedes the older "Turn 1" (wake one) in the DOM.
    const older = screen.getByTestId('turn-0');
    expect(older.textContent).toContain('wake one');
    expect(live.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Newest-first WITHIN the turn too: the latest activity ("answer two") is above
    // its prompt ("wake two") — the current streamed line is the highest thing.
    const answer = screen.getByText('answer two');
    const promptEl = screen.getByText('wake two');
    expect(answer.compareDocumentPosition(promptEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('escalates a live run with zero output past the stall threshold', () => {
    // Run started 60s ago (> STALL_AFTER_MS) with an empty backfill → the live
    // modal must flag it as stalled instead of an eternal "No output yet".
    renderModal({ startedAtMs: Date.now() - 60_000 });
    act(() => { captured!.handlers.backfill!(JSON.stringify([])); });
    expect(screen.getByText('stalled?')).toBeTruthy();
    expect(screen.getByText(/No output for/)).toBeTruthy();
  });

  it('shows a live elapsed counter before the stall threshold (not stalled)', () => {
    renderModal({ startedAtMs: Date.now() - 5_000 });
    act(() => { captured!.handlers.backfill!(JSON.stringify([])); });
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText(/Waiting for first output/)).toBeTruthy();
    expect(screen.queryByText('stalled?')).toBeNull();
  });

  it('shows the terminal empty message when a run ends with no output', () => {
    renderModal();
    act(() => { captured!.handlers.done!(''); });
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText(/Run ended without producing any output/)).toBeTruthy();
  });

  it('shows a Focus-window button that POSTs to the focus endpoint when a focusTarget is given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    renderModal({ focusTarget: { advSessionId: 42, windowId: '0xabc', pid: 999 } });
    const btn = screen.getByTestId('focus-window-btn');
    expect(btn.textContent).toContain('Focus window');
    fireEvent.click(btn);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/adv/sessions/focus');
    expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ id: 42, windowId: '0xabc', pid: 999 });
    vi.unstubAllGlobals();
  });

  it('hides the Focus-window button when no focusTarget is given (never a dead button)', () => {
    renderModal();
    expect(screen.queryByTestId('focus-window-btn')).toBeNull();
  });

  it('shows a "Resume in new terminal" button (fork:false) that POSTs resumeSessionId to console/launch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
    vi.stubGlobal('fetch', fetchSpy);
    renderModal({ resumeTarget: { sessionId: 'sess-abc', live: false, canFork: true } });
    const btn = screen.getByTestId('resume-terminal-btn');
    expect(btn.textContent).toContain('Resume in new terminal');
    fireEvent.click(btn);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/agent-mcp/console/launch');
    expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
    // WI-3988/WI-3989: text/plain (a CORS "simple request", no preflight) — NOT
    // application/json, whose preflight OPTIONS fails SILENTLY in the desktop
    // webkit2gtk build and killed the request before it reached the server.
    expect(fetchSpy.mock.calls[0][1].headers['content-type']).toBe('text/plain');
    // Resume → resume in place, so fork must be false (never branches).
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      resumeSessionId: 'sess-abc',
      fork: false,
      label: 'resume · worker',
    });
    vi.unstubAllGlobals();
  });

  // Owner ask 2026-07-11: Resume + Fork are two independent buttons, BOTH offered
  // for active AND inactive sessions. Fork (fork:true) shows only when canFork.
  it('shows a SEPARATE "Fork in new terminal" button (canFork) that POSTs fork:true', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
    vi.stubGlobal('fetch', fetchSpy);
    renderModal({ resumeTarget: { sessionId: 'sess-abc', live: true, canFork: true } });
    // Both buttons present for a live claude session.
    expect(screen.getByTestId('resume-terminal-btn').textContent).toContain('Resume in new terminal');
    const fork = screen.getByTestId('fork-terminal-btn');
    expect(fork.textContent).toContain('Fork in new terminal');
    fireEvent.click(fork);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/agent-mcp/console/launch');
    // Fork → branch the session (never resume in place), fork:true.
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      resumeSessionId: 'sess-abc',
      fork: true,
      label: 'fork · worker',
    });
    vi.unstubAllGlobals();
  });

  it('offers BOTH Resume and Fork for an INACTIVE session too (retracted "fork only for active")', () => {
    renderModal({ resumeTarget: { sessionId: 'sess-abc', live: false, canFork: true } });
    expect(screen.getByTestId('resume-terminal-btn')).toBeTruthy();
    expect(screen.getByTestId('fork-terminal-btn')).toBeTruthy();
  });

  it('hides ONLY the Fork button (keeps Resume) when the source cannot be forked (omp — canFork:false)', () => {
    renderModal({ resumeTarget: { sessionId: 'sess-omp', live: true, canFork: false } });
    expect(screen.getByTestId('resume-terminal-btn')).toBeTruthy();
    // omp has no --fork-session → no Fork button, but Resume (-r) still offered.
    expect(screen.queryByTestId('fork-terminal-btn')).toBeNull();
  });

  it('warns on the Resume button (tooltip) when the source is still LIVE — resuming in place collides', () => {
    renderModal({ resumeTarget: { sessionId: 'sess-abc', live: true, canFork: true } });
    const title = screen.getByTestId('resume-terminal-btn').getAttribute('title') ?? '';
    expect(title.toLowerCase()).toContain('collide');
    // An ended source has no collision warning.
    cleanup();
    renderModal({ resumeTarget: { sessionId: 'sess-abc', live: false, canFork: true } });
    expect(screen.getByTestId('resume-terminal-btn').getAttribute('title')).toBeNull();
  });

  it('surfaces a "resume failed" state + the server error as the button tooltip when the launch POST fails', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ status: 'error', error: 'no conversation found' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    renderModal({ resumeTarget: { sessionId: 'sess-abc', live: false, canFork: false } });
    const btn = screen.getByTestId('resume-terminal-btn');
    fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toContain('resume failed'));
    // WI-3988/WI-3989: the actual server reason is surfaced (button tooltip),
    // not swallowed into a bare "resume failed".
    expect(btn.getAttribute('title')).toBe('no conversation found');
    vi.unstubAllGlobals();
  });

  it('surfaces the Fork failure independently on the Fork button (per-action state)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ status: 'error', error: 'fork blew up' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    renderModal({ resumeTarget: { sessionId: 'sess-abc', live: true, canFork: true } });
    const fork = screen.getByTestId('fork-terminal-btn');
    fireEvent.click(fork);
    await waitFor(() => expect(fork.textContent).toContain('fork failed'));
    expect(fork.getAttribute('title')).toBe('fork blew up');
    // Resume button stays idle — per-action state, not shared.
    expect(screen.getByTestId('resume-terminal-btn').textContent).toContain('Resume in new terminal');
    vi.unstubAllGlobals();
  });

  it('hides BOTH the Resume and Fork buttons when no resumeTarget is given (never a dead button)', () => {
    renderModal();
    expect(screen.queryByTestId('resume-terminal-btn')).toBeNull();
    expect(screen.queryByTestId('fork-terminal-btn')).toBeNull();
  });
});
