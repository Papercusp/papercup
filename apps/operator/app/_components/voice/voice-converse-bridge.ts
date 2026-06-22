'use client';

/**
 * voice→converse handler singleton.
 *
 * The OperatorConversationProvider owns `sendUserMessage`/`runGeneration`
 * (the `operator:converse` brain) but lives inside the React tree, while
 * the voice runtime + VoiceAppBridge route final-utterances imperatively
 * outside it. This module is the seam: the provider publishes its
 * `sendUserMessage` here on mount, and VoiceAppBridge calls
 * `routeVoiceUtteranceToConverse(text)` instead of the (dead, wrong)
 * Oracle fallback so a spoken turn drives the SAME backend the TUI text
 * chat drives.
 *
 * Phase 1 of sentinel-tui-shared-backend-and-cards-2026-06-22: restores
 * "voice ≡ text on one brain". Decision A — the brain is the Sentinel
 * front-door (`operator:converse`), NOT Oracle and NOT the ElevenLabs
 * full-agent.
 */

/** A spoken user turn sent to the operator conversation. `spoken:true`
 *  marks it voice-initiated so the provider speaks the assistant reply. */
type VoiceConverseHandler = (text: string, opts: { spoken: true }) => void;

let handler: VoiceConverseHandler | null = null;

/**
 * Provider publishes its `sendUserMessage` here on mount (and clears it
 * on unmount). Called from inside OperatorConversationProvider where
 * `sendUserMessage` is in scope.
 */
export function setVoiceConverseHandler(fn: VoiceConverseHandler | null): void {
  handler = fn;
}

/**
 * Route a final voice utterance into the operator conversation brain.
 * Returns true when a handler was registered and the turn was dispatched
 * (so the caller knows NOT to fall through to any other backend), false
 * when no conversation provider is mounted.
 */
export function routeVoiceUtteranceToConverse(text: string): boolean {
  if (!handler) return false;
  handler(text, { spoken: true });
  return true;
}
