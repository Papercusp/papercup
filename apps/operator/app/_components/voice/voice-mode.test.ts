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

  it('does not restore a persisted microphone mode in isolated Tauri verification', async () => {
    vi.resetModules();
    const g = globalThis as any;
    const previousLocation = g.location;
    Object.defineProperty(g, 'location', {
      value: new URL('http://127.0.0.1:33700/?verify-tauri-isolated=1'),
      configurable: true,
    });
    try {
      localStorage.setItem(
        'pc:ws:default:papercusp.voice.config.v1',
        JSON.stringify({ lastMode: 'always-on' }),
      );
      const mod = await import('./voice-mode');
      mod.initVoiceMode();
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(mod.getVoiceState().mode).toBe('off');
    } finally {
      if (previousLocation === undefined) delete g.location;
      else Object.defineProperty(g, 'location', { value: previousLocation, configurable: true });
    }
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

  it('WI-4873: a cold engine cache routes the first spoken reply to the selected adapter (kokoro), not silent WebKitGTK Web Speech', async () => {
    vi.resetModules();
    const g = globalThis as any;
    const origFetch = g.fetch;
    const origAudio = g.Audio;
    const origCreate = g.URL?.createObjectURL;
    const origRevoke = g.URL?.revokeObjectURL;
    try {
      // synthViaAdapter uses fetch → blob → URL.createObjectURL → new Audio().play().
      const fetchSpy = vi.fn(async (..._args: unknown[]) => ({ ok: true, blob: async () => ({}) }) as any);
      g.fetch = fetchSpy;
      // Augment the real URL (adding statics) — never REPLACE it, or `new URL()`
      // elsewhere in this file breaks with "URL is not a constructor".
      g.URL.createObjectURL = () => 'blob:x';
      g.URL.revokeObjectURL = () => {};
      g.Audio = class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor(u: string) { this.src = u; }
        play() { this.onended?.(); return Promise.resolve(); }
        pause() {}
      };
      const mod = await import('./voice-mode');
      mod.initVoiceMode();
      // localStorage empty → loadVoicePrefsClient defaults ttsEngine to 'kokoro'.
      // force:true bypasses the mode/mute/leader gates so we isolate ENGINE ROUTING.
      mod.speak('the harness is green', 'system:operator', 'polite', { force: true });
      await new Promise((r) => setTimeout(r, 0)); // let the async adapter path reach fetch()
      // Regression: the FIRST utterance must NOT use the silent WebKitGTK Web Speech path…
      expect(g.window.speechSynthesis.speak).not.toHaveBeenCalled();
      // …and MUST synthesize through the server adapter with the selected engine.
      const ttsCall = fetchSpy.mock.calls.find((c: any[]) => String(c[0]).includes('operator-tts-preview'));
      expect(ttsCall).toBeTruthy();
      expect(String((ttsCall![1] as any).body)).toContain('kokoro');
    } finally {
      g.fetch = origFetch;
      g.Audio = origAudio;
      if (origCreate) g.URL.createObjectURL = origCreate; else delete g.URL.createObjectURL;
      if (origRevoke) g.URL.revokeObjectURL = origRevoke; else delete g.URL.revokeObjectURL;
    }
  });
});

