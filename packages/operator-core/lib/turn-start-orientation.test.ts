/**
 * turn-start-orientation — the pure composition half (P-004 / D-004 ruling 3).
 *
 * The IO half is a Promise.all of already-tested readers; what is worth pinning
 * here is the behaviour that decides whether an agent is oriented at all, and the
 * behaviour that decides what it COSTS every turn.
 */
import { describe, it, expect, vi } from 'vitest';

const getLoopStatusMock = vi.hoisted(() => vi.fn());
vi.mock('./harness/routines/loop', () => ({ getLoopStatus: getLoopStatusMock }));

import {
  composeOrientationBlock,
  defaultOrientationDeps,
  fingerprintOrientation,
  isLoopFireWithheld,
  orientationUnchanged,
  isEmptyOrientation,
  renderOrientationLines,
  resolveOrientationState,
  selectOrientationImprovementTriage,
  ORIENTATION_BUDGET_CHARS,
  type OrientationState,
} from './turn-start-orientation';
import { selectUntriaged } from './harness/improvements/triage-core';
import type { ScoredItem } from './harness/improvements/digest';

const base: OrientationState = {
  held: [],
  unansweredDirected: 0,
  openAsks: null,
  inboxRecent: [],
  announcedGates: [],
  loopArmed: false,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};
const withWork: OrientationState = {
  held: [
    {
      id: 'WI-1',
      status: 'wip',
      checkpoint: 'Implemented the reader; next run the focused test.',
      checkpointUpdatedAtMs: 1_000,
      checkpointStale: false,
    },
  ],
  unansweredDirected: 2,
  openAsks: null,
  inboxRecent: [{ msgId: 'm-1', from: 'su-peer', summary: 'Need your decision on the shared seam.' }],
  announcedGates: [{ event: 'fleet:atlas:phase-open', note: 'Phase 2 may begin.' }],
  loopArmed: true,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};

/** The context generation most of these cases hold fixed; P-023's own block varies it. */
const EPOCH = 3;

