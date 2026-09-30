/**
 * turn-start-orientation-own-work-first.test.ts — D-027 of plan
 * `goal-brief-to-claimed-plan-work-2026-09-23` (R-3: omitted input cannot be
 * reported as ignored by the agent).
 *
 * WHAT THIS EXISTS TO CATCH. Measured 2026-09-30 on a goal holder (probe #4,
 * su-f75078c7): its turn-start `## Orientation` held ONLY three "👥 … THEIR open
 * owner directives" FYI groups (~850 chars), while its own turn-end rows recorded
 * a plan-placement obligation at the same moment. Two defects stacked:
 *
 *   1. other sessions' directive groups rendered at order 20, above every class
 *      describing the session's OWN work, so they spent the 1000-char budget first;
 *   2. the composer BREAKS on the first row that does not fit and said nothing,
 *      so the agent could not tell "no obligation" from "it did not fit".
 *
 * The fixture below is that incident's shape: three peer groups of real-length
 * directive text plus one obligation of this session's own.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAgentObligations } from './agent-obligations';
import {
  ownerDirectiveObligations,
  type OwnerDirectiveObligationRow,
} from './agent-obligation-providers';
import { projectAgentTurnStartObligationBrief } from './agent-obligation-reader';
import {
  composeOrientationBlockWithRows,
  ORIENTATION_BUDGET_CHARS,
  projectOrientationRows,
  type OrientationOwnerDirective,
  type OrientationState,
} from './turn-start-orientation';

const ME = 'su-9390fc63-26a0-46a9-95d1-805705cc5e2d';
const PEERS = [
  'su-091ad703-1111-4111-8111-111111111111',
  'su-cbf53cb6-2222-4222-8222-222222222222',
  'su-7273d7a5-3333-4333-8333-333333333333',
];
const OBSERVED_AT = '2026-09-30T03:28:42.000Z';
const EPOCH = 3;

/** Quiet on every other class, mirroring the owner-directive-buckets baseline. */
const BASELINE: OrientationState = {
  lockTransitions: undefined,
  coupledPeers: [],
  planDecisions: undefined,
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
};

// Real lengths from the incident: two short directives and one long summary line.
const PEER_TEXTS = [
  'put yourself on auto mode and continue carrying the pui plan to shipped status',
  'why did you stop?  put yourself on auto mode and continue carrying the plan to shipped status',
  'continue carrying every plan on the worklist to shipped status, then grade each shipped plan with the reused rubric and report which acceptance bars are still unmet and why',
];

function peerDirective(index: number): OrientationOwnerDirective {
  return {
    id: 460 + index,
    verbatimText: PEER_TEXTS[index]!,
    recordedBy: PEERS[index]!,
    capturedByHook: true,
    addressedToMe: false,
    addresseeState: 'ended',
  };
}

/** One obligation of this session's own, through the real provider → projector. */
function ownObligations() {
  const row: OwnerDirectiveObligationRow = {
    id: 908,
    state: 'open',
    displayText: JSON.stringify('ship the plan, then grade it'),
    recordedAt: '2026-09-30T03:00:00.000Z',
    recordedBy: ME,
    capturedByHook: true,
  };
  const agenda = evaluateAgentObligations(
    ownerDirectiveObligations({
      workspaceId: 'papercusp-workspace',
      ownerId: ME,
      observedAt: OBSERVED_AT,
      sourceGeneration: 'own-work-first-test',
      read: { status: 'known', value: [row] },
    }),
    OBSERVED_AT,
  );
  return projectAgentTurnStartObligationBrief(agenda);
}

function incidentState(): OrientationState {
  return {
    ...BASELINE,
    ownerDirectives: [peerDirective(0), peerDirective(1), peerDirective(2)],
    obligations: ownObligations(),
  };
}

const MARKER = /- \+(\d+) orientation rows omitted \(([^)]*)\) — coord:orient/;

describe('D-027 — own work renders before other sessions’ directives', () => {
  it('calibration: the fixture overflows the budget when peer groups lead', () => {
    // Without this, the ordering assertion below could pass on a fixture that
    // fits either way and prove nothing about precedence.
    const rows = projectOrientationRows(incidentState(), 'turn-start');
    const peer = rows.filter((row) => row.text.startsWith('- 👥 '));
    const obligation = rows.filter((row) => row.classId === 'obligations');
    expect(peer).toHaveLength(3);
    expect(obligation.length).toBeGreaterThan(0);
    const header = '## Orientation'.length;
    const peersFirst = [...peer, ...obligation].reduce((sum, row) => sum + row.text.length + 1, header);
    expect(peersFirst).toBeGreaterThan(ORIENTATION_BUDGET_CHARS);
  });

  it('delivers the session’s own obligation, and only then the peer FYI groups', () => {
    const state = incidentState();
    const { block } = composeOrientationBlockWithRows({ state, committed: null, epoch: EPOCH });
    const obligationLines = state.obligations!.projection.text.split('\n').filter(Boolean);
    expect(obligationLines.length).toBeGreaterThan(0);
    for (const line of obligationLines) expect(block).toContain(line);
    const firstPeer = block.indexOf('- 👥 ');
    if (firstPeer >= 0) expect(block.indexOf(obligationLines[0]!)).toBeLessThan(firstPeer);
    expect(block.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
  });

  it('keeps the session’s OWN directive at the top of the block', () => {
    const own: OrientationOwnerDirective = { ...peerDirective(0), id: 938, recordedBy: ME, addressedToMe: true };
    const state: OrientationState = { ...incidentState(), ownerDirectives: [own, peerDirective(1), peerDirective(2)] };
    const { block } = composeOrientationBlockWithRows({ state, committed: null, epoch: EPOCH });
    expect(block.split('\n')[1]).toContain('📌 YOURS · owner directive #938');
  });
});

describe('D-027 — the composer says what it cut', () => {
  it('names the omitted rows instead of dropping them silently', () => {
    const state = incidentState();
    const { block, rows } = composeOrientationBlockWithRows({ state, committed: null, epoch: EPOCH, budgetChars: 500 });
    const match = block.match(MARKER);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(0);
    expect(match![2]).toContain('ownerDirectives');
    expect(block.length).toBeLessThanOrEqual(500);
    // The marker is not a delivered row of any class it names.
    expect(rows.some((row) => MARKER.test(row.text))).toBe(false);
    expect(block.split('\n').at(-1)).toMatch(MARKER);
  });

  it('never exceeds the budget to fit the marker, at any budget', () => {
    const state = incidentState();
    for (let budget = 20; budget <= ORIENTATION_BUDGET_CHARS; budget += 13) {
      const { block } = composeOrientationBlockWithRows({ state, committed: null, epoch: EPOCH, budgetChars: budget });
      expect(block.length).toBeLessThanOrEqual(budget);
    }
  });

  it('adds no marker when everything fits', () => {
    const state: OrientationState = { ...BASELINE, obligations: ownObligations() };
    const { block } = composeOrientationBlockWithRows({ state, committed: null, epoch: EPOCH });
    expect(block).not.toMatch(MARKER);
    expect(block).not.toBe('');
  });
});
