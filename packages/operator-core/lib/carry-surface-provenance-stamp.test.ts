/** The stamper's field-shaping contract (P-014 base + P-015 typed-slot lint).
 *  ownerId is withheld so the transcript legs are skipped — these tests pin
 *  the pure composition, not the IO (turn-ref.test.ts covers verification). */
import { describe, expect, it } from 'vitest';
import { carryProvenanceFields, mergeQuoteMismatchesIntoLint, stampCarrySurfaceProvenance } from './carry-surface-provenance-stamp';
import type { TurnRefVerdict } from './turn-provenance/turn-ref';

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

describe('mergeQuoteMismatchesIntoLint (EI-12890 — pure, no IO)', () => {
  const verdict = (over: Partial<TurnRefVerdict>): TurnRefVerdict => ({
    ref: '[turn:82909092@2026-07-15T19:50:23Z]',
    found: true,
    verdict: 'owner-typed',
    origin: null,
    snippet: 'I got logged out. Continue where you left off.',
    quote: 'now get our 0.0.11 release out on all 3 platforms',
    quoteMatch: false,
    ...over,
  });

  it('no lint + no mismatches → undefined (clean case adds nothing)', () => {
    expect(mergeQuoteMismatchesIntoLint(undefined, [])).toBeUndefined();
    expect(mergeQuoteMismatchesIntoLint(undefined, [verdict({ quoteMatch: true })])).toBeUndefined();
    expect(mergeQuoteMismatchesIntoLint(undefined, [verdict({ found: false, quoteMatch: null })])).toBeUndefined();
  });

  it('a quote mismatch on its own → flagged:true with a quote-mismatch match, even with no sync lint', () => {
    const merged = mergeQuoteMismatchesIntoLint(undefined, [verdict({})]);
    expect(merged?.flagged).toBe(true);
    expect(merged?.matches).toHaveLength(1);
    expect(merged?.matches[0].kind).toBe('quote-mismatch');
    expect(merged?.matches[0].line).toContain('now get our 0.0.11 release out on all 3 platforms');
  });

  it('an existing sync-lint flag is preserved and the mismatch is appended, not dropped', () => {
    const lint = { flagged: true as const, note: 'sync note', matches: [{ line: 'the owner said ship dark', kind: 'owner-attribution' as const }] };
    const merged = mergeQuoteMismatchesIntoLint(lint, [verdict({})]);
    expect(merged?.matches).toHaveLength(2);
    expect(merged?.matches.map((m) => m.kind)).toEqual(['owner-attribution', 'quote-mismatch']);
  });

  it('sync lint alone (no mismatch) passes through unchanged', () => {
    const lint = { flagged: true as const, note: 'sync note', matches: [{ line: 'x', kind: 'bare-gate-imperative' as const }] };
    expect(mergeQuoteMismatchesIntoLint(lint, [])).toEqual(lint);
    expect(mergeQuoteMismatchesIntoLint(lint, [verdict({ quoteMatch: true })])).toEqual(lint);
  });
});