describe('turn-start-orientation — when it speaks', () => {
  it('says NOTHING when there is nothing to say (no held work, no mail, no loop)', () => {
    expect(isEmptyOrientation(base)).toBe(true);
    expect(composeOrientationBlock({ state: base, committed: null, epoch: EPOCH })).toBe('');
  });

  it('speaks in full on the FIRST turn (no committed cursor = baseline)', () => {
    const out = composeOrientationBlock({ state: withWork, committed: null, epoch: EPOCH });
    expect(out).toContain('Orientation');
    expect(out).toContain('WI-1 (wip)');
    expect(out).toContain('2 directed msg(s) awaiting YOUR reply');
  });

  it('says NOTHING on a turn where nothing changed — the whole economy of the fold', () => {
    const committed = fingerprintOrientation(withWork, EPOCH);
    expect(composeOrientationBlock({ state: withWork, committed, epoch: EPOCH })).toBe('');
  });

  it('emits the executable frontier on baseline, then suppresses it during unrelated changes', () => {
    const state: OrientationState = {
      ...withWork,
      executableFrontier: { planSlug: 'one-plan', executableWidth: 7 },
    };
    expect(composeOrientationBlock({ state, committed: null, epoch: EPOCH })).toContain(
      'frontier: 7 executable (one-plan)',
    );

    const committed = fingerprintOrientation(state, EPOCH);
    const unrelated = composeOrientationBlock({
      state: { ...state, unansweredDirected: 3 },
      committed,
      epoch: EPOCH,
    });
    expect(unrelated).toContain('3 directed msg(s)');
    expect(unrelated).not.toContain('frontier:');
  });

  it('emits only real executable-frontier edges, including plan identity changes', () => {
    const previous: OrientationState = {
      ...withWork,
      executableFrontier: { planSlug: 'one-plan', executableWidth: 7 },
    };
    const committed = fingerprintOrientation(previous, EPOCH);
    expect(
      composeOrientationBlock({
        state: { ...previous, executableFrontier: { planSlug: 'one-plan', executableWidth: 1 } },
        committed,
        epoch: EPOCH,
      }),
    ).toContain('frontier: 7 -> 1 executable (one-plan)');
    expect(
      composeOrientationBlock({
        state: { ...previous, executableFrontier: { planSlug: 'next-plan', executableWidth: 2 } },
        committed,
        epoch: EPOCH,
      }),
    ).toContain('frontier: one-plan@7 -> next-plan@2 executable');
  });

  it('preserves the last frontier cursor through an unknown read without repeating it later', () => {
    const previous: OrientationState = {
      ...withWork,
      executableFrontier: { planSlug: 'one-plan', executableWidth: 7 },
    };
    const committed = fingerprintOrientation(previous, EPOCH);
    const unknown: OrientationState = {
      ...previous,
      unansweredDirected: 3,
      executableFrontier: null,
    };
    const out = composeOrientationBlock({ state: unknown, committed, epoch: EPOCH });
    expect(out).not.toContain('frontier:');
    expect(fingerprintOrientation(unknown, EPOCH, committed).frontier).toBe(committed.frontier);
  });

  it('speaks again the moment ANY tracked field changes', () => {
    const committed = fingerprintOrientation(withWork, EPOCH);
    for (const changed of [
      { ...withWork, unansweredDirected: 3 },
      { ...withWork, openAsks: { count: 1, oldestAgeMs: 1_000, oldestTo: 'su-peer' } },
      { ...withWork, loopArmed: false },
      { ...withWork, loopFireWithheld: true },
      { ...withWork, held: [{ id: 'WI-1', status: 'blocked' }] },
      { ...withWork, held: [{ id: 'WI-2', status: 'wip' }] },
      { ...withWork, announcedGates: [{ event: 'fleet:atlas:another-gate' }] },
      { ...withWork, inboxRecent: [{ msgId: 'm-2', from: 'su-peer', summary: 'New ask' }] },
      {
        ...withWork,
        improvementTriage: {
          pending: 3,
          considered: 3,
          lowerBound: false,
          top: { id: 'EI-3', title: 'Consume me', lane: 'human' },
        },
      },
    ] as OrientationState[]) {
      expect(composeOrientationBlock({ state: changed, committed, epoch: EPOCH })).not.toBe('');
    }
  });

  it('re-emits the WHOLE block on a change, never a partial diff', () => {
    // Binding-context surface: an agent shown only the changed line would read the
    // elided lines as absent state. orient-list-delta.ts made the same call for
    // orient's claimable/facts folds; this mirrors it deliberately.
    const committed = fingerprintOrientation(withWork, EPOCH);
    const out = composeOrientationBlock({
      state: { ...withWork, unansweredDirected: 3 },
      committed,
      epoch: EPOCH,
    });
    expect(out).toContain('WI-1 (wip)'); // unchanged line still present
    expect(out).toContain('engine loop'); // unchanged line still present
  });

  it('a held-item STATUS change re-emits, not just an id change', () => {
    const a = fingerprintOrientation({ ...base, held: [{ id: 'WI-1', status: 'wip' }] }, EPOCH);
    const b = fingerprintOrientation({ ...base, held: [{ id: 'WI-1', status: 'blocked' }] }, EPOCH);
    expect(orientationUnchanged(a, b)).toBe(false);
  });

  it('a withheld-fire state change re-emits while the loop remains armed', () => {
    const committed = fingerprintOrientation(withWork, EPOCH);
    expect(
      composeOrientationBlock({
        state: { ...withWork, loopFireWithheld: true },
        committed,
        epoch: EPOCH,
      }),
    ).not.toBe('');
  });

  it('held-item ORDER does not count as a change (the fingerprint sorts)', () => {
    const a = fingerprintOrientation(
      {
        ...base,
        held: [
          { id: 'WI-1', status: 'wip' },
          { id: 'WI-2', status: 'wip' },
        ],
      },
      EPOCH,
    );
    const b = fingerprintOrientation(
      {
        ...base,
        held: [
          { id: 'WI-2', status: 'wip' },
          { id: 'WI-1', status: 'wip' },
        ],
      },
      EPOCH,
    );
    expect(orientationUnchanged(a, b)).toBe(true);
  });

  it('treats an unrecognizable committed value as CHANGED (fail-open, never silent)', () => {
    // A delta must never make orientation worse than no delta — same posture as
    // idListUnchanged. Anything unparseable ⇒ deliver in full.
    for (const junk of [null, undefined, 'nope', 42, {}] as unknown[]) {
      expect(orientationUnchanged(junk as never, fingerprintOrientation(withWork, EPOCH))).toBe(false);
    }
  });
});

