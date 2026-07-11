/**
 * Voice-mode capture/runtime unit tests.
 *
 * Covers the paths that broke (and were fixed) during the WebKitGTK voice
 * debugging session and had zero coverage:
 *   - the PTT "no audio detected" failure message, including how it's
 *     tailored from the real getUserMedia error (setMicCaptureError)
 *   - audioReceiving → "processing transcript" vs. the no-audio toast
 *   - __simulateUtterance → onFinalUtterance dispatch + awaitingResponse
 *   - speak()/cancelAllSpeech queue plumbing
 *   - setVoiceMode off/always-on state
 *   - shouldSkipVoicemodeWhisperOnThisRuntime (the runtime-gating truth
 *     table behind the PTT-vs-always-on capture asymmetry)
 *
 * Browser APIs are stubbed (no jsdom in this workspace). A real
 * window event bus is installed so we can assert the 'papercusp:voiceTimeout'
 * CustomEvents the no-audio path dispatches.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type TimeoutDetail = { phase: string; message: string };

beforeEach(() => {
  vi.resetModules();

  const g = globalThis as any;
  g.window = globalThis;

  // Real, minimal event bus — voice-mode dispatches CustomEvents we assert.
  const listeners = new Map<string, Set<(e: any) => void>>();
  g.addEventListener = (type: string, cb: (e: any) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(cb);
  };
  g.removeEventListener = (type: string, cb: (e: any) => void) => {
    listeners.get(type)?.delete(cb);
  };
  g.dispatchEvent = (ev: any) => {
    listeners.get(ev.type)?.forEach((cb) => cb(ev));
    return true;
  };
  if (typeof g.Event === 'undefined') {
    g.Event = class { type: string; constructor(type: string) { this.type = type; } };
  }
  if (typeof g.CustomEvent === 'undefined') {
    g.CustomEvent = class {
      type: string; detail: any;
      constructor(type: string, init?: { detail?: any }) { this.type = type; this.detail = init?.detail; }
    };
  }

  // Network is never reachable in unit tests — make fetch reject cleanly so
  // the async capture machinery falls through instead of throwing.
  g.fetch = vi.fn(() => Promise.reject(new Error('no network in test')));

  g.document = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' };

  g.SpeechRecognition = class {
    onresult: any = null; onend: any = null; onerror: any = null;
    continuous = false; interimResults = false; lang = 'en-US';
    start() {} stop() {}
  };
  g.window.speechSynthesis = {
    getVoices: () => [{ name: 'Alice', lang: 'en-US' }, { name: 'Bob', lang: 'en-US' }],
    speak: vi.fn(),
    cancel: vi.fn(),
    onvoiceschanged: undefined,
  };
  g.SpeechSynthesisUtterance = class {
    rate = 1; voice: any = null; onend: any = null; onerror: any = null;
    constructor(public text: string) {}
  };

  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  const sess = new Map<string, string>();
  g.sessionStorage = {
    getItem: (k: string) => sess.get(k) ?? null,
    setItem: (k: string, v: string) => void sess.set(k, v),
    removeItem: (k: string) => void sess.delete(k),
    clear: () => sess.clear(),
  };
});

/** Capture every papercusp:voiceTimeout detail dispatched during `fn`. */
function captureTimeouts(fn: () => void): TimeoutDetail[] {
  const events: TimeoutDetail[] = [];
  const handler = (e: any) => events.push(e.detail);
  (globalThis as any).addEventListener('papercusp:voiceTimeout', handler);
  try { fn(); } finally { (globalThis as any).removeEventListener('papercusp:voiceTimeout', handler); }
  return events;
}

async function loadVoiceMode() {
  const mod = await import('./voice-mode');
  mod.initVoiceMode();
  return mod;
}

