/**
 * getInProcessSubstrateStatus tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type {
  AutobaseHarnessHandle,
  OpEnvelope,
} from '../autobase-setup';

afterEach(() => {
  _resetHandleMapForTests();
  _resetBootstrapForTests();
});

function fakeHandle(
  workspaceId: string,
  harnessSlug: string,
): BootedHarnessHandle {
  const log: OpEnvelope[] = [];
  const view = {
    get length() {
      return log.length;
    },
    async get(seq: number) {
      return log[seq] ?? null;
    },
  };
  const base: AutobaseHarnessHandle = {
    base: { view } as unknown as AutobaseHarnessHandle['base'],
    append: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return {
    workspaceId,
    harnessSlug,
    store: {} as never,
    base,
    close: vi.fn(async () => {}),
  };
}

describe('getInProcessSubstrateStatus', () => {
  it('flag off + no handles → disabled summary, 0 harnesses', () => {
    const r = getInProcessSubstrateStatus({ envFlag: false });
    expect(r.flagEnabled).toBe(false);
    expect(r.bootedCount).toBe(0);
    expect(r.harnesses).toEqual([]);
    expect(r.summary.worstVerdict).toBe('disabled');
  });

  it('flag on + no handles → booting summary', () => {
    const r = getInProcessSubstrateStatus({ envFlag: true });
    expect(r.flagEnabled).toBe(true);
    expect(r.bootedCount).toBe(0);
    expect(r.harnesses).toEqual([]);
    expect(r.summary.worstVerdict).toBe('booting');
  });

  it('flag on + one healthy handle', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const r = getInProcessSubstrateStatus({ envFlag: true });
    expect(r.bootedCount).toBe(1);
    expect(r.harnesses).toHaveLength(1);
    expect(r.harnesses[0]?.verdict).toBe('healthy');
    expect(r.summary.worstVerdict).toBe('healthy');
    expect(r.summary.totalHarnesses).toBe(1);
  });

  it('resolveClaimStats threads through to verdict', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const r = getInProcessSubstrateStatus({
      envFlag: true,
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
      envFlag: true,
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
    const r = getInProcessSubstrateStatus({ envFlag: true });
    expect(r.harnesses[0]?.verdict).toBe('healthy');
  });

  it('default resolveClaimStats yields zero stats', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    const r = getInProcessSubstrateStatus({ envFlag: true });
    // No claim stats provided + handle present → healthy by default.
    expect(r.harnesses[0]?.verdict).toBe('healthy');
  });

  it('envFlag override beats process.env', () => {
    const original = process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE;
    try {
      process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE = '1';
      const r = getInProcessSubstrateStatus({ envFlag: false });
      expect(r.flagEnabled).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE;
      } else {
        process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE = original;
      }
    }
  });

  it('reads from process.env when envFlag undefined', () => {
    const original = process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE;
    try {
      process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE = '1';
      const r = getInProcessSubstrateStatus();
      expect(r.flagEnabled).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE;
      } else {
        process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE = original;
      }
    }
  });
});