/**
 * P-023 / D-008 — the epoch-boundary behaviour.
 *
 * These are the cases the pre-P-023 fold got WRONG, and they are worth stating as
 * behaviour rather than as implementation: the cursor is keyed by OWNER, but what
 * it dedups against is the agent's CONTEXT. A carry-respawn and a cold loop wake
 * both keep the owner id and discard the context — and they are exactly the
 * boundaries where orientation state is most likely to be byte-identical to the
 * predecessor's last turn, because nothing changed except that the process
 * restarted. So the old suppression was anti-correlated with need.
 */
describe('turn-start-orientation — the context boundary (P-023 / D-008)', () => {
  it('SPEAKS across a context boundary even when nothing else changed at all', () => {
    // The load-bearing case. Identical held items, identical mail, identical loop —
    // only the context generation moved. Pre-P-023 this returned '' and a fresh
    // successor was told nothing.
    const committed = fingerprintOrientation(withWork, 7);
    const out = composeOrientationBlock({ state: withWork, committed, epoch: 8 });
    expect(out).not.toBe('');
    expect(out).toContain('WI-1 (wip)');
  });

  it('still says nothing WITHIN one context generation — the economy is preserved', () => {
    // The complement of the case above: this change must not turn a per-turn fold
    // into a per-turn cost. Same epoch, same state ⇒ still silent.
    const committed = fingerprintOrientation(withWork, 8);
    expect(composeOrientationBlock({ state: withWork, committed, epoch: 8 })).toBe('');
  });

  it('treats a PRE-P-023 committed cursor (no epoch key) as changed, not as equal', () => {
    // Migration posture: rows written before the epoch key existed must re-emit
    // once rather than suppress forever against a generation they never recorded.
    const legacy = { held: 'WI-1:wip', unanswered: 2, loop: 1 };
    expect(orientationUnchanged(legacy, fingerprintOrientation(withWork, 0))).toBe(false);
  });

  it('a generation that never moves reproduces the OLD dedup exactly (0 = unknown)', () => {
    // `currentSessionEpoch` answers 0 on a missing relation or a failed read, and
    // that degradation must be the pre-P-023 behaviour — not a block on every turn.
    const committed = fingerprintOrientation(withWork, 0);
    expect(composeOrientationBlock({ state: withWork, committed, epoch: 0 })).toBe('');
  });

  it('carries the epoch on the fingerprint so a stage() cannot commit a silent one', () => {
    expect(fingerprintOrientation(withWork, 8).epoch).toBe(8);
    expect(orientationUnchanged(fingerprintOrientation(withWork, 7), fingerprintOrientation(withWork, 8))).toBe(false);
  });

  it('CONTROL: the pre-P-023 comparator cannot tell a boundary crossing apart', () => {
    // Falsifiability control, kept permanently rather than proved by mutating the
    // tree (the repo's tier for a module subject: a deliberately-wrong
    // implementation lives beside the real one). Without it the assertions above
    // could pass for the wrong reason — e.g. if the two states differed in some
    // field other than the epoch, "re-emits" would be true but vacuous.
    //
    // Here every content field is identical BY CONSTRUCTION (same `withWork`), so
    // the old three-field comparator returns "unchanged" and would suppress the
    // block. That is the exact defect: a fresh successor, told nothing.
    const a = fingerprintOrientation(withWork, 7);
    const b = fingerprintOrientation(withWork, 8);
    const preP023Comparator = a.held === b.held && a.unanswered === b.unanswered && a.loop === b.loop;
    expect(preP023Comparator).toBe(true); // old logic: "nothing changed" → silence
    expect(orientationUnchanged(a, b)).toBe(false); // new logic: context moved → speak
  });
});

