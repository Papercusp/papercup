/**
 * routine-classification — the four derivation axes behind the Agents/System
 * split (agents-system-pane-split-2026-07-26 P-001).
 *
 * These are pure functions over one row's fields, so they are tested directly
 * rather than through the catalog. The cases that matter are the ones the OLD
 * name-regex got wrong, and the `stalled` state it could not express at all.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_FAMILY_ORDER,
  isClockDriven,
  SENTINEL_TARGET_ROLES,
  STALLED_OVERDUE_MS,
  SYSTEM_FAMILY_ORDER,
  TARGET_ROLE_SPEND,
  isLoopRoutine,
  armedStateLabel,
  routineArmedState,
  routineControl,
  routineFamily,
  routineKind,
  routineLiveness,
  routineNeedsAttention,
  spendForTargetRole,
  spendReasonForTargetRole,
} from './routine-classification';

const FLEET_HEADCOUNT_ACTION_SOURCE = readFileSync(
  new URL('../harness/routines/fleet-headcount-action.ts', import.meta.url),
  'utf8',
);

describe('spendForTargetRole', () => {
  it('classifies the agent-spawning roles as llm', () => {
    for (const role of [
      'system:blueprint-run',
      'system:plan-run',
      'system:blueprint-operation',
      'system:overwatch-launch',
      'system:gym-cycle',
      'system:improvement-implement',
      'system:loop-wake',
    ]) {
      expect(spendForTargetRole(role), role).toBe('llm');
    }
  });

  it.each([
    'calibration',
    'change-ledger',
    'deferral-interest',
    'fleet-ekg',
    'graduation',
    'memory-live-recall-canary',
    'memory-precision',
    'negative-space',
    'neologism',
    'red-queen',
  ])('uses the declared deterministic spend metadata for blueprint %s', (blueprintId) => {
    expect(spendForTargetRole('system:blueprint-run', { blueprintId })).toBe('none');
    expect(spendReasonForTargetRole('system:blueprint-run', { blueprintId })).toMatch(/no agent or LLM turn/i);
  });

  it('keeps unknown and LLM-backed blueprint payloads conservative', () => {
    expect(spendForTargetRole('system:blueprint-run', { blueprintId: 'scout' })).toBe('llm');
    expect(spendForTargetRole('system:blueprint-run', { blueprintId: 'not-installed' })).toBe('llm');
    expect(spendForTargetRole('system:blueprint-run', null)).toBe('llm');
  });

  it('classifies knowledge-pack hygiene from its transferability-judge writer', () => {
    expect(spendForTargetRole('system:knowledge-pack-hygiene')).toBe('llm');
    expect(spendReasonForTargetRole('system:knowledge-pack-hygiene')).toMatch(/judge LLM/i);
  });

  it('classifies the fleet headcount writer from its replacement-member spawn seam', () => {
    expect(FLEET_HEADCOUNT_ACTION_SOURCE).toMatch(/registerSystemAction\('fleet-headcount-governor'/);
    expect(FLEET_HEADCOUNT_ACTION_SOURCE).toMatch(/spawnHeadless/);
    expect(FLEET_HEADCOUNT_ACTION_SOURCE).toMatch(/spawnConsole/);
    expect(spendForTargetRole('system:fleet-headcount-governor')).toBe('llm');
    expect(spendReasonForTargetRole('system:fleet-headcount-governor')).toMatch(/spawn/i);
  });

  it('classifies system:template-gym now that its live row has a registered handler', () => {
    expect(spendForTargetRole('system:template-gym')).toBe('none');
  });

  it('classifies system:scout-cycle now that it is registered (EI-18741240128927188)', () => {
    expect(spendForTargetRole('system:scout-cycle')).toBe('llm');
  });

  it('classifies the deterministic sweeps as none', () => {
    for (const role of [
      'system:git-sync',
      'system:green-checkpoint',
      // Renamed hive-git-gc -> pot-git-gc. The classification map moved with the
      // rename; this expectation did not, so it asserted a role that no longer exists
      // and silently got the 'unknown' fallback (EI-20060640525290316).
      'system:pot-git-gc',
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
      'system:improvement-tool-rejection-scorecard',
      'system:improvement-correction-decay',
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
    expect(isClockDriven({ source: 'other', kind: 'scheduled', nextFireAt: '2026-07-26T18:00:00.000Z' })).toBe(true);
  });

  it('never judges a triggered row, whatever its source', () => {
    expect(isClockDriven({ source: 'routines', kind: 'triggered', cron: '0 * * * * *' })).toBe(false);
    expect(isClockDriven({ source: 'other', kind: 'triggered', nextFireAt: '2026-07-26T18:00:00.000Z' })).toBe(false);
  });

  /*
   * EI-19294826146331487 — an ARM-STATE row (`tier='in-process'`) carries the SWEEP's cadence in
   * `reschedule_interval_sec` purely so the pane can render "every 30s". No executor reads the
   * row, so it has no `next_fire_at` and never will. Judging it by the clock reported all 17
   * sweeps as stalled and needing attention — the same false alarm P-008 was fixed to stop.
   */
  it('never judges an arm-state row by the clock, cadence or not', () => {
    expect(
      isClockDriven({ source: 'routines', kind: 'scheduled', rescheduleIntervalSec: 30, tier: 'in-process' }),
    ).toBe(false);
    expect(
      routineLiveness({
        active: true,
        nextFireAt: null,
        clockDriven: isClockDriven({
          source: 'routines',
          kind: 'scheduled',
          rescheduleIntervalSec: 30,
          tier: 'in-process',
        }),
      }),
    ).toBe('running');
  });

  it('CALIBRATION: the SAME input on any other tier still is clock-driven', () => {
    // Without this, the exemption above would also pass if `rescheduleIntervalSec` had simply
    // stopped counting for every row — a much larger and silent behaviour change.
    for (const tier of ['durable', 'ephemeral', null, undefined]) {
      expect(
        isClockDriven({ source: 'routines', kind: 'scheduled', rescheduleIntervalSec: 30, tier }),
      ).toBe(true);
    }
  });

  // End-to-end shape of the regression: a managed timer must come out RUNNING.
  it('leaves a managed timer with a cadence and no next fire reading as running', () => {
    const clockDriven = isClockDriven({ source: 'other', kind: 'scheduled', nextFireAt: null });
    expect(routineLiveness({ active: true, nextFireAt: null, clockDriven })).toBe('running');
  });
});

