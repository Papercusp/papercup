/** The stamper's field-shaping contract (P-014 base + P-015 typed-slot lint).
 *  ownerId is withheld so the transcript legs are skipped — these tests pin
 *  the pure composition, not the IO (turn-ref.test.ts covers verification). */
import { describe, expect, it } from 'vitest';
import { carryProvenanceFields, stampCarrySurfaceProvenance } from './carry-surface-provenance-stamp';

describe('stampCarrySurfaceProvenance / carryProvenanceFields', () => {
  it('clean text → undefined stamp / empty fields (no response noise)', async () => {
    expect(await stampCarrySurfaceProvenance('routine progress note', null)).toBeUndefined();
    expect(await carryProvenanceFields('routine progress note', null)).toEqual({});
  });

  it('P-015: owner-question prose → typedSlotLint field', async () => {
    const fields = await carryProvenanceFields('waiting on the owner to pick the pricing model', null);
    expect(fields.typedSlotLint?.flagged).toBe(true);
    expect(fields.typedSlotLint?.matches[0].kind).toBe('owner-question-prose');
    expect(fields.provenanceLint).toBeUndefined();
  });

  it('an [ask:…]-cited question is clean; provenance lint still fires independently', async () => {
    const clean = await carryProvenanceFields('pricing question filed [ask:conv_8f31ab2c]', null);
    expect(clean.typedSlotLint).toBeUndefined();

    const both = await carryProvenanceFields(
      ['the owner said to ship dark', 'need to ask the owner about retention'].join('\n'),
      null,
    );
    expect(both.provenanceLint?.flagged).toBe(true);
    expect(both.typedSlotLint?.flagged).toBe(true);
  });
});
