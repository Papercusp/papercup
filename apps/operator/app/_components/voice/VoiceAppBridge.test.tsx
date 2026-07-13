/**
 * @vitest-environment jsdom
 *
 * VoiceAppBridge — routes app-level voice utterances into the Papercup
 * CONVERSE thread (the operator chat sidebar's shared conversation, via the
 * provider-registered submitVoiceTurn), unless a higher-priority consumer
 * (an open Operator panel, an undo toast) has claimed them. When the
 * FLAGS.TESTING dev path is ON, the dock's 🛡 Sentinel pane
 * (routeVoiceToSentinelPane → POST /api/operator/papercup-input) keeps
 * priority, degrading to converse on a failed pane write. We render the
 * component, capture its onFinalUtterance + voice-state subscriptions, and
 * drive utterances to assert the consumer-priority routing decision + the
 * brain hand-off.
 *
 * Intent parsing is bypassed (wakeWordIntents:false) so we test the
 * consumer / brain routing path directly.
 *
 * Routing history: the legacy Oracle fallback (POST /api/oracle/chat) was
 * removed 2026-06-22 (sentinel-tui-shared-backend-and-cards Phase 1), which
 * briefly handed spoken turns to operator:converse. Phase C
 * (sentinel-as-claude-tui-2026-06-22) then SUPERSEDED that converse route
 * with the pane write; WI-4337 flipped to converse-primary while the pane
 * brain was too heavy for the voice window; voice-public-release-readiness
 * P-019 (2026-07-12) made the PANE primary again (fast papercup role) with a
 * spoken instant ack; operator-chat-sidebar-revival P-007/D-001 (2026-07-13)
 * reversed that once more — the sidebar is the shipped chat surface and the
 * dock is TESTING-gated, so CONVERSE is primary and the pane is the
 * FLAGS.TESTING dev path.
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
  // FLAGS.TESTING: false = shipped config (converse-primary, dock hidden);
  // true = the dev dock path (pane-primary). P-007/D-001.
  testingFlag: false,
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
  // The bridge seeds its state ref from the live module state (no more
  // hand-enumerated partial literal). Off-state default; tests push their
  // own state through h.stateCb.
  getVoiceState: () => ({
    mode: 'off', status: 'off', supported: false,
    hasWebSpeechSTT: false, hasWebSpeechTTS: false,
    lastTranscript: '', speakingRole: null, wakeDetected: false, userSpoke: false,
    micOwnedByFullAgent: false, audioReceiving: false,
    processingTranscript: false, awaitingResponse: false, wakeListening: false,
  }),
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
// The pane dev path is gated on FLAGS.TESTING (P-007/D-001): default OFF
// (the shipped converse-primary config); the dev-pane suite flips it on.
vi.mock('@papercusp/flags', () => ({
  FLAGS: { TESTING: 'papercusp-testing' },
}));
vi.mock('@/lib/flag-hooks', () => ({
  useFlag: () => h.testingFlag,
}));

import { VoiceAppBridge, registerVoiceConsumer } from './VoiceAppBridge';
import { setVoiceConverseHandler } from './voice-converse-handler';

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
  h.testingFlag = false;
  // Reset the module-level converse seam so no provider is "mounted" by default
  // (the dock-fallback tests below assume this); the primary-path suite registers
  // its own handler.
  setVoiceConverseHandler(null);
});
afterEach(() => {
  deregs.forEach((d) => d());
  deregs.length = 0;
  cleanup();
});

// Converse-primary routing (operator-chat-sidebar-revival P-007/D-001): the
// operator chat sidebar's converse thread is the PRIMARY voice brain in the
// shipped config (FLAGS.TESTING off — the dock doesn't exist). The pane is
// the TESTING dev path (suite below).
describe('VoiceAppBridge — converse-primary routing (shipped config)', () => {
  it('submits the utterance to the converse brain when no consumer is registered', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(converse).toHaveBeenCalledWith('what is happening', { spoken: true });
  });

  it('never touches the Sentinel pane while the TESTING dev path is off', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(sentinelCalled()).toBe(false);
  });

  it('speaks no local ack on the converse path (the provider speaks the real reply)', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('does nothing when voice mode is off', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    mount(); // no setMode → stays 'off'
    await utter('ignored while off');
    expect(converse).not.toHaveBeenCalled();
    expect(sentinelCalled()).toBe(false);
  });

  it('ignores too-short utterances', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    mount();
    setMode(ALWAYS_ON);
    await utter('a');
    expect(converse).not.toHaveBeenCalled();
  });

  it('does NOT dispatch to converse when a full-agent engine owns the session', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    h.fullAgentEngine = 'elevenlabs-conv';
    mount();
    setMode(ALWAYS_ON);
    await utter('the full agent is in charge');
    expect(converse).not.toHaveBeenCalled();
    expect(sentinelCalled()).toBe(false);
  });

  it('drops the turn silently when no provider is registered (no pane attempt, no false ack)', async () => {
    // No setVoiceConverseHandler — submitVoiceTurn returns false.
    mount();
    setMode(ALWAYS_ON);
    await utter('anyone there');
    expect(sentinelCalled()).toBe(false); // dev path off — pane never tried
    expect(h.speak).not.toHaveBeenCalled(); // no false ack
  });
});

describe('VoiceAppBridge — consumer priority', () => {
  it('suppresses converse routing when the Operator panel (panel-open) is registered', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    mount();
    setMode(ALWAYS_ON);
    deregs.push(registerVoiceConsumer('operator-panel', 'panel-open'));
    await utter('open something');
    expect(converse).not.toHaveBeenCalled(); // panel consumes (suppresses) the turn
    expect(sentinelCalled()).toBe(false);
  });

  it('hands the utterance to a background-toast consumer’s handler', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    const handler = vi.fn();
    deregs.push(registerVoiceConsumer('undo-toast', 'background-toast', handler));
    mount();
    setMode(ALWAYS_ON);
    await utter('cancel');
    expect(handler).toHaveBeenCalledWith('cancel');
    expect(converse).not.toHaveBeenCalled();
  });

  it('panel-open outranks background-toast (higher priority wins, suppresses both toast handler and brain routing)', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    const toastHandler = vi.fn();
    deregs.push(registerVoiceConsumer('undo-toast', 'background-toast', toastHandler));
    deregs.push(registerVoiceConsumer('operator-panel', 'panel-open'));
    mount();
    setMode(ALWAYS_ON);
    await utter('something');
    expect(toastHandler).not.toHaveBeenCalled(); // panel-open won
    expect(converse).not.toHaveBeenCalled();
  });

  it('deregistering the panel consumer restores converse routing', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    const dereg = registerVoiceConsumer('operator-panel', 'panel-open');
    mount();
    setMode(ALWAYS_ON);
    dereg(); // panel closed
    await utter('now route me');
    expect(converse).toHaveBeenCalledWith('now route me', { spoken: true });
  });
});

// Dev pane path (FLAGS.TESTING on — the dock exists): the dock's Papercup
// pane keeps priority over converse (the pre-revival P-019 behavior), with a
// spoken instant ack on success and a converse degrade on a failed pane
// write. P-007/D-001 gates this whole path behind the TESTING flag.
describe('VoiceAppBridge — dev pane path (FLAGS.TESTING on)', () => {
  beforeEach(() => {
    h.testingFlag = true;
  });

  it('routes the utterance to the Papercup pane first', async () => {
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(sentinelCalled()).toBe(true);
    expect(h.routeToSentinel).toHaveBeenCalledWith('what is happening');
  });

  it('speaks a short instant ack after a successful pane write', async () => {
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(h.speak).toHaveBeenCalledWith('On it.', 'system:operator', 'polite');
  });

  it('does NOT dispatch to the converse brain when the pane write succeeded', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(sentinelCalled()).toBe(true);
    expect(converse).not.toHaveBeenCalled(); // one brain per turn — no double-dispatch
  });

  it('degrades to the converse brain when the pane write fails', async () => {
    h.routeToSentinel.mockReturnValue(Promise.resolve(false)); // pane route down
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    mount();
    setMode(ALWAYS_ON);
    await utter('what is happening');
    expect(sentinelCalled()).toBe(true); // pane was TRIED first
    expect(converse).toHaveBeenCalledWith('what is happening', { spoken: true });
    // No instant ack on the converse path — the provider speaks the real reply.
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('a full-agent engine still owns its own brain (no pane write, no converse dispatch)', async () => {
    const converse = vi.fn();
    setVoiceConverseHandler(converse);
    h.fullAgentEngine = 'elevenlabs-conv';
    mount();
    setMode(ALWAYS_ON);
    await utter('the full agent is in charge');
    expect(converse).not.toHaveBeenCalled();
    expect(sentinelCalled()).toBe(false);
  });

  it('drops the turn silently when neither the pane nor a provider is available', async () => {
    h.routeToSentinel.mockReturnValue(Promise.resolve(false)); // pane route down
    // No setVoiceConverseHandler — submitVoiceTurn returns false.
    mount();
    setMode(ALWAYS_ON);
    await utter('anyone there');
    expect(sentinelCalled()).toBe(true); // tried
    expect(h.speak).not.toHaveBeenCalled(); // no false ack
  });
});