describe('stopPushToTalk — "no audio" failure messaging', () => {
  it('dispatches a no-audio voiceTimeout with the generic message when no audio + no error', async () => {
    const mod = await loadVoiceMode();
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('no-audio');
    expect(events[0].message).toContain('No audio detected');
    expect(events[0].message).toContain('check your microphone');
  });

  it('reports a blocked-permission message when getUserMedia failed with NotAllowedError', async () => {
    const mod = await loadVoiceMode();
    mod.setMicCaptureError({ name: 'NotAllowedError', message: 'Permission denied' });
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events[0].phase).toBe('no-audio');
    expect(events[0].message).toContain('Microphone access is blocked');
  });

  it('reports an unavailable-device message (with the error name) for NotReadableError', async () => {
    const mod = await loadVoiceMode();
    mod.setMicCaptureError({ name: 'NotReadableError', message: 'Device in use' });
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events[0].message).toContain('Microphone unavailable');
    expect(events[0].message).toContain('NotReadableError');
  });

  it('clears a stale error when passed null, falling back to the generic message', async () => {
    const mod = await loadVoiceMode();
    mod.setMicCaptureError({ name: 'NotAllowedError', message: 'x' });
    mod.setMicCaptureError(null);
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events[0].message).toContain('No audio detected');
    expect(events[0].message).not.toContain('blocked');
  });

  it('does NOT fire no-audio when audio was received — it enters processing instead', async () => {
    const mod = await loadVoiceMode();
    mod.setAudioReceiving(true);
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events).toHaveLength(0);
    expect(mod.getVoiceState().processingTranscript).toBe(true);
    // stopPushToTalk resets the receiving flag once the hold ends.
    expect(mod.getVoiceState().audioReceiving).toBe(false);
  });
});

describe('setAudioReceiving', () => {
  it('writes the flag and is idempotent', async () => {
    const mod = await loadVoiceMode();
    expect(mod.getVoiceState().audioReceiving).toBe(false);
    mod.setAudioReceiving(true);
    expect(mod.getVoiceState().audioReceiving).toBe(true);
    mod.setAudioReceiving(true); // no-op, no throw
    expect(mod.getVoiceState().audioReceiving).toBe(true);
  });
});

describe('utterance dispatch', () => {
  it('__simulateUtterance notifies onFinalUtterance listeners and arms awaitingResponse', async () => {
    const mod = await loadVoiceMode();
    const got: string[] = [];
    const unsub = mod.onFinalUtterance((t) => got.push(t));
    mod.__simulateUtterance('hello world');
    unsub();
    expect(got).toEqual(['hello world']);
    expect(mod.getVoiceState().lastTranscript).toBe('hello world');
    expect(mod.getVoiceState().awaitingResponse).toBe(true);
  });

  it('unsubscribed listeners stop receiving utterances', async () => {
    const mod = await loadVoiceMode();
    const got: string[] = [];
    const unsub = mod.onFinalUtterance((t) => got.push(t));
    unsub();
    mod.__simulateUtterance('ignored');
    expect(got).toEqual([]);
  });
});

// voice-convergence-additive-wins-2026-07-10 P-001: both transport paths relay
// the transcript into the pane through ONE uniform, source-tagged seam. The
// tag is additive — a legacy 1-arg listener is unaffected — so this is a pure
// observability win with no dispatch change.
describe('transcriptSource seam (P-001)', () => {
  it('tags local-engine utterances localWhisper (the default arm)', async () => {
    const mod = await loadVoiceMode();
    const got: Array<[string, string | undefined]> = [];
    const unsub = mod.onFinalUtterance((t, src) => got.push([t, src]));
    mod.__simulateUtterance('what is the build status');
    unsub();
    expect(got).toEqual([['what is the build status', 'localWhisper']]);
  });

  it('tags provider-engine utterances providerSTT through the same seam', async () => {
    const mod = await loadVoiceMode();
    const got: Array<[string, string | undefined]> = [];
    const unsub = mod.onFinalUtterance((t, src) => got.push([t, src]));
    mod.__simulateUtterance('deploy the operator', 'providerSTT');
    unsub();
    expect(got).toEqual([['deploy the operator', 'providerSTT']]);
  });

  it('is backward-compatible: a 1-arg listener still receives the text', async () => {
    const mod = await loadVoiceMode();
    const got: string[] = [];
    const unsub = mod.onFinalUtterance((t) => got.push(t));
    mod.__simulateUtterance('legacy listener', 'providerSTT');
    unsub();
    expect(got).toEqual(['legacy listener']);
  });

  it('delivers the tag to every subscribed listener', async () => {
    const mod = await loadVoiceMode();
    const a: Array<string | undefined> = [];
    const b: Array<string | undefined> = [];
    const unsubA = mod.onFinalUtterance((_t, src) => a.push(src));
    const unsubB = mod.onFinalUtterance((_t, src) => b.push(src));
    mod.__simulateUtterance('fan out', 'localWhisper');
    unsubA();
    unsubB();
    expect(a).toEqual(['localWhisper']);
    expect(b).toEqual(['localWhisper']);
  });
});

