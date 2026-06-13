import { describe, it, expect } from 'vitest';
import {
  LOG_FIRST_PRODUCED_TABLES,
  ACCEPTED_UNFEDERATED_TABLES,
  checkSubstrateCaptureCoverage,
} from '../capture-coverage';
import { CDC_CAPTURED_TABLES } from '../feature-issue-op-keys';
import { checkCaptureCoverage } from '../../../harness-state/projection-engine';
import { PEER_LOG_TABLES } from '../../../harness-state/table-registry';

/**
 * shared-hive-hardening-2026-06-13 P-011 — the write-side capture-coverage guard.
 * The EI-382 class at the data layer: a federated (`sync:'peer-log'`) table whose
 * local writes are never put onto the peer-log silently never federates. This
 * suite pins that EVERY peer-log table has exactly one producer.
 */
describe('substrate capture coverage (P-011)', () => {
  it('every sync:peer-log table has a producer — checkSubstrateCaptureCoverage is GREEN', () => {
    const cov = checkSubstrateCaptureCoverage();
    // A non-empty `uncaptured` is a real bug: a federated table whose writes
    // never reach the peer-log. If this fails after adding a peer-log table,
    // wire its producer (CDC trigger or log-first append) — or, if it genuinely
    // should not federate, add it to ACCEPTED_UNFEDERATED_TABLES with a reason.
    expect(cov.uncaptured).toEqual([]);
    expect(cov.doubleCaptured).toEqual([]);
    expect(cov.orphanProducer).toEqual([]);
    expect(cov.ok).toBe(true);
  });

  it('the three producer sets exactly partition PEER_LOG_TABLES (no gap, no overlap)', () => {
    const produced = new Set<string>([
      ...CDC_CAPTURED_TABLES,
      ...Object.keys(LOG_FIRST_PRODUCED_TABLES),
      ...Object.keys(ACCEPTED_UNFEDERATED_TABLES),
    ]);
    expect(produced).toEqual(new Set(PEER_LOG_TABLES));
    // Partition is disjoint: a table is captured by exactly one mechanism.
    const total =
      CDC_CAPTURED_TABLES.length +
      Object.keys(LOG_FIRST_PRODUCED_TABLES).length +
      Object.keys(ACCEPTED_UNFEDERATED_TABLES).length;
    expect(total).toBe(PEER_LOG_TABLES.length);
  });

  it('CDC and log-first sets are disjoint (a table cannot be both — EI-117 echo risk)', () => {
    const cdc = new Set(CDC_CAPTURED_TABLES);
    const both = Object.keys(LOG_FIRST_PRODUCED_TABLES).filter((t) => cdc.has(t));
    expect(both).toEqual([]);
  });

  it('the five log-first tables are exactly the known direct-append producers', () => {
    expect(new Set(Object.keys(LOG_FIRST_PRODUCED_TABLES))).toEqual(
      new Set(['feature_claims', 'feature_queue', 'feature_working_set', 'contributors', 'shared_presence']),
    );
  });

  it('harness_feature_prs is the documented accepted-unfederated table (GitHub-derived)', () => {
    // The P-011 finding: prs has a read projection but no producer. It is an
    // accepted gap (GitHub is the PR authority), NOT the EI-382 bug. Pinning it
    // here documents the decision; removing it from ACCEPTED (without wiring a
    // producer or reclassifying the registry) re-reds the coverage check.
    expect(Object.keys(ACCEPTED_UNFEDERATED_TABLES)).toContain('harness_feature_prs');
    expect(ACCEPTED_UNFEDERATED_TABLES.harness_feature_prs).toMatch(/GitHub/i);
  });

  describe('checkCaptureCoverage (pure invariant)', () => {
    it('detects an uncaptured federated table (the EI-382 class)', () => {
      const c = checkCaptureCoverage(
        ['a', 'b', 'new_federated_table'],
        ['a'], // CDC
        ['b'], // log-first
        [], // accepted
      );
      expect(c.ok).toBe(false);
      expect(c.uncaptured).toEqual(['new_federated_table']);
    });

    it('detects a double-captured table (CDC + log-first)', () => {
      const c = checkCaptureCoverage(['a'], ['a'], ['a'], []);
      expect(c.ok).toBe(false);
      expect(c.doubleCaptured).toEqual(['a']);
    });

    it('detects a producer for a non-federated table (orphanProducer)', () => {
      const c = checkCaptureCoverage(['a'], ['a', 'stale_table'], [], []);
      expect(c.ok).toBe(false);
      expect(c.orphanProducer).toEqual(['stale_table']);
    });

    it('accepts an accepted-unfederated table as covered', () => {
      const c = checkCaptureCoverage(['a', 'b'], ['a'], [], ['b']);
      expect(c.ok).toBe(true);
      expect(c.uncaptured).toEqual([]);
    });
  });
});
