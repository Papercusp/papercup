import { describe, expect, it, vi } from 'vitest';
import type { GitPipelineSnapshot } from '../../git-pipeline-stats';
import {
  DEFAULT_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP,
  MAX_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP,
  decideEpisodeScopedOperationalReconcile,
  episodeScopedOperationalReconcileCap,
  isGateConfirmedGreen,
  makeEpisodeScopedOperationalReconcileAction,
  type EpisodeScopedOperationalCandidate,
} from './episode-scoped-operational-reconcile-action';

/** `readExternalBlockers` (external-blockers.ts) parses defensively and drops any row
 *  missing `summary`/`createdAt`/`createdBy`/`updatedAt` — verified against the real
 *  WI-38439/WI-39939 rows via dev_pg_query, which carry all four, so a test fixture
 *  must too or it exercises a row shape the classifier will never actually see. */
function gateBlocker(patch: { status?: string; ref?: string } = {}) {
  return {
    kind: 'gate',
    status: 'active',
    ref: 'green-checkpoint:65b3fbd1',
    summary: 'test blocker',
    createdAt: '2026-08-13T13:22:03.575Z',
    createdBy: 'su-test',
    updatedAt: '2026-08-13T13:22:03.575Z',
    ...patch,
  };
}

function candidate(patch: Partial<EpisodeScopedOperationalCandidate> = {}): EpisodeScopedOperationalCandidate {
  return {
    workspaceId: 'ws',
    harnessSlug: 'harness-a',
    id: 'WI-1',
    status: 'blocked',
    itemKind: 'bug',
    title: 'restore green-checkpoint after red',
    payload: { externalBlockers: [gateBlocker()] },
    ...patch,
  };
}

/** Only the 5 fields `isGateConfirmedGreen` reads; the rest of `GitPipelineSnapshot['gate']`
 *  is irrelevant to this action (module header explains why `mainBehindStaging` is deliberately
 *  not one of them), so a partial cast — matching the pattern in git-pipeline-position.test.ts's
 *  own `snap()` fixture — is the correct fixture shape rather than a full snapshot. */
function gate(patch: Partial<GitPipelineSnapshot['gate']> = {}): GitPipelineSnapshot['gate'] {
  return {
    inconclusive: null,
    fireStale: false,
    countersUnknown: null,
    verdictStale: false,
    recordedVerdict: 'green',
    ...patch,
  } as GitPipelineSnapshot['gate'];
}

describe('isGateConfirmedGreen', () => {
  it('confirms green only when every freshness axis is clean and the verdict is green', () => {
    expect(isGateConfirmedGreen(gate())).toBe(true);
  });

  it.each([
    ['inconclusive tick', { inconclusive: 'aborted' as unknown as GitPipelineSnapshot['gate']['inconclusive'] }],
    ['stale/wedged ticker', { fireStale: true }],
    ['unmeasured counters', { countersUnknown: 'absent' as unknown as GitPipelineSnapshot['gate']['countersUnknown'] }],
    ['stale verdict', { verdictStale: true }],
    ['not-green verdict', { recordedVerdict: 'not-green' as const }],
    ['null verdict (never stamped)', { recordedVerdict: null }],
  ])('fails closed for %s', (_label, patch) => {
    expect(isGateConfirmedGreen(gate(patch))).toBe(false);
  });
});

