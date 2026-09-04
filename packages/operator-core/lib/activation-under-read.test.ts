/**
 * Tests for the P-017 under-read detector (design-to-code-coverage-seam-2026-09-02).
 *
 * Two things these deliberately do that a normal suite would not:
 *
 * 1. **POSITIVE CONTROLS on the patterns.** This is a lexical detector, so its dominant
 *    failure is matching NOTHING and reporting a clean verdict — which reads exactly like
 *    success. D-047 on this plan records that failure happening for real (a Postgres `\b`
 *    was BACKSPACE, so every heading regex returned 0 over a 1,750-row corpus and looked
 *    like a finding). So every signal is asserted to fire on text that should match AND
 *    stay silent on text that should not; an all-negative suite would pass against a
 *    detector that had been broken to match nothing.
 *
 * 2. **The conclusiveness predicate is tested as a SAFETY property**, not a getter. The
 *    interesting case is an empty candidate list that is NOT a clean bill of health,
 *    because the detector read less than the audit claimed. That case is the whole point
 *    of the item, and it is the one a careless reader will get wrong.
 */
import { describe, expect, it } from 'vitest';

import type { ActivationAuditMapping, ActivationAuditSourceRange } from './plan-audits';
import {
  UNDER_READ_MIN_TURN_CHARS,
  UNDER_READ_SIGNAL_PATTERNS,
  type AuditSourceTurn,
  describeUnderReadCandidate,
  describeUnderReadVerdict,
  detectUnderRead,
  isUnderReadVerdictConclusive,
  underReadSignalsOf,
} from './activation-under-read';

const KIND = 'claude';
const SESSION = 'session-abc';

function range(fromTurn: number, toTurn: number): ActivationAuditSourceRange {
  return { sourceKind: KIND, sessionId: SESSION, fromTurn, toTurn };
}

function ref(turnIdx: number, sessionId = SESSION): string {
  return `session_turn:${KIND}:${sessionId}:${turnIdx}`;
}

function map(id: string, turnIdxs: number[], sessionId = SESSION): ActivationAuditMapping {
  return {
    id,
    sourceRefs: turnIdxs.map((idx) => ref(idx, sessionId)),
    requirement: `requirement for ${id}`,
    planTargets: ['P-001'],
    disposition: 'covered',
  };
}

function turn(turnIdx: number, text: string, speaker = 'user'): AuditSourceTurn {
  return { sourceKind: KIND, sessionId: SESSION, turnIdx, speaker, text };
}

/** Long enough to clear UNDER_READ_MIN_TURN_CHARS, with no signal words in it. */
const INERT = 'the quick brown fox jumped over the lazy dog again today';

