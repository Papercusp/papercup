/**
 * Substrate-stack integration smoke — composes every in-process
 * substrate helper end-to-end using fakes so the diagnostic stack
 * stays demonstrably composable.
 *
 * Defensive: this is the test that catches a regression where a
 * helper's signature drifts and breaks the composition path that
 * `getInProcessSubstrateStatus` + `/api/admin/dogfood-substrate-*`
 * routes rely on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
} from '../boot-all';
import {
  _resetTrackerForTests,
  recordMergedOps,
} from '../bootstrap-progress';
import {
  _resetBootHistoryForTests,
  recordBootEvent,
} from '../boot-history';
import { getInProcessSubstrateStatus } from '../in-process-status';
import { formatSubstrateStatus } from '../format-cli';
import type { BootedHarnessHandle } from '../boot';
import { makeFakeBootedHandle } from './fake-booted-handle';

afterEach(() => {
  _resetHandleMapForTests();
  _resetTrackerForTests();
  _resetBootHistoryForTests();
});

function fakeHandle(
  workspaceId: string,
  harnessSlug: string,
): BootedHarnessHandle {
  return makeFakeBootedHandle({ workspaceId, harnessSlug }).handle;
}

describe('substrate integration smoke', () => {
  it('disabled state — composer → formatter → exit 0', () => {
    const status = getInProcessSubstrateStatus({ forceDisabledForTest: true });
    const out = formatSubstrateStatus({
      enabled: status.substrateActive,
      bootedCount: status.bootedCount,
      harnesses: status.harnesses,
      summary: status.summary,
    });
    expect(out.exitCode).toBe(0);
    expect(out.lines.join('\n')).toContain('· off');
  });

  it('idle state — substrate on + no handles → composer says healthy → formatter exit 0', () => {
    const status = getInProcessSubstrateStatus();
    const out = formatSubstrateStatus({
      enabled: status.substrateActive,
      bootedCount: status.bootedCount,
      harnesses: status.harnesses,
      summary: status.summary,
    });
    expect(status.summary.worstVerdict).toBe('healthy');
    expect(out.exitCode).toBe(0);
  });

  it('healthy state — flag on + one handle + no claim errors → exit 0', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    recordBootEvent('ws-1', 'papercup', 'boot_start');
    recordBootEvent('ws-1', 'papercup', 'boot_ok');
    const status = getInProcessSubstrateStatus();
    expect(status.bootedCount).toBe(1);
    expect(status.summary.worstVerdict).toBe('healthy');
    const out = formatSubstrateStatus({
      enabled: status.substrateActive,
      bootedCount: status.bootedCount,
      harnesses: status.harnesses,
      summary: status.summary,
    });
    expect(out.exitCode).toBe(0);
    expect(out.lines.join('\n')).toContain('Workspace summary: healthy');
  });

  it('unhealthy state — flag on + claim errors > 25% → exit 1', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const status = getInProcessSubstrateStatus({
      resolveClaimStats: () => ({
        total: 100,
        won: 60,
        lost: 5,
        error: 35,
      }),
    });
    expect(status.summary.worstVerdict).toBe('unhealthy');
    const out = formatSubstrateStatus({
      enabled: status.substrateActive,
      bootedCount: status.bootedCount,
      harnesses: status.harnesses,
      summary: status.summary,
    });
    expect(out.exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain('unhealthy');
  });

  it('bootstrap-progress feeds into the snapshot', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    recordMergedOps('ws-1', 'a', 7);
    const status = getInProcessSubstrateStatus();
    // Healthy because progress is fresh + no claim errors.
    expect(status.harnesses[0]?.verdict).toBe('healthy');
  });

  it('boot-history events do not leak between harnesses', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
    recordBootEvent('ws-1', 'a', 'boot_ok');
    recordBootEvent('ws-1', 'b', 'boot_fail', 'stale lock');
    const status = getInProcessSubstrateStatus();
    expect(status.harnesses).toHaveLength(2);
    // Both are 'healthy' from the composer's POV — boot-history doesn't
    // feed verdict yet, only diagnostic surfaces. Asserts the two
    // signals stay independent.
    expect(status.summary.worstVerdict).toBe('healthy');
  });

  it('worst-wins aggregation matches per-row verdicts', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
    _setHandleForTests('ws-1', 'c', fakeHandle('ws-1', 'c'));
    const status = getInProcessSubstrateStatus({
      resolveClaimStats: (_w, slug) =>
        slug === 'b'
          ? { total: 100, won: 60, lost: 5, error: 35 } // unhealthy
          : slug === 'c'
            ? { total: 100, won: 89, lost: 5, error: 6 } // degraded (6%)
            : { total: 0, won: 0, lost: 0, error: 0 }, // healthy
    });
    const verdicts = status.harnesses.map((h) => h.verdict).sort();
    expect(verdicts).toEqual(['degraded', 'healthy', 'unhealthy']);
    expect(status.summary.worstVerdict).toBe('unhealthy');
    expect(status.summary.healthy).toBe(1);
    expect(status.summary.degraded).toBe(1);
    expect(status.summary.unhealthy).toBe(1);
  });
});
