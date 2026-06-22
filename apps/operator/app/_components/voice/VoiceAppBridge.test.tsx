/**
 * @vitest-environment jsdom
 *
 * VoiceAppBridge — routes app-level voice utterances into the
 * operator:converse brain (the SAME backend the Sentinel TUI text chat
 * drives) via routeVoiceUtteranceToConverse(), unless a higher-priority
 * consumer (an open Operator panel, an undo toast) has claimed them. We
 * render the component, capture its onFinalUtterance + voice-state
 * subscriptions, and drive utterances to assert the consumer-priority
 * routing decision + the converse hand-off.
 *
 * Intent parsing is bypassed (wakeWordIntents:false) so we test the
 * consumer / converse routing path directly.
 *
 * The legacy Oracle fallback (POST /api/oracle/chat) was removed
 * 2026-06-22 (sentinel-tui-shared-backend-and-cards Phase 1): Oracle is
 * a separate concierge brain (not the conversation) and 404s on the
 * desktop host. The bridge now hands spoken turns to operator:converse,
 * which generates AND speaks the reply.
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
  routeToConverse: vi.fn(() => true),
  fullAgentEngine: 'off' as string,
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
  // wakeWordIntents false → bypass intent parsing, fall through to
  // consumer / converse routing. fullAgentEngine governs whether converse
  // is the active brain (off) or a hosted full-agent owns the turn.
  loadVoicePrefsClient: vi.fn(() => ({ fullAgentEngine: h.fullAgentEngine, wakeWordIntents: false })),
}));
vi.mock('./voice-converse-bridge', () => ({
  routeVoiceUtteranceToConverse: h.routeToConverse,
}));

import { VoiceAppBridge, registerVoiceConsumer } from './VoiceAppBridge';

function converseCalled() {
  return h.routeToConverse.mock.calls.length > 0;
}

const ALWAYS_ON = { mode: 'always-on', status: 'listening', supported: true, lastTranscript: '', speakingRole: null };

const deregs: Array<() => void> = [];

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
  h.routeToConverse.mockClear();
  h.routeToConverse.mockReturnValue(true);
  h.fullAgentEngine = 'off';
});
afterEach(() => {
  deregs.forEach((d) => d());
  deregs.length = 0;
  cleanup();
});

describe('VoiceAppBridge — converse routing', () => {
  it('routes the spoken turn into operator:converse when no consumer is registered (panel closed)', async () => {
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(converseCalled()).toBe(true);
    expect(h.routeToConverse).toHaveBeenCalledWith('what is happening');
  });

  it('does nothing when voice mode is off', async () => {
    mount(); // no setMode → stays 'off'
    await utter('ignored while off');
    expect(converseCalled()).toBe(false);
  });

  it('ignores too-short utterances', async () => {
    mount();
    setMode(ALWAYS_ON);
    await utter('a');
    expect(converseCalled()).toBe(false);
  });

  it('does NOT route into converse when a full-agent engine owns the session', async () => {
    h.fullAgentEngine = 'elevenlabs-conv';
    mount();
    setMode(ALWAYS_ON);
    await utter('the full agent is in charge');
    expect(converseCalled()).toBe(false);
  });
});

describe('VoiceAppBridge — consumer priority', () => {
  it('suppresses converse when the Operator panel (panel-open) is registered', async () => {
    mount();
    setMode(ALWAYS_ON);
    deregs.push(registerVoiceConsumer('operator-panel', 'panel-open'));
    await utter('open something');
    expect(converseCalled()).toBe(false); // panel consumes (suppresses) the turn
  });

  it('hands the utterance to a background-toast consumer’s handler', async () => {
    const handler = vi.fn();
    deregs.push(registerVoiceConsumer('undo-toast', 'background-toast', handler));
    mount();
    setMode(ALWAYS_ON);
    await utter('cancel');
    expect(handler).toHaveBeenCalledWith('cancel');
    expect(converseCalled()).toBe(false);
  });

  it('panel-open outranks background-toast (higher priority wins, suppresses both toast handler and converse)', async () => {
    const toastHandler = vi.fn();
    deregs.push(registerVoiceConsumer('undo-toast', 'background-toast', toastHandler));
    deregs.push(registerVoiceConsumer('operator-panel', 'panel-open'));
    mount();
    setMode(ALWAYS_ON);
    await utter('something');
    expect(toastHandler).not.toHaveBeenCalled(); // panel-open won
    expect(converseCalled()).toBe(false);
  });

  it('deregistering the panel consumer restores converse routing', async () => {
    const dereg = registerVoiceConsumer('operator-panel', 'panel-open');
    mount();
    setMode(ALWAYS_ON);
    dereg(); // panel closed
    await utter('now route me');
    expect(converseCalled()).toBe(true);
  });
});
