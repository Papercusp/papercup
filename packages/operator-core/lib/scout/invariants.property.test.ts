/**
 * Scout-loop invariants — PROPERTY suite (scout-loop-test-plan-2026-06-11, P-004).
 *
 * fast-check properties over the pure invariant predicates (./invariants) and
 * their two production consumers (`validateProposal`, recombine.ts;
 * `deriveProvenance`, cycle.ts), complementing the example-based P-009 suite
 * (scout-loop-invariants.test.ts) with generated corpora:
 *
 *  1. GROUNDED (#1 / D-003)  — accepted IFF addressesPatternRefs ⊆ digest refs
 *     (and non-empty); no generated item carrying an invented ref can pass.
 *  2. BETTABLE (#4 / D-006)  — `validateProposal` / `isBettable` accept IFF the
 *     cheap experiment exists with substantive hypothesis/method/falsifiableSignal
 *     (field omissions + blank/trivial strings fuzzed).
 *  3. PROVENANCE (P-013 / D-009) — `deriveProvenance` yields exactly one row per
 *     (dispatched decision × resolvable source idea), lens always the idea's own;
 *     no dupes, no missing, fused proposals never double-dispatch.
 *  4. FORCED DIVERSITY (#2 / D-004) — any all-same-lens roster collapse is
 *     rejected; fully-distinct rosters always pass.
 *
 * Arbitraries are CONSTRUCTIVE (mask-picked subsets of generated pools — no
 * fc.pre / .filter), so shrinking lands on small readable counterexamples.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { CorpusDigest, MetaPattern, Proposal, ScoutExperiment } from './types';
import { CREATIVE_LENSES } from './types';
import type { CritiqueVerdict } from './critique-core';
import type { RoutingDecision } from './router';
import { deriveProvenance, selectSurvivors } from './cycle';
import { validateProposal } from './recombine';
import {
  digestRefSet,
  distinctLenses,
  hasForcedDiversity,
  isBettable,
  isGrounded,
  ungroundedRefs,
  MIN_EXPERIMENT_FIELD_CHARS,
  type GroundedItem,
} from './invariants';
import { fixtureIdea, fixtureMetaPattern, fixtureProposal, fixtureScoredIdea } from './test-support';

/* ────────────────────────────────────────────────────────────────────────
 * Shared constructive helpers
 * ──────────────────────────────────────────────────────────────────────── */

/** Pick the subset of `items` whose index bit is set in `mask` (constructive subset). */
function pickByMask<T>(items: readonly T[], mask: number): T[] {
  return items.filter((_, i) => (mask >> i) & 1);
}

/** Compact drill-back refs ("wi:3", "plan:17") — small ints shrink readably. */
const refArb = fc
  .tuple(fc.constantFrom('wi', 'plan', 'gym'), fc.nat({ max: 99 }))
  .map(([kind, n]) => `${kind}:${n}`);

const lensArb = fc.constantFrom(...CREATIVE_LENSES);

/** Distribute refs across the digest's four lanes (rotated by `laneOffset`). */
function digestFromRefs(refs: readonly string[], laneOffset: number): CorpusDigest {
  const lanes: MetaPattern[][] = [[], [], [], []];
  refs.forEach((ref, i) => lanes[(i + laneOffset) % 4].push(fixtureMetaPattern({ ref })));
  const [recurringFriction, timeTokenSinks, chronicDeferrals, capabilityGaps] = lanes;
  return { recurringFriction, timeTokenSinks, chronicDeferrals, capabilityGaps };
}

/* ────────────────────────────────────────────────────────────────────────
 * #1 GROUNDED (D-003)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One grounding case: a unique ref pool is SPLIT into digest refs vs invented
 * refs (disjoint by construction), then the item mask-picks claims from each
 * side. The item is a real Idea or a real Proposal (both are GroundedItems).
 */
const groundingCaseArb = fc
  .record({
    pool: fc.uniqueArray(refArb, { minLength: 1, maxLength: 10 }),
    split: fc.nat({ max: 10 }),
    laneOffset: fc.nat({ max: 3 }),
    inMask: fc.nat({ max: 0x3ff }),
    outMask: fc.nat({ max: 0x3ff }),
    shape: fc.constantFrom<'idea' | 'proposal'>('idea', 'proposal'),
  })
  .map(({ pool, split, laneOffset, inMask, outMask, shape }) => {
    const cut = split % (pool.length + 1);
    const digestRefs = pool.slice(0, cut);
    const claimedIn = pickByMask(digestRefs, inMask);
    const claimedOut = pickByMask(pool.slice(cut), outMask);
    const addressesPatternRefs = [...claimedIn, ...claimedOut];
    const item: GroundedItem =
      shape === 'idea'
        ? fixtureIdea({ addressesPatternRefs })
        : fixtureProposal({ addressesPatternRefs });
    return { digest: digestFromRefs(digestRefs, laneOffset), digestRefs, item, claimedIn, claimedOut };
  });

