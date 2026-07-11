/**
 * bettable-first feature (su-ideate-learning-substrate-2026-07-10 P-007). Pins:
 *  - isBettableIdeation = scout isBettable over the persisted (untrusted) payload
 *    shape: complete + substantive triple ⇒ true; missing / trivial fields ⇒ false;
 *  - the feature's per-item output: bettable ⇒ value 1 + { ideation, bettable:true }
 *    attached; ideation-without-complete-experiment ⇒ value 0 + { ideation } only
 *    (the flag is never attached false — absence IS the negative);
 *  - ABSENCE CHANGES NOTHING: an item with no payload.ideation gains no fields and
 *    contributes 0, so the ranked queue is byte-identical to the pre-P-007 order;
 *  - end-to-end through applyHumanQueueRanking: among otherwise-equal items the
 *    bettable one ranks FIRST, and its breakdown names the feature + weight.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildDigest } from '../harness/improvements/digest';
import type { CandidateIdeation, ImprovementCandidate } from '../harness/improvements/policy';
import type { IssueLinkCounts } from '../issues-engineer';
import { BETTABLE_FIRST_WEIGHT, bettableFirstFeature, isBettableIdeation } from './bettable-first-feature';
import type { HumanQueueRankContext } from './blocking-impact-feature';
import { applyHumanQueueRanking, HUMAN_QUEUE_FEATURES } from './human-queue';

// Optional ranker features (deferral / owner-preference) graduated to default-ON —
// pin the flags OFF (as human-queue.test.ts does) so this suite exercises
// blocking-impact + bettable-first deterministically.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFlag: vi.fn(async () => false),
}));

const NOW = Date.parse('2026-07-11T00:00:00Z');

/** A complete, substantive cheap experiment (every field past the 8-char floor). */
const COMPLETE_EXPERIMENT = {
  hypothesis: 'triage decisions land twice as fast with the flag',
  method: 'measure one week of triage latency with the flag on',
  falsifiableSignal: 'median triage latency unchanged after the week',
};

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return {
    kind: 'change',
    scope: 'operator',
    title: `distinct topic ${p.id}`,
    state: 'open',
    severity: 'minor',
    createdAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(),
    ...p,
  };
}

function rankCtx(candidates: readonly ImprovementCandidate[]): HumanQueueRankContext {
  return {
    digest: { recurringSignatures: [], likelyDuplicates: [] },
    candidates,
    deps: { readLinkCounts: async () => new Map<string, IssueLinkCounts>() },
  };
}

describe('isBettableIdeation (the machine-checkable D-006 completeness test)', () => {
  it('a complete substantive experiment is bettable', () => {
    expect(isBettableIdeation({ cheapExperiment: COMPLETE_EXPERIMENT })).toBe(true);
  });

  it('a missing field is not bettable', () => {
    const { falsifiableSignal: _dropped, ...partial } = COMPLETE_EXPERIMENT;
    expect(isBettableIdeation({ cheapExperiment: partial })).toBe(false);
  });

  it('trivial / sub-floor fields are not bettable (isBettable substance gate)', () => {
    expect(
      isBettableIdeation({ cheapExperiment: { hypothesis: 'tbd', method: 'todo', falsifiableSignal: 'n/a' } }),
    ).toBe(false);
  });

  it('no ideation / no experiment is not bettable', () => {
    expect(isBettableIdeation(undefined)).toBe(false);
    expect(isBettableIdeation({ bet: 'a concrete upside but no experiment' })).toBe(false);
  });
});

describe('bettableFirstFeature.score', () => {
  const ideation: CandidateIdeation = {
    lens: 'risk-first',
    bet: 'halves triage latency for su ideas',
    cheapExperiment: COMPLETE_EXPERIMENT,
  };

  it('bettable ⇒ value 1 with { ideation, bettable:true } attached; incomplete ⇒ value 0 with ideation only; absent ⇒ nothing', async () => {
    const items = [
      cand({ id: 'EI-1' }), // no ideation at all
      cand({ id: 'EI-2', ideation }), // complete — bettable
      cand({ id: 'EI-3', ideation: { bet: 'upside declared, experiment missing' } }), // incomplete
    ];
    const digest = buildDigest(items, { nowMs: NOW });
    const out = await bettableFirstFeature.score(digest.humanQueue, rankCtx(items));

    expect(out.get('EI-1')).toBeUndefined(); // absence changes NOTHING

    const bettable = out.get('EI-2')!;
    expect(bettable.value).toBe(1);
    expect(bettable.attach).toEqual({ ideation, bettable: true });
    expect(bettable.reasons?.length).toBeGreaterThan(0);

    const incomplete = out.get('EI-3')!;
    expect(incomplete.value).toBe(0);
    // The flag is never attached false — absence IS the negative signal.
    expect(incomplete.attach).toEqual({ ideation: { bet: 'upside declared, experiment missing' } });
  });
});

describe('registry + end-to-end ranking (applyHumanQueueRanking)', () => {
  it('bettable-first is registered with its exported tunable weight', () => {
    const f = HUMAN_QUEUE_FEATURES.find((x) => x.name === 'bettable-first');
    expect(f).toBeDefined();
    expect(f!.weight).toBe(BETTABLE_FIRST_WEIGHT);
  });

  it('among otherwise-equal items the bettable idea ranks FIRST, breakdown naming the feature', async () => {
    const ideation: CandidateIdeation = { bet: 'big upside', cheapExperiment: COMPLETE_EXPERIMENT };
    // EI-8 sorts before EI-9 on the id tie-break — give the ideation to EI-9 so
    // the reordering is attributable to the feature, not the tie-break.
    const items = [cand({ id: 'EI-8' }), cand({ id: 'EI-9', ideation })];
    const digest = buildDigest(items, { nowMs: NOW });
    const ranked = await applyHumanQueueRanking(digest, { candidates: items, linkCounts: new Map() });

    expect(ranked.humanQueue.map((i) => i.id)).toEqual(['EI-9', 'EI-8']);
    const winner = ranked.humanQueue[0] as (typeof ranked.humanQueue)[number] & {
      bettable?: boolean;
      ideation?: CandidateIdeation;
    };
    expect(winner.bettable).toBe(true);
    expect(winner.ideation).toEqual(ideation);
    const contribution = winner.rank.features.find((f) => f.feature === 'bettable-first')!;
    expect(contribution.contribution).toBe(BETTABLE_FIRST_WEIGHT);
    // The non-ideation peer gains no fields and a zero contribution.
    const peer = ranked.humanQueue[1] as typeof winner;
    expect('bettable' in peer).toBe(false);
    expect('ideation' in peer).toBe(false);
    expect(peer.rank.features.find((f) => f.feature === 'bettable-first')!.contribution).toBe(0);
  });

  it('ABSENCE CHANGES NOTHING: without any ideation the order is the pre-P-007 tie-break order', async () => {
    const items = [cand({ id: 'EI-8' }), cand({ id: 'EI-9' })];
    const digest = buildDigest(items, { nowMs: NOW });
    const ranked = await applyHumanQueueRanking(digest, { candidates: items, linkCounts: new Map() });
    expect(ranked.humanQueue.map((i) => i.id)).toEqual(['EI-8', 'EI-9']);
    for (const item of ranked.humanQueue) {
      expect(item.rank.features.find((f) => f.feature === 'bettable-first')!.contribution).toBe(0);
    }
  });
});
