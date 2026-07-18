/**
 * issue-cols-parity.test.ts — runtime half of the ISSUE_COLS / IssueRowDb drift guard
 * (EI-10489).
 *
 * `ISSUE_COLS` (the SELECT allowlist every issue query in issues-engineer.ts uses) and
 * `IssueRowDb` (its TS shape) used to be two independently hand-maintained lists of the
 * same 26 columns — a mismatch silently degraded a real field to `undefined` at runtime,
 * with no compile error and no test failure. `ISSUE_ROW_DB_KEYS` (issues-engineer.ts) is
 * compile-time-locked to `IssueRowDb`'s own keys (see its doc comment); this test closes
 * the loop by asserting `ISSUE_COLS` names EXACTLY those columns — so a change to either
 * side alone now fails loudly instead of silently.
 */
import { describe, it, expect } from 'vitest';
import { ISSUE_COLS, ISSUE_ROW_DB_KEYS } from './issues-engineer';

describe('ISSUE_COLS / IssueRowDb parity guard (EI-10489)', () => {
  it('ISSUE_COLS names exactly the columns in ISSUE_ROW_DB_KEYS', () => {
    const parsed = ISSUE_COLS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(new Set(parsed)).toEqual(new Set(ISSUE_ROW_DB_KEYS));
  });

  it('has no duplicate columns', () => {
    const parsed = ISSUE_COLS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(parsed.length).toBe(new Set(parsed).size);
  });
});
