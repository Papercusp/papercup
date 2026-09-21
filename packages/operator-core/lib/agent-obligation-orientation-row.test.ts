/**
 * agent-obligation-orientation-row.test.ts — P-002 of plan
 * `turn-start-memory-two-class-2026-09-21`, the UNIFORM-ROW half.
 *
 * WHAT THIS EXISTS TO CATCH. P-002 requires a uniform row
 * `{ id, short verbatim, disposition verb, recovery pointer }`. Before this
 * change the turn-start row rendered `- [DUE] <title> — <action>` and carried
 * NEITHER the verbatim (it lives in `reason`, which the narrow `action` detail
 * drops) NOR the pointer (it lived in `action.targetRef`, which nothing
 * rendered). Three pending directives therefore rendered as three copies of
 * one 133-char sentence differing only in `#id`.
 *
 * The measured consequence was worse than "less useful": 86% of each row was
 * boilerplate identical on every row, so the 400-char sink delivered 2 of 3
 * entries and dropped the third on the character cap. Even three MINIMAL rows
 * came to 401 chars — one over budget.
 *
 * So the load-bearing property here is not "the row contains an excerpt" but
 * "the rendered row still FITS its sink". A row-content change is exactly the
 * kind of edit that silently starves this budget, which is why the assertions
 * below MEASURE rendered length against the real projector rather than
 * eyeballing the format, and why a permanent control proves the measurement
 * can fail.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAgentObligations, formatAgentObligationLine } from './agent-obligations';
import {
  ownerDirectiveObligations,
  type OwnerDirectiveObligationRow,
  type OwnerDirectivesProviderInput,
} from './agent-obligation-providers';
import { projectAgentTurnStartObligationBrief } from './agent-obligation-reader';
import { ORIENTATION_ROW_EXCERPT_CHARS, orientationRowExcerpt } from './owner-directives';

const OBSERVED_AT = '2026-09-21T20:30:00.000Z';

/** The turn-start sink's real contract, restated so a silent widening fails here. */
const SINK_MAX_CHARS = 400;
const SINK_MAX_ENTRIES = 3;

function row(id: number, excerpt: string): OwnerDirectiveObligationRow {
  return {
    id,
    state: 'pending',
    excerpt,
    recordedAt: '2026-09-21T20:00:00.000Z',
    recordedBy: 'su-c03852cb',
    capturedByHook: true,
  };
}

function obligationsFor(rows: OwnerDirectiveObligationRow[]) {
  const input: OwnerDirectivesProviderInput = {
    workspaceId: 'papercusp-workspace',
    ownerId: 'su-c03852cb',
    observedAt: OBSERVED_AT,
    sourceGeneration: 'orientation-row-test',
    read: { status: 'known', value: rows },
  };
  return ownerDirectiveObligations(input);
}

function turnStartBody(rows: OwnerDirectiveObligationRow[]) {
  const agenda = evaluateAgentObligations(obligationsFor(rows), OBSERVED_AT);
  return projectAgentTurnStartObligationBrief(agenda);
}

// A real directive from this workspace's own queue (owner directive #27).
const SHORT = 'Add to this plan filling these gaps';
// Measured 2026-09-21 over all 26 rows in harness_shared.owner_directives:
// median length 109. A median-length directive is the case that decides
// whether this sink is useful, so it is the case under test.
const MEDIAN =
  'I want a hybrid: capture every owner turn verbatim at the hook, then have the agent promote the real ones';

