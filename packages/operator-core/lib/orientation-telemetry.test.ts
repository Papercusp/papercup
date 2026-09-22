/**
 * P-020 — orientation reach + action telemetry.
 *
 * WHAT THIS FILE GUARDS, in priority order:
 *
 *  1. The FABRICATED-DISPOSITION trap. Disposition is observed as
 *     DISAPPEARANCE, so a class whose source FAILED (resolved `undefined`)
 *     must never be closed against — otherwise one failed provider read is
 *     indistinguishable from "every obligation of that class was dispositioned
 *     this turn" and writes a fleet-wide burst of fake actions into the ledger.
 *     `undefined` (did not look) vs `[]` (looked, found none) is therefore a
 *     load-bearing distinction, not a nicety.
 *  2. The REGISTRY/SELECTOR covenant — a class added to
 *     ORIENTATION_ACTION_MEASURABLE but not to the selector would be silently
 *     unmeasured forever, which is the failure this instrument exists to end.
 *  3. The NEVER-THROWS posture. Telemetry must never be able to cost an agent
 *     its orientation block.
 *
 * FIXTURE NOTE: `state()` casts ONE quiet base and type-checks every override.
 * OrientationState is actively growing required fields (8 sites stranded on
 * `planDecisions` on 2026-09-22), and this file deliberately has exactly one
 * such site instead of one per test.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ORIENTATION_ACTION_MEASURABLE,
  ORIENTATION_ZERO_ACTION_FLAG_TURNS,
  readOrientationTelemetry,
  recordOrientationTurn,
  resetOrientationTelemetryLatchForTest,
  selectObligationTelemetry,
  type OrientationTurnObservation,
} from './orientation-telemetry';
import type { OrientationState } from './turn-start-orientation';

/** One quiet OrientationState with `overrides` applied. See FIXTURE NOTE. */
function state(overrides: Partial<OrientationState> = {}): OrientationState {
  return {
    held: [],
    unansweredDirected: 0,
    unansweredStale: 0,
    inboxRecent: [],
    openAsks: null,
    announcedGates: [],
    modes: [],
    authorityVerdict: null,
    loopArmed: true,
    loopFireWithheld: false,
    improvementTriage: null,
    executableFrontier: null,
    neverDropFacts: [],
    toolSurface: null,
    carryBlindWindow: null,
    ...overrides,
  } as OrientationState;
}

/** A primary obligation row; the selector reads only `id`. */
const obligation = (id: string) =>
  ({ id, title: id, status: 'open' }) as unknown as NonNullable<
    OrientationState['obligations']
  >['primary'][number];

const brief = (primary: string[], evaluations: string[] = []) =>
  ({
    primary: primary.map(obligation),
    evaluations: evaluations.map(obligation),
  }) as unknown as OrientationState['obligations'];

/** A template-tag stand-in. `handler` sees the assembled SQL text. */
function fakeSql(handler: (text: string) => unknown) {
  const calls: string[] = [];
  const tag = (strings: TemplateStringsArray, ..._v: unknown[]) => {
    const text = strings.join(' ');
    calls.push(text);
    const out = handler(text);
    return out instanceof Promise ? out : Promise.resolve(out);
  };
  return { tag: tag as never, calls };
}

const observation = (
  over: Partial<OrientationTurnObservation> = {},
): OrientationTurnObservation => ({
  workspaceId: 'ws-1',
  ownerId: 'su-1',
  sink: 'turn-start',
  renderedRowsByClass: new Map([['ownerDirectives', 1]]),
  obligationRows: [{ classId: 'ownerDirectives', rowKey: '85' }],
  evaluatedClasses: ['ownerDirectives'],
  ...over,
});

beforeEach(() => {
  // The no-op latch is PROCESS-WIDE; leaving it armed would silently turn every
  // later test in this file into a vacuous pass.
  resetOrientationTelemetryLatchForTest();
});

