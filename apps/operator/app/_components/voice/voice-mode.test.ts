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
