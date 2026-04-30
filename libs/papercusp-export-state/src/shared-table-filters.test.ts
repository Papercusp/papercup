import { describe, expect, it } from 'vitest';
import {
  SHARED_TABLE_FILTERS,
  assertValidSlug,
  excludedSharedTables,
  findSharedTableFilter,
  includedSharedTables,
} from './shared-table-filters';

describe('shared-table-filter registry', () => {
  it('covers every harness_shared.* table the codebase declares', () => {
    // Snapshot the registry's table list. CI check at §15.22 enforces that
    // any new `CREATE TABLE harness_shared.X` in libs/papercusp/libs/db/sql/*
    // also appears here. This test pins the current set so a removal at
    // least bubbles up as a test failure.
    expect(SHARED_TABLE_FILTERS.map((f) => f.table).sort()).toEqual([
      'audit_log',
      'goals',
      'harness_features_consolidated',
      'pending_events',
      'project_spec_revisions',
      'projects',
      'routines',
    ]);
  });

  it('every entry has either include with a non-trivial filter or explicit exclude with reason', () => {
    for (const e of SHARED_TABLE_FILTERS) {
      if (e.mode === 'include') {
        const sql = e.filter('test-slug');
        expect(typeof sql).toBe('string');
        expect(sql.length).toBeGreaterThan(0);
      } else {
        expect(e.reason).toBeTruthy();
      }
    }
  });

  it('lookup by table works', () => {
    expect(findSharedTableFilter('projects')?.mode).toBe('include');
    expect(findSharedTableFilter('audit_log')?.mode).toBe('exclude');
    expect(findSharedTableFilter('nonexistent')).toBeUndefined();
  });

  it('include/exclude partitioning is consistent', () => {
    const inc = includedSharedTables();
    const exc = excludedSharedTables();
    expect(inc.length + exc.length).toBe(SHARED_TABLE_FILTERS.length);
    expect(inc.every((t) => t.mode === 'include')).toBe(true);
    expect(exc.every((t) => t.mode === 'exclude')).toBe(true);
  });

  it('forkPrefixIds tables list FK refs in per-harness schema', () => {
    for (const e of SHARED_TABLE_FILTERS) {
      if (e.forkPrefixIds) {
        expect(e.fkRefsInPerHarness?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('filters template the slug as a single-quoted SQL literal', () => {
    const goalsFilter = findSharedTableFilter('goals')!.filter('mySlug');
    expect(goalsFilter).toContain("'mySlug'");
  });
});

describe('assertValidSlug', () => {
  it('accepts conventional slugs', () => {
    expect(() => assertValidSlug('sheets')).not.toThrow();
    expect(() => assertValidSlug('papercup-coding')).not.toThrow();
    expect(() => assertValidSlug('a.b_c-1')).not.toThrow();
  });
  it('rejects empty / whitespace / SQL-injection-shaped strings', () => {
    expect(() => assertValidSlug('')).toThrow();
    expect(() => assertValidSlug("foo'; DROP")).toThrow();
    expect(() => assertValidSlug('-leading-dash')).toThrow();
    expect(() => assertValidSlug('a'.repeat(65))).toThrow();
  });
});
