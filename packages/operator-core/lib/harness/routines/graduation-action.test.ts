import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { GRADUATION_TRACKER: 'papercusp-graduation-tracker' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

// Importing the module registers the `graduation-scan` system action.
import { setGraduationGovernorGate, setGraduationTickDeps } from './graduation-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { GraduationTickDeps } from '../../graduation/scan';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('graduation-scan')!(ctx(over) as never);

function spyDeps(): GraduationTickDeps & { listResolved: ReturnType<typeof vi.fn>; fileReport: ReturnType<typeof vi.fn> } {
  const listResolved = vi.fn(async () => []);
  const fileReport = vi.fn(async () => ({ ok: true, created: true, possibleDuplicates: [] }));
  return {
    evidence: {
      listResolvedImprovements: listResolved,
      listAutoResolvedItemIds: vi.fn(async () => new Set<string>()),
      listGymRegressions: vi.fn(async () => []),
      listEkgRegressions: vi.fn(async () => []),
    },
    fileReport,
    nowMs: () => 1_750_000_000_000,
    listResolved,
  } as never;
}

let deps: ReturnType<typeof spyDeps>;
beforeEach(() => {
  deps = spyDeps();
  setGraduationTickDeps(deps);
  // Governor allows by default — the gate's own verdicts live in
  // lib/graduation/governor.test.ts; here we pin the action's wiring.
  setGraduationGovernorGate(async () => ({ allow: true, remainingUsd: 0 }));
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setGraduationTickDeps(null);
  setGraduationGovernorGate(null);
  vi.clearAllMocks();
});

describe('system:graduation-scan (self-learning-frontier P-045/P-046 / FB-19)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('graduation-scan')).toBeTypeOf('function');
  });

  it('flag OFF → no tick (the frontier D-001 arming gate)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.listResolved).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('flag ON + governor allows → runs the tick', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.listResolved).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('0 class(es) counted'));
    } finally {
      log.mockRestore();
    }
  });

  it('governor refuses → no tick (D-004 unattended-refusal, FB-01)', async () => {
    setGraduationGovernorGate(async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.listResolved).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('learning-governor refused (unbudgeted)'));
    } finally {
      log.mockRestore();
    }
  });

  it('no gate override (the LIVE preflight) in a hermetic env → fail-closed, no tick', async () => {
    // The default gate must never reach a pool from a PG-free process: the
    // mocked getOrgPg yields no sql, the preflight fail-CLOSES, the tick is
    // refused (the default-on-flag-glue-vs-hermetic-unit-tests insight).
    setGraduationGovernorGate(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.listResolved).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('payload_template tunes the tick (mineOnly threads through)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run({ payloadTemplate: { mineOnly: true, threshold: 2 } });
      expect(deps.listResolved).toHaveBeenCalledTimes(1);
      expect(deps.fileReport).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('a tick failure never throws out of the durable step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      deps.listResolved.mockRejectedValue(new Error('pg down'));
      await expect(run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith('[graduation-scan] tick FAILED:', 'pg down');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
