'use client';

/**
 * Voice mode toggle button. Lives in the Operator chat sidebar header.
 *
 * Click cycles: off → push-to-talk → always-on → off.
 * Long-press while in push-to-talk holds the mic open.
 */

import { useEffect, useState, useCallback, useRef, type ReactElement } from 'react';
import { wsLocalKey } from '@/lib/browser-workspace';
import { Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip } from '../../harness/Tooltip';
import {
  getVoiceConfig,
  getVoiceState,
  initVoiceMode,
  setAudioReceiving,
  setVoiceMode,
  startPushToTalk,
  stopPushToTalk,
  subscribeVoiceState,
  type VoiceState,
  type VoiceMode,
} from './voice-mode';
import { useMicLevel } from './useMicLevel';

const ICON: Record<VoiceState['status'], string> = {
  off: '🚫',
  connecting: '⏳',
  idle: '🎤',
  listening: '🔴',
  speaking: '🔊',
  paused: '⏸',
};

const NEXT_MODE: Record<VoiceMode, VoiceMode> = {
  'off': 'push-to-talk',
  'push-to-talk': 'always-on',
  'always-on': 'off',
};

const MODE_LABEL: Record<VoiceMode, string> = {
  'off': 'Mic off',
  'push-to-talk': 'PUSH TT',
  'always-on': 'Always-on',
};

const WAKE_HINT_SEEN_KEY = 'pc-voice-wake-hint-seen-v1';
const PTT_HINT_SEEN_KEY = 'pc-voice-ptt-hint-seen-v1';
// Push-to-talk key. Backtick (`) is the right default for a coding-harness
// app: rarely typed in normal English/code outside template literals,
// easy to find by touch (top-left, below Escape), and doesn't conflict
// with editor shortcuts. V was a poor choice — it fires in any text
// input that isn't caught by `isEditableTarget`, and the global keydown
// listener only ran in push-to-talk *mode*, so users in always-on mode
// got a silent no-op instead of a temporary force-mic.
//
// `event.code === 'Backquote'` matches the physical key regardless of
// keyboard layout (US/UK/etc), which is more reliable than e.key.
const PTT_SHORTCUT_CODE = 'Backquote';
const PTT_SHORTCUT_LABEL = '`';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // contenteditable elements: any "true"/"" value, plus inherited via [contenteditable=inherit]
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return !!target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor, .monaco-editor, .xterm, .xterm-screen',
  );
}

