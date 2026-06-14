import { describe, it, expect } from 'vitest';
import { b64uEncode, b64uDecode, b64uEncodeString, b64uDecodeString } from './base64url';

describe('base64url byte codec', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(b64uDecode(b64uEncode(bytes)))).toEqual(Array.from(bytes));
  });

  it('emits only URL-safe characters (no +, /, or = padding)', () => {
    // These bytes produce + and / under standard base64.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x3e, 0x3f]);
    const enc = b64uEncode(bytes);
    expect(enc).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(enc).not.toMatch(/[+/=]/);
  });

  it('handles empty input', () => {
    expect(b64uEncode(new Uint8Array([]))).toBe('');
    expect(Array.from(b64uDecode(''))).toEqual([]);
  });

  it('strips padding for a single byte', () => {
    const enc = b64uEncode(new Uint8Array([0x66])); // 'f' → 'Zg' (no '==')
    expect(enc).not.toContain('=');
    expect(Array.from(b64uDecode(enc))).toEqual([0x66]);
  });

  it('decodes a value that has no padding', () => {
    // 'aGVsbG8' is standard 'aGVsbG8=' minus padding.
    expect(b64uDecodeString('aGVsbG8')).toBe('hello');
  });
});

describe('base64url string codec', () => {
  it('matches the known vector for "hello"', () => {
    expect(b64uEncodeString('hello')).toBe('aGVsbG8');
  });

  it('round-trips unicode strings', () => {
    const s = 'héllo 世界 🌍';
    expect(b64uDecodeString(b64uEncodeString(s))).toBe(s);
  });

  it('round-trips an empty string', () => {
    expect(b64uDecodeString(b64uEncodeString(''))).toBe('');
  });
});
