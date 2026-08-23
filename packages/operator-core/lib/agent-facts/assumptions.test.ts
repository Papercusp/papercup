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
  nonAssumptionKindAdvisory,
  parseAssumptionRef,
  resolveAssumptions,
  wasStaleAtDeclaration,
  type DeclaredBasisRow,
  type ResolvedAssumption,
} from './assumptions';

/** A fake tagged-template `sql` — a tag call is just `fn(strings, ...values)`, so
 *  a plain async function that ignores its args and returns the fixture rows
 *  works as `inject` (per the repo's standing unit-test convention: mock the
 *  tagged template, never hit live PG). */
function fakeSql(rows: unknown[]): Parameters<typeof resolveAssumptions>[3] {
  return (async (..._args: unknown[]) => rows) as unknown as Parameters<typeof resolveAssumptions>[3];
}

function factRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    scope: 'owner',
    scope_ref: 'su-1',
    key: 'my-key',
    body: 'the fact body',
    retracted_at: null,
    superseded_at: null,
    expired: false,
    kind: null,
    confidence: null,
    ...over,
  };
}

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
      [{ declared: 'ghost-key', ref: null, key: 'ghost-key', scope: null, scopeRef: null, versionId: null, condition: 'dangling', kind: null, confidence: null, isAssumption: null }],
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
      [{ declared: 'k', ref: null, key: 'k', scope: null, scopeRef: null, versionId: null, condition: 'dangling', kind: null, confidence: null, isAssumption: null }],
      selectors,
    );
    expect(msg).toMatch(/EXPIRED or RETRACTED key still resolves/);
    expect(msg).toContain('"none"');
  });

  it('pluralizes so the refusal reads correctly for one and for many', () => {
    const one = danglingAssumptionsMessage(
      [{ declared: 'a', ref: null, key: 'a', scope: null, scopeRef: null, versionId: null, condition: 'dangling', kind: null, confidence: null, isAssumption: null }],
      selectors,
    );
    const many = danglingAssumptionsMessage(
      [
        { declared: 'a', ref: null, key: 'a', scope: null, scopeRef: null, versionId: null, condition: 'dangling', kind: null, confidence: null, isAssumption: null },
        { declared: 'b', ref: null, key: 'b', scope: null, scopeRef: null, versionId: null, condition: 'dangling', kind: null, confidence: null, isAssumption: null },
      ],
      selectors,
    );
    expect(one).toContain('key "a" does not resolve');
    expect(many).toContain('keys "a", "b" do not resolve');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EI-19298742806956600 — the assumption gate accepted a VERIFIED CONCLUSION as
// an assumption, because resolution never inspected `kind`/`confidence` at all.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAssumptions stamps kind/confidence/isAssumption on every resolved entry', () => {
  const selectors = assumptionSelectorsFor({ ownerId: 'su-1' });

  it('a real assumption (kind:"assumption") resolves isAssumption:true', async () => {
    const out = await resolveAssumptions(['my-key'], selectors, {}, fakeSql([factRow({ kind: 'assumption' })]));
    expect(out[0]).toMatchObject({ kind: 'assumption', isAssumption: true });
  });

  it('the LEGACY form (no kind, confidence:"suspected") still resolves isAssumption:true', async () => {
    const out = await resolveAssumptions(
      ['my-key'],
      selectors,
      {},
      fakeSql([factRow({ kind: null, confidence: 'suspected' })]),
    );
    expect(out[0]).toMatchObject({ kind: null, confidence: 'suspected', isAssumption: true });
  });

  it('a VERIFIED CONCLUSION resolves isAssumption:false — the exact defect this closes', async () => {
    const out = await resolveAssumptions(
      ['my-key'],
      selectors,
      {},
      fakeSql([factRow({ kind: 'conclusion', confidence: 'verified' })]),
    );
    expect(out[0]).toMatchObject({ kind: 'conclusion', confidence: 'verified', isAssumption: false });
  });

  it('a plain fact with no kind and no suspected confidence resolves isAssumption:false, not null', async () => {
    const out = await resolveAssumptions(['my-key'], selectors, {}, fakeSql([factRow()]));
    expect(out[0]).toMatchObject({ kind: null, confidence: null, isAssumption: false });
  });

  it('a DANGLING entry (no row at all) carries isAssumption:null — nothing to judge, not "false"', async () => {
    const out = await resolveAssumptions(['ghost-key'], selectors, {}, fakeSql([]));
    expect(out[0]).toMatchObject({ condition: 'dangling', kind: null, confidence: null, isAssumption: null });
  });

  it('an unrecognized kind/confidence value on the row parses to null rather than passing through raw', async () => {
    // Defends against a future DB value this enum doesn't know about silently
    // being treated as a real kind/confidence instead of "unparseable".
    const out = await resolveAssumptions(
      ['my-key'],
      selectors,
      {},
      fakeSql([factRow({ kind: 'not-a-real-kind', confidence: 'not-a-real-confidence' })]),
    );
    expect(out[0]).toMatchObject({ kind: null, confidence: null, isAssumption: false });
  });
});

