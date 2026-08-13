/**
 * EI-19385475092979200 — teeth tests for the dev:restart gate-collision guard.
 *
 * These are structured so the guard is proven to FIRE on the real shape and to stay SILENT
 * for each single condition removed. A test that only asserted "clear tree ⇒ no collision"
 * would pass identically with the condition INVERTED, which is the false-green class that
 * already bit two guards in this repo (the plugin-spawn-impl ambient-environment assertion,
 * and the typeless-reexport live-leg). Every block below therefore pairs a POSITIVE with the
 * minimal negative that distinguishes it.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  judgeGateCollision,
  probeGateCollision,
  checkGateCollision,
  isGateSensitiveTarget,
  GATE_SENSITIVE_RESTART_TARGETS,
  IMMINENT_FIRE_LOOKAHEAD_SEC,
  IMMINENT_FIRE_LOOKBEHIND_SEC,
  gateRunCgroupRelation,
  type GateCollisionProbe,
  type GateCollisionProbeDeps,
} from './gate-collision-guard';
import type { StoredInFlightRetriage } from './in-flight-retriage';

const CLEAR: GateCollisionProbe = {
  probeFailed: false,
  runLockHeld: false,
  runElapsedSec: null,
  nextFireInSec: null,
  refire: null,
};

const judge = (probe: Partial<GateCollisionProbe>, target = 'embed-sidecar', override = false) =>
  judgeGateCollision({ target, probe: { ...CLEAR, ...probe }, override });

describe('gate-sensitive target set', () => {
  it('covers exactly the three shared hosts a gate run depends on', () => {
    expect([...GATE_SENSITIVE_RESTART_TARGETS]).toEqual(['embed-sidecar', 'gateway', 'bg-host']);
  });

  it('does NOT guard the operator web hosts — they are not gate dependencies', () => {
    expect(isGateSensitiveTarget('dev')).toBe(false);
    expect(isGateSensitiveTarget('staging')).toBe(false);
  });
});

describe('run-in-flight (the primary condition)', () => {
  it('BLOCKS a gate-sensitive restart while the run-lock is held', () => {
    const v = judge({ runLockHeld: true, runElapsedSec: 1980 });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('run-in-flight');
    expect(v.note).toContain('IN FLIGHT');
    // The run's AGE must reach the caller — it is what decides "wait it out" vs "override".
    expect(v.note).toContain('33min');
    expect(v.detail.runElapsedSec).toBe(1980);
  });

  it('single condition removed — lock NOT held, nothing else true ⇒ CLEAR', () => {
    expect(judge({ runLockHeld: false }).blocked).toBe(false);
    expect(judge({ runLockHeld: false }).kind).toBe('clear');
  });

  it('single condition removed — same held lock on a NON-gate-sensitive target ⇒ CLEAR', () => {
    for (const t of ['dev', 'staging']) {
      const v = judge({ runLockHeld: true, runElapsedSec: 1980 }, t);
      expect(v.blocked).toBe(false);
      expect(v.kind).toBe('not-gate-sensitive');
    }
  });

  it('enriches the note from the refire marker when one is in flight', () => {
    const refire: StoredInFlightRetriage = {
      fromCandidate: '1ee32228',
      refiringCandidate: '4a9b218b',
      refireAttempt: 1,
      maxRefires: 2,
      failingFiles: ['lib/x.test.ts'],
      observedAtMs: Date.now(),
    };
    const v = judge({ runLockHeld: true, runElapsedSec: 60, refire });
    expect(v.note).toContain('MID AUTO-REFIRE');
    expect(v.note).toContain('4a9b218b');
    expect(v.detail.refiringCandidate).toBe('4a9b218b');
  });
});

describe('mechanism-aware run-in-flight guard', () => {
  const userSlice = '/user.slice/user-1000.slice/user@1000.service/app.slice';
  const targetCgroup = `${userSlice}/papercup-bg-host.service`;

  it('treats a target cgroup and its child cgroup as shared', () => {
    expect(gateRunCgroupRelation(`${targetCgroup}/checkpoint.scope`, targetCgroup)).toBe('same');
    const v = judge({
      runLockHeld: true,
      runElapsedSec: 60,
      runLockCgroupPath: `${targetCgroup}/checkpoint.scope`,
      targetCgroupPath: targetCgroup,
    });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('run-in-flight');
    expect(v.detail.cgroupRelation).toBe('same');
    expect(v.note).not.toContain('EI-18793581783459047');
  });

  it('proceeds when a detached checkpoint unit is a known sibling cgroup', () => {
    const v = judge({
      runLockHeld: true,
      runElapsedSec: 60,
      runLockCgroupPath: `${userSlice}/papercup-green-checkpoint-manual.scope`,
      targetCgroupPath: targetCgroup,
    });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('run-in-flight-isolated');
    expect(v.detail.cgroupRelation).toBe('different');
    expect(v.note).toContain('residual risk');
  });

  it('fails open, explicitly, when either cgroup path is unknown', () => {
    const v = judge({
      runLockHeld: true,
      runElapsedSec: 60,
      runLockCgroupPath: null,
      targetCgroupPath: null,
    });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('run-in-flight-unknown');
    expect(v.detail.cgroupRelation).toBe('unknown');
    expect(v.note).toContain('could not be determined');
  });

  it('passes the actual restart target to the cgroup reader', async () => {
    const readTargetCgroup = vi.fn(async (target: (typeof GATE_SENSITIVE_RESTART_TARGETS)[number]) => {
      expect(target).toBe('gateway');
      return '/user.slice/user-1000.slice/user@1000.service/app.slice/papercup-gateway.service';
    });
    const probe = await probeGateCollision(
      {
        readRunLock: () => ({ held: true, elapsedSec: 10, pid: 42 }),
        readRunLockCgroup: () => '/user.slice/user-1000.slice/user@1000.service/app.slice/papercup-gateway.service',
        readTargetCgroup,
        readNextFireInSec: async () => 3_000,
        readRefire: async () => null,
      },
      'gateway',
    );
    expect(readTargetCgroup).toHaveBeenCalledWith('gateway');
    expect(judgeGateCollision({ target: 'gateway', probe, override: false }).blocked).toBe(true);
  });
});

describe('imminent fire — the two-sided window', () => {
  it('BLOCKS just AHEAD of a scheduled fire', () => {
    const v = judge({ nextFireInSec: 40 });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('imminent-fire');
    expect(v.note).toContain('fires in 40s');
  });

  /**
   * THE REGRESSION GUARD. The reported near-miss happened at :15:36 — 36 seconds AFTER the
   * scheduled :15:00 fire, with the run process alive but the lock not yet observed. A
   * forward-only window would sail straight past the very incident this guard exists for.
   */
  it('BLOCKS just BEHIND a scheduled fire (the 2026-08-02 near-miss at :15:36)', () => {
    const v = judge({ nextFireInSec: -36, runLockHeld: false });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('imminent-fire');
    expect(v.note).toContain('fired 36s ago');
  });

  it('is CLEAR when the next fire is far ahead (the live steady-state: ~640s)', () => {
    const v = judge({ nextFireInSec: 640 });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('clear');
    expect(v.note).toContain('next scheduled fire');
  });

  it('is CLEAR when next_fire_at is long past — a paused/stale routine must not wedge restarts', () => {
    expect(judge({ nextFireInSec: -3600 }).blocked).toBe(false);
    expect(judge({ nextFireInSec: -3600 }).kind).toBe('clear');
  });

  it('honours both window boundaries exactly', () => {
    expect(judge({ nextFireInSec: IMMINENT_FIRE_LOOKAHEAD_SEC }).blocked).toBe(true);
    expect(judge({ nextFireInSec: IMMINENT_FIRE_LOOKAHEAD_SEC + 1 }).blocked).toBe(false);
    expect(judge({ nextFireInSec: -IMMINENT_FIRE_LOOKBEHIND_SEC }).blocked).toBe(true);
    expect(judge({ nextFireInSec: -IMMINENT_FIRE_LOOKBEHIND_SEC - 1 }).blocked).toBe(false);
  });

  it('a null schedule alone never blocks — absence of data is not evidence of a fire', () => {
    expect(judge({ nextFireInSec: null }).blocked).toBe(false);
  });
});

