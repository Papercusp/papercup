/**
 * ./scope-residue — the zero-hit residue disclosure, and the bijection guard
 * that keeps it from rotting.
 *
 * ⚠ THIS FILE DELIBERATELY DOES NOT MOCK `./sources`. Its sibling
 * prose-handlers.test.ts replaces the registry with 7 minimal stand-ins to
 * isolate handler shaping — correct there, and fatal here: the whole point of
 * the bijection test below is to fail when the REAL registry gains a source
 * nobody described. Run against a stand-in registry it would pass forever while
 * the live tool emitted `(no corpus description registered for '<name>')`.
 */

import { describe, expect, it } from 'vitest';
import { SEARCH_SOURCES } from './sources';
import { SOURCE_CORPUS, scopeResidue } from './scope-residue';

describe('SOURCE_CORPUS is bijective with the real SEARCH_SOURCES registry', () => {
  // THE ANTI-ROT MECHANISM. The defect this whole module fixes
  // (EI-20838436704308881) exists because the previous fix hard-coded ONE
  // source name, so it silently stopped covering the registry the moment a
  // source was added. Deriving `not_searched` FROM the registry fixes the list;
  // this pair of assertions is what fixes the DESCRIPTIONS, which are the only
  // half a human still has to write.
  //
  // Each guard is stated as a PREDICATE and then run twice: once against the
  // live registry (must be clean) and once against a synthetic registry that is
  // deliberately broken (must be caught). A guard that has only ever been run
  // against a passing input is a guard nobody has tested — and the in-tree
  // mutation that would otherwise prove it can be committed by the git-sync
  // sweep mid-run, so the known-bad input lives here permanently instead.
  const undescribedIn = (names: readonly string[]) => names.filter((n) => !SOURCE_CORPUS[n]);
  const staleAgainst = (names: readonly string[]) => {
    const live = new Set(names);
    return Object.keys(SOURCE_CORPUS).filter((k) => !live.has(k));
  };
  const liveNames = () => SEARCH_SOURCES.map((s) => s.name);

  it('every registered source has a corpus description', () => {
    const undescribed = undescribedIn(liveNames());
    expect(undescribed, `add these to SOURCE_CORPUS in ./scope-residue.ts: ${undescribed.join(', ')}`)
      .toEqual([]);
  });

  it('CALIBRATION: that guard DETECTS a source added without a description', () => {
    expect(undescribedIn([...liveNames(), 'newly_added_source'])).toEqual(['newly_added_source']);
  });

  it('has no descriptions for sources that no longer exist', () => {
    const stale = staleAgainst(liveNames());
    expect(stale, `remove these stale SOURCE_CORPUS rows: ${stale.join(', ')}`).toEqual([]);
  });

  it('CALIBRATION: that guard DETECTS a description left behind by a removed source', () => {
    expect(staleAgainst(liveNames().filter((n) => n !== 'turns'))).toEqual(['turns']);
  });
});

describe('the two confusable transcript corpora disambiguate each other', () => {
  // NOT decoration, and not a spelling test: `turns` vs `session_turn` is the
  // specific pair that produced EI-20838436704308881 (and cost a MAJOR filing
  // proposing to delete a working 25,774-row search scope). `turns` reads as
  // the generic "search the turns" choice AND sits in DEFAULT_SCOPE, while the
  // transcript corpus an agent almost always wants is `session_turn`. A generic
  // one-liner on either row would let that trap go unmarked again.
  it("`turns` names the operator chat and points at session_turn", () => {
    expect(SOURCE_CORPUS.turns).toMatch(/OPERATOR CHAT/);
    expect(SOURCE_CORPUS.turns).toMatch(/session_turn/);
  });

  it('`session_turn` names the agent transcripts and points at turns', () => {
    expect(SOURCE_CORPUS.session_turn).toMatch(/AGENT SESSION TRANSCRIPTS/);
    expect(SOURCE_CORPUS.session_turn).toMatch(/'turns'/);
  });
});

describe('scopeResidue', () => {
  it('reproduces the filed defect: a `turns`-only search is told session_turn was never queried', () => {
    // The EXACT shape of EI-20838436704308881. The reporter searched
    // scope:['turns'] for a phrase that lived in a claude session transcript,
    // got a clean zero, and concluded the scope matched nothing.
    const residue = scopeResidue(['turns']);
    expect(residue).not.toBeNull();

    const names = residue!.not_searched.map((r) => r.scope);
    expect(names).toContain('session_turn');
    expect(names).not.toContain('turns');
    expect(residue!.searched).toEqual(['turns']);

    const sessionRow = residue!.not_searched.find((r) => r.scope === 'session_turn')!;
    expect(sessionRow.holds).toMatch(/AGENT SESSION TRANSCRIPTS/);
    expect(residue!.caveat).toMatch(/NOT AN ABSENCE CLAIM/);
  });

  it('CALIBRATION: a search covering every corpus gets NO residue', () => {
    // The control that keeps the assertions above honest. Without it, a
    // `scopeResidue` that returned a caveat unconditionally — the failure mode
    // where a warning stops carrying information because it is always present —
    // would satisfy every other test in this file.
    expect(scopeResidue(SEARCH_SOURCES.map((s) => s.name))).toBeNull();
  });

  it('counts the residue against the real registry size, not a hard-coded total', () => {
    const residue = scopeResidue(['turns'])!;
    expect(residue.not_searched).toHaveLength(SEARCH_SOURCES.length - 1);
    expect(residue.caveat).toContain(`1 of ${SEARCH_SOURCES.length} corpora`);
  });

  it('never describes a source as undescribed (the degraded-row fallback stays unreached)', () => {
    // Pairs with the bijection guard from the other direction: that one proves
    // the map is complete, this one proves the RENDERED rows never expose the
    // fallback string to a caller.
    for (const name of SEARCH_SOURCES.map((s) => s.name)) {
      const residue = scopeResidue(SEARCH_SOURCES.map((s) => s.name).filter((n) => n !== name))!;
      expect(residue.not_searched[0].holds).not.toMatch(/no corpus description registered/);
    }
  });
});
