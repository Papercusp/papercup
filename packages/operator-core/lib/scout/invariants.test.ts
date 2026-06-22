/**
 * invariants — example-based coverage for the Scout-loop predicates the PROPERTY
 * suite (invariants.property.test.ts) does not exercise: proposalNoveltyText,
 * ranWithoutHumanPrompt (#6 / D-010), and isNonDuplicate (#3 / D-005). The other
 * predicates (grounded / forced-diversity / bettable) are IFF-tested there.
 */
import { describe, it, expect } from 'vitest';
import { proposalNoveltyText, ranWithoutHumanPrompt, isNonDuplicate } from './invariants';

describe('proposalNoveltyText', () => {
  it('joins framing + mechanism (the "haven\'t we tried this?" surface), trimmed', () => {
    expect(proposalNoveltyText({ framing: 'cut spawn latency', mechanism: 'pool the PG handles' })).toBe(
      'cut spawn latency pool the PG handles',
    );
  });

  it('trims when one half is empty (no leading/trailing space)', () => {
    expect(proposalNoveltyText({ framing: '', mechanism: 'just the mechanism' })).toBe('just the mechanism');
    expect(proposalNoveltyText({ framing: 'only framing', mechanism: '' })).toBe('only framing');
  });
});

describe('ranWithoutHumanPrompt (#6 / D-010)', () => {
  it('true IFF the cycle did generative work (llmCalls>0) AND prompted no human (humanPrompts===0)', () => {
    expect(ranWithoutHumanPrompt({ llmCalls: 5, humanPrompts: 0 })).toBe(true);
    expect(ranWithoutHumanPrompt({ llmCalls: 0, humanPrompts: 0 })).toBe(false); // no generative work → not a real cycle
    expect(ranWithoutHumanPrompt({ llmCalls: 5, humanPrompts: 1 })).toBe(false); // a human was prompted
    expect(ranWithoutHumanPrompt({ llmCalls: 0, humanPrompts: 3 })).toBe(false);
  });
});

describe('isNonDuplicate (#3 / D-005)', () => {
  it('a text against an EMPTY corpus is non-duplicate (nothing to collide with → novelty 1, not alreadyTried)', () => {
    expect(isNonDuplicate('a genuinely fresh idea about handle pooling', [])).toBe(true);
  });

  it('the noveltyFloor gates: even maximal novelty is a "duplicate" below an impossible floor (pins the floor branch)', () => {
    // corpusNovelty caps novelty at 1.0; a floor of 1.1 can never be met → always rejected as too-close.
    expect(isNonDuplicate('a genuinely fresh idea about handle pooling', [], { noveltyFloor: 1.1 })).toBe(false);
  });
});
