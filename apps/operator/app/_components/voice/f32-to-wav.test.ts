/**
 * Unit tests for the PCM16 WAV encoder used by the Voicemode/Whisper
 * capture path. The encoder is pure bytes — exercised here against the
 * canonical 44-byte WAV header layout and the Float32→Int16 conversion
 * (including clamping), so a malformed header or wrong sample scaling
 * (which would make Whisper transcribe garbage or nothing) is caught.
 */

import { describe, it, expect } from 'vitest';
import { f32ToWavBuffer, f32ToWav } from './f32-to-wav';

function ascii(view: DataView, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe('f32ToWavBuffer header', () => {
  it('emits a canonical 44-byte PCM16 mono header', () => {
    const samples = new Float32Array(8);
    const buf = f32ToWavBuffer(samples, 16000);
    const view = new DataView(buf);
    const dataSize = samples.length * 2;

    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + dataSize); // RIFF chunk size
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);   // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1);    // PCM
    expect(view.getUint16(22, true)).toBe(1);    // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(16000 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2);    // block align
    expect(view.getUint16(34, true)).toBe(16);   // bits per sample
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(dataSize);
  });

  it('honours a non-default sample rate in header + byte rate', () => {
    const view = new DataView(f32ToWavBuffer(new Float32Array(4), 48000));
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(48000 * 2);
  });

  it('total length is 44 + 2 bytes per sample', () => {
    expect(f32ToWavBuffer(new Float32Array(100)).byteLength).toBe(44 + 200);
    expect(f32ToWavBuffer(new Float32Array(0)).byteLength).toBe(44);
  });
});

describe('f32ToWavBuffer PCM16 conversion', () => {
  it('maps full-scale and zero samples correctly, clamping out-of-range input', () => {
    const samples = new Float32Array([0, 1, -1, 2, -2, 0.5]);
    const view = new DataView(f32ToWavBuffer(samples));
    const pcm = (i: number) => view.getInt16(44 + i * 2, true);

    expect(pcm(0)).toBe(0);          // silence
    expect(pcm(1)).toBe(0x7fff);     // +1.0 → max positive
    expect(pcm(2)).toBe(-0x8000);    // -1.0 → min negative
    expect(pcm(3)).toBe(0x7fff);     // +2.0 clamps to +1.0
    expect(pcm(4)).toBe(-0x8000);    // -2.0 clamps to -1.0
    expect(pcm(5)).toBe(Math.trunc(0.5 * 0x7fff)); // 0.5 * 32767, setInt16 truncates toward zero
  });
});

describe('f32ToWav', () => {
  it('wraps the buffer as an audio/wav Blob of matching size', () => {
    const blob = f32ToWav(new Float32Array(10));
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 20);
  });
});
