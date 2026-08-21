/**
 * drain-stamp tests (work-item-claimability-clarity-2026-07-20 P-006): the
 * fleet:wind-down auto-drain stamp. The scheduler oracle (aggregateIssueClaimExclusions)
 * and the claim-spec store are mocked WHOLESALE — this asserts the harness-resolution
 * order, the summary shape, and the fail-soft contract, not the SQL (that is the
 * scheduler's own tested predicate, reused here on purpose so there is no second copy).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueClaimExclusionBreakdown } from '../../scheduler/get-next';

vi.mock('../../scheduler/claim-spec-store', () => ({
  getClaimSpecRecord: vi.fn(),
  fleetSpecBeeKey: (slug: string) => `fleet:${slug}`,
  resolveClaimSpecWorkspace: (ws: string | null) => ws ?? 'default',
}));
vi.mock('../../scheduler/get-next', () => ({ aggregateIssueClaimExclusions: vi.fn() }));

import { buildFleetDrainStamp } from './drain-stamp';
import { getClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { aggregateIssueClaimExclusions } from '../../scheduler/get-next';

const recM = vi.mocked(getClaimSpecRecord);
const aggM = vi.mocked(aggregateIssueClaimExclusions);

function breakdown(
  over: Partial<IssueClaimExclusionBreakdown['excluded']> = {},
  matched = 100,
  claimable = 0,
): IssueClaimExclusionBreakdown {
  return {
    matchedByFilter: matched,
    claimable,
    affinityCoverage: {
      denominator: claimable,
      nonEmptyPaths: 0,
      floor: 0.5,
      belowFloor: false,
    },
    excluded: {
      taken: 0,
      claimHold: 0,
      legacyNeedsHuman: 0,
      needsOwnerAction: 0,
      agentReview: 0,
      observationLane: 0,
      externalBlocker: 0,
      planLaneReserved: 0,
      federationDetector: 0,
      loopNoise: 0,
      alreadyCompleted: 0,
      crossMachineRig: 0,
      blockedDep: 0,
      cooldown: 0,
      remoteOrigin: 0,
      ...over,
    },
  };
}

const sentinel = (over: Record<string, unknown> = {}) => ({
  source: 'cup' as const,
  spec: { specId: 'bug-drain', revision: 4, view: { filter: { field: 'kind', op: 'eq', value: 'bug' } }, states: ['open'] },
  revision: 4,
  updatedBy: null,
  updatedAt: null,
  harnessSlug: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  recM.mockResolvedValue(sentinel() as never);
  aggM.mockResolvedValue(breakdown({ federationDetector: 60, legacyNeedsHuman: 40 }, 100));
});

describe('buildFleetDrainStamp', () => {
  it('scopes the breakdown to the sentinel spec filter + resolves harness from the first candidate', async () => {
    const s = await buildFleetDrainStamp({
      fleetSlug: 'bug-drain-200k',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp', undefined],
    });
    expect(s).not.toBeNull();
    expect(s!.harness).toBe('papercusp');
    expect(s!.reVerifyCommand).toBe("scheduler:get_next { harness: 'papercusp' }");
    expect(s!.spec).toEqual({ specId: 'bug-drain', revision: 4, source: 'cup' });
    // the oracle was called with the sentinel's OWN filter + states + the leader as assignee.
    expect(aggM).toHaveBeenCalledWith(
      { field: 'kind', op: 'eq', value: 'bug' },
      expect.objectContaining({ harness: 'papercusp', states: ['open'], assignee: 'su-leader' }),
    );
    // the summary names the dominant floors, descending, and the re-verify command.
    expect(s!.summary).toContain('100 in-lane issue-family row(s)');
    expect(s!.summary).toContain('federationDetector=60, legacyNeedsHuman=40');
    expect(s!.summary).toContain("scheduler:get_next { harness: 'papercusp' }");
  });

  it('skips empty/"*" candidates and falls back to the sentinel spec harness scope', async () => {
    recM.mockResolvedValue(sentinel({ harnessSlug: 'papercusp' }) as never);
    const s = await buildFleetDrainStamp({
      fleetSlug: 'bug-drain-200k',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: [null, '*', undefined],
    });
    expect(s!.harness).toBe('papercusp');
  });

  it('returns null when no harness is resolvable (fails soft, no stamp)', async () => {
    recM.mockResolvedValue(sentinel({ harnessSlug: null }) as never);
    const s = await buildFleetDrainStamp({
      fleetSlug: 'bug-drain-200k',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: [null, undefined],
    });
    expect(s).toBeNull();
    expect(aggM).not.toHaveBeenCalled();
  });

  it('a spec whose filter matches ZERO rows is flagged as a spec problem, not a floor story', async () => {
    aggM.mockResolvedValue(breakdown({}, 0));
    const s = await buildFleetDrainStamp({
      fleetSlug: 'x',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp'],
    });
    expect(s!.summary).toContain('the SPEC matches nothing');
  });

  it('a fully-unfloored lane warns wind-down may be premature (claimable work may remain)', async () => {
    aggM.mockResolvedValue(breakdown({}, 12));
    const s = await buildFleetDrainStamp({
      fleetSlug: 'x',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp'],
    });
    expect(s!.summary).toContain('none floored');
    expect(s!.summary).toContain('premature');
  });

  it('fails soft to null when the oracle throws — never blocks the wind-down', async () => {
    aggM.mockRejectedValue(new Error('pg pool saturated'));
    const s = await buildFleetDrainStamp({
      fleetSlug: 'x',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp'],
    });
    expect(s).toBeNull();
  });
});