describe('nonAssumptionKindAdvisory — WARN-ONLY, never a refusal', () => {
  function resolved(over: Partial<ResolvedAssumption>): ResolvedAssumption {
    return {
      declared: 'my-key',
      ref: 'fact:owner:su-1:my-key@v1',
      key: 'my-key',
      scope: 'owner',
      scopeRef: 'su-1',
      versionId: 1,
      condition: 'live',
      kind: null,
      confidence: null,
      isAssumption: null,
      ...over,
    };
  }

  it('fires for a cited key that resolved but was not an assumption', () => {
    const msg = nonAssumptionKindAdvisory([
      resolved({ declared: 'gate-red-is-flake', key: 'gate-red-is-flake', kind: 'conclusion', confidence: 'verified', isAssumption: false }),
    ]);
    expect(msg).toBeDefined();
    expect(msg).toContain('"gate-red-is-flake"');
    expect(msg).toContain('kind:conclusion');
    expect(msg).toContain('confidence:verified');
    expect(msg).toMatch(/advisory only/i);
  });

  it('does NOT fire for a real assumption', () => {
    expect(nonAssumptionKindAdvisory([resolved({ kind: 'assumption', isAssumption: true })])).toBeUndefined();
  });

  it('does NOT fire for a dangling/unresolved entry — isAssumption:null is "nothing to judge", not a hit', () => {
    expect(nonAssumptionKindAdvisory([resolved({ condition: 'dangling', isAssumption: null })])).toBeUndefined();
    expect(nonAssumptionKindAdvisory([resolved({ condition: 'unresolved', isAssumption: null })])).toBeUndefined();
  });

  it('only names the offending keys when the declaration mixes assumption and non-assumption citations', () => {
    const msg = nonAssumptionKindAdvisory([
      resolved({ declared: 'real-assumption', isAssumption: true, kind: 'assumption' }),
      resolved({ declared: 'a-conclusion', isAssumption: false, kind: 'conclusion' }),
    ]);
    expect(msg).toBeDefined();
    expect(msg).toContain('"a-conclusion"');
    expect(msg).not.toContain('"real-assumption"');
  });

  it('returns undefined for an empty resolution list', () => {
    expect(nonAssumptionKindAdvisory([])).toBeUndefined();
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

// ─────────────────────────────────────────────────────────────────────────────
// EI-21194879039423312 — the refusal must expose the grammar it accepts, WHERE
// it searched, and where a same-key fact actually lives. On 2026-08-22 a closer
// cited an existing fact's displayed form, was told to "cite an absolute ref",
// and had nothing left to try — the grammar was never spelled out.
// ─────────────────────────────────────────────────────────────────────────────

const danglingEntry = (over: Partial<ResolvedAssumption> = {}): ResolvedAssumption => ({
  declared: 'ghost-key',
  ref: null,
  key: 'ghost-key',
  scope: null,
  scopeRef: null,
  versionId: null,
  condition: 'dangling',
  kind: null,
  confidence: null,
  isAssumption: null,
  ...over,
});

describe('danglingAssumptionsMessage exposes its components (EI-21194879039423312)', () => {
  const selectors = assumptionSelectorsFor({ workItemId: 'WI-1', ownerId: 'su-1' });

  it('spells out the accepted citation forms, including the @v pin and the workspace special case', () => {
    const msg = danglingAssumptionsMessage([danglingEntry()], selectors);
    expect(msg).toContain('Accepted citation forms');
    expect(msg).toContain('fact:<scope>:[<ref>:]<key>[@v<factRowId>]');
    expect(msg).toContain('`fact:workspace:<key>`');
  });

  it('names the workspace partition that was searched', () => {
    const msg = danglingAssumptionsMessage(
      [danglingEntry({ searchedWorkspace: 'papercusp-workspace' })],
      selectors,
    );
    expect(msg).toContain('workspace partition: papercusp-workspace');
    expect(msg).toContain('has no row at all in workspace papercusp-workspace');
  });

  it('a malformed fact:-prefixed entry is told its SHAPE is wrong, not sent to assert a phantom key', () => {
    const msg = danglingAssumptionsMessage(
      [danglingEntry({ malformed: true, declared: 'fact:workspce:k', key: 'k' })],
      selectors,
    );
    expect(msg).toContain('"fact:workspce:k" opens with fact: but is not a well-formed ref');
    expect(msg).not.toContain('"fact:workspce:k" has no row');
  });

  it('a near-miss NAMES where the key actually lives', () => {
    const msg = danglingAssumptionsMessage(
      [danglingEntry({ nearMisses: ['fact:owner:su-other:ghost-key@v42'] })],
      selectors,
    );
    expect(msg).toContain('EXISTS at `fact:owner:su-other:ghost-key@v42`');
    expect(msg).toContain('Cite one of those refs verbatim');
  });
});

describe('resolveAssumptions stamps search context + near-misses on dangles (EI-21194879039423312)', () => {
  it('the follow-up probe surfaces a same-key fact living outside the searched scopes', async () => {
    // Main read and probe share the fake: resolveOne drops this row because
    // scope_ref su-other matches no selector — then the probe reports it.
    const sql = fakeSql([factRow({ id: 42, key: 'ghost-key', scope: 'owner', scope_ref: 'su-other' })]);
    const out = await resolveAssumptions(['ghost-key'], assumptionSelectorsFor({ ownerId: 'su-1' }), {}, sql);
    expect(out[0].condition).toBe('dangling');
    expect(out[0].nearMisses).toEqual(['fact:owner:su-other:ghost-key@v42']);
  });

  it('every dangle carries the workspace partition the search ran in', async () => {
    const out = await resolveAssumptions(
      ['never-existed-key'],
      assumptionSelectorsFor({ ownerId: 'su-1' }),
      { workspaceId: 'ws-probe' },
      fakeSql([]),
    );
    expect(out[0].condition).toBe('dangling');
    expect(out[0].searchedWorkspace).toBe('ws-probe');
  });

  it('a total absence gets NO near-miss (the probe found nothing)', async () => {
    const out = await resolveAssumptions(
      ['never-existed-key'],
      assumptionSelectorsFor({ ownerId: 'su-1' }),
      {},
      fakeSql([]),
    );
    expect(out[0].condition).toBe('dangling');
    expect(out[0].nearMisses).toBeUndefined();
  });

  it('probe failure changes no verdict — hints are best-effort', async () => {
    let calls = 0;
    const flaky = (async (..._args: unknown[]) => {
      calls += 1;
      if (calls > 1) throw new Error('pg down mid-probe');
      return [] as unknown[];
    }) as unknown as Parameters<typeof resolveAssumptions>[3];
    const out = await resolveAssumptions(
      ['never-existed-key'],
      assumptionSelectorsFor({ ownerId: 'su-1' }),
      { workspaceId: 'ws-flaky' },
      flaky,
    );
    expect(out[0].condition).toBe('dangling');
    expect(out[0].searchedWorkspace).toBe('ws-flaky');
    expect(out[0].nearMisses).toBeUndefined();
  });
});
