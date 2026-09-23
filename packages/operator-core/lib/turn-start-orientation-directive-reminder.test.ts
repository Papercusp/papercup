/**
 * Owner-directive reminder cadence — P-006 of
 * owner-directive-delivery-redesign-2026-09-22 (D-005).
 *
 * Before P-006 an addressed agent's open directive re-rendered its obligation
 * row on EVERY turn (the P-002 class-B re-emit), which is the per-turn cost
 * directive #200 asked to remove. Now the row is delivered once per context
 * epoch, and a single reminder line stands in for it each time the agent's
 * context has grown by OWNER_DIRECTIVE_REMINDER_TOKENS.
 *
 * Driven through the real provider, the real turn-start projector and the real
 * compose → delivered-fingerprint pair, one call per turn, exactly as
 * buildTurnStartOrientationBlock chains them.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAgentObligations } from './agent-obligations';
import { ownerDirectiveObligations, type OwnerDirectiveObligationRow } from './agent-obligation-providers';
import { projectAgentTurnStartObligationBrief } from './agent-obligation-reader';
import type { CursorState } from './agent-tools/coordination/read-cursors';
import {
  composeOrientationBlockWithRows,
  fingerprintDeliveredOrientation,
  OWNER_DIRECTIVE_REMINDER_ESCALATE_AFTER,
  OWNER_DIRECTIVE_REMINDER_TOKENS,
  type OrientationState,
} from './turn-start-orientation';

const OWNER = 'su-reminded';
const T0 = '2026-09-23T01:00:00.000Z';
const DUE_ROW = (id: number) => `Owner directive #${id} is yours and still open`;

function brief(ids: number[], observedAt = T0) {
  const rows: OwnerDirectiveObligationRow[] = ids.map((id) => ({
    id,
    state: 'open',
    displayText: `"directive ${id}"`,
    recordedAt: T0,
    recordedBy: OWNER,
    capturedByHook: true,
  }));
  const obligations = ownerDirectiveObligations({
    workspaceId: 'ws-reminded',
    ownerId: OWNER,
    observedAt,
    // Keyed on the id set, as the real reader's generation is on its inputs:
    // a directive arriving is a change, the same set is not.
    sourceGeneration: `gen-${ids.join('-')}`,
    read: { status: 'known', value: rows },
  });
  return projectAgentTurnStartObligationBrief(evaluateAgentObligations(obligations, observedAt));
}

const quiet: OrientationState = {
  held: [],
  unansweredDirected: 0,
  unansweredStale: 0,
  inboxRecent: [],
  openAsks: null,
  announcedGates: [],
  modes: [],
  authorityVerdict: null,
  planDecisions: undefined,
  lockTransitions: undefined,
  coupledPeers: [],
  loopArmed: true,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};

/** One turn: compose against the cursor, then fingerprint what was delivered. */
function turn(input: { ids: number[]; tokens: number | null; committed: CursorState | null; epoch?: number; at?: string }) {
  const epoch = input.epoch ?? 1;
  const state: OrientationState = { ...quiet, obligations: brief(input.ids, input.at) };
  const { block } = composeOrientationBlockWithRows({
    state,
    committed: input.committed,
    epoch,
    contextTokens: input.tokens,
  });
  return { block, cursor: fingerprintDeliveredOrientation(state, epoch, input.committed, block, input.tokens) };
}

describe('owner-directive reminder cadence (P-006)', () => {
  it('delivers the rows once, then stays silent until the context has grown by the threshold', async () => {
    const first = turn({ ids: [188], tokens: 100_000, committed: null });
    expect(first.block).toContain(DUE_ROW(188));

    // Pre-P-006 this turn re-rendered the row; now it says nothing.
    const quietTurn = turn({ ids: [188], tokens: 120_000, committed: first.cursor });
    expect(quietTurn.block).toBe('');

    const due = turn({ ids: [188], tokens: 100_000 + OWNER_DIRECTIVE_REMINDER_TOKENS, committed: quietTurn.cursor });
    expect(due.block).toContain('reminder: owner directive #188 still open and yours');
    // One line, not the row again.
    expect(due.block).not.toContain(DUE_ROW(188));

    // The reminder resets the clock: the next small step is silent again.
    const after = turn({ ids: [188], tokens: 160_000, committed: due.cursor });
    expect(after.block).toBe('');
  });

  it('escalates the wording once reminders keep going unanswered', async () => {
    let cursor = turn({ ids: [188, 189], tokens: 0, committed: null }).cursor;
    let block = '';
    for (let n = 1; n <= OWNER_DIRECTIVE_REMINDER_ESCALATE_AFTER + 1; n++) {
      ({ block, cursor } = turn({ ids: [188, 189], tokens: n * OWNER_DIRECTIVE_REMINDER_TOKENS, committed: cursor }));
      if (n <= OWNER_DIRECTIVE_REMINDER_ESCALATE_AFTER) expect(block).toContain('📌 reminder');
    }
    expect(block).toContain(`reminder ${OWNER_DIRECTIVE_REMINDER_ESCALATE_AFTER + 1}, still unanswered`);
    expect(block).toContain('#188, #189');
  });

  it('a new context epoch delivers the full rows again', async () => {
    const first = turn({ ids: [188], tokens: 10_000, committed: null, epoch: 1 });
    const fresh = turn({ ids: [188], tokens: 1_000, committed: first.cursor, epoch: 2 });
    expect(fresh.block).toContain(DUE_ROW(188));
  });

  it('a newly arrived directive gets its full row while the delivered one stays withheld', async () => {
    const first = turn({ ids: [188], tokens: 10_000, committed: null });
    const arrived = turn({ ids: [188, 190], tokens: 12_000, committed: first.cursor });
    expect(arrived.block).toContain(DUE_ROW(190));
    expect(arrived.block).not.toContain(DUE_ROW(188));
  });

  it('without a context-size reading, falls back to a wall-clock cadence', async () => {
    const first = turn({ ids: [188], tokens: null, committed: null, at: T0 });
    const soon = turn({ ids: [188], tokens: null, committed: first.cursor, at: '2026-09-23T01:10:00.000Z' });
    expect(soon.block).toBe('');
    const later = turn({ ids: [188], tokens: null, committed: soon.cursor, at: '2026-09-23T01:31:00.000Z' });
    expect(later.block).toContain('reminder: owner directive #188');
  });

  it('a reminder the budget cut is not marked delivered, so it is still due next turn', async () => {
    const first = turn({ ids: [188], tokens: 0, committed: null });
    const state: OrientationState = { ...quiet, obligations: brief([188]) };
    const tokens = OWNER_DIRECTIVE_REMINDER_TOKENS;
    const starved = composeOrientationBlockWithRows({
      state,
      committed: first.cursor,
      epoch: 1,
      contextTokens: tokens,
      budgetChars: 20,
    });
    expect(starved.block).toBe('');
    const cursor = fingerprintDeliveredOrientation(state, 1, first.cursor, starved.block, tokens);
    const retry = turn({ ids: [188], tokens: OWNER_DIRECTIVE_REMINDER_TOKENS + 1_000, committed: cursor });
    expect(retry.block).toContain('reminder: owner directive #188');
  });
});