// ── WI-5174 — spoken output never fails silently ──────────────────────────
// Owner repro 2026-07-17: "they replied a fine response but it showed up in the
// text chat and wasn't spoken out loud like it should have been." Evidence
// showed kokoro DID return 200 + WAV bytes, so the failure was strictly in
// client-side playback — where every branch resolved silently and the queue
// advanced as if it had spoken. These lock in that a failure to SPEAK always
// tells the user, via the same papercusp:voiceTimeout channel VoiceButton
// already toasts.
describe('WI-5174: spoken playback failures are surfaced, not swallowed', () => {
  interface Harness {
    mod: typeof import('./voice-mode');
    toasts: Array<{ phase: string; message: string }>;
    restore: () => void;
  }

  /**
   * Drive one utterance through synthViaAdapter with a scripted Audio stub.
   * `audioBehavior` decides how playback resolves; `fetchOk` decides whether the
   * TTS route returns bytes at all.
   */
  async function runUtterance(opts: {
    fetchOk?: boolean;
    status?: number;
    audioBehavior?: 'ok' | 'play-rejects' | 'play-rejects-autoplay' | 'onerror' | 'throws';
  }): Promise<Harness> {
    const { fetchOk = true, status = 200, audioBehavior = 'ok' } = opts;
    vi.resetModules();
    const g = globalThis as any;
    const origFetch = g.fetch;
    const origAudio = g.Audio;
    const origCreate = g.URL?.createObjectURL;
    const origRevoke = g.URL?.revokeObjectURL;
    const origDispatch = g.dispatchEvent;

    const toasts: Array<{ phase: string; message: string }> = [];
    g.dispatchEvent = (e: any) => {
      if (e?.type === 'papercusp:voiceTimeout' && e.detail) toasts.push(e.detail);
      return true;
    };
    g.fetch = vi.fn(async () => {
      if (audioBehavior === 'throws') throw new Error('network down');
      return { ok: fetchOk, status, blob: async () => ({}) } as any;
    });
    g.URL.createObjectURL = () => 'blob:x';
    g.URL.revokeObjectURL = () => {};
    g.Audio = class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = '';
      constructor(u: string) { this.src = u; }
      play(): Promise<void> {
        if (audioBehavior === 'onerror') { this.onerror?.(); return Promise.resolve(); }
        if (audioBehavior === 'play-rejects') return Promise.reject(new Error('boom'));
        if (audioBehavior === 'play-rejects-autoplay') {
          const err = new Error('play() failed because the user did not interact first');
          err.name = 'NotAllowedError';
          return Promise.reject(err);
        }
        this.onended?.();
        return Promise.resolve();
      }
      pause() {}
    };

    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.speak('the harness is green', 'system:operator', 'polite', { force: true });
    // Let the async adapter path run: fetch → blob → Audio → play/settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    return {
      mod,
      toasts,
      restore: () => {
        g.fetch = origFetch;
        g.Audio = origAudio;
        g.dispatchEvent = origDispatch;
        if (origCreate) g.URL.createObjectURL = origCreate; else delete g.URL.createObjectURL;
        if (origRevoke) g.URL.revokeObjectURL = origRevoke; else delete g.URL.revokeObjectURL;
      },
    };
  }

  it('stays silent when playback actually succeeds (no false alarm)', async () => {
    const h = await runUtterance({ audioBehavior: 'ok' });
    try {
      expect(h.toasts).toHaveLength(0);
    } finally { h.restore(); }
  });

  it('tells the user when play() is rejected — the exact WI-5174 shape', async () => {
    const h = await runUtterance({ audioBehavior: 'play-rejects' });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].phase).toBe('playback');
      expect(h.toasts[0].message).toMatch(/couldn't be played/i);
    } finally { h.restore(); }
  });

  it('names autoplay blocking specifically so the user acts on the right problem', async () => {
    const h = await runUtterance({ audioBehavior: 'play-rejects-autoplay' });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].message).toMatch(/click anywhere/i);
      // Must NOT send the user hunting speakers/output devices.
      expect(h.toasts[0].message).not.toMatch(/couldn't be played/i);
    } finally { h.restore(); }
  });

  it('tells the user when the audio element errors', async () => {
    const h = await runUtterance({ audioBehavior: 'onerror' });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].phase).toBe('playback');
    } finally { h.restore(); }
  });

  it('tells the user when the TTS route returns non-ok (no bytes to play)', async () => {
    const h = await runUtterance({ fetchOk: false, status: 503 });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].message).toMatch(/couldn't generate speech/i);
      expect(h.toasts[0].message).toContain('503');
    } finally { h.restore(); }
  });

  it('tells the user when the adapter throws outright', async () => {
    const h = await runUtterance({ audioBehavior: 'throws' });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].message).toMatch(/playback failed/i);
    } finally { h.restore(); }
  });

  it('throttles a persistently broken sink to one toast, not one per utterance', async () => {
    const h = await runUtterance({ audioBehavior: 'play-rejects' });
    try {
      // Two more failing utterances inside the throttle window.
      h.mod.speak('second reply', 'system:operator', 'polite', { force: true });
      await new Promise((r) => setTimeout(r, 0));
      h.mod.speak('third reply', 'system:operator', 'polite', { force: true });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.toasts).toHaveLength(1);
    } finally { h.restore(); }
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

// WI-4500: the always-on mic hears papercup's OWN kokoro TTS (WebKitGTK AEC is weak),
// whisper hallucinates a stable token ("omid"), it sails past isBlankTranscript, and the
// self-refreshing wake window keeps papercup talking to its own echo forever. These pin
// the two guards that break that loop. Each also carries the DISCRIMINATION half — the
// guard must stay silent on real input — because a guard that drops everything is not a
// guard (see harness fact a-claimed-guard-is-not-a-guard).
describe('always-on self-feedback guards (WI-4500)', () => {
  const T0 = 2_000_000;

  it('isLikelyWhisperHallucination catches whisper non-speech tokens including "omid"', async () => {
    const mod = await import('./voice-mode');
    // The tokens the loop actually produced / the classic whisper.cpp hallucinations.
    for (const t of ['omid', 'Omid', ' OMID ', 'you', 'Thank you', 'thanks for watching']) {
      expect(mod.isLikelyWhisperHallucination(t)).toBe(true);
    }
  });

  it('does NOT filter real one-word replies (discrimination — not a mute button)', async () => {
    const mod = await import('./voice-mode');
    // These are legitimate short commands a user says; they MUST pass.
    for (const t of ['yes', 'no', 'stop', 'open the dashboard', 'what changed today']) {
      expect(mod.isLikelyWhisperHallucination(t)).toBe(false);
    }
  });

  it('isSelfAudioLikely is true within the cooldown after playout ends, false after', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow(); // also clears synthQuietSince
    // Nothing has spoken → not self-audio.
    expect(mod.isSelfAudioLikely(T0)).toBe(false);
    // Playout just ended → inside the ~700ms AEC-settle tail → treat mic as self-audio.
    mod.__markSynthPlayoutEnded(T0);
    expect(mod.isSelfAudioLikely(T0 + 100)).toBe(true);
    expect(mod.isSelfAudioLikely(T0 + 699)).toBe(true);
    // Past the tail → the room is quiet again, real speech is trustworthy.
    expect(mod.isSelfAudioLikely(T0 + 1_500)).toBe(false);
  });
});
