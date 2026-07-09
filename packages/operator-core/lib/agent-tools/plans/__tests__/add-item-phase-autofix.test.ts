/**
 * add-item-phase-autofix.test.ts — the PHASE arg's auto-prefix normalization
 * (EI-8811).
 *
 * The plan parser only recognizes `/^Phase\b/i` headings as phase sections, so
 * PHASE validates that grammar. Before this fix a caller-supplied phase name
 * that didn't already start with "Phase" (e.g. the very natural "Baseline")
 * was hard-REJECTED — and because `plans:add-item`'s bulk items share one
 * `phase` arg, that rejected the WHOLE batch, often after a preceding
 * `plans:new` call had already written the plan (leaving it created but
 * itemless — the exact sequence EI-8811 was filed against). `PHASE` now
 * `z.preprocess`-normalizes the input (auto-prefixing "Phase — " when needed)
 * BEFORE the regex validates it, so the call succeeds with the caller's
 * intended phase name instead of failing on a naming-convention mismatch.
 */
import { describe, it, expect } from 'vitest';
import { PHASE, normalizePhaseHeadingInput } from '../add-item';

describe('normalizePhaseHeadingInput (EI-8811)', () => {
  it('leaves an already-valid "Phase ..." heading untouched', () => {
    expect(normalizePhaseHeadingInput('Phase 1 — Tooling')).toBe('Phase 1 — Tooling');
  });

  it('is case-insensitive on the "Phase" prefix (matches the parser regex)', () => {
    expect(normalizePhaseHeadingInput('phase 2 — beta')).toBe('phase 2 — beta');
  });

  it('auto-prefixes a natural phase name that does not start with "Phase"', () => {
    expect(normalizePhaseHeadingInput('Baseline')).toBe('Phase — Baseline');
  });

  it('trims surrounding whitespace before prefixing', () => {
    expect(normalizePhaseHeadingInput('  Baseline  ')).toBe('Phase — Baseline');
  });

  it('passes non-string values through unchanged (regex validation still catches them)', () => {
    expect(normalizePhaseHeadingInput(undefined)).toBeUndefined();
    expect(normalizePhaseHeadingInput(null)).toBeNull();
    expect(normalizePhaseHeadingInput(42)).toBe(42);
  });
});

describe('PHASE schema (EI-8811) — end-to-end via z.preprocess', () => {
  it('accepts a natural phase name that previously hard-rejected, auto-prefixing it', () => {
    expect(PHASE.parse('Baseline')).toBe('Phase — Baseline');
  });

  it('still accepts a well-formed "Phase ..." heading unchanged', () => {
    expect(PHASE.parse('Phase 1 — Tooling')).toBe('Phase 1 — Tooling');
  });

  it('still rejects an empty string (min(1) on the inner schema still applies)', () => {
    expect(() => PHASE.parse('')).toThrow();
  });
});
