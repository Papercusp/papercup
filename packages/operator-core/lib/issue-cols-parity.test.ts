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
import {
  ISSUE_COLS,
  ISSUE_COLS_BODYLESS,
  ISSUE_COLS_PAYLOADLESS,
  ISSUE_COLS_BODYLESS_PAYLOADLESS,
  ISSUE_ROW_DB_KEYS,
  issueListColumns,
} from './issues-engineer';

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

/**
 * ISSUE_COLS_BODYLESS — the P-008 projection (db-performance-remediation-2026-07-26,
 * D-010) for readers that provably never touch `body`.
 *
 * It is DERIVED from ISSUE_COLS by substitution rather than written out, precisely so
 * the EI-10489 guard above keeps covering it. These assertions pin that derivation: the
 * failure they exist to catch is a future column being added to ISSUE_COLS while the
 * bodyless variant silently stops matching the row shape — the same class of silent
 * `undefined` degradation EI-10489 was filed for.
 */
describe('ISSUE_COLS_BODYLESS — the P-008 body projection', () => {
  const cols = (s: string) =>
    s
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

  it('selects the same number of columns, in the same positions', () => {
    // Same arity + same order is what keeps `IssueRowDb` (and every consumer's
    // destructuring) valid for both variants — this is a payload optimization,
    // never a different row shape.
    expect(cols(ISSUE_COLS_BODYLESS).length).toBe(cols(ISSUE_COLS).length);
  });

  it('replaces ONLY body, leaving every other column untouched', () => {
    const before = cols(ISSUE_COLS);
    const after = cols(ISSUE_COLS_BODYLESS);
    const differing = before.map((c, i) => [c, after[i]] as const).filter(([b, a]) => b !== a);
    expect(differing).toEqual([['body', 'NULL::text AS body']]);
  });

  it('still names `body` as the output column, so the row shape is unchanged', () => {
    // A consumer reading r.body must keep getting a `body` key (empty), never
    // `undefined` from a renamed/missing column.
    expect(ISSUE_COLS_BODYLESS).toMatch(/\bAS body\b/);
    expect(cols(ISSUE_COLS_BODYLESS)).toContain('NULL::text AS body');
  });

  it('is actually different from ISSUE_COLS — the substitution matched', () => {
    // Guards the regex itself: a reformat of ISSUE_COLS (e.g. body moving to the
    // first or last position) that stopped matching would silently make this a
    // no-op alias, and the "projection" would ship the full body forever.
    expect(ISSUE_COLS_BODYLESS).not.toBe(ISSUE_COLS);
    expect(ISSUE_COLS_BODYLESS).not.toMatch(/(^|,)\s*body\s*,/);
  });
});

describe('WI-42508 lean issue list projections', () => {
  const cols = (s: string) =>
    s
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

  it('keeps the full row arity and aliases payload back to its original key', () => {
    expect(cols(ISSUE_COLS_PAYLOADLESS).length).toBe(cols(ISSUE_COLS).length);
    expect(ISSUE_COLS_PAYLOADLESS).toContain('NULL::jsonb AS payload');
    expect(cols(ISSUE_COLS_PAYLOADLESS).filter((c) => c === 'payload')).toHaveLength(0);
  });

  it('combines body + payload omission without changing any other position', () => {
    const before = cols(ISSUE_COLS);
    const after = cols(ISSUE_COLS_BODYLESS_PAYLOADLESS);
    expect(after.length).toBe(before.length);
    const differing = before
      .map((c, i) => [c, after[i]] as const)
      .filter(([b, a]) => b !== a);
    expect(differing).toEqual([
      ['body', 'NULL::text AS body'],
      ['payload', 'NULL::jsonb AS payload'],
    ]);
  });

  it('selects full, bodyless, payloadless, and combined variants deterministically', () => {
    expect(issueListColumns({})).toBe(ISSUE_COLS);
    expect(issueListColumns({ includeBody: false })).toBe(ISSUE_COLS_BODYLESS);
    expect(issueListColumns({ includePayload: false })).toBe(ISSUE_COLS_PAYLOADLESS);
    expect(issueListColumns({ includeBody: false, includePayload: false })).toBe(
      ISSUE_COLS_BODYLESS_PAYLOADLESS,
    );
  });
});
