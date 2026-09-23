/**
 * turn-start-class-b-reinject.test.ts — P-002 of plan
 * `turn-start-memory-two-class-2026-09-21`.
 *
 * WHAT THIS EXISTS TO CATCH. `composeOrientationBlock` suppresses the whole
 * block when the fingerprint matches the committed cursor, and
 * `fingerprintDeliveredOrientation` commits the obligations token as soon as the
 * actions and recovery pointer were delivered. Together those make an
 * obligation row a ONE-SHOT: it renders on the turn it appears and is silently
 * suppressed as "unchanged" for the rest of the session — even though nobody
 * acted on it.
 *
 * That is the wrong discharge condition. A class-B row is discharged by
 * DISPOSITION, not by DELIVERY. The tests below pin the corrected contract in
 * both directions, because only the pair is meaningful: an undischarged row
 * must render AGAIN on the next turn, and a dispositioned one must NOT.
 *
 * The obligations here are built by the REAL owner-directive provider rather
 * than hand-shaped fixtures, so this also exercises the P-006 path end to end.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAgentObligations } from './agent-obligations';
import { ownerDirectiveObligations, type OwnerDirectiveObligationRow } from './agent-obligation-providers';
import { projectAgentTurnStartObligationBrief } from './agent-obligation-reader';
import {
  composeOrientationBlock,
  fingerprintDeliveredOrientation,
  fingerprintOrientation,
  hasUndischargedObligations,
  orientationUnchanged,
  type OrientationState,
} from './turn-start-orientation';

const OBSERVED_AT = '2026-09-21T16:00:00.000Z';
const EPOCH = 7;

/** A live-shaped session that is otherwise completely quiet and UNCHANGING. */
const BASE: OrientationState = {
  planDecisions: undefined,
  lockTransitions: undefined,
  coupledPeers: [],
  held: [{ id: 'WI-10002197', status: 'wip', checkpoint: 'class-b re-inject in progress' }],
  unansweredDirected: 0,
  unansweredStale: 0,
  inboxRecent: [],
  openAsks: null,
  announcedGates: [],
  modes: [],
  // null is UNREADABLE — the silent value, so this quiet fixture asserts no
  // posture. Same convention as MINIMAL_STATE in the class-registry test.
  authorityVerdict: null,
  loopArmed: true,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: ['dead-end:gate-lastfiredat-not-evidence'],
  toolSurface: null,
  carryBlindWindow: null,
};

function briefFor(rows: OwnerDirectiveObligationRow[]) {
  return projectAgentTurnStartObligationBrief(
    evaluateAgentObligations(
      ownerDirectiveObligations({
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-test',
        observedAt: OBSERVED_AT,
        sourceGeneration: 'gen-1',
        read: { status: 'known', value: rows },
      }),
      OBSERVED_AT,
    ),
  );
}

/** One OPEN owner directive — undischarged until dispositioned done or declined. */
const UNDISCHARGED = briefFor([
  {
    id: 17,
    state: 'open',
    displayText: '"Implement owner-directive capture as HYBRID"',
    recordedAt: '2026-09-21T15:27:44.000Z',
    recordedBy: 'su-c03852cb',
    capturedByHook: true,
  },
]);

/** The SAME queue after disposition: measured empty, so nothing is actionable. */
const DISCHARGED = briefFor([]);

/**
 * P-006 of owner-directive-delivery-redesign-2026-09-22 narrowed this policy for
 * OWNER DIRECTIVES: their row is delivered once per context epoch and then
 * reminded on context growth (turn-start-orientation-directive-reminder.test.ts).
 * The per-turn re-emit still governs every OTHER family, so the re-emit cases
 * below run the same real row re-labelled as an owner-report obligation: the row
 * shape is what the composer renders, the family is what P-006 keys on.
 */
function relabelled(brief: typeof UNDISCHARGED): typeof UNDISCHARGED {
  const asReport = (entries: typeof brief.primary) =>
    entries.map((entry) => ({ ...entry, family: 'owner-report' as const }));
  return projectAgentTurnStartObligationBrief({
    schemaVersion: brief.schemaVersion,
    evaluatedAt: brief.evaluatedAt,
    sourceGeneration: brief.sourceGeneration,
    evaluations: asReport(brief.evaluations),
    primary: asReport(brief.primary),
    conflicts: [],
  });
}
const UNDISCHARGED_REPORT = relabelled(UNDISCHARGED);

const withObligations = (brief: typeof UNDISCHARGED): OrientationState => ({ ...BASE, obligations: brief });

/** Turn N: render, then stage the cursor exactly as the composer's caller does. */
function deliverTurn(state: OrientationState, committed: ReturnType<typeof fingerprintDeliveredOrientation> | null) {
  const block = composeOrientationBlock({ state, committed, epoch: EPOCH });
  const nextCursor = fingerprintDeliveredOrientation(state, EPOCH, committed, block);
  return { block, nextCursor };
}

