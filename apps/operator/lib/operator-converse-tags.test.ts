import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseOperatorTurn,
  sleepTagToEpochMs,
} from './operator-converse-tags';

describe('parseOperatorTurn', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('extracts say-only turn', () => {
    const r = parseOperatorTurn('<say>Still with me?</say>');
    expect(r.say).toBe('Still with me?');
    expect(r.setMode).toBeNull();
    expect(r.sleep).toBeNull();
  });

  it('extracts say + set_mode together (allowed pairing)', () => {
    const r = parseOperatorTurn(
      '<say>Whenever you are ready.</say>\n<set_mode>passive</set_mode>',
    );
    expect(r.say).toBe('Whenever you are ready.');
    expect(r.setMode).toBe('passive');
    expect(r.sleep).toBeNull();
  });

  it('extracts a bare sleep tag (no say) — going-silent contract', () => {
    const r = parseOperatorTurn('<sleep duration_minutes="30" reason="firm pushback">');
    expect(r.say).toBeNull();
    expect(r.sleep).toEqual({ durationMinutes: 30, reason: 'firm pushback' });
  });

  it('drops sleep when paired with say, keeps the say (warn emitted)', () => {
    const r = parseOperatorTurn(
      '<say>got it</say>\n<sleep duration_minutes="30" reason="x">',
    );
    expect(r.say).toBe('got it');
    expect(r.sleep).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped <sleep>'),
      expect.any(Object),
    );
  });

  it('drops sleep with non-numeric duration (warn emitted)', () => {
    const r = parseOperatorTurn('<sleep duration_minutes="soon" reason="x">');
    expect(r.sleep).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('bad duration_minutes'),
      expect.any(Object),
    );
  });

  it('drops sleep with zero / negative duration', () => {
    expect(parseOperatorTurn('<sleep duration_minutes="0" reason="x">').sleep).toBeNull();
    expect(parseOperatorTurn('<sleep duration_minutes="-5" reason="x">').sleep).toBeNull();
  });

  it('caps absurdly large sleep durations at 30 days', () => {
    const r = parseOperatorTurn('<sleep duration_minutes="9999999" reason="forever">');
    expect(r.sleep?.durationMinutes).toBe(60 * 24 * 30);
  });

  it('accepts both " and \' quoting on attributes', () => {
    const r = parseOperatorTurn(`<sleep duration_minutes='15' reason='soft'>`);
    expect(r.sleep).toEqual({ durationMinutes: 15, reason: 'soft' });
  });

  it('treats empty say content as null', () => {
    const r = parseOperatorTurn('<say>   </say>');
    expect(r.say).toBeNull();
  });

  it('rejects unknown set_mode values', () => {
    const r = parseOperatorTurn('<say>x</say><set_mode>frozen</set_mode>');
    expect(r.setMode).toBeNull();
  });

  it('returns the raw input for telemetry', () => {
    const raw = '<say>hi</say>';
    const r = parseOperatorTurn(raw);
    expect(r.raw).toBe(raw);
  });

  it('handles multi-line say content', () => {
    const r = parseOperatorTurn('<say>line one\nline two</say>');
    expect(r.say).toBe('line one\nline two');
  });

  it('first sleep wins when multiple emitted (defensive)', () => {
    const r = parseOperatorTurn(
      '<sleep duration_minutes="10" reason="a"> ignore <sleep duration_minutes="999" reason="b">',
    );
    expect(r.sleep).toEqual({ durationMinutes: 10, reason: 'a' });
  });

  it('falls back to bare prose as say when no <say> tag emitted', () => {
    // Defensive: the model is supposed to wrap in <say>, but if it
    // doesn't we still want the user to see the reply.
    const r = parseOperatorTurn('Sure, what would you like to work on?');
    expect(r.say).toBe('Sure, what would you like to work on?');
    expect(r.setMode).toBeNull();
    expect(r.sleep).toBeNull();
  });

  it('bare-prose fallback strips set_mode tags from the visible text', () => {
    const r = parseOperatorTurn('Talk to you later <set_mode>passive</set_mode>');
    expect(r.say).toBe('Talk to you later');
    expect(r.setMode).toBe('passive');
  });

  it('bare-prose fallback is skipped when a <sleep> is present (going-silent contract)', () => {
    // Prose around a sleep tag is model noise — silence IS the response.
    const r = parseOperatorTurn(
      'okay <sleep duration_minutes="15" reason="x">',
    );
    expect(r.say).toBeNull();
    expect(r.sleep).toEqual({ durationMinutes: 15, reason: 'x' });
  });

  it('returns all-null on empty input', () => {
    const r = parseOperatorTurn('');
    expect(r.say).toBeNull();
    expect(r.setMode).toBeNull();
    expect(r.sleep).toBeNull();
  });

  it('returns null say but parses tags when input is pure-tag (sleep-only contract)', () => {
    const r = parseOperatorTurn('<sleep duration_minutes="15" reason="ok">');
    expect(r.say).toBeNull();
    expect(r.sleep).toEqual({ durationMinutes: 15, reason: 'ok' });
  });
});

describe('sleepTagToEpochMs', () => {
  it('adds duration_minutes to the supplied now', () => {
    expect(sleepTagToEpochMs({ durationMinutes: 5 }, 1_000_000_000)).toBe(
      1_000_000_000 + 5 * 60 * 1000,
    );
  });
});
