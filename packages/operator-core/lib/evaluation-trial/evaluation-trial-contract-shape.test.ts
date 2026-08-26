/**
 * The contract version is DERIVED from `EVALUATION_TRIAL_CONTRACT_SHAPE` (D-014),
 * which only works if that descriptor actually describes the `EvaluationTrial`
 * type. This file is the guard that keeps the two from drifting.
 *
 * What it catches: a field added, removed, or renamed on the contract without the
 * descriptor being updated — which would otherwise leave the version unchanged
 * across a real contract change, exactly the failure D-014 forbids.
 *
 * What it deliberately does NOT catch: a field's TYPE changing (the `:kind` half
 * of each entry). TypeScript type names are not observable at runtime, so this
 * test compares PATHS only. Re-typing is caught instead by `tsc` at every call
 * site plus the exemplar's own `EvaluationTrial` annotation below, which stops
 * compiling if a field's type moves incompatibly. Stating the limit here is the
 * point: a guard whose reach is unstated gets trusted past it.
 */
import { describe, expect, it } from 'vitest';

import { EVALUATION_TRIAL_CONTRACT_SHAPE, EVALUATION_TRIAL_CONTRACT_VERSION } from './identity';
import type { EvaluationTrial } from './schema';

/**
 * A trial with EVERY field populated. Any field left out here reads as a missing
 * path and fails the comparison below, so this exemplar is load-bearing: it is
 * what makes "the descriptor covers the type" a measured claim rather than a
 * hopeful one.
 */
const FULLY_POPULATED: EvaluationTrial = {
  contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
  subject: {
    family: 'external-bench',
    corpus: 'swe-bench-pro',
    taskId: 'task-1',
    taskRevision: 'prereg-abc',
  },
  system: {
    modelId: 'claude-opus-4-8',
    modelVersion: '2026-08-01',
    harnessVersion: 'blueprint-7',
    harnessGitSha: 'a'.repeat(40),
    environmentFingerprint: 'env-fp',
  },
  configuration: {
    configHash: 'cfg-fp',
    seed: 3,
    arm: 'papercusp',
    matrixIndex: 0,
    budgets: {
      tokens: 100_000,
      usd: 5,
      wallClockMs: 60_000,
      agents: 4,
      capped: false,
      breaches: [],
    },
  },
  grader: {
    kind: 'deterministic',
    family: 'swebench-official',
    version: '2.0',
    judgeModel: null,
  },
  outcome: {
    status: 'passed',
    resolved: true,
    score: 1,
    infraFailure: false,
    errors: [],
  },
  usage: {
    tokensIn: 10,
    tokensOut: 20,
    tokensTotal: 30,
    tokensCacheRead: 1,
    tokensCacheWrite: 2,
    costUsd: 0.5,
    priceTableVersion: 'price-table-v1',
    wallClockMs: 1_000,
    turns: 7,
  },
  evidence: {
    trajectoryRef: 'traj-1',
    trajectoryKind: 'inspect',
    submissionRef: 'sub-1',
    rawGraderOutputRef: 'raw-1',
    artifactRefs: [],
    privacy: 'internal',
    contentHash: 'content-1',
  },
  lineage: {
    runId: 'run-1',
    groupId: 'rollout-1',
    repeat: 3,
    parentTrialKey: null,
    sourceRef: 'external-bench:rollout-1',
  },
  startedAt: '2026-08-26T00:00:00.000Z',
  finishedAt: '2026-08-26T00:01:00.000Z',
};

/** Leaf paths of a value. Arrays and `null` are leaves; plain objects recurse. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...leafPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

describe('EVALUATION_TRIAL_CONTRACT_SHAPE', () => {
  it('describes exactly the paths a fully-populated trial carries', () => {
    const declared = EVALUATION_TRIAL_CONTRACT_SHAPE.map((entry) => entry.split(':')[0]).sort();
    const actual = leafPaths(FULLY_POPULATED).sort();

    // Compared as sets with a readable diff: a bare toEqual on two long arrays
    // reports "arrays differ" without saying which field moved.
    const missingFromDescriptor = actual.filter((p) => !declared.includes(p));
    const staleInDescriptor = declared.filter((p) => !actual.includes(p));

    expect({ missingFromDescriptor, staleInDescriptor }).toEqual({
      missingFromDescriptor: [],
      staleInDescriptor: [],
    });
  });

  it('is sorted and free of duplicates, so the derived version cannot move on ordering', () => {
    const entries = [...EVALUATION_TRIAL_CONTRACT_SHAPE];
    expect(entries).toEqual([...entries].sort());
    expect(new Set(entries).size).toBe(entries.length);
  });

  it('every entry declares a kind, so a re-type is at least visible in review', () => {
    for (const entry of EVALUATION_TRIAL_CONTRACT_SHAPE) {
      expect(entry, `shape entry ${entry} must be "path:kind"`).toMatch(/^[a-zA-Z.]+:[A-Za-z[\]]+$/);
    }
  });

  it('derives a labelled version rather than carrying a literal', () => {
    expect(EVALUATION_TRIAL_CONTRACT_VERSION).toMatch(/^evaluation-trial\.[0-9a-f]{12}$/);
  });
});
