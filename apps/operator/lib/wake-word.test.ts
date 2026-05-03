import { describe, expect, it } from 'vitest';
import { stripWakeWordAndPrefix } from './wake-word';

describe('stripWakeWordAndPrefix', () => {
  it('returns matched:false when wake word absent', () => {
    const r = stripWakeWordAndPrefix('the quick brown fox', 'hey operator');
    expect(r.matched).toBe(false);
    expect(r.dispatchText).toBe('');
  });

  it('strips wake word and prefixes "operator "', () => {
    const r = stripWakeWordAndPrefix('hey operator approve sheets', 'hey operator');
    expect(r.matched).toBe(true);
    expect(r.trailing).toBe('approve sheets');
    expect(r.dispatchText).toBe('operator approve sheets');
  });

  it('handles wake word case-insensitively', () => {
    const r = stripWakeWordAndPrefix('Hey Operator approve sheets', 'hey operator');
    expect(r.matched).toBe(true);
    expect(r.dispatchText).toBe('operator approve sheets');
  });

  it('does NOT double-prefix when trailing already starts with operator', () => {
    const r = stripWakeWordAndPrefix('hey operator open', 'hey');
    expect(r.dispatchText).toBe('operator open');
  });

  it('uses lastIndexOf so a leading filler does not break dispatch', () => {
    const r = stripWakeWordAndPrefix('uh hey operator scan', 'hey operator');
    expect(r.dispatchText).toBe('operator scan');
  });

  it('returns empty dispatchText when only the wake word was spoken', () => {
    const r = stripWakeWordAndPrefix('hey operator', 'hey operator');
    expect(r.matched).toBe(true);
    expect(r.dispatchText).toBe('');
    expect(r.trailing).toBe('');
  });

  it('preserves multi-word intent payloads (approve <slug> <cap>)', () => {
    const r = stripWakeWordAndPrefix('hey operator approve sheets http fetch', 'hey operator');
    expect(r.dispatchText).toBe('operator approve sheets http fetch');
  });

  it('handles "across workspaces" multi-word intent', () => {
    const r = stripWakeWordAndPrefix('hey operator across workspaces', 'hey operator');
    expect(r.dispatchText).toBe('operator across workspaces');
  });
});