describe('selectObligationTelemetry — undefined (did not look) vs empty (looked)', () => {
  it('does NOT close against a class whose source failed', () => {
    // No ownerDirectives / openChecks / obligations keys at all: every provider
    // read failed. Closing against them here is the fleet-wide fake-disposition
    // burst this guard exists to prevent.
    const { rows, evaluatedClasses } = selectObligationTelemetry(state());

    expect(evaluatedClasses).not.toContain('ownerDirectives');
    expect(evaluatedClasses).not.toContain('openChecks');
    expect(evaluatedClasses).not.toContain('obligations');
    expect(rows).toEqual([]);
  });

  it('DOES close against a class that resolved empty', () => {
    const { rows, evaluatedClasses } = selectObligationTelemetry(
      state({ ownerDirectives: [], openChecks: [], obligations: brief([]) }),
    );

    // "We looked and there are none" is a real disposition signal.
    expect(evaluatedClasses).toEqual(
      expect.arrayContaining(['ownerDirectives', 'openChecks', 'obligations']),
    );
    expect(rows).toEqual([]);
  });

  it('separates the two cases even when they occur on the same turn', () => {
    const { evaluatedClasses } = selectObligationTelemetry(
      state({ ownerDirectives: [] }), // resolved empty; the other two failed
    );

    expect(evaluatedClasses).toContain('ownerDirectives');
    expect(evaluatedClasses).not.toContain('openChecks');
    expect(evaluatedClasses).not.toContain('obligations');
  });
});

describe('FALSIFIABILITY CONTROL for the fabricated-disposition guard', () => {
  // Tier 1 (the repo's tier for an imported module): a deliberately-wrong
  // implementation kept PERMANENTLY beside the real one, so the guard above is
  // proven to reject the bug it exists to catch rather than merely passing.
  //
  // This is the single most consequential line in the module: `!== undefined`
  // relaxed to a truthiness/`?? []` check closes against a class whose provider
  // FAILED, turning one failed read into a fleet-wide burst of fake dispositions.
  const brokenSelect = (s: OrientationState) => {
    const evaluated: string[] = [];
    // THE BUG: `?? []` erases the did-not-look / looked-and-found-none
    // distinction, so every class is reported as evaluated every turn.
    for (const [key, value] of [
      ['ownerDirectives', s.ownerDirectives ?? []],
      ['openChecks', s.openChecks ?? []],
      ['obligations', s.obligations?.primary ?? []],
    ] as const) {
      void value;
      evaluated.push(key);
    }
    evaluated.push('unansweredDirected');
    return { evaluatedClasses: evaluated };
  };

  const allProvidersFailed = state();

  it('the broken selector FAILS the assertion the real one passes', () => {
    // Calibration: the real selector passes.
    expect(selectObligationTelemetry(allProvidersFailed).evaluatedClasses).not.toContain(
      'ownerDirectives',
    );

    // The control: the same assertion must REJECT the broken implementation.
    // If this ever passes, the guard above has stopped guarding.
    expect(() =>
      expect(brokenSelect(allProvidersFailed).evaluatedClasses).not.toContain(
        'ownerDirectives',
      ),
    ).toThrow();
  });

  it('the control is still detector-shaped (it must differ only in the bug)', () => {
    // Guards against a later "simplification" making the control unmatchable,
    // which would make the falsifiability proof pass vacuously.
    const populated = state({
      ownerDirectives: [{ id: 1, captureStatus: 'pending', verbatimText: 'x' }],
    });
    expect(brokenSelect(populated).evaluatedClasses).toContain('ownerDirectives');
    expect(selectObligationTelemetry(populated).evaluatedClasses).toContain(
      'ownerDirectives',
    );
  });
});

