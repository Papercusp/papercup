import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    NEOLOGISM_MINER: 'papercusp-neologism-miner',
    LEARNING_GOVERNOR: 'papercusp-learning-governor',
  },
  ALL_FLAG_KEYS: [],
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

// Importing the module registers the `neologism-mine` system action.
import { setNeologismGovernorGate, setNeologismTickDeps } from './neologism-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { NeologismTickDeps } from '../../neologism/scan';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('neologism-mine')!(ctx(over) as never);

function spyDeps(): NeologismTickDeps & { readRows: ReturnType<typeof vi.fn> } {
  const readRows = vi.fn(async () => []);
  return {
    readRows,
    readInsights: vi.fn(async () => []),
    readNamespaces: vi.fn(async () => []),
    capture: vi.fn(),
    log: () => {},
  } as never;
}

let deps: ReturnType<typeof spyDeps>;
beforeEach(() => {
  deps = spyDeps();
  setNeologismTickDeps(deps);
  // Governor allows by default — the gate's own verdicts live in
  // lib/neologism/governor.test.ts; here we pin the action's wiring.
  setNeologismGovernorGate(async () => ({ allow: true, remainingUsd: 0 }));
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setNeologismTickDeps(null);
  setNeologismGovernorGate(null);
  vi.clearAllMocks();
});

describe('system:neologism-mine (self-learning-frontier P-011 / FB-05)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('neologism-mine')).toBeTypeOf('function');
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

  it('governor refuses → no tick (D-004 unattended-refusal, FB-01)', async () => {
    setNeologismGovernorGate(async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readRows).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('learning-governor refused (unbudgeted)'));
    } finally {
      log.mockRestore();
    }
  });

  it('no gate override (the LIVE preflight) in a hermetic env → fail-closed, no tick', async () => {
    // The default gate must never reach a pool from a PG-free process: the
    // mocked getOrgPg yields no sql, the preflight fail-CLOSES, the tick is
    // refused (the default-on-flag-glue-vs-hermetic-unit-tests insight).
    setNeologismGovernorGate(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readRows).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('payload_template tunes the window', async () => {
    await run({ payloadTemplate: { windowDays: 7 } });
    expect(deps.readRows).toHaveBeenCalledWith('ws-1', 7);
  });

  it('a tick failure never throws out of the durable step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      deps.readRows.mockRejectedValue(new Error('pg down'));
      await expect(run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith('[neologism-mine] tick FAILED:', 'pg down');
    } finally {
      warn.mockRestore();
    }
  });
});
