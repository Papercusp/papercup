import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { DEFERRAL_INTEREST: 'papercusp-deferral-interest' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

// Importing the module registers the `deferral-interest-refit` system action.
import { setDeferralGovernorGate, setDeferralRefitDeps } from './deferral-interest-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { DeferralRefitDeps } from '../../deferral-interest/refit';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('deferral-interest-refit')!(ctx(over) as never);

function spyDeps(): DeferralRefitDeps & { readCandidates: ReturnType<typeof vi.fn> } {
  const readCandidates = vi.fn(async () => []);
  return {
    readCandidates,
    readEdges: vi.fn(async () => []),
    saveModel: vi.fn(async () => {}),
    log: () => {},
  } as never;
}

let deps: ReturnType<typeof spyDeps>;
beforeEach(() => {
  deps = spyDeps();
  setDeferralRefitDeps(deps);
  // Governor allows by default — the gate's own verdicts live in
  // lib/deferral-interest/governor.test.ts; here we pin the action's wiring.
  setDeferralGovernorGate(async () => ({ allow: true, remainingUsd: 0 }));
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setDeferralRefitDeps(null);
  setDeferralGovernorGate(null);
  vi.clearAllMocks();
});

describe('system:deferral-interest-refit (self-learning-frontier P-042 / FB-14)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('deferral-interest-refit')).toBeTypeOf('function');
  });

  it('flag OFF → no tick (the frontier D-001 arming gate)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readCandidates).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('flag ON + governor allow → runs the refit tick', async () => {
    await run();
    expect(deps.readCandidates).toHaveBeenCalledTimes(1);
    expect(deps.saveModel).toHaveBeenCalledTimes(1);
  });

  it('governor refuses → no tick (D-004 unattended-refusal, FB-01)', async () => {
    setDeferralGovernorGate(async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readCandidates).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('learning-governor refused (unbudgeted)'));
    } finally {
      log.mockRestore();
    }
  });

  it('no gate override (the LIVE preflight) in a hermetic env → fail-closed, no tick', async () => {
    // The default gate must never reach a pool from a PG-free process: the
    // mocked getOrgPg yields no sql, the preflight fail-CLOSES, the tick is
    // refused (the default-on-flag-glue-vs-hermetic-unit-tests insight).
    setDeferralGovernorGate(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.readCandidates).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('a tick failure never throws out of the durable step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      deps.readCandidates.mockRejectedValue(new Error('pg down'));
      await expect(run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith('[deferral-interest-refit] tick FAILED:', 'pg down');
    } finally {
      warn.mockRestore();
    }
  });
});
