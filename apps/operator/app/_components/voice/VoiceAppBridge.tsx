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

/**
 * Voice consumer priority registry (v4 §2b).
 *
 * Multiple chrome surfaces can claim utterances; the highest-priority
 * registered consumer wins. Oracle is the implicit lowest (no
 * registration needed — falls through when no consumer is registered).
 *
 * Priority order:
 *   panel-open               highest — the Operator panel is open
 *   background-toast         a 5s/8s undo toast is on-screen
 *   standing-approval-prompt (deferred per v4; reserved)
 *   oracle                   lowest, implicit
 */
export type VoiceConsumerPriority =
  | 'panel-open'
  | 'background-toast'
  | 'standing-approval-prompt';

const PRIORITY_RANK: Record<VoiceConsumerPriority, number> = {
  'panel-open': 100,
  'background-toast': 50,
  'standing-approval-prompt': 25,
};

interface Consumer {
  name: string;
  priority: VoiceConsumerPriority;
  /** Optional callback — when present, this consumer also handles the
   *  utterance directly (high-priority consumers like the toast cancel
   *  hook). When absent, the consumer's only effect is to suppress
   *  lower-priority routing. */
  onUtterance?: (text: string) => void;
}

const consumers: Map<string, Consumer> = new Map();
const consumerListeners = new Set<() => void>();

/**
 * Register a voice consumer. Defaults to `panel-open` priority for
 * back-compat with the original (name-only) signature.
 *
 * Returns a deregister function.
 */
export function registerVoiceConsumer(
  name: string,
  priority: VoiceConsumerPriority = 'panel-open',
  onUtterance?: (text: string) => void,
): () => void {
  consumers.set(name, { name, priority, onUtterance });
  consumerListeners.forEach((l) => l());
  return () => {
    consumers.delete(name);
    consumerListeners.forEach((l) => l());
  };
}

