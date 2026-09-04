/**
 * Tests for the P-018 source-span assertion (design-to-code-coverage-seam-2026-09-02).
 *
 * The load-bearing cases here are the ones where an EMPTY gap list is not good news:
 * a declared session whose transcript could not be measured produces zero gaps and zero
 * findings, and reading that as "fully spanned" would infer complete coverage from a
 * failed measurement. That is the same self-chosen-denominator defect this item closes,
 * relocated into the detector — so `isSourceSpanVerdictConclusive` is tested as a safety
 * property rather than as a getter.
 */
import { describe, expect, it } from 'vitest';

import type { ActivationAuditSourceRange } from './plan-audits';
import {
  type SessionTurnExtent,
  assertSourceSpan,
  describeSourceSpanGap,
  describeSourceSpanVerdict,
  isSourceSpanVerdictConclusive,
} from './activation-source-span';

const KIND = 'claude';
const S1 = 'session-one';
const S2 = 'session-two';

function range(fromTurn: number, toTurn: number, sessionId = S1): ActivationAuditSourceRange {
  return { sourceKind: KIND, sessionId, fromTurn, toTurn };
}

function extent(minTurn: number, maxTurn: number, sessionId = S1): SessionTurnExtent {
  return { sourceKind: KIND, sessionId, minTurn, maxTurn };
}

describe('assertSourceSpan — full coverage', () => {
  it('reports no gaps when the declared range matches the transcript exactly', () => {
    const verdict = assertSourceSpan({ sourceRanges: [range(1, 10)], extents: [extent(1, 10)] });

    expect(verdict.gaps).toEqual([]);
    expect(verdict.transcriptTurns).toBe(10);
    expect(verdict.declaredTurns).toBe(10);
    expect(verdict.gapTurns).toBe(0);
    expect(isSourceSpanVerdictConclusive(verdict)).toBe(true);
    expect(verdict.advisory).toBe(true);
  });

  it('tolerates a declared range wider than the transcript without inventing coverage', () => {
    // Over-declaring is not this detector's finding; it only measures what the transcript
    // holds, so the extra declared turns must not inflate transcriptTurns.
    const verdict = assertSourceSpan({ sourceRanges: [range(1, 999)], extents: [extent(5, 10)] });
    expect(verdict.transcriptTurns).toBe(6);
    expect(verdict.declaredTurns).toBe(6);
    expect(verdict.gaps).toEqual([]);
  });

  it('merges overlapping and unsorted ranges instead of double-counting', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(5, 10), range(1, 6)],
      extents: [extent(1, 10)],
    });
    expect(verdict.declaredTurns).toBe(10);
    expect(verdict.gaps).toEqual([]);
  });

  it('contributes nothing for an inverted range rather than throwing', () => {
    const verdict = assertSourceSpan({ sourceRanges: [range(9, 2)], extents: [extent(1, 3)] });
    expect(verdict.declaredTurns).toBe(0);
    expect(verdict.gapTurns).toBe(3);
  });
});

describe('assertSourceSpan — gap positions carry different meanings', () => {
  it('classifies a late start as a HEAD gap', () => {
    const verdict = assertSourceSpan({ sourceRanges: [range(40, 100)], extents: [extent(1, 100)] });
    expect(verdict.gaps).toEqual([
      expect.objectContaining({ position: 'head', fromTurn: 1, toTurn: 39, turnCount: 39 }),
    ]);
  });

  it('classifies an early stop as a TAIL gap — the costly one', () => {
    // Turns after the declared range are where corrections and reversals live. An audit
    // that stops early does not merely miss a requirement; it records the SUPERSEDED
    // version of one as current.
    const verdict = assertSourceSpan({ sourceRanges: [range(1, 150)], extents: [extent(1, 200)] });
    expect(verdict.gaps).toEqual([
      expect.objectContaining({ position: 'tail', fromTurn: 151, toTurn: 200, turnCount: 50 }),
    ]);
  });

  it('classifies a stretch between two declared ranges as INTERIOR', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 10), range(21, 30)],
      extents: [extent(1, 30)],
    });
    expect(verdict.gaps).toEqual([
      expect.objectContaining({ position: 'interior', fromTurn: 11, toTurn: 20, turnCount: 10 }),
    ]);
  });

  it('finds head, interior and tail gaps together and ranks TAIL first', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(10, 20), range(40, 50)],
      extents: [extent(1, 60)],
    });
    expect(verdict.gaps.map((gap) => gap.position)).toEqual(['tail', 'head', 'interior']);
    expect(verdict.gapTurns).toBe(9 + 19 + 10);
  });

  it('ranks larger gaps first within the same position', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 5), range(11, 12), range(31, 40)],
      extents: [extent(1, 40)],
    });
    const interior = verdict.gaps.filter((gap) => gap.position === 'interior');
    expect(interior.map((gap) => gap.turnCount)).toEqual([18, 5]);
  });

  it('reports a single undeclared turn as a one-turn gap', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 4), range(6, 10)],
      extents: [extent(1, 10)],
    });
    expect(verdict.gaps).toEqual([
      expect.objectContaining({ position: 'interior', fromTurn: 5, toTurn: 5, turnCount: 1 }),
    ]);
  });

  it('treats a wholly-undeclared measured session as a HEAD gap spanning it', () => {
    // runStart === minTurn wins the position test, which is the right reading: nothing
    // was declared, so the reader should see it as "started reading at the end", not as
    // an interior tangent.
    const verdict = assertSourceSpan({ sourceRanges: [range(1, 5, S2)], extents: [extent(1, 5, S2), extent(1, 8)] });
    // S1 was declared nothing at all — that is `undeclaredSessions`, not a gap.
    expect(verdict.undeclaredSessions).toEqual([`${KIND}::${S1}`]);
    expect(verdict.gaps).toEqual([]);
  });
});

