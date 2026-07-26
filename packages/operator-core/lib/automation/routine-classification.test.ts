/**
 * routine-classification — the four derivation axes behind the Agents/System
 * split (agents-system-pane-split-2026-07-26 P-001).
 *
 * These are pure functions over one row's fields, so they are tested directly
 * rather than through the catalog. The cases that matter are the ones the OLD
 * name-regex got wrong, and the `stalled` state it could not express at all.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_FAMILY_ORDER,
  isClockDriven,
  SENTINEL_TARGET_ROLES,
  STALLED_OVERDUE_MS,
  SYSTEM_FAMILY_ORDER,
  TARGET_ROLE_SPEND,
  isLoopRoutine,
  routineFamily,
  routineKind,
  routineLiveness,
  routineNeedsAttention,
  spendForTargetRole,
  spendReasonForTargetRole,
} from './routine-classification';

describe('spendForTargetRole', () => {
  it('classifies the agent-spawning roles as llm', () => {
    for (const role of [
      'system:blueprint-run',
      'system:plan-run',
      'system:overwatch-launch',
      'system:gym-cycle',
      'system:improvement-implement',
      'system:loop-wake',
    ]) {
      expect(spendForTargetRole(role), role).toBe('llm');
    }
  });

  // These two are live target_roles with NO registered handler — the tick logs
  // "no handler registered … skipping" and the routine silently does nothing while
  // presenting as running (EI-18741229858124453 / EI-18741240128927188). Leaving
  // them unclassified routes them to Needs-you instead of laundering the bug into
  // an ordinary row; classifying them would hide it.
  it('leaves the two unregistered-but-live roles unclassified on purpose', () => {
    expect(spendForTargetRole('system:template-gym')).toBe('unknown');
    expect(spendForTargetRole('system:scout-cycle')).toBe('unknown');
  });

  it('classifies the deterministic sweeps as none', () => {
    for (const role of [
      'system:git-sync',
      'system:green-checkpoint',
      'system:hive-git-gc',
      'system:telemetry-retention',
      'system:cross-hive-outbox-drain',
      'system:precompute-derived-reads',
    ]) {
      expect(spendForTargetRole(role), role).toBe('none');
    }
  });

  // The two demonstrated failures of the retired AGENT_SPAWNING_PATTERNS regex.
  // Both were flagged as token spenders and neither can spend anything.
  it('does not flag wake-brain — its handler is a retired no-op tombstone', () => {
    expect(spendForTargetRole('system:wake-brain')).toBe('none');
    expect(spendReasonForTargetRole('system:wake-brain')).toMatch(/tombstone|no-op/i);
  });

  it('flags only improvement-implement of the improvement family', () => {
    expect(spendForTargetRole('system:improvement-implement')).toBe('llm');
    for (const role of [
      'system:improvement-triage',
      'system:improvement-watchdog',
      'system:improvement-human-digest',
      'system:improvement-invalid-args-miner',
    ]) {
      expect(spendForTargetRole(role), role).toBe('none');
    }
  });

  it('returns unknown for an unclassified or missing role, never a default of none', () => {
    expect(spendForTargetRole('system:brand-new-thing')).toBe('unknown');
    expect(spendForTargetRole(null)).toBe('unknown');
    expect(spendForTargetRole(undefined)).toBe('unknown');
    expect(spendForTargetRole('')).toBe('unknown');
  });

  it('gives every entry a non-empty reason — it is the row tooltip', () => {
    for (const [role, entry] of Object.entries(TARGET_ROLE_SPEND)) {
      expect(entry.why.trim().length, role).toBeGreaterThan(0);
    }
  });

  it('carries the loop-wake sentinel, which is a target_role with no handler', () => {
    for (const role of SENTINEL_TARGET_ROLES) {
      expect(TARGET_ROLE_SPEND[role], role).toBeDefined();
    }
  });
});

describe('routineKind', () => {
  it('reads loop-<ownerId> rows as loops', () => {
    expect(routineKind({ name: 'loop-su-d93ac1bf-d48f-420d-8136-dea6de467e7f' })).toBe('loop');
    expect(isLoopRoutine('loop-su-29fe479d')).toBe(true);
    expect(isLoopRoutine('looping-sweep')).toBe(false);
  });

  it('reads sync-triggered sweeps as triggered, not scheduled', () => {
    expect(routineKind({ name: 'doc-freshness-sweep', syncTriggered: true })).toBe('triggered');
    expect(routineKind({ name: 'doc-steward-dispatch', syncTriggered: true })).toBe('triggered');
  });

  it('reads everything else as scheduled', () => {
    expect(routineKind({ name: 'git-sync' })).toBe('scheduled');
    expect(routineKind({ name: 'hive-wake' })).toBe('scheduled');
  });
});

describe('routineLiveness', () => {
  const now = Date.parse('2026-07-26T18:00:00.000Z');
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  it('reads an inactive row as dormant regardless of its fire times', () => {
    expect(routineLiveness({ active: false, nextFireAt: iso(60_000), clockDriven: true, now })).toBe('dormant');
    expect(routineLiveness({ active: false, nextFireAt: null, clockDriven: true, now })).toBe('dormant');
  });

  it('reads an active row with a future fire as running', () => {
    expect(routineLiveness({ active: true, nextFireAt: iso(5 * 60_000), clockDriven: true, now })).toBe('running');
  });

  // The defect this state exists for: `next_fire_at = 'infinity'` arrives as null,
  // and `active` alone reported these 15 rows as healthy.
  it('reads an active clock-driven row with NO next fire as stalled', () => {
    expect(routineLiveness({ active: true, nextFireAt: null, clockDriven: true, now })).toBe('stalled');
  });

  it('reads an active row overdue past the grace window as stalled', () => {
    expect(
      routineLiveness({ active: true, nextFireAt: iso(-STALLED_OVERDUE_MS - 60_000), clockDriven: true, now }),
    ).toBe('stalled');
  });

  it('tolerates a slightly-late fire inside the grace window', () => {
    expect(
      routineLiveness({ active: true, nextFireAt: iso(-STALLED_OVERDUE_MS + 60_000), clockDriven: true, now }),
    ).toBe('running');
  });

  // A triggered row has no clock BY DESIGN, so absence of a next fire is normal.
  it('never reads a non-clock-driven row as stalled', () => {
    expect(routineLiveness({ active: true, nextFireAt: null, clockDriven: false, now })).toBe('running');
  });

  /**
   * REGRESSION (caught in the live shell, agents-system-pane-split P-008): the
   * System pane opened claiming 17 healthy sweeps needed the owner's attention.
   *
   * A DBOS workflow / managed timer / in-process sweep reports a human CADENCE
   * ("every 30s") but usually cannot report a NEXT FIRE — there is no scheduler row
   * to read one from. catalog.ts had derived `clockDriven` from `nextFire || cadence`,
   * so every one of those rows arrived here as clock-driven-with-no-next-fire and
   * came back `stalled`. The caller now keys on nextFire alone for non-routines rows;
   * this pins the behaviour that makes that correct.
   *
   * Every unit test passed while this was broken, because the bug was in what the
   * CALLER passed, not in this function. The live render is what found it.
   */
  it('is only ever stalled for a row that can actually report a next fire', () => {
    // The shape a managed timer arrives in: no next fire, and no way to produce one.
    expect(routineLiveness({ active: true, nextFireAt: null, clockDriven: false, now })).toBe('running');
    // Whereas a routines row with a real cron genuinely has one, and its absence is a fault.
    expect(routineLiveness({ active: true, nextFireAt: null, clockDriven: true, now })).toBe('stalled');
  });

  it('treats an unparseable next fire as stalled', () => {
    expect(routineLiveness({ active: true, nextFireAt: 'infinity', clockDriven: true, now })).toBe('stalled');
  });
});

