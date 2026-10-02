/**
 * Pins the persisted breakdown's scope LABELS to the query that makes them true.
 *
 * `spentCentsBreakdown` carries `potScope`/`sessionScope`/`lineageScope` so a
 * reader of the jsonb learns what each cent figure measures without reading this
 * module. That is only worth anything while the labels stay honest, and a label
 * is hand-written text describing a WHERE clause — exactly the code-describing
 * metadata the repo's derived-truth ladder says will drift. So it is pinned:
 * remove the session leg's goal_pots exclusion and `outside-goal-pots` becomes a
 * lie, and this test fails instead of the label quietly misdescribing the data.
 *
 * Background: EI-21970344408288271 was filed as a major bug reading potCents and
 * sessionCents as two disagreeing meters for one quantity (they are disjoint
 * partitions), concluding the spend tripwire was "a coin flip between two
 * instruments". Since D-011 (work-on-everything-stewardship-remediation) neither
 * governs: the goal_id-attributed lineage leg is the one authoritative figure.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  computeGoalSpendRollup,
  GOAL_SPEND_LINEAGE_SCOPE,
  GOAL_SPEND_POT_SCOPE,
  GOAL_SPEND_SCOPE_RELATIONS,
  GOAL_SPEND_SESSION_SCOPE,
  lineageSpendForGoal,
  sessionSpendForGoal,
} from './spend-rollup';
import { goalSpend } from '@papercusp/db-org';
import type { InteractiveUsageFreshness } from '../interactive-usage/freshness';

const SOURCE = readFileSync(join(__dirname, 'spend-rollup.ts'), 'utf8');

describe('goal spend numerator — isolated ledger arithmetic', () => {
  const opts = {
    workspaceId: 'numerator-unit',
    goalId: 'numerator-goal',
    interactiveUsageFreshness: {
      status: 'fresh', lastIngestedAtMs: 1000, ageMs: 0, windowMs: 1000,
      maxRecentIngestLagMs: 0, lagThresholdMs: 1000, lagWindowMs: 1000,
      reason: 'current fixture watermark',
    } satisfies InteractiveUsageFreshness,
  };

  const aggregate = (cost: string, samples: number) => ({
    cost, samples: String(samples), priced_samples: String(samples),
    unpriced_samples: '0', sessions: String(samples), inside_pot_cost: '0',
  });

  // These are query results, not a substitute SQL implementation. The real-PG
  // companion suite verifies which samples each query selects; these cases
  // isolate the arithmetic and authority decision with distinct populations.
  function ledgerSql(potUsd: string | null, sessionUsd: string, lineageUsd: string, lineageSamples: number): Sql {
    const query = async (strings: TemplateStringsArray) => {
      const statement = strings.join('?');
      if (statement.includes('AS inside_pot_cost')) return [aggregate(lineageUsd, lineageSamples)];
      if (statement.includes('WITH goal_owners AS')) return [aggregate(sessionUsd, Number(sessionUsd) === 0 ? 0 : 1)];
      if (statement.includes('GROUP BY s.harness_slug')) {
        return potUsd === null ? [] : [{ harness_slug: 'diagnostic-pot', ...aggregate(potUsd, 1) }];
      }
      throw new Error('Unexpected query in numerator fixture');
    };
    return query as unknown as Sql;
  }

  it('attributed-authoritative: uses lineage cents instead of the larger diagnostic partition', async () => {
    const result = await computeGoalSpendRollup(ledgerSql('1.50', '0.55', '1.05', 3), opts);
    expect(result.spentCents).toBe(105);
    expect(result.unmeasuredReason).toBeNull();
    expect(result.totalCents).toBe(205);
  });

  it('diagnostic-excluded: priced diagnostics cannot turn absent attribution into measured spend', async () => {
    const result = await computeGoalSpendRollup(ledgerSql('0.50', '0.75', '0', 0), opts);
    expect(result.spentCents).toBeNull();
    expect(result.unmeasuredReason).toBe('no-lineage-samples');
    expect(result.totalCents).toBe(125);
    expect(result.measured).toBe(true);
  });

  it('potless-attributed: priced attribution remains authoritative without any pot', async () => {
    const result = await computeGoalSpendRollup(ledgerSql(null, '1.40', '1.40', 1), opts);
    expect(result.spentCents).toBe(140);
    expect(result.unmeasuredReason).toBeNull();
    expect(result.potCents).toBe(0);
    expect(result.pot.measured).toBe(false);
  });

  it('CALIBRATION: the fixture supplies three independently distinguishable query results', async () => {
    const sql = ledgerSql('1.50', '0.55', '1.05', 3);
    expect(await goalSpend(sql, opts)).toMatchObject({ costUsd: 1.5, samples: 1 });
    expect(await sessionSpendForGoal(sql, opts)).toMatchObject({ costUsd: 0.55, samples: 1 });
    expect(await lineageSpendForGoal(sql, opts)).toMatchObject({ costUsd: 1.05, samples: 3 });
  });
});

describe('goal spend breakdown — scope labels are self-describing and pinned', () => {
  it('labels each leg with its population AND its authority', () => {
    // The label has to carry both halves. "inside-goal-pots" alone still lets a
    // reader treat that number as the goal's spend.
    expect(GOAL_SPEND_LINEAGE_SCOPE).toBe('attributed-by-lineage:authoritative');
    expect(GOAL_SPEND_POT_SCOPE).toBe('inside-goal-pots:diagnostic-only');
    expect(GOAL_SPEND_SESSION_SCOPE).toBe('outside-goal-pots:diagnostic-only');
    expect(GOAL_SPEND_SCOPE_RELATIONS.authoritative).toBe(GOAL_SPEND_LINEAGE_SCOPE);
  });

  it('persists every label into spentCentsBreakdown, not just into comments', () => {
    // The whole defect was that the caveats lived only in source. Assert they
    // reach the jsonb: the patch literal must reference the constants.
    const patch = SOURCE.slice(
      SOURCE.indexOf('spentCentsBreakdown: {'),
      SOURCE.indexOf('diagnosticUnpricedSamples'),
    );
    expect(patch).toContain('lineageScope: GOAL_SPEND_LINEAGE_SCOPE');
    expect(patch).toContain('potScope: GOAL_SPEND_POT_SCOPE');
    expect(patch).toContain('sessionScope: GOAL_SPEND_SESSION_SCOPE');
  });

  it('the session leg still EXCLUDES goal-pot harnesses, so "outside-goal-pots" is true', () => {
    // The clause that makes the two diagnostic legs disjoint. If this goes, they
    // start double-counting and both labels stop describing the data.
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      's.harness_slug IS NULL OR s.harness_slug NOT IN ( SELECT gp.harness_slug FROM harness_shared.goal_pots gp',
    );
    expect(normalized).toContain('gp.removed_at IS NULL');
  });

  it('the authoritative snapshot is the LINEAGE leg — the labels must not outlive the rule they describe', () => {
    // `potScope: diagnostic-only` is a claim about enforcement, so pin
    // enforcement too: spentCents is the rollup's lineage-derived figure, never
    // the pot leg, the session leg or the diagnostic total.
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('spentCents: unmeasuredReason === null ? lineageCents : null');
    expect(normalized).toContain('spentCents: rollup.spentCents,');
    expect(normalized).not.toContain('spentCents: rollup.potCents');
    expect(normalized).not.toContain('spentCents: rollup.totalCents');
    expect(normalized).not.toContain('spentCents: rollup.sessionCents');
  });

  /*
   * D-011 clause 3 (and WI-2146705 before it): an empty or partially-priced
   * window must never be written as a measured number. A 0 for "no samples"
   * would read as "measured zero" to the launch gate, and a priced subset of an
   * unpriced window is only a floor. null, with a named reason, is honest.
   */
  it('never writes a spend figure the lineage leg did not completely measure', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain("lineage.samples === 0 ? 'no-lineage-samples'");
    expect(normalized).toContain("lineage.unpricedSamples > 0 ? 'unpriced-lineage-samples'");
    expect(normalized).toContain('spentCentsUnmeasuredReason: rollup.unmeasuredReason');
  });

  it('still enforces a priced FLOOR that already reaches the ceiling', () => {
    // A null snapshot must not disable the ceiling when the priced portion alone
    // has crossed it — that is the spend-floor-goal-breach branch.
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('const judgedCents = rollup.spentCents ?? rollup.lineageCents;');
    expect(normalized).toContain('spend-floor-goal-breach');
  });

  it('judges ONE windowed figure: the sweep computes the rollup over the budget window', () => {
    // A lifetime figure judged against a per-window ceiling is the
    // guaranteed-termination bug (work-on-everything-goal P-004). The window is
    // applied where the rollup is computed, so the snapshot, tripwires and breach
    // check cannot disagree.
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('SELECT id, workspace_id, tripwires, created_at, budget_cents, budget_window_sec');
    expect(normalized).toContain('windowSec: g.budget_window_sec == null ? null : Number(g.budget_window_sec)');
  });
});

