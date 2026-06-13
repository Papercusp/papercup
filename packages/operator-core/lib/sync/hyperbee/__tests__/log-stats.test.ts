import { afterEach, describe, expect, it } from 'vitest';
import {
  computeHarnessLogStats,
  collectSubstrateLogStats,
  type LogStatsHandleLike,
} from '../log-stats';
import { _resetHandleMapForTests, _setHandleForTests } from '../boot-all';
import { makeFakeBootedHandle } from './fake-booted-handle';

/**
 * substrate-peer-log-compaction-2026-06-13 P-001/P-002 — log-growth + replay-cost
 * observability (the signal for the P-009 compaction decision).
 */

function fakeLog(keyHex: string, length: number) {
  return { keyHex, length };
}

function handle(
  workspaceId: string,
  harnessSlug: string,
  ownKey: string,
  ownLen: number,
  admitted: ReadonlyArray<[string, number]>,
): LogStatsHandleLike {
  return {
    workspaceId,
    harnessSlug,
    ownLog: fakeLog(ownKey, ownLen),
    admitted: new Map(admitted.map(([k, n]) => [k, fakeLog(k, n)])),
  };
}

afterEach(() => _resetHandleMapForTests());

describe('computeHarnessLogStats (pure)', () => {
  it('sums admitted lengths into replayCostOps and finds the largest', () => {
    // own=OWN(10) + two remotes(5, 100). replay cost = a joiner folds all three.
    const s = computeHarnessLogStats(
      handle('ws', 'h', 'OWN', 10, [['OWN', 10], ['R1', 5], ['R2', 100]]),
    );
    expect(s.replayCostOps).toBe(115);
    expect(s.largestLogOps).toBe(100);
    expect(s.ownLogOps).toBe(10);
    expect(s.admittedLogCount).toBe(3);
  });

  it('marks the own log and sorts perLog largest-first', () => {
    const s = computeHarnessLogStats(
      handle('ws', 'h', 'OWN', 10, [['OWN', 10], ['R1', 5], ['R2', 100]]),
    );
    expect(s.perLog.map((p) => p.keyHex)).toEqual(['R2', 'OWN', 'R1']);
    expect(s.perLog.find((p) => p.keyHex === 'OWN')?.isOwn).toBe(true);
    expect(s.perLog.find((p) => p.keyHex === 'R2')?.isOwn).toBe(false);
  });

  it('reads ownLogOps from the own log even if it is absent from the admitted map', () => {
    // admitted has only a remote; own log length still reported from ownLog.
    const s = computeHarnessLogStats(handle('ws', 'h', 'OWN', 7, [['R1', 3]]));
    expect(s.ownLogOps).toBe(7);
    expect(s.replayCostOps).toBe(3); // replay = what's in the admitted set
    expect(s.admittedLogCount).toBe(1);
  });

  it('handles an empty admitted set (fresh peer, nothing replicated yet)', () => {
    const s = computeHarnessLogStats(handle('ws', 'h', 'OWN', 0, []));
    expect(s.replayCostOps).toBe(0);
    expect(s.largestLogOps).toBe(0);
    expect(s.ownLogOps).toBe(0);
    expect(s.perLog).toEqual([]);
  });
});

describe('collectSubstrateLogStats (over the boot registry)', () => {
  it('returns [] when no harness is booted', () => {
    expect(collectSubstrateLogStats()).toEqual([]);
  });

  it('returns one stats entry per booted harness', () => {
    _setHandleForTests('ws-1', 'a', makeFakeBootedHandle({ workspaceId: 'ws-1', harnessSlug: 'a', keyHex: 'aa'.repeat(32) }).handle);
    _setHandleForTests('ws-1', 'b', makeFakeBootedHandle({ workspaceId: 'ws-1', harnessSlug: 'b', keyHex: 'bb'.repeat(32) }).handle);
    const all = collectSubstrateLogStats();
    expect(all).toHaveLength(2);
    const slugs = all.map((s) => s.harnessSlug).sort();
    expect(slugs).toEqual(['a', 'b']);
    // A fresh fake handle has an own log seeded into admitted with 0 ops.
    const a = all.find((s) => s.harnessSlug === 'a')!;
    expect(a.admittedLogCount).toBe(1);
    expect(a.replayCostOps).toBe(0);
    expect(a.ownLogOps).toBe(0);
  });

  it('reflects appended ops as own-log growth', async () => {
    const { handle: h } = makeFakeBootedHandle({ workspaceId: 'ws-1', harnessSlug: 'a', keyHex: 'cc'.repeat(32) });
    _setHandleForTests('ws-1', 'a', h);
    await h.append({ type: 'put', table: 'queue', hbKey: 'F-1', value: {}, ts: 1, schema_version: 1 });
    await h.append({ type: 'put', table: 'queue', hbKey: 'F-2', value: {}, ts: 2, schema_version: 1 });
    const [s] = collectSubstrateLogStats();
    expect(s.ownLogOps).toBe(2);
    expect(s.replayCostOps).toBe(2); // own log is in the admitted set
  });
});
