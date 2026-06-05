/**
 * P-038 (Phase 8) — working_users projection reconciliation against Model B.
 *
 * The Model-B `feature_working_set` pointer table is the per-(user, feature)
 * Hyperbee-synced detail layer; the CANONICAL "working_users projection" per
 * v5 §0.5 / §7.1 / D-016 is the `harness_features_consolidated.working_users`
 * BIGINT[] array (with `current_worker = working_users[0]` DERIVED). That
 * array is what the UI's already-wired `featuresConsolidated.bySlug` SSE query
 * carries — so the working-set projection must keep it in sync.
 *
 * These tests cover the pure recompute helper that rebuilds the canonical
 * array from the live (non-cleared) pointer rows on every put/del.
 */

import { describe, expect, it } from 'vitest';
import { buildRecomputeWorkingUsersQuery } from '../feature-working-set';

describe('buildRecomputeWorkingUsersQuery — working_users[] reconciliation', () => {
  it('parameterizes workspace, harness, feature', () => {
    const { query, params } = buildRecomputeWorkingUsersQuery({
      workspaceId: 'w-1',
      harnessSlug: 'sheets',
      featureId: 'F-001',
    });
    expect(params).toEqual(['w-1', 'sheets', 'F-001']);
    expect(query).toContain('UPDATE harness_shared.harness_features_consolidated');
    // Targets the right row.
    expect(query).toContain('harness_slug = $2');
    expect(query).toContain('feature_id = $3');
  });

  it('derives the array from non-cleared pointer rows of feature_working_set', () => {
    const { query } = buildRecomputeWorkingUsersQuery({
      workspaceId: 'w-1',
      harnessSlug: 'sheets',
      featureId: 'F-001',
    });
    // Sub-select reads the live pointer table…
    expect(query).toContain('harness_shared.feature_working_set');
    // …only the still-active (non-tombstoned) rows count…
    expect(query).toContain('cleared_at IS NULL');
    // …and the same (workspace, harness, feature) scope is applied to the
    // pointer sub-select so cross-feature/cross-harness rows never leak in.
    expect(query).toContain('SET working_users');
  });

  it('orders the array by started_at so working_users[0] is the earliest worker (current_worker per D-016)', () => {
    const { query } = buildRecomputeWorkingUsersQuery({
      workspaceId: 'w-1',
      harnessSlug: 'sheets',
      featureId: 'F-001',
    });
    expect(query).toContain('ORDER BY');
    expect(query).toContain('started_at');
  });

  it('coalesces to an empty array when no one is working (never leaves NULL)', () => {
    const { query } = buildRecomputeWorkingUsersQuery({
      workspaceId: 'w-1',
      harnessSlug: 'sheets',
      featureId: 'F-001',
    });
    expect(query).toMatch(/COALESCE/i);
    // BIGINT[] empty-array literal, not jsonb.
    expect(query).toContain("'{}'");
  });
});