/**
 * Lineage OVERLAPS both diagnostic legs, so its danger is being read as a third
 * addend. These pin the non-additivity, because the moment someone sums three
 * cent figures the number is wrong and nothing complains.
 */
describe('goal spend breakdown — the lineage scope is labelled and never summed', () => {
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
    // The overlap must be EMITTED, not merely asserted in a comment.
    expect(patch).toContain('lineageInsidePotCents: rollup.lineageInsidePotCents');
  });

  it('keeps the lineage leg OUT of every diagnostic aggregate — the non-additivity rule', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    // totalCents stays the pot+session partition.
    expect(normalized).toContain('totalCents: potCents + sessionCents');
    expect(normalized).not.toContain('totalCents: potCents + sessionCents + lineageCents');
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
    expect(normalized).toContain('lineageCents = Math.round(lineage.costUsd * 100)');
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
 * The readout half of P-004: a number attached to a PAUSE must say what it
 * measured. This plan is the case study — a display fallback read as a fact
 * about the world framed an entire plan and nearly funded two wrong branches.
 */
describe('goal spend readouts — ceilings, tripwires and auto-pauses name their population', () => {
  it('stamps the auto-pause evidence with the scope of the number that caused it', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('spentCentsScope: GOAL_SPEND_LINEAGE_SCOPE');
    expect(normalized).not.toContain('spentCentsScope: GOAL_SPEND_POT_SCOPE');
  });

  it('records WHICH denominator the ceiling was judged over', () => {
    // Lifetime vs rolling window changes what the pause means; the reader of a
    // paused goal cannot recover it from the cent figure alone.
    expect(SOURCE.replace(/\s+/g, ' ')).toContain('judgedWindowSec: rollup.windowSec');
  });

  it('carries the un-judged legs as explicitly labelled context, not bare numbers', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('notJudged:');
    expect(normalized).toContain('potScope: GOAL_SPEND_POT_SCOPE');
    expect(normalized).toContain('sessionScope: GOAL_SPEND_SESSION_SCOPE');
  });

  it('appends the measured population to every generic tripwire breach reason', () => {
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('populationForMetric(b.metric)');
    expect(normalized).toContain('[measured over ${pop}]');
  });
});
