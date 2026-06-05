import { describe, expect, it } from 'vitest';
import {
  IDENTITY_TRUST_TABLES,
  SHARED_TABLE_FILTERS,
  assertValidSlug,
  excludedSharedTables,
  findSharedTableFilter,
  includedSharedTables,
} from './shared-table-filters';

describe('shared-table-filter registry', () => {
  it('covers the harness_shared.* tables the capture logic classifies (include or explicit exclude)', () => {
    // The registry is the curated set of harness_shared tables the capture path
    // reasons about: include-with-slug-filter (captured) or explicit exclude
    // (deliberately skipped, with a cited reason + surfaced in manifest.excluded[]).
    // The identity/membership/trust/credential block was added 2026-06-04 to make
    // the D-011 "never portable" rule intentional, not incidental. Pin the set so an
    // addition/removal bubbles up at PR time.
    expect(SHARED_TABLE_FILTERS.map((f) => f.table).sort()).toEqual([
      'audit_log',
      'contributor_usage_events',
      'contributors',
      'goals',
      'harness_features_consolidated',
      'identity_files',
      'mobile_devices',
      'mobile_pair_tokens',
      'oauth_nonces',
      'operator_credentials',
      'operator_publish_credentials',
      'operator_search_provider_credentials',
      'operator_trust_store',
      'operator_voice_credentials',
      'pending_events',
      'project_spec_revisions',
      'projects',
      'routines',
      'snapshot_index',
      'trusted_authors',
      'work_items',
    ]);
  });

  it('excludes every identity/membership/trust/credential table (D-011 — never portable)', () => {
    const excludedNames = new Set(excludedSharedTables().map((f) => f.table));
    const includedNames = new Set(includedSharedTables().map((f) => f.table));
    for (const t of IDENTITY_TRUST_TABLES) {
      const f = findSharedTableFilter(t);
      expect(f, `${t} must be in the registry`).toBeDefined();
      expect(f!.mode, `${t} must be excluded, never captured`).toBe('exclude');
      expect(f!.reason, `${t} exclusion must cite a reason`).toBeTruthy();
      expect(excludedNames.has(t), `${t} must be on the exclude side`).toBe(true);
      expect(includedNames.has(t), `${t} must never be captured`).toBe(false);
    }
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
