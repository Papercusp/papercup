'use client';

/**
 * Voice mode toggle button. Lives in the chrome header next to Operator.
 *
 * Click cycles: off → push-to-talk → always-on → off.
 * Long-press while in push-to-talk holds the mic open.
 */

import { useEffect, useState, useCallback } from 'react';
import { Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  getVoiceConfig,
  initVoiceMode,
  setVoiceMode,
  startPushToTalk,
  stopPushToTalk,
  subscribeVoiceState,
  type VoiceState,
  type VoiceMode,
} from './voice-mode';
import { useMicLevel } from './useMicLevel';
import { usePathname } from 'next/navigation';

const ICON: Record<VoiceState['status'], string> = {
  off: '🚫',
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
  'push-to-talk': 'PTT',
  'always-on': 'Always-on',
};

export function VoiceButton(): JSX.Element {
  const [vs, setVs] = useState<VoiceState>({
    mode: 'off',
    status: 'off',
    supported: false,
    lastTranscript: '',
    speakingRole: null,
  });
  const [wakeWord, setWakeWord] = useState(() => getVoiceConfig().wakeWord);
  const [pttHeld, setPttHeld] = useState(false);

  useEffect(() => {
    initVoiceMode();
    const unsub = subscribeVoiceState(setVs);
    return unsub;
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


  const onClick = useCallback(() => {
    if (!vs.supported) {
      toast.error('Voice mode is not available in this environment.');
      return;
    }
    setVoiceMode(NEXT_MODE[vs.mode]);
  }, [vs.mode, vs.supported]);

  const onPttDown = useCallback(() => {
    if (!vs.hasWebSpeechSTT || vs.mode !== 'push-to-talk') return;
    setPttHeld(true);
    startPushToTalk();
  }, [vs.mode, vs.hasWebSpeechSTT]);

  const onPttUp = useCallback(() => {
    if (!pttHeld) return;
    setPttHeld(false);
    stopPushToTalk();
  }, [pttHeld]);

  // Live mic level — only sample when the mic is actually open AND we're
  // on a route where the visual is worth the CPU. Skip on /settings/* so
  // the settings UI stays responsive (the actual STT VAD is already
  // running another analyser on the same mic when always-on is enabled).
  const pathname = usePathname();
  const onSettingsRoute = pathname?.startsWith('/settings') ?? false;
  const micActive =
    !onSettingsRoute &&
    (vs.mode === 'always-on' || vs.status === 'listening' || pttHeld);
  const { ref: micRef } = useMicLevel(micActive);

  const labelText = vs.supported ? MODE_LABEL[vs.mode] : 'No mic';
  const title = vs.supported
    ? `Voice mode: ${MODE_LABEL[vs.mode]} (click to cycle, hold for PTT)`
    : 'Voice mode unsupported in this browser';
  const showWakeHint = vs.mode === 'always-on' && vs.supported;

  return (
    <div className={`pc-voice-control${showWakeHint ? ' has-wake-hint' : ''}`}>
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
        className={`pc-voice-btn pc-voice-btn--mode-${vs.mode} pc-voice-btn--status-${vs.status}${pttHeld ? ' is-held' : ''}${vs.supported ? '' : ' is-unsupported'}${micActive ? ' is-mic-active' : ''}`}
      >
        <span className="pc-voice-btn-orb" aria-hidden="true">
          <span className="pc-voice-btn-level" aria-hidden="true" />
          <span className="pc-voice-btn-icon">{ICON[vs.status]}</span>
        </span>
        <span className="pc-voice-btn-label">{labelText}</span>
      </button>
      <a
        href="/settings/voice"
        className="pc-voice-settings-link"
        aria-label="Microphone settings"
        title="Open microphone settings"
      >
        <Settings2 size={14} aria-hidden="true" />
        <span className="pc-voice-settings-text">Voice</span>
      </a>
      {showWakeHint && (
        <div className="pc-voice-wake-hint" aria-live="polite">
          Say <strong>{wakeWord}</strong>
        </div>
      )}
    </div>
  );
}
