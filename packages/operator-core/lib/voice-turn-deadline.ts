/**
 * The mobile desktop-local voice route is interactive: if the brain has not
 * produced any stream event promptly, waiting for the converse tool's generic
 * ten-minute ceiling is worse than failing the turn and letting the owner retry.
 */
export const VOICE_BRAIN_FIRST_EVENT_TIMEOUT_MS = 45_000;

export const VOICE_BRAIN_TIMEOUT_MESSAGE =
  'The voice response took too long. Please try again.';

export interface VoiceBrainFirstEventDeadline {
  signal: AbortSignal;
  /** Stop the first-event timer once the brain proves it is making progress. */
  observeEvent(): void;
  /** True only when this deadline fired, not when the caller disconnected. */
  didTimeout(): boolean;
  dispose(): void;
}

/**
 * Compose the request signal with a voice-specific first-event deadline.
 * The converse dispatch gets the child signal; disconnects still propagate,
 * while the route can distinguish its own timeout and render stable copy.
 */
export function createVoiceBrainFirstEventDeadline(
  parentSignal: AbortSignal,
  timeoutMs = VOICE_BRAIN_FIRST_EVENT_TIMEOUT_MS,
): VoiceBrainFirstEventDeadline {
  const controller = new AbortController();
  let timedOut = false;
  let settled = false;

  const clearDeadline = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };
  const abortFromParent = (): void => {
    clearDeadline();
    controller.abort(parentSignal.reason);
  };

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    timedOut = true;
    controller.abort(new DOMException('voice brain first event timed out', 'TimeoutError'));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });

  return {
    signal: controller.signal,
    observeEvent: clearDeadline,
    didTimeout: () => timedOut,
    dispose: () => {
      clearDeadline();
      parentSignal.removeEventListener('abort', abortFromParent);
    },
  };
}
