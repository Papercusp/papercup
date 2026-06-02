// @vitest-environment jsdom
/**
 * MediaSource-Extensions streaming player for ElevenLabs TTS (elevenlabs-mse.ts).
 * Untested. Covers both branches:
 *   - MSE path (MediaSource supported): chunks appended to the SourceBuffer in
 *     order, playback kicks off on the first chunk, endOfStream on stream end,
 *     done resolves on the audio 'ended' event, and cancel() tears down
 *     (pause + abort fetch + endOfStream) idempotently.
 *   - buffered fallback (MSE unsupported): the whole stream is collected into a
 *     Blob and played; cancel() aborts the fetch.
 *
 * MediaSource/SourceBuffer/Audio are faked (jsdom implements none of them).
 *
 * P-015 of plan voice-production-test-coverage-2026-06-01.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playStream } from './elevenlabs-mse';

const audios: FakeAudio[] = [];
const mediaSources: FakeMediaSource[] = [];

class FakeAudio extends EventTarget {
  src = '';
  paused = false;
  playCalls = 0;
  constructor(src = '') {
    super();
    this.src = src; // buffered path uses `new Audio(url)`; MSE path sets .src after
    audios.push(this);
  }
  play() {
    this.playCalls += 1;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

class FakeSourceBuffer extends EventTarget {
  appended: Uint8Array[] = [];
  appendBuffer(chunk: Uint8Array) {
    this.appended.push(chunk);
    setTimeout(() => this.dispatchEvent(new Event('updateend')), 0);
  }
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  readyState = 'closed';
  sourceBuffers: FakeSourceBuffer[] = [];
  constructor() {
    super();
    mediaSources.push(this);
    // Real MediaSource fires 'sourceopen' once attached to an element; do it
    // on the next macrotask so the listener (added synchronously after
    // construction) is in place.
    setTimeout(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    }, 0);
  }
  addSourceBuffer() {
    const sb = new FakeSourceBuffer();
    this.sourceBuffers.push(sb);
    return sb;
  }
  endOfStream() {
    this.readyState = 'ended';
  }
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}
const tick = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  audios.length = 0;
  mediaSources.length = 0;
  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
  URL.createObjectURL = vi.fn(() => 'blob:stub') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  (window as unknown as { MediaSource?: unknown }).MediaSource = undefined;
});

describe('playStream — MSE path', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaSource', FakeMediaSource as unknown as typeof MediaSource);
    (window as unknown as { MediaSource: unknown }).MediaSource = FakeMediaSource;
  });

  it('appends chunks in order and starts playback on the first chunk', async () => {
    const c1 = new Uint8Array([1]);
    const c2 = new Uint8Array([2]);
    const c3 = new Uint8Array([3]);
    playStream({ body: streamOf([c1, c2, c3]), abortController: new AbortController() });
    await tick();
    const sb = mediaSources[0].sourceBuffers[0];
    expect(sb.appended).toEqual([c1, c2, c3]);
    expect(audios[0].playCalls).toBe(1); // started once, on the first chunk
    expect(mediaSources[0].readyState).toBe('ended'); // endOfStream after stream drained
  });

  it('resolves done + revokes the object URL when the audio ends', async () => {
    const player = playStream({ body: streamOf([new Uint8Array([1])]), abortController: new AbortController() });
    await tick();
    audios[0].dispatchEvent(new Event('ended'));
    await expect(player.done).resolves.toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('cancel() pauses, aborts the fetch, and is idempotent', async () => {
    const abort = vi.fn();
    const player = playStream({
      body: streamOf([new Uint8Array([1]), new Uint8Array([2])]),
      abortController: { abort } as unknown as AbortController,
    });
    await tick(5);
    player.cancel();
    player.cancel(); // idempotent
    expect(abort).toHaveBeenCalledTimes(1);
    expect(audios[0].paused).toBe(true);
  });
});

describe('playStream — buffered fallback (MSE unsupported)', () => {
  it('collects the whole stream into a Blob and plays it', async () => {
    const player = playStream({
      body: streamOf([new Uint8Array([1]), new Uint8Array([2])]),
      abortController: new AbortController(),
    });
    await player.done;
    expect(audios).toHaveLength(1);
    expect(audios[0].src).toBe('blob:stub');
    expect(audios[0].playCalls).toBe(1);
  });

  it('cancel() aborts the fetch', async () => {
    const abort = vi.fn();
    const never = new ReadableStream<Uint8Array>({ start() {/* never closes */} });
    const player = playStream({ body: never, abortController: { abort } as unknown as AbortController });
    player.cancel();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
