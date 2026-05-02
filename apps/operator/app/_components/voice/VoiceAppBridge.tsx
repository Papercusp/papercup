'use client';

/**
 * Voice → Oracle bridge for app-level voice mode.
 *
 * When voice mode is enabled and the Operator panel is closed, user
 * utterances should drive the rest of the app (per spec: "If voice mode
 * is enabled at the app level the user should be able to direct the
 * whole app via voice"). The Oracle is the existing reactive concierge
 * with UI-routing tools (navigate, listHarnesses, dispatchToAgent, etc.).
 *
 * This bridge:
 *   - Subscribes to voice utterances when voice mode is on.
 *   - Routes them to Oracle (POST /api/oracle/chat) when no other voice
 *     consumer (Operator panel) is in focus.
 *   - Speaks Oracle's text deltas via TTS using the `system:oracle` voice.
 *
 * The Operator panel pre-empts this bridge when it's open — utterances
 * go to Operator's scan loop instead. Coordination is via the
 * `voiceConsumers` set: the bridge only routes when no Operator-style
 * consumer is registered.
 */

import { useEffect, useRef } from 'react';
import {
  onFinalUtterance,
  speak,
  subscribeVoiceState,
  cancelAllSpeech,
  type VoiceState,
} from './voice-mode';

const consumers = new Set<string>();
let consumerListeners = new Set<() => void>();

/**
 * Register a higher-priority voice consumer (e.g. the Operator panel
 * when open). While any consumer is registered, the app-level bridge
 * suppresses its routing to Oracle. Returns a deregister function.
 */
export function registerVoiceConsumer(name: string): () => void {
  consumers.add(name);
  consumerListeners.forEach((l) => l());
  return () => {
    consumers.delete(name);
    consumerListeners.forEach((l) => l());
  };
}

function hasHigherPriorityConsumer(): boolean {
  return consumers.size > 0;
}

export function VoiceAppBridge(): null {
  const voiceStateRef = useRef<VoiceState>({
    mode: 'off',
    status: 'off',
    supported: false,
    lastTranscript: '',
    speakingRole: null,
  });
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubState = subscribeVoiceState((s) => {
      voiceStateRef.current = s;
    });

    const unsubUtterance = onFinalUtterance(async (text) => {
      // Skip if voice mode is off, or another consumer is in priority.
      if (voiceStateRef.current.mode === 'off') return;
      if (hasHigherPriorityConsumer()) return;
      if (!text || text.trim().length < 2) return;

      // Lazy-init session id (Oracle expects a stable session per dock).
      if (!sessionIdRef.current) {
        sessionIdRef.current = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }

      // POST to Oracle's chat endpoint, stream the response, speak deltas.
      try {
        const r = await fetch('/api/oracle/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            message: text,
          }),
        });
        if (!r.ok || !r.body) return;
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let speakBuffer = '';
        const SPEAK_FLUSH_THRESHOLD = 80; // chars
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const evt of events) {
            const lines = evt.split('\n');
            const eventLine = lines.find((l) => l.startsWith('event:'));
            const dataLine = lines.find((l) => l.startsWith('data:'));
            if (!eventLine || !dataLine) continue;
            const eventName = eventLine.slice(6).trim();
            const dataStr = dataLine.slice(5).trim();
            if (eventName === 'delta') {
              try {
                const { text: chunk } = JSON.parse(dataStr) as { text: string };
                speakBuffer += chunk;
                // Flush at sentence boundaries or threshold.
                const flushIdx = Math.max(
                  speakBuffer.lastIndexOf('. '),
                  speakBuffer.lastIndexOf('! '),
                  speakBuffer.lastIndexOf('? '),
                );
                if (flushIdx > 0 || speakBuffer.length > SPEAK_FLUSH_THRESHOLD) {
                  const cut = flushIdx > 0 ? flushIdx + 2 : speakBuffer.length;
                  const toSpeak = speakBuffer.slice(0, cut).trim();
                  speakBuffer = speakBuffer.slice(cut);
                  if (toSpeak) speak(toSpeak, 'system:oracle');
                }
              } catch {
                /* ignore */
              }
            } else if (eventName === 'done') {
              if (speakBuffer.trim()) {
                speak(speakBuffer.trim(), 'system:oracle');
                speakBuffer = '';
              }
            }
          }
        }
      } catch {
        /* network error; user can retry by speaking again */
      }
    });

    return () => {
      unsubState();
      unsubUtterance();
      cancelAllSpeech();
    };
  }, []);

  return null;
}
