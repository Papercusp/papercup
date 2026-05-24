import { describe, expect, it } from 'vitest';
import { DOGFOOD_REACTIVE_TABLES, EXISTING_HYPERBEE_REACTIVE_TABLES } from './ensure-schema-dogfood';

/**
 * Structural sanity tests for ensure-schema-dogfood — purely about
 * the exported constant arrays, no PG needed.
 *
 * Live PG behavior (CREATE TABLE IF NOT EXISTS + trigger attach) is
 * covered by `scripts/verify-trigger-consolidation.mjs` against an
 * embedded PG18.
 */
describe('DOGFOOD_REACTIVE_TABLES', () => {
  it('contains the 13 dogfood tables (12 from initial set + shared_repo_binding_cache)', () => {
    expect(DOGFOOD_REACTIVE_TABLES).toHaveLength(13);
  });

  it('includes shared_repo_binding_cache (Phase 1a P-013a)', () => {
    expect(DOGFOOD_REACTIVE_TABLES).toContain('shared_repo_binding_cache');
  });

  it('has no duplicate entries', () => {
    const seen = new Set(DOGFOOD_REACTIVE_TABLES);
    expect(seen.size).toBe(DOGFOOD_REACTIVE_TABLES.length);
  });

  it('every entry is a valid snake_case PG table identifier', () => {
    for (const name of DOGFOOD_REACTIVE_TABLES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(name.length).toBeGreaterThan(2);
      expect(name.length).toBeLessThan(64); // PG identifier limit
    }
  });
});

describe('EXISTING_HYPERBEE_REACTIVE_TABLES', () => {
  it('contains the 4 pre-existing HYPERBEE consolidated tables (P-019 part 2)', () => {
    expect(EXISTING_HYPERBEE_REACTIVE_TABLES).toEqual([
      'harness_features_consolidated',
      'harness_issues_consolidated',
      'coord_presence',
      'harness_feature_prs',
    ]);
  });

  it('has no duplicate entries', () => {
    const seen = new Set(EXISTING_HYPERBEE_REACTIVE_TABLES);
    expect(seen.size).toBe(EXISTING_HYPERBEE_REACTIVE_TABLES.length);
  });
});

describe('DOGFOOD_REACTIVE_TABLES ∩ EXISTING_HYPERBEE_REACTIVE_TABLES', () => {
  it('the two sets are disjoint (no double-attached triggers)', () => {
    const a: readonly string[] = DOGFOOD_REACTIVE_TABLES;
    const b: ReadonlySet<string> = new Set<string>(EXISTING_HYPERBEE_REACTIVE_TABLES);
    for (const x of a) {
      expect(b.has(x)).toBe(false);
    }
  });
});
