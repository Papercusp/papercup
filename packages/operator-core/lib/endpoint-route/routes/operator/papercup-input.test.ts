import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cors', () => ({
  requireAllowedOriginOr403: vi.fn(() => null),
}));
vi.mock('../../../papercup/papercup-pane-input', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../papercup/papercup-pane-input')>();
  // Keep the REAL isExitedPaneScreen (tested below); stub only the pane write.
  return { ...actual, writeToSentinelPane: vi.fn() };
});
vi.mock('../../../operator-conversations', () => ({
  getOrCreateActiveConversation: vi.fn(),
  appendTurn: vi.fn(),
}));
vi.mock('../../../sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

import routeTools, { isExitedPaneScreen } from './papercup-input';
import { writeToSentinelPane } from '../../../papercup/papercup-pane-input';
import { getOrCreateActiveConversation, appendTurn } from '../../../operator-conversations';

const paneWrite = vi.mocked(writeToSentinelPane);
const getConv = vi.mocked(getOrCreateActiveConversation);
const append = vi.mocked(appendTurn);

const post = routeTools as unknown as {
  handler: (req: Request) => Promise<Response>;
};

function req(body: unknown): Request {
  return new Request('http://127.0.0.1/api/operator/papercup-input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getConv.mockResolvedValue({ id: 'conv-42' } as never);
  append.mockResolvedValue({ seq: 1 } as never);
});

/**
 * WI-4838 D: a spoken transcript the pane ACCEPTED must also land in the
 * shared conversation (source voice_stt) — the pane consumed it, so no other
 * path persists it. Never on failure (the 503 fallback path persists its own
 * user turn via the converse provider — persisting here too double-writes).
 */
describe('papercup-input voice-turn persistence', () => {
  it('persists a spoken turn as user/voice_stt when the pane write succeeds', async () => {
    paneWrite.mockResolvedValue({ ok: true, session: 's', paneId: 'p', targeted: true } as never);
    const res = await post.handler(req({ text: 'what is the capital of France', spoken: true }));
    expect(res.status).toBe(200);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toMatchObject({
      conversationId: 'conv-42',
      role: 'user',
      text: 'what is the capital of France',
      source: 'voice_stt',
    });
  });

  it('does NOT persist a non-spoken (typed) pane write', async () => {
    paneWrite.mockResolvedValue({ ok: true, session: 's', paneId: 'p', targeted: true } as never);
    await post.handler(req({ text: 'typed text', spoken: false }));
    expect(append).not.toHaveBeenCalled();
  });

  it('does NOT persist when the pane write fails (the converse fallback owns it)', async () => {
    paneWrite.mockResolvedValue({ ok: false, reason: 'no-dock', error: 'no dock' } as never);
    const res = await post.handler(req({ text: 'hello', spoken: true }));
    expect(res.status).toBe(503);
    expect(append).not.toHaveBeenCalled();
  });

  it('still returns ok when the mirror persist fails (pane got the words)', async () => {
    paneWrite.mockResolvedValue({ ok: true, session: 's', paneId: 'p', targeted: true } as never);
    append.mockRejectedValueOnce(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post.handler(req({ text: 'hello', spoken: true }));
    expect(res.status).toBe(200);
    warn.mockRestore();
  });
});

/**
 * Guards the exited-pane detection that keeps voice-in from typing into a zellij
 * pane held at the re-run prompt (where the trailing Enter would re-run the
 * command and lose the turn). The markers come from zellij 0.44's held-frame
 * footer: `<ENTER> re-run … Ctrl-c exit [ EXIT CODE: N ] EXITED`.
 */
describe('isExitedPaneScreen', () => {
  it('detects a zellij command pane held at the re-run prompt', () => {
    const dump = [
      'psu: sentinel on claude',
      '$ psu-sentinel',
      'Session ended.',
      ' <ENTER> re-run, <ESC> close, Ctrl-c exit  [ EXIT CODE: 1 ] EXITED ',
    ].join('\n');
    expect(isExitedPaneScreen(dump)).toBe(true);
  });

  it('detects the held frame even with color ANSI styling present', () => {
    const dump = '\x1b[31m <ENTER> re-run \x1b[0m Ctrl-c exit \x1b[1m[ EXIT CODE: 0 ] EXITED\x1b[0m';
    expect(isExitedPaneScreen(dump)).toBe(true);
  });

  it('returns false for a normal, running composer pane', () => {
    const dump = [
      '❯ Try "how do I log an error?"',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      '  papercusp · ◇ role-e0616 · 2 peers · ◆ e8643f',
    ].join('\n');
    expect(isExitedPaneScreen(dump)).toBe(false);
  });

  it('does NOT false-positive on chat that mentions only an exit code', () => {
    // Requiring BOTH `EXIT CODE:` and a `re-run` hint means an ordinary mention of
    // an exit code (the common case) cannot be mistaken for the held frame.
    expect(isExitedPaneScreen('The deploy exited with exit code: 137 (OOM).')).toBe(false);
    expect(isExitedPaneScreen('Should I re-run the migration? It is idempotent.')).toBe(false);
  });

  it('returns false for empty / unrelated output', () => {
    expect(isExitedPaneScreen('')).toBe(false);
    expect(isExitedPaneScreen('just some normal terminal text\nwith no markers')).toBe(false);
  });
});
