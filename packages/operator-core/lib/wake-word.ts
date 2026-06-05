/**
 * Pure helper for the wake-word → intent re-prefix logic used by the
 * Web Speech wake-word listener.
 *
 * Wake word ≠ intent prefix. The user typically says "hey operator" as
 * the wake word, but `parseOperatorIntent` matches utterances starting
 * with "operator ". This helper strips the wake word and re-prefixes
 * "operator " so the intent parser sees a parseable string.
 */

export interface WakeStripResult {
  /** True when the transcript contained the wake word. */
  matched: boolean;
  /** Text to pass to onUtteranceFinal (already prefixed for parseOperatorIntent). */
  dispatchText: string;
  /** Trailing text after the wake word (no prefix added). */
  trailing: string;
}

export function stripWakeWordAndPrefix(
  transcript: string,
  wakeWord: string,
): WakeStripResult {
  const lower = transcript.toLowerCase();
  const wake = wakeWord.toLowerCase();
  const idx = lower.lastIndexOf(wake);
  if (idx < 0) return { matched: false, dispatchText: '', trailing: '' };
  const trailing = transcript.slice(idx + wake.length).trim();
  if (!trailing) return { matched: true, dispatchText: '', trailing: '' };
  // If the trailing text already starts with "operator ", don't double-prefix
  // (case where the wakeWord doesn't include "operator").
  const dispatchText = /^operator\s+/i.test(trailing) ? trailing : `operator ${trailing}`;
  return { matched: true, dispatchText, trailing };
}
