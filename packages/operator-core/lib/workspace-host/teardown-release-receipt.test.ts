import { describe, expect, it } from 'vitest';

import { GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS, type GcpWorkspaceHostResourceCensus } from './gcp-safety';
import {
  WORKSPACE_HOST_RESOURCE_CENSUS_STAGE,
  workspaceHostResourceCensusOutcome,
  workspaceHostResourceCensusStage,
} from './teardown-release-receipt';

const SUBJECT = { workspaceId: 'workspace-1', hostId: 'host-1' };

function census(overrides: Partial<GcpWorkspaceHostResourceCensus> = {}): GcpWorkspaceHostResourceCensus {
  return {
    controllerIndependent: true,
    inventoryComplete: true,
    clean: true,
    evaluatedAt: '2026-08-25T00:10:00.000Z',
    inventoryEvidence: GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS.map((kind) => ({
      kind,
      strategy: 'managed-labels' as const,
      providerEvidenceRef: `gcp://inventory/${kind}`,
    })),
    managed: [],
    untracked: [],
    missing: [],
    labelMismatches: [],
    reaperPlan: [],
    ...overrides,
  };
}

describe('teardown.resource-census', () => {
  it('names the eight GCP resource kinds the census covers as its identity', () => {
    const stage = workspaceHostResourceCensusStage();
    expect(stage.stage).toBe(WORKSPACE_HOST_RESOURCE_CENSUS_STAGE);
    expect(stage.identity).toEqual({
      provider: 'gcp',
      kinds: ['disk', 'firewall', 'nat', 'network', 'router', 'snapshot', 'subnetwork', 'vm'],
    });
  });

  it('commits a clean census whose inventory covered every kind, naming each kind it read', () => {
    const outcome = workspaceHostResourceCensusOutcome({ subject: SUBJECT, disposition: 'discard', census: census() });
    expect(outcome.outcome).toBe('committed');
    expect(outcome.evidenceRefs).toEqual(
      expect.arrayContaining([
        'census-host:workspace-1/host-1',
        'census-disposition:discard',
        'census-kind:nat:managed-labels:gcp://inventory/nat',
        'census-untracked:0',
      ]),
    );
    expect(outcome.evidenceRefs.some((ref) => ref.startsWith('census-uncovered:'))).toBe(false);
  });

  it('refuses a "clean" census that never read one of the kinds: clean over fewer kinds is not clean', () => {
    const partial = census({
      inventoryEvidence: census().inventoryEvidence.filter((evidence) => evidence.kind !== 'nat'),
    });
    const outcome = workspaceHostResourceCensusOutcome({ subject: SUBJECT, disposition: 'discard', census: partial });
    expect(outcome.outcome).toBe('refused');
    expect(outcome.evidenceRefs).toContain('census-uncovered:nat');
  });

  it('refuses an unclean census and says how many survivors it saw', () => {
    const survivor = {
      resource: { target: 'gcp' as const, kind: 'disk', providerId: 'pc-host-disk' },
      labels: {},
      observedAt: '2026-08-25T00:10:00.000Z',
    };
    const outcome = workspaceHostResourceCensusOutcome({
      subject: SUBJECT,
      disposition: 'snapshot',
      census: census({ clean: false, untracked: [survivor] }),
    });
    expect(outcome.outcome).toBe('refused');
    expect(outcome.evidenceRefs).toContain('census-untracked:1');
  });
});
