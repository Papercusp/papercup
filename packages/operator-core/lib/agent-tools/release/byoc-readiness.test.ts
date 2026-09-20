import { describe, expect, it } from 'vitest';
import {
  evaluateByocReadiness,
} from './byoc-readiness';
import type { ByocReleaseCarrySnapshot } from '../../byoc-release-carry';

function snapshot(
  overrides: Partial<ByocReleaseCarrySnapshot['milestoneProjection']> = {},
  artifactIdentity: unknown = { bundleSha256: 'bundle' },
): ByocReleaseCarrySnapshot {
  const keys = [
    ['build', 'build'],
    ['publication', 'publication'],
    ['root-bootstrap', 'root bootstrap'],
    ['fixed-agent-initialization', 'fixed-agent initialization'],
    ['customer-acceptance', 'customer acceptance'],
    ['soak-24h', '24-hour soak'],
    ['resource-census', 'resource census'],
    ['billing-closure', 'billing closure'],
    ['cleanup', 'cleanup'],
    ['shipment', 'shipment'],
  ] as const;
  const milestones = keys.map(([key, label]) => ({
    key,
    label,
    status: 'verified' as const,
    receiptState: 'committed' as const,
    receiptSequence: 1,
    evidenceRefs: [`evidence:${key}`],
  }));
  return {
    schemaVersion: 'byoc-release-carry-v1',
    taskId: 'task-1',
    workItemId: 'WI-10001532',
    operationId: 'op-1',
    cursor: 10,
    currentStage: 'release.shipment.green',
    currentState: 'committed',
    artifactIdentity,
    sourceIdentity: { sha: 'source' },
    credentialGeneration: 'cred-1',
    credentialExpiresAt: null,
    spentRequestIdentities: ['req-1'],
    evidenceRefs: milestones.flatMap((entry) => entry.evidenceRefs),
    milestoneProjection: {
      current: 'shipment',
      customerReady: true,
      shipped: true,
      milestones,
      contradictions: [],
      ...overrides,
    },
    nextAction: 'done',
    historyRef: 'task:task-1#release',
  };
}

describe('release:byoc_readiness', () => {
  it('passes only when the BAR population has committed evidence-backed milestones', () => {
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [snapshot()], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'pass',
      bar: 'R-4',
      artifactIdentityPresent: true,
      releaseTaskSelection: 'explicit',
    });
    expect(evaluateByocReadiness('R-5', 'WI-10001532', [snapshot()], '2026-09-20T00:00:00.000Z').verdict).toBe('pass');
    expect(evaluateByocReadiness('R-6', 'WI-10001532', [snapshot()], '2026-09-20T00:00:00.000Z').verdict).toBe('pass');
  });

  it('returns unknown for an absent or incomplete receipt chain, never a vacuous pass', () => {
    expect(evaluateByocReadiness('R-5', 'WI-10001532', [], '2026-09-20T00:00:00.000Z').verdict).toBe('unknown');
    const pending = snapshot({
      milestones: snapshot().milestoneProjection.milestones.map((entry) =>
        entry.key === 'customer-acceptance' ? { ...entry, status: 'pending' as const, receiptState: null, receiptSequence: null } : entry,
      ),
    });
    expect(evaluateByocReadiness('R-5', 'WI-10001532', [pending], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      missingMilestones: ['task-1:customer-acceptance'],
    });
  });

  it('fails closed on committed contradictions and missing artifact identity for R-4', () => {
    const contradictory = snapshot({ contradictions: ['publication has a committed receipt but an earlier prerequisite is not verified'] });
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [contradictory], '2026-09-20T00:00:00.000Z').verdict).toBe('fail');
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [snapshot({}, null)], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      missingMilestones: ['artifact-identity'],
    });
  });

  it('refuses an ambiguous historical release-task population instead of selecting a lucky receipt', () => {
    const first = snapshot();
    const second = { ...snapshot(), taskId: 'task-2' };
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [first, second], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      missingMilestones: ['release-task-selection'],
      releaseTaskSelection: 'ambiguous',
    });
  });
});
