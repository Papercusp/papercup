/**
 * cancelAllSpeech race fix (v4 §1.2.7).
 *
 * `window.speechSynthesis.cancel()` has well-known cross-browser races
 * where a "pending" utterance still fires after cancel. Fix: spin until
 * the engine reports both pending=false AND speaking=false, with a
 * 200ms timeout cap.
 *
 * Streaming engines (kokoro, elevenlabs) compose differently: they
 * each take an AbortController on the in-flight fetch. Use
 * `awaitAbort()` to ensure the abort propagates before the next call.
 */

export async function flushBrowserSpeechSynthesis(): Promise<void> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  for (let i = 0; i < 20; i++) {
    if (!window.speechSynthesis.pending && !window.speechSynthesis.speaking) return;
    await sleep(10);
  }
}

export async function awaitAbort(controller: AbortController | null): Promise<void> {
  if (!controller) return;
  if (controller.signal.aborted) return;
  controller.abort();
  // One microtask tick for downstream listeners to settle.
  await Promise.resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
