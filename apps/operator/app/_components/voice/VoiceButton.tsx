'use client';

/**
 * Voice mode toggle button. Lives in the chrome header next to Operator.
 *
 * Click cycles: off → push-to-talk → always-on → off.
 * Long-press while in push-to-talk holds the mic open.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  initVoiceMode,
  setVoiceMode,
  startPushToTalk,
  stopPushToTalk,
  subscribeVoiceState,
  type VoiceState,
  type VoiceMode,
} from './voice-mode';

const ICON: Record<VoiceState['status'], string> = {
  off: '🎤',
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
  'off': 'Voice off',
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
  const [pttHeld, setPttHeld] = useState(false);

  useEffect(() => {
    initVoiceMode();
    const unsub = subscribeVoiceState(setVs);
    return unsub;
  }, []);

  const onClick = useCallback(() => {
    if (!vs.supported) {
      // eslint-disable-next-line no-alert
      alert('Voice mode is not available in this environment.');
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

  const showLabel = vs.mode !== 'off' || vs.status === 'speaking';
  const title = vs.supported
    ? `Voice mode: ${MODE_LABEL[vs.mode]} (click to cycle, hold for PTT)`
    : 'Voice mode unsupported in this browser';

  return (
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
      style={{
        marginLeft: 8,
        padding: '4px 10px',
        background: vs.status === 'listening' ? 'rgba(255,0,0,0.1)'
          : vs.status === 'speaking' ? 'rgba(0,128,255,0.1)'
          : 'transparent',
        border: '1px solid rgba(0,0,0,0.15)',
        borderRadius: 6,
        cursor: vs.supported ? 'pointer' : 'not-allowed',
        opacity: vs.supported ? 1 : 0.5,
        fontSize: 13,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span style={{ fontFamily: 'monospace' }}>{ICON[vs.status]}</span>
      {showLabel && <span style={{ fontSize: 11 }}>{MODE_LABEL[vs.mode]}</span>}
    </button>
  );
}
