import { describe, expect, it } from 'vitest';
import {
  LEGACY_SU_CONTEXT_SIZE,
  SU_CONTEXT_SIZE,
  normalizeSuContextSize,
} from './su-context-size.mjs';

/**
 * Regression coverage for the canonical launch-context policy
 * (trimmed-only-agent-context-launch-2026-08-27 P-003).
 *
 * `normalizeSuContextSize` is the single chokepoint that keeps the plan's central
 * requirement true: `full` is a deprecated compatibility ALIAS accepted at durable and
 * CLI boundaries, and must never survive as an EFFECTIVE launch mode. Every caller —
 * buildRoleLaunchSpec, buildSuLaunchSpec, the fleet/capability/endpoint schemas, and the
 * spawn routes — funnels through it, so it was carrying the whole invariant with no test
 * at all. A silent regression here does not fail loudly: it re-opens the eager
 * whole-catalog load, which for Codex is transport-INVALID once the code-mode IPC frame
 * exceeds its limit, and for everyone else is the "Prompt is too long" death (WI-4608).
 */
describe('normalizeSuContextSize — the legacy-alias chokepoint', () => {
  it('exposes trimmed as the canonical size and full as the legacy spelling', () => {
    expect(SU_CONTEXT_SIZE).toBe('trimmed');
    expect(LEGACY_SU_CONTEXT_SIZE).toBe('full');
  });

  it('defaults to trimmed when nothing was requested', () => {
    for (const absent of [undefined, null, '', '   ']) {
      const r = normalizeSuContextSize(absent);
      expect(r.ok, String(absent)).toBe(true);
      if (!r.ok) return;
      expect(r.contextSize).toBe('trimmed');
      // `explicit:false` is what lets a caller tell "caller asked for trimmed" from
      // "caller said nothing" — the spawn routes report the difference.
      expect(r.explicit).toBe(false);
      expect(r.normalizedLegacyFull).toBe(false);
    }
  });

  it('accepts an explicit trimmed without flagging a legacy normalization', () => {
    const r = normalizeSuContextSize('trimmed');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contextSize).toBe('trimmed');
    expect(r.explicit).toBe(true);
    expect(r.normalizedLegacyFull).toBe(false);
  });

  it('accepts the legacy full and reports it as normalized, not as an effective mode', () => {
    const r = normalizeSuContextSize('full');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The whole point: it is ACCEPTED (an old stored row must not become a trap) but
    // the value it resolves to is trimmed, and the caller is told a legacy value came in
    // so it can surface the deprecation instead of silently honouring it.
    expect(r.contextSize).toBe('trimmed');
    expect(r.explicit).toBe(true);
    expect(r.normalizedLegacyFull).toBe(true);
  });

  it('tolerates surrounding whitespace on both spellings', () => {
    expect(normalizeSuContextSize('  trimmed  ')).toMatchObject({
      ok: true,
      contextSize: 'trimmed',
      normalizedLegacyFull: false,
    });
    expect(normalizeSuContextSize('\tfull\n')).toMatchObject({
      ok: true,
      contextSize: 'trimmed',
      normalizedLegacyFull: true,
    });
  });

  it('REJECTS an unrecognized value instead of silently defaulting it', () => {
    // Failing closed matters more than convenience here: silently coercing an unknown
    // value to trimmed would hide a caller that thinks it is selecting something else.
    const r = normalizeSuContextSize('enormous');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.received).toBe('enormous');
    expect(r.error).toContain('trimmed');
  });

  it('is case-SENSITIVE, so a near-miss spelling fails loudly rather than resolving', () => {
    for (const nearMiss of ['FULL', 'Full', 'TRIMMED', 'Trimmed']) {
      expect(normalizeSuContextSize(nearMiss).ok, nearMiss).toBe(false);
    }
  });

  it('cannot return an effective full for ANY input — the invariant, not one case', () => {
    const inputs: unknown[] = [
      undefined, null, '', '   ', 'trimmed', 'full', ' full ', 'FULL', 'enormous',
      0, 1, true, false, {}, [], ['full'], { contextSize: 'full' }, () => 'full', Symbol,
      Number.NaN, Infinity, '__proto__', 'null', 'undefined',
    ];
    for (const input of inputs) {
      const r = normalizeSuContextSize(input);
      if (r.ok) {
        // The single assertion this whole file exists to make.
        expect(r.contextSize, `input ${String(input)} resolved to an effective mode`).toBe('trimmed');
      } else {
        // A rejection is equally acceptable — what must never happen is ok:true with 'full'.
        expect(r.received, String(input)).toBeTypeOf('string');
      }
    }
  });

  it('only claims normalizedLegacyFull when the caller actually said full', () => {
    // Guards the reverse error: over-reporting the deprecation would make every launch
    // look like it came from a legacy row, which is how a real one stops being noticed.
    const legacyFlagged = ['full', ' full ', '\tfull\n'];
    const notFlagged = [undefined, null, '', 'trimmed', '  trimmed  '];
    for (const v of legacyFlagged) {
      const r = normalizeSuContextSize(v);
      expect(r.ok && r.normalizedLegacyFull, String(v)).toBe(true);
    }
    for (const v of notFlagged) {
      const r = normalizeSuContextSize(v);
      expect(r.ok && r.normalizedLegacyFull, String(v)).toBe(false);
    }
  });
});
