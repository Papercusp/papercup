/**
 * substrate-booted-handles-pg.test.ts — EI-19327550671915579 (part 2 of
 * EI-18735338283879820).
 *
 * The cross-SERVICE leg: a fake PG-backed `operator_state` row stands in for
 * the real table (this module is a thin wrapper over readOperatorState /
 * writeOperatorState, whose own round-trip is exercised elsewhere) so these
 * tests stay unit-level and deterministic via fake timers, mirroring
 * cluster-booted-handles-sync.test.ts's PRIMARY-side conventions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: {
    booted: Array<{ workspaceId: string; harnessSlug: string }>;
    relocated: Array<{ workspaceId: string; harnessSlug: string }>;
    row: unknown;
  } = { booted: [], relocated: [], row: null };
  return {
    state,
    listBootedHandles: () => state.booted,
    listRelocatedBootedHandles: () => state.relocated,
    readOperatorState: vi.fn(async () => state.row),
    writeOperatorState: vi.fn(async (_table: string, payload: unknown) => {
      state.row = payload;
    }),
  };
});
vi.mock('./boot-all', () => ({
  listBootedHandles: H.listBootedHandles,
  listRelocatedBootedHandles: H.listRelocatedBootedHandles,
}));
vi.mock('./substrate-socket-path', () => ({ resolveSubstrateSocketPath: () => '/tmp/substrate-owner.sock' }));
vi.mock('../../operator-state-pg', () => ({
  readOperatorState: H.readOperatorState,
  writeOperatorState: H.writeOperatorState,
}));

import {
  startBootedHandlesPgPublisher,
  getPgBootedHandlesSnapshotFallback,
  getPgRelocatedHarnessEndpoint,
} from './substrate-booted-handles-pg';

beforeEach(() => {
  H.state.booted = [];
  H.state.relocated = [];
  H.state.row = null;
  H.readOperatorState.mockClear();
  H.writeOperatorState.mockClear();
});

describe('startBootedHandlesPgPublisher (SUBSTRATE-OWNER side)', () => {
  it('publishes immediately, then every intervalMs, with the latest listBootedHandles() snapshot', async () => {
    vi.useFakeTimers();
    try {
      H.state.booted = [{ workspaceId: 'ws1', harnessSlug: 'a' }];
      const h = startBootedHandlesPgPublisher({ intervalMs: 10_000, ownsSubstrate: true, now: () => 1_000 });
      // beat() runs SYNCHRONOUSLY once at start (mirrors startBootedHandlesBroadcaster) —
      // no timer needs to fire yet; advancing here would double-count the interval's own
      // first (10s-later) tick since fake timers treat any pending timer as immediately due.
      expect(H.writeOperatorState).toHaveBeenCalledTimes(1);
      expect(H.writeOperatorState).toHaveBeenLastCalledWith('substrate_booted_handles_status', {
        handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }],
        sentAt: 1_000,
        // EI-20575137548097507: published alongside the handles so a non-owner
        // reader can ASSESS them. Present-but-empty here (no liveness
        // registered in this fixture) is meaningfully different from absent:
        // absent means the reader must report health UNOBSERVED.
        replicationLiveness: [],
      });
      H.state.booted = [
        { workspaceId: 'ws1', harnessSlug: 'a' },
        { workspaceId: 'ws1', harnessSlug: 'b' },
      ];
      await vi.advanceTimersByTimeAsync(10_000);
      expect(H.writeOperatorState).toHaveBeenCalledTimes(2);
      expect((H.writeOperatorState.mock.calls[1]![1] as { handles: unknown[] }).handles).toHaveLength(2);
      h.stop();
      await vi.advanceTimersByTimeAsync(50_000);
      expect(H.writeOperatorState).toHaveBeenCalledTimes(2); // stopped — no further writes
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * EI-18735338283879820's rule, applied to the cross-service leg too: a
   * non-owner's local map is unconditionally empty, and a fresh empty write
   * is indistinguishable from a genuine owner reporting an idle substrate —
   * it would manufacture the exact confident-false-zero WI-4070 chased for
   * 15 days. Silence (no row written) is correct; the reader then honestly
   * reports reachedSubstrateOwner:false.
   */
  it('does NOT publish at all when this process does not own the substrate', async () => {
    vi.useFakeTimers();
    try {
      H.state.booted = [];
      const h = startBootedHandlesPgPublisher({ intervalMs: 10_000, ownsSubstrate: false });
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(H.writeOperatorState).not.toHaveBeenCalled();
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows a write rejection rather than crashing the timer', async () => {
    vi.useFakeTimers();
    try {
      H.writeOperatorState.mockRejectedValueOnce(new Error('pg hiccup'));
      const h = startBootedHandlesPgPublisher({ intervalMs: 1_000, ownsSubstrate: true });
      await expect(vi.advanceTimersByTimeAsync(3_000)).resolves.not.toThrow();
      expect(H.writeOperatorState.mock.calls.length).toBeGreaterThan(1);
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('EI-20438405483051865: advertises the sidecar socket with relocated handles only', () => {
    H.state.booted = [
      { workspaceId: 'ws1', harnessSlug: 'in-process' },
      { workspaceId: 'ws1', harnessSlug: 'relocated' },
    ];
    H.state.relocated = [{ workspaceId: 'ws1', harnessSlug: 'relocated' }];

    const h = startBootedHandlesPgPublisher({ ownsSubstrate: true, now: () => 5_000 });
    expect(H.writeOperatorState).toHaveBeenLastCalledWith('substrate_booted_handles_status', {
      handles: H.state.booted,
      sentAt: 5_000,
      replicationLiveness: [],
      sidecar: {
        socketPath: '/tmp/substrate-owner.sock',
        handles: [{ workspaceId: 'ws1', harnessSlug: 'relocated' }],
      },
    });
    h.stop();
  });
});

describe('getPgBootedHandlesSnapshotFallback (READER side)', () => {
  it('returns null when no row has ever been written', async () => {
    H.state.row = null;
    expect(await getPgBootedHandlesSnapshotFallback()).toBeNull();
  });

  it('returns the row, shaped as a RemoteBootedHandlesSnapshot, when fresh', async () => {
    H.state.row = { handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }], sentAt: 1_000 };
    const snap = await getPgBootedHandlesSnapshotFallback({ now: () => 1_500, maxAgeMs: 30_000 });
    expect(snap).toEqual({ handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }], receivedAt: 1_000 });
  });

  it('returns null when the row is older than maxAgeMs (a wedged/dead owner)', async () => {
    H.state.row = { handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }], sentAt: 1_000 };
    const snap = await getPgBootedHandlesSnapshotFallback({ now: () => 1_000 + 30_001, maxAgeMs: 30_000 });
    expect(snap).toBeNull();
  });

  it('always does a FRESH read (fresh:true), never the TTL-cached path', async () => {
    H.state.row = { handles: [], sentAt: 1_000 };
    await getPgBootedHandlesSnapshotFallback({ now: () => 1_000 });
    expect(H.readOperatorState).toHaveBeenCalledWith('substrate_booted_handles_status', undefined, { fresh: true });
  });

  it('degrades to null (never throws) on a PG read failure', async () => {
    H.readOperatorState.mockRejectedValueOnce(new Error('pg down'));
    await expect(getPgBootedHandlesSnapshotFallback()).resolves.toBeNull();
  });

  it('returns null for a malformed row (missing/wrong-typed fields)', async () => {
    H.state.row = { handles: 'not-an-array', sentAt: 1_000 };
    expect(await getPgBootedHandlesSnapshotFallback({ now: () => 1_000 })).toBeNull();
    H.state.row = { handles: [] }; // sentAt missing
    expect(await getPgBootedHandlesSnapshotFallback({ now: () => 1_000 })).toBeNull();
  });
});