describe('assertSourceSpan — multi-session accounting is per-session, not averaged', () => {
  it('keeps a fully-covered session from masking a badly-covered one', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 100), range(1, 5, S2)],
      extents: [extent(1, 100), extent(1, 100, S2)],
    });

    expect(verdict.perSession).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: S1, declaredTurns: 100, gapTurns: 0 }),
        expect.objectContaining({ sessionId: S2, declaredTurns: 5, gapTurns: 95 }),
      ]),
    );
    // The aggregate alone would read as 52% covered and hide that one session is at 5%.
    expect(verdict.declaredTurns).toBe(105);
    expect(verdict.gaps).toHaveLength(1);
    expect(verdict.gaps[0]).toMatchObject({ sessionId: S2, position: 'tail', turnCount: 95 });
  });

  it('does not confuse the same turn index across different sessions', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 3)],
      extents: [extent(1, 3), extent(1, 3, S2)],
    });
    expect(verdict.undeclaredSessions).toEqual([`${KIND}::${S2}`]);
    expect(verdict.perSession).toHaveLength(1);
  });
});

describe('isSourceSpanVerdictConclusive — an empty gap list is not automatically clean', () => {
  it('is FALSE when a DECLARED session had no measurable extent, despite zero gaps', () => {
    // THE case. Concluding "fully spanned" here would infer complete coverage from a
    // failed measurement.
    const verdict = assertSourceSpan({ sourceRanges: [range(1, 50)], extents: [] });

    expect(verdict.gaps).toEqual([]);
    expect(verdict.gapTurns).toBe(0);
    expect(verdict.unmeasuredSessions).toEqual([`${KIND}::${S1}`]);
    expect(isSourceSpanVerdictConclusive(verdict)).toBe(false);
  });

  it('stays FALSE when one of several declared sessions is unmeasured', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 10), range(1, 10, S2)],
      extents: [extent(1, 10)],
    });
    expect(verdict.gaps).toEqual([]);
    expect(verdict.unmeasuredSessions).toEqual([`${KIND}::${S2}`]);
    expect(isSourceSpanVerdictConclusive(verdict)).toBe(false);
  });

  it('is TRUE only when every declared session was measured', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 10), range(1, 10, S2)],
      extents: [extent(1, 10), extent(1, 10, S2)],
    });
    expect(verdict.unmeasuredSessions).toEqual([]);
    expect(isSourceSpanVerdictConclusive(verdict)).toBe(true);
  });

  it('an unmeasured session contributes no turns to the totals in either direction', () => {
    // It must not count as covered (inventing coverage) NOR as a gap (inventing findings).
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 10), range(1, 500, S2)],
      extents: [extent(1, 10)],
    });
    expect(verdict.transcriptTurns).toBe(10);
    expect(verdict.declaredTurns).toBe(10);
    expect(verdict.gapTurns).toBe(0);
  });

  it('is pure — repeated calls agree and inputs are not mutated', () => {
    const input = { sourceRanges: [range(1, 5)], extents: [extent(1, 10)] };
    const frozen = JSON.stringify(input);
    expect(assertSourceSpan(input)).toEqual(assertSourceSpan(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe('describeSourceSpan* — coverage is never reported without its caveat', () => {
  it('leads with the position and names the turn range', () => {
    const verdict = assertSourceSpan({ sourceRanges: [range(1, 150)], extents: [extent(1, 200)] });
    const line = describeSourceSpanGap(verdict.gaps[0]!);
    expect(line).toContain('TAIL gap');
    expect(line).toContain('turns 151-200');
    expect(line).toContain('50 undeclared');
  });

  it('renders a one-turn gap in the singular', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 4), range(6, 10)],
      extents: [extent(1, 10)],
    });
    expect(describeSourceSpanGap(verdict.gaps[0]!)).toContain('turn 5 ');
  });

  it('calls out tail gaps specifically in the summary', () => {
    const verdict = assertSourceSpan({ sourceRanges: [range(1, 150)], extents: [extent(1, 200)] });
    const line = describeSourceSpanVerdict(verdict);
    expect(line).toContain('150/200');
    expect(line).toContain('75%');
    expect(line).toContain('TAIL (where corrections live)');
    expect(line).toContain('Advisory only');
  });

  it('refuses to state a span verdict at all when nothing was measurable', () => {
    const verdict = assertSourceSpan({ sourceRanges: [range(1, 50)], extents: [] });
    const line = describeSourceSpanVerdict(verdict);
    expect(line).toContain('UNMEASURED');
    expect(line).toContain('no span claim is supported');
    // Critically, it must NOT report a percentage — 0/0 rendering as any number here
    // would be a fabricated measurement.
    expect(line).not.toMatch(/\d+%/);
  });

  it('marks a partial view when some sessions were measured and others were not', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 10), range(1, 10, S2)],
      extents: [extent(1, 10)],
    });
    const line = describeSourceSpanVerdict(verdict);
    expect(line).toContain('UNMEASURED');
    expect(line).toContain('not a span verdict');
  });

  it('names sessions that were declared nothing at all', () => {
    const verdict = assertSourceSpan({
      sourceRanges: [range(1, 3)],
      extents: [extent(1, 3), extent(1, 3, S2)],
    });
    expect(describeSourceSpanVerdict(verdict)).toContain('declared NOTHING at all');
  });
});
