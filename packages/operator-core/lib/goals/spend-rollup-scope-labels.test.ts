/**
 * Pins the persisted breakdown's scope LABELS to the query that makes them true.
 *
 * `spentCentsBreakdown` carries `potScope`/`sessionScope` so a reader of the
 * jsonb learns what the two cent figures measure without reading this module.
 * That is only worth anything while the labels stay honest, and a label is
 * hand-written text describing a WHERE clause — exactly the code-describing
 * metadata the repo's derived-truth ladder says will drift. So it is pinned:
 * remove the session leg's goal_pots exclusion and `outside-goal-pots` becomes a
 * lie, and this test fails instead of the label quietly misdescribing the data.
 *
 * Background: EI-21970344408288271 was filed as a major bug reading potCents and
 * sessionCents as two disagreeing meters for one quantity (they are disjoint
 * partitions), concluding the spend tripwire was "a coin flip between two
 * instruments". The repair that reading suggests — enforce on the larger meter —
 * is a real regression, which is why the payload now says what it measures.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GOAL_SPEND_LINEAGE_SCOPE,
  GOAL_SPEND_POT_SCOPE,
  GOAL_SPEND_SCOPE_RELATIONS,
  GOAL_SPEND_SESSION_SCOPE,
} from './spend-rollup';

const SOURCE = readFileSync(join(__dirname, 'spend-rollup.ts'), 'utf8');

describe('goal spend breakdown — scope labels are self-describing and pinned', () => {
  it('labels each leg with its population AND its authority', () => {
    // The label has to carry both halves. "outside-goal-pots" alone still lets a
    // reader treat the bigger number as the better measurement.
    expect(GOAL_SPEND_POT_SCOPE).toBe('inside-goal-pots:authoritative');
    expect(GOAL_SPEND_SESSION_SCOPE).toBe('outside-goal-pots:diagnostic-only');
  });

  it('persists both labels into spentCentsBreakdown, not just into comments', () => {
    // The whole defect was that the caveats lived only in source. Assert they
    // reach the jsonb: the patch literal must reference both constants.
    const patch = SOURCE.slice(
      SOURCE.indexOf('spentCentsBreakdown: {'),
      SOURCE.indexOf('diagnosticUnpricedSamples'),
    );
    expect(patch).toContain('potScope: GOAL_SPEND_POT_SCOPE');
    expect(patch).toContain('sessionScope: GOAL_SPEND_SESSION_SCOPE');
  });

  it('the session leg still EXCLUDES goal-pot harnesses, so "outside-goal-pots" is true', () => {
    // The clause that makes the two legs disjoint. If this goes, the legs start
    // double-counting and both labels stop describing the data.
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      's.harness_slug IS NULL OR s.harness_slug NOT IN ( SELECT gp.harness_slug FROM harness_shared.goal_pots gp',
    );
    expect(normalized).toContain('gp.removed_at IS NULL');
  });

  it('the authoritative snapshot is still the POT leg — the labels must not outlive the rule they describe', () => {
    // `sessionScope: diagnostic-only` is a claim about enforcement, so pin
    // enforcement too: spentCents is assigned from the pot leg, never the total.
    // The pot leg is now written through the unmeasurable guard below, so the
    // assignment is the guarded form — still the pot leg, never the other two.
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('spentCents: rollup.pot.samples > 0 ? rollup.potCents : null');
    expect(normalized).not.toContain('spentCents: rollup.totalCents');
    expect(normalized).not.toContain('spentCents: rollup.sessionCents');
  });

  /*
   * WI-2146705. goalSpend() is an INNER JOIN on goal_pots, so a goal with ZERO
   * attached pots returns samples 0 / potCents 0. Writing that 0 into
   * goals.metadata.spentCents made "unmeasurable" indistinguishable from
   * "measured zero", and the budget launch gate reads a 0 as an authoritative
   * measurement — so every launch under budget was silently admitted on a
   * number nothing measured. null is the honest value: the gate's null branch
   * records a degraded reason and fails OPEN loudly.
   */
  it('never writes a spend figure the pot leg did not measure', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    // The guard must exist, and must be on the WRITE of spentCents itself —
    // not merely reported inside spentCentsBreakdown, which no gate reads.
    expect(normalized).toContain('spentCents: rollup.pot.samples > 0 ? rollup.potCents : null');
    expect(normalized).not.toContain('spentCents: rollup.potCents,');
  });

  it('keys the guard on samples, NOT measured — `measured` would regress the spend floor', () => {
    // `measured` is `samples > 0 && unpricedSamples === 0`, so keying on it also
    // nulls a PARTIALLY-PRICED pot — whose potCents judgeGoalSpend deliberately
    // enforces as a spend FLOOR (the spend-floor-goal-breach branch). Copying
    // refreshGoalTripwires' `measured ? potCents : null` verbatim here would
    // disable a live budget control, so that specific form is pinned out.
    const normalized = SOURCE.replace(/\s+/g, ' ');
    // vacuous-negative-ok: pins the budget-disabling `spentCents:` form out; the live key is measuredSpentCents
    expect(normalized).not.toContain('spentCents: rollup.pot.measured ? rollup.potCents : null');
    // The spend floor this protects must still be enforced on unmeasured spend.
    expect(normalized).toContain('spend-floor-goal-breach');
  });
});