describe('class-B re-inject policy', () => {
  it('discharges on DISPOSITION, not on delivery', () => {
    expect(hasUndischargedObligations(withObligations(UNDISCHARGED))).toBe(true);
    expect(hasUndischargedObligations(withObligations(DISCHARGED))).toBe(false);
  });

  it('calibration: the fixtures differ in the way the whole file depends on', () => {
    // Without this, both fixtures could be silently empty and every assertion
    // below would pass while measuring nothing.
    expect(UNDISCHARGED.primary.length).toBe(1);
    expect(DISCHARGED.primary).toEqual([]);
  });

  it('renders an undispositioned row on turn N and AGAIN on turn N+1', () => {
    const state = withObligations(UNDISCHARGED_REPORT);
    const first = deliverTurn(state, null);
    expect(first.block).toContain('#17');

    // Turn N+1: nothing has changed and the cursor was committed. Under the old
    // contract this returned '' and the owner directive was never seen again.
    const second = deliverTurn(state, first.nextCursor);
    expect(second.block, 'an undispositioned row must re-inject').toContain('#17');

    // FALSIFIABILITY, measured rather than assumed. The assertion above would
    // pass vacuously if the fingerprint simply differed on turn N+1 — the row
    // would re-render for an ordinary "something changed" reason and this file
    // would be testing nothing. So pin the precondition: the fingerprint IS
    // unchanged, which is exactly the state the composer's `unchanged &&
    // !undischarged` guard suppresses. Delete the `!undischarged` half and this
    // case goes red, because `composeOrientationBlock` returns '' on it.
    expect(
      orientationUnchanged(first.nextCursor, fingerprintOrientation(state, EPOCH, first.nextCursor)),
      'precondition: turn N+1 must be fingerprint-UNCHANGED, or this test proves nothing',
    ).toBe(true);
  });

  it('keeps re-injecting across many unchanged turns, not just the second', () => {
    const state = withObligations(UNDISCHARGED_REPORT);
    let cursor = deliverTurn(state, null).nextCursor;
    for (let turn = 0; turn < 5; turn += 1) {
      const next = deliverTurn(state, cursor);
      expect(next.block, `turn ${turn + 2} dropped the row`).toContain('#17');
      cursor = next.nextCursor;
    }
  });

  it('stops once the row is dispositioned', () => {
    const undischarged = withObligations(UNDISCHARGED);
    const first = deliverTurn(undischarged, null);
    expect(first.block).toContain('#17');

    // The directive is dispositioned, so the queue measures empty and the
    // obligation becomes not-applicable — never actionable, never in `primary`.
    const discharged = withObligations(DISCHARGED);
    const after = composeOrientationBlock({ state: discharged, committed: first.nextCursor, epoch: EPOCH });
    expect(after).not.toContain('#17');
  });

  it('re-injects the ROW ONLY — not the unchanged held/facts lines around it', () => {
    // Re-emitting the whole block every turn for one standing row would repeat
    // classes that genuinely have not moved, manufacturing the signal decay
    // D-003 withdrew the improvement-triage line for.
    const state = withObligations(UNDISCHARGED_REPORT);
    const first = deliverTurn(state, null);
    expect(first.block).toContain('WI-10002197');
    expect(first.block).toContain('never-drop facts:');

    const second = deliverTurn(state, first.nextCursor);
    expect(second.block).toContain('#17');
    expect(second.block, 'held items had not changed').not.toContain('WI-10002197');
    expect(second.block, 'facts had not changed').not.toContain('never-drop facts:');
  });

  it('an OWNER-DIRECTIVE row is the exception: delivered once per epoch, not every turn (P-006)', () => {
    const state = withObligations(UNDISCHARGED);
    const first = deliverTurn(state, null);
    expect(first.block).toContain('#17');
    // Same unchanged turn that re-emits the owner-report row above. For an owner
    // directive it stays quiet until the reminder cadence says otherwise.
    expect(deliverTurn(state, first.nextCursor).block).toBe('');
  });

  it('CONTROL: an unchanged turn with NO undischarged row is still suppressed', () => {
    // The bypass must be specific to undischarged obligations. If this ever
    // renders, the change degenerated into "always re-emit" and every dedup
    // guarantee in this file's neighbour suite is void.
    const state = withObligations(DISCHARGED);
    const first = deliverTurn(state, null);
    expect(first.block).not.toBe('');
    const second = composeOrientationBlock({ state, committed: first.nextCursor, epoch: EPOCH });
    expect(second, 'a fully unchanged, fully discharged turn must stay quiet').toBe('');
  });
});