describe('selectObligationTelemetry — row identity', () => {
  it('keys rows by stable identity, never by rendered text', () => {
    const { rows } = selectObligationTelemetry(
      state({
        ownerDirectives: [
          { id: 85, captureStatus: 'pending', verbatimText: 'cut a 0.0.22 release' },
        ],
      }),
    );

    expect(rows).toEqual([{ classId: 'ownerDirectives', rowKey: '85' }]);
    // A re-wording must NOT read as a disposition + a new obligation.
    const reworded = selectObligationTelemetry(
      state({
        ownerDirectives: [
          { id: 85, captureStatus: 'open', verbatimText: 'COMPLETELY different words' },
        ],
      }),
    );
    expect(reworded.rows[0]!.rowKey).toBe('85');
  });

  it('counts obligations.primary and ignores evaluations', () => {
    // `evaluations` holds satisfied / not-applicable controls. Counting them
    // would dilute exactly the number this instrument is for.
    const { rows } = selectObligationTelemetry(
      state({ obligations: brief(['ob-1'], ['ob-satisfied', 'ob-n/a']) }),
    );

    expect(rows).toEqual([{ classId: 'obligations', rowKey: 'ob-1' }]);
  });

  it('skips openChecks rows with no stable id', () => {
    const { rows, evaluatedClasses } = selectObligationTelemetry(
      state({
        openChecks: [
          { id: 'check-1', claim: 'c', pointer: 'p' },
          { id: '', claim: 'no identity', pointer: 'p' },
        ] as OrientationState['openChecks'],
      }),
    );

    expect(evaluatedClasses).toContain('openChecks');
    expect(rows).toEqual([{ classId: 'openChecks', rowKey: 'check-1' }]);
  });
});

describe('selectObligationTelemetry — unansweredDirected is a synthetic grain', () => {
  it('is always evaluated, because the field is required and cannot fail to resolve', () => {
    expect(selectObligationTelemetry(state()).evaluatedClasses).toContain(
      'unansweredDirected',
    );
  });

  it('emits its single synthetic row only while the count is above zero', () => {
    expect(selectObligationTelemetry(state({ unansweredDirected: 0 })).rows).toEqual([]);
    expect(selectObligationTelemetry(state({ unansweredDirected: 3 })).rows).toEqual([
      { classId: 'unansweredDirected', rowKey: 'directed-awaiting-reply' },
    ]);
    // The count is a grain, not a row multiplier: 3 unanswered is ONE clock.
    expect(selectObligationTelemetry(state({ unansweredDirected: 3 })).rows).toHaveLength(
      1,
    );
  });
});

describe('the registry/selector covenant', () => {
  it('every measurable class is actually produced by the selector', () => {
    // A class added to the registry but not to the selector would report reach
    // forever and action never — silently unmeasured.
    const everyClassPopulated = state({
      ownerDirectives: [{ id: 1, captureStatus: 'pending', verbatimText: 'x' }],
      openChecks: [
        { id: 'c1', claim: 'c', pointer: 'p' },
      ] as OrientationState['openChecks'],
      obligations: brief(['ob-1']),
      unansweredDirected: 1,
    });

    const produced = new Set(
      selectObligationTelemetry(everyClassPopulated).rows.map((r) => r.classId),
    );

    expect([...produced].sort()).toEqual(Object.keys(ORIENTATION_ACTION_MEASURABLE).sort());
  });

  it('documents why each class is measurable', () => {
    for (const [classId, why] of Object.entries(ORIENTATION_ACTION_MEASURABLE)) {
      expect(why, `${classId} must say what its row identity is`).toBeTruthy();
    }
  });
});

describe('never-throws posture', () => {
  it('recordOrientationTurn swallows a failing write', async () => {
    const sql = fakeSql(() => {
      throw new Error('connection closed');
    });

    await expect(recordOrientationTurn(sql.tag, observation())).resolves.toBeUndefined();
  });

  it('recordOrientationTurn writes nothing when identity is missing', async () => {
    const sql = fakeSql(() => []);

    await recordOrientationTurn(sql.tag, observation({ workspaceId: '' }));
    await recordOrientationTurn(sql.tag, observation({ ownerId: '' }));

    expect(sql.calls).toEqual([]);
  });

  it('latches to a process-wide no-op once the relation is missing', async () => {
    const missing = fakeSql(() => {
      throw new Error('relation "harness_shared.orientation_class_reach" does not exist');
    });
    await recordOrientationTurn(missing.tag, observation());
    const firstAttempt = missing.calls.length;
    expect(firstAttempt).toBeGreaterThan(0);

    // An un-migrated host degrades to NO telemetry, not to a failed turn — and
    // must stop paying for the attempt on every subsequent turn.
    const after = fakeSql(() => []);
    await recordOrientationTurn(after.tag, observation());
    expect(after.calls).toEqual([]);

    // The latch is a test seam precisely so it cannot leak between suites.
    resetOrientationTelemetryLatchForTest();
    const rearmed = fakeSql(() => []);
    await recordOrientationTurn(rearmed.tag, observation());
    expect(rearmed.calls.length).toBeGreaterThan(0);
  });

  it('readOrientationTelemetry reports unavailable rather than an empty class list', async () => {
    const sql = fakeSql(() => {
      throw new Error('relation "harness_shared.orientation_class_reach" does not exist');
    });

    const read = await readOrientationTelemetry(sql.tag, { workspaceId: 'ws-1' });

    // "No rows" and "could not read" prescribe OPPOSITE actions, and a
    // zero-reach list is exactly the evidence someone would delete a class on.
    expect(read.unavailableReason).toMatch(/could not be read/);
    expect(read.classes).toEqual([]);
    expect(read.flagged).toEqual([]);
  });
});

