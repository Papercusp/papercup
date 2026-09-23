/**
 * P-016 — the `coupledPeers` orientation class: for each opt-in `coord:couple`
 * edge this owner is on, emit the peer's intent line WHEN IT CHANGES.
 *
 * The bar the plan item sets: uncoupled peers never render; a coupled peer
 * renders EXACTLY ONCE per intent change. Two further states this file pins
 * because each is a silent-failure mode of the class:
 *   - a SUPPRESSED (decoupled) peer never renders, even with a declared edge;
 *   - an UNREADABLE read (null) renders nothing AND preserves the committed
 *     token, so recovery does not re-announce every standing intent.
 *
 * Render cases drive the REAL registry through `composeOrientationBlock`, so a
 * class that is implemented but not registered — or whose watermark token is
 * written but not compared in `orientationUnchanged` — fails here.
 *
 * ⚠ vitest does NOT typecheck; the compile-time half lives in `lint:tsc`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getLoopStatusMock = vi.hoisted(() => vi.fn());
vi.mock('./harness/routines/loop', () => ({ getLoopStatus: getLoopStatusMock }));

const listCouplingsForMock = vi.hoisted(() => vi.fn());
vi.mock('./coord/couplings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./coord/couplings')>()),
  listCouplingsFor: listCouplingsForMock,
}));

/** The presence rows the fake `coord_presence` read can return, keyed by owner. */
const presenceRows = vi.hoisted(
  () => new Map<string, { owner_id: string; owner_label: string | null; intent: string | null }>(),
);
/** Every peer-id array the presence read was asked for — what reached the query. */
const presenceQueries = vi.hoisted(() => [] as string[][]);
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => {
    const sql = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const ids = values[0] as string[];
      presenceQueries.push([...ids]);
      return ids.flatMap((id) => (presenceRows.has(id) ? [presenceRows.get(id)!] : []));
    };
    return { sql: Object.assign(sql, { begin: vi.fn() }) };
  },
}));
vi.mock('./workspace-registry', () => ({ resolveConcreteWorkspaceId: (ws: string) => ws }));

import type { CouplingEdge } from './coord/couplings';
import {
  composeOrientationBlock,
  defaultOrientationDeps,
  fingerprintOrientation,
  type OrientationCoupledPeer,
  type OrientationState,
} from './turn-start-orientation';

const EPOCH = 3;
const ME = 'su-me000000-0000-0000-0000-000000000000';
const PEER_A = 'su-peera000-0000-0000-0000-000000000000';
const PEER_B = 'su-peerb000-0000-0000-0000-000000000000';
const PEER_C = 'su-peerc000-0000-0000-0000-000000000000';

function peer(ownerId: string, intent: string, ownerLabel: string | null = null): OrientationCoupledPeer {
  return { ownerId, ownerLabel, intent };
}

/**
 * A change in a class OTHER than this one, so the block re-renders around a
 * coupled-peer set that did not move. Without it every "renders nothing"
 * assertion would pass identically if the whole block had been suppressed.
 */
function inbox(summary: string) {
  return [{ msgId: `m-${summary.length}`, from: 'su-other', summary }];
}

function stateWith(
  coupledPeers: OrientationCoupledPeer[] | null,
  extra: Partial<OrientationState> = {},
): OrientationState {
  return {
    planDecisions: undefined,
    lockTransitions: undefined,
    coupledPeers,
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
    ...extra,
  };
}

/** Only the lines this class owns. */
function coupledLines(block: string): string[] {
  return block
    .split('\n')
    .filter((line) => line.startsWith('- coupled ') || line.includes('more coupled peer'));
}

describe('P-016 coupledPeers — renders exactly once per intent change', () => {
  it('FIRST SIGHT: a coupled peer with no committed token renders its intent', () => {
    const block = composeOrientationBlock({
      state: stateWith([peer(PEER_A, 'rewriting the demo resolver', 'su · su-peera')]),
      committed: null,
      epoch: EPOCH,
    });
    expect(coupledLines(block)).toEqual(['- coupled su · su-peera → rewriting the demo resolver']);
  });

  it('STEADY STATE: the same intent on the next turn is SILENT, on a block that did re-render', () => {
    const peers = [peer(PEER_A, 'rewriting the demo resolver')];
    const committed = fingerprintOrientation(stateWith(peers, { inboxRecent: inbox('first') }), EPOCH);
    const block = composeOrientationBlock({
      state: stateWith(peers, { inboxRecent: inbox('an unrelated peer message arrived') }),
      committed,
      epoch: EPOCH,
    });
    expect(block).not.toBe('');
    expect(coupledLines(block)).toEqual([]);
  });

  it('CHANGE: a new intent renders once, then goes silent again', () => {
    const t1 = fingerprintOrientation(stateWith([peer(PEER_A, 'intent one')]), EPOCH);
    const changed = stateWith([peer(PEER_A, 'intent two')]);
    const block = composeOrientationBlock({ state: changed, committed: t1, epoch: EPOCH });
    expect(coupledLines(block)).toEqual([`- coupled ${PEER_A} → intent two`]);

    // The ONLY input distinguishing turn 3 from turn 2 is the committed cursor.
    // If `orientationUnchanged` ignored the coupledPeers token, the change above
    // would never have produced a block at all; if the render ignored the token,
    // this turn would re-announce it.
    const t2 = fingerprintOrientation(changed, EPOCH, t1);
    const again = composeOrientationBlock({
      state: stateWith([peer(PEER_A, 'intent two')], { inboxRecent: inbox('unrelated') }),
      committed: t2,
      epoch: EPOCH,
    });
    expect(again).not.toBe('');
    expect(coupledLines(again)).toEqual([]);
  });

  it('a coupled-peer change ALONE re-renders the block (the orientationUnchanged conjunct)', () => {
    const t1 = fingerprintOrientation(stateWith([peer(PEER_A, 'intent one')]), EPOCH);
    const block = composeOrientationBlock({
      state: stateWith([peer(PEER_A, 'intent two')]),
      committed: t1,
      epoch: EPOCH,
    });
    expect(block).not.toBe('');
    expect(coupledLines(block)).toHaveLength(1);
  });

  it('only the peer whose intent CHANGED renders, never its unchanged neighbours', () => {
    const t1 = fingerprintOrientation(stateWith([peer(PEER_A, 'a1'), peer(PEER_B, 'b1')]), EPOCH);
    const block = composeOrientationBlock({
      state: stateWith([peer(PEER_A, 'a1'), peer(PEER_B, 'b2')]),
      committed: t1,
      epoch: EPOCH,
    });
    expect(coupledLines(block)).toEqual([`- coupled ${PEER_B} → b2`]);
  });

  it('a whitespace-only reflow of the same intent is NOT a change', () => {
    const t1 = fingerprintOrientation(stateWith([peer(PEER_A, 'fixing  the\tresolver')]), EPOCH);
    const block = composeOrientationBlock({
      state: stateWith([peer(PEER_A, 'fixing the resolver')], { inboxRecent: inbox('x') }),
      committed: t1,
      epoch: EPOCH,
    });
    expect(block).not.toBe('');
    expect(coupledLines(block)).toEqual([]);
  });

  it('intents differing only PAST the display cut still count as a change (hashed, not truncated)', () => {
    const prefix = 'x'.repeat(200);
    const t1 = fingerprintOrientation(stateWith([peer(PEER_A, `${prefix} ending one`)]), EPOCH);
    const block = composeOrientationBlock({
      state: stateWith([peer(PEER_A, `${prefix} ending two`)]),
      committed: t1,
      epoch: EPOCH,
    });
    expect(coupledLines(block)).toHaveLength(1);
  });
});

