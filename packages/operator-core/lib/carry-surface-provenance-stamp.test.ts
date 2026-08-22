/** The stamper's field-shaping contract (P-014 base + P-015 typed-slot lint).
 *  ownerId is withheld so the transcript legs are skipped — these tests pin
 *  the pure composition, not the IO (turn-ref.test.ts covers verification). */
import { describe, expect, it } from 'vitest';
import {
  applyOwnerTurnAutoVerify,
  carryProvenanceFields,
  mergeQuoteMismatchesIntoLint,
  retainedProvenanceText,
  stampCarrySurfaceProvenance,
} from './carry-surface-provenance-stamp';
import { lintCarrySurfaceProvenance, PROVENANCE_LINT_NOTE } from './carry-surface-provenance-lint';
import type { CurrentTurnStamp, TurnRefVerdict } from './turn-provenance/turn-ref';

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

describe('current-vs-retained provenance split (EI-21165235642497045)', () => {
  const current = 'the owner said to run the focused suite';
  const retained = 'the owner said to retain the old checkpoint';

  it('keeps current lint separate from lint found only in inherited bytes', async () => {
    const fields = await carryProvenanceFields(current, null, { retainedText: retained });

    expect(fields.provenanceLint?.matches.map((match) => match.line)).toEqual([current]);
    expect(fields.retainedProvenance?.matches.map((match) => match.line)).toEqual([retained]);
    expect(fields.retainedProvenance?.flagged).toBe(true);
  });

  it('recognizes normalized since suffixes as the supplied row, not retained history', () => {
    const stored = [
      `${retained} (since 2026-08-22T18:00:00.000Z)`,
      `${current} (since 2026-08-22T19:00:00.000Z)`,
    ].join('\n');

    expect(retainedProvenanceText(stored, current)).toBe(`${retained} (since 2026-08-22T18:00:00.000Z)`);
  });
});

describe('applyOwnerTurnAutoVerify (cold-carry-system-hardening-2026-07-19 P-005 — pure)', () => {
  const OWNER_TURN: CurrentTurnStamp = { ref: '[turn:abc123@2026-07-19T03:25:00Z]', verdict: 'owner-typed', origin: null };
  const LOOP_TURN: CurrentTurnStamp = { ref: '[turn:abc124@2026-07-19T03:30:00Z]', verdict: 'agent-injected', origin: 'loop-fire' };
  const lintOf = (text: string) => {
    const r = lintCarrySurfaceProvenance(text);
    return r.flagged ? { flagged: true as const, note: PROVENANCE_LINT_NOTE, matches: r.matches } : undefined;
  };

  it('auto-verifies manual [owner:…] tags when the current turn is owner-typed; lint clears when nothing else', () => {
    const lint = lintOf('[owner:Jane 2026-07-19 "Don\'t do the cut yet"] HOLD ruled — no cut until GO.');
    expect(lint?.matches[0].kind).toBe('manual-owner-tag');
    const out = applyOwnerTurnAutoVerify(lint, OWNER_TURN);
    expect(out.ownerTagsAutoVerified).toBe(1);
    expect(out.lint).toBeUndefined();
  });

  it('keeps non-owner-tag matches: only the manual tags are auto-verified', () => {
    const lint = lintOf(
      ['[owner:Jane 2026-07-19] the ruling', 'the owner said to ship it dark'].join('\n'),
    );
    expect(lint?.matches).toHaveLength(2);
    const out = applyOwnerTurnAutoVerify(lint, OWNER_TURN);
    expect(out.ownerTagsAutoVerified).toBe(1);
    expect(out.lint?.matches).toHaveLength(1);
    expect(out.lint?.matches[0].kind).toBe('owner-attribution');
  });

  it('a machine-injected turn auto-verifies NOTHING (the WI-3532 protection stands)', () => {
    const lint = lintOf('[owner:Jane 2026-07-19] the ruling');
    expect(applyOwnerTurnAutoVerify(lint, LOOP_TURN)).toEqual({ lint, ownerTagsAutoVerified: 0 });
    expect(applyOwnerTurnAutoVerify(lint, null)).toEqual({ lint, ownerTagsAutoVerified: 0 });
  });

  it('an OLD-dated tag is NOT auto-verified by today\'s owner turn (fold #3 — no manufactured provenance)', () => {
    const lint = lintOf('[owner:Jane 2026-07-16 "ship it dark"] standing order');
    const out = applyOwnerTurnAutoVerify(lint, OWNER_TURN); // turn date 2026-07-19
    expect(out.ownerTagsAutoVerified).toBe(0);
    expect(out.lint?.matches[0].kind).toBe('manual-owner-tag');
  });

  it('a turn ref with no parseable date verifies nothing (conservative)', () => {
    const lint = lintOf('[owner:Jane 2026-07-19] the ruling');
    const noDate: CurrentTurnStamp = { ref: '[turn:abc]', verdict: 'owner-typed', origin: null };
    expect(applyOwnerTurnAutoVerify(lint, noDate)).toEqual({ lint, ownerTagsAutoVerified: 0 });
  });

  it('clean lint passes through untouched', () => {
    expect(applyOwnerTurnAutoVerify(undefined, OWNER_TURN)).toEqual({ lint: undefined, ownerTagsAutoVerified: 0 });
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
    checked: true,
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
