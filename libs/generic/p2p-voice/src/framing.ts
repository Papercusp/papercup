/**
 * Per-connection wire framing for voice peers — the house `[4B len BE][1B type][payload]`
 * shape (mirrors @papercusp/ipc-framing), symmetric in both directions.
 *
 * Types:
 *   0x01 CTRL  — UTF-8 JSON control message (hello / state)
 *   0x02 AUDIO — `[4B seq BE][codec payload…]`
 */

export const FRAME_CTRL = 0x01;
export const FRAME_AUDIO = 0x02;

/** Refuse absurd frames — a voice frame is ~tens of bytes; control JSON is small. */
export const MAX_FRAME_BYTES = 1 << 20; // 1 MiB

export interface VoiceFrame {
  type: number;
  payload: Uint8Array;
}

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  out[4] = type & 0xff;
  out.set(payload, 5);
  return out;
}

const te = new TextEncoder();
const td = new TextDecoder();

export function encodeCtrl(msg: unknown): Uint8Array {
  return encodeFrame(FRAME_CTRL, te.encode(JSON.stringify(msg)));
}

export function decodeCtrl(payload: Uint8Array): unknown {
  return JSON.parse(td.decode(payload));
}

export function encodeAudio(seq: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(4 + data.length);
  new DataView(payload.buffer).setUint32(0, seq >>> 0, false);
  payload.set(data, 4);
  return encodeFrame(FRAME_AUDIO, payload);
}

export function decodeAudio(payload: Uint8Array): { seq: number; data: Uint8Array } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { seq: view.getUint32(0, false), data: payload.subarray(4) };
}

/** Incremental decoder — feed arbitrary chunk boundaries, get whole frames out. */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): VoiceFrame[] {
    if (this.buf.length === 0) {
      this.buf = chunk;
    } else {
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf, 0);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
    const frames: VoiceFrame[] = [];
    for (;;) {
      if (this.buf.length < 5) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = view.getUint32(0, false);
      if (len > MAX_FRAME_BYTES) throw new Error(`p2p-voice: frame too large (${len})`);
      if (this.buf.length < 5 + len) break;
      frames.push({ type: this.buf[4], payload: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return frames;
  }
}
