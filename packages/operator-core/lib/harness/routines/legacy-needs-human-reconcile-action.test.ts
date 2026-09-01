import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP,
  MAX_LEGACY_NEEDS_HUMAN_RECONCILE_CAP,
  decideLegacyNeedsHumanReconcile,
  legacyNeedsHumanReconcileCap,
  makeLegacyNeedsHumanReconcileAction,
  type LegacyNeedsHumanCandidate,
} from './legacy-needs-human-reconcile-action';

function candidate(patch: Partial<LegacyNeedsHumanCandidate> = {}): LegacyNeedsHumanCandidate {
  return {
    workspaceId: 'ws',
    harnessSlug: 'harness-a',
    id: 'WI-1',
    status: 'open',
    itemKind: 'bug',
    takenBy: null,
    payload: { needsHuman: true, keep: 'sibling' },
    ...patch,
  };
}

describe('decideLegacyNeedsHumanReconcile', () => {
  it('clears only an issue-family legacy marker with no live human gate', () => {
    expect(decideLegacyNeedsHumanReconcile(candidate())).toEqual({
      action: 'clear',
      reason: 'no-live-human-gate',
    });
    expect(decideLegacyNeedsHumanReconcile(candidate({ payload: { needsHuman: 'TRUE' } }))).toEqual({
      action: 'clear',
      reason: 'no-live-human-gate',
    });
  });

  it.each([
    ['missing legacy marker', { payload: {} }, 'not-legacy-needs-human'],
    ['feature family', { itemKind: 'feature' }, 'not-issue-family'],
    ['terminal history', { status: 'done' }, 'terminal-history'],
    ['observation lane', { payload: { needsHuman: true, lane: 'observation' } }, 'observation-lane'],
    ['legacy observation lane', { payload: { needsHuman: true, _lane: 'observation' } }, 'observation-lane'],
    ['typed lifecycle', { status: 'needs-human' }, 'needs-human-status'],
    ['strict owner action', { payload: { needsHuman: true, needsOwnerAction: true } }, 'typed-owner-action'],
    ['human capability', { payload: { needsHuman: true, humanCapability: 'credential' } }, 'human-capability'],
    [
      'active blocker',
      { payload: { needsHuman: true, externalBlockers: [{ status: 'ACTIVE' }] } },
      'active-external-blocker',
    ],
    [
      'malformed blocker container',
      { payload: { needsHuman: true, externalBlockers: { status: 'active' } } },
      'malformed-external-blockers',
    ],
    ['malformed blocker row', { payload: { needsHuman: true, externalBlockers: [{}] } }, 'malformed-external-blockers'],
  ] as const)('fails closed for %s', (_label, patch, reason) => {
    expect(decideLegacyNeedsHumanReconcile(candidate(patch))).toEqual({ action: 'keep', reason });
  });

  it('does not treat cleared blocker history as a live gate', () => {
    expect(
      decideLegacyNeedsHumanReconcile(
        candidate({ payload: { needsHuman: true, externalBlockers: [{ status: 'cleared' }] } }),
      ),
    ).toEqual({ action: 'clear', reason: 'no-live-human-gate' });
  });
});

describe('legacyNeedsHumanReconcileCap', () => {
  it('defaults invalid values and clamps oversized values', () => {
    expect(legacyNeedsHumanReconcileCap(undefined)).toBe(DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP);
    expect(legacyNeedsHumanReconcileCap(0)).toBe(DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP);
    expect(legacyNeedsHumanReconcileCap('17')).toBe(17);
    expect(legacyNeedsHumanReconcileCap(MAX_LEGACY_NEEDS_HUMAN_RECONCILE_CAP + 1)).toBe(
      MAX_LEGACY_NEEDS_HUMAN_RECONCILE_CAP,
    );
  });
});

describe('makeLegacyNeedsHumanReconcileAction', () => {
  it('passes the bounded cap and logs a mutating tick with its ids', async () => {
    const reconcile = vi.fn(async () => ({
      scanned: 2,
      cleared: 2,
      clearedIds: ['WI-1', 'WI-2'],
      deferredToNextTick: true,
    }));
    const log = vi.fn();
    const action = makeLegacyNeedsHumanReconcileAction({ reconcile, log });
    await action({
      installSlug: 'papercusp',
      workspaceId: 'ws',
      triggerConfig: { cap: 2 },
      payloadTemplate: null,
    });
    expect(reconcile).toHaveBeenCalledWith({ workspaceId: 'ws', cap: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cleared=2'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('more deferred'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WI-1,WI-2'));
  });

  it('is quiet on a clean no-op tick', async () => {
    const log = vi.fn();
    const action = makeLegacyNeedsHumanReconcileAction({
      reconcile: vi.fn(async () => ({
        scanned: 0,
        cleared: 0,
        clearedIds: [],
        deferredToNextTick: false,
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
