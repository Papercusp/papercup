/**
 * P-014 — the `planDecisions` orientation class: for every plan on which this
 * owner holds a claimed item, push the governing decisions recorded since the
 * orientation cursor, instead of relying on the "read plans:get Decisions before
 * acting" PULL that nobody performs.
 *
 * The bar this file has to clear is NOT "a line appears". It is that the class
 * is a DIFF: it must stay silent on a decision the reader has already been
 * shown, while the block around it re-renders for unrelated reasons. A class
 * gated only on its own watermark token reappears verbatim every time an
 * unrelated inbox message lands, which is how a push becomes a standing nag the
 * reader learns to skip — the exact failure this class exists to avoid.
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
  type OrientationPlanDecision,
  type OrientationPlanDecisions,
  type OrientationState,
} from './turn-start-orientation';

const EPOCH = 5;

/** Mirrors the module-private `PLAN_DECISION_DISPLAY_CAP`. */
const DISPLAY_CAP = 3;

function decision(planSlug: string, id: string, title: string): OrientationPlanDecision {
  return { ref: `${planSlug}#${id}`, planSlug, id, title };
}

function decisions(
  list: OrientationPlanDecision[],
  extra: Partial<Omit<OrientationPlanDecisions, 'decisions'>> = {},
): OrientationPlanDecisions {
  return { decisions: list, omitted: 0, authorityReadFailed: false, ...extra };
}

