/**
 * assumptions.test.ts — P-008 (d) / D-050 / D-079.
 *
 * Covers the PURE halves (parsing, selector precedence, the refusal message) and
 * the condition classification, which is the part D-050 explicitly deferred to
 * P-008 and therefore the part a regression would silently change.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSUMPTION_CONDITIONS,
  assumptionSelectorsFor,
  basisHasMoved,
  BASIS_MOVEMENTS,
  classifyBasisMovement,
  danglingAssumptionsMessage,
  isComparableAtDeclaration,
  isDanglingCondition,
  parseAssumptionRef,
  resolveAssumptions,
  wasStaleAtDeclaration,
  type DeclaredBasisRow,
} from './assumptions';

describe('parseAssumptionRef', () => {
  it('treats a plain slug as a bare key', () => {
    expect(parseAssumptionRef('gate-red-is-flake')).toEqual({
      raw: 'gate-red-is-flake',
      key: 'gate-red-is-flake',
      scope: null,
      scopeRef: null,
      versionId: null,
      absolute: false,
    });
  });

  it('parses a workspace-scoped absolute ref (no scopeRef segment)', () => {
    expect(parseAssumptionRef('fact:workspace:my-key')).toMatchObject({
      key: 'my-key',
      scope: 'workspace',
      scopeRef: null,
      versionId: null,
      absolute: true,
    });
  });

  it('parses a scoped absolute ref with a version pin', () => {
    expect(parseAssumptionRef('fact:owner:su-8d9a6:gate-red@v3317')).toMatchObject({
      key: 'gate-red',
      scope: 'owner',
      scopeRef: 'su-8d9a6',
      versionId: 3317,
      absolute: true,
    });
  });

  it('keeps colons inside a scopeRef, splitting the KEY off the last colon', () => {
    // A harness/role ref may contain colons; a facts:assert key is a slug and does not.
    expect(parseAssumptionRef('fact:harness:pot:papercusp:some-key')).toMatchObject({
      scope: 'harness',
      scopeRef: 'pot:papercusp',
      key: 'some-key',
    });
  });

  /**
   * The important negative case: an entry that REACHES for the absolute grammar
   * and mistypes it must be reported, not silently demoted to a bare key whose
   * "key" is the whole malformed string — that would dangle with a baffling
   * message naming a key the caller never meant to write.
   */
  it.each([
    ['fact:', 'no scope at all'],
    ['fact:nonsense:k', 'unknown scope'],
    ['fact:owner:onlyref', 'scoped ref with no key segment'],
    ['fact:owner:su-1:k@v0', 'non-positive version'],
    ['fact:owner:su-1:k@vabc', 'non-numeric version'],
  ])('rejects a malformed absolute ref: %s (%s)', (raw) => {
    expect(parseAssumptionRef(raw)).toBeNull();
  });

  it('does not mistake a bare key that merely CONTAINS "fact" for a ref', () => {
    expect(parseAssumptionRef('artifact-is-stale')).toMatchObject({ absolute: false, key: 'artifact-is-stale' });
  });
});

describe('assumptionSelectorsFor', () => {
  it('orders selectors most-specific-first and always ends at workspace', () => {
    const sels = assumptionSelectorsFor({
      workItemId: 'WI-6330',
      ownerId: 'su-8d9a6',
      role: 'engineer',
      harnessSlug: 'papercusp',
    });
    expect(sels.map((s) => s.scope)).toEqual(['work_item', 'owner', 'role', 'harness', 'workspace']);
  });

  it('skips dimensions with no ref rather than emitting an unresolvable selector', () => {
    const sels = assumptionSelectorsFor({ ownerId: 'su-8d9a6' });
    expect(sels.map((s) => s.scope)).toEqual(['owner', 'workspace']);
  });

  it('always includes workspace even with no context at all', () => {
    expect(assumptionSelectorsFor({})).toEqual([{ scope: 'workspace', scopeRef: null }]);
  });
});

