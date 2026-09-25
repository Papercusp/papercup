import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceHostHealthPatterns, type WorkspaceHostFailureEvent,
} from './workspace-host-health-lane';
import { flattenDigest } from './lenses';
import type { CorpusDigest } from './types';

function failure(
  id: string, operationId: string, phase: string, recoveryId: string | null = null,
): WorkspaceHostFailureEvent {
  return {
    id, operationId, phase, hostId: operationId === 'op-3' ? 'host-2' : 'host-1',
    occurredAt: `2026-09-25T18:00:0${id}Z`,
    recoveryId, recoveryAt: recoveryId ? '2026-09-25T18:05:00Z' : null,
  };
}

describe('managed workspace-host corpus patterns', () => {
  it('counts distinct failed operations and describes later host success without claiming the failed operation recovered', () => {
    const lane = buildWorkspaceHostHealthPatterns([
      failure('1', 'op-1', 'initialize:failed', 'recovery-1'),
      failure('2', 'op-1', 'initialize:failed', 'recovery-1'),
      failure('3', 'op-2', 'initialize:failed'),
      failure('4', 'op-3', 'destroy-evidence:failed'),
    ]);
    const digest = {
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      workspaceHostHealth: lane,
    } satisfies CorpusDigest;
    const flat = flattenDigest(digest);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toMatchObject({ category: 'workspace-host-health', ref: 'workspace-host:event:3' });
    expect(flat[0]?.summary).toContain('2 failed managed workspace-host operation(s)');
    expect(flat[0]?.detail).toContain('3 failed event row(s)');
    expect(flat[0]?.detail).toContain('1 operation(s) had a later terminal success');
    expect(flat[0]?.detail).toContain('not proof the failed operation itself succeeded');
    expect(flat[1]?.summary).toContain('destroy-evidence:failed');
  });

  it('reports database and rendered-phase caps', () => {
    const lane = buildWorkspaceHostHealthPatterns([
      failure('1', 'op-1', 'initialize:failed'),
      failure('2', 'op-3', 'destroy-evidence:failed'),
    ], { limit: 1, totalFailures: 5 });
    expect(lane.at(-1)?.ref).toBe('workspace-host:coverage-residue');
    expect(lane.at(-1)?.summary).toContain('3 failure row(s)');
  });
});
