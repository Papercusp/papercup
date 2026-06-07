import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Frame } from '@papercusp/deployment-driver';
import {
  parseFramePull,
  subscribeFrameView,
  _resetFrameViewForTests,
  FRAME_PULL_SCRIPT,
  type FrameThumb,
  type FrameViewStatus,
} from './frame-view';

const b64 = (s: string) => Buffer.from(s).toString('base64');

afterEach(() => {
  _resetFrameViewForTests();
  vi.useRealTimers();
});

describe('parseFramePull', () => {
  it('parses leases + thumbs framed by marker lines', () => {
    const leases = { leases: [{ number: 99, role: 'worker', sinceMs: 123 }] };
    const stdout = [
      'LEASES',
      b64(JSON.stringify(leases)),
      'THUMB display-99.jpg',
      b64('jpeg-99-bytes'),
      'THUMB display-100.jpg',
      b64('jpeg-100-bytes'),
      '',
    ].join('\n');
    const parsed = parseFramePull(stdout);
    expect(parsed.noCaptureDir).toBe(false);
    expect(parsed.leases).toEqual([{ number: 99, role: 'worker', sinceMs: 123 }]);
    expect(parsed.thumbs).toEqual([
      { display: 99, jpegBase64: b64('jpeg-99-bytes') },
      { display: 100, jpegBase64: b64('jpeg-100-bytes') },
    ]);
  });

  it('flags a frame without a capture dir (desktop off)', () => {
    expect(parseFramePull('NO_CAPTURE_DIR\n')).toMatchObject({ noCaptureDir: true, thumbs: [] });
  });

  it('survives a garbled lease snapshot (skips it, keeps thumbs)', () => {
    const stdout = ['LEASES', 'not-base64-json!!!', 'THUMB display-99.jpg', b64('x'), ''].join('\n');
    const parsed = parseFramePull(stdout);
    expect(parsed.leases).toEqual([]);
    expect(parsed.thumbs).toHaveLength(1);
  });

  it('empty output → nothing', () => {
    expect(parseFramePull('')).toEqual({ noCaptureDir: false, leases: [], thumbs: [] });
  });
});

const FRAME: Frame = { id: 'lat-1', target: 'latitude', placement: 'remote', host: '203.0.113.5' };

function fakeDeps(stdoutFor: () => string, runs: string[] = []) {
  return {
    loadFrame: async () => ({ frame: FRAME, config: { target: 'latitude' } }),
    makeExec: () => ({
      async runScript(script: string) {
        runs.push(script);
        return { stdout: stdoutFor(), stderr: '', exitCode: 0 };
      },
      async copyFile() {},
    }),
    intervalMs: 1_000,
  };
}

describe('subscribeFrameView (viewer-driven poller)', () => {
  it('first subscriber starts the poll; thumbs + lease roles fan out', async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const stdout = [
      'LEASES',
      b64(JSON.stringify({ leases: [{ number: 99, role: 'worker', sinceMs: 5 }] })),
      'THUMB display-99.jpg',
      b64('img'),
      '',
    ].join('\n');
    const thumbs: FrameThumb[] = [];
    const statuses: FrameViewStatus[] = [];
    const off = subscribeFrameView(
      'h1',
      'ws1',
      { onThumb: (t) => thumbs.push(t), onStatus: (s) => statuses.push(s) },
      fakeDeps(() => stdout, runs),
    );
    await vi.advanceTimersByTimeAsync(10); // immediate first tick
    expect(runs).toEqual([FRAME_PULL_SCRIPT]);
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]).toMatchObject({ slug: 'h1', display: 99, role: 'worker', leaseSinceMs: 5 });
    expect(statuses.at(-1)).toMatchObject({ state: 'polling', frameId: 'lat-1', host: '203.0.113.5', displays: [99] });

    await vi.advanceTimersByTimeAsync(1_000); // next interval
    expect(runs).toHaveLength(2);
    off();
  });

  it('last unsubscribe stops the poll (viewer-driven, zero idle cost)', async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const off = subscribeFrameView('h1', 'ws1', { onThumb: () => {} }, fakeDeps(() => 'NO_CAPTURE_DIR\n', runs));
    await vi.advanceTimersByTimeAsync(10);
    const after = runs.length;
    off();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs.length).toBe(after); // no further pulls after the last viewer left
  });

  it('subscribers on the same slug share one poller', async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const deps = fakeDeps(() => 'NO_CAPTURE_DIR\n', runs);
    const off1 = subscribeFrameView('h1', 'ws1', { onThumb: () => {} }, deps);
    const off2 = subscribeFrameView('h1', 'ws1', { onThumb: () => {} }, deps);
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toHaveLength(1); // one pull serves both
    off1();
    off2();
  });

  it('no deployed frame → no-frame status, no ssh attempted', async () => {
    vi.useFakeTimers();
    const statuses: FrameViewStatus[] = [];
    const off = subscribeFrameView(
      'h1',
      'ws1',
      { onThumb: () => {}, onStatus: (s) => statuses.push(s) },
      { loadFrame: async () => undefined, intervalMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(statuses.at(-1)).toMatchObject({ state: 'no-frame' });
    off();
  });

  it('ssh failure → error status, exec re-resolved next tick', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const statuses: FrameViewStatus[] = [];
    const thumbs: FrameThumb[] = [];
    const off = subscribeFrameView(
      'h1',
      'ws1',
      { onThumb: (t) => thumbs.push(t), onStatus: (s) => statuses.push(s) },
      {
        loadFrame: async () => ({ frame: FRAME, config: { target: 'latitude' } }),
        makeExec: () => ({
          async runScript() {
            calls++;
            if (calls === 1) throw new Error('ssh: connection refused');
            return { stdout: ['THUMB display-99.jpg', b64('img'), ''].join('\n'), stderr: '', exitCode: 0 };
          },
          async copyFile() {},
        }),
        intervalMs: 1_000,
      },
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(statuses.at(-1)).toMatchObject({ state: 'error' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(thumbs).toHaveLength(1); // recovered on the next tick
    off();
  });
});