/**
 * The THIRD scope (P-004). Its whole risk is different from the other two: pot
 * and session are DISJOINT and sum, so their danger was being read as rival
 * meters. Lineage OVERLAPS both, so its danger is the opposite — being read as
 * a third addend. These pin the non-additivity, because the moment someone sums
 * three cent figures the number is wrong and nothing complains.
 */
describe('goal spend breakdown — the lineage scope is labelled and never summed', () => {
  it('labels the lineage leg with its population AND its authority', () => {
    expect(GOAL_SPEND_LINEAGE_SCOPE).toBe('attributed-by-lineage:diagnostic-only');
  });

  it('declares the scope RELATIONS as data, so a consumer can reject an unsafe sum', () => {
    // The label alone cannot say "do not add me to the other two". This can.
    expect(GOAL_SPEND_SCOPE_RELATIONS.additive).toEqual([
      GOAL_SPEND_POT_SCOPE,
      GOAL_SPEND_SESSION_SCOPE,
    ]);
    expect(GOAL_SPEND_SCOPE_RELATIONS.overlapping).toEqual([GOAL_SPEND_LINEAGE_SCOPE]);
    // Lineage must never appear on the additive side — that is the whole rule.
    expect(GOAL_SPEND_SCOPE_RELATIONS.additive).not.toContain(GOAL_SPEND_LINEAGE_SCOPE);
  });

  it('persists the lineage label and its measured pot-overlap into spentCentsBreakdown', () => {
    const patch = SOURCE.slice(
      SOURCE.indexOf('spentCentsBreakdown: {'),
      SOURCE.indexOf('diagnosticUnpricedSamples'),
    );
    expect(patch).toContain('lineageScope: GOAL_SPEND_LINEAGE_SCOPE');
    expect(patch).toContain('scopeRelations: GOAL_SPEND_SCOPE_RELATIONS');
    // The overlap must be EMITTED, not merely asserted in a comment: it is 0
    // today only because the writer that stamps goal_id never writes
    // harness_slug, and WI-2144763 proposes changing exactly that.
    expect(patch).toContain('lineageInsidePotCents: rollup.lineageInsidePotCents');
  });

  it('keeps the lineage leg OUT of every aggregate — the non-additivity rule', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    // totalCents stays the pot+session partition.
    expect(normalized).toContain('totalCents: potCents + sessionCents');
    expect(normalized).not.toContain('totalCents: potCents + sessionCents + lineageCents');
    // `samples`/`unpricedSamples` feed `measured`, which gates tripwire
    // advancement — inflating them with an overlapping leg would corrupt a
    // control input, not just a display.
    expect(normalized).toContain('const samples = pot.samples + session.samples;');
    expect(normalized).toContain(
      'const unpricedSamples = pot.unpricedSamples + session.unpricedSamples;',
    );
    expect(normalized).not.toContain('lineage.samples;');
  });

  it('CONTROL: the source-matching instrument works, so the not.toContain pins are not vacuous', () => {
    // Every non-additivity pin above is a NEGATIVE assertion, and a negative
    // assertion passes for free if the haystack is wrong (empty source, a
    // normalization that mangles the text). A positive control that must match
    // is what separates "the bad pattern is absent" from "nothing is present".
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(SOURCE.length).toBeGreaterThan(1000);
    expect(normalized).toContain('export async function lineageSpendForGoal');
    expect(normalized).toContain('lineageCents: Math.round(lineage.costUsd * 100)');
    // And a string that must NOT be there, to show the matcher can say no.
    expect(normalized).not.toContain('this_sentinel_should_never_appear_in_spend_rollup');
  });

  it('measures the pot overlap in SQL rather than assuming it stays zero', () => {
    // A hard-coded 0 would be a claim about another writer's behaviour.
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('AS inside_pot_cost');
    expect(normalized).toContain('insidePotCostUsd: Number(r?.inside_pot_cost ?? 0)');
  });
});

/**
 * The readout half of P-004: a number attached to a KILL must say what it
 * measured. This plan is the case study — a display fallback read as a fact
 * about the world framed an entire plan and nearly funded two wrong branches.
 */
describe('goal spend readouts — ceilings, tripwires and auto-kills name their population', () => {
  it('stamps the auto-kill evidence with the scope of the number that caused it', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    // `spentCents: judged.potCents` is the pot subset. Unlabelled on a killed
    // goal it reads as "what this goal cost".
    expect(normalized).toContain('spentCentsScope: GOAL_SPEND_POT_SCOPE');
  });

  it('records WHICH denominator the ceiling was judged over', () => {
    // Lifetime vs rolling window changes what the kill means; the reader of a
    // killed goal cannot recover it from the cent figure alone.
    expect(SOURCE.replace(/\s+/g, ' ')).toContain('judgedWindowSec: windowSec');
  });

  it('carries the un-judged legs as explicitly labelled context, not bare numbers', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    // The session leg is routinely ~2x the pot leg. Present but unlabelled, it
    // makes a correct kill look like it fired on the wrong number; absent
    // entirely, an operator cannot see why the figures differ at all.
    expect(normalized).toContain('notJudged:');
    expect(normalized).toContain('sessionScope: GOAL_SPEND_SESSION_SCOPE');
    expect(normalized).toContain('lineageScope: GOAL_SPEND_LINEAGE_SCOPE');
  });

  it('appends the measured population to every generic tripwire breach reason', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('populationForMetric(b.metric)');
    expect(normalized).toContain('[measured over ${pop}]');
  });
});
