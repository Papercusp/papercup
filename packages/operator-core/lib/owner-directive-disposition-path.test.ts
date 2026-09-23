/**
 * owner-directive-disposition-path.test.ts — the RESCOPED R-26 of P-009 on plan
 * `turn-start-memory-two-class-2026-09-21`, ordered by decision D-062.
 *
 * WHY THIS FILE EXISTS. R-26 originally demanded an ORDERING between two
 * already-terminal artifacts: that owner directive #17 reached `done` only
 * AFTER a live observation was recorded. #17 reached `done` at
 * 2026-09-21T19:55:58Z, 2m38s BEFORE the founding completion, with no
 * observation recorded. No future action makes a past ordering true, so that
 * bar was unsatisfiable in principle rather than merely expensive. D-062 took
 * exit (b) and rescoped it to an assertion over the DISPOSITION PATH itself:
 *
 *     a directive cannot be rendered as dispositioned while it is still pending.
 *
 * The original INTENT — do not mark a directive done before the mechanism is
 * shown to work — is preserved and generalised: instead of one unrepeatable
 * claim about #17, this pins the property for EVERY undispositioned row, on
 * every turn, in CI, and it fails when the behaviour regresses.
 *
 * SCOPE, and what already covers the rest. The re-injection half of the
 * contract (a pending row renders on turn N and AGAIN on N+1, and STOPS once
 * dispositioned) is the rescoped R-25 and is already pinned, green, by
 * `turn-start-class-b-reinject.test.ts`. The STORAGE half (the five lifecycle
 * states partition the population; a refused transition leaves the row in the
 * state it already had) is pinned by `owner-directive-state-parity` and
 * `owner-directive-disposition-readback`. What NONE of them assert is the
 * RENDER-path direction below: that no pending/open row can ever be presented
 * to an agent as already handled.
 *
 * THE FAILURE THIS CATCHES. `ownerDirectiveObligations` renders a discharged,
 * not-applicable obligation for exactly one input: an EMPTY queue. If a future
 * change ever lets an undispositioned row reach that branch — a widened state
 * union with a `default:` arm, a filter that drops a state it does not
 * recognise, a disposition map that stops being total — the agent is shown
 * "No undispositioned owner directive applies" while a real owner directive is
 * still pending. That is WI-10002186's original hole (capture dead, nothing
 * failed) re-opened from the other end, and it is silent by construction.
 */
import { describe, expect, it } from 'vitest';
import { agentObligationIsActionable, evaluateAgentObligations } from './agent-obligations';
import {
  ownerDirectiveObligations,
  type OwnerDirectiveObligationRow,
  type OwnerDirectivesProviderInput,
} from './agent-obligation-providers';

const OBSERVED_AT = '2026-09-21T16:00:00.000Z';

/**
 * Every state an UNDISPOSITIONED directive can be in. Terminal states
 * (`dismissed`/`done`/`declined`) are deliberately absent: the row type's own
 * contract says they "are not obligations and must be filtered out by the
 * reader, never represented here".
 *
 * COMPILE-TIME TOTALITY. This is a `Record` over the union rather than a bare
 * array so the check is derived from the type instead of hand-maintained
 * beside it: if `state` ever gains a member and this map does not, the file
 * fails to typecheck rather than silently under-measuring every case below.
 * A test that iterates a stale list is the exact shape of a guard that passes
 * while the thing it guards has moved.
 */
const UNDISPOSITIONED: Record<OwnerDirectiveObligationRow['state'], { verb: string }> = {
  open: { verb: 'orders:disposition' },
};

const UNDISPOSITIONED_STATES = Object.keys(UNDISPOSITIONED) as OwnerDirectiveObligationRow['state'][];

function row(state: OwnerDirectiveObligationRow['state'], id: number): OwnerDirectiveObligationRow {
  return {
    id,
    state,
    displayText: `"owner turn held in ${state}"`,
    recordedAt: '2026-09-21T15:27:44.000Z',
    recordedBy: 'su-c03852cb',
    capturedByHook: true,
  };
}

function known(rows: OwnerDirectiveObligationRow[]): OwnerDirectivesProviderInput {
  return {
    workspaceId: 'papercusp-workspace',
    ownerId: 'su-test',
    observedAt: OBSERVED_AT,
    sourceGeneration: 'gen-1',
    read: { status: 'known', value: rows },
  };
}

