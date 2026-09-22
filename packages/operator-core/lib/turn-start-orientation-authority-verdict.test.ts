/**
 * P-013 — the `authorityVerdict` orientation class: the INSTRUCTION-PRECEDENCE
 * verdict's three decisions (execution-authorization, mission, ideation)
 * rendered as ONE line, and only when the agent's authority actually changed.
 *
 * Its own file rather than a block inside `turn-start-orientation.test.ts`
 * because the D-073 falsifier at the bottom needs `instruction-lint` as a
 * SECOND subject — the whole point of that control is that the two modules
 * disagree about what "changed" means, which a single-subject suite cannot
 * express.
 *
 * ⚠ vitest transforms via esbuild and does NOT typecheck; the compile-time half
 * of any claim here only fires under `lint:tsc`.
 */
import { describe, it, expect, vi } from 'vitest';

const getLoopStatusMock = vi.hoisted(() => vi.fn());
vi.mock('./harness/routines/loop', () => ({ getLoopStatus: getLoopStatusMock }));

import {
  composeOrientationBlock,
  fingerprintOrientation,
  type OrientationAuthorityVerdict,
  type OrientationState,
} from './turn-start-orientation';
import {
  buildInstructionPrecedenceTrace,
  type InstructionPrecedenceTrace,
  type InstructionRuntimeContext,
} from './instruction-lint';

const EPOCH = 3;

/**
 * Two verdicts that differ in EXACTLY ONE decision, whose values are all LEGAL
 * values of their own decision.
 *
 * D-075 ruling 2: a control built from an impossible/"unknown" value does not
 * catch a renderer that reads the WRONG decision key, because a wrong key still
 * produces a well-formed line. Only distinct legal values separate the right
 * key from a plausible wrong one.
 */
const AUTO: OrientationAuthorityVerdict = {
  executionAuthorization: 'act-with-disclosure',
  mission: 'execute-fleet-plan-only',
  ideation: 'direct-improvements-only',
};
const CONFIRM: OrientationAuthorityVerdict = { ...AUTO, executionAuthorization: 'confirm-before-execution' };

function stateWith(
  verdict: OrientationAuthorityVerdict | null,
  extra: Partial<OrientationState> = {},
): OrientationState {
  return {
    held: [],
    unansweredDirected: 0,
    unansweredStale: 0,
    inboxRecent: [],
    openAsks: null,
    announcedGates: [],
    modes: [],
    authorityVerdict: verdict,
    loopArmed: false,
    loopFireWithheld: false,
    improvementTriage: null,
    executableFrontier: null,
    neverDropFacts: [],
    toolSurface: null,
    carryBlindWindow: null,
    ...extra,
  };
}

/**
 * A change in a class OTHER than the verdict, so the block re-renders around a
 * verdict that did not move. This is the entire bar: `composeOrientationBlock`
 * is all-or-nothing by design, so a verdict gated only on its own watermark
 * token reappears verbatim the next time an unrelated inbox message lands.
 */
function inbox(summary: string) {
  return [{ msgId: `m-${summary.length}`, from: 'su-peer', summary }];
}

function authorityLines(block: string): string[] {
  return block.split('\n').filter((line) => line.startsWith('- authority:'));
}

describe('P-013 authorityVerdict — renders on a change, and only on a change', () => {
  it('speaks all three decisions on the first turn (no cursor to diff against)', () => {
    const block = composeOrientationBlock({ state: stateWith(AUTO), committed: null, epoch: EPOCH });

    expect(authorityLines(block)).toEqual([
      '- authority: exec act-with-disclosure · mission execute-fleet-plan-only · ideation direct-improvements-only.',
    ]);
  });

  it('renders NOTHING when the verdict is unchanged but the block re-renders for another class', () => {
    const committed = fingerprintOrientation(stateWith(AUTO, { inboxRecent: inbox('first') }), EPOCH);

    const block = composeOrientationBlock({
      state: stateWith(AUTO, { inboxRecent: inbox('an unrelated peer message arrived') }),
      committed,
      epoch: EPOCH,
    });

    // The block DID re-render — otherwise this case proves nothing at all.
    expect(block).not.toBe('');
    expect(authorityLines(block)).toEqual([]);
  });

  it('renders a change exactly ONCE — not again on the next unrelated re-render', () => {
    const before = stateWith(CONFIRM, { inboxRecent: inbox('first') });
    const firstCursor = fingerprintOrientation(before, EPOCH);

    const changed = stateWith(AUTO, { inboxRecent: inbox('first') });
    const firstBlock = composeOrientationBlock({ state: changed, committed: firstCursor, epoch: EPOCH });
    expect(authorityLines(firstBlock)).toEqual([
      '- authority: exec confirm-before-execution -> act-with-disclosure.',
    ]);

    const secondCursor = fingerprintOrientation(changed, EPOCH, firstCursor);
    const secondBlock = composeOrientationBlock({
      state: stateWith(AUTO, { inboxRecent: inbox('a later, entirely unrelated message') }),
      committed: secondCursor,
      epoch: EPOCH,
    });

    expect(secondBlock).not.toBe('');
    expect(authorityLines(secondBlock)).toEqual([]);
  });

  it('stays silent on an UNREADABLE verdict rather than asserting a posture it could not read', () => {
    const committed = fingerprintOrientation(stateWith(AUTO, { inboxRecent: inbox('first') }), EPOCH);

    const block = composeOrientationBlock({
      state: stateWith(null, { inboxRecent: inbox('an unrelated peer message arrived') }),
      committed,
      epoch: EPOCH,
    });

    expect(block).not.toBe('');
    expect(authorityLines(block)).toEqual([]);
  });
});

