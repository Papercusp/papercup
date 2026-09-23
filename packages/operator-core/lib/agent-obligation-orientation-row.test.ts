/**
 * agent-obligation-orientation-row.test.ts — P-002 of plan
 * `turn-start-memory-two-class-2026-09-21`, the UNIFORM-ROW half.
 *
 * WHAT THIS EXISTS TO CATCH. P-002 requires a uniform row
 * `{ id, short verbatim, disposition verb, recovery pointer }`. Before this
 * change the turn-start row rendered `- [DUE] <title> — <action>` and carried
 * NEITHER the verbatim (it lives in `reason`, which the narrow `action` detail
 * drops) NOR the pointer (it lived in `action.targetRef`, which nothing
 * rendered). Three captured directives therefore rendered as three copies of
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
 *
 * Since P-004 of `owner-directive-delivery-redesign-2026-09-22` the row carries
 * NO owner text at all: D-004 forbids cutting it, a directive may run to 500
 * chars before it is summarized, and the full text already renders in the
 * ownerDirectives orientation class of the same block. So the row is a
 * reminder — { id, disposition verb, recovery pointer } — and its length no
 * longer depends on what the owner typed.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAgentObligations, formatAgentObligationLine } from './agent-obligations';
import {
  ownerDirectiveObligations,
  type OwnerDirectiveObligationRow,
  type OwnerDirectivesProviderInput,
} from './agent-obligation-providers';
import { projectAgentTurnStartObligationBrief } from './agent-obligation-reader';

const OBSERVED_AT = '2026-09-21T20:30:00.000Z';

/** The turn-start sink's real contract, restated so a silent widening fails here. */
const SINK_MAX_CHARS = 400;
const SINK_MAX_ENTRIES = 3;

function row(id: number, verbatim: string): OwnerDirectiveObligationRow {
  return {
    id,
    state: 'open',
    displayText: JSON.stringify(verbatim),
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
  it('carries id, disposition verb and recovery pointer', () => {
    const [obligation] = obligationsFor([row(27, MEDIAN)]);
    const line = formatAgentObligationLine(obligation!, 'action');

    expect(line).toContain('#27');
    expect(line).toContain('orders:disposition');
    expect(line).toContain('orders:get #27');
  });

  it('P-004 / D-004: the line carries NO fragment of the owner text, so there is nothing to cut', () => {
    const atCap = 'x'.repeat(500);
    for (const text of [SHORT, MEDIAN, atCap]) {
      const line = formatAgentObligationLine(obligationsFor([row(27, text)])[0]!, 'action');
      expect(line).not.toContain(text.slice(0, 20));
      expect(line).not.toContain('…');
      // With no text on the line the pointer is always load-bearing.
      expect(line).toContain('orders:get #27');
    }
  });

  it('keeps the owner text, uncut, in the full-detail reason', () => {
    const [obligation] = obligationsFor([row(27, MEDIAN)]);
    expect(obligation!.reason).toContain(JSON.stringify(MEDIAN));
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

  it('DELIVERS ALL THREE even at the 500-char cap — row length no longer depends on the text', () => {
    const atCap = 'y'.repeat(500);
    const brief = turnStartBody([row(27, atCap), row(28, atCap), row(29, atCap)]);

    expect(brief.projection.receipt.entriesDelivered).toBe(3);
    expect(brief.projection.text.length).toBeLessThanOrEqual(SINK_MAX_CHARS);
  });

  it('reports an omission rather than dropping a directive silently', () => {
    // A fourth directive exceeds the sink's entry cap. The contract is that the
    // projection SAYS SO, so the agent can recover the rest via detailRef
    // instead of believing it saw the whole queue.
    const brief = turnStartBody([row(27, MEDIAN), row(28, MEDIAN), row(29, MEDIAN), row(30, MEDIAN)]);

    expect(brief.projection.receipt.entriesDelivered).toBe(SINK_MAX_ENTRIES);
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
