import { describe, expect, it } from 'vitest';

import {
  caveat,
  describeCaveat,
  describeRefusal,
  isRefusedAnswer,
  refuseAnswer,
  withFieldReliability,
} from './field-reliability';

describe('field-reliability — the refusal is structurally unmistakable', () => {
  it('a refusal cannot be coerced into a plausible value the way null/empty-string can', () => {
    const r = refuseAnswer({
      question: 'does the in-flight run judge a candidate containing my change?',
      because: 'the only candidate available is the checkout HEAD, re-read after the fact.',
      insteadRead: 'the inFlightRetriage marker in harness_shared.routines',
    });

    // The whole design point: the common "absence" idioms a caller reaches for to paper over a
    // missing answer must NOT produce a usable-looking value. A null/''/false would each silently
    // become a confident answer under `?? 'unknown'` / `|| 0`.
    expect(r).not.toBeNull();
    expect(typeof r).toBe('object');
    expect(String(r)).not.toMatch(/^[0-9a-f]{7,40}$/); // can never be misread as a sha
    expect(Number(r as unknown as number)).toBeNaN(); // can never be misread as a count
  });

  it('isRefusedAnswer narrows a refusal and rejects every look-alike', () => {
    const r = refuseAnswer({ question: 'q', because: 'b', insteadRead: 'i' });
    expect(isRefusedAnswer(r)).toBe(true);

    for (const lookalike of [null, undefined, 'refused', 0, false, {}, { refused: true }, { refused: 'true', question: 'q' }]) {
      expect(isRefusedAnswer(lookalike)).toBe(false);
    }
  });

  it('REQUIRES a next move — a refusal that strands the caller is not an answer', () => {
    const r = refuseAnswer({
      question: 'which sha is this run judging?',
      because: 'held_externally with no marker.',
      insteadRead: 'harness_shared.routines gate_health.inFlightRetriage',
    });
    // Typed as required; assert the rendered line actually carries it, since that is what an
    // agent reads. A refusal without `insteadRead` just relocates the confusion.
    expect(r.insteadRead).toBeTruthy();
    expect(describeRefusal(r)).toContain('Read instead:');
    expect(describeRefusal(r)).toContain('harness_shared.routines');
  });
});

describe('field-reliability — caveats', () => {
  it('renders the reliability, the unanswerable question and the alternative', () => {
    const line = describeCaveat(
      caveat({
        field: 'candidate',
        reliability: 'inferred',
        cannotAnswer: 'which sha is this run judging?',
        insteadRead: 'in_flight_retriage.refiring_candidate',
        because: 'release-checkpoint-launch.ts:686 re-reads the checkout HEAD',
      }),
    );
    expect(line).toContain('`candidate` is INFERRED, not observed');
    expect(line).toContain('which sha is this run judging?');
    expect(line).toContain('Read instead: in_flight_retriage.refiring_candidate');
    expect(line).toContain('release-checkpoint-launch.ts:686');
  });

  it('omits the parenthetical entirely when no evidence is supplied', () => {
    const line = describeCaveat(
      caveat({ field: 'elapsed_sec', reliability: 'derived', cannotAnswer: 'how long has it run?', insteadRead: 'the run lock owner' }),
    );
    expect(line).not.toContain('(');
  });
});

describe('field-reliability — withFieldReliability', () => {
  it('returns the result UNCHANGED when there are no caveats, so a clean result gains no noise', () => {
    const input = { ok: true, candidate: 'abc123' };
    const out = withFieldReliability(input, []);
    expect(out).toEqual(input);
    expect(out).not.toHaveProperty('_fieldReliability');
    expect(out).not.toHaveProperty('_fieldReliabilityWarning');
  });

  it('attaches both the structured list and a pre-rendered warning', () => {
    const out = withFieldReliability({ ok: false, candidate: 'abc123' }, [
      caveat({
        field: 'candidate',
        reliability: 'inferred',
        cannotAnswer: 'which sha is this run judging?',
        insteadRead: 'in_flight_retriage.refiring_candidate',
      }),
    ]) as { _fieldReliability: unknown[]; _fieldReliabilityWarning: string; candidate: string };

    // Structured for machines...
    expect(out._fieldReliability).toHaveLength(1);
    // ...and pre-rendered for the agent who only skims prose.
    expect(out._fieldReliabilityWarning).toContain('1 field in this result is DERIVED/INFERRED');
    expect(out._fieldReliabilityWarning).toContain('`candidate`');
    // The original payload survives — annotating is not censoring.
    expect(out.candidate).toBe('abc123');
  });

  it('pluralises and lists every caveat', () => {
    const out = withFieldReliability({ ok: true }, [
      caveat({ field: 'candidate', reliability: 'inferred', cannotAnswer: 'q1?', insteadRead: 'a1' }),
      caveat({ field: 'elapsed_sec', reliability: 'derived', cannotAnswer: 'q2?', insteadRead: 'a2' }),
    ]) as { _fieldReliabilityWarning: string };

    expect(out._fieldReliabilityWarning).toContain('2 fields in this result are DERIVED/INFERRED');
    expect(out._fieldReliabilityWarning).toContain('`candidate`');
    expect(out._fieldReliabilityWarning).toContain('`elapsed_sec`');
  });
});