describe('decideEpisodeScopedOperationalReconcile', () => {
  it('closes an issue-family row matching a typed active gate blocker once the gate is confirmed green', () => {
    expect(decideEpisodeScopedOperationalReconcile(candidate(), true)).toEqual({
      action: 'close',
      reason: 'gate-currently-green',
      matchedRef: 'green-checkpoint:65b3fbd1',
    });
  });

  it('closes via the plan-lane restore-*-green typed ref pattern too', () => {
    const c = candidate({
      payload: {
        externalBlockers: [gateBlocker({ ref: 'plan-lane:restore-papercusp-main-green-2026-08-20#P-002' })],
      },
    });
    expect(decideEpisodeScopedOperationalReconcile(c, true)).toEqual({
      action: 'close',
      reason: 'gate-currently-green',
      matchedRef: 'plan-lane:restore-papercusp-main-green-2026-08-20#P-002',
    });
  });

  it('closes via the title-pattern fallback when no typed blocker is present', () => {
    const c = candidate({
      payload: {},
      title: 'Refresh Papercusp green checkpoint after current HEAD fixes the six-red failing set',
    });
    expect(decideEpisodeScopedOperationalReconcile(c, true)).toEqual({
      action: 'close',
      reason: 'gate-currently-green',
      matchedRef: 'title-pattern',
    });
  });

  it('does not close on a CLEARED (non-active) blocker', () => {
    const c = candidate({
      payload: { externalBlockers: [gateBlocker({ status: 'cleared' })] },
    });
    expect(decideEpisodeScopedOperationalReconcile(c, true)).toEqual({
      action: 'keep',
      reason: 'not-episode-scoped-class',
    });
  });

  it('does not close when the gate is not confirmed green even with a matching blocker', () => {
    expect(decideEpisodeScopedOperationalReconcile(candidate(), false)).toEqual({
      action: 'keep',
      reason: 'gate-not-confirmed-green',
    });
  });

  it.each([
    ['non-issue-family (feature)', { itemKind: 'feature' }, 'not-issue-family'],
    ['no item kind', { itemKind: null }, 'not-issue-family'],
    ['terminal history', { status: 'done' }, 'terminal-history'],
    ['observation lane', { payload: { lane: 'observation' } }, 'observation-lane'],
    ['legacy observation lane', { payload: { _lane: 'observation' } }, 'observation-lane'],
    ['no matching blocker or title', { payload: {}, title: 'unrelated bug' }, 'not-episode-scoped-class'],
  ] as const)('keeps for %s', (_label, patch, reason) => {
    expect(decideEpisodeScopedOperationalReconcile(candidate(patch), true)).toEqual({ action: 'keep', reason });
  });
});

describe('episodeScopedOperationalReconcileCap', () => {
  it('defaults invalid values and clamps oversized values', () => {
    expect(episodeScopedOperationalReconcileCap(undefined)).toBe(DEFAULT_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP);
    expect(episodeScopedOperationalReconcileCap(0)).toBe(DEFAULT_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP);
    expect(episodeScopedOperationalReconcileCap('17')).toBe(17);
    expect(episodeScopedOperationalReconcileCap(MAX_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP + 1)).toBe(
      MAX_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP,
    );
  });
});

describe('makeEpisodeScopedOperationalReconcileAction', () => {
  it('passes the bounded cap and logs a mutating tick with its ids', async () => {
    const reconcile = vi.fn(async () => ({
      scanned: 2,
      closed: 2,
      closedIds: ['WI-1', 'WI-2'],
      deferredToNextTick: true,
      gateConfirmedGreen: true,
    }));
    const log = vi.fn();
    const action = makeEpisodeScopedOperationalReconcileAction({ reconcile, log });
    await action({
      installSlug: 'papercusp',
      workspaceId: 'ws',
      triggerConfig: { cap: 2 },
      payloadTemplate: null,
    });
    expect(reconcile).toHaveBeenCalledWith({ workspaceId: 'ws', installSlug: 'papercusp', cap: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('closed=2'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('gateGreen=true'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('more deferred'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WI-1,WI-2'));
  });

  it('is quiet on a clean no-op tick', async () => {
    const log = vi.fn();
    const action = makeEpisodeScopedOperationalReconcileAction({
      reconcile: vi.fn(async () => ({
        scanned: 0,
        closed: 0,
        closedIds: [],
        deferredToNextTick: false,
        gateConfirmedGreen: false,
      })),
      log,
    });
    await action({
      installSlug: 'papercusp',
      workspaceId: 'ws',
      triggerConfig: {},
      payloadTemplate: null,
    });
    expect(log).not.toHaveBeenCalled();
  });
});