describe('speak / cancelAllSpeech queue', () => {
  it('force-speaks through the browser engine and cancelAllSpeech stops it', async () => {
    const mod = await loadVoiceMode();
    mod.speak('hello there', 'system:operator', 'polite', { force: true });
    expect((globalThis as any).window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    mod.cancelAllSpeech();
    expect((globalThis as any).window.speechSynthesis.cancel).toHaveBeenCalled();
  });

  it('does not speak when voice mode is off and force is not set', async () => {
    const mod = await loadVoiceMode();
    mod.speak('quiet', 'system:operator'); // mode off, no force → gated out
    expect((globalThis as any).window.speechSynthesis.speak).not.toHaveBeenCalled();
  });
});

describe('setVoiceMode', () => {
  it('off clears mode + status', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    expect(mod.getVoiceState().mode).toBe('always-on');
    mod.setVoiceMode('off');
    expect(mod.getVoiceState().mode).toBe('off');
    expect(mod.getVoiceState().status).toBe('off');
  });

  it('push-to-talk goes straight to idle — never the stuck "connecting" state', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('push-to-talk');
    expect(mod.getVoiceState().mode).toBe('push-to-talk');
    // PTT has no session to connect to — it must be ready immediately so the
    // button shows "PUSH TT", not a permanent "Connecting…".
    expect(mod.getVoiceState().status).toBe('idle');
    expect(mod.getVoiceState().micOwnedByFullAgent).toBe(false);
  });

  it('always-on enters the optimistic connecting state on toggle', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    // Synchronously optimistic (a watchdog + non-leader/no-engine resets
    // guarantee it resolves; here fetch is mocked-rejecting so it would fall
    // back asynchronously).
    expect(mod.getVoiceState().status).toBe('connecting');
    expect(mod.getVoiceState().micOwnedByFullAgent).toBe(true);
  });
});

describe('shouldSkipVoicemodeWhisperOnThisRuntime', () => {
  const WEBKIT_UA = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

  function setRuntime(opts: { ua: string; tauri: boolean; coi: boolean }) {
    const g = globalThis as any;
    Object.defineProperty(g, 'navigator', { value: { userAgent: opts.ua }, configurable: true });
    g.self = g;
    g.crossOriginIsolated = opts.coi;
    if (opts.tauri) g.window.__TAURI_INTERNALS__ = {};
    else delete g.window.__TAURI_INTERNALS__;
  }

  it('returns true only on Tauri WebKitGTK without crossOriginIsolated', async () => {
    const mod = await import('./voice-mode');
    setRuntime({ ua: WEBKIT_UA, tauri: true, coi: false });
    expect(mod.shouldSkipVoicemodeWhisperOnThisRuntime()).toBe(true);
  });

  it('returns false when crossOriginIsolated is enabled (Whisper threading works)', async () => {
    const mod = await import('./voice-mode');
    setRuntime({ ua: WEBKIT_UA, tauri: true, coi: true });
    expect(mod.shouldSkipVoicemodeWhisperOnThisRuntime()).toBe(false);
  });

  it('returns false in a Chromium webview even inside Tauri', async () => {
    const mod = await import('./voice-mode');
    setRuntime({ ua: CHROME_UA, tauri: true, coi: false });
    expect(mod.shouldSkipVoicemodeWhisperOnThisRuntime()).toBe(false);
  });

  it('returns false outside Tauri (plain browser)', async () => {
    const mod = await import('./voice-mode');
    setRuntime({ ua: WEBKIT_UA, tauri: false, coi: false });
    expect(mod.shouldSkipVoicemodeWhisperOnThisRuntime()).toBe(false);
  });

  // P-008 (voice-production-test-coverage): the isWebKit check excludes
  // Chromium-engine UAs via /(Chrome|Chromium|Edg)\//. Cover the Edge and
  // Chromium alternation branches the Chrome case above doesn't exercise — a
  // Chromium-based webview inside Tauri must NOT be treated as WebKitGTK.
  const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Edg/120.0';
  const CHROMIUM_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/120.0 Safari/537.36';

  it('returns false for an Edge (Chromium) webview inside Tauri', async () => {
    const mod = await import('./voice-mode');
    setRuntime({ ua: EDGE_UA, tauri: true, coi: false });
    expect(mod.shouldSkipVoicemodeWhisperOnThisRuntime()).toBe(false);
  });

  it('returns false for a Chromium-branded webview inside Tauri', async () => {
    const mod = await import('./voice-mode');
    setRuntime({ ua: CHROMIUM_UA, tauri: true, coi: false });
    expect(mod.shouldSkipVoicemodeWhisperOnThisRuntime()).toBe(false);
  });
});

