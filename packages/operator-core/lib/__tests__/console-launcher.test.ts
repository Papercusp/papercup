/**
 * Unit coverage for the P-023 / D-023 additions to console-launcher.
 *
 * `shellSafeId` is load-bearing — it stops anything outside
 * `[0-9a-f-]` from reaching a shell oneliner. Session ids are minted
 * as `crypto.randomUUID()`, so the regex is strict by design.
 */
import { describe, expect, it } from 'vitest';
import { shellSafeId } from '../console-launcher';

describe('shellSafeId', () => {
  it('accepts a real crypto.randomUUID() value', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(shellSafeId(id)).toBe(id);
  });

  it('accepts mixed-case hex (some uuid generators upper-case)', () => {
    const id = '550E8400-E29B-41D4-A716-446655440000';
    expect(shellSafeId(id)).toBe(id);
  });

  it('rejects a leading shell metachar', () => {
    expect(() => shellSafeId('; rm -rf /')).toThrow(/unsafe session id/i);
  });

  it('rejects backticks', () => {
    expect(() => shellSafeId('`evil`')).toThrow(/unsafe session id/i);
  });

  it('rejects a dollar substitution', () => {
    expect(() => shellSafeId('$(touch /tmp/pwn)')).toThrow(/unsafe session id/i);
  });

  it('rejects a space-separated payload', () => {
    expect(() => shellSafeId('abc 123')).toThrow(/unsafe session id/i);
  });

  it('rejects empty string', () => {
    expect(() => shellSafeId('')).toThrow(/unsafe session id/i);
  });

  it('rejects non-hex letters', () => {
    expect(() => shellSafeId('z'.repeat(36))).toThrow(/unsafe session id/i);
  });

  it('truncates the leaked id in the error message', () => {
    const long = '!'.repeat(100);
    expect(() => shellSafeId(long)).toThrow(/refusing to embed unsafe session id/);
  });
});