describe('readOrientationTelemetry — flagging', () => {
  const reachRow = (classId: string, turns: number) => ({
    class_id: classId,
    turns_rendered: turns,
    rows_rendered: turns,
    first_rendered_at: '2026-09-01T00:00:00.000Z',
    last_rendered_at: '2026-09-22T00:00:00.000Z',
  });

  const sqlFor = (reach: unknown[], action: unknown[]) =>
    fakeSql((text) =>
      text.includes('orientation_class_reach') ? reach : action,
    );

  it('flags a measurable class that reached the threshold with zero dispositions', async () => {
    const sql = sqlFor(
      [reachRow('ownerDirectives', ORIENTATION_ZERO_ACTION_FLAG_TURNS)],
      [{ class_id: 'ownerDirectives', dispositions: 0, open_rows: 4, settled: [] }],
    );

    const read = await readOrientationTelemetry(sql.tag, { workspaceId: 'ws-1' });
    const cls = read.classes.find((c) => c.classId === 'ownerDirectives')!;

    expect(cls.actionMeasurable).toBe(true);
    expect(cls.dispositions).toBe(0);
    expect(cls.flagged).toBe(true);
    expect(read.flagged).toContain('ownerDirectives');
  });

  it('does not flag below the threshold', async () => {
    const sql = sqlFor(
      [reachRow('ownerDirectives', ORIENTATION_ZERO_ACTION_FLAG_TURNS - 1)],
      [{ class_id: 'ownerDirectives', dispositions: 0, open_rows: 1, settled: [] }],
    );

    const read = await readOrientationTelemetry(sql.tag, { workspaceId: 'ws-1' });

    expect(read.classes[0]!.flagged).toBe(false);
    expect(read.flagged).toEqual([]);
  });

  it('never flags a class-A (delta) class, and reports its dispositions as null', async () => {
    // A guard that fires on a dozen healthy delta classes forever is a guard
    // everyone learns to ignore.
    const sql = sqlFor([reachRow('held', ORIENTATION_ZERO_ACTION_FLAG_TURNS * 10)], []);

    const read = await readOrientationTelemetry(sql.tag, { workspaceId: 'ws-1' });
    const cls = read.classes.find((c) => c.classId === 'held')!;

    expect(cls.actionMeasurable).toBe(false);
    expect(cls.dispositions).toBeNull();
    expect(cls.flagged).toBe(false);
  });

  it('does not flag a measurable class that has produced dispositions', async () => {
    const sql = sqlFor(
      [reachRow('ownerDirectives', ORIENTATION_ZERO_ACTION_FLAG_TURNS * 2)],
      [{ class_id: 'ownerDirectives', dispositions: 7, open_rows: 1, settled: [2, 4, 9] }],
    );

    const read = await readOrientationTelemetry(sql.tag, { workspaceId: 'ws-1' });
    const cls = read.classes[0]!;

    expect(cls.flagged).toBe(false);
    expect(cls.medianTurnsToDisposition).toBe(4);
    expect(read.unavailableReason).toBeNull();
  });
});