describe('turn-start-orientation — what it says', () => {
  it('leads with unanswered directed mail — it outranks the agent’s own work', () => {
    const [first] = renderOrientationLines(withWork);
    expect(first).toContain('awaiting YOUR reply');
  });

  it('warns explicitly when NO wake source is armed', () => {
    const out = composeOrientationBlock({
      state: { ...withWork, loopArmed: false },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('not armed');
    expect(out).toContain('halt silently');
  });

  it('labels an armed loop fire withheld for interaction instead of making it look unarmed', () => {
    const out = composeOrientationBlock({
      state: { ...withWork, loopFireWithheld: true },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('engine loop: ARMED — fire pending, withheld for interactive turn.');
    expect(out).not.toContain('engine loop: not armed');
  });

  it('recognizes only a current, active withheld fire', () => {
    const fired = '2026-08-24T04:00:00.000Z';
    expect(isLoopFireWithheld({ active: true, lastFiredAt: fired, lastWithheldAt: '2026-08-24T04:00:01.000Z' })).toBe(
      true,
    );
    expect(isLoopFireWithheld({ active: true, lastFiredAt: fired, lastWithheldAt: fired })).toBe(true);
    expect(isLoopFireWithheld({ active: true, lastFiredAt: fired, lastWithheldAt: '2026-08-24T03:59:59.000Z' })).toBe(
      false,
    );
    expect(isLoopFireWithheld({ active: false, lastFiredAt: fired, lastWithheldAt: '2026-08-24T04:00:01.000Z' })).toBe(
      false,
    );
    expect(isLoopFireWithheld({ active: true, lastFiredAt: null, lastWithheldAt: '2026-08-24T04:00:01.000Z' })).toBe(
      false,
    );
    expect(isLoopFireWithheld({ active: true, lastFiredAt: 'not-a-time', lastWithheldAt: '2026-08-24T04:00:01.000Z' })).toBe(
      false,
    );
  });

  it('reads the withheld-fire signal from the shared loop-status discriminator', async () => {
    getLoopStatusMock.mockResolvedValue({
      active: true,
      lastFiredAt: '2026-08-24T04:00:00.000Z',
      lastWithheldAt: '2026-08-24T04:00:01.000Z',
    });
    expect(await defaultOrientationDeps().loopFireWithheld('su-1')).toBe(true);

    getLoopStatusMock.mockResolvedValue({
      active: true,
      lastFiredAt: '2026-08-24T04:00:02.000Z',
      lastWithheldAt: '2026-08-24T04:00:01.000Z',
    });
    expect(await defaultOrientationDeps().loopFireWithheld('su-1')).toBe(false);
    expect(getLoopStatusMock).toHaveBeenCalledWith('su-1');
  });

  it('tells an agent holding nothing to claim before editing', () => {
    const out = composeOrientationBlock({
      state: { ...base, unansweredDirected: 1 },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('holding: nothing');
  });

  it('folds held checkpoints, staleness, announced gates, and actionable inbox headlines', () => {
    const state: OrientationState = {
      ...withWork,
      held: [
        { ...withWork.held[0]!, checkpointStale: true },
        { id: 'WI-2', status: 'wip', checkpoint: null },
      ],
    };
    const out = composeOrientationBlock({ state, committed: null, epoch: EPOCH });
    expect(out).toContain('stale checkpoint: WI-1');
    expect(out).toContain('no checkpoint: WI-2');
    expect(out).toContain('announced gates: fleet:atlas:phase-open');
    expect(out).toContain('checkpoint WI-1: Implemented the reader');
    expect(out).toContain('inbox su-peer: Need your decision');
  });

  it('injects the ranked top untriaged improvement with its bounded-window count and lane', () => {
    const out = composeOrientationBlock({
      state: {
        ...base,
        improvementTriage: {
          pending: 6,
          considered: 6,
          lowerBound: false,
          top: { id: 'EI-6', title: 'Repeated coord send truncation', lane: 'human' },
        },
      },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('improvement triage: 6 untriaged');
    expect(out).toContain('top EI-6 [human] — Repeated coord send truncation');
  });

  it('labels a capped triage window as a lower bound instead of a fleet-wide total', () => {
    const out = composeOrientationBlock({
      state: {
        ...base,
        improvementTriage: {
          pending: 80,
          considered: 100,
          lowerBound: true,
          top: { id: 'EI-80', title: 'Bound the population', lane: 'human' },
        },
      },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('at least 80 untriaged in 100-row window');
    expect(out).not.toContain('triage: 80 untriaged;');
  });

  it('preserves the one human-queue ranker order while filtering untriaged rows', () => {
    const item = (id: string, score: number): ScoredItem => ({
      id,
      kind: 'change',
      title: id,
      scope: 'operator-core',
      tier: 'human',
      score,
      ageDays: 1,
      tierReason: 'test',
    });
    const rankedFirst = item('EI-ranked-first', 1);
    const legacyScoreFirst = item('EI-legacy-score-first', 100);
    const humanQueue = [rankedFirst, legacyScoreFirst];

    expect(
      selectOrientationImprovementTriage(
        { humanQueue, autoEligible: [] },
        selectUntriaged,
        { considered: 2, lowerBound: false },
      ),
    ).toEqual({
      pending: 2,
      considered: 2,
      lowerBound: false,
      top: { id: 'EI-ranked-first', title: 'EI-ranked-first', lane: 'human' },
    });
    expect(humanQueue.map((candidate) => candidate.id)).toEqual([
      'EI-ranked-first',
      'EI-legacy-score-first',
    ]);
  });

  it('keeps no-wake and checkpoint warnings ahead of lower-priority fold content', () => {
    const lines = renderOrientationLines({
      ...withWork,
      loopArmed: false,
      held: [{ ...withWork.held[0]!, checkpointStale: true }],
    });
    const directed = lines.findIndex((line) => line.includes('awaiting YOUR reply'));
    const noWake = lines.findIndex((line) => line.includes('engine loop: not armed'));
    const stale = lines.findIndex((line) => line.includes('stale checkpoint'));
    const gates = lines.findIndex((line) => line.includes('announced gates'));
    expect(directed).toBeLessThan(noWake);
    expect(noWake).toBeLessThan(stale);
    expect(stale).toBeLessThan(gates);
  });

  it('resolves every new fold leg through injectable shared-reader seams', async () => {
    const state = await resolveOrientationState('su-1', 'ws-1', {
      held: async () => [{ id: 'WI-9', checkpoint: 'continue here', checkpointStale: true }],
      inbox: async () => ({
        count: 1,
        newest: [{ msgId: 'm-9', from: 'su-2', summary: 'Please answer.' }],
      }),
      announcedGates: async () => [{ event: 'fleet:f:ready' }],
      loopArmed: async () => true,
      loopFireWithheld: async () => true,
      improvementTriage: async () => ({
        pending: 2,
        considered: 2,
        lowerBound: false,
        top: { id: 'EI-9', title: 'Act on this filing', lane: 'human' },
      }),
      executableFrontier: async () => ({ planSlug: 'one-plan', executableWidth: 2 }),
      neverDropFacts: async () => ['guard-rail:some-settled-thing'],
    });
    expect(state).toEqual({
      held: [{ id: 'WI-9', checkpoint: 'continue here', checkpointStale: true }],
      unansweredDirected: 1,
      openAsks: null,
      inboxRecent: [{ msgId: 'm-9', from: 'su-2', summary: 'Please answer.' }],
      announcedGates: [{ event: 'fleet:f:ready' }],
      loopArmed: true,
      loopFireWithheld: true,
      improvementTriage: {
        pending: 2,
        considered: 2,
        lowerBound: false,
        top: { id: 'EI-9', title: 'Act on this filing', lane: 'human' },
      },
      executableFrontier: { planSlug: 'one-plan', executableWidth: 2 },
      neverDropFacts: ['guard-rail:some-settled-thing'],
      toolSurface: null,
      carryBlindWindow: null,
    });
  });

  it('re-emits the toolless warning while hook evidence keeps increasing', () => {
    const first: OrientationState = {
      ...base,
      unansweredDirected: 1,
      toolSurface: { hookCalls: 20, windowMinutes: 3 },
    };
    const firstBlock = composeOrientationBlock({ state: first, committed: null, epoch: EPOCH });
    expect(firstBlock).toContain('MCP TOOLS NOT REGISTERED');
    expect(firstBlock).toContain('20 harness beats OK');

    const committed = fingerprintOrientation(first, EPOCH);
    const second: OrientationState = {
      ...first,
      toolSurface: { hookCalls: 21, windowMinutes: 3 },
    };
    const secondBlock = composeOrientationBlock({ state: second, committed, epoch: EPOCH });
    expect(orientationUnchanged(committed, fingerprintOrientation(second, EPOCH))).toBe(false);
    expect(secondBlock).toContain('MCP TOOLS NOT REGISTERED');
    expect(secondBlock).toContain('21 harness beats OK');
    expect(secondBlock.indexOf('MCP TOOLS NOT REGISTERED')).toBeLessThan(
      secondBlock.indexOf('directed msg(s) awaiting YOUR reply'),
    );
  });

  it('degrades a failed improvement read to silence instead of a false zero', async () => {
    const state = await resolveOrientationState('su-1', 'ws-1', {
      held: async () => [],
      inbox: async () => ({ count: 0, newest: [] }),
      announcedGates: async () => [],
      loopArmed: async () => false,
      loopFireWithheld: async () => false,
      improvementTriage: async () => {
        throw new Error('ranker unavailable');
      },
      executableFrontier: async () => {
        throw new Error('frontier unavailable');
      },
    });
    expect(state.improvementTriage).toBeNull();
    expect(state.executableFrontier).toBeNull();
    expect(composeOrientationBlock({ state, committed: null, epoch: EPOCH })).toBe('');
  });
});

describe('turn-start-orientation — what it costs', () => {
  it('never exceeds its budget, even with an absurd number of held items', () => {
    const state: OrientationState = {
      ...base,
      held: Array.from({ length: 200 }, (_, i) => ({ id: `WI-${i}`, status: 'wip' })),
      unansweredDirected: 4,
      loopArmed: false,
    };
    const out = composeOrientationBlock({ state, committed: null, epoch: EPOCH });
    expect(out.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
  });

  it('drops the LOWEST-priority line under pressure, keeping unanswered mail', () => {
    const state: OrientationState = {
      ...base,
      held: [{ id: `WI-${'x'.repeat(120)}`, status: 'wip' }],
      unansweredDirected: 4,
      loopArmed: false,
    };
    const out = composeOrientationBlock({ state, committed: null, epoch: EPOCH, budgetChars: 160 });
    expect(out).toContain('awaiting YOUR reply');
    expect(out).not.toContain('engine loop');
  });

  it('emits NOTHING rather than a bare header when the budget fits no real line', () => {
    const out = composeOrientationBlock({
      state: withWork,
      committed: null,
      epoch: EPOCH,
      budgetChars: 10,
    });
    expect(out).toBe('');
  });
});

/**
 * EI-21309540201944554. coord:orient folds the never-drop tier on EVERY tick
 * (EI-18725816532600240, after a cold wake was told to implement an approach a
 * `dead-end:` fact had already falsified). This block fires even more often and
 * did not inherit that rule, so a settled do-not-repeat was invisible to the
 * agent it was written for unless it spent a coord:orient round-trip.
 */
describe('never-drop facts fold', () => {
  const KEYS = [
    'guard-rail:verifying-owner-speech-in-transcripts',
    'wall:host-bundle-unbuildable-at-staging-head',
    'dead-end:readinbox-push-filters-into-sql',
  ];
  const factLine = (state: OrientationState): string | undefined =>
    renderOrientationLines(state).find((l) => l.includes('never-drop facts'));

  it('surfaces the keys, and says how many it did not show', () => {
    const line = factLine({ ...base, neverDropFacts: KEYS });
    expect(line).toBeDefined();
    // Asserted on the legible HEAD, not the whole key: this one is 48 chars and
    // is deliberately clipped to FACT_KEY_CHARS to protect the budget.
    expect(line).toContain('guard-rail:verifying-owner-speech');
    expect(line).toContain('+1 more');
  });

  it('truncates a long key WITHOUT eating the type prefix', () => {
    // The prefix says how much authority the fact carries; a key clipped to a
    // bare "guard-r…" would cost the reader the only glanceable part.
    const line = factLine({ ...base, neverDropFacts: [`guard-rail:${'x'.repeat(120)}`] });
    expect(line).toContain('guard-rail:');
    expect(line).toContain('…');
  });

  it('ranks the do-not-repeat ABOVE the what-to-work-on lines', () => {
    const lines = renderOrientationLines({
      ...base,
      neverDropFacts: KEYS,
      improvementTriage: {
        pending: 5,
        considered: 100,
        lowerBound: true,
        top: { id: 'EI-9', lane: 'human', title: 'some untriaged thing' },
      },
    });
    const factIdx = lines.findIndex((l) => l.includes('never-drop facts'));
    const triageIdx = lines.findIndex((l) => l.includes('improvement triage'));
    expect(factIdx).toBeGreaterThanOrEqual(0);
    // Ordering IS the feature: a guard rail is worth almost nothing once the
    // agent has already picked an approach off the line below it.
    expect(triageIdx).toBeGreaterThan(factIdx);
  });

  it('is not an empty orientation when a never-drop fact is the only signal', () => {
    expect(isEmptyOrientation(base)).toBe(true);
    expect(isEmptyOrientation({ ...base, neverDropFacts: KEYS })).toBe(false);
  });

  it('re-emits when a NEW guard rail lands — the turn it first applies is the one that matters', () => {
    const before = fingerprintOrientation({ ...base, neverDropFacts: [KEYS[0]] }, EPOCH);
    const after = fingerprintOrientation({ ...base, neverDropFacts: KEYS }, EPOCH);
    expect(orientationUnchanged(before, after)).toBe(false);
  });

  it('does NOT re-emit merely because the fold returned the same keys in another order', () => {
    const a = fingerprintOrientation({ ...base, neverDropFacts: [KEYS[0], KEYS[1]] }, EPOCH);
    const b = fingerprintOrientation({ ...base, neverDropFacts: [KEYS[1], KEYS[0]] }, EPOCH);
    expect(orientationUnchanged(a, b)).toBe(true);
  });

  it('stays inside the default budget even with many long keys', () => {
    // composeOrientationBlock BREAKS on the first line that does not fit, so an
    // unbounded fact line would silently truncate every line below it.
    const many = Array.from({ length: 25 }, (_, i) => `guard-rail:${'long-slug-'.repeat(4)}${i}`);
    const out = composeOrientationBlock({
      state: { ...base, neverDropFacts: many },
      committed: null,
      epoch: EPOCH,
    });
    expect(out.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
    expect(out).toContain('never-drop facts');
  });

  it('still renders the higher-priority warning lines alongside it', () => {
    const out = composeOrientationBlock({
      state: { ...base, neverDropFacts: KEYS, unansweredDirected: 2 },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('directed msg(s) awaiting YOUR reply');
    expect(out).toContain('never-drop facts');
  });
});

/**
 * WI-2142142 — the SENDER-side mirror of the unanswered-directed line: asks
 * THIS agent made that a peer has not yet answered ("what am I still owed?",
 * as opposed to `unansweredDirected`'s "what do I still owe?").
 */
describe('open asks (WI-2142142 — "what am I still owed?")', () => {
  const openAsks = { count: 3, oldestAgeMs: 3_600_000, oldestTo: 'su-peer' };

  it('renders a line when there is at least one open ask', () => {
    const out = composeOrientationBlock({
      state: { ...base, openAsks },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('3 open ask(s) sent');
    expect(out).toContain('awaiting su-peer');
  });

  it('is absent, and does not break isEmptyOrientation, when openAsks is null', () => {
    expect(isEmptyOrientation(base)).toBe(true);
    expect(composeOrientationBlock({ state: base, committed: null, epoch: EPOCH })).toBe('');
  });

  it('renders below the unanswered-directed line — an ask you are owed never outranks one you owe', () => {
    const lines = renderOrientationLines({ ...withWork, openAsks });
    const directed = lines.findIndex((l) => l.includes('awaiting YOUR reply'));
    const owed = lines.findIndex((l) => l.includes('open ask(s) sent'));
    expect(directed).toBeGreaterThanOrEqual(0);
    expect(owed).toBeGreaterThan(directed);
  });

  it('says NOTHING on a turn where the open-ask count is unchanged — mirrors unansweredDirected', () => {
    const state = { ...withWork, openAsks };
    const committed = fingerprintOrientation(state, EPOCH);
    expect(composeOrientationBlock({ state, committed, epoch: EPOCH })).toBe('');
  });

  it('the fingerprint is COUNT-ONLY: age moving alone must not re-emit, but the count moving must', () => {
    const state = { ...withWork, openAsks };
    const committed = fingerprintOrientation(state, EPOCH);
    // Same age-token exclusion rule as `unanswered` beside it: a fingerprint keyed
    // on oldestAgeMs would re-emit every turn purely because time passed.
    expect(
      composeOrientationBlock({
        state: { ...state, openAsks: { ...openAsks, oldestAgeMs: openAsks.oldestAgeMs + 60_000 } },
        committed,
        epoch: EPOCH,
      }),
    ).toBe('');
    expect(
      composeOrientationBlock({
        state: { ...state, openAsks: { ...openAsks, count: openAsks.count + 1 } },
        committed,
        epoch: EPOCH,
      }),
    ).not.toBe('');
  });
});

/**
 * EI-21442716425230784 — the carry blind window's line.
 *
 * A successor inherits a carry document built BEFORE the cut it describes: the
 * psu host waits on a busy-gate, and everything the predecessor does in that
 * window is absent from the doc. The doc warns that such a window exists but
 * carries no signal about THIS one, so the successor cannot tell an empty window
 * from one holding the most owner-salient act of the session (the reported case:
 * an OAuth consent URL the owner was explicitly asked to act on).
 */
describe('carry blind window line', () => {
  const window = {
    snapshotAtMs: Date.parse('2026-08-25T16:13:55.000Z'),
    cutAtMs: Date.parse('2026-08-25T16:17:52.000Z'),
    windowMs: 237_000,
    callsAfter: 26,
    lastCallAtMs: Date.parse('2026-08-25T16:17:33.000Z'),
    lastToolName: 'capability:bash',
  };

  it('renders above the directed-message line — it is the only line that DECAYS', () => {
    // Every other line describes state the agent can re-read all session. This one
    // describes turns living solely in a dead predecessor's transcript, so losing
    // it to budget truncation loses it permanently.
    const lines = renderOrientationLines({ ...withWork, carryBlindWindow: window });
    const blind = lines.findIndex((l) => l.includes('carry blind window'));
    const directed = lines.findIndex((l) => l.includes('directed msg(s)'));
    expect(blind).toBeGreaterThanOrEqual(0);
    expect(directed).toBeGreaterThanOrEqual(0);
    expect(blind).toBeLessThan(directed);
  });

  it('a measured window makes an otherwise-identical orientation re-emit', () => {
    // The shape this must survive: a successor's first turn holds exactly what its
    // predecessor held, so every other token is unchanged. A fingerprint blind to
    // the window would suppress the one warning that cannot be re-derived.
    const without = fingerprintOrientation(base, 7);
    const with_ = fingerprintOrientation({ ...base, carryBlindWindow: window }, 7);
    expect(orientationUnchanged(without, with_)).toBe(false);
  });

  it('does not re-emit while the same window stands — it is a one-shot', () => {
    const first = fingerprintOrientation({ ...base, carryBlindWindow: window }, 7);
    const second = fingerprintOrientation({ ...base, carryBlindWindow: { ...window } }, 7);
    expect(orientationUnchanged(first, second)).toBe(true);
  });

  it('a window alone is enough to spend the block on', () => {
    expect(isEmptyOrientation(base)).toBe(true);
    expect(isEmptyOrientation({ ...base, carryBlindWindow: window })).toBe(false);
  });

  it('degrades to silence when the reader fails, never to a manufactured window', async () => {
    getLoopStatusMock.mockResolvedValue({ active: false });
    const state = await resolveOrientationState('su-x', 'ws-1', {
      held: async () => [],
      inbox: async () => ({ count: 0, newest: [] }),
      announcedGates: async () => [],
      loopArmed: async () => false,
      loopFireWithheld: async () => false,
      improvementTriage: async () => null,
      executableFrontier: async () => null,
      neverDropFacts: async () => [],
      toolSurface: async () => null,
      carryBlindWindow: async () => {
        throw new Error('host event log unreadable');
      },
      contextEpoch: async () => 1,
    });
    expect(state.carryBlindWindow).toBeNull();
  });
});
