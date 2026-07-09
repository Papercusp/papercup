/**
 * @vitest-environment jsdom
 *
 * VoiceAppBridge — routes app-level voice utterances into the dock's 🛡
 * Sentinel pane (a psu/Claude-Code TUI) via routeVoiceToSentinelPane()
 * (POST /api/operator/papercup-input), unless a higher-priority consumer
 * (an open Operator panel, an undo toast) has claimed them. We render the
 * component, capture its onFinalUtterance + voice-state subscriptions, and
 * drive utterances to assert the consumer-priority routing decision + the
 * Sentinel-pane hand-off.
 *
 * Intent parsing is bypassed (wakeWordIntents:false) so we test the
 * consumer / Sentinel routing path directly.
 *
 * Routing history: the legacy Oracle fallback (POST /api/oracle/chat) was
 * removed 2026-06-22 (sentinel-tui-shared-backend-and-cards Phase 1), which
 * briefly handed spoken turns to operator:converse. Phase C
 * (sentinel-as-claude-tui-2026-06-22) then SUPERSEDED that converse route:
 * the bridge now writes the final transcript into the Sentinel pane's stdin
 * (local app user only), which generates AND speaks the reply.
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
  routeToSentinel: vi.fn(() => Promise.resolve(true)),
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
  // consumer / Sentinel routing. fullAgentEngine governs whether converse
  // is the active brain (off) or a hosted full-agent owns the turn.
  loadVoicePrefsClient: vi.fn(() => ({ fullAgentEngine: h.fullAgentEngine, wakeWordIntents: false })),
}));
vi.mock('./voice-sentinel-bridge', () => ({
  routeVoiceToSentinelPane: h.routeToSentinel,
  // Phase D voice-OUT polling — kept inert so the bridge's 1.5s interval is a no-op.
  drainSentinelOutput: vi.fn(() => Promise.resolve([])),
}));

import { VoiceAppBridge, registerVoiceConsumer } from './VoiceAppBridge';

function sentinelCalled() {
  return h.routeToSentinel.mock.calls.length > 0;
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
  h.routeToSentinel.mockClear();
  h.routeToSentinel.mockReturnValue(Promise.resolve(true));
  h.fullAgentEngine = 'off';
});
afterEach(() => {
  deregs.forEach((d) => d());
  deregs.length = 0;
  cleanup();
});

describe('VoiceAppBridge — Sentinel-pane routing', () => {
  it('routes the spoken turn into the Sentinel pane when no consumer is registered (panel closed)', async () => {
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(sentinelCalled()).toBe(true);
    expect(h.routeToSentinel).toHaveBeenCalledWith('what is happening');
  });

  it('does nothing when voice mode is off', async () => {
    mount(); // no setMode → stays 'off'
    await utter('ignored while off');
    expect(sentinelCalled()).toBe(false);
  });

  it('ignores too-short utterances', async () => {
    mount();
    setMode(ALWAYS_ON);
    await utter('a');
    expect(sentinelCalled()).toBe(false);
  });

  it('does NOT route into the Sentinel pane when a full-agent engine owns the session', async () => {
    h.fullAgentEngine = 'elevenlabs-conv';
    mount();
    setMode(ALWAYS_ON);
    await utter('the full agent is in charge');
    expect(sentinelCalled()).toBe(false);
  });
});

describe('VoiceAppBridge — consumer priority', () => {
  it('suppresses Sentinel routing when the Operator panel (panel-open) is registered', async () => {
    mount();
    setMode(ALWAYS_ON);
    deregs.push(registerVoiceConsumer('operator-panel', 'panel-open'));
    await utter('open something');
    expect(sentinelCalled()).toBe(false); // panel consumes (suppresses) the turn
  });

  it('hands the utterance to a background-toast consumer’s handler', async () => {
    const handler = vi.fn();
    deregs.push(registerVoiceConsumer('undo-toast', 'background-toast', handler));
    mount();
    setMode(ALWAYS_ON);
    await utter('cancel');
    expect(handler).toHaveBeenCalledWith('cancel');
    expect(sentinelCalled()).toBe(false);
  });

  it('panel-open outranks background-toast (higher priority wins, suppresses both toast handler and Sentinel routing)', async () => {
    const toastHandler = vi.fn();
    deregs.push(registerVoiceConsumer('undo-toast', 'background-toast', toastHandler));
    deregs.push(registerVoiceConsumer('operator-panel', 'panel-open'));
    mount();
    setMode(ALWAYS_ON);
    await utter('something');
    expect(toastHandler).not.toHaveBeenCalled(); // panel-open won
    expect(sentinelCalled()).toBe(false);
  });

  it('deregistering the panel consumer restores Sentinel routing', async () => {
    const dereg = registerVoiceConsumer('operator-panel', 'panel-open');
    mount();
    setMode(ALWAYS_ON);
    dereg(); // panel closed
    await utter('now route me');
    expect(sentinelCalled()).toBe(true);
  });
});