describe('GROUNDED (#1 / D-003) — properties', () => {
  it('digestRefSet flattens exactly the refs of all four lanes', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(refArb, { maxLength: 10 }),
        fc.nat({ max: 3 }),
        (pool, laneOffset) => {
          const set = digestRefSet(digestFromRefs(pool, laneOffset));
          expect([...set].sort()).toEqual([...pool].sort());
        },
      ),
      { numRuns: 200 },
    );
  });

  it('IFF: accepted exactly when refs are non-empty and all drill back into the digest; ungroundedRefs names the invented ones', () => {
    fc.assert(
      fc.property(groundingCaseArb, ({ digest, item, claimedIn, claimedOut }) => {
        const refs = digestRefSet(digest);
        expect(isGrounded(item, refs)).toBe(claimedIn.length > 0 && claimedOut.length === 0);
        expect(ungroundedRefs(item, refs)).toEqual(claimedOut);
      }),
      { numRuns: 300 },
    );
  });

  it('a single invented ref poisons the item — no generated output can pass with an out-of-digest ref', () => {
    fc.assert(
      fc.property(groundingCaseArb, fc.integer({ min: 1, max: 3 }), (c, ghosts) => {
        // "ghost:" is never produced by refArb, so these are out-of-digest by construction.
        const poisoned: GroundedItem = {
          addressesPatternRefs: [
            ...c.item.addressesPatternRefs,
            ...Array.from({ length: ghosts }, (_, i) => `ghost:${i}`),
          ],
        };
        expect(isGrounded(poisoned, digestRefSet(c.digest))).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * #2 BETTABLE (D-006) — validateProposal + isBettable
 * ──────────────────────────────────────────────────────────────────────── */

/** Definitely-substantive field: ≥ MIN_EXPERIMENT_FIELD_CHARS, never a trivial token. */
const substantiveFieldArb = fc
  .string({ maxLength: 12 })
  .map((s) => `measure ${s} latency`);

/** Definitely-NOT-substantive: blank, trivial token, or trimmed length < the floor. */
const flimsyFieldArb = fc.oneof(
  fc.constantFrom('', '   ', '\t', 'tbd', 'TBD', 'n/a', 'NA', 'none', 'todo', 'ok', 'yes', 'NO', '????????', '--------'),
  fc.string({ maxLength: MIN_EXPERIMENT_FIELD_CHARS - 1 }),
);

/** A tagged experiment field: the value plus whether it should count as substantive. */
const expFieldArb = fc.oneof(
  substantiveFieldArb.map((v) => ({ v, ok: true })),
  flimsyFieldArb.map((v) => ({ v, ok: false })),
);

/** A tagged narrative field for validateProposal (present = non-blank string). */
const narrativeFieldArb = fc.oneof(
  fc.string({ maxLength: 8 }).map((s) => ({ v: `field ${s} text` as string | undefined, ok: true })),
  fc.constantFrom(undefined, '', ' ', '   ', '\n\t').map((v) => ({ v, ok: false })),
);

/** cheapExperiment slot: missing entirely, or three independently-fuzzed sub-fields. */
const experimentSlotArb = fc.oneof(
  fc.constant({ exp: undefined as ScoutExperiment | undefined, ok: false }),
  fc.tuple(narrativeFieldArb, narrativeFieldArb, narrativeFieldArb).map(([h, m, f]) => ({
    // Deliberately allows undefined sub-fields: the gate exists to reject
    // malformed (un-typed) LLM output, so we fuzz beyond the declared type.
    exp: { hypothesis: h.v, method: m.v, falsifiableSignal: f.v } as ScoutExperiment,
    ok: h.ok && m.ok && f.ok,
  })),
);

const sourceIdsArb = fc.oneof(
  fc.constant({ v: undefined as string[] | undefined, ok: false }),
  fc.constant({ v: [] as string[], ok: false }),
  fc.array(fc.nat({ max: 20 }).map((n) => `idea-${n}`), { minLength: 1, maxLength: 3 }).map((v) => ({ v, ok: true })),
);

const groundingArrayArb = fc.oneof(
  fc.constant({ v: undefined as string[] | undefined, ok: false }),
  // An EMPTY grounding array is valid for validateProposal ("may be empty").
  fc.array(refArb, { maxLength: 3 }).map((v) => ({ v, ok: true })),
);

describe('BETTABLE (#4 / D-006) — properties', () => {
  it('isBettable accepts IFF hypothesis AND method AND falsifiableSignal are each substantive', () => {
    fc.assert(
      fc.property(expFieldArb, expFieldArb, expFieldArb, (h, m, f) => {
        const p = fixtureProposal({
          cheapExperiment: { hypothesis: h.v, method: m.v, falsifiableSignal: f.v },
        });
        expect(isBettable(p)).toBe(h.ok && m.ok && f.ok);
      }),
      { numRuns: 300 },
    );
  });

  it('validateProposal accepts IFF every leg is present — and reports exactly one error per failed leg', () => {
    fc.assert(
      fc.property(
        narrativeFieldArb,
        narrativeFieldArb,
        narrativeFieldArb,
        narrativeFieldArb,
        experimentSlotArb,
        sourceIdsArb,
        groundingArrayArb,
        (framing, mechanism, whyNew, bet, exp, src, refs) => {
          const p: Partial<Proposal> = {
            framing: framing.v,
            mechanism: mechanism.v,
            whyNew: whyNew.v,
            bet: bet.v,
            cheapExperiment: exp.exp,
            sourceIdeaIds: src.v,
            addressesPatternRefs: refs.v,
          };
          const res = validateProposal(p);
          const failures = [framing, mechanism, whyNew, bet, exp, src, refs].filter((leg) => !leg.ok).length;
          expect(res.ok).toBe(failures === 0);
          expect(res.errors).toHaveLength(failures);
        },
      ),
      { numRuns: 300 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * #3 PROVENANCE completeness (P-013 / D-009) — deriveProvenance
 * ──────────────────────────────────────────────────────────────────────── */

/** A pool of ideas with unique ids, each on a generated lens. */
const ideaPoolArb = fc
  .uniqueArray(fc.record({ n: fc.nat({ max: 50 }), lens: lensArb }), {
    selector: (r) => r.n,
    maxLength: 8,
  })
  .map((rows) => rows.map((r) => fixtureIdea({ id: `idea-${r.n}`, lens: r.lens })));

/**
 * Idea pool + routing decisions derived from generated (possibly fused)
 * Proposals: each decision mask-picks source ideas from the pool, may add
 * "ghost" source ids that resolve to no idea, and may have failed to dispatch
 * (`routedRef` unset). routedRefs are unique per decision by construction
 * (the router dispatches each proposal once).
 */
const provenanceCaseArb = fc
  .record({
    ideas: ideaPoolArb,
    specs: fc.array(
      fc.record({
        srcMask: fc.nat({ max: 0xff }),
        ghostCount: fc.nat({ max: 2 }),
        rail: fc.constantFrom('plan', 'gym', 'improvement', 'instance'),
        dispatched: fc.boolean(),
        withTitle: fc.boolean(),
      }),
      { maxLength: 6 },
    ),
    cycleId: fc.option(fc.constantFrom('cyc-1', 'cyc-2'), { nil: undefined }),
  })
  .map(({ ideas, specs, cycleId }) => {
    const ids = ideas.map((i) => i.id);
    const decisions: RoutingDecision[] = specs.map((s, di) => {
      const proposal = fixtureProposal({
        id: `SP-${di}`,
        sourceIdeaIds: [
          ...pickByMask(ids, s.srcMask),
          ...Array.from({ length: s.ghostCount }, (_, g) => `ghost-${di}-${g}`),
        ],
      });
      return {
        proposalId: proposal.id,
        sourceIdeaIds: [...proposal.sourceIdeaIds],
        rail: s.rail,
        reason: 'property-fuzz routing',
        followedHint: false,
        ...(s.withTitle ? { title: `prop ${di}` } : {}),
        ...(s.dispatched ? { routedRef: `${s.rail}:${proposal.id}` } : {}),
      };
    });
    return { ideas, decisions, cycleId };
  });

describe('PROVENANCE (P-013 / D-009) — deriveProvenance properties', () => {
  it('yields exactly one row per (dispatched decision × resolvable source idea), in order, lens always the idea\'s own', () => {
    fc.assert(
      fc.property(provenanceCaseArb, ({ ideas, decisions, cycleId }) => {
        const rows = deriveProvenance(decisions, ideas, cycleId);
        const lensById = new Map(ideas.map((i) => [i.id, i.lens]));
        const expected = decisions
          .filter((d) => d.routedRef)
          .flatMap((d) =>
            d.sourceIdeaIds
              .filter((id) => lensById.has(id))
              .map((ideaId) => ({
                ideaId,
                lens: lensById.get(ideaId)!,
                rail: d.rail,
                routedRef: d.routedRef!,
                ...(cycleId ? { cycleId } : {}),
                ...(d.title ? { title: d.title } : {}),
              })),
          );
        expect(rows).toEqual(expected); // no missing, no extra, no reordering
      }),
      { numRuns: 250 },
    );
  });

  it('no duplicate attribution; fused proposals dispatch ONCE (rows share the decision\'s single routedRef)', () => {
    fc.assert(
      fc.property(provenanceCaseArb, ({ ideas, decisions, cycleId }) => {
        const rows = deriveProvenance(decisions, ideas, cycleId);
        const lensById = new Map(ideas.map((i) => [i.id, i.lens]));

        // No (routedRef × ideaId) pair appears twice.
        const pairs = rows.map((r) => `${r.routedRef}␟${r.ideaId}`);
        expect(new Set(pairs).size).toBe(pairs.length);

        // Every row's lens matches the source idea's lens; ghosts never leak.
        for (const r of rows) expect(r.lens).toBe(lensById.get(r.ideaId));

        // One routedRef per attributable dispatched decision — a proposal fusing
        // N ideas yields N attribution rows on ONE dispatch, never N dispatches.
        const attributable = decisions.filter(
          (d) => d.routedRef && d.sourceIdeaIds.some((id) => lensById.has(id)),
        );
        expect(new Set(rows.map((r) => r.routedRef)).size).toBe(attributable.length);

        // Undispatched decisions contribute nothing.
        const dispatchedRefs = new Set(attributable.map((d) => d.routedRef));
        for (const r of rows) expect(dispatchedRefs.has(r.routedRef)).toBe(true);
      }),
      { numRuns: 250 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * #4 FORCED DIVERSITY (D-004)
 * ──────────────────────────────────────────────────────────────────────── */

const lensRosterArb = fc.array(lensArb.map((lens) => ({ lens })), { maxLength: 12 });

describe('FORCED DIVERSITY (#2 / D-004) — properties', () => {
  it('IFF: a >1-idea roster passes threshold k exactly when it spans ≥ k distinct lenses', () => {
    fc.assert(
      fc.property(
        lensRosterArb,
        fc.integer({ min: 1, max: CREATIVE_LENSES.length }),
        (roster, k) => {
          const distinct = new Set(roster.map((r) => r.lens)).size;
          expect(distinctLenses(roster).size).toBe(distinct);
          expect(hasForcedDiversity(roster, k)).toBe(roster.length <= 1 || distinct >= k);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('REJECTS every roster collapse: N ≥ 2 ideators all on one lens never pass', () => {
    fc.assert(
      fc.property(lensArb, fc.integer({ min: 2, max: 12 }), (lens, n) => {
        const collapsed = Array.from({ length: n }, () => ({ lens }));
        expect(hasForcedDiversity(collapsed)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('ACCEPTS every fully-distinct roster — even at the strictest threshold (k = roster size)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(lensArb, { minLength: 2, maxLength: CREATIVE_LENSES.length }),
        (lenses) => {
          const roster = lenses.map((lens) => ({ lens }));
          expect(hasForcedDiversity(roster, roster.length)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('critic pruning never CREATES diversity: survivors\' lens spread ⊆ the ideated spread (it must be won at ideation)', () => {
    const scoredRosterArb = fc.array(
      fc
        .record({
          lens: lensArb,
          n: fc.nat({ max: 30 }),
          verdict: fc.constantFrom<CritiqueVerdict>('keep', 'moonshot', 'reject'),
        })
        .map(({ lens, n, verdict }) =>
          fixtureScoredIdea({ idea: fixtureIdea({ id: `idea-${lens}-${n}`, lens }), verdict }),
        ),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(scoredRosterArb, (scored) => {
        const all = distinctLenses(scored.map((s) => s.idea));
        const surviving = distinctLenses(selectSurvivors(scored).map((s) => s.idea));
        for (const lens of surviving) expect(all.has(lens)).toBe(true);
        expect(surviving.size).toBeLessThanOrEqual(all.size);
      }),
      { numRuns: 200 },
    );
  });
});
