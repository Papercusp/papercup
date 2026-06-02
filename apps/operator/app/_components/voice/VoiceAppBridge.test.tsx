/**
 * @vitest-environment jsdom
 *
 * VoiceAppBridge — routes app-level voice utterances to the Oracle when no
 * higher-priority consumer (the open Operator panel, an undo toast) has claimed
 * them, and speaks Oracle's reply via TTS. Untested. We render the component,
 * capture its onFinalUtterance + voice-state subscriptions, and drive
 * utterances to assert the consumer-priority routing decision + Oracle streaming.
 *
 * Intent parsing is bypassed (wakeWordIntents:false) so we test the
 * consumer/Oracle routing path directly.
 *
 * P-014 of plan voice-production-test-coverage-2026-06-01.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  utteranceCb: null as null | ((t: string) => void | Promise<void>),
  stateCb: null as null | ((s: Record<string, unknown>) => void),
  speak: vi.fn(),
  cancelAllSpeech: vi.fn(),
}));

vi.mock('./voice-mode', () => ({
  onFinalUtterance: (cb: (t: string) => void | Promise<void>) => {
    h.utteranceCb = cb;
    return () => {};
  },
  subscribeVoiceState: (cb: (s: Record<string, unknown>) => void) => {
    h.stateCb = cb;
    return () => {};
  },
  speak: h.speak,
  cancelAllSpeech: h.cancelAllSpeech,
}));
vi.mock('./voice-prefs-client', () => ({
  // fullAgentEngine 'off' + wakeWordIntents false → bypass intent parsing,
  // fall through to consumer / Oracle routing.
  loadVoicePrefsClient: vi.fn(() => ({ fullAgentEngine: 'off', wakeWordIntents: false })),
}));

import { VoiceAppBridge, registerVoiceConsumer } from './VoiceAppBridge';

function sseResponse(blocks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of blocks) c.enqueue(enc.encode(b));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;
const deregs: Array<() => void> = [];
function oracleCalled() {
  return fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/oracle/chat'));
}

const ALWAYS_ON = { mode: 'always-on', status: 'listening', supported: true, lastTranscript: '', speakingRole: null };

function mount() {
  render(<VoiceAppBridge />);
}
function setMode(state: Record<string, unknown>) {
  act(() => h.stateCb?.(state));
}
async function utter(text: string) {
  await act(async () => {
    await h.utteranceCb?.(text);
  });
}

beforeEach(() => {
  h.utteranceCb = null;
  h.stateCb = null;
  h.speak.mockClear();
  fetchMock = vi.fn(async () => sseResponse(['event: done\ndata: {}\n\n']));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  deregs.forEach((d) => d());
  deregs.length = 0;
  cleanup();
  vi.unstubAllGlobals();
});

describe('VoiceAppBridge — Oracle routing', () => {
  it('routes to Oracle and speaks the reply when no consumer is registered (panel closed)', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: delta\ndata: {"text":"Hello from oracle."}\n\n',
        'event: done\ndata: {}\n\n',
      ]),
    );
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(oracleCalled()).toBe(true);
    expect(h.speak).toHaveBeenCalledWith(expect.stringContaining('Hello from oracle'), 'system:oracle');
  });

  it('does nothing when voice mode is off', async () => {
    mount(); // no setMode → stays 'off'
    await utter('ignored while off');
    expect(oracleCalled()).toBe(false);
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('ignores too-short utterances', async () => {
    mount();
    setMode(ALWAYS_ON);
    await utter('a');
    expect(oracleCalled()).toBe(false);
  });
});

describe('VoiceAppBridge — consumer priority', () => {
  it('suppresses Oracle when the Operator panel (panel-open) is registered', async () => {
    mount();
    setMode(ALWAYS_ON);
    deregs.push(registerVoiceConsumer('operator-panel', 'panel-open'));
    await utter('open something');
    expect(oracleCalled()).toBe(false); // panel consumes (suppresses) the turn
  });

  it('hands the utterance to a background-toast consumer’s handler', async () => {
    const handler = vi.fn();
    deregs.push(registerVoiceConsumer('undo-toast', 'background-toast', handler));
    mount();
    setMode(ALWAYS_ON);
    await utter('cancel');
    expect(handler).toHaveBeenCalledWith('cancel');
    expect(oracleCalled()).toBe(false);
  });

  it('panel-open outranks background-toast (higher priority wins, suppresses both toast handler and Oracle)', async () => {
    const toastHandler = vi.fn();
    deregs.push(registerVoiceConsumer('undo-toast', 'background-toast', toastHandler));
    deregs.push(registerVoiceConsumer('operator-panel', 'panel-open'));
    mount();
    setMode(ALWAYS_ON);
    await utter('something');
    expect(toastHandler).not.toHaveBeenCalled(); // panel-open won
    expect(oracleCalled()).toBe(false);
  });

  it('deregistering the panel consumer restores Oracle routing', async () => {
    const dereg = registerVoiceConsumer('operator-panel', 'panel-open');
    mount();
    setMode(ALWAYS_ON);
    dereg(); // panel closed
    await utter('now route me');
    expect(oracleCalled()).toBe(true);
  });
});
