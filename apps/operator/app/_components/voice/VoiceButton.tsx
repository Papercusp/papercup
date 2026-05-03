'use client';

/**
 * Voice mode toggle button. Lives in the chrome header next to Operator.
 *
 * Click cycles: off → push-to-talk → always-on → off.
 * Long-press while in push-to-talk holds the mic open.
 */

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  initVoiceMode,
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
  const [pttHeld, setPttHeld] = useState(false);

  useEffect(() => {
    initVoiceMode();
    const unsub = subscribeVoiceState(setVs);
    return unsub;
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

  // Live mic level — only sample when the mic is actually open. Always-on
  // continuously listens (so we sample any time mode is always-on); PTT
  // only listens while held. `listening` status covers both.
  const micActive =
    vs.mode === 'always-on' ||
    vs.status === 'listening' ||
    pttHeld;
  const micLevel = useMicLevel(micActive);

  const labelText = vs.supported ? MODE_LABEL[vs.mode] : 'No mic';
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
      className={`pc-voice-btn pc-voice-btn--mode-${vs.mode} pc-voice-btn--status-${vs.status}${pttHeld ? ' is-held' : ''}${vs.supported ? '' : ' is-unsupported'}${micActive ? ' is-mic-active' : ''}`}
      style={{ ['--mic-level' as any]: micLevel.toFixed(3) }}
    >
      <span className="pc-voice-btn-orb" aria-hidden="true">
        <span className="pc-voice-btn-level" aria-hidden="true" />
        <span className="pc-voice-btn-icon">{ICON[vs.status]}</span>
      </span>
      <span className="pc-voice-btn-label">{labelText}</span>
    </button>
  );
}
