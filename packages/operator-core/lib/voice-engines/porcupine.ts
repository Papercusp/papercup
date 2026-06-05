/**
 * Picovoice Porcupine wake-word detection.
 *
 * Replaces "transcribe everything via Whisper, then string-match wake
 * word" with "ONNX-detect wake word, only spin up STT after match."
 * Big idle-CPU win when always-on mode is on but the user isn't talking.
 *
 * Usage:
 *   const stop = await startWakeWordDetection({
 *     accessKey,
 *     keyword: 'Computer',     // built-in Porcupine keyword
 *     onWake: () => { … },     // fires when wake word is heard
 *   });
 *   // later
 *   stop();
 *
 * The free Picovoice access key tier covers personal/dev use.
 */

import { PorcupineWorker, BuiltInKeyword } from '@picovoice/porcupine-web';
import { WebVoiceProcessor } from '@picovoice/web-voice-processor';

export interface WakeWordOptions {
  accessKey: string;
  /** Built-in Porcupine keyword. For custom keywords, swap to a .ppn URL. */
  keyword: keyof typeof BuiltInKeyword | BuiltInKeyword;
  onWake: () => void;
  onError?: (err: Error) => void;
}

export interface WakeWordHandle {
  /** Stop detection + release the worker. Idempotent. */
  stop(): Promise<void>;
}

export async function startWakeWordDetection(opts: WakeWordOptions): Promise<WakeWordHandle> {
  if (typeof window === 'undefined') throw new Error('not in browser');
  const keyword =
    typeof opts.keyword === 'string' && opts.keyword in BuiltInKeyword
      ? BuiltInKeyword[opts.keyword as keyof typeof BuiltInKeyword]
      : (opts.keyword as BuiltInKeyword);

  const worker = await PorcupineWorker.create(
    opts.accessKey,
    [{ builtin: keyword, sensitivity: 0.6 }],
    () => opts.onWake(),
    {
      publicPath: 'https://raw.githubusercontent.com/Picovoice/porcupine/master/lib/common/porcupine_params.pv',
      forceWrite: true,
    },
  );

  await WebVoiceProcessor.subscribe(worker);

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try { await WebVoiceProcessor.unsubscribe(worker); } catch { /* ignore */ }
      try { worker.terminate(); } catch { /* ignore */ }
    },
  };
}

export const BUILT_IN_WAKE_WORDS = Object.values(BuiltInKeyword);
