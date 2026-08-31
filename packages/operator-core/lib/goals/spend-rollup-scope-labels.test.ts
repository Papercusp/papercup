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
import { GOAL_SPEND_POT_SCOPE, GOAL_SPEND_SESSION_SCOPE } from './spend-rollup';

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
    const normalized = SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('spentCents: rollup.potCents');
    expect(normalized).not.toContain('spentCents: rollup.totalCents');
    expect(normalized).not.toContain('spentCents: rollup.sessionCents');
  });
});