describe('getPgRelocatedHarnessEndpoint (cross-process dial discovery)', () => {
  it('returns only a fresh, absolute-path advertisement for the exact relocated handle', async () => {
    H.state.row = {
      handles: [
        { workspaceId: 'ws1', harnessSlug: 'in-process' },
        { workspaceId: 'ws1', harnessSlug: 'relocated' },
      ],
      sentAt: 1_000,
      sidecar: {
        socketPath: '/tmp/substrate-owner.sock',
        handles: [{ workspaceId: 'ws1', harnessSlug: 'relocated' }],
      },
    };

    await expect(
      getPgRelocatedHarnessEndpoint('ws1', 'relocated', { now: () => 1_500 }),
    ).resolves.toEqual({ socketPath: '/tmp/substrate-owner.sock', advertisedAt: 1_000 });
    await expect(
      getPgRelocatedHarnessEndpoint('ws1', 'in-process', { now: () => 1_500 }),
    ).resolves.toBeNull();
    await expect(
      getPgRelocatedHarnessEndpoint('other-ws', 'relocated', { now: () => 1_500 }),
    ).resolves.toBeNull();

    await expect(
      getPgRelocatedHarnessEndpoint('ws1', 'relocated', { now: () => 31_001, maxAgeMs: 30_000 }),
    ).resolves.toBeNull();
    H.state.row = {
      ...(H.state.row as Record<string, unknown>),
      sidecar: {
        socketPath: 'relative/substrate.sock',
        handles: [{ workspaceId: 'ws1', harnessSlug: 'relocated' }],
      },
    };
    await expect(
      getPgRelocatedHarnessEndpoint('ws1', 'relocated', { now: () => 1_500 }),
    ).resolves.toBeNull();
  });
});