describe('P-013 authorityVerdict — legal-value swap controls (D-075 ruling 2)', () => {
  /** [decision key, its rendered label, ANOTHER legal value of that same decision] */
  const cases: ReadonlyArray<readonly [keyof OrientationAuthorityVerdict, string, string]> = [
    ['executionAuthorization', 'exec', 'confirm-before-execution'],
    ['mission', 'mission', 'generic-backlog-selection'],
    ['ideation', 'ideation', 'invent-and-implement'],
  ];

  for (const [key, label, otherLegalValue] of cases) {
    it(`attributes a changed ${key} to the "${label}" label and to no other decision`, () => {
      const previous: OrientationAuthorityVerdict = { ...AUTO, [key]: otherLegalValue };
      const committed = fingerprintOrientation(stateWith(previous), EPOCH);

      const block = composeOrientationBlock({ state: stateWith(AUTO), committed, epoch: EPOCH });

      // A renderer that read a different key would still emit a well-formed
      // line — just this one, with the wrong label or the wrong pair.
      expect(authorityLines(block)).toEqual([`- authority: ${label} ${otherLegalValue} -> ${AUTO[key]}.`]);
    });
  }

  it('does not collapse two DIFFERENT legal verdicts onto the same diff key', () => {
    const committed = fingerprintOrientation(stateWith(CONFIRM), EPOCH);

    // Identical verdict against that cursor: silent.
    expect(
      authorityLines(composeOrientationBlock({ state: stateWith(CONFIRM), committed, epoch: EPOCH })),
    ).toEqual([]);
    // A verdict differing in one legal value: NOT silent.
    expect(
      authorityLines(composeOrientationBlock({ state: stateWith(AUTO), committed, epoch: EPOCH })),
    ).toHaveLength(1);
  });
});

/**
 * D-073's permanent falsifier.
 *
 * P-013's item text says to render the verdict "ONLY when the WATERMARK shows it
 * differs from the prior turn". Taken literally that keys the class on
 * `InstructionPrecedenceTrace.watermark` — and these cases are the measurement
 * showing that key re-emits an IDENTICAL line, which is why the shipped class is
 * keyed on the three decision VALUES instead.
 *
 * Per D-070 ruling 1 every trace here is CONSTRUCTED. None is read from live
 * session state: a falsifiability control anchored to the state it guards stops
 * being a control the moment that state moves.
 */
describe('D-073 — the trace watermark is the WRONG diff key for authority', () => {
  const FLEET_AUTO: InstructionRuntimeContext = {
    source: 'coord:orient',
    ownerId: 'su-constructed-fixture',
    modes: ['auto'],
    modeResolution: 'registry',
    route: { kind: 'fleet', fleet: 'turn-start-memory', role: 'member' },
    scope: { workspace: 'w', harness: 'h', plan: 'p', items: ['P-013'] },
    loop: { active: true, intervalSec: 60 },
  };

  function decisionValues(trace: InstructionPrecedenceTrace): Record<string, string | null> {
    return Object.fromEntries(trace.decisions.map((d) => [d.key, d.effective?.value ?? null]));
  }

  it('emits exactly the three decisions the orientation line renders, in that order', () => {
    expect(buildInstructionPrecedenceTrace(FLEET_AUTO).decisions.map((d) => d.key)).toEqual([
      'execution-authorization',
      'mission',
      'ideation',
    ]);
  });

  it('FALSIFIER: claiming one more plan item moves the watermark while the authority is unchanged', () => {
    const before = buildInstructionPrecedenceTrace(FLEET_AUTO);
    const after = buildInstructionPrecedenceTrace({
      ...FLEET_AUTO,
      scope: { ...FLEET_AUTO.scope, items: ['P-013', 'P-014'] },
    });

    expect(after.watermark).not.toBe(before.watermark);
    expect(decisionValues(after)).toEqual(decisionValues(before));
  });

  it('FALSIFIER: retuning the loop interval moves the watermark while the authority is unchanged', () => {
    const before = buildInstructionPrecedenceTrace(FLEET_AUTO);
    const after = buildInstructionPrecedenceTrace({
      ...FLEET_AUTO,
      loop: { active: true, intervalSec: 300 },
    });

    expect(after.watermark).not.toBe(before.watermark);
    expect(decisionValues(after)).toEqual(decisionValues(before));
  });

  it('CALIBRATION: the same probe DOES see a real authority change, so the falsifiers are not vacuous', () => {
    const auto = buildInstructionPrecedenceTrace(FLEET_AUTO);
    const notAuto = buildInstructionPrecedenceTrace({ ...FLEET_AUTO, modes: [] });

    expect(notAuto.watermark).not.toBe(auto.watermark);
    expect(decisionValues(notAuto)).not.toEqual(decisionValues(auto));
  });

  it('the watermark is content-addressed, not time-derived — so it is comparable across turns', () => {
    const early = buildInstructionPrecedenceTrace({ ...FLEET_AUTO, observedAt: '2026-01-01T00:00:00.000Z' });
    const late = buildInstructionPrecedenceTrace({ ...FLEET_AUTO, observedAt: '2026-09-22T13:00:00.000Z' });

    expect(late.watermark).toBe(early.watermark);
    // …and the timestamp is still CARRIED, just not hashed — otherwise this
    // case would pass merely because `observedAt` is dropped on the floor.
    expect(late.provenance.observedAt).not.toBe(early.provenance.observedAt);
  });
});
