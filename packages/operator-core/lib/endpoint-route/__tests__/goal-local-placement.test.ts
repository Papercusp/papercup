import { describe, expect, it, vi } from 'vitest';
import type { GoalPotLink } from '@papercusp/db-org';
import {
  goalHolderMayPlaceIntoLocalPot,
  type GoalLocalPlacementDeps,
  type GoalLocalPlacementInput,
} from '../routes/transport/goal-local-placement';

const INPUT: GoalLocalPlacementInput = {
  workspaceId: 'ws-test',
  callerOwnerId: 'goal-holder',
  scopeHive: 'papercusp',
  targetHarness: 'sidestage',
};

function link(harnessSlug: string, role: 'owner' | 'contributing' = 'contributing'): GoalPotLink {
  return {
    id: `link-${harnessSlug}`,
    goalId: 'goal-1',
    harnessSlug,
    role,
    addedAt: '2026-09-04T00:00:00.000Z',
    addedBy: 'owner',
    note: null,
    killCriterion: null,
  };
}

function deps(overrides: Partial<GoalLocalPlacementDeps> = {}): GoalLocalPlacementDeps {
  return {
    readAuthority: vi.fn(async () => ({
      status: 'elected',
      goalId: 'goal-1',
      electedOwnerId: 'goal-holder',
      electedEpoch: 1,
      handoffExpiresAt: null,
    })),
    listGoalPots: vi.fn(async () => [link('sidestage')]),
    resolvePotHome: vi.fn(async (_workspaceId, harnessSlug) =>
      harnessSlug === 'sidestage-member' ? 'sidestage' : harnessSlug,
    ),
    isRemotePot: vi.fn(async () => false),
    ownedPotVisibility: vi.fn(async () => null),
    ...overrides,
  };
}

describe('goalHolderMayPlaceIntoLocalPot', () => {
  it('authorizes the elected goal holder for an unpublished contributing pot', async () => {
    await expect(goalHolderMayPlaceIntoLocalPot(INPUT, deps())).resolves.toBe(true);
  });

  it('covers a member harness when the goal link names the local pot home', async () => {
    const d = deps({
      listGoalPots: vi.fn(async () => [link('sidestage')]),
    });
    await expect(
      goalHolderMayPlaceIntoLocalPot({ ...INPUT, targetHarness: 'sidestage-member' }, d),
    ).resolves.toBe(true);
  });

  it('rejects inherited/non-holder goal context', async () => {
    const d = deps({
      readAuthority: vi.fn(async () => ({
        status: 'none',
        goalId: null,
        electedOwnerId: null,
        electedEpoch: null,
        handoffExpiresAt: null,
      })),
    });
    await expect(goalHolderMayPlaceIntoLocalPot(INPUT, d)).resolves.toBe(false);
    expect(d.listGoalPots).not.toHaveBeenCalled();
  });

  it('accepts a live handoff predecessor but not a superseded holder', async () => {
    const handoff = deps({
      readAuthority: vi.fn(async () => ({
        status: 'handoff',
        goalId: 'goal-1',
        electedOwnerId: 'new-holder',
        electedEpoch: 2,
        handoffExpiresAt: '2026-09-04T23:59:59.000Z',
      })),
    });
    await expect(goalHolderMayPlaceIntoLocalPot(INPUT, handoff)).resolves.toBe(true);

    const superseded = deps({
      readAuthority: vi.fn(async () => ({
        status: 'superseded',
        goalId: 'goal-1',
        electedOwnerId: 'new-holder',
        electedEpoch: 2,
        handoffExpiresAt: null,
      })),
    });
    await expect(goalHolderMayPlaceIntoLocalPot(INPUT, superseded)).resolves.toBe(false);
  });

  it('requires an active goal-pot link', async () => {
    const d = deps({
      listGoalPots: vi.fn(async () => [link('another-pot')]),
    });
    await expect(goalHolderMayPlaceIntoLocalPot(INPUT, d)).resolves.toBe(false);
  });

  it('keeps published and joined pots on the federated route', async () => {
    await expect(
      goalHolderMayPlaceIntoLocalPot(
        INPUT,
        deps({ ownedPotVisibility: vi.fn(async () => 'public') }),
      ),
    ).resolves.toBe(false);

    await expect(
      goalHolderMayPlaceIntoLocalPot(INPUT, deps({ isRemotePot: vi.fn(async () => true) })),
    ).resolves.toBe(false);
  });

  it('fails closed when authority or local-pot reads are unavailable', async () => {
    await expect(
      goalHolderMayPlaceIntoLocalPot(
        INPUT,
        deps({ readAuthority: vi.fn(async () => { throw new Error('authority unavailable'); }) }),
      ),
    ).resolves.toBe(false);

    await expect(
      goalHolderMayPlaceIntoLocalPot(
        INPUT,
        deps({ ownedPotVisibility: vi.fn(async () => { throw new Error('registry unavailable'); }) }),
      ),
    ).resolves.toBe(false);
  });

  it('rejects wildcard, same-hive, and workspace-less targets before reading authority', async () => {
    const d = deps();
    await expect(
      goalHolderMayPlaceIntoLocalPot({ ...INPUT, targetHarness: '*' }, d),
    ).resolves.toBe(false);
    await expect(
      goalHolderMayPlaceIntoLocalPot({ ...INPUT, targetHarness: 'papercusp' }, d),
    ).resolves.toBe(false);
    await expect(
      goalHolderMayPlaceIntoLocalPot({ ...INPUT, workspaceId: '*' }, d),
    ).resolves.toBe(false);
    expect(d.readAuthority).not.toHaveBeenCalled();
  });
});