export function VoiceButton(): ReactElement {
  const [vs, setVs] = useState<VoiceState>(() => getVoiceState());
  const [wakeWord, setWakeWord] = useState(() => getVoiceConfig().wakeWord);
  const [wakeHintSeen, setWakeHintSeen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(wsLocalKey(WAKE_HINT_SEEN_KEY)) === '1';
  });
  const [pttHintSeen, setPttHintSeen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(wsLocalKey(PTT_HINT_SEEN_KEY)) === '1';
  });
  const [pttHeld, setPttHeld] = useState(false);

  useEffect(() => {
    initVoiceMode();
    const unsub = subscribeVoiceState(setVs);
    return unsub;
  }, []);

  // Surface phase-stall failures as toasts so the user can tell a
  // silent error apart from "still working." Wired via window event
  // from voice-mode.ts where the per-phase timers fire.
  useEffect(() => {
    const onTimeout = (e: Event) => {
      const detail = (e as CustomEvent<{ phase: string; message: string }>).detail;
      if (!detail?.message) return;
      const isError = detail.phase === 'no-audio';
      (isError ? toast.error : toast.warning)(detail.message);
    };
    window.addEventListener('papercusp:voiceTimeout', onTimeout as EventListener);
    return () => window.removeEventListener('papercusp:voiceTimeout', onTimeout as EventListener);
  }, []);

  useEffect(() => {
    const syncWakeWord = () => setWakeWord(getVoiceConfig().wakeWord);
    syncWakeWord();
    window.addEventListener('pc-voice-config-changed', syncWakeWord);
    window.addEventListener('focus', syncWakeWord);
    return () => {
      window.removeEventListener('pc-voice-config-changed', syncWakeWord);
      window.removeEventListener('focus', syncWakeWord);
    };
  }, []);

  const markWakeHintSeen = useCallback(() => {
    if (wakeHintSeen) return;
    setWakeHintSeen(true);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(wsLocalKey(WAKE_HINT_SEEN_KEY), '1');
      } catch {
        /* ignore storage issues */
      }
    }
  }, [wakeHintSeen]);

  const markPttHintSeen = useCallback(() => {
    if (pttHintSeen) return;
    setPttHintSeen(true);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(wsLocalKey(PTT_HINT_SEEN_KEY), '1');
      } catch {
        /* ignore storage issues */
      }
    }
  }, [pttHintSeen]);

  const onClick = useCallback(() => {
    if (!vs.supported) {
      toast.error('Voice mode is not available in this environment.');
      return;
    }
    if (vs.mode === 'always-on') markWakeHintSeen();
    setVoiceMode(NEXT_MODE[vs.mode]);
  }, [markWakeHintSeen, vs.mode, vs.supported]);

  // Hold-detection threshold: a regular click (mousedown→mouseup within
  // ~250ms) is treated as a mode-cycle click only — onClick handles it.
  // Only sustained holds engage push-to-talk. Without this, every click
  // simultaneously fired startPushToTalk (loading MicVAD/Whisper) AND
  // setVoiceMode (loading EL/Realtime), and the two competed for the
  // mic — leaving EL's published track silent and the agent unable to
  // hear anything.
  const pttHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPttDown = useCallback(() => {
    if (!vs.supported) return;
    if (pttHoldTimerRef.current) clearTimeout(pttHoldTimerRef.current);
    pttHoldTimerRef.current = setTimeout(() => {
      pttHoldTimerRef.current = null;
      setPttHeld(true);
      startPushToTalk();
    }, 250);
  }, [vs.supported]);

  const onPttUp = useCallback(() => {
    // Held shorter than the threshold? Cancel the pending PTT start so
    // the click semantics (mode-cycle via onClick) are the only effect.
    if (pttHoldTimerRef.current) {
      clearTimeout(pttHoldTimerRef.current);
      pttHoldTimerRef.current = null;
      return;
    }
    if (!pttHeld) return;
    setPttHeld(false);
    stopPushToTalk();
  }, [pttHeld]);

  // Hold-to-talk keyboard shortcut. Listener is mounted whenever voice
  // mode is "supported" (i.e. any voice path is viable), regardless of
  // current mode — holding the key in always-on mode acts as a force-
  // listen override; in off mode it temporarily activates the mic.
  // Previously the listener was gated on mode==='push-to-talk' which
  // made the key silently no-op in any other mode.
  useEffect(() => {
    if (!vs.supported) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.code !== PTT_SHORTCUT_CODE) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      markPttHintSeen();
      if (pttHeld) return;
      setPttHeld(true);
      startPushToTalk();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== PTT_SHORTCUT_CODE) return;
      if (!pttHeld) return;
      e.preventDefault();
      setPttHeld(false);
      stopPushToTalk();
    };
    // Defensive: if the user releases the key while the window doesn't have
    // focus (alt-tab while held), keyup never fires. Treat blur as release.
    const onBlur = () => {
      if (!pttHeld) return;
      setPttHeld(false);
      stopPushToTalk();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [markPttHintSeen, pttHeld, vs.supported]);

  // Live mic level — sampled whenever the mic is open. 'micActive' is
  // the CSS-class signal ("mic is hot, please show feedback") and the
  // analyser is its own visualization-only stream.
  const micActive =
    vs.mode === 'always-on' || vs.status === 'listening' || pttHeld;
  // Run the visualization analyser during PTT regardless of who owns
  // the mic. The previous "skip when micOwnedByFullAgent" rule was a
  // belt-and-suspenders guard against a Chrome-specific WebRTC issue
  // (two getUserMedia consumers contending). The cost of suppressing
  // it was: PTT users in always-on agent mode (EL Conv AI / Realtime)
  // got zero feedback — "I pressed the button, spoke, nothing
  // happened." For brief PTT holds (typical: 1-3s) the contention
  // risk is acceptable; for sustained always-on we keep the old
  // guard. Connecting still skipped — analyser nodes during ICE
  // negotiation can interleave audio init badly.
  const analyserActive =
    (pttHeld || (micActive && !vs.micOwnedByFullAgent)) &&
    vs.status !== 'connecting';
  const { ref: micRef } = useMicLevel(analyserActive, setAudioReceiving);

  // Phase-specific label so the user can tell apart the 5 visible
  // states. Order matters: speaking > awaiting > processing > pressed-
  // and-hearing > pressed-no-audio > connecting > default.
  let labelText: string;
  if (!vs.supported) labelText = 'No mic';
  else if (vs.status === 'speaking') labelText = 'Speaking';
  else if (vs.awaitingResponse) labelText = 'Thinking…';
  else if (vs.processingTranscript) labelText = 'Processing…';
  else if (pttHeld && vs.audioReceiving) labelText = 'Hearing you';
  else if (pttHeld) labelText = 'Listening…';
  else if (vs.status === 'connecting') labelText = 'Connecting…';
  else labelText = MODE_LABEL[vs.mode];
  const title = vs.status === 'connecting'
    ? 'Voice mode: connecting to agent (waiting for WebRTC negotiation)…'
    : vs.supported
    ? `Voice mode: ${MODE_LABEL[vs.mode]} (click to cycle, hold button for PTT, hold ${PTT_SHORTCUT_LABEL} for keyboard PTT)`
    : 'Voice mode unsupported in this browser';
  // The hint bubbles ("Say <wakeWord>" / "Hold ` to talk") are persistent
  // affordances — keep them visible whenever the matching mode is active.
  // The historical 'seen' localStorage flags are kept up-to-date so any
  // future opt-out toggle can read them, but they no longer gate render.
  const showConnectingHint = vs.status === 'connecting' && vs.supported;
  const showWakeHint = !showConnectingHint && vs.mode === 'always-on' && vs.supported;
  const showPttHint = !showConnectingHint && vs.mode === 'push-to-talk' && vs.supported;

  return (
    <div className={`pc-voice-control${showWakeHint || showPttHint || showConnectingHint ? ' has-wake-hint' : ''}${showConnectingHint ? ' is-connecting' : ''}`}>
      <button
        type="button"
        aria-label="Voice mode"
        title={title}
        onClick={onClick}
        onMouseDown={onPttDown}
        onMouseUp={onPttUp}
        onMouseLeave={onPttUp}
        onTouchStart={onPttDown}
        onTouchEnd={onPttUp}
        ref={micRef as React.RefObject<HTMLButtonElement>}
        className={`pc-voice-btn pc-voice-btn--mode-${vs.mode} pc-voice-btn--status-${vs.status}${pttHeld ? ' is-held' : ''}${vs.supported ? '' : ' is-unsupported'}${micActive ? ' is-mic-active' : ''}${vs.wakeDetected ? ' is-wake-detected' : ''}${vs.userSpoke ? ' is-user-spoke' : ''}${vs.audioReceiving ? ' is-receiving-audio' : ''}${vs.processingTranscript ? ' is-processing-transcript' : ''}${vs.awaitingResponse ? ' is-awaiting-response' : ''}`}
      >
        <span className="pc-voice-btn-orb" aria-hidden="true">
          <span className="pc-voice-btn-level" aria-hidden="true" />
          <span className="pc-voice-btn-icon">{ICON[vs.status]}</span>
        </span>
        <span className="pc-voice-btn-label">{labelText}</span>
      </button>
      <Tooltip label="Open microphone settings">
        <a
          href="/settings/voice"
          className="pc-voice-settings-link"
          aria-label="Microphone settings"
        >
          <Settings2 size={14} aria-hidden="true" />
          <span className="pc-voice-settings-text">Voice</span>
        </a>
      </Tooltip>
      {(showWakeHint || showPttHint || showConnectingHint) && (
        <div className="pc-voice-wake-hint" aria-live="polite">
          {showConnectingHint ? (
            <>Connecting<span className="pc-voice-wake-hint-dots" aria-hidden="true">…</span></>
          ) : showWakeHint ? (
            <>
              Say <strong>{wakeWord}</strong>
            </>
          ) : (
            <>
              Hold <strong>{PTT_SHORTCUT_LABEL}</strong> to talk
            </>
          )}
        </div>
      )}
    </div>
  );
}