describe('underReadSignalsOf — every pattern has a positive control', () => {
  // A detector that matches nothing looks identical to a clean corpus. These are the
  // assertions that tell those apart; see the file header.
  const positives: Array<[string, string]> = [
    ['requirement', 'the completion payload must resolve every cited path'],
    ['constraint', 'it should never double-write the same clause row'],
    ['correction', 'actually, use the census plan for that instead of forking it'],
    ['decision', "let's go with the frozen candidate rather than re-cutting at tip"],
    ['open-question', 'do we want the detector to gate the audit or only report?'],
  ];

  for (const [signal, text] of positives) {
    it(`fires '${signal}' on representative authoring language`, () => {
      expect(underReadSignalsOf(text)).toContain(signal);
    });
  }

  it('every declared pattern is exercised by a positive control above', () => {
    // Guards against adding a pattern with no control — which would reintroduce exactly
    // the silent-no-match hole this block exists to close.
    const covered = new Set(positives.map(([signal]) => signal));
    for (const { signal } of UNDER_READ_SIGNAL_PATTERNS) {
      expect(covered.has(signal)).toBe(true);
    }
  });

  it('stays silent on inert prose of the same length', () => {
    expect(underReadSignalsOf(INERT)).toEqual([]);
  });

  it('ignores a turn shorter than the minimum, which is an ack rather than a requirement', () => {
    expect('yes do that'.length).toBeLessThan(UNDER_READ_MIN_TURN_CHARS);
    expect(underReadSignalsOf('yes do that')).toEqual([]);
  });

  it('reports several signals when a turn carries several', () => {
    const signals = underReadSignalsOf(
      'actually it must never re-cut the candidate at tip — should we freeze instead?',
    );
    expect(signals).toEqual(expect.arrayContaining(['constraint', 'requirement', 'correction']));
    expect(signals.length).toBeGreaterThan(2);
  });

  it('returns signals in the declared pattern order, so output is stable', () => {
    const signals = underReadSignalsOf('you must never do that, so we will pick the other one');
    const declaredOrder = UNDER_READ_SIGNAL_PATTERNS.map((entry) => entry.signal);
    const positions = signals.map((signal) => declaredOrder.indexOf(signal));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('only treats a TRAILING question mark as an open question', () => {
    expect(underReadSignalsOf('what about the frozen candidate handling here?')).toContain(
      'open-question',
    );
    // A mid-sentence question mark inside a longer statement is not an open question.
    expect(
      underReadSignalsOf('the "why?" comment in that file is stale and needs rewriting now'),
    ).not.toContain('open-question');
  });
});

describe('detectUnderRead — the diff between declared and cited', () => {
  it('flags an uncited signal-bearing turn inside a declared range', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 3)],
      mappings: [map('M-001', [1])],
      turns: [
        turn(1, 'the audit must record its own revision'),
        turn(2, 'it should never clobber a refined clause'),
        turn(3, INERT),
      ],
    });

    expect(verdict.declaredTurns).toBe(3);
    expect(verdict.suppliedTurns).toBe(3);
    expect(verdict.unsuppliedTurns).toBe(0);
    expect(verdict.citedTurns).toBe(1);
    expect(verdict.uncitedTurns).toBe(2);
    expect(verdict.candidates.map((c) => c.ref)).toEqual([ref(2)]);
    expect(verdict.advisory).toBe(true);
  });

  it('does NOT flag an uncited turn that carries no signal', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 2)],
      mappings: [map('M-001', [1])],
      turns: [turn(1, 'the audit must record its revision'), turn(2, INERT)],
    });
    expect(verdict.uncitedTurns).toBe(1);
    expect(verdict.candidates).toEqual([]);
  });

  it('counts a cited turn as covered even when it is loud with signals', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 1)],
      mappings: [map('M-001', [1])],
      turns: [turn(1, 'it must never do that, so actually we will pick the other approach')],
    });
    expect(verdict.citedTurns).toBe(1);
    expect(verdict.candidates).toEqual([]);
  });

  it('ranks candidates by signal count, then by ref for a total order', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 3)],
      mappings: [],
      turns: [
        turn(1, 'the payload should carry the revision identifier with it'),
        turn(2, 'actually it must never re-cut at tip; we will freeze instead'),
        turn(3, 'the resolver should reject an unknown target reference'),
      ],
    });
    expect(verdict.candidates[0]?.ref).toBe(ref(2));
    expect(verdict.candidates[0]!.signals.length).toBeGreaterThan(
      verdict.candidates[1]!.signals.length,
    );
    // Ties break on ref, so repeated runs are diffable.
    expect(verdict.candidates.slice(1).map((c) => c.ref)).toEqual([ref(1), ref(3)]);
  });

  it('scopes strictly to DECLARED turns — a supplied turn outside every range is ignored', () => {
    // Counting it would inflate the denominator with turns the audit never claimed.
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 2)],
      mappings: [],
      turns: [
        turn(1, 'the gate must refuse an unresolvable citation'),
        turn(99, 'this one should never appear in the verdict at all'),
      ],
    });
    expect(verdict.declaredTurns).toBe(2);
    expect(verdict.suppliedTurns).toBe(1);
    expect(verdict.candidates.map((c) => c.ref)).toEqual([ref(1)]);
  });

  it('keeps different sessions distinct at the same turn index', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 1)],
      mappings: [map('M-001', [1], 'a-different-session')],
      turns: [turn(1, 'this turn must be reported as uncited')],
    });
    // The mapping cites turn 1 of ANOTHER session, so this session's turn 1 is uncited.
    expect(verdict.citedTurns).toBe(0);
    expect(verdict.candidates.map((c) => c.ref)).toEqual([ref(1)]);
  });

  it('treats ranges as inclusive at both ends', () => {
    const verdict = detectUnderRead({ sourceRanges: [range(4, 6)], mappings: [], turns: [] });
    expect(verdict.declaredTurns).toBe(3);
  });

  it('contributes nothing for an inverted range rather than throwing', () => {
    // A malformed range is the audit tool's problem to report; this advisory read must
    // not be the thing that fails on it.
    const verdict = detectUnderRead({ sourceRanges: [range(9, 2)], mappings: [], turns: [] });
    expect(verdict.declaredTurns).toBe(0);
    expect(verdict.candidates).toEqual([]);
  });

  it('de-duplicates overlapping ranges instead of double-counting the denominator', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 5), range(3, 7)],
      mappings: [],
      turns: [],
    });
    expect(verdict.declaredTurns).toBe(7);
  });

  it('reports a citation that falls outside every declared range', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 2)],
      mappings: [map('M-001', [1, 42])],
      turns: [turn(1, INERT)],
    });
    expect(verdict.citedOutsideRanges).toEqual([{ mappingId: 'M-001', ref: ref(42) }]);
  });

  it('ignores an unparseable sourceRef — ref VALIDITY is the audit tool s gate, not this one s', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 1)],
      mappings: [{ ...map('M-001', []), sourceRefs: ['not-a-turn-ref'] }],
      turns: [turn(1, 'this turn must still be reported as uncited')],
    });
    expect(verdict.citedOutsideRanges).toEqual([]);
    expect(verdict.candidates).toHaveLength(1);
  });

  it('is pure — the same input yields the same verdict and inputs are not mutated', () => {
    const input = {
      sourceRanges: [range(1, 2)],
      mappings: [map('M-001', [1])],
      turns: [turn(1, INERT), turn(2, 'the writer must never drop a skip reason')],
    };
    const frozen = JSON.stringify(input);
    expect(detectUnderRead(input)).toEqual(detectUnderRead(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe('isUnderReadVerdictConclusive — an empty candidate list is not automatically clean', () => {
  it('is FALSE when the detector read less than the audit declared, even with zero candidates', () => {
    // THE case this item exists for. 2 of 100 turns supplied, nothing flagged — reading
    // that as "no gaps" is the self-chosen-denominator failure moved into the detector.
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 100)],
      mappings: [map('M-001', [1])],
      turns: [turn(1, INERT), turn(2, INERT)],
    });

    expect(verdict.candidates).toEqual([]);
    expect(verdict.unsuppliedTurns).toBe(98);
    expect(isUnderReadVerdictConclusive(verdict)).toBe(false);
  });

  it('is TRUE only when every declared turn was actually supplied', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 2)],
      mappings: [map('M-001', [1, 2])],
      turns: [turn(1, INERT), turn(2, INERT)],
    });
    expect(verdict.unsuppliedTurns).toBe(0);
    expect(isUnderReadVerdictConclusive(verdict)).toBe(true);
  });

  it('counts a duplicate supplied turn once, so duplicates cannot fake full coverage', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 3)],
      mappings: [],
      turns: [turn(1, INERT), turn(1, INERT), turn(1, INERT)],
    });
    expect(verdict.suppliedTurns).toBe(1);
    expect(verdict.unsuppliedTurns).toBe(2);
    expect(isUnderReadVerdictConclusive(verdict)).toBe(false);
  });
});

