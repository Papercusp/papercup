import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VIDEO_CONFIG,
  KeyframeGate,
  createCameraEncoder,
  createPeerDecoder,
  encodedChunkToFrame,
  webCodecsSupported,
  type EncodedChunkLike,
  type VideoFrameLike,
} from './video-codec';

describe('webCodecsSupported', () => {
  it('false when the globals are missing (jsdom default)', () => {
    expect(webCodecsSupported({})).toBe(false);
    expect(webCodecsSupported({ VideoEncoder: function () {} as never })).toBe(false); // partial
  });
  it('true when VideoEncoder + VideoDecoder + EncodedVideoChunk all present', () => {
    const fn = function () {} as never;
    expect(webCodecsSupported({ VideoEncoder: fn, VideoDecoder: fn, EncodedVideoChunk: fn })).toBe(true);
  });
});

describe('encodedChunkToFrame', () => {
  it('copies bytes and maps type→key', () => {
    const chunk: EncodedChunkLike = {
      type: 'key',
      timestamp: 42,
      byteLength: 3,
      copyTo: (d) => d.set([7, 8, 9]),
    };
    const f = encodedChunkToFrame(chunk);
    expect(f.key).toBe(true);
    expect(f.timestamp).toBe(42);
    expect([...f.data]).toEqual([7, 8, 9]);
    expect(encodedChunkToFrame({ ...chunk, type: 'delta' }).key).toBe(false);
  });
});

describe('KeyframeGate', () => {
  it('drops deltas until the first keyframe, then forwards everything', () => {
    const g = new KeyframeGate();
    expect(g.accept(false)).toBe(false); // delta before any key → dropped
    expect(g.accept(false)).toBe(false);
    expect(g.accept(true)).toBe(true); // keyframe opens the gate
    expect(g.accept(false)).toBe(true); // subsequent deltas pass
    expect(g.ready).toBe(true);
  });
  it('reset re-waits for a keyframe', () => {
    const g = new KeyframeGate();
    g.accept(true);
    g.reset();
    expect(g.ready).toBe(false);
    expect(g.accept(false)).toBe(false);
    expect(g.accept(true)).toBe(true);
  });
});

describe('DEFAULT_VIDEO_CONFIG', () => {
  it('is the conservative 360p@15 starting point (D-005)', () => {
    expect(DEFAULT_VIDEO_CONFIG.width).toBe(640);
    expect(DEFAULT_VIDEO_CONFIG.height).toBe(360);
    expect(DEFAULT_VIDEO_CONFIG.framerate).toBe(15);
    expect(DEFAULT_VIDEO_CONFIG.bitrate).toBeLessThanOrEqual(600_000);
  });
});

// --- factory tests with a fake WebCodecs global ---

interface FakeEncoderInstance {
  configs: Record<string, unknown>[];
  encodes: { ts: number; keyFrame?: boolean }[];
  closed: boolean;
  emit(ts: number, key: boolean): void;
}
let lastEncoder: FakeEncoderInstance | null = null;

function installFakeWebCodecs() {
  const g = globalThis as unknown as Record<string, unknown>;
  class FakeVideoEncoder {
    configs: Record<string, unknown>[] = [];
    encodes: { ts: number; keyFrame?: boolean }[] = [];
    closed = false;
    encodeQueueSize = 0;
    #out: (c: EncodedChunkLike) => void;
    constructor(init: { output: (c: EncodedChunkLike) => void }) {
      this.#out = init.output;
      lastEncoder = this as unknown as FakeEncoderInstance;
    }
    configure(c: Record<string, unknown>) {
      this.configs.push(c);
    }
    encode(frame: VideoFrameLike, opts?: { keyFrame?: boolean }) {
      this.encodes.push({ ts: frame.timestamp, keyFrame: opts?.keyFrame });
    }
    emit(ts: number, key: boolean) {
      this.#out({ type: key ? 'key' : 'delta', timestamp: ts, byteLength: 1, copyTo: (d) => d.set([1]) });
    }
    close() {
      this.closed = true;
    }
  }
  const decodes: { configured: number; chunks: unknown[] } = { configured: 0, chunks: [] };
  class FakeVideoDecoder {
    constructor(_init: unknown) {}
    configure() {
      decodes.configured++;
    }
    decode(chunk: unknown) {
      decodes.chunks.push(chunk);
    }
    close() {}
  }
  class FakeEncodedVideoChunk {
    type: string;
    timestamp: number;
    constructor(init: { type: string; timestamp: number }) {
      this.type = init.type;
      this.timestamp = init.timestamp;
    }
  }
  g.VideoEncoder = FakeVideoEncoder as never;
  g.VideoDecoder = FakeVideoDecoder as never;
  g.EncodedVideoChunk = FakeEncodedVideoChunk as never;
  return { decodes };
}

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.VideoEncoder;
  delete g.VideoDecoder;
  delete g.EncodedVideoChunk;
  lastEncoder = null;
});

