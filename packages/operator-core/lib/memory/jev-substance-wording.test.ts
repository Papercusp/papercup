import { describe, expect, it } from 'vitest';

import { SUBSTANCE_CRITERIA, SUBSTANCE_INSTRUCTIONS } from './jev-admission-request';
import { buildConflictRequest, SUBSTANCE_QUESTION_ID } from './jev-conflict-judge';
import {
  JEV_SUBSTANCE_WORDING,
  parseSubstanceWording,
  substanceQuestion,
  substanceWordingParts,
  TRIGGER_SUBSTANCE_CRITERIA,
  TRIGGER_SUBSTANCE_INSTRUCTIONS,
} from './jev-substance-wording';

describe('substance wordings', () => {
  it('v1 is exactly the P-005 wording', () => {
    expect(substanceWordingParts('v1')).toEqual({ instructions: SUBSTANCE_INSTRUCTIONS, criteria: SUBSTANCE_CRITERIA });
  });

  it('trigger keeps the v1 question and adds the quoted-trigger clause', () => {
    const { instructions, criteria } = substanceWordingParts('trigger');
    expect(instructions.startsWith(SUBSTANCE_INSTRUCTIONS)).toBe(true);
    expect(instructions).toBe(TRIGGER_SUBSTANCE_INSTRUCTIONS);
    expect(instructions).toMatch(/only quotes as the occasion to recall it/);
    expect(instructions).toMatch(/even when that quoted text reads like a fact/);
    expect(criteria).toEqual(TRIGGER_SUBSTANCE_CRITERIA);
    expect(criteria.no).toMatch(/only names the questions or topics it should be recalled for/);
  });

  it('production asks trigger (adopted by WI-10004428)', () => {
    expect(JEV_SUBSTANCE_WORDING).toBe('trigger');
  });

  it('parses the CLI flag: absent means the production wording, unknown throws', () => {
    expect(parseSubstanceWording(undefined)).toBe(JEV_SUBSTANCE_WORDING);
    expect(parseSubstanceWording('v1')).toBe('v1');
    expect(parseSubstanceWording('trigger')).toBe('trigger');
    expect(() => parseSubstanceWording('v3')).toThrow(/--substance-wording must be v1\|trigger/);
  });

  it('builds the yes/no question with the memory text after the instructions', () => {
    expect(substanceQuestion('trigger', 'M')).toEqual({
      type: 'yesNo',
      instructions: `${TRIGGER_SUBSTANCE_INSTRUCTIONS}\n\nMemory:\nM`,
      criteria: TRIGGER_SUBSTANCE_CRITERIA,
    });
  });
});

describe('buildConflictRequest substanceWording option', () => {
  const memory = 'Relevant memory: recall this whenever someone asks "the export uses ISO dates".';

  it('defaults to the production wording, and changes only the substance question', () => {
    const neighbours = [{ text: 'neighbour one' }, { text: 'neighbour two' }];
    const dflt = buildConflictRequest(memory, neighbours, { substance: true });
    const v1 = buildConflictRequest(memory, neighbours, { substance: true, substanceWording: 'v1' });
    expect(dflt.request.questions[SUBSTANCE_QUESTION_ID]).toEqual(substanceQuestion(JEV_SUBSTANCE_WORDING, memory));
    expect(v1.request.questions[SUBSTANCE_QUESTION_ID]).toEqual(substanceQuestion('v1', memory));
    expect(dflt.request.state).toEqual(v1.request.state);
    for (const id of dflt.questionIds) expect(dflt.request.questions[id]).toEqual(v1.request.questions[id]);
  });

  it('adds no substance question when substance is not asked, whatever the wording', () => {
    const r = buildConflictRequest(memory, [{ text: 'neighbour' }], { substanceWording: 'trigger' });
    expect(Object.keys(r.request.questions)).toEqual(['n1']);
  });
});
