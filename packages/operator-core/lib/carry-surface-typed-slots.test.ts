/** P-015 (deterministic-context-carry) — owner-blocking questions must be
 *  coord:ask-owner records: the typed-slot lint. */
import { describe, expect, it } from 'vitest';
import {
  lintOwnerQuestionSlots,
  ownerQuestionSlotField,
  OWNER_QUESTION_SLOT_NOTE,
} from './carry-surface-typed-slots';

describe('lintOwnerQuestionSlots', () => {
  it('is clean on empty / null / ordinary progress prose', () => {
    expect(lintOwnerQuestionSlots('')).toEqual({ flagged: false, matches: [] });
    expect(lintOwnerQuestionSlots(null)).toEqual({ flagged: false, matches: [] });
    expect(
      lintOwnerQuestionSlots('Finished the migration; 12/12 tests green; docs update next wake.').flagged,
    ).toBe(false);
  });

  it('flags "need to ask the owner" / "question for the owner" prose', () => {
    const r = lintOwnerQuestionSlots('need to ask the owner whether the beta page ships this cut');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('owner-question-prose');
    expect(lintOwnerQuestionSlots('question for the owner: keep the legacy route?').flagged).toBe(true);
  });

  it('flags blocked-on-owner-answer shapes', () => {
    expect(lintOwnerQuestionSlots('waiting on the owner to pick the pricing model').flagged).toBe(true);
    expect(lintOwnerQuestionSlots("blocked on owner's decision about the schema split").flagged).toBe(true);
    expect(lintOwnerQuestionSlots("needs the owner's approval before the force-push").flagged).toBe(true);
  });

  it('an [ask:<conversation_id>] ref on the line CLEARS it — the question is a typed record', () => {
    expect(
      lintOwnerQuestionSlots('waiting on the owner to pick the pricing model [ask:conv_8f31ab2c]').flagged,
    ).toBe(false);
  });

  it('a wall marker clears the line — the walls slot is also typed', () => {
    expect(
      lintOwnerQuestionSlots('⚠ OWNER-WALL: capital arming needs the owner\'s approval (loop walls row)').flagged,
    ).toBe(false);
  });

  it('is LINE-scoped: an ask ref on one line does not clear a different untyped question', () => {
    const text = [
      'pricing question filed [ask:conv_8f31ab2c]',
      'also need to ask the owner about the retention window',
    ].join('\n');
    const r = lintOwnerQuestionSlots(text);
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].line).toContain('retention window');
  });

  it('does NOT flag plain owner mentions (provenance lint\'s beat, not this one)', () => {
    expect(lintOwnerQuestionSlots('the owner said to ship dark').flagged).toBe(false);
    expect(lintOwnerQuestionSlots('owner-directed AUTO mode stays active').flagged).toBe(false);
  });

  it('caps matches at 5 and truncates long lines to 200 chars', () => {
    const many = Array.from({ length: 8 }, (_, i) => `need to ask the owner about item ${i}`).join('\n');
    expect(lintOwnerQuestionSlots(many).matches).toHaveLength(5);
    const long = 'need to ask the owner about ' + 'x'.repeat(400);
    expect(lintOwnerQuestionSlots(long).matches[0].line.length).toBe(200);
  });
});

describe('ownerQuestionSlotField', () => {
  it('undefined on clean; { flagged, note, matches } when flagged', () => {
    expect(ownerQuestionSlotField('routine note')).toBeUndefined();
    const f = ownerQuestionSlotField('waiting for owner input on the cut date');
    expect(f?.flagged).toBe(true);
    expect(f?.note).toBe(OWNER_QUESTION_SLOT_NOTE);
    expect(f?.matches.length).toBe(1);
  });
});
