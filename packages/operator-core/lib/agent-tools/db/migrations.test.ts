/**
 * db:migrations — plan sql-escape-tool-routing-2026-08-12 P-003.
 *
 * The behaviour under test is the ZERO-ROWS verdict, because that is the only
 * thing this tool does that the raw SQL it replaces cannot: an empty
 * `SELECT ... WHERE filename LIKE '795%'` is ambiguous between "not applied
 * yet", "authored but never armed", and "wrong number", and an agent that
 * reads it as the first waits forever for a migration that will never run.
 */

import { describe, it, expect } from 'vitest';
import { toFilenamePattern, classifyMissing } from './migrations';

describe('toFilenamePattern', () => {
  it('treats a bare migration number as a PREFIX — the dominant corpus shape', () => {
    // Corpus: WHERE filename LIKE '727%' / '774%' / '566%'. A caller passing
    // '795' means migration 795, not a file named exactly "795".
    expect(toFilenamePattern('795')).toBe('795%');
    expect(toFilenamePattern('72')).toBe('72%');
  });

  it('prefixes a partial filename too', () => {
    expect(toFilenamePattern('795-agent-facts')).toBe('795-agent-facts%');
  });

  it('honours an explicit LIKE pattern verbatim', () => {
    // Corpus: ILIKE '%797%' — a caller who wrote wildcards meant them.
    expect(toFilenamePattern('%797%')).toBe('%797%');
    expect(toFilenamePattern('795-%')).toBe('795-%');
    expect(toFilenamePattern('79_')).toBe('79_');
  });
});

describe('classifyMissing', () => {
  it('says UNKNOWN when no sql dir resolved — never "no such migration"', () => {
    // The false-negative this guards: with no dir to scan we cannot tell
    // pending from absent, and claiming absence would be a confident wrong
    // answer. Asserted on the verdict AND on the note not claiming absence.
    const r = classifyMissing([], false);
    expect(r.verdict).toBe('unknown');
    expect(r.note).toMatch(/not a claim/i);
  });

  it('says NO-SUCH-MIGRATION when the dir resolved and holds no such file', () => {
    const r = classifyMissing([], true);
    expect(r.verdict).toBe('no-such-migration');
  });

  it('says PENDING when an armed .sql file exists but has not run', () => {
    const r = classifyMissing(['795-agent-facts-volatile-measurements.sql'], true);
    expect(r.verdict).toBe('pending');
    expect(r.note).toContain('795-agent-facts-volatile-measurements.sql');
  });

  it('distinguishes a .DRAFT file — it will NEVER apply on its own', () => {
    // The runner only applies *.sql, so waiting on a .DRAFT is waiting
    // forever. Reporting this as `pending` would send an agent to
    // db:check_drift / a restart, neither of which can ever help.
    const r = classifyMissing(['800-new-thing.sql.DRAFT'], true);
    expect(r.verdict).toBe('draft-not-armed');
    expect(r.note).toMatch(/never apply/i);
  });

  it('treats .PENDING-CODE-DEPLOY as unarmed for the same reason', () => {
    const r = classifyMissing(['801-later.sql.PENDING-CODE-DEPLOY'], true);
    expect(r.verdict).toBe('draft-not-armed');
  });

  it('prefers PENDING when an armed file sits beside a draft', () => {
    // A real case: NNN-foo.sql armed while NNN-foo.sql.DRAFT lingers. The
    // armed one is what will run, so the actionable verdict is pending.
    const r = classifyMissing(['802-x.sql', '802-x.sql.DRAFT'], true);
    expect(r.verdict).toBe('pending');
    expect(r.note).toContain('802-x.sql');
    expect(r.note).not.toContain('.DRAFT');
  });

  it('every verdict carries a non-empty note — the verdict alone is not actionable', () => {
    const cases = [classifyMissing([], false), classifyMissing([], true), classifyMissing(['9-a.sql'], true), classifyMissing(['9-a.sql.DRAFT'], true)];
    for (const c of cases) expect(c.note.length).toBeGreaterThan(20);
  });
});