function frame(ts: number): VideoFrameLike {
  return { timestamp: ts, close: vi.fn() };
}

describe('createCameraEncoder (fake WebCodecs)', () => {
  it('first frame is a keyframe, subsequent are deltas, and frames are closed', () => {
    installFakeWebCodecs();
    const out: { key: boolean; timestamp: number }[] = [];
    const enc = createCameraEncoder({ onFrame: (f) => out.push({ key: f.key, timestamp: f.timestamp }) });
    const f1 = frame(0);
    const f2 = frame(1);
    enc.encode(f1);
    enc.encode(f2);
    expect(lastEncoder!.encodes).toEqual([
      { ts: 0, keyFrame: true },
      { ts: 1, keyFrame: false },
    ]);
    expect(f1.close).toHaveBeenCalled();
    expect(f2.close).toHaveBeenCalled();
    enc.close();
    expect(lastEncoder!.closed).toBe(true);
  });

  it('requestKeyframe forces the next encode to be a keyframe', () => {
    installFakeWebCodecs();
    const enc = createCameraEncoder({ onFrame: () => {} });
    enc.encode(frame(0)); // key
    enc.encode(frame(1)); // delta
    enc.requestKeyframe();
    enc.encode(frame(2)); // forced key
    expect(lastEncoder!.encodes.map((e) => e.keyFrame)).toEqual([true, false, true]);
  });

  it('reconfigure re-configures and forces a keyframe', () => {
    installFakeWebCodecs();
    const enc = createCameraEncoder({ onFrame: () => {} });
    enc.encode(frame(0));
    enc.encode(frame(1));
    enc.reconfigure({ width: 320, height: 180 });
    enc.encode(frame(2));
    expect(lastEncoder!.configs.at(-1)).toMatchObject({ width: 320, height: 180 });
    expect(lastEncoder!.encodes.at(-1)?.keyFrame).toBe(true);
  });

  it('output chunks flow through as EncodedVideoFrames', () => {
    installFakeWebCodecs();
    const out: { key: boolean; timestamp: number }[] = [];
    createCameraEncoder({ onFrame: (f) => out.push({ key: f.key, timestamp: f.timestamp }) });
    lastEncoder!.emit(99, true);
    expect(out).toEqual([{ key: true, timestamp: 99 }]);
  });
});

describe('createPeerDecoder (fake WebCodecs)', () => {
  it('drops deltas until the first keyframe, configures once, then decodes', () => {
    const { decodes } = installFakeWebCodecs();
    const dec = createPeerDecoder({ onFrame: () => {} });
    dec.decode({ key: false, timestamp: 0, data: new Uint8Array([1]) }); // dropped
    expect(decodes.chunks).toHaveLength(0);
    expect(decodes.configured).toBe(0);
    dec.decode({ key: true, timestamp: 1, data: new Uint8Array([2]) }); // configures + decodes
    dec.decode({ key: false, timestamp: 2, data: new Uint8Array([3]) }); // decodes
    expect(decodes.configured).toBe(1); // configured exactly once
    expect(decodes.chunks).toHaveLength(2);
  });

  it('reset re-waits for a keyframe', () => {
    const { decodes } = installFakeWebCodecs();
    const dec = createPeerDecoder({ onFrame: () => {} });
    dec.decode({ key: true, timestamp: 0, data: new Uint8Array([1]) });
    dec.reset();
    dec.decode({ key: false, timestamp: 1, data: new Uint8Array([2]) }); // dropped after reset
    expect(decodes.chunks).toHaveLength(1);
  });
});