function stateWith(
  planDecisions: OrientationPlanDecisions | undefined,
  extra: Partial<OrientationState> = {},
): OrientationState {
  return {
    planDecisions,
    lockTransitions: undefined,
    coupledPeers: [],
    held: [],
    unansweredDirected: 0,
    unansweredStale: 0,
    inboxRecent: [],
    openAsks: null,
    announcedGates: [],
    modes: [],
    authorityVerdict: null,
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
 * A change in a class OTHER than plan decisions, so the block re-renders around
 * a decision set that did not move. Without this the "renders nothing" cases
 * below would pass simply because the whole block was suppressed, which proves
 * nothing about THIS class.
 */
function inbox(summary: string) {
  return [{ msgId: `m-${summary.length}`, from: 'su-peer', summary }];
}

/** Every line this class owns — decision rows AND its two disclosures. */
function decisionLines(block: string): string[] {
  return block
    .split('\n')
    .filter((line) => line.startsWith('- plan ') || line.startsWith('- +') || line.includes('decision(s)') || line.includes('inbound-decision read FAILED'));
}

const D1 = decision('turn-start-memory-two-class-2026-09-21', 'D-081', 'Key the diff on decision refs, not a timestamp');
const D2 = decision('turn-start-memory-two-class-2026-09-21', 'D-082', 'R-7/R-9 are omitted for proof depth, not automation');

describe('P-014 planDecisions — pushes new governing decisions, and only the new ones', () => {
  it('speaks every decision on the first turn (no cursor to diff against)', () => {
    const block = composeOrientationBlock({ state: stateWith(decisions([D1, D2])), committed: null, epoch: EPOCH });

    expect(decisionLines(block)).toEqual([
      '- plan turn-start-memory-two-class-2026-09-21 D-081: Key the diff on decision refs, not a timestamp',
      '- plan turn-start-memory-two-class-2026-09-21 D-082: R-7/R-9 are omitted for proof depth, not automation',
    ]);
  });

  it('renders NOTHING for a decision already seen, while the block re-renders for another class', () => {
    const committed = fingerprintOrientation(
      stateWith(decisions([D1]), { inboxRecent: inbox('first') }),
      EPOCH,
    );

    const block = composeOrientationBlock({
      state: stateWith(decisions([D1]), { inboxRecent: inbox('an unrelated peer message arrived') }),
      committed,
      epoch: EPOCH,
    });

    // The block DID re-render — otherwise this case proves nothing at all.
    expect(block).not.toBe('');
    expect(decisionLines(block)).toEqual([]);
  });

  it('CALIBRATION — the matched pair: the same re-render DOES speak a decision that is genuinely new', () => {
    // Identical to the case above in every respect except that one NEW decision
    // has been recorded. If this failed, the silence above would be a renderer
    // that never speaks rather than a working diff.
    const committed = fingerprintOrientation(
      stateWith(decisions([D1]), { inboxRecent: inbox('first') }),
      EPOCH,
    );

    const block = composeOrientationBlock({
      state: stateWith(decisions([D1, D2])),
      committed,
      epoch: EPOCH,
    });

    expect(decisionLines(block)).toEqual([
      '- plan turn-start-memory-two-class-2026-09-21 D-082: R-7/R-9 are omitted for proof depth, not automation',
    ]);
  });

  it('D-081 — keys on the decision REF, so the same D-NNN id on a DIFFERENT plan is not suppressed', () => {
    // The failure this pins: keying on the in-plan id (`D-001`) instead of the
    // globally-citable ref silently swallows every other plan's D-001. Both
    // decisions here are legal, distinct, and share an id on purpose.
    const mine = decision('plan-alpha', 'D-001', 'Alpha ruling');
    const theirs = decision('plan-beta', 'D-001', 'Beta ruling');

    const committed = fingerprintOrientation(stateWith(decisions([mine])), EPOCH);
    const block = composeOrientationBlock({
      state: stateWith(decisions([mine, theirs])),
      committed,
      epoch: EPOCH,
    });

    expect(decisionLines(block)).toEqual(['- plan plan-beta D-001: Beta ruling']);
  });

  it('D-081 ruling 3 — UNREADABLE says NOTHING rather than an all-clear', () => {
    // `undefined` is a failed READ, not "no decisions". Rendering an all-clear
    // here would tell an agent it has seen every governing ruling on its plan at
    // exactly the moment we failed to look.
    const block = composeOrientationBlock({ state: stateWith(undefined), committed: null, epoch: EPOCH });

    expect(decisionLines(block)).toEqual([]);
  });

  it('caps the list and reports the remainder with a recovery verb', () => {
    const many = [
      decision('p', 'D-001', 'one'),
      decision('p', 'D-002', 'two'),
      decision('p', 'D-003', 'three'),
      decision('p', 'D-004', 'four'),
      decision('p', 'D-005', 'five'),
    ];

    const lines = decisionLines(
      composeOrientationBlock({ state: stateWith(decisions(many)), committed: null, epoch: EPOCH }),
    );

    expect(lines.filter((l) => l.startsWith('- plan '))).toHaveLength(DISPLAY_CAP);
    expect(lines.at(-1)).toContain(`+${many.length - DISPLAY_CAP} more new decision(s)`);
    expect(lines.at(-1)).toContain('plans:get');
  });

  describe('the incompleteness disclosures ride WITH a list, never alone', () => {
    it('discloses a bounded read window alongside the decisions it may have cut', () => {
      const block = composeOrientationBlock({
        state: stateWith(decisions([D1], { omitted: 4 })),
        committed: null,
        epoch: EPOCH,
      });

      expect(decisionLines(block).at(-1)).toContain('4 older decision(s) fell outside the read window');
    });

    it('CONTROL — the same omission is SILENT when nothing fresh renders, so it cannot become a standing nag', () => {
      const committed = fingerprintOrientation(
        stateWith(decisions([D1], { omitted: 4 }), { inboxRecent: inbox('first') }),
        EPOCH,
      );

      const block = composeOrientationBlock({
        state: stateWith(decisions([D1], { omitted: 4 }), { inboxRecent: inbox('an unrelated peer message arrived') }),
        committed,
        epoch: EPOCH,
      });

      expect(block).not.toBe('');
      expect(decisionLines(block)).toEqual([]);
    });

    it('discloses a FAILED authority read alongside the decisions it could not complete', () => {
      const block = composeOrientationBlock({
        state: stateWith(decisions([D1], { authorityReadFailed: true })),
        committed: null,
        epoch: EPOCH,
      });

      expect(decisionLines(block).at(-1)).toContain('inbound-decision read FAILED');
    });

    it('CONTROL — a failed read is SILENT when nothing fresh renders', () => {
      const committed = fingerprintOrientation(
        stateWith(decisions([D1], { authorityReadFailed: true }), { inboxRecent: inbox('first') }),
        EPOCH,
      );

      const block = composeOrientationBlock({
        state: stateWith(decisions([D1], { authorityReadFailed: true }), {
          inboxRecent: inbox('an unrelated peer message arrived'),
        }),
        committed,
        epoch: EPOCH,
      });

      expect(block).not.toBe('');
      expect(decisionLines(block)).toEqual([]);
    });
  });
});
