/**
 * dev:stall_waker_status — the tool wrapper over getStallWakerStatus() (EI-2432),
 * now federating to sibling processes when the local reading is not-running
 * (EI-22054545312178322). getStallWakerStatus and collectSiblingManagedTimers
 * are both mocked; this checks the wrapper's shaping AND its local-vs-federated
 * selection logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getStallWakerStatus: vi.fn(),
  collectSiblingManagedTimers: vi.fn(),
}));

vi.mock('../../inference-gateway/stall-waker-loop', () => ({ getStallWakerStatus: h.getStallWakerStatus }));
vi.mock('../../schedule-federation', () => ({ collectSiblingManagedTimers: h.collectSiblingManagedTimers }));

import tool from './stall_waker_status';

function fakeStatus(overrides: Partial<ReturnType<typeof h.getStallWakerStatus>> = {}) {
  return {
    running: true,
    workspaceId: 'papercusp-workspace',
    startedAt: 1_700_000_000_000,
    pollMs: 20_000,
    idleSilenceMs: 30_000,
    tickCount: 42,
    lastTickAt: 1_700_000_500_000,
    lastTickOk: true,
    lastTickError: null,
    pendingCount: 1,
    breadcrumbCount: 2,
    wokenTotal: 5,
    droppedTotal: 3,
    unwedgedTotal: 1,
    ...overrides,
  };
}

/** A minimal SiblingManagedTimers row, as schedule-federation.ts's probeSibling produces. */
function fakeSibling(overrides: {
  ok?: boolean;
  label?: string;
  stallWaker?: ReturnType<typeof fakeStatus> | null;
} = {}) {
  return {
    port: 3271,
    pid: 12345,
    label: overrides.label ?? 'bg-host:3271',
    process: 'bg-host',
    ok: overrides.ok ?? true,
    timers: [],
    dbosSchedules: [],
    stallWaker: overrides.stallWaker === undefined ? null : overrides.stallWaker,
    elapsedMs: 5,
  };
}

async function run() {
  const res = await (tool.handler as (a: unknown, c?: unknown) => Promise<{ data: Record<string, unknown> }>)({}, {});
  return res.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getStallWakerStatus.mockReturnValue(fakeStatus());
  // Default: no siblings answer (matches an unfederated single-process host); each
  // running:false test below overrides this per-case.
  h.collectSiblingManagedTimers.mockResolvedValue([]);
});

describe('dev:stall_waker_status', () => {
  it('wraps the live status with ok:true (running locally — fast path, no federation)', async () => {
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.source).toBe('local');
    expect(out.running).toBe(true);
    expect(out.workspaceId).toBe('papercusp-workspace');
    expect(out.pendingCount).toBe(1);
    expect(out.wokenTotal).toBe(5);
    // Local copy is already running — no reason to pay the sibling fan-out cost.
    expect(h.collectSiblingManagedTimers).not.toHaveBeenCalled();
  });

  it('surfaces a not-running snapshot verbatim when no sibling reports it running either', async () => {
    h.getStallWakerStatus.mockReturnValue(
      fakeStatus({ running: false, workspaceId: null, startedAt: null, tickCount: 0, lastTickAt: null, pendingCount: 0 }),
    );
    h.collectSiblingManagedTimers.mockResolvedValue([
      fakeSibling({ stallWaker: fakeStatus({ running: false }) }),
      fakeSibling({ ok: false, label: 'operator:3170', stallWaker: null }),
    ]);
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.source).toBe('local');
    expect(out.running).toBe(false);
    expect(out.workspaceId).toBeNull();
    expect(out.tickCount).toBe(0);
  });

  it('federates to a sibling reporting running:true (EI-22054545312178322 — the bug this fixes)', async () => {
    h.getStallWakerStatus.mockReturnValue(fakeStatus({ running: false, workspaceId: null, tickCount: 0 }));
    const remoteStatus = fakeStatus({ workspaceId: 'papercusp-workspace', tickCount: 99, wokenTotal: 12 });
    h.collectSiblingManagedTimers.mockResolvedValue([fakeSibling({ label: 'bg-host:3271', stallWaker: remoteStatus })]);
    const out = await run();
    expect(out.ok).toBe(true);
    // Reports the SIBLING's status, not the caller's own false-negative local read.
    expect(out.source).toBe('bg-host:3271');
    expect(out.running).toBe(true);
    expect(out.tickCount).toBe(99);
    expect(out.wokenTotal).toBe(12);
  });

  it('skips a sibling that did not answer or answered running:false, prefers one that answered running:true', async () => {
    h.getStallWakerStatus.mockReturnValue(fakeStatus({ running: false }));
    h.collectSiblingManagedTimers.mockResolvedValue([
      fakeSibling({ ok: false, label: 'operator:3170', stallWaker: null }),
      fakeSibling({ ok: true, label: 'operator:3070', stallWaker: fakeStatus({ running: false }) }),
      fakeSibling({ ok: true, label: 'bg-host:3271', stallWaker: fakeStatus({ running: true, tickCount: 7 }) }),
    ]);
    const out = await run();
    expect(out.source).toBe('bg-host:3271');
    expect(out.running).toBe(true);
    expect(out.tickCount).toBe(7);
  });

  it('federation failure degrades to the honest local (not-running) reading, never throws', async () => {
    h.getStallWakerStatus.mockReturnValue(fakeStatus({ running: false }));
    h.collectSiblingManagedTimers.mockRejectedValue(new Error('discovery dir unreadable'));
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.source).toBe('local');
    expect(out.running).toBe(false);
  });

  it('surfaces a failed-tick snapshot (lastTickOk:false + the error)', async () => {
    h.getStallWakerStatus.mockReturnValue(fakeStatus({ lastTickOk: false, lastTickError: 'boom' }));
    const out = await run();
    expect(out.lastTickOk).toBe(false);
    expect(out.lastTickError).toBe('boom');
  });
});