describe('D-079 R3 — what refuses', () => {
  it('refuses ONLY total non-existence', () => {
    const refusing = ASSUMPTION_CONDITIONS.filter(isDanglingCondition);
    expect(refusing).toEqual(['dangling']);
  });

  /**
   * The distinction that keeps a PG blip from blocking every terminal close in
   * the fleet: "the ledger says this key does not exist" (refuse) is not "the
   * ledger could not be consulted" (proceed, and record that it was not checked).
   */
  it('does NOT refuse when the ledger could not be read', () => {
    expect(isDanglingCondition('unresolved')).toBe(false);
    expect(ASSUMPTION_CONDITIONS).toContain('unresolved');
  });

  it('fails OPEN to unresolved when the fact read throws', async () => {
    const exploding = (() => {
      throw new Error('connection refused');
    }) as unknown as Parameters<typeof resolveAssumptions>[3];
    const out = await resolveAssumptions(['some-key'], assumptionSelectorsFor({ ownerId: 'su-1' }), {}, exploding);
    expect(out).toHaveLength(1);
    expect(out[0].condition).toBe('unresolved');
    expect(out[0].key).toBe('some-key');
    // Still persisted, so an audit can tell WHICH closes were never checked.
    expect(out[0].declared).toBe('some-key');
  });

  it('still refuses a MALFORMED absolute ref, which needs no ledger read at all', async () => {
    const out = await resolveAssumptions(['fact:nonsense:k'], assumptionSelectorsFor({ ownerId: 'su-1' }), {});
    expect(out[0].condition).toBe('dangling');
  });

  /**
   * The load-bearing assertion of D-079 R3, stated so a future change that makes
   * expiry refuse fails HERE with the reason attached rather than silently
   * turning a six-hour TTL into a closure blocker.
   */
  it('resolves lapsed / superseded / retracted rather than refusing them', () => {
    for (const c of ['live', 'lapsed', 'superseded', 'retracted'] as const) {
      expect(isDanglingCondition(c)).toBe(false);
    }
  });
});

