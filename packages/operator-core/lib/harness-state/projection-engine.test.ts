import { describe, it, expect } from 'vitest';
import {
  PEER_LOG_TAG_TO_TABLE,
  checkPeerLogConsistency,
  checkInventoryCoverage,
  syncAuthorityFor,
  projectionAdapterFor,
  routeProjection,
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
    const c = checkPeerLogConsistency(REGISTERED_PROJECTION_TAGS.filter((t) => t !== 'contributors'));
    expect(c.ok).toBe(false);
    expect(c.missingProjection).toContain('contributors');
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

  it('P-003c router maps each sync authority to exactly one adapter', () => {
    expect(projectionAdapterFor('harness_decisions')).toBe('git-export');
    expect(projectionAdapterFor('harness_features_consolidated')).toBe('peer-log');
    expect(projectionAdapterFor('operator_preferences')).toBe('local');
    expect(projectionAdapterFor('agent_runs_consolidated')).toBe('local');
    // the fs-mirror + retired org-demo we reclassified route to 'local', not git:
    expect(projectionAdapterFor('harness_branch_actions')).toBe('local');
    expect(projectionAdapterFor('messages')).toBe('local');
  });

  it('routeProjection partitions a live inventory across the 3 adapters (total + disjoint)', () => {
    const live = [
      'harness_decisions',              // git-export
      'harness_chunk_plans',            // git-export
      'harness_features_consolidated',  // peer-log
      'feature_queue',                  // peer-log
      'operator_preferences',           // local
      'agent_runs_consolidated',        // local
    ];
    const r = routeProjection(live, REGISTERED_PROJECTION_TAGS);
    expect(r.gitExport.sort()).toEqual(['harness_chunk_plans', 'harness_decisions']);
    expect(r.peerLog.sort()).toEqual(['feature_queue', 'harness_features_consolidated']);
    expect(r.local.sort()).toEqual(['agent_runs_consolidated', 'operator_preferences']);
    // total + disjoint partition: every input lands in exactly one bucket
    expect(r.gitExport.length + r.peerLog.length + r.local.length).toBe(live.length);
    // green peer-log guard → ok
    expect(r.ok).toBe(true);
  });

  it('routeProjection.ok goes false when the peer-log drift guard fails', () => {
    const r = routeProjection(['harness_decisions'], REGISTERED_PROJECTION_TAGS.filter((t) => t !== 'queue'));
    expect(r.ok).toBe(false);
    expect(r.peerLogConsistency.missingProjection).toContain('feature_queue');
  });
});
