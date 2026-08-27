import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS,
  type FleetLifecycleBaselineCoverage,
} from './fleet-lifecycle-baseline';
import {
  FLEET_LIFECYCLE_ACCEPTANCE_CAMPAIGN_V1,
  FLEET_LIFECYCLE_ACCEPTANCE_INJECTION_IDS,
  FLEET_LIFECYCLE_ACCEPTANCE_PROOF_IDS,
  FLEET_LIFECYCLE_ACCEPTANCE_V1_PROOFS,
  baselineContractFor,
  replayFleetLifecycleAcceptance,
} from './fleet-lifecycle-acceptance';

/**
 * Walk up to the workspace root rather than counting `..` segments, so moving
 * this file inside the package does not silently make every path check pass
 * against a directory that does not exist.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 12; hop += 1) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { workspaces?: unknown };
        if (parsed.workspaces) return dir;
      } catch {
        /* a malformed manifest on the way up is not the root */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the workspace root from the acceptance fixture');
}

const ROOT = repoRoot();
const COVERAGE_RANK: Record<FleetLifecycleBaselineCoverage, number> = {
  unknown: 0,
  partial: 1,
  measured: 2,
};

describe('P-013 fleet lifecycle acceptance campaign', () => {
  it('locates a workspace root that actually contains the tree under test', () => {
    // Positive control: without this, every existsSync assertion below could be
    // passing against a bogus root and prove nothing.
    expect(existsSync(resolve(ROOT, 'packages/operator-core/lib/agent-tools/fleet'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'packages/operator-core/lib/agent-tools/fleet/definitely-not-a-real-file.ts'))).toBe(
      false,
    );
  });

  it('covers every declared proof exactly once, in the plan order', () => {
    expect(FLEET_LIFECYCLE_ACCEPTANCE_V1_PROOFS.map((proof) => proof.id)).toEqual(
      FLEET_LIFECYCLE_ACCEPTANCE_PROOF_IDS,
    );
    expect(new Set(FLEET_LIFECYCLE_ACCEPTANCE_V1_PROOFS.map((proof) => proof.id)).size).toBe(
      FLEET_LIFECYCLE_ACCEPTANCE_PROOF_IDS.length,
    );
  });

  it('claims every injected fault condition P-013 names', () => {
    const claimed = new Set(FLEET_LIFECYCLE_ACCEPTANCE_V1_PROOFS.flatMap((proof) => proof.injections));
    for (const injection of FLEET_LIFECYCLE_ACCEPTANCE_INJECTION_IDS) {
      expect(claimed.has(injection), `injected condition never exercised: ${injection}`).toBe(true);
    }
  });

  it('resolves every canonical writer and asserting test on disk', () => {
    for (const proof of FLEET_LIFECYCLE_ACCEPTANCE_V1_PROOFS) {
      expect(proof.canonicalWriters.length, `${proof.id} names no writer`).toBeGreaterThan(0);
      expect(proof.assertingTests.length, `${proof.id} names no asserting test`).toBeGreaterThan(0);
      expect(proof.baselineAxes.length, `${proof.id} names no baseline axis`).toBeGreaterThan(0);

      for (const writer of proof.canonicalWriters) {
        expect(existsSync(resolve(ROOT, writer)), `${proof.id} writer missing: ${writer}`).toBe(true);
      }
      for (const test of proof.assertingTests) {
        expect(test.endsWith('.test.ts'), `${proof.id} asserting file is not a test: ${test}`).toBe(true);
        expect(existsSync(resolve(ROOT, test)), `${proof.id} asserting test missing: ${test}`).toBe(true);
      }
    }
  });

  it('binds every proof to a real P-002 baseline axis', () => {
    const axisIds = new Set(FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS.map((axis) => axis.id));
    for (const proof of FLEET_LIFECYCLE_ACCEPTANCE_V1_PROOFS) {
      for (const axisId of proof.baselineAxes) {
        expect(axisIds.has(axisId), `${proof.id} names an unknown baseline axis: ${axisId}`).toBe(true);
        expect(baselineContractFor(axisId).id).toBe(axisId);
      }
    }
  });

  it('never records post-campaign coverage below the P-002 baseline it is compared against', () => {
    for (const proof of Object.values(FLEET_LIFECYCLE_ACCEPTANCE_CAMPAIGN_V1.proofs)) {
      for (const axisId of proof.baselineAxes) {
        const after = proof.axisCoverage[axisId];
        expect(after, `${proof.id} has no post-campaign coverage for ${axisId}`).toBeDefined();
        const before = baselineContractFor(axisId).baselineCoverage;
        expect(
          COVERAGE_RANK[after as FleetLifecycleBaselineCoverage],
          `${axisId} regressed: baseline ${before} -> campaign ${after}`,
        ).toBeGreaterThanOrEqual(COVERAGE_RANK[before]);
      }
    }
  });

  it('records a verdict for every proof, with evidence for a pass and a reason otherwise', () => {
    for (const id of FLEET_LIFECYCLE_ACCEPTANCE_PROOF_IDS) {
      const proof = FLEET_LIFECYCLE_ACCEPTANCE_CAMPAIGN_V1.proofs[id];
      expect(proof, `no campaign verdict for ${id}`).toBeDefined();
      if (proof.status === 'proven') {
        expect(proof.evidence, `${id} passed with no evidence`).toBeTruthy();
        expect(Object.keys(proof.evidence ?? {}).length).toBeGreaterThan(0);
        expect(proof.reason).toBeUndefined();
      } else {
        expect(proof.reason, `${id} is ${proof.status} with no reason`).toBeTruthy();
        expect((proof.reason ?? '').length).toBeGreaterThan(20);
      }
    }
  });

  it('records the deterministic fault-injection matrix that backs the campaign', () => {
    const { matrix } = FLEET_LIFECYCLE_ACCEPTANCE_CAMPAIGN_V1;
    expect(matrix.failed).toBe(0);
    expect(matrix.files).toBeGreaterThan(0);
    expect(matrix.passed).toBeGreaterThan(matrix.files);
    expect(matrix.runIds.length).toBeGreaterThan(0);
    for (const runId of matrix.runIds) expect(runId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps the comparison boundary anchored to the P-002 start and extended, never replayed', () => {
    const { boundary } = FLEET_LIFECYCLE_ACCEPTANCE_CAMPAIGN_V1;
    expect(boundary.since).toBe('2026-08-27T00:00:00.000Z');
    expect(Date.parse(boundary.until)).toBeGreaterThan(Date.parse(boundary.since));
  });

  it('reports a missing verdict as unproven rather than manufacturing a pass', () => {
    // Falsifiability control: the replay must not silently upgrade an absent
    // reading, exactly as the P-002 fixture refuses to manufacture a zero.
    const replayed = replayFleetLifecycleAcceptance({
      capturedAt: '2026-08-27T00:00:00.000Z',
      boundary: { since: 'a', until: 'b', scope: 'test' },
      matrix: { files: 1, passed: 2, failed: 0, runIds: ['00000000'] },
      verdicts: {},
      axisCoverage: {},
    });
    for (const id of FLEET_LIFECYCLE_ACCEPTANCE_PROOF_IDS) {
      expect(replayed.proofs[id].status).toBe('unproven');
      expect(replayed.proofs[id].reason).toBe('campaign-verdict-missing');
      expect(replayed.proofs[id].evidence).toBeNull();
    }
    // ...and an axis with no supplied coverage must read `unknown`, not `measured`.
    expect(Object.values(replayed.proofs.readinessNotFromJoinAlone.axisCoverage)).toContain('unknown');
  });
});
