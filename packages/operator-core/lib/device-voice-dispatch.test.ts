/**
 * Tests for the mobile voice dispatch tree. Mocks all upstream readers/writers
 * so we can exercise the routing logic without spinning up a WS server, hitting
 * Postgres, or making real HTTP calls.
 *
 * (The card verbs — dispatch/dismiss ordinals over the scanner card stream —
 * were retired with the operator-card panel, unify-agent-launches D-005. A
 * voice scan now fires the `scan` launch blueprint.)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./device-store', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./device-operator-actions', () => ({
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
vi.mock('./blueprint/launch-blueprint', () => ({
  fireLaunchBlueprint: vi.fn().mockResolvedValue({ blueprintId: 'scan', role: 'scanner', url: 'http://test/invoke' }),
}));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));

import { setPaused, setResumed } from './device-operator-actions';
import { refreshCandidates } from './operator-standing-candidates';
import { appendPreferenceEntry } from './operator-preferences';
import { fireLaunchBlueprint } from './blueprint/launch-blueprint';
import { dispatchTranscript, type OutgoingFrame } from './device-voice-dispatch';
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
  it('strips wake word, then routes "operator scan" → the scan launch blueprint (D-005)', async () => {
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'hey operator scan all the harnesses', 'hey operator', send);

    expect(frames.find((f) => f.kind === 'status' && f.status === 'scanning')).toBeTruthy();
    expect(frames.find((f) => f.kind === 'speak' && f.text?.includes('Started a workspace scan'))).toBeTruthy();
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
    const [bpId, input] = (fireLaunchBlueprint as any).mock.calls[0];
    expect(bpId).toBe('scan');
    expect(input.kickoff).toContain('all the harnesses');
    expect(input.timeoutMs).toBe(900_000);
    // No bespoke scan route fetch — the launch blueprint IS the path now.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('"operator open" is no longer an intent (panel retired, D-005) — falls through to Oracle freeform', async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 503, body: null });
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'hey operator open', 'hey operator', send);
    // Routed as freeform → oracle (which we fail here to keep the test cheap).
    const speak = frames.find((f) => f.kind === 'speak');
    expect(speak?.source).toBe('oracle');
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
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
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'computer scan all', 'computer', send);
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
    expect(frames.some((f) => f.kind === 'speak' && f.text?.includes('Started a workspace scan'))).toBe(true);
  });

  it('a failed launch fire surfaces as a friendly speak', async () => {
    (fireLaunchBlueprint as any).mockRejectedValueOnce(new Error('blueprint registry down'));
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, 'hey operator scan', 'hey operator', send);
    expect(frames.some((f) => f.text?.includes('Scan dispatch failed'))).toBe(true);
    expect(frames.some((f) => f.kind === 'status' && f.status === 'idle')).toBe(true);
  });

  it('empty transcript is a no-op', async () => {
    const { frames, send } = frameSink();
    await dispatchTranscript(claims, '   ', 'hey operator', send);
    expect(frames).toEqual([]);
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