describe('routineNeedsAttention', () => {
  const base = {
    liveness: 'running',
    armedState: 'armed',
    control: 'routine',
    active: true,
    spend: 'none',
  } as const;

  it('flags a stalled row', () => {
    expect(routineNeedsAttention({ ...base, liveness: 'stalled' })).toBe(true);
  });

  it('flags a row whose armed state is unknown', () => {
    expect(routineNeedsAttention({ ...base, armedState: 'unknown' })).toBe(true);
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
    expect(routineNeedsAttention({ ...base, spend: 'unknown', active: false, liveness: 'dormant' })).toBe(false);
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
    const names = [
      'loop-x',
      'hive-wake',
      'gym-cycle',
      'doc-steward',
      'git-sync',
      'session-dir-gc',
      'p2p-perf-tier1',
      'whatever',
    ];
    for (const n of names) {
      const fam = routineFamily(n, n.startsWith('loop-') ? 'loop' : 'scheduled');
      expect(all, `${n} → ${fam}`).toContain(fam);
    }
  });
});

/**
 * The owner asked, looking at the shipped System pane: "why are there some things
 * that say 'Runs as a managed schedule, not a routine — paused from its own
 * subsystem'. should we not have all runs as routines?" (2026-07-26, WI-6313).
 *
 * These tests pin the ANSWER to that question, per category, so the pane keeps
 * giving it. The reasons are genuinely different, and one of them — watchdog — is
 * an invariant rather than a gap, so a future "let's just make everything a
 * routine" change has to delete an explicit assertion saying why it must not.
 */