describe('describeUnderRead* — a count is never reported without its denominator', () => {
  it('says the verdict is a FLOOR when coverage was partial', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 50)],
      mappings: [],
      turns: [turn(1, 'the store must refuse an unknown plan item')],
    });
    const line = describeUnderReadVerdict(verdict);
    expect(line).toContain('1 of 50 declared turn(s)');
    expect(line).toContain('FLOOR');
    expect(line).toContain('Advisory only');
  });

  it('says so plainly when coverage was complete', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 2)],
      mappings: [map('M-001', [1, 2])],
      turns: [turn(1, INERT), turn(2, INERT)],
    });
    const line = describeUnderReadVerdict(verdict);
    expect(line).toContain('all 2 declared turn(s)');
    expect(line).not.toContain('FLOOR');
  });

  it('surfaces out-of-range citations in the summary', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 1)],
      mappings: [map('M-001', [1, 77])],
      turns: [turn(1, INERT)],
    });
    expect(describeUnderReadVerdict(verdict)).toContain('outside every declared range');
  });

  it('renders a candidate with its ref, speaker, signals and excerpt', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 1)],
      mappings: [],
      turns: [turn(1, 'the deriver must never invent a falsifier', 'user')],
    });
    const line = describeUnderReadCandidate(verdict.candidates[0]!);
    expect(line).toContain(ref(1));
    expect(line).toContain('[user]');
    expect(line).toContain('constraint');
    expect(line).toContain('must never invent a falsifier');
  });

  it('elides a long excerpt and collapses whitespace so a report stays one line per entry', () => {
    const verdict = detectUnderRead({
      sourceRanges: [range(1, 1)],
      mappings: [],
      turns: [turn(1, `it must never ${'wander '.repeat(60)}stop`)],
    });
    const candidate = verdict.candidates[0]!;
    expect(candidate.excerpt.length).toBeLessThanOrEqual(160);
    expect(candidate.excerpt.endsWith('...')).toBe(true);
    expect(describeUnderReadCandidate(candidate).split('\n')).toHaveLength(1);
  });
});
