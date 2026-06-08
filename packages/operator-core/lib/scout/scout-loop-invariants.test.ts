/**
 * Scout-loop INVARIANTS suite (hive-creative-ideation-2026-06-08, P-009 / B11).
 *
 * Asserts the plan's P-009 bar — the loop yields GROUNDED, NON-DUPLICATE,
 * BETTABLE proposals (each with a cheap experiment) with NO human prompt in the
 * cycle — via the pure predicates in `./invariants`, over the shared
 * verification-lane harness (`./test-support`, su-b6c3f) + grounded fixtures,
 * AND over the real P-006 `Proposal` type (su-d1170).
 *
 * GREEN TODAY over fixtures + the real Proposal contract (the predicates are the
 * durable definition of "correct"). The final block (`it.todo`) lights up when
 * the loop entrypoint lands — `runScoutCycle` (su-cb4b9, scout/cycle.ts) — at
 * which point the SAME predicates run over the real cycle output (and P-014's
 * E2E, su-b6c3f, reuses them). P-009 owns the invariants; P-014 the full cycle.
 */
import { describe, it, expect } from 'vitest';
import { CREATIVE_LENSES } from './types';
import type { Proposal, ScoredIdea, ScoutExperiment } from './types';
import type { CorpusEntry } from './critique-core';
import type { RoutingDecision } from './router';
import { runScoutCycle, selectSurvivors, type ScoutCycleDeps, type ScoutCyclePorts } from './cycle';
import { validateProposal } from './recombine';
import {
  FIXTURE_PATTERN_REFS,
  digestRefs,
  fixtureCorpusDigest,
  fixtureIdea,
  fixtureIdeasAllLenses,
  jsonResponder,
  makeFakeScoutLlm,
} from './test-support';
import {
  digestRefSet,
  distinctLenses,
  hasForcedDiversity,
  isBettable,
  isGrounded,
  isNonDuplicate,
  MIN_EXPERIMENT_FIELD_CHARS,
  proposalNoveltyText,
  ranWithoutHumanPrompt,
  ungroundedRefs,
} from './invariants';

/** A well-formed P-006 Proposal (su-d1170's shape), grounded + bettable by default. */
function fixtureProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    framing: 'agents waste turns hand-retrying lock-blocked edits instead of yielding',
    mechanism: 'on lock-block, register a wake on grant + yield the turn (events:await), never spin',
    whyNew: 'no prior plan wired the wake-on-grant yield into the edit-block path; today it spins',
    bet: 'eliminates retry-thrash and frees the turn for other work under contention',
    cheapExperiment: {
      hypothesis: 'wake-on-grant yield removes hand-retry thrash with no added latency',
      method: 'A/B the re-queue path over 50 real lock-blocks in a shadow run',
      falsifiableSignal: 'p50 edit-to-land latency regresses, or hand-retries > 0',
    },
    sourceIdeaIds: ['idea-analogical-1'],
    routeHint: 'gym',
    addressesPatternRefs: ['plan:lock-contention-2026-06-01'],
    ...over,
  };
}

