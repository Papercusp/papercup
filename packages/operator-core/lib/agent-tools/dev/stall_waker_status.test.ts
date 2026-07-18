/**
 * dev:stall_waker_status — the tool wrapper over getStallWakerStatus() (EI-2432).
 * getStallWakerStatus itself is mocked; this only checks the wrapper's own
 * shaping (spreads the status onto `{ ok: true, ... }`, under `data`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getStallWakerStatus: vi.fn(),
}));

vi.mock('../../inference-gateway/stall-waker-loop', () => ({ getStallWakerStatus: h.getStallWakerStatus }));

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

async function run() {
  const res = await (tool.handler as (a: unknown, c?: unknown) => Promise<{ data: Record<string, unknown> }>)({}, {});
  return res.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getStallWakerStatus.mockReturnValue(fakeStatus());
});

describe('dev:stall_waker_status', () => {
  it('wraps the live status with ok:true', async () => {
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.running).toBe(true);
    expect(out.workspaceId).toBe('papercusp-workspace');
    expect(out.pendingCount).toBe(1);
    expect(out.wokenTotal).toBe(5);
  });

  it('surfaces a not-running snapshot verbatim (never started / stopped)', async () => {
    h.getStallWakerStatus.mockReturnValue(
      fakeStatus({ running: false, workspaceId: null, startedAt: null, tickCount: 0, lastTickAt: null, pendingCount: 0 }),
    );
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.running).toBe(false);
    expect(out.workspaceId).toBeNull();
    expect(out.tickCount).toBe(0);
  });

  it('surfaces a failed-tick snapshot (lastTickOk:false + the error)', async () => {
    h.getStallWakerStatus.mockReturnValue(fakeStatus({ lastTickOk: false, lastTickError: 'boom' }));
    const out = await run();
    expect(out.lastTickOk).toBe(false);
    expect(out.lastTickError).toBe('boom');
  });
});
