import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { NEGATIVE_SPACE_MINER: 'papercusp-negative-space-miner' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

// Importing the module registers the `negative-space-mine` system action.
import { setNegativeSpaceTickDeps } from './negative-space-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { NegativeSpaceTickDeps } from '../../negative-space/scan';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('negative-space-mine')!(ctx(over) as never);

function spyDeps(): NegativeSpaceTickDeps & { readRows: ReturnType<typeof vi.fn> } {
  const readRows = vi.fn(async () => []);
  return {
    readRows,
    persist: vi.fn(async (_ws: string, entries: never[]) => entries),
    capture: vi.fn(),
    markFiled: vi.fn(),
    log: () => {},
  } as never;
}

let deps: ReturnType<typeof spyDeps>;
beforeEach(() => {
  deps = spyDeps();
  setNegativeSpaceTickDeps(deps);
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setNegativeSpaceTickDeps(null);
  vi.clearAllMocks();
});

describe('system:negative-space-mine (self-learning-frontier P-010 / FB-04)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('negative-space-mine')).toBeTypeOf('function');
  });

  it('flag OFF → no tick (the frontier D-001 arming gate)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    await run();
    expect(deps.readRows).not.toHaveBeenCalled();
  });

  it('flag ON → runs the tick against the workspace', async () => {
    await run();
    expect(deps.readRows).toHaveBeenCalledWith('ws-1', 30);
  });

  it('payload_template tunes the window', async () => {
    await run({ payloadTemplate: { windowDays: 7 } });
    expect(deps.readRows).toHaveBeenCalledWith('ws-1', 7);
  });

  it('a tick failure never throws out of the durable step', async () => {
    deps.readRows.mockRejectedValue(new Error('pg down'));
    await expect(run()).resolves.toBeUndefined();
  });
});
