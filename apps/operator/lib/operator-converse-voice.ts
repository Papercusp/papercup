/**
 * Voice-side bridge between the realtime/Conv-AI session and the
 * operator-conversation tag dispatcher.
 *
 * The voice agent (EL Conv AI / OpenAI Realtime / Gemini Live) emits
 * assistant text events as it speaks. When the operator is in active
 * mode, those utterances will contain the same <say>/<set_mode>/<sleep>
 * tags the text-path /api/agent-mcp/operator-converse route emits — same
 * prompt, same wire shape. This module:
 *
 *   1. Buffers incremental text events into utterance boundaries.
 *   2. Parses each completed utterance for tags via the shared
 *      parseOperatorTurn().
 *   3. Dispatches the side effects (mode flip, sleep timer) through
 *      the same sessionStorage hooks the text path uses, so a
 *      <set_mode>passive</set_mode> from voice flips the navbar
 *      toggle in lockstep with a <set_mode> from text.
 *
 * Buffering rule: an "utterance" is the assistant's text from the last
 * silence to the next. The voice engines fire onAssistantText with
 * incremental chunks and (sometimes) a final chunk. We treat any flush
 * (caller-driven or 1.2s of no chunks) as a boundary and parse what we
 * have. If parsing finds no tags the utterance is just spoken voice
 * with no side effects; we drop it silently.
 *
 * Importantly: <say> content already passes through TTS via the agent
 * itself. We do NOT re-render <say> here — that would double-render
 * the line. We only honor <set_mode> + <sleep> for side effects.
 */

import {
  parseOperatorTurn,
  sleepTagToEpochMs,
  writeOperatorModeToSession,
  writeSleepUntilMs,
} from './operator-converse-tags';

const FLUSH_MS = 1200;

export interface OperatorVoiceTagObserver {
  /** Feed an incremental assistant-text chunk from the engine. */
  push(text: string): void;
  /** Force-flush + parse the buffered utterance now. */
  flush(): void;
  /** Tear down the auto-flush timer. Call on session disconnect. */
  dispose(): void;
}

/**
 * Create a buffered tag observer. Independent of any specific engine —
 * voice-mode.ts wires this into elevenlabs-conv / openai-realtime /
 * etc. via the existing onAssistantText callback.
 */
export function createOperatorVoiceTagObserver(): OperatorVoiceTagObserver {
  let buf = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!buf.trim()) {
      buf = '';
      return;
    }
    const parsed = parseOperatorTurn(buf);
    buf = '';

    // We do NOT honor parsed.say here — the voice agent has already
    // spoken it via TTS. Re-rendering would double-up.

    if (parsed.sleep) {
      writeSleepUntilMs(sleepTagToEpochMs(parsed.sleep));
    }

    if (parsed.setMode) {
      writeOperatorModeToSession(parsed.setMode);
      try {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('papercusp:operatorMode', { detail: { mode: parsed.setMode } }),
          );
        }
      } catch { /* ignore */ }
    }
  };

  const push = (text: string) => {
    if (!text) return;
    buf += text;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_MS);
  };

  const dispose = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    buf = '';
  };

  return { push, flush, dispose };
}
