import { describe, expect, it, vi } from 'vitest';
import { encodeVideoPayload } from '@papercusp/p2p-voice';
import { VideoDemux, type DemuxDecoder } from './video-demux';
import type { EncodedVideoFrame } from './video-codec';

const te = new TextEncoder();

function vid(peerId: string, frame: { key: boolean; timestamp: number; data: number[] }): Uint8Array {
  const vp = encodeVideoPayload({ key: frame.key, timestamp: frame.timestamp }, new Uint8Array(frame.data));
  const id = te.encode(peerId);
  const out = new Uint8Array(1 + id.length + vp.length);
  out[0] = id.length;
  out.set(id, 1);
  out.set(vp, 1 + id.length);
  return out;
}

function mockDecoder() {
  const decoded: EncodedVideoFrame[] = [];
  const dec: DemuxDecoder & { decoded: EncodedVideoFrame[]; closed: boolean } = {
    decoded,
    closed: false,
    decode: (f) => decoded.push(f),
    close() {
      this.closed = true;
    },
  };
  return dec;
}

describe('VideoDemux', () => {
  it('lazily creates one decoder per peer and routes frames to it', () => {
    const created = new Map<string, ReturnType<typeof mockDecoder>>();
    const demux = new VideoDemux((peerId) => {
      const d = mockDecoder();
      created.set(peerId, d);
      return d;
    });

    demux.onVid(vid('A', { key: true, timestamp: 1, data: [1] }));
    demux.onVid(vid('A', { key: false, timestamp: 2, data: [2] }));
    demux.onVid(vid('B', { key: true, timestamp: 3, data: [3] }));

    expect(demux.peers().sort()).toEqual(['A', 'B']);
    expect(created.get('A')!.decoded.map((f) => f.timestamp)).toEqual([1, 2]);
    expect(created.get('B')!.decoded.map((f) => f.timestamp)).toEqual([3]);
  });

  it('syncPeers closes decoders for departed peers only', () => {
    const created = new Map<string, ReturnType<typeof mockDecoder>>();
    const demux = new VideoDemux((peerId) => {
      const d = mockDecoder();
      created.set(peerId, d);
      return d;
    });
    demux.onVid(vid('A', { key: true, timestamp: 1, data: [1] }));
    demux.onVid(vid('B', { key: true, timestamp: 1, data: [1] }));

    demux.syncPeers(['A']); // B left
    expect(demux.peers()).toEqual(['A']);
    expect(created.get('B')!.closed).toBe(true);
    expect(created.get('A')!.closed).toBe(false);
  });

  it('removePeer + close tear down decoders', () => {
    const created: ReturnType<typeof mockDecoder>[] = [];
    const demux = new VideoDemux(() => {
      const d = mockDecoder();
      created.push(d);
      return d;
    });
    demux.onVid(vid('A', { key: true, timestamp: 1, data: [1] }));
    demux.removePeer('A');
    expect(demux.has('A')).toBe(false);
    expect(created[0].closed).toBe(true);

    demux.onVid(vid('C', { key: true, timestamp: 1, data: [1] }));
    demux.close();
    expect(demux.peers()).toEqual([]);
    expect(created.every((d) => d.closed)).toBe(true);
  });

  it('ignores a malformed VID payload (returns null, no decoder created)', () => {
    const factory = vi.fn(() => mockDecoder());
    const demux = new VideoDemux(factory);
    expect(demux.onVid(new Uint8Array([9, 1, 2]))).toBeNull(); // idLen 9 > available
    expect(factory).not.toHaveBeenCalled();
  });
});
