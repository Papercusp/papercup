/**
 * code-cleanup-campaigns-2026-10-26 P-003 (R-3): item kind 'cleanup' is issue-family.
 *
 * Guards the ONE exported list and every hand-maintained copy of it: source copies are
 * ratcheted against a shrink-only baseline (cleanup-item-kind.baseline.json) until none is
 * left; SQL copies were extended by migration 1590, and any later migration that spells
 * the three-kind list without 'cleanup' fails here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ISSUE_FAMILY_ROUTE_KINDS } from '../work-nature/agent-work-predicate';
import { ISSUE_FAMILY_KINDS } from '../work-items';
import {
  CLEANUP_IS_ISSUE_FAMILY,
  CLEANUP_ITEM_KIND,
  censusHardcodedIssueFamilyLists,
  countBareIssueFamilyTriples,
  isCleanupKind,
} from './cleanup-item-kind';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SQL_DIR = join(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const BASELINE: Record<string, number> = JSON.parse(
  readFileSync(new URL('./cleanup-item-kind.baseline.json', import.meta.url), 'utf8'),
);

describe('cleanup item kind', () => {
  it('is routed with the issue family through the one exported list', () => {
    expect(CLEANUP_ITEM_KIND).toBe('cleanup');
    expect(ISSUE_FAMILY_ROUTE_KINDS).toContain('cleanup');
    expect(ISSUE_FAMILY_KINDS).toContain('cleanup');
    expect(CLEANUP_IS_ISSUE_FAMILY).toBe(true);
    expect(isCleanupKind('cleanup')).toBe(true);
    expect(isCleanupKind('change')).toBe(false);
    expect(isCleanupKind(null)).toBe(false);
  });

  it('counts a bare three-kind list in every spelling and skips extended lists and comments', () => {
    expect(countBareIssueFamilyTriples("const k = ['bug', 'change', 'task'];")).toBe(1);
    expect(countBareIssueFamilyTriples("WHERE item_kind IN ('bug','change','task')")).toBe(1);
    expect(countBareIssueFamilyTriples(`x = ["bug", "change", "task"]`)).toBe(1);
    expect(countBareIssueFamilyTriples("ARRAY['bug'::text, 'change'::text, 'task'::text]")).toBe(1);
    expect(countBareIssueFamilyTriples("['bug', 'change', 'task', 'cleanup']")).toBe(0);
    expect(countBareIssueFamilyTriples("ARRAY['bug'::text, 'change'::text, 'task'::text, 'cleanup'::text]")).toBe(0);
    expect(countBareIssueFamilyTriples(" * e.g. item_kind IN ('bug', 'change', 'task')")).toBe(0);
    expect(countBareIssueFamilyTriples("// ['bug', 'change', 'task']")).toBe(0);
    expect(countBareIssueFamilyTriples("['bug', 'change']")).toBe(0);
  });

  it('never adds a hand-maintained copy of the issue-family list (shrink-only baseline)', () => {
    const census = censusHardcodedIssueFamilyLists(REPO_ROOT);
    const grown = Object.entries(census)
      .filter(([file, n]) => n > (BASELINE[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} (baseline ${BASELINE[file] ?? 0})`);
    expect(
      grown,
      `route these through ISSUE_FAMILY_ROUTE_KINDS / issueFamilyRouteSql instead of a literal list`,
    ).toEqual([]);
    const shrunk = Object.entries(BASELINE)
      .filter(([file, n]) => (census[file] ?? 0) < n)
      .map(([file, n]) => `${file}: ${census[file] ?? 0} (baseline ${n})`);
    expect(shrunk, 'lower these baseline entries in cleanup-item-kind.baseline.json').toEqual([]);
  });

  it('SQL: the issue-family lists in migrations 866 and 965 use spellings migration 1590 extends', () => {
    const files = readdirSync(SQL_DIR);
    const named = (n: number) => files.find((f) => f.startsWith(`${n}-`) && f.endsWith('.sql'));
    expect(named(1590), 'migration 1590 (cleanup joins the issue family) must exist').toBeDefined();
    const surgery = readFileSync(join(SQL_DIR, named(1590)!), 'utf8');
    for (const n of [866, 965]) {
      const text = readFileSync(join(SQL_DIR, named(n)!), 'utf8');
      const spellings = [...text.matchAll(/'bug'(::text)?,(\s*)'change'(::text)?,\s*'task'(::text)?/g)].map((m) => m[0]);
      expect(spellings.length, `migration ${n} carries the issue-family list`).toBeGreaterThan(0);
      for (const s of spellings) {
        const escaped = s.replace(/'/g, "''").replace(/[()[\]]/g, (c) => `\\${c}`);
        expect(surgery.includes(escaped), `1590 extends the spelling ${s} used by ${n}`).toBe(true);
      }
    }
  });

  it('SQL: no migration after 1590 spells the issue-family list without cleanup', () => {
    const later = readdirSync(SQL_DIR)
      .filter((f) => /^\d+-.*\.sql$/.test(f) && Number.parseInt(f, 10) > 1590)
      .filter((f) => countBareIssueFamilyTriples(readFileSync(join(SQL_DIR, f), 'utf8')) > 0);
    expect(later).toEqual([]);
  });
});