describe('the uniform turn-start owner-directive row', () => {
  it('carries all four P-002 elements: id, verbatim, disposition verb, recovery pointer', () => {
    const [obligation] = obligationsFor([row(27, MEDIAN)]);
    const line = formatAgentObligationLine(obligation!, 'action');

    expect(line).toContain('#27');
    expect(line).toContain(MEDIAN.slice(0, 40));
    expect(line).toContain('orders:resolve-pending');
    expect(line).toContain('orders:get #27');
  });

  it('spends the recovery pointer ONLY when text was actually budgeted away', () => {
    const whole = formatAgentObligationLine(obligationsFor([row(27, SHORT)])[0]!, 'action');
    const cut = formatAgentObligationLine(obligationsFor([row(27, MEDIAN)])[0]!, 'action');

    // Nothing to recover: the owner's whole sentence is already on the line.
    expect(whole).toContain(SHORT);
    expect(whole).not.toContain('orders:get');
    // Text WAS cut, so the pointer is load-bearing and must be present.
    expect(cut).toContain('…');
    expect(cut).toContain('orders:get #27');
  });

  it('renders the verbatim as a substring, never a paraphrase, and never a doubled ellipsis', () => {
    // An excerpt ALREADY truncated upstream by ownerDirectiveExcerpt must not
    // acquire a second ellipsis when this row re-cuts it.
    const preTruncated = `${'x'.repeat(ORIENTATION_ROW_EXCERPT_CHARS + 40)}…`;
    const line = formatAgentObligationLine(obligationsFor([row(27, preTruncated)])[0]!, 'action');

    expect(line).not.toContain('……');
    expect(line).toContain('orders:get #27');
    expect(orientationRowExcerpt(preTruncated).startsWith('x'.repeat(40))).toBe(true);
  });

  it('DELIVERS ALL THREE short directives — the regression that motivated P-002', () => {
    const brief = turnStartBody([row(27, SHORT), row(28, SHORT), row(29, SHORT)]);

    expect(brief.projection.receipt.entriesDelivered).toBe(3);
    expect(brief.projection.receipt.entriesOmitted).toBe(0);
    expect(brief.projection.receipt.bodyTruncated).toBe(false);
    // The measured body must fit the sink it claims to fit.
    expect(brief.projection.text.length).toBeLessThanOrEqual(SINK_MAX_CHARS);
    // Each directive is individually identifiable — the whole point of the row.
    for (const id of ['#27', '#28', '#29']) expect(brief.projection.text).toContain(id);
  });

  it('keeps a single rendered row inside its share of the sink budget', () => {
    const perRowBudget = Math.floor((SINK_MAX_CHARS - (SINK_MAX_ENTRIES - 1)) / SINK_MAX_ENTRIES);
    const line = formatAgentObligationLine(obligationsFor([row(27, SHORT)])[0]!, 'action');

    expect(line.length).toBeLessThanOrEqual(perRowBudget);
  });

  it('reports an omission rather than dropping a directive silently', () => {
    // Three median-length directives genuinely cannot fit 400 chars. The
    // contract is that the projection SAYS SO, so the agent can recover the
    // rest via detailRef instead of believing it saw the whole queue.
    const brief = turnStartBody([row(27, MEDIAN), row(28, MEDIAN), row(29, MEDIAN)]);

    expect(brief.projection.receipt.entriesDelivered).toBeLessThan(3);
    expect(brief.projection.receipt.entriesOmitted).toBeGreaterThan(0);
    expect(brief.detailRef).toBeTruthy();
  });

  /**
   * PERMANENT FALSIFIABILITY CONTROL. Every assertion above would also pass if
   * the budget check were vacuous — if rows were, say, always trivially short.
   * This proves the measurement has teeth by rendering the row shape that USED
   * to ship (the repeated boilerplate sentence, no excerpt) and showing the
   * sink starves on it.
   *
   * It is a locally-built string, never a mutation of the real provider, so it
   * cannot leak into the tree the way an in-tree mutation probe can.
   */
  it('CONTROL: the pre-P-002 row shape overflows the same budget', () => {
    const legacyRow = (id: number) =>
      `- [DUE] Pending owner turn awaits promote-or-dismiss — #${id} — ` +
      'promote or dismiss this captured owner turn before your next agenda step';

    const legacyBody = [27, 28, 29].map(legacyRow).join('\n');
    const currentBody = turnStartBody([row(27, SHORT), row(28, SHORT), row(29, SHORT)]).projection.text;

    // The shape this change replaced could not fit three rows...
    expect(legacyBody.length).toBeGreaterThan(SINK_MAX_CHARS);
    // ...while the shape that replaced it does.
    expect(currentBody.length).toBeLessThanOrEqual(SINK_MAX_CHARS);
    // And the legacy row carried no owner text at all, which is the defect.
    expect(legacyRow(27)).not.toContain(SHORT);
  });
});
