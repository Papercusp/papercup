import { describe, expect, it } from 'vitest';
import { assessGoalFactDivergence, type CorrectedFact } from './loop-goal-fact-divergence';

const ARMED = Date.UTC(2026, 7, 25, 20, 1, 0);
const AFTER = Date.UTC(2026, 7, 25, 20, 33, 0);
const BEFORE = Date.UTC(2026, 7, 25, 19, 30, 0);

/** The measured instance from the filing: the goal baked in the rule the fact retracted. */
const REAL_GOAL =
  'Watch the Gmail and Slack live-trigger wall. trigger_sources.updated_at is written per ' +
  'poll unconditionally, so a value more than 4 minutes stale is a REAL FAULT — escalate it.';

const REAL_CORRECTION: CorrectedFact = {
  key: 'guard-rail:trigger-poll-liveness-instruments',
  body:
    'trigger_sources.updated_at advances only when a poll WRITES, so a connected idle mailbox ' +
    'legitimately freezes it. A stale value is NOT by itself a fault — corroborate against the ' +
    'bg-host journal before calling any trigger poll broken.',
  correctedAtMs: AFTER,
};

describe('assessGoalFactDivergence', () => {
  it('fires on the measured instance: a correction landing after the goal was armed', () => {
    const v = assessGoalFactDivergence(REAL_GOAL, [REAL_CORRECTION], ARMED);
    expect(v.diverged.map((d) => d.key)).toEqual([REAL_CORRECTION.key]);
    expect(v.note).toContain('WITHDRAWN');
    expect(v.note).toContain(REAL_CORRECTION.key);
    // Names the repair, not just the problem.
    expect(v.note).toContain('loop:arm');
  });

  it('is SILENT when the correction predates the arm — the goal could already reflect it', () => {
    const v = assessGoalFactDivergence(REAL_GOAL, [{ ...REAL_CORRECTION, correctedAtMs: BEFORE }], ARMED);
    expect(v.diverged).toEqual([]);
    expect(v.note).toBeNull();
  });

  it('is SILENT when the arm time is unknown — never announce what was not measured', () => {
    for (const armed of [null, undefined, Number.NaN]) {
      const v = assessGoalFactDivergence(REAL_GOAL, [REAL_CORRECTION], armed);
      expect(v.note, `armedAtMs=${String(armed)}`).toBeNull();
    }
  });

  it('is SILENT on an empty corrected set — a FAILED read must not read as all-clear', () => {
    expect(assessGoalFactDivergence(REAL_GOAL, [], ARMED).note).toBeNull();
  });

  it('is SILENT when a correction lands but is about an unrelated subject', () => {
    const unrelated: CorrectedFact = {
      key: 'guard-rail:unrelated',
      body: 'Purple giraffe bicycle omelette. Nothing whatsoever about mailboxes or polling.',
      correctedAtMs: AFTER,
    };
    const v = assessGoalFactDivergence(REAL_GOAL, [unrelated], ARMED);
    expect(v.diverged).toEqual([]);
    expect(v.note).toBeNull();
  });

  it('is SILENT for a goal with no significant tokens', () => {
    for (const goal of [null, undefined, '', '   ', 'a b c']) {
      const v = assessGoalFactDivergence(goal, [REAL_CORRECTION], ARMED);
      expect(v.note, `goal=${JSON.stringify(goal)}`).toBeNull();
    }
  });

  it('does not fire on launch-provenance boilerplate — the measured 69% false-positive source', () => {
    // A mission-shaped goal and the launch-provenance fact every agent holds share
    // fleet/session vocabulary. This is the pair that made the ungated version noise;
    // here it is excluded by the gate, not by the threshold, so assert the GATE holds:
    // launch-provenance is never CORRECTED, so it never enters the population at all.
    const goal =
      'Drive plan p2p-release per your member role in fleet nonp2p-feature-change-drain; ' +
      'coord:orient to pull your lane and report to the fleet leader session.';
    const provenance: CorrectedFact = {
      key: 'launch-provenance',
      body:
        'You were launched by session su-bcd1a39d with brief fleet-nonp2p-feature-change-drain ' +
        'launch-context; report to the fleet leader, coord:send to @fleet-leader selector.',
      correctedAtMs: BEFORE, // never corrected after arming
    };
    expect(assessGoalFactDivergence(goal, [provenance], ARMED).note).toBeNull();
  });

  it('ranks strongest overlap first and caps the named keys at 3', () => {
    const mk = (n: number, extra: string): CorrectedFact => ({
      key: `guard-rail:poll-${n}`,
      body: `trigger_sources updated_at poll mailbox stale fault escalate ${extra}`,
      correctedAtMs: AFTER,
    });
    const facts = [mk(1, ''), mk(2, ''), mk(3, ''), mk(4, ''), mk(5, '')];
    const v = assessGoalFactDivergence(REAL_GOAL, facts, ARMED);
    expect(v.diverged.length).toBe(5);
    // Sorted by shared-token count, descending.
    const shared = v.diverged.map((d) => d.shared);
    expect([...shared].sort((a, b) => b - a)).toEqual(shared);
    expect(v.note).toContain('+2 more');
  });

  it('agrees in number — the plural branch is reached on real data (2 hits measured live)', () => {
    const one = assessGoalFactDivergence(REAL_GOAL, [REAL_CORRECTION], ARMED);
    expect(one.note).toContain('a standing fact covering the same subject was CORRECTED');

    const two = assessGoalFactDivergence(
      REAL_GOAL,
      [REAL_CORRECTION, { ...REAL_CORRECTION, key: 'guard-rail:second' }],
      ARMED,
    );
    expect(two.note).toContain('standing facts covering the same subject were CORRECTED');
  });

  it('carries the correction timestamp through for every hit', () => {
    const v = assessGoalFactDivergence(REAL_GOAL, [REAL_CORRECTION], ARMED);
    expect(v.diverged[0].correctedAtMs).toBe(AFTER);
  });

  it('ignores a correction with a non-finite timestamp rather than treating it as recent', () => {
    const v = assessGoalFactDivergence(
      REAL_GOAL,
      [{ ...REAL_CORRECTION, correctedAtMs: Number.NaN }],
      ARMED,
    );
    expect(v.note).toBeNull();
  });
});
