/**
 * Tests for the mobile voice dispatch tree. Mocks all upstream readers/writers
 * so we can exercise the routing logic without spinning up a WS server, hitting
 * Postgres, or making real HTTP calls.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./device-store', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./device-operator-actions', () => ({
  listPendingCards: vi.fn(),
  dispatchCard: vi.fn(),
  dismissCard: vi.fn(),
  describeCard: vi.fn((c: any) => c.directive_subject ?? c.action),
  setPaused: vi.fn(),
  setResumed: vi.fn(),
}));
vi.mock('./operator-standing-candidates', () => ({
  refreshCandidates: vi.fn(),
  readCandidates: vi.fn(),
}));
vi.mock('./operator-preferences', () => ({
  appendPreferenceEntry: vi.fn().mockResolvedValue(undefined),
}));

import {
  listPendingCards,
  dispatchCard,
  dismissCard,
  setPaused,
  setResumed,
} from './device-operator-actions';
import { refreshCandidates } from './operator-standing-candidates';
import { appendPreferenceEntry } from './operator-preferences';
import {
  dispatchTranscript,
  runDispatch,
  runDismiss,
  type OutgoingFrame,
} from './device-voice-dispatch';
import type { DeviceClaims } from './device-jwt';

const claims: DeviceClaims = {
  sub: 'device-1',
  workspace_id: 'ws-1',
  device_kind: 'mobile',
  user_email: 'test@example.com',
  iat: 0,
  exp: 2 ** 31,
};

function frameSink() {
  const frames: OutgoingFrame[] = [];
  return { frames, send: (f: OutgoingFrame) => { frames.push(f); } };
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn() as any;
});

describe('dispatchTranscript — wake word + intent routing', () => {
  it('strips wake word, then routes "operator scan" → operator-scan fetch', async () => {
    (global.fetch as any).mockResolvedValue({ ok: true });
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'hey operator scan all the harnesses', 'hey operator', send);

    expect(frames.find((f) => f.kind === 'status' && f.status === 'scanning')).toBeTruthy();
    expect(frames.find((f) => f.kind === 'speak' && f.text?.includes('Scanning'))).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as any).mock.calls[0][0] as URL;
    expect(url.pathname).toBe('/api/agent-mcp/operator-scan');
    expect(url.searchParams.get('request')).toBe('all the harnesses');
  });

  it('routes "operator open" without invoking scan', async () => {
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'hey operator open', 'hey operator', send);
    expect(frames).toEqual([{ kind: 'speak', text: expect.stringContaining('Papercup panel'), source: 'operator' }]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('routes "pause" → setPaused + frame', async () => {
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'pause', 'hey operator', send);
    expect(setPaused).toHaveBeenCalledTimes(1);
    expect(frames[0].text).toBe('Papercup paused.');
  });

  it('routes "resume" → setResumed + frame', async () => {
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'resume', 'hey operator', send);
    expect(setResumed).toHaveBeenCalledTimes(1);
    expect(frames[0].text).toBe('Papercup resumed.');
  });

  it('respects per-user wake word override (intent path)', async () => {
    // Wake-word stripping rewrites the prefix to "operator " so the intent
    // parser matches. Voice commands (bare "pause"/"resume") don't use the
    // wake-word path — they parse from the raw transcript directly.
    (global.fetch as any).mockResolvedValue({ ok: true });
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'computer scan all', 'computer', send);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(frames.some((f) => f.kind === 'speak' && f.text?.includes('Scanning'))).toBe(true);
  });

  it('empty transcript is a no-op', async () => {
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, '   ', 'hey operator', send);
    expect(frames).toEqual([]);
  });
});

describe('runDispatch — ordinal resolution', () => {
  it('no pending → friendly speak', async () => {
    (listPendingCards as any).mockResolvedValue([]);
    const { frames, send } = frameSink();
    await runDispatch(undefined, send);
    expect(frames).toHaveLength(1);
    expect(frames[0].text).toMatch(/no pending/i);
  });

  it('default ordinal picks #1', async () => {
    (listPendingCards as any).mockResolvedValue([
      { id: 'c1', action: 'send_directive', target_harness: 'foo', status: 'pending', directive_subject: 'first' },
      { id: 'c2', action: 'send_directive', target_harness: 'bar', status: 'pending', directive_subject: 'second' },
    ]);
    (dispatchCard as any).mockResolvedValue('Dispatched to foo.');
    const { frames, send } = frameSink();
    await runDispatch(undefined, send);
    expect(dispatchCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    expect(frames.some((f) => f.text?.includes('Dispatching: first'))).toBe(true);
    expect(frames.some((f) => f.text === 'Dispatched to foo.')).toBe(true);
  });

  it('ordinal=3 picks third', async () => {
    (listPendingCards as any).mockResolvedValue([
      { id: 'c1', action: 'send_directive', status: 'pending' },
      { id: 'c2', action: 'send_directive', status: 'pending' },
      { id: 'c3', action: 'send_directive', target_harness: 'baz', status: 'pending', directive_subject: 'third' },
    ]);
    (dispatchCard as any).mockResolvedValue('Dispatched to baz.');
    const { frames, send } = frameSink();
    await runDispatch(3, send);
    expect(dispatchCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'c3' }));
  });

  it('out-of-range ordinal → guidance frame', async () => {
    (listPendingCards as any).mockResolvedValue([
      { id: 'c1', action: 'send_directive', status: 'pending' },
    ]);
    const { frames, send } = frameSink();
    await runDispatch(5, send);
    expect(dispatchCard).not.toHaveBeenCalled();
    expect(frames[0].text).toMatch(/Only 1 pending/);
  });
});

describe('runDismiss', () => {
  it('no pending → friendly speak', async () => {
    (listPendingCards as any).mockResolvedValue([]);
    const { frames, send } = frameSink();
    await runDismiss(undefined, send);
    expect(frames[0].text).toMatch(/Nothing to dismiss/);
  });

  it('default ordinal dismisses #1', async () => {
    (listPendingCards as any).mockResolvedValue([
      { id: 'c1', action: 'inform', status: 'pending', directive_subject: 'A' },
    ]);
    (dismissCard as any).mockResolvedValue('Dismissed: A.');
    const { frames, send } = frameSink();
    await runDismiss(undefined, send);
    expect(dismissCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    expect(frames[0].text).toBe('Dismissed: A.');
  });
});

describe('standing-approval voice flow', () => {
  it('approve → appendPreferenceEntry + acknowledgement', async () => {
    (refreshCandidates as any).mockResolvedValue([
      { capability: 'tools:read', targetHarness: 'foo', count: 5, lastSeenAt: '2026-05-01T00:00:00Z', firstShownAt: '2026-05-01T00:01:00Z' },
    ]);
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'operator approve foo tools:read', 'hey operator', send);
    expect(appendPreferenceEntry).toHaveBeenCalledTimes(1);
    expect((appendPreferenceEntry as any).mock.calls[0][0]).toContain('STANDING-APPROVE');
    expect(frames[0].text).toMatch(/Approved standing for tools:read on foo/);
  });

  it('no-match → refusal frame, no preference write', async () => {
    (refreshCandidates as any).mockResolvedValue([]);
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'operator approve nonexistent tools:read', 'hey operator', send);
    expect(appendPreferenceEntry).not.toHaveBeenCalled();
    expect(frames[0].text).toMatch(/No pending standing-approval for nonexistent/);
  });
});

describe('freeform → Oracle bridge', () => {
  it('SSE delta concatenation produces one speak frame', async () => {
    const sseBody = [
      'event: delta\ndata: {"text":"Hello "}\n\n',
      'event: delta\ndata: {"text":"world"}\n\n',
      'event: done\ndata: {}\n\n',
    ].join('');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });
    (global.fetch as any).mockResolvedValue({ ok: true, body: stream });

    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'what is the meaning of life', 'hey operator', send);

    const speak = frames.find((f) => f.kind === 'speak');
    expect(speak?.source).toBe('oracle');
    expect(speak?.text).toBe('Hello world');
    expect(frames.some((f) => f.kind === 'status' && f.status === 'thinking')).toBe(true);
    expect(frames.some((f) => f.kind === 'status' && f.status === 'idle')).toBe(true);
  });

  it('Oracle HTTP failure surfaces as friendly speak', async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 503, body: null });
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'unparseable freeform query', 'hey operator', send);
    const speak = frames.find((f) => f.kind === 'speak');
    expect(speak?.text).toMatch(/Oracle failed/);
  });
});
