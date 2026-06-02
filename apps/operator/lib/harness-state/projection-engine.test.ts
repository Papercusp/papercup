import { describe, it, expect } from 'vitest';
import {
  PEER_LOG_TAG_TO_TABLE,
  checkPeerLogConsistency,
  checkInventoryCoverage,
  syncAuthorityFor,
} from './projection-engine';
import { PEER_LOG_TABLES } from './table-registry';
// The real hand-wired tags — drift guard cross-checks against the actual substrate registry.
import { REGISTERED_PROJECTION_TAGS } from '../sync/hyperbee/projections/register-all';

describe('harness-state projection-engine (P-003a)', () => {
  it('peer-log tag→table map is bijective with the registry sync:peer-log set', () => {
    const mappedTables = new Set(Object.values(PEER_LOG_TAG_TO_TABLE));
    expect(mappedTables).toEqual(new Set(PEER_LOG_TABLES));
  });

  it('checkPeerLogConsistency is GREEN against the real REGISTERED_PROJECTION_TAGS', () => {
    const c = checkPeerLogConsistency(REGISTERED_PROJECTION_TAGS);
    expect(c.missingProjection).toEqual([]);
    expect(c.orphanTag).toEqual([]);
    expect(c.ok).toBe(true);
  });

  it('detects a peer-log table that lost its projection (missingProjection)', () => {
    // drop one tag → its table is now unprojected
    const c = checkPeerLogConsistency(REGISTERED_PROJECTION_TAGS.filter((t) => t !== 'prs'));
    expect(c.ok).toBe(false);
    expect(c.missingProjection).toContain('harness_feature_prs');
  });

  it('detects a projection tag with no registry peer-log entry (orphanTag)', () => {
    const c = checkPeerLogConsistency([...REGISTERED_PROJECTION_TAGS, 'made-up-tag']);
    expect(c.ok).toBe(false);
    expect(c.orphanTag).toContain('made-up-tag');
  });

  it('checkInventoryCoverage surfaces unclassified + default fall-through', () => {
    const cov = checkInventoryCoverage([
      'harness_features_consolidated', // peer-log
      'harness_decisions',             // git
      'operator_preferences',          // workspace-owned
      'agent_runs_consolidated',       // default
      'brand_new_unclassified',        // default (surfaced)
    ]);
    expect(cov.total).toBe(5);
    expect(cov.unreviewed).toEqual([]); // NEEDS_REVIEW empty at P-002 close
    expect(cov.defaulted).toContain('brand_new_unclassified');
    expect(cov.byBucket['slug-shared/peer-log']).toBe(1);
  });

  it('syncAuthorityFor routes by registry classification', () => {
    expect(syncAuthorityFor('harness_features_consolidated')).toBe('peer-log');
    expect(syncAuthorityFor('harness_decisions')).toBe('git');
    expect(syncAuthorityFor('operator_preferences')).toBe('none');
    expect(syncAuthorityFor('agent_runs_consolidated')).toBe('none');
  });
});
