/**
 * issues:list — plan sql-escape-tool-routing-2026-08-12 P-006.
 *
 * The scope normaliser is the piece with a documented silent-failure mode:
 * `harness_shared.engineer_issues.scope` is 'harness:<slug>' | 'operator' and
 * has NO counterpart on the underlying work_items table, so a bare slug
 * matches ZERO rows instead of erroring. Every other filter is passed straight
 * through to the already-tested listIssues layer.
 */

import { describe, it, expect } from 'vitest';
import { normalizeScope } from './list';

describe('normalizeScope', () => {
  it('prefixes a bare harness slug — a bare slug silently matches nothing on this view', () => {
    expect(normalizeScope('papercusp')).toBe('harness:papercusp');
  });

  it('leaves an already-qualified scope alone', () => {
    expect(normalizeScope('harness:papercusp')).toBe('harness:papercusp');
  });

  it("leaves the non-harness scope 'operator' alone", () => {
    // 'operator' is a real scope value, NOT a harness slug — prefixing it
    // would turn a valid filter into one that matches nothing.
    expect(normalizeScope('operator')).toBe('operator');
  });

  it('leaves any other already-namespaced scope alone', () => {
    expect(normalizeScope('hive:something')).toBe('hive:something');
  });

  it('tolerates surrounding whitespace', () => {
    expect(normalizeScope('  papercusp  ')).toBe('harness:papercusp');
  });
});
