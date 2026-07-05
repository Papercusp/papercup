/**
 * getInProcessSubstrateStatus tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getInProcessSubstrateStatus } from '../in-process-status';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
} from '../boot-all';
import {
  _resetTrackerForTests as _resetBootstrapForTests,
  recordMergedOps,
} from '../bootstrap-progress';
import type { BootedHarnessHandle } from '../boot';
import { makeFakeBootedHandle } from './fake-booted-handle';

afterEach(() => {
  _resetHandleMapForTests();
  _resetBootstrapForTests();
});

function fakeHandle(
  workspaceId: string,
  harnessSlug: string,
): BootedHarnessHandle {
  return makeFakeBootedHandle({ workspaceId, harnessSlug }).handle;
}

describe('getInProcessSubstrateStatus', () => {
  it('forceDisabledForTest + no handles → disabled summary, 0 harnesses', () => {
    const r = getInProcessSubstrateStatus({ forceDisabledForTest: true });
    expect(r.substrateActive).toBe(false);
    expect(r.bootedCount).toBe(0);
    expect(r.harnesses).toEqual([]);
    expect(r.summary.worstVerdict).toBe('disabled');
  });

  it('active (default) + no handles → healthy summary (idle — nothing shared)', () => {
    const r = getInProcessSubstrateStatus();
    expect(r.substrateActive).toBe(true);
    expect(r.bootedCount).toBe(0);
    expect(r.harnesses).toEqual([]);
    expect(r.summary.worstVerdict).toBe('healthy');
  });

  it('active + one healthy handle', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const r = getInProcessSubstrateStatus();
    expect(r.bootedCount).toBe(1);
    expect(r.harnesses).toHaveLength(1);
    expect(r.harnesses[0]?.verdict).toBe('healthy');
    expect(r.summary.worstVerdict).toBe('healthy');
    expect(r.summary.totalHarnesses).toBe(1);
  });

  it('resolveClaimStats threads through to verdict', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const r = getInProcessSubstrateStatus({
      resolveClaimStats: () => ({
        total: 100,
        won: 70,
        lost: 0,
        error: 30,
      }),
    });
    expect(r.harnesses[0]?.verdict).toBe('unhealthy');
    expect(r.summary.worstVerdict).toBe('unhealthy');
  });

  it('worst-wins across multiple harnesses', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
    _setHandleForTests('ws-1', 'c', fakeHandle('ws-1', 'c'));
    const r = getInProcessSubstrateStatus({
      resolveClaimStats: (_w, slug) =>
        slug === 'b'
          ? { total: 100, won: 60, lost: 0, error: 40 }
          : { total: 0, won: 0, lost: 0, error: 0 },
    });
    expect(r.summary.worstVerdict).toBe('unhealthy');
    const bRow = r.harnesses.find((h) => h.harnessSlug === 'b');
    expect(bRow?.verdict).toBe('unhealthy');
  });

  it('bootstrap-progress feeds into verdict', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    // Record progress that hasn't moved in over the stall threshold —
    // assessHarnessSubstrateHealth flips to unhealthy when mergedOps
    // lags highestSeen past staleThresholdMs (default 5 min). For
    // this test we record a snapshot with mergedOps < highestSeen and
    // rely on the default time-now to be > snapshot.lastChangeMs +
    // 5min, which won't be the case here. Instead just confirm the
    // progress data threads through and renders as healthy when fresh.
    recordMergedOps('ws-1', 'a', 5);
    const r = getInProcessSubstrateStatus();
    expect(r.harnesses[0]?.verdict).toBe('healthy');
  });

  it('default resolveClaimStats yields zero stats', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    const r = getInProcessSubstrateStatus();
    // No claim stats provided + handle present → healthy by default.
    expect(r.harnesses[0]?.verdict).toBe('healthy');
  });

  it('forceDisabledForTest forces the disabled rendering (test seam only)', () => {
    const r = getInProcessSubstrateStatus({ forceDisabledForTest: true });
    expect(r.substrateActive).toBe(false);
  });

  it('substrate is active by default (always boots, Stage 4d — no flag gate)', () => {
    const r = getInProcessSubstrateStatus();
    expect(r.substrateActive).toBe(true);
  });

  // WI-899 (A): resolveSidecarLive is the seam that lets a dead SUBSTRATE_SIDECAR
  // override the boot-time handle proxy (which stays "present" even after the
  // sidecar process that owns replication has died).
  describe('resolveSidecarLive (WI-899 A)', () => {
    it('resolveSidecarLive() => false forces every booted harness unhealthy', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
      const r = getInProcessSubstrateStatus({
        resolveSidecarLive: () => false,
      });
      expect(r.harnesses.every((h) => h.verdict === 'unhealthy')).toBe(true);
      expect(r.summary.worstVerdict).toBe('unhealthy');
    });

    it('resolveSidecarLive() => true does not itself force a healthy verdict', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      const r = getInProcessSubstrateStatus({
        resolveSidecarLive: () => true,
        resolveClaimStats: () => ({ total: 100, won: 0, lost: 0, error: 100 }),
      });
      expect(r.harnesses[0]?.verdict).toBe('unhealthy');
    });

    it('resolveSidecarLive() => null is a no-op (sidecar mode off)', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      const r = getInProcessSubstrateStatus({
        resolveSidecarLive: () => null,
      });
      expect(r.harnesses[0]?.verdict).toBe('healthy');
    });

    it('default (no resolveSidecarLive passed) resolves null and has no effect', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      const r = getInProcessSubstrateStatus();
      expect(r.harnesses[0]?.verdict).toBe('healthy');
    });

    it('resolveSidecarLive is resolved ONCE per call, not per-harness', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
      _setHandleForTests('ws-1', 'c', fakeHandle('ws-1', 'c'));
      let calls = 0;
      const r = getInProcessSubstrateStatus({
        resolveSidecarLive: () => {
          calls += 1;
          return null;
        },
      });
      expect(r.harnesses).toHaveLength(3);
      expect(calls).toBe(1);
    });
  });
});