/**
 * REGRESSION SUITE (agents-system-pane-split P-008). Every unit test in this file
 * passed while the System pane was, in the real shell, announcing that 17 healthy
 * sweeps needed the owner's attention — because the defect was in what the CALLER
 * computed, not in `routineLiveness`. Extracting that computation is what makes it
 * testable; these are the cases that were wrong.
 */
describe('isClockDriven — who can be judged late', () => {
  it('judges a routines row by its cron or reschedule interval', () => {
    expect(isClockDriven({ source: 'routines', kind: 'scheduled', cron: '0 */5 * * * *' })).toBe(true);
    expect(isClockDriven({ source: 'routines', kind: 'loop', rescheduleIntervalSec: 300 })).toBe(true);
    expect(isClockDriven({ source: 'routines', kind: 'scheduled', cron: null })).toBe(false);
  });

  // The shipped bug: these report a human cadence and no next fire, and were being
  // judged by the cadence — so every one of them read as stalled.
  it('judges a NON-routines row by its next fire alone, never its cadence', () => {
    expect(isClockDriven({ source: 'other', kind: 'scheduled', nextFireAt: null })).toBe(false);
    expect(
      isClockDriven({ source: 'other', kind: 'scheduled', nextFireAt: '2026-07-26T18:00:00.000Z' }),
    ).toBe(true);
  });

  it('never judges a triggered row, whatever its source', () => {
    expect(isClockDriven({ source: 'routines', kind: 'triggered', cron: '0 * * * * *' })).toBe(false);
    expect(
      isClockDriven({ source: 'other', kind: 'triggered', nextFireAt: '2026-07-26T18:00:00.000Z' }),
    ).toBe(false);
  });

  // End-to-end shape of the regression: a managed timer must come out RUNNING.
  it('leaves a managed timer with a cadence and no next fire reading as running', () => {
    const clockDriven = isClockDriven({ source: 'other', kind: 'scheduled', nextFireAt: null });
    expect(routineLiveness({ active: true, nextFireAt: null, clockDriven })).toBe('running');
  });
});

