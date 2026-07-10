/**
 * Paused-pot recovery — the missing detector for a pot PAUSED while work is
 * queued (autonomous-loop-canary-reliability-2026-06-29 P-003). The started-only
 * watchdog seams skip a paused pot, so this was a silent outage (the multi-day
 * daily-canary stall). Pure tests for the act-decision + the env tunables; the IO
 * deps are mocked only so importing ./watchdog has no load-time side effects.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve([]) }) }));
vi.mock('./wake', () => ({
  declarePotTimeWake: vi.fn(),
  getPotTimeWake: vi.fn(),
  readPotWakeState: vi.fn(),
}));
vi.mock('./started', () => ({
  getPotStarted: vi.fn(),
  listStartedWorkspaceLoops: vi.fn(),
  listPausedPots: vi.fn(),
  setPotStarted: vi.fn(),
}));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({
    projects: [{ slug: 'live-pot', harness_kind: 'hive' }],
  })),
}));
// WI-3309: mutable so each test picks the K1 flag state; default OFF (legacy).
let wsCoordOn = false;
vi.mock('../workspace-brain-scope', () => ({
  isWorkspaceCoordinationOn: async () => wsCoordOn,
  workspaceBrainScopeKey: (ws: string, perPotSlug: string, on: boolean) => (on ? ws : perPotSlug),
  workspaceBrainReadKeys: (ws: string, perPotSlug: string, on: boolean) =>
    on ? (perPotSlug && perPotSlug !== ws ? [ws, perPotSlug] : [ws]) : [perPotSlug],
}));

import {
  pausedPotRecoverySweep,
  shouldActOnPausedPot,
  pausedRecoveryStaleSec,
  pausedRecoveryAutoResume,
  effectiveAutoResumeForPause,
} from './watchdog';
import { declarePotTimeWake } from './wake';
import { listPausedPots, setPotStarted } from './started';
import { loadHarnessRegistry } from '../harness-registry';

const HOUR = 3_600_000;

describe('shouldActOnPausedPot', () => {
  const base = {
    pausedAtMs: 0,
    now: 48 * HOUR,
    thresholdMs: 24 * HOUR,
    hasDemand: true,
    alreadyFiredRecently: false,
  };
  it('acts on a long-paused pot with demand', () => {
    expect(shouldActOnPausedPot(base)).toBe(true);
  });
  it('skips when paused less than the threshold (deliberate brief pause)', () => {
    expect(shouldActOnPausedPot({ ...base, now: 1 * HOUR })).toBe(false);
  });
  it('skips when there is no demand (idle by choice)', () => {
    expect(shouldActOnPausedPot({ ...base, hasDemand: false })).toBe(false);
  });
  it('skips when the pause time is unknown (never act blind)', () => {
    expect(shouldActOnPausedPot({ ...base, pausedAtMs: null })).toBe(false);
  });
  it('skips when already fired within the window (debounce)', () => {
    expect(shouldActOnPausedPot({ ...base, alreadyFiredRecently: true })).toBe(false);
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

describe('pausedPotRecoverySweep — stale registry residue (EI-8177)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC;
  });

  it('skips a paused row whose pot slug is no longer registered', async () => {
    process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC = '3600';
    (listPausedPots as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workspaceId: 'ws-1', installSlug: 'dead-pot', pausedAtMs: 0, deliberate: false },
    ]);
    (loadHarnessRegistry as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: [{ slug: 'live-pot', harness_kind: 'hive' }],
    });

    const res = await pausedPotRecoverySweep({ now: 2 * HOUR });

    expect(res).toEqual([
      {
        workspaceId: 'ws-1',
        installSlug: 'dead-pot',
        outcome: 'skipped',
        reason: 'pot is no longer registered',
        pausedForMs: 2 * HOUR,
      },
    ]);
    expect(setPotStarted).not.toHaveBeenCalled();
    expect(declarePotTimeWake).not.toHaveBeenCalled();
  });
});

describe('pausedPotRecoverySweep — scope correctness under WORKSPACE_COORDINATION (WI-3309, the Mug auto-unpause RECURRENCE)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    wsCoordOn = false;
    delete process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC;
  });

  it('NEVER acts on a per-pot placement row (an owner Stop of one mug) — no resume, no papercup write', async () => {
    // The exact live shape that bypassed WI-3261: the owner's paused mug reads
    // deliberate:false (the placement writer recorded no provenance), plus stale
    // test-pot rows, all far past the threshold. The old sweep "recovered" each
    // via setPotStarted, which collapsed onto the WORKSPACE PAPERCUP — re-starting
    // the whole loop and wiping the papercup's deliberate bit.
    wsCoordOn = true;
    process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC = '3600';
    (listPausedPots as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workspaceId: 'ws-1', installSlug: 'mug-pot', pausedAtMs: 0, deliberate: false },
      { workspaceId: 'ws-1', installSlug: 'xbench-stale', pausedAtMs: 0, deliberate: false },
    ]);

    const res = await pausedPotRecoverySweep({ now: 48 * HOUR });

    expect(res.map((r) => r.outcome)).toEqual(['skipped', 'skipped']);
    expect(res[0].reason).toContain('per-pot placement bit');
    expect(setPotStarted).not.toHaveBeenCalled();
    expect(declarePotTimeWake).not.toHaveBeenCalled();
  });

  it('still evaluates the workspace PAPERCUP row (the real loop bit) through the normal gates', async () => {
    wsCoordOn = true;
    process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC = '3600';
    (listPausedPots as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workspaceId: 'ws-1', installSlug: 'ws-1', pausedAtMs: 0, deliberate: true },
    ]);

    const res = await pausedPotRecoverySweep({ now: 48 * HOUR });

    // NOT scope-skipped: the papercup flows on to the demand/debounce gates
    // (the mocked sql yields no demand ⇒ no action) — and is never resumed here.
    expect(res).toEqual([]);
    expect(setPotStarted).not.toHaveBeenCalled();
  });

  it('flag OFF keeps the legacy per-pot behavior (rows flow to the registry gate)', async () => {
    wsCoordOn = false;
    process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC = '3600';
    (listPausedPots as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workspaceId: 'ws-1', installSlug: 'dead-pot', pausedAtMs: 0, deliberate: false },
    ]);
    (loadHarnessRegistry as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: [{ slug: 'live-pot', harness_kind: 'hive' }],
    });

    const res = await pausedPotRecoverySweep({ now: 2 * HOUR });

    expect(res).toHaveLength(1);
    expect(res[0].outcome).toBe('skipped');
    expect(res[0].reason).toBe('pot is no longer registered');
    expect(setPotStarted).not.toHaveBeenCalled();
  });
});

describe('paused-recovery tunables', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('defaults to a 24h stale threshold', () => {
    delete process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC;
    expect(pausedRecoveryStaleSec()).toBe(86_400);
  });
  it('honors PAPERCUSP_POT_PAUSED_RECOVERY_SEC (and <=0 = kill switch)', () => {
    process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC = '3600';
    expect(pausedRecoveryStaleSec()).toBe(3600);
    process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC = '0';
    expect(pausedRecoveryStaleSec()).toBe(0);
  });
  it('auto-resumes by default; off/0/false disable it', () => {
    delete process.env.PAPERCUSP_POT_PAUSED_AUTO_RESUME;
    expect(pausedRecoveryAutoResume()).toBe(true);
    for (const v of ['off', '0', 'false']) {
      process.env.PAPERCUSP_POT_PAUSED_AUTO_RESUME = v;
      expect(pausedRecoveryAutoResume()).toBe(false);
    }
  });
});
