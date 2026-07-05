/**
 * sentinel-herald Phase 4 (P-017) — the Sentinel handoff dispatch.
 *
 * Asserts the core contract: a user request via the Sentinel produces a
 * HIGH-PRIORITY, `user-requested`-tagged work_item + a Queen nudge, the tier-gate
 * (P-015) routes medium/high un-approved actions to approval instead of placing,
 * and the Sentinel NEVER calls cup:spawn (it files + nudges + hands off only).
 *
 * Unit-level: dispatch against injected deps (no PG/coord). Mirrors the
 * converse/tag test style (vitest, spy deps).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  dispatchSentinelHandoff,
  resolveHandoffTier,
  USER_REQUESTED_LABEL,
  HANDOFF_CAPABILITY,
  type SentinelHandoffDeps,
} from './operator-sentinel-handoff';
import { parseOperatorTurn } from './operator-converse-tags';
import type { HandoffRequest } from './operator-converse-tags';

const WS = 'ws-test';

function makeDeps(over: Partial<SentinelHandoffDeps> = {}): {
  deps: SentinelHandoffDeps;
  spies: {
    createWorkItem: ReturnType<typeof vi.fn>;
    setPriority: ReturnType<typeof vi.fn>;
    nudgeQueen: ReturnType<typeof vi.fn>;
    subscribeOperator: ReturnType<typeof vi.fn>;
    surfaceForApproval: ReturnType<typeof vi.fn>;
    standingApprovals: ReturnType<typeof vi.fn>;
  };
} {
  const createWorkItem = vi.fn(async () => ({ id: 'WI-101' }));
  const setPriority = vi.fn(async () => {});
  const nudgeQueen = vi.fn(async () => {});
  const subscribeOperator = vi.fn(async () => {});
  const surfaceForApproval = vi.fn(async () => {});
  const standingApprovals = vi.fn(async () => [] as Array<{ capability: string; targetHarness: string }>);
  const deps: SentinelHandoffDeps = {
    createWorkItem,
    setPriority,
    nudgeQueen,
    subscribeOperator,
    surfaceForApproval,
    standingApprovals,
    ...over,
  };
  return {
    deps,
    spies: { createWorkItem, setPriority, nudgeQueen, subscribeOperator, surfaceForApproval, standingApprovals },
  };
}

const lowHandoff = (over: Partial<HandoffRequest> = {}): HandoffRequest => ({
  summary: 'draft the auth module',
  harness: 'papercup',
  featureId: 'auth-module',
  tier: 'low',
  capability: null,
  urgent: false,
  ...over,
});

describe('dispatchSentinelHandoff — file + nudge (P-014)', () => {
  it('files a high-priority, user-requested work_item and nudges the Queen', async () => {
    const { deps, spies } = makeDeps();
    const out = await dispatchSentinelHandoff(lowHandoff(), WS, deps);

    expect(out).toEqual({ status: 'filed', workItemId: 'WI-101', tier: 'low', nudged: true });

    // P-014: a work_item was filed, tagged user-requested, in the right workspace.
    expect(spies.createWorkItem).toHaveBeenCalledTimes(1);
    const createArg = spies.createWorkItem.mock.calls[0][0];
    expect(createArg).toMatchObject({
      title: 'draft the auth module',
      summary: 'draft the auth module',
      harness: 'papercup',
      label: USER_REQUESTED_LABEL,
      workspaceId: WS,
    });

    // High priority (the user-asked default).
    expect(spies.setPriority).toHaveBeenCalledWith('WI-101', 'high', 'papercup');

    // P-016: subscribed for hindsight outcome feedback.
    expect(spies.subscribeOperator).toHaveBeenCalledWith('WI-101', 'papercup');

    // P-014: the Queen was nudged about the filed item.
    expect(spies.nudgeQueen).toHaveBeenCalledTimes(1);
    expect(spies.nudgeQueen.mock.calls[0][0]).toMatchObject({
      workItemId: 'WI-101',
      summary: 'draft the auth module',
      urgent: false,
    });

    // P-014 (the whole point): the Sentinel NEVER surfaces a low action for approval.
    expect(spies.surfaceForApproval).not.toHaveBeenCalled();
  });

  it('an urgent handoff files urgent and the nudge carries urgent', async () => {
    const { deps, spies } = makeDeps();
    await dispatchSentinelHandoff(lowHandoff({ urgent: true }), WS, deps);
    expect(spies.createWorkItem.mock.calls[0][0].urgent).toBe(true);
    expect(spies.nudgeQueen.mock.calls[0][0].urgent).toBe(true);
  });

  it('still reports filed (nudged:false) when the Queen nudge throws — the create-event wakes her anyway', async () => {
    const { deps, spies } = makeDeps({
      nudgeQueen: vi.fn(async () => {
        throw new Error('coord down');
      }),
    });
    const out = await dispatchSentinelHandoff(lowHandoff(), WS, deps);
    expect(out).toMatchObject({ status: 'filed', workItemId: 'WI-101', nudged: false });
    expect(spies.createWorkItem).toHaveBeenCalledTimes(1);
  });

  it('returns an error (never throws) when the work_item create fails', async () => {
    const { deps, spies } = makeDeps({ createWorkItem: vi.fn(async () => null) });
    const out = await dispatchSentinelHandoff(lowHandoff(), WS, deps);
    expect(out).toEqual({ status: 'error', error: 'work_item create failed' });
    expect(spies.nudgeQueen).not.toHaveBeenCalled();
  });
});

describe('dispatchSentinelHandoff — tier gate (P-015, the user-facing approval tier)', () => {
  it('surfaces a HIGH-tier action for approval instead of placing it', async () => {
    const { deps, spies } = makeDeps();
    const out = await dispatchSentinelHandoff(lowHandoff({ tier: 'high' }), WS, deps);

    expect(out).toEqual({ status: 'surfaced_for_approval', tier: 'high' });
    expect(spies.surfaceForApproval).toHaveBeenCalledTimes(1);
    expect(spies.surfaceForApproval.mock.calls[0][0]).toMatchObject({
      tier: 'high',
      capability: HANDOFF_CAPABILITY,
      harness: 'papercup',
    });
    // Deferred to the Queen post-approval: nothing is filed/nudged now.
    expect(spies.createWorkItem).not.toHaveBeenCalled();
    expect(spies.nudgeQueen).not.toHaveBeenCalled();
  });

  it('a medium/high action ALREADY standing-approved is filed (not re-surfaced)', async () => {
    const { deps, spies } = makeDeps({
      standingApprovals: vi.fn(async () => [
        { capability: HANDOFF_CAPABILITY, targetHarness: 'papercup' },
      ]),
    });
    const out = await dispatchSentinelHandoff(lowHandoff({ tier: 'high' }), WS, deps);
    expect(out).toMatchObject({ status: 'filed', tier: 'high' });
    expect(spies.surfaceForApproval).not.toHaveBeenCalled();
    expect(spies.createWorkItem).toHaveBeenCalledTimes(1);
    expect(spies.nudgeQueen).toHaveBeenCalledTimes(1);
  });

  it('a wildcard standing approval (target=*) covers any harness', async () => {
    const { deps, spies } = makeDeps({
      standingApprovals: vi.fn(async () => [{ capability: HANDOFF_CAPABILITY, targetHarness: '*' }]),
    });
    const out = await dispatchSentinelHandoff(lowHandoff({ tier: 'medium', harness: 'other' }), WS, deps);
    expect(out).toMatchObject({ status: 'filed' });
    expect(spies.surfaceForApproval).not.toHaveBeenCalled();
  });

  it('a LOW action is always filed directly — no approval, no standing-approval read needed', async () => {
    const { deps, spies } = makeDeps();
    await dispatchSentinelHandoff(lowHandoff({ tier: 'low' }), WS, deps);
    expect(spies.standingApprovals).not.toHaveBeenCalled();
    expect(spies.surfaceForApproval).not.toHaveBeenCalled();
    expect(spies.createWorkItem).toHaveBeenCalledTimes(1);
  });
});

describe('resolveHandoffTier — authoritative tier (P-015)', () => {
  it('a capability-less handoff trusts the brain self-classified tier', () => {
    expect(resolveHandoffTier(lowHandoff({ tier: 'low', capability: null }))).toBe('low');
    expect(resolveHandoffTier(lowHandoff({ tier: 'medium', capability: null }))).toBe('medium');
  });

  it('a named capability resolves the authoritative substrate tier (cup:spawn ⇒ not low)', () => {
    // The whole point of the handoff is that the Sentinel can't place — the
    // capability it hands off (cup:spawn) must NOT resolve to a self-placeable
    // low tier. (Unknown caps fail-safe to high.)
    const tier = resolveHandoffTier(lowHandoff({ tier: 'low', capability: HANDOFF_CAPABILITY }));
    expect(tier).not.toBe('low');
  });
});

describe('the Sentinel NEVER calls cup:spawn (P-017 invariant)', () => {
  it('a parsed sentinel user-request turn yields handoffs, NO spawns', () => {
    // The sentinel persona files + nudges; it must never emit a <spawn>. Even if
    // it did, the converse dispatch only honors <spawn> for the operator. Here we
    // assert the SHAPE: a user-request turn is a handoff, not a spawn.
    const turn = parseOperatorTurn(
      '<say>Filing the auth rewrite and flagging the Queen.</say>\n' +
        '<handoff_to_queen summary="rewrite auth" harness="papercup" capability="cup:spawn">',
    );
    expect(turn.handoffs).toHaveLength(1);
    expect(turn.spawns).toHaveLength(0);
  });

  it('the handoff dispatch surface exposes no spawn/placement primitive', async () => {
    // The dispatch's entire dep surface is file/nudge/subscribe/approve — there is
    // no spawn or placement seam to call. Guards against a future dep being added
    // that lets the Herald place.
    const { deps } = makeDeps();
    await dispatchSentinelHandoff(lowHandoff(), WS, deps);
    const depKeys = Object.keys(deps);
    expect(depKeys).not.toContain('spawn');
    expect(depKeys.some((k) => /spawn|place|dispatch|cancel|drain/i.test(k))).toBe(false);
  });
});
