/**
 * pattern.test — pattern/wildcard awaits (P-201). Pure; no DB.
 *
 * Asserts the glob↔mingo bridge: pattern classification, macro expansion (grounded
 * on the catalog key schemes), the anchored `matches` compilation, exact-vs-pattern
 * matching via @papercusp/rules' evaluator, and the too-broad guard.
 */
import { describe, it, expect } from 'vitest';
import {
  isPattern,
  expandPatternMacro,
  patternToOperatorTest,
  keyMatchesPattern,
  assertUsablePattern,
} from './pattern';

describe('isPattern', () => {
  it('flags globs and @macros; exact keys are not patterns', () => {
    expect(isPattern('work-item:done:*')).toBe(true);
    expect(isPattern('@plan:my-plan')).toBe(true);
    expect(isPattern('@fleet:red')).toBe(true);
    expect(isPattern('work-item:done:WI-12')).toBe(false);
    expect(isPattern('session:compacted:su-94b69')).toBe(false);
    expect(isPattern('lock:grant:t1')).toBe(false);
  });
});

describe('expandPatternMacro', () => {
  it('@plan:<slug> → plan-item:done:<slug>:* (grounded on the catalog scheme)', () => {
    expect(expandPatternMacro('@plan:event-await-2026-07-03')).toBe(
      'plan-item:done:event-await-2026-07-03:*',
    );
  });
  it('@fleet:<slug> → fleet:*:<slug>', () => {
    expect(expandPatternMacro('@fleet:fed-scout-gym-r2')).toBe('fleet:*:fed-scout-gym-r2');
  });
  it('passes a raw glob or exact key through unchanged', () => {
    expect(expandPatternMacro('work-item:done:*')).toBe('work-item:done:*');
    expect(expandPatternMacro('lock:grant:t1')).toBe('lock:grant:t1');
  });
  it('throws loudly on an unknown macro (a typo must not store a dead key)', () => {
    expect(() => expandPatternMacro('@plann:foo')).toThrow(/unknown pattern macro/);
    expect(() => expandPatternMacro('@bogus')).toThrow(/unknown pattern macro/);
  });
});

describe('patternToOperatorTest', () => {
  it('compiles to an anchored matches regex with * → .* and literals escaped', () => {
    expect(patternToOperatorTest('work-item:done:*')).toEqual({ matches: '^work-item:done:.*$' });
    // a literal regex metachar in the glob is escaped, not interpreted
    expect(patternToOperatorTest('a.b:*')).toEqual({ matches: '^a\\.b:.*$' });
  });
});

describe('keyMatchesPattern (reuses the @papercusp/rules mingo matcher)', () => {
  it('a glob matches every key in its family, and only that family', () => {
    expect(keyMatchesPattern('work-item:done:*', 'work-item:done:WI-123')).toBe(true);
    expect(keyMatchesPattern('work-item:done:*', 'work-item:done:WI-9')).toBe(true);
    expect(keyMatchesPattern('work-item:done:*', 'work-item:status:WI-9')).toBe(false);
    expect(keyMatchesPattern('work-item:done:*', 'plan-item:done:p:P-1')).toBe(false);
  });
  it('is anchored — a prefix glob does NOT match a longer unrelated key', () => {
    expect(keyMatchesPattern('work-item:done:*', 'xwork-item:done:WI-1')).toBe(false);
  });
  it('@plan macro matches any item finishing in that plan (the headline use case)', () => {
    expect(keyMatchesPattern('@plan:my-plan', 'plan-item:done:my-plan:P-014')).toBe(true);
    expect(keyMatchesPattern('@plan:my-plan', 'plan-item:done:other-plan:P-014')).toBe(false);
  });
  it('@fleet macro matches any fleet event for the slug', () => {
    expect(keyMatchesPattern('@fleet:red', 'fleet:drained:red')).toBe(true);
    expect(keyMatchesPattern('@fleet:red', 'fleet:drained:blue')).toBe(false);
  });
  it('a mid-key wildcard matches across one segment', () => {
    expect(keyMatchesPattern('fleet:*:red', 'fleet:drained:red')).toBe(true);
  });
  it('an exact (non-pattern) key degrades to string equality', () => {
    expect(keyMatchesPattern('lock:grant:t1', 'lock:grant:t1')).toBe(true);
    expect(keyMatchesPattern('lock:grant:t1', 'lock:grant:t2')).toBe(false);
  });
});

describe('assertUsablePattern', () => {
  it('accepts an anchored glob', () => {
    expect(() => assertUsablePattern('work-item:done:*')).not.toThrow();
    expect(() => assertUsablePattern('fleet:*:red')).not.toThrow();
  });
  it('rejects a wildcard-only / near-empty pattern that would wake-storm', () => {
    expect(() => assertUsablePattern('*')).toThrow(/too broad/);
    expect(() => assertUsablePattern('*:*')).toThrow(/too broad/);
  });
});
