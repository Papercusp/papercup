import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { FLEET_EKG: 'papercusp-fleet-ekg' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

// Importing the module registers the `fleet-ekg-scan` system action.
import { setFleetEkgGovernorGate, setFleetEkgTickDeps } from './fleet-ekg-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { FleetEkgTickDeps } from '../../fleet-ekg/scan';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('fleet-ekg-scan')!(ctx(over) as never);

function spyDeps(): FleetEkgTickDeps & { readSessions: ReturnType<typeof vi.fn> } {
  const readSessions = vi.fn(async () => []);
  return {
    readSessions,
    persistVectors: vi.fn(async () => {}),
    readCohort: vi.fn(async () => []),
    readLedger: vi.fn(async () => []),
    persistShifts: vi.fn(async () => []),
    alarm: vi.fn(async () => {}),
    markNotified: vi.fn(async () => {}),
    nowMs: () => 1_750_000_000_000,
    log: () => {},
  } as never;
}

let deps: ReturnType<typeof spyDeps>;
beforeEach(() => {
  deps = spyDeps();
  setFleetEkgTickDeps(deps);
  // Governor allows by default — the gate's own verdicts live in
  // lib/fleet-ekg/governor.test.ts; here we pin the action's wiring.
  setFleetEkgGovernorGate(async () => ({ allow: true, remainingUsd: 0 }));
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setFleetEkgTickDeps(null);
  setFleetEkgGovernorGate(null);
  vi.clearAllMocks();
});

describe('system:fleet-ekg-scan (self-learning-frontier P-030 / FB-10)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('fleet-ekg-scan')).toBeTypeOf('function');
  });

  it('flag OFF → no tick (the frontier D-001 arming gate)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readSessions).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('flag ON → runs the tick against the workspace', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readSessions).toHaveBeenCalledWith('ws-1', expect.any(Number));
    } finally {
      log.mockRestore();
    }
  });

  it('governor refuses → no tick (D-004 unattended-refusal, FB-01)', async () => {
    setFleetEkgGovernorGate(async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readSessions).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('learning-governor refused (unbudgeted)'));
    } finally {
      log.mockRestore();
    }
  });

  it('no gate override (the LIVE preflight) in a hermetic env → fail-closed, no tick', async () => {
    // The default gate must never reach a pool from a PG-free process: the
    // mocked getOrgPg yields no sql, the preflight fail-CLOSES, the tick is
    // refused (the default-on-flag-glue-vs-hermetic-unit-tests insight).
    setFleetEkgGovernorGate(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readSessions).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('payload_template tunes the embed window', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run({ payloadTemplate: { embedDays: 10 } });
      const sinceMs = deps.readSessions.mock.calls[0][1] as number;
      expect(1_750_000_000_000 - sinceMs).toBe(10 * 86_400_000);
    } finally {
      log.mockRestore();
    }
  });

  it('a tick failure never throws out of the durable step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      deps.readSessions.mockRejectedValue(new Error('pg down'));
      await expect(run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith('[fleet-ekg-scan] tick FAILED:', 'pg down');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
