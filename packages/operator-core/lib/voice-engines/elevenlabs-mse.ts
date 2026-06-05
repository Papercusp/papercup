/**
 * MediaSource Extensions helper for ElevenLabs streaming TTS (v4 §1.2.6).
 *
 * Pinned over raw AudioContext + chunks (manual backpressure, race-prone)
 * and `<audio>` + blob URL (no streaming, high first-byte). MSE gives
 * native streaming + clean cancel.
 *
 * Returned `cancel()` tears down the MediaSource + revokes the blob URL
 * + aborts the underlying fetch in one call.
 */

export interface MsePlayer {
  /** Promise that resolves when audio finishes playing or is cancelled. */
  done: Promise<void>;
  /** Stop playback + free resources. Idempotent. */
  cancel(): void;
}

export interface MsePlayOpts {
  /** Source stream of audio chunks. */
  body: ReadableStream<Uint8Array>;
  /** Mime type for SourceBuffer. ElevenLabs Turbo v2.5 returns audio/mpeg by default. */
  mimeType?: string;
  /** Used to abort the underlying fetch on cancel. */
  abortController: AbortController;
}

/**
 * Stream `body` into an `<audio>` element via MediaSource. Returns a
 * cancel handle. Caller is responsible for awaiting `done` if it cares
 * about completion.
 */
export function playStream(opts: MsePlayOpts): MsePlayer {
  const mimeType = opts.mimeType ?? 'audio/mpeg';
  let cancelled = false;

  // Some browsers (Safari particularly) historically had MIME picky-ness;
  // detect support up front.
  if (typeof window === 'undefined' || !window.MediaSource || !MediaSource.isTypeSupported(mimeType)) {
    // Fallback path: buffer-then-play. Higher first-byte but always works.
    return playBuffered(opts);
  }

  const mediaSource = new MediaSource();
  const audio = new Audio();
  audio.src = URL.createObjectURL(mediaSource);

  const done = new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try { URL.revokeObjectURL(audio.src); } catch {}
      resolve();
    };

    audio.addEventListener('ended', finish);
    audio.addEventListener('error', finish);

    mediaSource.addEventListener('sourceopen', async () => {
      let sb: SourceBuffer;
      try {
        sb = mediaSource.addSourceBuffer(mimeType);
      } catch {
        finish();
        return;
      }

      const reader = opts.body.getReader();

      const appendChunk = (chunk: Uint8Array): Promise<void> => {
        return new Promise((res, rej) => {
          if (cancelled) { res(); return; }
          const onUpdateEnd = () => {
            sb.removeEventListener('updateend', onUpdateEnd);
            sb.removeEventListener('error', onError);
            res();
          };
          const onError = (e: any) => {
            sb.removeEventListener('updateend', onUpdateEnd);
            sb.removeEventListener('error', onError);
            rej(e);
          };
          sb.addEventListener('updateend', onUpdateEnd);
          sb.addEventListener('error', onError);
          try { sb.appendBuffer(chunk); } catch (e) { rej(e); }
        });
      };

      // Kick off playback as soon as the first chunk lands.
      let started = false;
      try {
        for (;;) {
          const { value, done: streamDone } = await reader.read();
          if (cancelled) break;
          if (streamDone) {
            try { mediaSource.endOfStream(); } catch {}
            break;
          }
          if (value && value.byteLength > 0) {
            await appendChunk(value);
            if (!started) {
              started = true;
              audio.play().catch(() => {});
            }
          }
        }
      } catch {
        /* abort propagated */
      }
    });
  });

  return {
    done,
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      try { audio.pause(); } catch {}
      try { opts.abortController.abort(); } catch {}
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch {}
      try { URL.revokeObjectURL(audio.src); } catch {}
    },
  };
}

/** Fallback when MSE isn't supported — buffer the whole stream then play. */
function playBuffered(opts: MsePlayOpts): MsePlayer {
  let cancelled = false;
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;

  const done = (async () => {
    try {
      const reader = opts.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { value, done: d } = await reader.read();
        if (cancelled) return;
        if (d) break;
        if (value) chunks.push(value);
      }
      if (cancelled) return;
      const blob = new Blob(chunks, { type: opts.mimeType ?? 'audio/mpeg' });
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.addEventListener('ended', () => { if (url) URL.revokeObjectURL(url); });
      await audio.play().catch(() => {});
    } catch { /* ignore */ }
  })();

  return {
    done,
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      try { opts.abortController.abort(); } catch {}
      if (audio) try { audio.pause(); } catch {}
      if (url) try { URL.revokeObjectURL(url); } catch {}
    },
  };
}