describe('P-016 coupledPeers — unreadable is not "nothing changed"', () => {
  it('null renders nothing AND preserves the committed token, so recovery is silent', () => {
    const peers = [peer(PEER_A, 'standing intent')];
    const t1 = fingerprintOrientation(stateWith(peers), EPOCH);

    const unreadable = stateWith(null, { inboxRecent: inbox('during the outage') });
    const outage = composeOrientationBlock({ state: unreadable, committed: t1, epoch: EPOCH });
    expect(coupledLines(outage)).toEqual([]);

    const t2 = fingerprintOrientation(unreadable, EPOCH, t1);
    expect(t2.coupledPeers).toBe(t1.coupledPeers);

    // The good read after recovery diffs against what the agent last SAW.
    const recovered = composeOrientationBlock({
      state: stateWith(peers, { inboxRecent: inbox('after recovery') }),
      committed: t2,
      epoch: EPOCH,
    });
    expect(recovered).not.toBe('');
    expect(coupledLines(recovered)).toEqual([]);
  });
});

describe('P-016 coupledPeers — the default reader (real resolveCoupledPeers)', () => {
  const edge = (a: string, b: string, state: 'coupled' | 'suppressed'): CouplingEdge => {
    const [agentA, agentB] = a < b ? [a, b] : [b, a];
    return {
      agentA,
      agentB,
      state,
      declaredBy: ME,
      reason: null,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
      expiresAt: null,
    };
  };

  beforeEach(() => {
    listCouplingsForMock.mockReset();
    presenceRows.clear();
    presenceQueries.length = 0;
    for (const id of [PEER_A, PEER_B, PEER_C]) {
      presenceRows.set(id, { owner_id: id, owner_label: null, intent: `intent of ${id}` });
    }
  });

  it('an UNCOUPLED peer never reaches the presence read, so it can never render', async () => {
    listCouplingsForMock.mockResolvedValue([edge(ME, PEER_A, 'coupled')]);
    const peers = await defaultOrientationDeps().coupledPeers(ME, 'ws');
    expect(peers?.map((p) => p.ownerId)).toEqual([PEER_A]);
    expect(presenceQueries).toEqual([[PEER_A]]);
  });

  it('a SUPPRESSED (decoupled) peer never renders', async () => {
    listCouplingsForMock.mockResolvedValue([edge(ME, PEER_A, 'coupled'), edge(ME, PEER_C, 'suppressed')]);
    const peers = await defaultOrientationDeps().coupledPeers(ME, 'ws');
    expect(peers?.map((p) => p.ownerId)).toEqual([PEER_A]);
    expect(presenceQueries.flat()).not.toContain(PEER_C);
  });

  it('no edges is MEASURED-empty ([]) and skips the presence read', async () => {
    listCouplingsForMock.mockResolvedValue([]);
    expect(await defaultOrientationDeps().coupledPeers(ME, 'ws')).toEqual([]);
    expect(presenceQueries).toEqual([]);
  });

  it('a peer with no declared intent is omitted, not rendered as blank', async () => {
    listCouplingsForMock.mockResolvedValue([edge(ME, PEER_A, 'coupled')]);
    presenceRows.set(PEER_A, { owner_id: PEER_A, owner_label: null, intent: '   ' });
    expect(await defaultOrientationDeps().coupledPeers(ME, 'ws')).toEqual([]);
  });

  it('a failed couplings read is UNREADABLE (null), never measured-empty', async () => {
    listCouplingsForMock.mockRejectedValue(new Error('pg down'));
    expect(await defaultOrientationDeps().coupledPeers(ME, 'ws')).toBeNull();
  });
});