describe('danglingAssumptionsMessage', () => {
  const selectors = assumptionSelectorsFor({ workItemId: 'WI-1', ownerId: 'su-1', harnessSlug: 'papercusp' });

  it('names the offending entries and the scopes actually searched', () => {
    const msg = danglingAssumptionsMessage(
      [{ declared: 'ghost-key', ref: null, key: 'ghost-key', scope: null, scopeRef: null, versionId: null, condition: 'dangling' }],
      selectors,
    );
    expect(msg).toContain('"ghost-key"');
    expect(msg).toContain('work_item:WI-1');
    expect(msg).toContain('owner:su-1');
    expect(msg).toContain('workspace');
  });

  it('tells the caller that an expired key is NOT what was refused', () => {
    // Without this the obvious misreading of the refusal is "my fact expired",
    // which sends the agent to re-assert something that already resolves.
    const msg = danglingAssumptionsMessage(
      [{ declared: 'k', ref: null, key: 'k', scope: null, scopeRef: null, versionId: null, condition: 'dangling' }],
      selectors,
    );
    expect(msg).toMatch(/EXPIRED or RETRACTED key still resolves/);
    expect(msg).toContain('"none"');
  });

  it('pluralizes so the refusal reads correctly for one and for many', () => {
    const one = danglingAssumptionsMessage(
      [{ declared: 'a', ref: null, key: 'a', scope: null, scopeRef: null, versionId: null, condition: 'dangling' }],
      selectors,
    );
    const many = danglingAssumptionsMessage(
      [
        { declared: 'a', ref: null, key: 'a', scope: null, scopeRef: null, versionId: null, condition: 'dangling' },
        { declared: 'b', ref: null, key: 'b', scope: null, scopeRef: null, versionId: null, condition: 'dangling' },
      ],
      selectors,
    );
    expect(one).toContain('key "a" does not resolve');
    expect(many).toContain('keys "a", "b" do not resolve');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RE-CHECK (WI-6465 / D-102)
// ─────────────────────────────────────────────────────────────────────────────

function basis(over: Partial<DeclaredBasisRow> = {}): DeclaredBasisRow {
  return {
    conditionAtClose: 'live',
    pinnedVersion: 100,
    currentVersion: 100,
    retractedNow: false,
    expiredNow: false,
    ...over,
  };
}

describe('classifyBasisMovement', () => {
  it('reports unchanged when the pinned version is still the newest and live', () => {
    expect(classifyBasisMovement(basis())).toBe('unchanged');
  });

  it('reports superseded when a newer version of the same identity exists', () => {
    expect(classifyBasisMovement(basis({ currentVersion: 101 }))).toBe('superseded');
  });

  it('reports lapsed when the pinned version is still newest but has aged out', () => {
    expect(classifyBasisMovement(basis({ expiredNow: true }))).toBe('lapsed');
  });

  it('reports vanished when the identity is gone from the ledger entirely', () => {
    // The expiry sweep hard-deletes 30d past expiry, leaving only the excerpt
    // D-079 stamped onto the close.
    expect(classifyBasisMovement(basis({ currentVersion: null }))).toBe('vanished');
  });

  // ⚠ THE ORDERING RULES ARE THE DESIGN, so they get their own assertions: a
  // reader must be told the STRONGEST news, not the first true thing. Without
  // these, a refactor that reorders the branches still passes every test above.
  it('prefers retracted over superseded — a withdrawn claim dominates a revised one', () => {
    expect(classifyBasisMovement(basis({ currentVersion: 101, retractedNow: true }))).toBe('retracted');
  });

  it('prefers superseded over lapsed — revised content outranks mere ageing', () => {
    expect(classifyBasisMovement(basis({ currentVersion: 101, expiredNow: true }))).toBe('superseded');
  });

  it('prefers vanished over every other verdict', () => {
    expect(
      classifyBasisMovement(basis({ currentVersion: null, retractedNow: true, expiredNow: true })),
    ).toBe('vanished');
  });

  it('reports undeterminable for an unpinned declaration rather than guessing unchanged', () => {
    // "We cannot tell" is not "nothing moved" — collapsing them would let a
    // declaration that predates the version stamp certify itself as fresh.
    expect(classifyBasisMovement(basis({ pinnedVersion: null }))).toBe('undeterminable');
  });

  it('still reports retracted/vanished for an unpinned declaration', () => {
    // Those two verdicts hold WITHOUT a pin, which is why the pin check sits
    // below them. A regression that hoisted it would silently mute real news.
    expect(classifyBasisMovement(basis({ pinnedVersion: null, retractedNow: true }))).toBe('retracted');
    expect(classifyBasisMovement(basis({ pinnedVersion: null, currentVersion: null }))).toBe('vanished');
  });

  it('never returns a movement outside the declared vocabulary', () => {
    const rows = [
      basis(),
      basis({ currentVersion: 101 }),
      basis({ retractedNow: true }),
      basis({ expiredNow: true }),
      basis({ currentVersion: null }),
      basis({ pinnedVersion: null }),
    ];
    for (const r of rows) expect(BASIS_MOVEMENTS).toContain(classifyBasisMovement(r));
  });
});

describe('basisHasMoved excludes undeterminable BY CONSTRUCTION', () => {
  it('counts every real movement as moved', () => {
    expect(basisHasMoved('superseded')).toBe(true);
    expect(basisHasMoved('retracted')).toBe(true);
    expect(basisHasMoved('lapsed')).toBe(true);
    expect(basisHasMoved('vanished')).toBe(true);
  });

  it('counts neither unchanged NOR undeterminable', () => {
    // Counting an uncomparable row as unmoved would convert missing data into a
    // clean bill of health — the sibling staleness metric's own failure mode.
    expect(basisHasMoved('unchanged')).toBe(false);
    expect(basisHasMoved('undeterminable')).toBe(false);
  });
});

describe('the close-time question is separate from the movement question (D-102)', () => {
  it('counts a basis that was already not-current when it was cited', () => {
    expect(wasStaleAtDeclaration('superseded')).toBe(true);
    expect(wasStaleAtDeclaration('retracted')).toBe(true);
    expect(wasStaleAtDeclaration('lapsed')).toBe(true);
  });

  it('does not count a live citation, nor one the ledger could not check', () => {
    expect(wasStaleAtDeclaration('live')).toBe(false);
    // `unresolved` is a failed READ, not a stale citation — see isDanglingCondition.
    expect(wasStaleAtDeclaration('unresolved')).toBe(false);
    expect(wasStaleAtDeclaration(null)).toBe(false);
  });

  it('excludes the unreadable conditions from the denominator too', () => {
    // The numerator and denominator must exclude the SAME rows, or a ledger blip
    // deflates the rate instead of shrinking the sample.
    expect(isComparableAtDeclaration('unresolved')).toBe(false);
    expect(isComparableAtDeclaration('dangling')).toBe(false);
    expect(isComparableAtDeclaration(null)).toBe(false);
    for (const c of ASSUMPTION_CONDITIONS) {
      if (c === 'unresolved' || c === 'dangling') continue;
      expect(isComparableAtDeclaration(c)).toBe(true);
    }
  });

  it('never counts a stale-at-close row that the denominator excluded', () => {
    // The invariant that keeps the rate in [0,1]: every condition counted by the
    // numerator must also be counted by the denominator.
    for (const c of ASSUMPTION_CONDITIONS) {
      if (wasStaleAtDeclaration(c)) expect(isComparableAtDeclaration(c)).toBe(true);
    }
  });
});
