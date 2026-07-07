/**
 * Paused-hive recovery — the missing detector for a hive PAUSED while work is
 * queued (autonomous-loop-canary-reliability-2026-06-29 P-003). The started-only
 * watchdog seams skip a paused hive, so this was a silent outage (the multi-day
 * daily-canary stall). Pure tests for the act-decision + the env tunables; the IO
 * deps are mocked only so importing ./watchdog has no load-time side effects.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve([]) }) }));
vi.mock('./wake', () => ({
  declareHiveTimeWake: vi.fn(),
  getHiveTimeWake: vi.fn(),
  readHiveWakeState: vi.fn(),
}));
vi.mock('./started', () => ({
  getHiveStarted: vi.fn(),
  listStartedWorkspaceLoops: vi.fn(),
  listPausedHives: vi.fn(),
  setHiveStarted: vi.fn(),
}));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({
    projects: [{ slug: 'live-hive', harness_kind: 'hive' }],
  })),
}));
// WI-3309: mutable so each test picks the K1 flag state; default OFF (legacy).
let wsCoordOn = false;
vi.mock('../workspace-brain-scope', () => ({
  isWorkspaceCoordinationOn: async () => wsCoordOn,
  workspaceBrainScopeKey: (ws: string, perHiveSlug: string, on: boolean) => (on ? ws : perHiveSlug),
  workspaceBrainReadKeys: (ws: string, perHiveSlug: string, on: boolean) =>
    on ? (perHiveSlug && perHiveSlug !== ws ? [ws, perHiveSlug] : [ws]) : [perHiveSlug],
}));

import {
  pausedHiveRecoverySweep,
  shouldActOnPausedHive,
  pausedRecoveryStaleSec,
  pausedRecoveryAutoResume,
  effectiveAutoResumeForPause,
} from './watchdog';
import { declareHiveTimeWake } from './wake';
import { listPausedHives, setHiveStarted } from './started';
import { loadHarnessRegistry } from '../harness-registry';

const HOUR = 3_600_000;

describe('shouldActOnPausedHive', () => {
  const base = {
    pausedAtMs: 0,
    now: 48 * HOUR,
    thresholdMs: 24 * HOUR,
    hasDemand: true,
    alreadyFiredRecently: false,
  };
  it('acts on a long-paused hive with demand', () => {
    expect(shouldActOnPausedHive(base)).toBe(true);
  });
  it('skips when paused less than the threshold (deliberate brief pause)', () => {
    expect(shouldActOnPausedHive({ ...base, now: 1 * HOUR })).toBe(false);
  });
  it('skips when there is no demand (idle by choice)', () => {
    expect(shouldActOnPausedHive({ ...base, hasDemand: false })).toBe(false);
  });
  it('skips when the pause time is unknown (never act blind)', () => {
    expect(shouldActOnPausedHive({ ...base, pausedAtMs: null })).toBe(false);
  });
  it('skips when already fired within the window (debounce)', () => {
    expect(shouldActOnPausedHive({ ...base, alreadyFiredRecently: true })).toBe(false);
  });
});

describe('effectiveAutoResumeForPause (WI-3261 — owner-reported: "I keep pausing the Mug and it keeps getting unpaused")', () => {
  it('a DELIBERATE pause is NEVER auto-resumed, even with the global knob on', () => {
    expect(effectiveAutoResumeForPause(true, true)).toBe(false);
  });
  it('a deliberate pause stays alert-only even if the global knob is already off', () => {
    expect(effectiveAutoResumeForPause(false, true)).toBe(false);
  });
  it('a NON-deliberate (plain/silent-outage) pause still auto-resumes when the global knob is on', () => {
    expect(effectiveAutoResumeForPause(true, false)).toBe(true);
  });
  it('a non-deliberate pause respects the global knob being off', () => {
    expect(effectiveAutoResumeForPause(false, false)).toBe(false);
  });
});

describe('pausedHiveRecoverySweep — stale registry residue (EI-8177)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC;
  });

  it('skips a paused row whose hive slug is no longer registered', async () => {
    process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC = '3600';
    (listPausedHives as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workspaceId: 'ws-1', installSlug: 'dead-hive', pausedAtMs: 0, deliberate: false },
    ]);
    (loadHarnessRegistry as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: [{ slug: 'live-hive', harness_kind: 'hive' }],
    });

    const res = await pausedHiveRecoverySweep({ now: 2 * HOUR });

    expect(res).toEqual([
      {
        workspaceId: 'ws-1',
        installSlug: 'dead-hive',
        outcome: 'skipped',
        reason: 'hive is no longer registered',
        pausedForMs: 2 * HOUR,
      },
    ]);
    expect(setHiveStarted).not.toHaveBeenCalled();
    expect(declareHiveTimeWake).not.toHaveBeenCalled();
  });
});

describe('pausedHiveRecoverySweep — scope correctness under WORKSPACE_COORDINATION (WI-3309, the Mug auto-unpause RECURRENCE)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    wsCoordOn = false;
    delete process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC;
  });

  it('NEVER acts on a per-hive placement row (an owner Stop of one mug) — no resume, no sentinel write', async () => {
    // The exact live shape that bypassed WI-3261: the owner's paused mug reads
    // deliberate:false (the placement writer recorded no provenance), plus stale
    // test-hive rows, all far past the threshold. The old sweep "recovered" each
    // via setHiveStarted, which collapsed onto the WORKSPACE SENTINEL — re-starting
    // the whole loop and wiping the sentinel's deliberate bit.
    wsCoordOn = true;
    process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC = '3600';
    (listPausedHives as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workspaceId: 'ws-1', installSlug: 'mug-hive', pausedAtMs: 0, deliberate: false },
      { workspaceId: 'ws-1', installSlug: 'xbench-stale', pausedAtMs: 0, deliberate: false },
    ]);

    const res = await pausedHiveRecoverySweep({ now: 48 * HOUR });

    expect(res.map((r) => r.outcome)).toEqual(['skipped', 'skipped']);
    expect(res[0].reason).toContain('per-hive placement bit');
    expect(setHiveStarted).not.toHaveBeenCalled();
    expect(declareHiveTimeWake).not.toHaveBeenCalled();
  });

  it('still evaluates the workspace SENTINEL row (the real loop bit) through the normal gates', async () => {
    wsCoordOn = true;
    process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC = '3600';
    (listPausedHives as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workspaceId: 'ws-1', installSlug: 'ws-1', pausedAtMs: 0, deliberate: true },
    ]);

    const res = await pausedHiveRecoverySweep({ now: 48 * HOUR });

    // NOT scope-skipped: the sentinel flows on to the demand/debounce gates
    // (the mocked sql yields no demand ⇒ no action) — and is never resumed here.
    expect(res).toEqual([]);
    expect(setHiveStarted).not.toHaveBeenCalled();
  });

  it('flag OFF keeps the legacy per-hive behavior (rows flow to the registry gate)', async () => {
    wsCoordOn = false;
    process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC = '3600';
    (listPausedHives as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workspaceId: 'ws-1', installSlug: 'dead-hive', pausedAtMs: 0, deliberate: false },
    ]);
    (loadHarnessRegistry as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: [{ slug: 'live-hive', harness_kind: 'hive' }],
    });

    const res = await pausedHiveRecoverySweep({ now: 2 * HOUR });

    expect(res).toHaveLength(1);
    expect(res[0].outcome).toBe('skipped');
    expect(res[0].reason).toBe('hive is no longer registered');
    expect(setHiveStarted).not.toHaveBeenCalled();
  });
});

describe('paused-recovery tunables', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('defaults to a 24h stale threshold', () => {
    delete process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC;
    expect(pausedRecoveryStaleSec()).toBe(86_400);
  });
  it('honors PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC (and <=0 = kill switch)', () => {
    process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC = '3600';
    expect(pausedRecoveryStaleSec()).toBe(3600);
    process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC = '0';
    expect(pausedRecoveryStaleSec()).toBe(0);
  });
  it('auto-resumes by default; off/0/false disable it', () => {
    delete process.env.PAPERCUSP_HIVE_PAUSED_AUTO_RESUME;
    expect(pausedRecoveryAutoResume()).toBe(true);
    for (const v of ['off', '0', 'false']) {
      process.env.PAPERCUSP_HIVE_PAUSED_AUTO_RESUME = v;
      expect(pausedRecoveryAutoResume()).toBe(false);
    }
  });
});
