/**
 * Voice-mode logic unit tests. Browser APIs are stubbed; we test the
 * state transitions and voice assignment hash-stability.
 */

// Node environment with manual window stubs (jsdom not installed in this workspace).
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  // Stub Web Speech APIs.
  (globalThis as any).window = globalThis;
  // initVoiceMode registers pagehide/beforeunload + visibilitychange/
  // focus/blur listeners. Without these stubs the test environment
  // throws "window.addEventListener is not a function" at module-eval
  // time on every test in this file.
  if (!(globalThis as any).addEventListener) {
    (globalThis as any).addEventListener = () => {};
    (globalThis as any).removeEventListener = () => {};
  }
  if (!(globalThis as any).document) {
    (globalThis as any).document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      visibilityState: 'visible',
    };
  }
  if (!(globalThis as any).sessionStorage) {
    (globalThis as any).sessionStorage = {
      _s: new Map<string, string>(),
      getItem(k: string) { return (this._s as any).get(k) ?? null; },
      setItem(k: string, v: string) { (this._s as any).set(k, v); },
      removeItem(k: string) { (this._s as any).delete(k); },
      clear() { (this._s as any).clear(); },
    };
  }
  (globalThis as any).SpeechRecognition = class {
    onresult: any = null;
    onend: any = null;
    onerror: any = null;
    continuous = false;
    interimResults = false;
    lang = 'en-US';
    start() {}
    stop() {}
  };
  (globalThis as any).window.speechSynthesis = {
    getVoices: () =>
      [
        { name: 'Alice', lang: 'en-US' },
        { name: 'Bob', lang: 'en-US' },
        { name: 'Carol', lang: 'en-GB' },
      ] as any,
    speak: vi.fn(),
    cancel: vi.fn(),
    onvoiceschanged: undefined,
  };
  (globalThis as any).SpeechSynthesisUtterance = class {
    rate = 1;
    voice: any = null;
    onend: any = null;
    onerror: any = null;
    constructor(public text: string) {}
  };
  (globalThis as any).localStorage = {
    _store: new Map<string, string>(),
    getItem(k: string) {
      return (this._store as any).get(k) ?? null;
    },
    setItem(k: string, v: string) {
      (this._store as any).set(k, v);
    },
    removeItem(k: string) {
      (this._store as any).delete(k);
    },
    clear() {
      (this._store as any).clear();
    },
  };
});

describe('voice-mode', () => {
  it('initializes with off state', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    const s = mod.getVoiceState();
    expect(s.mode).toBe('off');
    expect(s.supported).toBe(true);
  });

  it('lists available voices', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    const voices = mod.listAvailableVoices();
    expect(voices.length).toBe(3);
    expect(voices[0].name).toBe('Alice');
  });

  it('assigned voices persist across calls', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.assignVoiceToRole('orchestrator', 'Alice');
    expect(mod.getVoiceConfig().roleVoices['orchestrator']).toBe('Alice');
    // Re-assign — overwrites.
    mod.assignVoiceToRole('orchestrator', 'Bob');
    expect(mod.getVoiceConfig().roleVoices['orchestrator']).toBe('Bob');
  });

  it('different roles can have different voices', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.assignVoiceToRole('role-a', 'Alice');
    mod.assignVoiceToRole('role-b', 'Bob');
    const cfg = mod.getVoiceConfig();
    expect(cfg.roleVoices['role-a']).toBe('Alice');
    expect(cfg.roleVoices['role-b']).toBe('Bob');
  });

  it('updateVoiceConfig persists wake word', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.updateVoiceConfig({ wakeWord: 'paperclip activate' });
    expect(mod.getVoiceConfig().wakeWord).toBe('paperclip activate');
  });

  it('assignVoiceToRole sets explicit voice', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.assignVoiceToRole('worker', 'Bob');
    expect(mod.getVoiceConfig().roleVoices['worker']).toBe('Bob');
  });

  // Voice-OUTPUT (TTS) mute — the speaker toggle in the voice bar
  // (sentinel-as-claude-tui-2026-06-23). Default unmuted (responses spoken);
  // setVoiceOutputMuted persists through localStorage and round-trips. (The
  // broadcast event is best-effort/try-caught, so persistence holds even when
  // window.dispatchEvent is absent in this Node test env.)
  it('voice output mute (TTS toggle) defaults off and round-trips', async () => {
    const mod = await import('./voice-mode');
    expect(mod.isVoiceOutputMuted()).toBe(false);
    mod.setVoiceOutputMuted(true);
    expect(mod.isVoiceOutputMuted()).toBe(true);
    mod.setVoiceOutputMuted(false);
    expect(mod.isVoiceOutputMuted()).toBe(false);
  });
});

// Always-on wake-phrase gate (voice-public-release-readiness-2026-07-12 P-004).
// The always-on local loop hears EVERYTHING; the gate forwards only
// wake-phrase-prefixed utterances or follow-ups inside the conversation
// window a wake opened. Pure w.r.t. time (nowMs param) so fully deterministic.
describe('gateAlwaysOnTranscript (P-004 wake gate)', () => {
  const T0 = 1_000_000;

  it('drops ambient speech outside a wake window', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    expect(mod.gateAlwaysOnTranscript('the meeting is at three', T0)).toEqual({
      dispatch: null,
      bareWake: false,
    });
  });

  it('a bare wake opens the window and reports bareWake', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    expect(mod.gateAlwaysOnTranscript('Hey Papercup!', T0)).toEqual({
      dispatch: null,
      bareWake: true,
    });
    // Follow-up inside the window now dispatches verbatim.
    expect(mod.gateAlwaysOnTranscript('what changed today', T0 + 5_000)).toEqual({
      dispatch: 'what changed today',
      bareWake: false,
    });
  });

  it('wake + command dispatches the trailing command', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    expect(mod.gateAlwaysOnTranscript('Hey, Papercup. open the dashboard', T0)).toEqual({
      dispatch: 'open the dashboard',
      bareWake: false,
    });
  });

  it('the conversation window expires (~25s) and each follow-up refreshes it', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    mod.gateAlwaysOnTranscript('hey papercup', T0); // opens window
    // Follow-up at +20s → inside, dispatched, refreshes the window.
    expect(mod.gateAlwaysOnTranscript('and the tests?', T0 + 20_000).dispatch).toBe('and the tests?');
    // +40s = 20s after the refresh → still inside.
    expect(mod.gateAlwaysOnTranscript('run them', T0 + 40_000).dispatch).toBe('run them');
    // +40s + 26s → expired, ambient speech dropped again.
    expect(mod.gateAlwaysOnTranscript('unrelated chatter', T0 + 66_000).dispatch).toBe(null);
  });

  it('resetWakeConversationWindow closes an open window', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    mod.gateAlwaysOnTranscript('hey papercup', T0);
    mod.resetWakeConversationWindow();
    expect(mod.gateAlwaysOnTranscript('should be dropped', T0 + 1_000).dispatch).toBe(null);
  });
});
