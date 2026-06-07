import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createIvfStreamParser, buildIvf } from './ivf';
import { vp9IsKeyframe } from './vp9';
import { ffmpegScreenArgs, startScreenCapture, type ScreenEncodedFrame } from './screen-capture-source';
import {
  startFrameScreenPublisher,
  screenPeerLabel,
  parseScreenPeerLabel,
  type DisplayTrack,
} from './screen-publisher';

// VP9 uncompressed-header first bytes (profile 0):
// [marker(2)=10][profile_low=0][profile_high=0][show_existing=0][frame_type][show_frame][err]
const VP9_KEY = new Uint8Array([0b10_0_0_0_0_1_0, 0x00, 0x00]); // frame_type=0 → KEY
const VP9_DELTA = new Uint8Array([0b10_0_0_0_1_1_0, 0x00, 0x00]); // frame_type=1 → delta

describe('vp9IsKeyframe', () => {
  it('detects key vs delta from the frame_type bit (profile 0)', () => {
    expect(vp9IsKeyframe(VP9_KEY)).toBe(true);
    expect(vp9IsKeyframe(VP9_DELTA)).toBe(false);
  });

  it('show_existing_frame repeats are never keys', () => {
    // [10][0][0][show_existing=1]…
    expect(vp9IsKeyframe(new Uint8Array([0b10_0_0_1_0_0_0]))).toBe(false);
  });

  it('non-VP9 bytes (bad frame marker) and empty input → false', () => {
    expect(vp9IsKeyframe(new Uint8Array([0x00]))).toBe(false);
    expect(vp9IsKeyframe(new Uint8Array(0))).toBe(false);
  });
});

describe('createIvfStreamParser', () => {
  const frames = [
    { data: VP9_KEY, pts: 0 },
    { data: VP9_DELTA, pts: 1 },
    { data: VP9_DELTA, pts: 2 },
  ];

  it('parses header + frames from one buffer (pts → µs via the timebase)', () => {
    const parser = createIvfStreamParser();
    const out = parser.push(buildIvf(frames, { den: 15, num: 1 }));
    expect(parser.header()).toMatchObject({ fourcc: 'VP90', width: 1920, height: 1080 });
    expect(out).toHaveLength(3);
    expect(out[0].data).toEqual(VP9_KEY);
    expect(out[0].timestampUs).toBe(0);
    expect(out[1].timestampUs).toBe(Math.round((1 / 15) * 1_000_000));
  });

  it('handles arbitrary chunk boundaries (byte-by-byte)', () => {
    const bytes = buildIvf(frames);
    const parser = createIvfStreamParser();
    const out: unknown[] = [];
    for (const b of bytes) out.push(...parser.push(new Uint8Array([b])));
    expect(out).toHaveLength(3);
  });

  it('rejects a non-IVF stream loudly', () => {
    const parser = createIvfStreamParser();
    expect(() => parser.push(new Uint8Array(40).fill(0x41))).toThrow(/bad magic/);
  });
});

describe('ffmpegScreenArgs', () => {
  it('grabs the right display as realtime profile-0 VP9 over IVF', () => {
    const args = ffmpegScreenArgs({ display: 100 });
    expect(args).toContain('x11grab');
    expect(args[args.indexOf('-i') + 1]).toBe(':100');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libvpx-vp9');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args[args.indexOf('-deadline') + 1]).toBe('realtime');
    expect(args[args.indexOf('-f') + 1]).toBe('x11grab'); // first -f
    expect(args.at(-2)).toBe('ivf');
    expect(args.at(-1)).toBe('pipe:1');
  });
});

function fakeFfmpeg() {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('startScreenCapture', () => {
  it('streams IVF → per-frame callbacks with VP9 keyframe flags', () => {
    const child = fakeFfmpeg();
    const frames: ScreenEncodedFrame[] = [];
    startScreenCapture({
      display: 99,
      onFrame: (f) => frames.push(f),
      spawn: (() => child) as never,
    });
    const bytes = buildIvf([
      { data: VP9_KEY, pts: 0 },
      { data: VP9_DELTA, pts: 1 },
    ]);
    // feed in two chunks split mid-frame
    child.stdout.emit('data', Buffer.from(bytes.subarray(0, 40)));
    child.stdout.emit('data', Buffer.from(bytes.subarray(40)));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ key: true, timestampUs: 0 });
    expect(frames[1].key).toBe(false);
  });

  it('stop() kills the encoder; exit reaches onExit', () => {
    const child = fakeFfmpeg();
    const onExit = vi.fn();
    const cap = startScreenCapture({ display: 99, onFrame: () => {}, onExit, spawn: (() => child) as never });
    cap.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0);
    expect(onExit).toHaveBeenCalledWith(0);
  });
});

describe('screen peer labels', () => {
  it('round-trips slug:display (slugs may contain colons-free dashes etc.)', () => {
    expect(parseScreenPeerLabel(screenPeerLabel('papercup', 99))).toEqual({ slug: 'papercup', display: 99 });
    expect(parseScreenPeerLabel(screenPeerLabel('my-h1', 102))).toEqual({ slug: 'my-h1', display: 102 });
  });

  it('rejects non-screen labels', () => {
    expect(parseScreenPeerLabel('alice@laptop')).toBeUndefined();
    expect(parseScreenPeerLabel('frame:nodisplay')).toBeUndefined();
  });
});

describe('startFrameScreenPublisher (lease-driven track lifecycle)', () => {
  function trackFactory() {
    const made: number[] = [];
    const stopped: number[] = [];
    const makeTrack = async (display: number): Promise<DisplayTrack> => {
      made.push(display);
      return { display, stop: async () => void stopped.push(display) };
    };
    return { made, stopped, makeTrack };
  }

  it('starts a track per active display; release stops it; stop() stops all', async () => {
    vi.useFakeTimers();
    try {
      let leased = [99, 100];
      const { made, stopped, makeTrack } = trackFactory();
      const pub = startFrameScreenPublisher({
        harnessSlug: 'h1',
        displays: () => leased,
        pollMs: 1_000,
        makeTrack,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(made).toEqual([99, 100]);
      expect(pub.tracks()).toEqual([99, 100]);

      leased = [100]; // :99's agent exited
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped).toEqual([99]);
      expect(pub.tracks()).toEqual([100]);

      leased = [100, 101];
      await vi.advanceTimersByTimeAsync(1_000);
      expect(made).toEqual([99, 100, 101]);

      await pub.stop();
      expect(stopped.sort((a, b) => a - b)).toEqual([99, 100, 101]);
      await vi.advanceTimersByTimeAsync(5_000); // no zombie reconciles
      expect(made).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed track start is retried on a later tick, not wedged', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // the retry path warns by design
    try {
      let fail = true;
      const made: number[] = [];
      const pub = startFrameScreenPublisher({
        harnessSlug: 'h1',
        displays: () => [99],
        pollMs: 1_000,
        makeTrack: async (d) => {
          if (fail) throw new Error('swarm not up yet');
          made.push(d);
          return { display: d, stop: async () => {} };
        },
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(made).toEqual([]);
      fail = false;
      await vi.advanceTimersByTimeAsync(1_100);
      expect(made).toEqual([99]);
      await pub.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
