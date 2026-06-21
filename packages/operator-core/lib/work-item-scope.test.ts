import { describe, expect, it } from 'vitest';
import { assertScopeWellFormed, harnessScope, harnessOfScope, OPERATOR_SCOPE } from './work-item-scope';

describe('work-item scope guards (unified-work-item-ledger P-001)', () => {
  describe('assertScopeWellFormed', () => {
    it('accepts the operator (global) scope', () => {
      expect(() => assertScopeWellFormed(OPERATOR_SCOPE)).not.toThrow();
    });
    it('accepts a well-formed harness scope', () => {
      expect(() => assertScopeWellFormed('harness:papercusp')).not.toThrow();
    });
    it('rejects an empty string', () => {
      expect(() => assertScopeWellFormed('')).toThrow(/non-empty string/);
    });
    it('rejects a whitespace-only string', () => {
      expect(() => assertScopeWellFormed('   ')).toThrow(/non-empty string/);
    });
    it('rejects a harness: prefix with an empty slug', () => {
      expect(() => assertScopeWellFormed('harness:')).toThrow(/non-empty harness slug/);
    });
    it('rejects a harness: prefix with a whitespace slug', () => {
      expect(() => assertScopeWellFormed('harness:   ')).toThrow(/non-empty harness slug/);
    });
  });

  describe('harnessScope', () => {
    it('maps null/undefined to the explicit operator scope', () => {
      expect(harnessScope(null)).toBe(OPERATOR_SCOPE);
      expect(harnessScope(undefined)).toBe(OPERATOR_SCOPE);
    });
    it('builds a harness scope from a slug', () => {
      expect(harnessScope('papercusp')).toBe('harness:papercusp');
    });
    it('trims the slug', () => {
      expect(harnessScope('  papercusp  ')).toBe('harness:papercusp');
    });
    it('throws on a blank harness (never silently collapses to operator)', () => {
      expect(() => harnessScope('')).toThrow(/blank harness/);
      expect(() => harnessScope('   ')).toThrow(/blank harness/);
    });
    it('produces scopes that pass the well-formed guard', () => {
      expect(() => assertScopeWellFormed(harnessScope('papercusp'))).not.toThrow();
      expect(() => assertScopeWellFormed(harnessScope(null))).not.toThrow();
    });
  });

  describe('harnessOfScope', () => {
    it('returns null for the operator scope', () => {
      expect(harnessOfScope(OPERATOR_SCOPE)).toBeNull();
    });
    it('returns the slug for a harness scope', () => {
      expect(harnessOfScope('harness:papercusp')).toBe('papercusp');
    });
    it('round-trips with harnessScope', () => {
      expect(harnessOfScope(harnessScope('papercusp'))).toBe('papercusp');
    });
  });
});