describe('routineControl — why a row has (or has not) a switch', () => {
  it('gives a routines row its own switch', () => {
    const c = routineControl({ source: 'routines' });
    expect(c.control).toBe('routine');
    expect(c.reason).toBeNull();
  });

  it('prefers the feature flag when one IS the armed state', () => {
    const c = routineControl({ source: 'in-process', flagKey: 'papercusp-doc-steward' });
    expect(c.control).toBe('flag');
    expect(c.reason).toBeNull();
    expect(c.why).toContain('papercusp-doc-steward');
  });

  it('a flag switch wins over the category, since it is a REAL control', () => {
    // A flagged row must never fall through to a no-control reason just because
    // its category also matches one — that regression would re-hide the one
    // non-routine row that genuinely has a switch.
    expect(routineControl({ source: 'in-process', category: 'watchdog', flagKey: 'f' }).control).toBe('flag');
  });

  it('classifies a watchdog as deliberately outside the control plane', () => {
    const c = routineControl({ source: 'managed', category: 'watchdog' });
    expect(c.control).toBe('none');
    expect(c.reason).toBe('watchdog');
    // The load-bearing claim: it is not an oversight, it is the point.
    expect(c.why).toMatch(/scheduler/i);
  });

  it('classifies a per-process cache refresh as having no singleton to pause', () => {
    expect(routineControl({ source: 'managed', category: 'cache' }).reason).toBe('per-process');
  });

  it('classifies a per-connection timer as not a schedule at all', () => {
    expect(routineControl({ source: 'managed', category: 'lifecycle' }).reason).toBe('per-connection');
  });

  it('classifies a separate OS process as out of reach, not as a principle', () => {
    // external-process wins over any category it may also carry: the process
    // boundary is the binding constraint.
    expect(routineControl({ source: 'external-process', category: 'external-process' }).reason).toBe('other-process');
    expect(routineControl({ source: 'external-process', category: 'watchdog' }).reason).toBe('other-process');
  });

  it('classifies central in-process sweeps as the ephemeral tier', () => {
    expect(routineControl({ source: 'managed', category: 'global-sweep' }).reason).toBe('ephemeral-tier');
    expect(routineControl({ source: 'in-process', category: 'ephemeral-harness' }).reason).toBe('ephemeral-tier');
  });

  it('degrades an unknown category to a vague reason rather than throwing', () => {
    // A new timer category must show a vague tooltip, never break the pane.
    const c = routineControl({ source: 'managed', category: 'something-invented-later' });
    expect(c.control).toBe('none');
    expect(c.reason).toBe('unknown');
    expect(c.why.length).toBeGreaterThan(0);
  });

  it('never returns empty copy for any outcome', () => {
    const cases = [
      { source: 'routines' },
      { source: 'in-process', flagKey: 'x' },
      { source: 'managed', category: 'watchdog' },
      { source: 'managed', category: 'cache' },
      { source: 'managed', category: 'lifecycle' },
      { source: 'external-process' },
      { source: 'managed', category: 'global-sweep' },
      { source: 'dbos', category: 'dbos-scheduled' },
    ];
    for (const input of cases) {
      const { why } = routineControl(input);
      expect(why.trim(), JSON.stringify(input)).not.toBe('');
    }
  });

  it('classifies a DBOS scheduled workflow as declared-in-code', () => {
    expect(routineControl({ source: 'dbos', category: 'dbos-scheduled' }).reason).toBe('durable-workflow');
  });

  it('classifies a sync-triggered sweep as event-driven, not a schedule', () => {
    expect(routineControl({ source: 'in-process', category: 'sync-triggered' }).reason).toBe('event-triggered');
  });

  /**
   * Pinned to the REAL inventory, not to what the mapping happens to handle: this
   * is the full set of (source, category) pairs observed live in
   * `schedule:inventory` on 2026-07-26 (421 rows). Writing the test from the
   * mapping instead of from the data is what let `dbos` and `sync-triggered` fall
   * through to vague copy in the first pass — an assertion over five categories
   * passed while the live system had eight pairs.
   */
  it('gives a specific reason for EVERY source/category pair live in the inventory', () => {
    const livePairs: Array<[string, string]> = [
      ['in-process', 'global-sweep'], // 15 rows
      ['managed', 'watchdog'], // 9
      ['managed', 'cache'], // 7
      ['external-process', 'external-process'], // 7
      ['managed', 'lifecycle'], // 5
      ['managed', 'global-sweep'], // 5
      ['in-process', 'sync-triggered'], // 2
      ['dbos', 'dbos-scheduled'], // 1
    ];
    for (const [source, category] of livePairs) {
      const { reason, why } = routineControl({ source, category });
      expect(reason, `${source}/${category}`).not.toBe('unknown');
      expect(why.trim(), `${source}/${category}`).not.toBe('');
    }
  });
});

/**
 * routineArmedState — WI-6447, the tri-state the pane used to destroy.
 *
 * The bug these assertions pin: `catalog.ts` collapsed the field with
 * `const active = row.armed !== false`, which maps the UNKNOWN case (`null` — the
 * 7 external-process rows whose live fire-state needs P-014 federation) onto
 * `true`. The pane then ASSERTED those were running when nothing had checked.
 * Written so a future "simplify this back to a boolean" has to delete an explicit
 * statement that unknown must not read as on.
 */
describe('routineArmedState — unknown is a state, not a default', () => {
  it('maps the two VERIFIED booleans to their own states', () => {
    expect(routineArmedState(true)).toBe('armed');
    expect(routineArmedState(false)).toBe('disarmed');
  });

  it('maps null to unknown rather than to armed', () => {
    // The load-bearing case: `armed !== false` returned true here.
    expect(routineArmedState(null)).toBe('unknown');
  });

  it('degrades an absent field to unknown, not to the flattering state', () => {
    // Total over the input type: a future inventory source that stops emitting
    // `armed` lands on the honest state without anyone remembering to look.
    expect(routineArmedState(undefined)).toBe('unknown');
  });

  it('labels every state with copy that reads as an answer, not a field name', () => {
    expect(armedStateLabel('armed')).toBe('armed');
    // "not armed" is the distinction the owner asked to SEE (2026-07-27): a row
    // showing only "every 1m" reads as a schedule that IS running every minute.
    expect(armedStateLabel('disarmed')).toBe('not armed');
    expect(armedStateLabel('unknown')).toBe('arm state unknown');
  });
});