describe('routineNeedsAttention', () => {
  const base = { liveness: 'running', control: 'routine', active: true, spend: 'none' } as const;

  it('flags a stalled row', () => {
    expect(routineNeedsAttention({ ...base, liveness: 'stalled' })).toBe(true);
  });

  it('flags a flag-gated row that is off — the switch is the owner’s', () => {
    expect(routineNeedsAttention({ ...base, control: 'flag', active: false })).toBe(true);
  });

  // An ACTIVE row dispatching to an unregistered action is a silent no-op that
  // presents as healthy — the exact shape of EI-18741229858124453 (template-gym).
  it('flags an ACTIVE row whose role is unclassified, so a new action cannot pass as free', () => {
    expect(routineNeedsAttention({ ...base, spend: 'unknown', active: true })).toBe(true);
  });

  it('does not flag an INACTIVE unclassified row — it cannot fire, so it is just dormant', () => {
    expect(
      routineNeedsAttention({ ...base, spend: 'unknown', active: false, liveness: 'dormant' }),
    ).toBe(false);
  });

  // Narrow on purpose: 750 dormant loop rows must not flood the bucket.
  it('does not flag a merely dormant row', () => {
    expect(routineNeedsAttention({ ...base, liveness: 'dormant', active: false })).toBe(false);
  });

  it('does not flag a healthy running row', () => {
    expect(routineNeedsAttention(base)).toBe(false);
  });
});

describe('routineFamily', () => {
  it('routes loops by kind, before any name match', () => {
    expect(routineFamily('loop-su-abc', 'loop')).toBe('loops');
  });

  it('routes the wake family by name, ahead of its group', () => {
    for (const n of ['hive-wake', 'pot-wake', 'overwatch-wake', 'wake-brain']) {
      expect(routineFamily(n, 'scheduled'), n).toBe('wake');
    }
  });

  it('routes docs ahead of learning so doc-steward lands where the owner looks', () => {
    expect(routineFamily('doc-steward-dispatch', 'triggered')).toBe('docs');
    expect(routineFamily('doc-freshness-sweep', 'triggered')).toBe('docs');
  });

  it('routes the learning pipeline as one family across its differing group slugs', () => {
    for (const n of ['bp-singleton-scout-0', 'improvement-triage', 'gym-cycle', 'pot-eval-battery']) {
      expect(routineFamily(n, 'scheduled'), n).toBe('learning');
    }
  });

  it('routes system work into its four families', () => {
    expect(routineFamily('git-sync', 'scheduled')).toBe('git-release');
    expect(routineFamily('green-checkpoint', 'scheduled')).toBe('git-release');
    expect(routineFamily('session-dir-gc', 'scheduled')).toBe('cleanup');
    expect(routineFamily('telemetry-retention', 'scheduled')).toBe('cleanup');
    expect(routineFamily('cross-hive-outbox-drain', 'scheduled')).toBe('federation');
    expect(routineFamily('p2p-perf-tier1', 'scheduled')).toBe('federation');
    expect(routineFamily('coord-probe-canary', 'scheduled')).toBe('health');
  });

  it('falls back to health rather than dropping an unrecognised name', () => {
    expect(routineFamily('something-brand-new', 'scheduled')).toBe('health');
  });

  // The owner mandate "no routines that don't get surfaced" applied to families:
  // every family must be claimed by exactly one pane.
  it('partitions every family across exactly one of the two panes', () => {
    const all = [...AGENT_FAMILY_ORDER, ...SYSTEM_FAMILY_ORDER];
    expect(new Set(all).size).toBe(all.length);
    const names = ['loop-x', 'hive-wake', 'gym-cycle', 'doc-steward', 'git-sync', 'session-dir-gc', 'p2p-perf-tier1', 'whatever'];
    for (const n of names) {
      const fam = routineFamily(n, n.startsWith('loop-') ? 'loop' : 'scheduled');
      expect(all, `${n} → ${fam}`).toContain(fam);
    }
  });
});