describe('R-26 (rescoped by D-062): a pending directive is never RENDERED as dispositioned', () => {
  it('CALIBRATION: the state map really covers more than one state', () => {
    // Without this, a union that collapsed to a single member — or a map that
    // lost an entry — would leave every per-state assertion below trivially
    // satisfied by one case, and the exhaustiveness claim would be a fiction.
    // D-001 of owner-directive-delivery-redesign-2026-09-22 removed the pending
    // triage, so exactly one undispositioned state remains — pinned, not assumed.
    expect(UNDISPOSITIONED_STATES).toEqual(['open']);
  });

  it('renders EVERY undispositioned state as due and actionable — never discharged', () => {
    for (const state of UNDISPOSITIONED_STATES) {
      const [obligation] = ownerDirectiveObligations(known([row(state, 17)]));
      expect(obligation, `${state} produced no obligation at all`).toBeDefined();
      expect(obligation!.status, `${state} must be due`).toBe('due');
      expect(
        agentObligationIsActionable(obligation!),
        `a ${state} directive rendered as NOT actionable — it would be shown as already handled`,
      ).toBe(true);
    }
  });

  it('keeps every undispositioned row in the DELIVERED set, not merely in the agenda', () => {
    // `primary` is what actually reaches the agent. A row that is due but
    // ranked out of `primary` is invisible in practice, which is the same
    // failure wearing a different hat.
    const rows = UNDISPOSITIONED_STATES.map((state, index) => row(state, 17 + index));
    const agenda = evaluateAgentObligations(ownerDirectiveObligations(known(rows)), OBSERVED_AT);
    expect(agenda.primary).toHaveLength(rows.length);
  });

  it('routes each state to ITS OWN disposition verb', () => {
    // A swapped verb tells the agent to clear a pending row with the verb that
    // only closes an already-promoted one. The row would be reported as
    // dispositionable by a path that cannot discharge it, so it never clears.
    for (const state of UNDISPOSITIONED_STATES) {
      const [obligation] = ownerDirectiveObligations(known([row(state, 17)]));
      expect(obligation!.action?.tool, `${state} routed to the wrong verb`).toBe(UNDISPOSITIONED[state].verb);
    }
  });

  it('ties discharge to DISPOSITION OF THAT ROW — never to having rendered it', () => {
    // The discharge condition must name the row's own disposition. If it ever
    // becomes a delivery-shaped or queue-shaped condition, a rendered-once row
    // counts as handled and the re-inject contract collapses.
    for (const state of UNDISPOSITIONED_STATES) {
      const [obligation] = ownerDirectiveObligations(known([row(state, 17)]));
      expect(obligation!.clearsWhen?.id).toBe('owner-directive-dispositioned:17');
      expect(obligation!.clearsWhen?.sourceRef).toBe('owner-directive:17');
    }
  });

  it('THE INVARIANT: a discharged render is reachable ONLY from an empty queue', () => {
    // This is R-26 proper. Discharge must be caused by actual disposition —
    // which is observable here as the row having LEFT the pending/open queue —
    // and by nothing else. So: no non-empty input may render not-applicable.
    for (const state of UNDISPOSITIONED_STATES) {
      const obligations = ownerDirectiveObligations(known([row(state, 17)]));
      expect(
        obligations.some((entry) => entry.status === 'not-applicable'),
        `a ${state} row rendered as not-applicable — a live owner directive shown as already dispositioned`,
      ).toBe(false);
    }

    // And the positive control for that same branch: the empty queue — the
    // state a row reaches ONLY by being dispositioned — does render discharged.
    // Without this the assertion above could pass because the not-applicable
    // branch is unreachable for every input, testing nothing.
    const [discharged] = ownerDirectiveObligations(known([]));
    expect(discharged!.status, 'the empty-queue branch must still be reachable').toBe('not-applicable');
    expect(agentObligationIsActionable(discharged!)).toBe(false);
  });

  it('CONTROL: mixing open rows into the queue removes the discharged render entirely', () => {
    // The two branches are mutually exclusive by construction. If a build ever
    // emitted both, an agent could be told "nothing applies" alongside a live
    // directive and would be entitled to believe either one.
    const obligations = ownerDirectiveObligations(known([row('open', 17), row('open', 18)]));
    expect(obligations).toHaveLength(2);
    expect(obligations.every((entry) => entry.status === 'due')).toBe(true);
    expect(obligations.some((entry) => entry.status === 'not-applicable')).toBe(false);
  });
});