// P-011 (voice-production-test-coverage): barge-in. cancelAllSpeech() is the
// interruption primitive (wired to wake/utterance via activateListening, and
// to mode-off). The existing speak/cancel test only checks cancel() fired;
// these cover the user-facing semantics — return-to-idle, queue-clear (no
// overlap), mode-off stop, and clean resume.
describe('barge-in (TTS interruption)', () => {
  const synth = () => (globalThis as { window: { speechSynthesis: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } } }).window.speechSynthesis;

  it('cancel while speaking returns to idle and clears the speaking role', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    mod.speak('a long operator utterance', 'system:operator', 'polite', { force: true });
    expect(mod.getVoiceState().status).toBe('speaking');
    expect(mod.getVoiceState().speakingRole).toBe('system:operator');
    mod.cancelAllSpeech();
    expect(synth().cancel).toHaveBeenCalled();
    expect(mod.getVoiceState().status).toBe('idle');
    expect(mod.getVoiceState().speakingRole).toBeNull();
  });

  it('clears the queue so a pending utterance never plays (no overlap)', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    mod.speak('first', 'system:operator', 'polite', { force: true }); // plays now
    mod.speak('second', 'system:operator', 'polite', { force: true }); // queued behind first
    expect(synth().speak).toHaveBeenCalledTimes(1);
    const firstUtt = synth().speak.mock.calls[0][0] as { onend?: () => void };
    mod.cancelAllSpeech(); // barge-in clears the queue
    // the first utterance "ending" must NOT pull the (cleared) second off the queue
    firstUtt.onend?.();
    expect(synth().speak).toHaveBeenCalledTimes(1);
    expect(mod.getVoiceState().status).toBe('idle');
  });

  it('turning voice mode off stops in-progress speech', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    mod.speak('mid-sentence', 'system:operator', 'polite', { force: true });
    synth().cancel.mockClear();
    mod.setVoiceMode('off');
    expect(synth().cancel).toHaveBeenCalled();
    expect(mod.getVoiceState().status).toBe('off');
  });

  it('a fresh utterance speaks again after a barge-in (capture resumes)', async () => {
    // This assertion observes the browser SpeechSynthesis adapter directly.
    // Voice prefs now hydrate through the shared sync bridge and default to
    // Kokoro, so pin the browser engine explicitly instead of relying on the
    // old fetch-cache's first-call fallback.
    const prefs = await import('./voice-prefs-client');
    prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'browser' });
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    mod.speak('first', 'system:operator', 'polite', { force: true });
    mod.cancelAllSpeech();
    mod.speak('second after barge-in', 'system:operator', 'polite', { force: true });
    expect(synth().speak).toHaveBeenCalledTimes(2);
    expect(mod.getVoiceState().status).toBe('speaking');
  });
});
