/**
 * @vitest-environment jsdom
 *
 * Component tests for the voice toggle button. Covers the interaction
 * logic that has no other coverage:
 *   - push-to-talk hold threshold (a quick tap cycles mode; a sustained
 *     hold engages PTT)
 *   - keyboard PTT (Backquote) with the editable-target + modifier guards
 *   - the "no audio" voiceTimeout toast wiring its "Mic permissions"
 *     action to the setup-wizard OS-permissions deep link
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  startPushToTalk: vi.fn(),
  stopPushToTalk: vi.fn(),
  setVoiceMode: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  navigateClient: vi.fn(),
  state: {
    mode: 'off', status: 'off', supported: true,
    hasWebSpeechSTT: true, hasWebSpeechTTS: true,
    lastTranscript: '', speakingRole: null, wakeDetected: false, userSpoke: false,
    micOwnedByFullAgent: false, audioReceiving: false,
    processingTranscript: false, awaitingResponse: false,
  } as Record<string, unknown>,
}));

vi.mock('./voice-mode', () => ({
  getVoiceConfig: () => ({ wakeWord: 'hey papercup' }),
  getVoiceState: () => h.state,
  initVoiceMode: vi.fn(),
  setAudioReceiving: vi.fn(),
  setMicCaptureError: vi.fn(),
  setVoiceMode: h.setVoiceMode,
  startPushToTalk: h.startPushToTalk,
  stopPushToTalk: h.stopPushToTalk,
  subscribeVoiceState: (cb: (s: unknown) => void) => { cb(h.state); return () => {}; },
}));
vi.mock('./useMicLevel', () => ({ useMicLevel: () => ({ ref: { current: null } }) }));
vi.mock('sonner', () => ({ toast: { error: h.toastError, warning: h.toastWarning } }));
vi.mock('@papercusp/operator-core/lib/client-navigation', () => ({ navigateClient: h.navigateClient }));
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({ wsLocalKey: (k: string) => k, getBrowserWorkspaceId: () => 'default' }));
vi.mock('../../harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));

import { VoiceButton } from './VoiceButton';

const PTT_HOLD_MS = 250;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.state.mode = 'off';
  h.state.status = 'off';
  h.state.supported = true;
  h.state.audioReceiving = false;
  h.state.processingTranscript = false;
  h.state.awaitingResponse = false;
  // jsdom's localStorage is shadowed by Node's broken `--localstorage-file`
  // built-in in this runner; install a working in-memory one.
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderButton() {
  render(<VoiceButton />);
  return screen.getByRole('button', { name: /voice mode/i });
}

describe('VoiceButton — push-to-talk hold threshold', () => {
  it('engages PTT after a sustained hold (>250ms)', () => {
    const btn = renderButton();
    fireEvent.mouseDown(btn);
    act(() => { vi.advanceTimersByTime(PTT_HOLD_MS + 10); });
    expect(h.startPushToTalk).toHaveBeenCalledTimes(1);
  });

  it('treats a quick tap as a mode-cycle, not PTT', () => {
    const btn = renderButton();
    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);   // releases before the 250ms threshold
    fireEvent.click(btn);
    expect(h.startPushToTalk).not.toHaveBeenCalled();
    expect(h.setVoiceMode).toHaveBeenCalledWith('push-to-talk'); // off → push-to-talk
  });
});

describe('VoiceButton — keyboard PTT (Backquote)', () => {
  it('starts on keydown and stops on keyup', () => {
    renderButton();
    fireEvent.keyDown(window, { code: 'Backquote' });
    expect(h.startPushToTalk).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(window, { code: 'Backquote' });
    expect(h.stopPushToTalk).toHaveBeenCalledTimes(1);
  });

  it('reserves the backtick for PTT even inside a normal text input (swallows the char)', () => {
    renderButton();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const notPrevented = fireEvent.keyDown(input, { code: 'Backquote' });
    expect(h.startPushToTalk).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false); // preventDefault ran → no literal backtick typed
    input.remove();
  });

  it('does NOT hijack the backtick inside a code editor / terminal (literal needed)', () => {
    renderButton();
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const inner = document.createElement('span');
    editor.appendChild(inner);
    document.body.appendChild(editor);
    const notPrevented = fireEvent.keyDown(inner, { code: 'Backquote' });
    expect(h.startPushToTalk).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true); // not prevented → backtick types normally
    editor.remove();
  });

  it('ignores the shortcut when a modifier is held', () => {
    renderButton();
    fireEvent.keyDown(window, { code: 'Backquote', metaKey: true });
    expect(h.startPushToTalk).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    renderButton();
    fireEvent.keyDown(window, { code: 'KeyA' });
    expect(h.startPushToTalk).not.toHaveBeenCalled();
  });
});

describe('VoiceButton — compact status display', () => {
  it('shows the short "Off" label when off', () => {
    h.state.mode = 'off'; h.state.status = 'off';
    renderButton();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.queryByText(/mic off/i)).toBeNull();
  });

  it('shows the short "On" label in always-on idle', () => {
    h.state.mode = 'always-on'; h.state.status = 'idle';
    renderButton();
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.queryByText(/always-on/i)).toBeNull();
  });

  it('shows a spinner (no "connecting" word) while connecting', () => {
    h.state.mode = 'always-on'; h.state.status = 'connecting';
    renderButton();
    expect(screen.getByRole('status', { name: 'Connecting' })).toBeTruthy();
    expect(screen.queryByText(/connecting/i)).toBeNull();
  });

  it('shows the listening equalizer (no word) while the mic is hearing voice', () => {
    h.state.mode = 'always-on'; h.state.status = 'idle'; h.state.audioReceiving = true;
    renderButton();
    expect(screen.getByRole('status', { name: 'Hearing you' })).toBeTruthy();
    expect(screen.queryByText(/listening|hearing/i)).toBeNull();
  });

  it('shows a speaker glyph (no word) while the agent is speaking', () => {
    h.state.status = 'speaking';
    renderButton();
    expect(screen.getByRole('status', { name: 'Speaking' })).toBeTruthy();
    expect(screen.queryByText(/speaking/i)).toBeNull();
  });

  it('shows a thinking glyph (no word) while awaiting the response', () => {
    h.state.status = 'idle'; h.state.awaitingResponse = true;
    renderButton();
    expect(screen.getByRole('status', { name: 'Thinking' })).toBeTruthy();
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });
});

describe('VoiceButton — voiceTimeout toast', () => {
  function fireTimeout(detail: { phase: string; message: string }) {
    act(() => {
      window.dispatchEvent(new CustomEvent('papercusp:voiceTimeout', { detail }));
    });
  }

  it('shows an error toast linking to the mic-permissions page on no-audio', () => {
    renderButton();
    fireTimeout({ phase: 'no-audio', message: 'No audio detected — check your microphone and try again.' });

    expect(h.toastError).toHaveBeenCalledTimes(1);
    const [message, opts] = h.toastError.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(message).toContain('No audio detected');
    expect(opts.action.label).toBe('Mic permissions');

    opts.action.onClick();
    expect(h.navigateClient).toHaveBeenCalledWith('/settings/setup-wizard?step=os-permissions');
  });

  it('uses a plain warning toast for non-no-audio phase stalls', () => {
    renderButton();
    fireTimeout({ phase: 'transcript', message: 'No transcript received — try speaking again.' });
    expect(h.toastWarning).toHaveBeenCalledTimes(1);
    expect(h.toastError).not.toHaveBeenCalled();
  });
});