describe('Scout-loop invariants (P-009): grounded · non-duplicate · bettable · no-human-prompt', () => {
  const digest = fixtureCorpusDigest();
  const refs = digestRefSet(digest);

  describe('#1 grounded (D-003) — leaps anchor to real Hive history', () => {
    it('digestRefSet flattens all four lanes', () => {
      expect(refs).toEqual(new Set(digestRefs(digest)));
      expect(refs.size).toBeGreaterThanOrEqual(4);
    });
    it('an idea targeting a real digest ref is grounded', () => {
      expect(isGrounded(fixtureIdea({ addressesPatternRefs: ['plan:lock-contention-2026-06-01'] }), refs)).toBe(true);
    });
    it('the full ideator roster is grounded (every idea ⊆ digest refs)', () => {
      for (const idea of fixtureIdeasAllLenses()) {
        expect(ungroundedRefs(idea, refs)).toEqual([]);
        expect(isGrounded(idea, refs)).toBe(true);
      }
    });
    it('an invented ref is flagged + fails grounding', () => {
      const idea = fixtureIdea({ addressesPatternRefs: ['plan:lock-contention-2026-06-01', 'plan:hallucinated'] });
      expect(ungroundedRefs(idea, refs)).toEqual(['plan:hallucinated']);
      expect(isGrounded(idea, refs)).toBe(false);
    });
    it('an empty ref set is ungrounded (no free-floating cleverness)', () => {
      expect(isGrounded(fixtureIdea({ addressesPatternRefs: [] }), refs)).toBe(false);
    });
  });

  describe('#2 forced diversity (D-004) — N lenses, no mode-collapse', () => {
    it('the full roster spans every distinct lens', () => {
      const ideas = fixtureIdeasAllLenses();
      expect(distinctLenses(ideas).size).toBe(CREATIVE_LENSES.length);
      expect(hasForcedDiversity(ideas)).toBe(true);
    });
    it('all-one-lens collapse fails', () => {
      const collapsed = CREATIVE_LENSES.map((_, i) => fixtureIdea({ id: `c${i}`, lens: 'analogical' }));
      expect(distinctLenses(collapsed).size).toBe(1);
      expect(hasForcedDiversity(collapsed)).toBe(false);
    });
    it('a two-lens batch passes the no-collapse floor', () => {
      expect(
        hasForcedDiversity([
          fixtureIdea({ id: 'a', lens: 'analogical' }),
          fixtureIdea({ id: 'b', lens: 'reframing' }),
        ]),
      ).toBe(true);
    });
    it('a single idea cannot collapse', () => {
      expect(hasForcedDiversity([fixtureIdea()])).toBe(true);
    });
  });

  describe('#3 non-duplicate (D-005) — search-first vs the corpus, reusing the shipped matcher', () => {
    const corpus: CorpusEntry[] = [
      {
        ref: 'plan:lock-contention-2026-06-01',
        kind: 'plan',
        state: 'shipped',
        text: 're-queue lock-blocked edits via events:await instead of hand-retrying',
      },
      {
        ref: 'idea:docs-cache',
        kind: 'idea',
        text: 'cache the docs outline so agents stop re-reading 316KB every session',
      },
    ];
    it('a genuinely novel proposal passes', () => {
      expect(
        isNonDuplicate('a MAP-Elites archive over scope, domain and risk niches for gym candidates', corpus),
      ).toBe(true);
    });
    it('a re-worded restatement of an already-SHIPPED prior is a duplicate', () => {
      // Same content tokens, reordered — the Jaccard matcher still collides, and
      // the prior is `shipped` ⇒ alreadyTried ⇒ rejected as duplicate.
      expect(
        isNonDuplicate('hand-retrying lock-blocked edits should instead re-queue via events:await', corpus),
      ).toBe(false);
    });
    it('an empty corpus ⇒ everything is novel', () => {
      expect(isNonDuplicate('anything at all', [])).toBe(true);
    });
  });

  describe('#4 bettable (D-006) — every proposal ships a cheap falsifiable experiment', () => {
    const good: ScoutExperiment = {
      hypothesis: 'wake-on-grant yield removes hand-retry thrash with no latency cost',
      method: 'A/B the re-queue path over 50 lock-blocks in a shadow run',
      falsifiableSignal: 'p50 edit-to-land latency regresses or hand-retries > 0',
    };
    it('a fully-substantive structured experiment passes', () => {
      expect(isBettable({ cheapExperiment: good })).toBe(true);
    });
    it('a missing falsifiable signal fails — not actually falsifiable', () => {
      expect(isBettable({ cheapExperiment: { ...good, falsifiableSignal: '' } })).toBe(false);
    });
    it.each(['', '   ', 'tbd', 'todo', 'n/a', 'ok'])('a placeholder method %j fails', (m) => {
      expect(isBettable({ cheapExperiment: { ...good, method: m } })).toBe(false);
    });
    it('a too-short hypothesis fails the substance floor', () => {
      expect('helps'.length).toBeLessThan(MIN_EXPERIMENT_FIELD_CHARS);
      expect(isBettable({ cheapExperiment: { ...good, hypothesis: 'helps' } })).toBe(false);
    });
  });

  describe('#6 no human prompt in the cycle (D-010) — Queen-gated, not human-prompted', () => {
    it('injected-LLM work with zero human input is autonomous', () => {
      expect(ranWithoutHumanPrompt({ llmCalls: 7, humanPrompts: 0 })).toBe(true);
    });
    it('any human prompt breaks autonomy', () => {
      expect(ranWithoutHumanPrompt({ llmCalls: 7, humanPrompts: 1 })).toBe(false);
    });
    it('a cycle that did no generative work is not a real autonomous cycle', () => {
      expect(ranWithoutHumanPrompt({ llmCalls: 0, humanPrompts: 0 })).toBe(false);
    });
    it('the shared fake ScoutLlmCall is the autonomy substrate (records every call, no human port)', async () => {
      const fake = makeFakeScoutLlm({ responders: [jsonResponder(() => ({ items: [] }))] });
      await fake.call({ model: 'm', messages: [{ role: 'user', content: 'ideate' }], responseFormat: 'json' });
      expect(fake.count()).toBe(1);
      expect(ranWithoutHumanPrompt({ llmCalls: fake.count(), humanPrompts: 0 })).toBe(true);
    });
  });

  describe('the real P-006 Proposal type (su-d1170) satisfies the invariants', () => {
    it('a well-formed proposal is grounded AND bettable', () => {
      const p = fixtureProposal();
      expect(isGrounded(p, refs)).toBe(true); // Proposal.addressesPatternRefs ⊆ digest refs
      expect(isBettable(p)).toBe(true); // structured cheapExperiment, all 3 sub-fields substantive
    });
    it('a proposal with an invented ref fails grounding', () => {
      expect(isGrounded(fixtureProposal({ addressesPatternRefs: ['plan:made-up'] }), refs)).toBe(false);
    });
    it('a proposal whose experiment lacks a falsifiable signal is NOT bettable', () => {
      const p = fixtureProposal({
        cheapExperiment: { hypothesis: 'it will help under load', method: 'ship it and watch', falsifiableSignal: '' },
      });
      expect(isBettable(p)).toBe(false);
    });
    it('a novel proposal passes the non-duplicate check vs an unrelated corpus', () => {
      const corpus: CorpusEntry[] = [{ ref: 'idea:x', kind: 'idea', text: 'add a MAP-Elites diversity archive to the gym' }];
      expect(isNonDuplicate(proposalNoveltyText(fixtureProposal()), corpus)).toBe(true);
    });
  });

  describe('full Scout cycle — the invariants hold over real runScoutCycle output (su-cb4b9, P-008 seam)', () => {
    const NOVELTY_CORPUS: CorpusEntry[] = [
      { ref: 'idea:gym-archive', kind: 'idea', text: 'add a MAP-Elites diversity archive over the gym candidates' },
    ];

    /**
     * A complete-cycle deps that emits one GROUNDED, BETTABLE, NOVEL proposal —
     * realistic ports (mirroring cycle.test.ts) so we assert the P-009 invariants
     * over the REAL `runScoutCycle` output, not a hand-built proposal. Every
     * LLM-touching port goes through the injected fake (the no-human-prompt
     * substrate); there is no human-input port — autonomy is structural.
     */
    function makeLiveDeps(): { deps: ScoutCycleDeps; fake: ReturnType<typeof makeFakeScoutLlm> } {
      const fake = makeFakeScoutLlm({ costUsd: 0.01 });
      const ports: ScoutCyclePorts = {
        readCorpus: async () => fixtureCorpusDigest(),
        readNoveltyCorpus: async () => NOVELTY_CORPUS,
        ideate: async (_digest, ctx) => {
          await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'ideate' }], responseFormat: 'json' });
          return fixtureIdeasAllLenses(); // grounded, spans every lens
        },
        critique: async (ins, ctx) => {
          await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'critique' }], responseFormat: 'json' });
          return ins.map(
            (idea): ScoredIdea => ({ idea, novelty: 0.82, feasibility: 0.7, noveltyMatches: [], verdict: 'keep', notes: 'novel + feasible' }),
          );
        },
        recombine: async (scored, ctx) => {
          await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'recombine' }], responseFormat: 'json' });
          return [
            {
              id: 'P-live-1',
              framing: 'agents waste turns hand-retrying lock-blocked edits under contention',
              mechanism: 'register a wake on grant + yield the turn via events:await; never spin on a held lock',
              whyNew: 'no prior plan wired wake-on-grant yield into the edit-block path; today it spins',
              bet: 'removes retry-thrash and frees the turn for other work under contention',
              cheapExperiment: {
                hypothesis: 'wake-on-grant yield removes hand-retry thrash with no added latency',
                method: 'A/B the re-queue path over 50 real lock-blocks in a shadow run',
                falsifiableSignal: 'p50 edit-to-land latency regresses, or hand-retries > 0',
              },
              sourceIdeaIds: selectSurvivors(scored).map((s) => s.idea.id),
              routeHint: 'gym',
              addressesPatternRefs: ['plan:lock-contention-2026-06-01'],
            },
          ];
        },
        route: async (proposals) =>
          proposals.map(
            (p): RoutingDecision => ({
              proposalId: p.id,
              sourceIdeaIds: [...p.sourceIdeaIds],
              rail: 'gym',
              reason: 'testable-small → gym',
              followedHint: true,
              title: p.framing,
              routedRef: `gym:${p.id}`,
            }),
          ),
      };
      return { deps: { ...ports, llmCall: fake.call }, fake };
    }

    it('every proposal the cycle emits is grounded + non-duplicate + bettable + well-formed, with NO human prompt', async () => {
      const { deps, fake } = makeLiveDeps();
      const r = await runScoutCycle(deps);

      expect(r.stop).toBe('completed');
      expect(r.proposals.length).toBeGreaterThanOrEqual(1);

      // forced diversity over the cycle's ACTUAL ideas
      expect(hasForcedDiversity(r.ideas)).toBe(true);
      expect(distinctLenses(r.ideas).size).toBe(CREATIVE_LENSES.length);

      const refs = digestRefSet(r.digest);
      for (const p of r.proposals) {
        expect(isGrounded(p, refs)).toBe(true); // refs ⊆ digest (D-003)
        expect(validateProposal(p).ok).toBe(true); // D-006 well-formed (su-d1170's gate, reused)
        expect(isBettable(p)).toBe(true); // experiment substantive (P-009's stricter check)
        expect(isNonDuplicate(proposalNoveltyText(p), NOVELTY_CORPUS)).toBe(true);
      }

      // no-human-prompt (D-010): the cycle did real generative work through the
      // injected fake LLM and there is NO human-input port (runScoutCycle takes
      // only `deps`). calls > 0 confirms it actually ran the model.
      expect(r.calls.length).toBeGreaterThan(0);
      expect(fake.count()).toBe(r.calls.length);
      expect(ranWithoutHumanPrompt({ llmCalls: r.calls.length, humanPrompts: 0 })).toBe(true);
    });

    it('the bettable invariant has teeth at the cycle level — a non-falsifiable proposal is caught', async () => {
      // GUARD (not vacuous): if a buggy recombine emitted a proposal whose
      // experiment isn't actually falsifiable, P-009 fails loudly.
      const { deps } = makeLiveDeps();
      const bad: ScoutCycleDeps = {
        ...deps,
        recombine: async (scored, ctx) => {
          await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'recombine' }], responseFormat: 'json' });
          return [
            {
              id: 'P-bad',
              framing: 'a real framing of the problem',
              mechanism: 'a plausible-sounding mechanism',
              whyNew: 'asserted novelty',
              bet: 'the upside',
              cheapExperiment: { hypothesis: 'it will help', method: 'ship it', falsifiableSignal: 'tbd' },
              sourceIdeaIds: selectSurvivors(scored).map((s) => s.idea.id),
              addressesPatternRefs: ['plan:lock-contention-2026-06-01'],
            },
          ];
        },
      };
      const r = await runScoutCycle(bad);
      expect(r.proposals.length).toBeGreaterThanOrEqual(1);
      expect(r.proposals.every(isBettable)).toBe(false); // the invariant catches the non-falsifiable experiment
    });
  });
});
