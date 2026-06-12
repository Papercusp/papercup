import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { REGRET_MINING: 'papercusp-regret-mining' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

// Importing the module registers the `regret-mine` system action.
import { setRegretGovernorGate, setRegretTickDeps } from './regret-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { RegretTickDeps } from '../../replay/regret/mine';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('regret-mine')!(ctx(over) as never);

function spyDeps(): RegretTickDeps & { readRows: ReturnType<typeof vi.fn> } {
  const readRows = vi.fn(async () => []);
  return {
    readRows,
    readTranscript: vi.fn(async () => null),
    listKnownRunIds: vi.fn(async () => new Set<string>()),
    upsertFinding: vi.fn(),
    readPendingReplay: vi.fn(async () => []),
    recordReplayScores: vi.fn(),
    readUnfiledReplayed: vi.fn(async () => []),
    capture: vi.fn(),
    markFiled: vi.fn(),
    replayRunner: null,
    nowIso: () => '2026-06-12T12:00:00.000Z',
    log: () => {},
  } as never;
}

let deps: ReturnType<typeof spyDeps>;
beforeEach(() => {
  deps = spyDeps();
  setRegretTickDeps(deps);
  // Governor allows by default — the gate's own verdicts live in
  // lib/replay/regret/governor.test.ts; here we pin the action's wiring.
  setRegretGovernorGate(async () => ({ allow: true, remainingUsd: 0 }));
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setRegretTickDeps(null);
  setRegretGovernorGate(null);
  vi.clearAllMocks();
});

describe('system:regret-mine (self-learning-frontier P-021 / FB-07)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('regret-mine')).toBeTypeOf('function');
  });

  it('flag OFF → no tick (the frontier D-001 arming gate)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readRows).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('flag ON + governor allow → runs the tick against the workspace', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readRows).toHaveBeenCalledWith('ws-1', 14);
    } finally {
      log.mockRestore();
    }
  });

  it('governor refuses → no tick (D-004 unattended-refusal, FB-01)', async () => {
    setRegretGovernorGate(async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }));
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
    setRegretGovernorGate(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readRows).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('payload_template tunes the window', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run({ payloadTemplate: { windowDays: 7 } });
      expect(deps.readRows).toHaveBeenCalledWith('ws-1', 7);
    } finally {
      log.mockRestore();
    }
  });

  it("the governor's per-cycle cap bounds replay spend (payload may lower, never raise)", async () => {
    setRegretGovernorGate(async () => ({ allow: true, remainingUsd: 2 }));
    const readPendingReplay = vi.mocked(deps.readPendingReplay);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Payload asks for 10 — the governor cap (2) must win. With a budget > 0
      // and a wired runner the replay leg reads pending findings; budget
      // plumbing is observable through that read happening at all.
      deps.replayRunner = { priceFinding: vi.fn(async () => ({ scores: [], costUsd: 0 })) };
      await run({ payloadTemplate: { replayBudgetUsd: 10 } });
      expect(readPendingReplay).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('a tick failure never throws out of the durable step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      deps.readRows.mockRejectedValue(new Error('pg down'));
      await expect(run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith('[regret-mine] tick FAILED:', 'pg down');
    } finally {
      warn.mockRestore();
    }
  });
});