/** Highest-priority registered consumer, or null if none. */
function topConsumer(): Consumer | null {
  let best: Consumer | null = null;
  for (const c of consumers.values()) {
    if (!best || PRIORITY_RANK[c.priority] > PRIORITY_RANK[best.priority]) best = c;
  }
  return best;
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

  useEffect(() => {
    const unsubState = subscribeVoiceState((s) => {
      voiceStateRef.current = s;
    });

    const unsubUtterance = onFinalUtterance(async (text) => {
      // Skip if voice mode is off.
      if (voiceStateRef.current.mode === 'off') return;
      if (!text || text.trim().length < 2) return;

      // Skip intent parsing when a full-agent engine is in charge — EL
      // Conv AI / OpenAI Realtime already process intents via their own
      // LLM + tool calls. Firing parseOperatorIntent here would double-
      // dispatch (e.g. open the panel twice on "open the operator").
      // Test wake-word + other onFinalUtterance listeners still receive
      // the transcript; only the legacy intent path is bypassed.
      try {
        const { loadVoicePrefsClient } = await import('./voice-prefs-client');
        const prefs = loadVoicePrefsClient();
        if (prefs.fullAgentEngine && prefs.fullAgentEngine !== 'off') {
          throw new Error('full-agent in charge');
        }
        if (!prefs.wakeWordIntents) {
          // Skip intent parsing; fall through to consumer/Oracle routing.
          throw new Error('wake-word disabled');
        }
        const { parseOperatorIntent, resolveApprove } = await import('@papercusp/operator-core/lib/voice-intents');
        // Engine-agnostic wake-word strip: Voicemode/Deepgram deliver the
        // raw transcript ("hey papercup approve sheets") without going
        // through the Web Speech wake-word listener, so we re-prefix here
        // so parseOperatorIntent sees a parseable string. Web Speech path
        // already passes a normalized "operator …" string and is a no-op
        // through this helper.
        const { stripWakeWordAndPrefix } = await import('@papercusp/operator-core/lib/wake-word');
        const { getVoiceConfig } = await import('./voice-mode');
        const wakeWord = getVoiceConfig().wakeWord ?? 'hey papercup';
        const stripped = stripWakeWordAndPrefix(text, wakeWord);
        // Pulse the visual wake-detected indicator on the voice button
        // so the user sees a flash the moment we recognize the wake
        // word — even if the dispatch path errors below or the verb
        // doesn't parse. Same signal feeds Porcupine + openWakeWord.
        if (stripped.matched) {
          const { signalWakeDetected } = await import('./voice-mode');
          signalWakeDetected();
        }
        // Wake word with no verb → audible acknowledgement so the user
        // knows the engine heard them. They then need to say
        // "hey papercup <verb>" as a single utterance — there's no
        // separate listen-window like Siri.
        if (stripped.matched && !stripped.trailing) {
          const { speak } = await import('./voice-mode');
          speak('Say a command after the wake word, like "scan" or "approve sheets".', 'system:operator', 'polite');
          return;
        }
        const normalized = stripped.matched ? stripped.dispatchText : text;
        const intent = parseOperatorIntent(normalized);
        // No matching intent → tell the user, so silence isn't a black hole.
        if (stripped.matched && stripped.trailing && !intent) {
          const { speak } = await import('./voice-mode');
          speak(`I didn't recognize "${stripped.trailing}". Try scan, or approve followed by a harness name.`, 'system:operator', 'polite');
          return;
        }
        if (intent) {
          if (intent.kind === 'scan') {
            // D-005 (unify-agent-launches): a voice scan fires the `scan` launch
            // blueprint via the invoke route (loopback inside the desktop webview).
            // Findings land as work_items in the self-improvement backlog — the
            // operator-card panel is retired.
            const { speak } = await import('./voice-mode');
            void fetch('/api/harness/papercup/invoke?role=scanner', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                kickoff: intent.query
                  ? `Voice-requested workspace scan: ${intent.query}. Capture each finding via improvements:capture.`
                  : 'Voice-requested workspace scan. Capture each finding via improvements:capture.',
                extra: ['BLUEPRINT_ID=scan'],
                timeoutMs: 900_000,
              }),
            }).catch(() => { /* fire-and-forget — the cadence routine is the reliable path */ });
            speak('Started a workspace scan. Findings will land in the improvements backlog.', 'system:operator', 'polite');
            return;
          }
          if (intent.kind === 'approve') {
            // Fetch candidates + resolve.
            try {
              const r = await fetch('/api/agent-mcp/operator-standing-approvals');
              const body = await r.json();
              const result = resolveApprove(intent, body.candidates ?? []);
              const { speak } = await import('./voice-mode');
              if (result.action === 'approve' && result.capability) {
                await fetch('/api/agent-mcp/operator-standing-approvals', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    capability: result.capability,
                    targetHarness: result.targetSlug,
                    decision: 'approve',
                  }),
                });
                speak(`Approved ${result.capability.replace(':', ' ')} for ${result.targetSlug}.`, 'system:operator', 'polite');
              } else if (result.action === 'refuse-no-match') {
                speak(`No candidate matches ${result.targetSlug} that I've shown you yet. Open settings to review.`, 'system:operator', 'polite');
              } else if (result.action === 'refuse-ambiguous') {
                const opts = (result.options ?? []).map((o) => o.replace(':', ' ')).join(', or ');
                speak(`Multiple pending approvals for ${result.targetSlug}: ${opts}. Say operator approve ${result.targetSlug} followed by the capability.`, 'system:operator', 'polite');
              } else if (result.action === 'refuse-complex-cap') {
                speak(`That capability has a complex name. Please approve in operator settings.`, 'system:operator', 'polite');
              }
            } catch {
              /* network blip — settings UI is the fallback */
            }
            return;
          }
        }
      } catch {
        /* intent module not yet loaded — fall through to normal routing */
      }

      // Highest-priority consumer wins. If it has an `onUtterance`
      // handler (e.g. background-toast looking for "cancel"), let it
      // process the utterance and stop. If it has no handler (e.g.
      // panel-open consumer, which uses its own onFinalUtterance
      // subscription), still suppress Oracle routing.
      const top = topConsumer();
      if (top) {
        if (top.onUtterance) top.onUtterance(text);
        return;
      }
      if (hasHigherPriorityConsumer()) return;

      // POST to Oracle's chat endpoint, stream the response, speak deltas.
      // oracle:chat's ArgsSchema requires a `messages` array (min 1); the
      // voice bridge sends a single user turn per spoken utterance.
      try {
        const r = await fetch('/api/oracle/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: text }],
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
