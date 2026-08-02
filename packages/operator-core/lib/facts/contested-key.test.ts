/**
 * contested-key.test.ts — agent-epistemics-2026-08-02 P-006 (scoped by D-001).
 *
 * The detector's job is to fire at the moment an agent is about to re-pay a derivation someone
 * already paid — and, critically, to STAY SILENT otherwise. A false positive on every re-assert
 * would train agents to skim past it, which is how the previous contradiction detector's
 * successor would fail even with a working producer.
 *
 * Run: cd packages/operator-core && npx vitest run lib/facts/contested-key.test.ts
 */
import { describe, expect, it } from 'vitest';
import { assessKeyContest, type ContestChainEntry } from './contested-key';

const v = (over: Partial<ContestChainEntry> = {}): ContestChainEntry => ({
  id: 1,
  createdBy: 'su-alice',
  body: 'the gate is judging 1ee32228',
  kind: 'conclusion',
  settledBy: null,
  updatedAt: '2026-08-02T08:00:00Z',
  ...over,
});

describe('assessKeyContest — silence on the clean cases', () => {
  it('returns null for a first assert (no chain)', () => {
    expect(assessKeyContest({ chain: [], asserter: 'su-me' })).toBeNull();
  });

  it('returns null when ONE other agent wrote the key before', () => {
    // A single prior author is an ordinary update, not a dispute. Firing here would make the
    // advisory near-universal on any long-lived key and therefore ignorable.
    expect(assessKeyContest({ chain: [v({ createdBy: 'su-alice' })], asserter: 'su-me' })).toBeNull();
  });

  it('returns null when the whole chain is the asserter re-writing their OWN key', () => {
    const chain = [v({ id: 3, createdBy: 'su-me' }), v({ id: 2, createdBy: 'su-me' }), v({ id: 1, createdBy: 'su-me' })];
    expect(assessKeyContest({ chain, asserter: 'su-me' })).toBeNull();
  });

  it('counts DISTINCT authors, not versions — one author writing five times is not contested', () => {
    const chain = [1, 2, 3, 4, 5].map((id) => v({ id, createdBy: 'su-alice' }));
    expect(assessKeyContest({ chain, asserter: 'su-me' })).toBeNull();
  });
});

describe('assessKeyContest — the contested-key case (D-001 §3: threshold is 2 other authors)', () => {
  const chain = [v({ id: 3, createdBy: 'su-carol' }), v({ id: 2, createdBy: 'su-bob' }), v({ id: 1, createdBy: 'su-alice' })];

  it('fires at TWO other authors, not the drafted three', () => {
    const out = assessKeyContest({ chain: chain.slice(0, 2), asserter: 'su-me' });
    expect(out).not.toBeNull();
    expect(out!.priorAuthors).toEqual(['su-carol', 'su-bob']);
  });

  it('asks the action-relevance question rather than reporting the disagreement', () => {
    // The value is not "you disagree" — it is "would you ACT differently". A detector that only
    // announces disagreement adds a message to the argument it is trying to end.
    const out = assessKeyContest({ chain, asserter: 'su-me' })!;
    expect(out.note).toMatch(/WHAT WOULD YOU DO DIFFERENTLY/);
    expect(out.note).toMatch(/kind:"undecidable"/);
    expect(out.settledUndecidable).toBe(false);
  });

  it('excludes the asserter from the prior-author count', () => {
    // Their own earlier version is not someone else's competing answer.
    const withSelf = [v({ id: 4, createdBy: 'su-me' }), ...chain.slice(0, 1)];
    expect(assessKeyContest({ chain: withSelf, asserter: 'su-me' })).toBeNull();
  });

  it('reports the version depth alongside the authors', () => {
    const out = assessKeyContest({ chain, asserter: 'su-me' })!;
    expect(out.priorVersions).toBe(3);
    expect(out.priorAuthors).toHaveLength(3);
  });
});

describe('assessKeyContest — re-deriving a key already settled as UNDECIDABLE', () => {
  const settled = v({
    createdBy: 'su-alice',
    kind: 'undecidable',
    body: 'the judged candidate is not determinable from these fields',
    settledBy: 'the inFlightRetriage marker in harness_shared.routines',
  });

  it('fires on a SINGLE prior author when that version is undecidable', () => {
    // This is the whole P-002 -> P-006 join: one durable "we cannot know" outranks the
    // multi-author threshold, because re-deriving it is exactly what it was written to stop.
    const out = assessKeyContest({ chain: [settled], asserter: 'su-me' });
    expect(out).not.toBeNull();
    expect(out!.settledUndecidable).toBe(true);
  });

  it('quotes the recorded exit condition, so the advisory is a CHECK not a scolding', () => {
    const out = assessKeyContest({ chain: [settled], asserter: 'su-me' })!;
    expect(out.settledBy).toBe('the inFlightRetriage marker in harness_shared.routines');
    expect(out.note).toContain('the inFlightRetriage marker');
    // Overwriting IS correct once you hold the named evidence — say that, or the advisory
    // discourages the one write that closes the question.
    expect(out.note).toMatch(/If you HAVE that, this write is the right one/);
  });

  it('says so plainly when the undecidable named NO exit condition', () => {
    const out = assessKeyContest({ chain: [v({ ...settled, settledBy: null })], asserter: 'su-me' })!;
    expect(out.settledBy).toBeNull();
    expect(out.note).toMatch(/no exit condition/);
    expect(out.note).toMatch(/what do you have that the previous agent did not/);
  });

  it('does not scold an agent RE-AFFIRMING the undecidable', () => {
    // Asserting undecidable over an undecidable is agreement, not re-derivation. Treating it as
    // a violation punishes the exact behavior the record is asking for.
    const out = assessKeyContest({ chain: [settled], asserter: 'su-me', assertedKind: 'undecidable' })!;
    expect(out.note).not.toMatch(/RE-DERIVING/);
    expect(out.note).toMatch(/re-affirming it, which is fine/);
    expect(out.settledUndecidable).toBe(true);
  });

  it('fires even when the asserter is the one who settled it', () => {
    // A post-compaction successor carries the same ownerId and has lost the reasoning — it is
    // the same re-derivation, and arguably the likeliest one.
    const out = assessKeyContest({ chain: [v({ ...settled, createdBy: 'su-me' })], asserter: 'su-me' });
    expect(out).not.toBeNull();
    expect(out!.settledUndecidable).toBe(true);
    expect(out!.priorAuthors).toEqual([]);
  });

  it('prefers the undecidable message over the contested-key one when both apply', () => {
    const out = assessKeyContest({
      chain: [settled, v({ id: 2, createdBy: 'su-bob' }), v({ id: 1, createdBy: 'su-carol' })],
      asserter: 'su-me',
    })!;
    expect(out.settledUndecidable).toBe(true);
    expect(out.note).toMatch(/RE-DERIVING A SETTLED QUESTION/);
    // The author list is still reported — a settled key that THREE agents fought over first is
    // more informative than either signal alone.
    expect(out.priorAuthors).toEqual(['su-alice', 'su-bob', 'su-carol']);
  });

  it('only treats the MOST RECENT version as the settlement', () => {
    // An undecidable buried deeper in the chain was already superseded by a real answer — that
    // question is closed, and re-warning about it would resurrect a resolved dispute.
    const chain = [v({ id: 3, createdBy: 'su-bob', kind: 'conclusion' }), v({ id: 1, ...settled })];
    const out = assessKeyContest({ chain, asserter: 'su-me' });
    expect(out).toBeNull(); // one other author, and the live version is not undecidable
  });
});
