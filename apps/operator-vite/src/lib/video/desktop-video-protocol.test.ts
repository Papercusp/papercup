import { describe, expect, it } from 'vitest';
import { FrameDecoder, decodeCtrl, encodeVideoPayload } from '@papercusp/p2p-voice';
import {
  CAM,
  CTRL,
  buildCamFrame,
  buildCamera,
  buildJoin,
  buildVideoRecv,
  parseVidFrame,
} from './desktop-video-protocol';

const te = new TextEncoder();

describe('desktop-video-protocol CAM', () => {
  it('buildCamFrame produces a CAM frame whose payload decodes back to the video frame', () => {
    const data = new Uint8Array([5, 6, 7, 8]);
    const wire = buildCamFrame({ key: true, timestamp: 1000 }, data);
    const frames = new FrameDecoder().push(wire);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(CAM);
    // The CAM payload is the raw video payload — the demux/decoder will decodeVideo it.
    const parsed = parseVidFrame(prefixPeer('', frames[0].payload)); // empty id + payload
    expect(parsed?.frame.key).toBe(true);
    expect(parsed?.frame.timestamp).toBe(1000);
    expect([...(parsed?.frame.data ?? [])]).toEqual([...data]);
  });
});

/** Helper: build a VID payload [idLen][peerId][videoPayload]. */
function prefixPeer(peerId: string, videoPayload: Uint8Array): Uint8Array {
  const id = te.encode(peerId);
  const out = new Uint8Array(1 + id.length + videoPayload.length);
  out[0] = id.length;
  out.set(id, 1);
  out.set(videoPayload, 1 + id.length);
  return out;
}

describe('parseVidFrame', () => {
  it('splits peerId from the video payload and decodes it', () => {
    const vp = encodeVideoPayload({ key: false, timestamp: 77 }, new Uint8Array([1, 2, 3]));
    const parsed = parseVidFrame(prefixPeer('host-ab12', vp));
    expect(parsed).not.toBeNull();
    expect(parsed!.peerId).toBe('host-ab12');
    expect(parsed!.frame.key).toBe(false);
    expect(parsed!.frame.timestamp).toBe(77);
    expect([...parsed!.frame.data]).toEqual([1, 2, 3]);
  });

  it('returns null for an empty or truncated payload', () => {
    expect(parseVidFrame(new Uint8Array(0))).toBeNull();
    // idLen says 5 but only 2 id bytes present
    expect(parseVidFrame(new Uint8Array([5, 1, 2]))).toBeNull();
  });
});

describe('CTRL builders', () => {
  it('produce CTRL frames carrying the expected ops', () => {
    for (const [wire, expected] of [
      [buildJoin('vc-1'), { op: 'join', channel: 'vc-1' }],
      [buildVideoRecv(true), { op: 'video', recv: true }],
      [buildCamera(false), { op: 'camera', on: false }],
    ] as const) {
      const frames = new FrameDecoder().push(wire);
      expect(frames[0].type).toBe(CTRL);
      expect(decodeCtrl(frames[0].payload)).toEqual(expected);
    }
  });
});