describe('fail-open contract', () => {
  it('a failed probe PROCEEDS, and says so rather than reporting a verified all-clear', () => {
    const v = judge({ probeFailed: true });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('probe-failed');
    expect(v.note).toContain('Could NOT determine');
  });

  it('a failed probe outranks a would-be block — it never silently blocks on unknown state', () => {
    const v = judge({ probeFailed: true, runLockHeld: true, nextFireInSec: 10 });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('probe-failed');
  });
});

describe('override (soft block, not hard block)', () => {
  it('lets a real collision through, flags it, and preserves the attribution warning', () => {
    const v = judge({ runLockHeld: true, runElapsedSec: 120 }, 'embed-sidecar', true);
    expect(v.blocked).toBe(false);
    expect(v.overridden).toBe(true);
    expect(v.kind).toBe('run-in-flight');
    expect(v.note).toContain('PROCEEDING ANYWAY');
    expect(v.note).toContain('attribute it to THIS restart');
  });

  it('does not invent an override on a clear probe', () => {
    expect(judge({}, 'embed-sidecar', true).overridden).toBe(false);
  });

  it('the block message names the exact override arg, so the caller is never stuck', () => {
    expect(judge({ runLockHeld: true }).note).toContain('override_gate_collision: true');
  });
});

describe('probe shell — one broken reader degrades one field, not the verdict', () => {
  const deps = (over: Partial<GateCollisionProbeDeps>): GateCollisionProbeDeps => ({
    readRunLock: () => ({ held: false, elapsedSec: null }),
    readNextFireInSec: async () => null,
    readRefire: async () => null,
    ...over,
  });

  it('a throwing routines read still BLOCKS on a readable held run-lock', async () => {
    const probe = await probeGateCollision(
      deps({
        readRunLock: () => ({ held: true, elapsedSec: 300 }),
        readNextFireInSec: async () => {
          throw new Error('pg down');
        },
      }),
    );
    expect(probe.runLockHeld).toBe(true);
    expect(probe.probeFailed).toBe(true);
    // probeFailed fails OPEN by contract — the point here is that the lock was still READ.
    expect(judgeGateCollision({ target: 'gateway', probe, override: false }).kind).toBe('probe-failed');
  });

  it('a throwing refire read is NOT a probe failure — the marker only enriches the message', async () => {
    const probe = await probeGateCollision(
      deps({
        readRunLock: () => ({ held: true, elapsedSec: 42 }),
        readRefire: async () => {
          throw new Error('no marker');
        },
      }),
    );
    expect(probe.probeFailed).toBe(false);
    expect(probe.refire).toBeNull();
    expect(judgeGateCollision({ target: 'gateway', probe, override: false }).blocked).toBe(true);
  });

  it('a throwing run-lock read marks the probe failed', async () => {
    const probe = await probeGateCollision(
      deps({
        readRunLock: () => {
          throw new Error('unreadable lock dir');
        },
      }),
    );
    expect(probe.probeFailed).toBe(true);
  });
});

describe('checkGateCollision', () => {
  it('short-circuits a non-gate-sensitive target WITHOUT probing at all', async () => {
    const readRunLock = vi.fn(() => ({ held: true, elapsedSec: 1 }));
    const v = await checkGateCollision('dev', false, {
      readRunLock,
      readNextFireInSec: async () => 0,
      readRefire: async () => null,
    });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('not-gate-sensitive');
    expect(readRunLock).not.toHaveBeenCalled();
  });

  it('probes and blocks for each gate-sensitive target', async () => {
    for (const t of GATE_SENSITIVE_RESTART_TARGETS) {
      const v = await checkGateCollision(t, false, {
        readRunLock: () => ({ held: true, elapsedSec: 10 }),
        readNextFireInSec: async () => 3000,
        readRefire: async () => null,
      });
      expect(v.blocked, `${t} must be guarded`).toBe(true);
    }
  });
});
