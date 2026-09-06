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
  payloadMatchesFilter,
  patternLiteralPrefix,
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

describe('payloadMatchesFilter (EI-8998 — predicate/payload watches)', () => {
  it('a null/undefined filter always matches (no predicate registered)', () => {
    expect(payloadMatchesFilter(null, { queue_depth: 99 })).toBe(true);
    expect(payloadMatchesFilter(undefined, undefined)).toBe(true);
  });
  it('evaluates the $-free OperatorTest vocabulary (lt/gte/…) against a payload field', () => {
    expect(payloadMatchesFilter({ queue_depth: { lt: 5 } }, { queue_depth: 3 })).toBe(true);
    expect(payloadMatchesFilter({ queue_depth: { lt: 5 } }, { queue_depth: 9 })).toBe(false);
  });
  it('matches legacy eq/ne aliases on a grading-integrity scorecard event payload', () => {
    const subjectRef = 'EI-22437875427583069';
    const emitted = {
      issueId: 'EI-22439061823369551',
      rubricRef: 'grading-integrity',
      subjectRef,
    };

    // This is the durable shape from await 152428. It must fire for the exact
    // subject instead of timing out, while a neighboring subject stays quiet.
    expect(payloadMatchesFilter({ subjectRef: { eq: subjectRef } }, emitted)).toBe(true);
    expect(payloadMatchesFilter({ subjectRef: { eq: subjectRef } }, { ...emitted, subjectRef: 'other' })).toBe(false);
    expect(payloadMatchesFilter({ subjectRef: { ne: 'other' } }, emitted)).toBe(true);
    expect(payloadMatchesFilter({ subjectRef: { ne: subjectRef } }, emitted)).toBe(false);
  });
  it('supports the all/any/not combinators (same vocabulary as an ECA rule when)', () => {
    const filter = { all: [{ status: 'red' }, { severity: { gte: 3 } }] };
    expect(payloadMatchesFilter(filter, { status: 'red', severity: 4 })).toBe(true);
    expect(payloadMatchesFilter(filter, { status: 'red', severity: 1 })).toBe(false);
    expect(payloadMatchesFilter(filter, { status: 'green', severity: 4 })).toBe(false);
  });
  it('a payload missing the tested field fails the predicate rather than throwing', () => {
    expect(payloadMatchesFilter({ queue_depth: { lt: 5 } }, {})).toBe(false);
    expect(payloadMatchesFilter({ queue_depth: { lt: 5 } }, null)).toBe(false);
  });
  it('a non-object filter (string/number/array) is rejected up front, never vacuously true', () => {
    expect(payloadMatchesFilter('not-an-object', { x: 1 })).toBe(false);
    expect(payloadMatchesFilter(42, { x: 1 })).toBe(false);
    expect(payloadMatchesFilter(['also', 'not', 'an', 'object'], { x: 1 })).toBe(false);
  });
  it('a malformed operand inside an otherwise-valid filter degrades to false rather than throwing', () => {
    // an unterminated regex source is an author bug mingo's compiler rejects at build time
    expect(payloadMatchesFilter({ name: { matches: '[' } }, { name: 'x' })).toBe(false);
  });
});

describe('patternLiteralPrefix (EI-19332682533219755)', () => {
  it('anchors on the literal segment before the first wildcard', () => {
    expect(patternLiteralPrefix('release:green:*')).toBe('release:green');
    expect(patternLiteralPrefix('work-item:done:*')).toBe('work-item:done');
    expect(patternLiteralPrefix('fleet:*:my-slug')).toBe('fleet');
  });

  it('returns no prefix when the glob leads with a wildcard, so a caller cannot turn it into an unbounded scan', () => {
    expect(patternLiteralPrefix('*')).toBe('');
    expect(patternLiteralPrefix('*:papercusp')).toBe('');
  });

  it('trims back to a whole segment rather than cutting mid-segment', () => {
    // 'release:gre*' must not anchor on 'release:gre' — a prefix scan on a partial
    // segment silently under-matches the keys the glob really covers.
    expect(patternLiteralPrefix('release:gre*')).toBe('release');
  });

  it('passes an exact (wildcard-free) key through whole', () => {
    expect(patternLiteralPrefix('release:green:papercusp')).toBe('release:green');
    expect(patternLiteralPrefix('bare')).toBe('bare');
  });

  it('is defensive about a non-string key, like its siblings on the emit path', () => {
    expect(patternLiteralPrefix(undefined as unknown as string)).toBe('');
    expect(patternLiteralPrefix(null as unknown as string)).toBe('');
  });

  it('the incident glob really does cross pipelines — the regression this exists to disclose', () => {
    // EI-19332682533219755: `release:green:*` was armed meaning "MY gate went
    // green" and woke on a co-hosted foreign project's verdict instead.
    expect(keyMatchesPattern('release:green:*', 'release:green:papercusp')).toBe(true);
    expect(keyMatchesPattern('release:green:*', 'release:green:oddsmith')).toBe(true);
    // ...and both live under one anchorable prefix, so the disclosure probe can
    // find them with a single index-backed range read.
    expect(patternLiteralPrefix('release:green:*')).toBe('release:green');
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
