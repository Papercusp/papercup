/**
 * coupling-derivation.test.ts — P-013's derived half (scoping ruling D-078).
 */
import { describe, expect, it } from 'vitest';

import {
  deriveCouplings,
  deriveCouplingsFromCoordExchange,
  deriveCouplingsFromHeldFiles,
  deriveCouplingsFromPlanBlocking,
  deriveCouplingsFromRoster,
  type DerivationRow,
} from './coupling-derivation';
import { resolveCoupledPeers } from './couplings';
import {
  PRESENCE_IDENTITY_FIELDS,
  PRESENCE_STATE_FIELDS,
} from '../agent-tools/coordination/presence-payload';

const row = (o: Partial<Record<string, unknown>> & { ownerId: string }) => o;

describe('deriveCouplingsFromRoster', () => {
  // THE D-054 RECURRENCE GUARD. This test is the INVERSE of the one that stood
  // here until 2026-08-09, which asserted that a shared fleet DOES couple two
  // agents. D-054 cut that edge on 2026-07-27 — *"FLEETS CAN HAVE 30 MEMBERS
  // THAT IS TOO MUCH COUPLING NO?"* — and the derivation emitted it anyway for
  // 12 days, with six tests actively protecting the vetoed behaviour. The
  // absence of this negative is why nobody noticed: every test asked "does the
  // signal fire?", none asked "is it still gone?".
  it('does NOT couple two agents merely because they share a fleet (D-054)', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', fleetSlug: 'alpha' }),
      row({ ownerId: 'su-peer', fleetSlug: 'alpha' }),
      row({ ownerId: 'su-other', fleetSlug: 'beta' }),
    ]);
    // Set membership is not a pairwise relation: it is O(n²) in fleet size and
    // redundant with `fleetSlug`, which the base presence payload already puts
    // on every row. Measured 2026-08-09 on the live fleet `nonp2p-bug-drain`:
    // 18 members ⇒ 17 edges per caller, 306 fleet-wide.
    expect(derived).toEqual([]);
  });

  it('does NOT couple two agents that merely both have no fleet', () => {
    // A null fleet is an absence, not a shared property. Treating it as a signal
    // would couple every unfleeted agent to every other one — the block would be
    // noise on exactly the surface it is meant to make legible.
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', fleetSlug: null }),
      row({ ownerId: 'su-peer', fleetSlug: null }),
      row({ ownerId: 'su-blank', fleetSlug: '  ' }),
    ]);
    expect(derived).toEqual([]);
  });

  // THE D-093 RECURRENCE GUARD, written in the same shape as the D-054 one above
  // and for the same reason. Two tests here used to assert that overlapping
  // `currentFiles` DOES couple two agents; both were green for the signal's whole
  // life while it produced ZERO edges in production across 14 days of divergence
  // stamps. The field is real but empty on essentially every roster row
  // (EI-18772330418885814: 119 live rows, zero populated), so hand-built fixtures
  // could only ever prove the code path works — never that anything reaches it.
  it('does NOT couple two agents over overlapping currentFiles (D-093)', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', currentFiles: ['a.ts', 'b.ts'] }),
      row({ ownerId: 'su-peer', currentFiles: ['b.ts', 'c.ts'] }),
    ]);
    // Superseded by `holds-a-lock-on`, which reads a LIVE LOCK — the only
    // automatic "this agent is on this file" signal there is. ⚠ This asserts the
    // COUPLING SIGNAL is gone, NOT that the roster field is: `current_files` has a
    // live writer and live consumers and must stay (D-095).
    expect(derived).toEqual([]);
  });

  it('couples peers parked on the SAME awaited event', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', awaitingEventKey: 'fleet:x:gate' }),
      row({ ownerId: 'su-peer', awaitingEventKey: 'fleet:x:gate' }),
      row({ ownerId: 'su-other', awaitingEventKey: 'fleet:y:gate' }),
    ]);
    expect(derived).toEqual([{ ownerId: 'su-peer', relation: 'awaits', because: 'both awaiting fleet:x:gate' }]);
  });

  it('emits ONLY the surviving signal on a row that trips every retired one', () => {
    // ⚠ A COMBINED D-054 + D-093 RECURRENCE GUARD, and the reason it is one test:
    // this peer trips a shared fleet AND overlapping currentFiles AND a shared
    // await, so a single expectation catches EITHER cut edge coming back.
    //
    // It used to assert "emits EVERY signal a peer trips, in a fixed order",
    // pairing shared-file with awaits. Two retirements later the roster emits at
    // most ONE relation per peer, so there is no longer an order to fix — asserting
    // one would be asserting a property the code cannot have. Multi-signal
    // ACCUMULATION is still covered, on the path that actually produces it: the
    // union contract test below folds roster + lock-hold edges into one peer.
    const derived = deriveCouplingsFromRoster('su-me', [
      row({
        ownerId: 'su-me',
        fleetSlug: 'alpha',
        currentFiles: ['x.ts'],
        awaitingEventKey: 'gate:1',
      }),
      row({
        ownerId: 'su-peer',
        fleetSlug: 'alpha',
        currentFiles: ['x.ts'],
        awaitingEventKey: 'gate:1',
      }),
    ]);
    // The shared `alpha` fleet and the overlapping `x.ts` are left in the fixture
    // ON PURPOSE: each contributes NOTHING (D-054, D-093), so the exact-equality
    // assertion below fails the moment either cut edge is restored.
    expect(derived.map((d) => d.because)).toEqual(['both awaiting gate:1']);
  });

  it('never couples the caller to itself', () => {
    // ⚠ NON-VACUOUS BY CONSTRUCTION: the peer proves the signal is live on this
    // very roster, so the empty self-edge is the assertion doing work rather than
    // nothing firing at all. (Until 2026-08-10 this passed a lone self row whose
    // only signal was `currentFiles`; once that emit went it would have asserted
    // an emptiness that no longer had anything to do with self-coupling.)
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', awaitingEventKey: 'gate:1' }),
      row({ ownerId: 'su-peer', awaitingEventKey: 'gate:1' }),
    ]);
    expect(derived).toHaveLength(1);
    expect(derived.map((d) => d.ownerId)).not.toContain('su-me');
  });

  it('returns empty when the caller has no row of its own', () => {
    // Nothing to compare against — a scope question, not a coupling question.
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-peer', fleetSlug: 'alpha' }),
    ]);
    expect(derived).toEqual([]);
  });

  it('is TOTAL over malformed rows — a bad row is skipped, never thrown on', () => {
    // A throwing derivation would take down coord:presence itself, which is far
    // worse than a missing expanded[] entry.
    expect(() =>
      deriveCouplingsFromRoster('su-me', [
        null,
        undefined,
        42,
        'nonsense',
        { ownerId: '' },
        { ownerId: 'su-me', fleetSlug: 'alpha', currentFiles: 'not-an-array' },
        { ownerId: 'su-peer', fleetSlug: 'alpha', currentFiles: [null, 7, 'x.ts'] },
      ]),
    ).not.toThrow();
    // The junk is EXERCISED INTO AN EMITTED EDGE rather than sitting beside one:
    // a surviving signal must still fire on a roster full of malformed rows.
    // ⚠ This has now been re-anchored TWICE for the same reason — first off
    // `fleetSlug` (D-054), then off `currentFiles` (D-093) — because each time the
    // relation it rode was retired the test kept passing while exercising nothing.
    // Anchor it to a signal that is LIVE, and re-anchor it the day that changes.
    const derived = deriveCouplingsFromRoster('su-me', [
      { ownerId: 'su-me', fleetSlug: 'alpha', awaitingEventKey: 'gate:1' },
      { ownerId: 'su-peer', fleetSlug: 'alpha', awaitingEventKey: 'gate:1' },
    ]);
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'awaits', because: 'both awaiting gate:1' },
    ]);
  });

  it('deduplicates a repeated ownerId — first row wins', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', awaitingEventKey: 'gate:1' }),
      row({ ownerId: 'su-peer', awaitingEventKey: 'gate:1' }),
      row({ ownerId: 'su-peer', awaitingEventKey: 'gate:1' }),
    ]);
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'awaits', because: 'both awaiting gate:1' },
    ]);
  });
});

describe('deriveCouplingsFromRoster ∘ resolveCoupledPeers — the union contract', () => {
  it('feeds the union so signals accumulate into one derivedBecause', () => {
    // ⚠ ACCUMULATION NOW SPANS TWO DERIVATIONS, and that is the honest shape. It
    // used to pair `shared-file` + `awaits`, both from the roster — but once
    // D-093 removed the file signal the roster emits at most ONE relation per
    // peer, so a roster-only fixture could no longer demonstrate accumulation at
    // all. Pairing the roster's `awaits` with the lock derivation exercises the
    // real production path: `deriveCouplings` concatenates the legs and the union
    // folds them into one peer.
    const rows = [
      row({ ownerId: 'su-me', awaitingEventKey: 'gate:1' }),
      row({ ownerId: 'su-peer', awaitingEventKey: 'gate:1' }),
    ];
    const derived = [
      ...deriveCouplingsFromRoster('su-me', rows),
      ...deriveCouplingsFromHeldFiles(
        'su-me',
        new Map([
          ['su-me', ['x.ts']],
          ['su-peer', ['x.ts']],
        ]),
      ),
    ];
    // The antecedent, asserted: two distinct signals really did fire, so the fold
    // below is exercised rather than trivially satisfied by a single edge.
    expect(derived).toHaveLength(2);
    const peers = resolveCoupledPeers('su-me', derived, []);
    expect(peers).toEqual([
      {
        ownerId: 'su-peer',
        source: 'derived',
        derivedBecause: 'both awaiting gate:1; you both hold locks in x.ts',
        // D-087: the typed half survives END-TO-END, derivation through union —
        // asserted here on the real path, not only on hand-built rows.
        derivedRelations: ['awaits', 'holds-a-lock-on'],
      },
    ]);
  });

  it('SUPPRESSION STILL WINS over a live derivation — the D-061 R4 property', () => {
    // The reason the derivation feeds the union instead of bypassing it. The
    // shared await is still real and this re-fires on every read, so if
    // suppression lost here the peer would silently return next tick and the
    // agent would rightly conclude decoupling is broken.
    const rows = [
      row({ ownerId: 'su-me', awaitingEventKey: 'gate:1' }),
      row({ ownerId: 'su-peer', awaitingEventKey: 'gate:1' }),
    ];
    // ⚠ THE ANTECEDENT, ASSERTED. Without this line the test passes whenever the
    // derivation returns NOTHING — suppression is never exercised and the green is
    // vacuous. That is not hypothetical: this test kept passing on 2026-08-09 when
    // the `same-fleet` edge it used to rely on was removed, silently testing
    // nothing. A suppression test must first prove there was something to suppress.
    const derived = deriveCouplingsFromRoster('su-me', rows);
    expect(derived).toHaveLength(1);
    const peers = resolveCoupledPeers('su-me', derived, [
      {
        agentA: 'su-me',
        agentB: 'su-peer',
        state: 'suppressed',
        declaredBy: 'su-me',
        reason: null,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
        expiresAt: null,
      },
    ]);
    expect(peers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE RECURRENCE GUARD (P-013).
//
// This module reads roster rows STRUCTURALLY (`DerivationRow` is an interface of
// optional fields over `unknown[]` inputs), which is what makes it pure and
// PG-free — and also what makes it silently wrong if a field name drifts from
// the producer. Every other test here builds its own fixtures, so they would all
// stay green while the production signal derived nothing. That is not
// hypothetical: it is exactly what happened to the `currentFiles` signal, which
// shipped "green (51/51)" reading a field that is real but empty for essentially
// every live agent. A fixture test cannot tell "wrong field" from "always-empty
// field"; only a check against the PRODUCER can.
// ---------------------------------------------------------------------------
describe('DerivationRow is bound to the real presence producer', () => {
  const emitted = new Set<string>([...PRESENCE_IDENTITY_FIELDS, ...PRESENCE_STATE_FIELDS]);

  it('reads only fields coord:presence actually emits', () => {
    // Every key of DerivationRow, listed explicitly: a rename on either side
    // fails HERE rather than degrading a signal to silence in production.
    const readFields: (keyof DerivationRow)[] = [
      'ownerId',
      'fleetSlug',
      'awaitingEventKey',
      'currentPlanSlug',
      'claimedItems',
      'claimedPlanItemRefs',
    ];
    const missing = readFields.filter((f) => !emitted.has(f));
    expect(missing).toEqual([]);
  });

  it('does not read heldFiles from the roster — it is opt-in detail, not a STATE field', () => {
    // The lock-hold signal deliberately takes an INJECTED map instead of reading
    // a roster field, because `heldFiles` is attached only under include_detail.
    // If it ever became a always-emitted STATE field this assertion flips and the
    // signal should be simplified to read it directly.
    expect(emitted.has('heldFiles')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P-013 querying signals (lock holds, plan blocked-by, recent coord exchange)
// ---------------------------------------------------------------------------

describe('deriveCouplingsFromHeldFiles', () => {
  const held = (o: Record<string, string[]>) => new Map(Object.entries(o));

  it('couples peers holding a lock on the same path, naming it', () => {
    const derived = deriveCouplingsFromHeldFiles(
      'su-me',
      held({ 'su-me': ['a/x.ts'], 'su-peer': ['a/x.ts', 'b/y.ts'], 'su-other': ['c/z.ts'] }),
    );
    expect(derived).toEqual([{ ownerId: 'su-peer', relation: 'holds-a-lock-on', because: 'you both hold locks in a/x.ts' }]);
  });

  it('bounds how many shared paths it names and counts the rest', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const derived = deriveCouplingsFromHeldFiles('su-me', held({ 'su-me': paths, 'su-peer': paths }));
    expect(derived[0]?.because).toBe('you both hold locks in a.ts, b.ts (+2 more shared paths)');
  });

  it('is empty when the caller holds nothing (no self entry ⇒ no overlap)', () => {
    expect(deriveCouplingsFromHeldFiles('su-me', held({ 'su-peer': ['a.ts'] }))).toEqual([]);
  });

  it('is deterministic regardless of map insertion order (D-006)', () => {
    const a = deriveCouplingsFromHeldFiles(
      'su-me',
      held({ 'su-me': ['x.ts'], 'su-b': ['x.ts'], 'su-a': ['x.ts'] }),
    );
    const b = deriveCouplingsFromHeldFiles(
      'su-me',
      held({ 'su-a': ['x.ts'], 'su-me': ['x.ts'], 'su-b': ['x.ts'] }),
    );
    expect(a).toEqual(b);
    expect(a.map((d) => d.ownerId)).toEqual(['su-a', 'su-b']);
  });
});

describe('deriveCouplingsFromPlanBlocking', () => {
  const rows = [
    row({ ownerId: 'su-me', currentPlanSlug: 'p1', claimedItems: ['P-005'] }),
    row({ ownerId: 'su-peer', currentPlanSlug: 'p1', claimedItems: ['P-003'] }),
  ];

  it('names the peer holding what BLOCKS you', () => {
    const derived = deriveCouplingsFromPlanBlocking('su-me', rows, [
      { item: 'P-005', blockedBy: ['P-003'] },
    ]);
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'blocks-me', because: 'your P-005 is blocked by P-003, which they hold' },
    ]);
  });

  it('names the peer BLOCKED ON YOU — the direction an agent cannot discover alone', () => {
    const derived = deriveCouplingsFromPlanBlocking('su-me', rows, [
      { item: 'P-003', blockedBy: ['P-005'] },
    ]);
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'blocked-by-me', because: 'their P-003 is blocked by P-005, which you hold' },
    ]);
  });

  it('does NOT couple across different plans — item ids are plan-local', () => {
    const derived = deriveCouplingsFromPlanBlocking(
      'su-me',
      [
        row({ ownerId: 'su-me', currentPlanSlug: 'p1', claimedItems: ['P-005'] }),
        row({ ownerId: 'su-peer', currentPlanSlug: 'OTHER', claimedItems: ['P-003'] }),
      ],
      [{ item: 'P-005', blockedBy: ['P-003'] }],
    );
    expect(derived).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // EI-20200393414409502 — occupancy via HELD WORK-ITEMS, not just plan-item claims.
  //
  // These are the cases the signal could not reach before: the fleet records what it
  // is working on in `work_items.taken_by` (31 agents / 46 items when measured), not
  // in `plan_item_claims` (5 agents), so keying occupancy to the latter alone made
  // `blocks-me` census a permanent zero for 14 days while 6 plans had co-located
  // agents and blocked items.
  // -------------------------------------------------------------------------
  it('couples on occupancy carried by a held WORK-ITEM stamp, with no plan-item claim on either side', () => {
    const derived = deriveCouplingsFromPlanBlocking(
      'su-me',
      [
        row({ ownerId: 'su-me', currentPlanSlug: 'p1', claimedPlanItemRefs: ['p1#P-005'] }),
        row({ ownerId: 'su-peer', currentPlanSlug: 'p1', claimedPlanItemRefs: ['p1#P-003'] }),
      ],
      [{ item: 'P-005', blockedBy: ['P-003'] }],
    );
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'blocks-me', because: 'your P-005 is blocked by P-003, which they hold' },
    ]);
  });

  it('counts a peer as on THIS plan through a qualified ref even when it declares another plan', () => {
    // Holding stamped work on the plan is stronger evidence than the declaration,
    // and the ref is plan-qualified so it cannot collide. 43 agents declare a plan
    // slug and only 4 also hold a live plan-item claim, so the declaration alone
    // routinely fails to describe where an agent's work actually is.
    const derived = deriveCouplingsFromPlanBlocking(
      'su-me',
      [
        row({ ownerId: 'su-me', currentPlanSlug: 'p1', claimedItems: ['P-005'] }),
        row({ ownerId: 'su-peer', currentPlanSlug: 'ELSEWHERE', claimedPlanItemRefs: ['p1#P-003'] }),
      ],
      [{ item: 'P-005', blockedBy: ['P-003'] }],
    );
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'blocks-me', because: 'your P-005 is blocked by P-003, which they hold' },
    ]);
  });

  it('does NOT match a ref qualified with a DIFFERENT plan (the collision the qualification prevents)', () => {
    // The failure this rules out: reading `other#P-003` as `P-003` would couple two
    // agents over an identifier that means unrelated things in the two plans — the
    // exact hazard the plan-local `claimedItems` check has always guarded against,
    // now that occupancy no longer requires a declared plan to be admitted.
    const derived = deriveCouplingsFromPlanBlocking(
      'su-me',
      [
        row({ ownerId: 'su-me', currentPlanSlug: 'p1', claimedItems: ['P-005'] }),
        row({ ownerId: 'su-peer', currentPlanSlug: 'p1', claimedPlanItemRefs: ['other#P-003'] }),
      ],
      [{ item: 'P-005', blockedBy: ['P-003'] }],
    );
    expect(derived).toEqual([]);
  });

  it('unions the two surfaces rather than preferring one', () => {
    // A caller holding P-005 by plan-item claim and P-009 by work-item stamp is
    // blocked through EITHER; a fix that swapped the surfaces instead of unioning
    // them would pass the tests above and still drop half the real edges.
    const derived = deriveCouplingsFromPlanBlocking(
      'su-me',
      [
        row({
          ownerId: 'su-me',
          currentPlanSlug: 'p1',
          claimedItems: ['P-005'],
          claimedPlanItemRefs: ['p1#P-009'],
        }),
        row({ ownerId: 'su-peer', currentPlanSlug: 'p1', claimedItems: ['P-003'] }),
      ],
      [
        { item: 'P-005', blockedBy: ['P-003'] },
        { item: 'P-009', blockedBy: ['P-003'] },
      ],
    );
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'blocks-me', because: 'your P-005 is blocked by P-003, which they hold' },
      { ownerId: 'su-peer', relation: 'blocks-me', because: 'your P-009 is blocked by P-003, which they hold' },
    ]);
  });

  it('ignores a malformed ref instead of throwing (rows are unknown[] and must stay total)', () => {
    const derived = deriveCouplingsFromPlanBlocking(
      'su-me',
      [
        row({ ownerId: 'su-me', currentPlanSlug: 'p1', claimedItems: ['P-005'] }),
        row({
          ownerId: 'su-peer',
          currentPlanSlug: 'p1',
          claimedPlanItemRefs: ['', '#P-003', 'p1#', 'p1#P-003'],
        }),
      ],
      [{ item: 'P-005', blockedBy: ['P-003'] }],
    );
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'blocks-me', because: 'your P-005 is blocked by P-003, which they hold' },
    ]);
  });

  it('is empty with no edges, and empty when the caller declares no plan', () => {
    expect(deriveCouplingsFromPlanBlocking('su-me', rows, [])).toEqual([]);
    expect(
      deriveCouplingsFromPlanBlocking(
        'su-me',
        [row({ ownerId: 'su-me', claimedItems: ['P-005'] }), rows[1]!],
        [{ item: 'P-005', blockedBy: ['P-003'] }],
      ),
    ).toEqual([]);
  });
});

describe('deriveCouplingsFromCoordExchange', () => {
  it('couples each distinct partner once', () => {
    expect(deriveCouplingsFromCoordExchange('su-me', ['su-a', 'su-a', 'su-b'])).toEqual([
      { ownerId: 'su-a', relation: 'coord-exchange', because: 'recent coord exchange' },
      { ownerId: 'su-b', relation: 'coord-exchange', because: 'recent coord exchange' },
    ]);
  });

  it('never couples the caller to itself', () => {
    expect(deriveCouplingsFromCoordExchange('su-me', ['su-me'])).toEqual([]);
  });
});

describe('deriveCouplings (orchestrator)', () => {
  // `awaitingEventKey` is what makes the PURE ROSTER leg contribute here. It
  // replaced `fleetSlug`, which contributes nothing since D-054 — the shared
  // `alpha` fleet is kept in the fixture deliberately so these cases also prove
  // the cut edge stays cut on the full orchestrator path, not just the pure one.
  const rows = [
    row({
      ownerId: 'su-me',
      fleetSlug: 'alpha',
      awaitingEventKey: 'gate:1',
      currentPlanSlug: 'p1',
      claimedItems: ['P-005'],
    }),
    row({
      ownerId: 'su-peer',
      fleetSlug: 'alpha',
      awaitingEventKey: 'gate:1',
      currentPlanSlug: 'p1',
      claimedItems: ['P-003'],
    }),
  ];

  it('unions every signal, accumulating each distinct reason onto the one peer', async () => {
    const derived = await deriveCouplings('su-me', rows, {
      heldFiles: async () =>
        new Map([
          ['su-me', ['x.ts']],
          ['su-peer', ['x.ts']],
        ]),
      planEdges: async () => [{ item: 'P-005', blockedBy: ['P-003'] }],
      recentPartners: async () => ['su-peer'],
    });
    expect(derived.map((d) => d.because)).toEqual([
      'both awaiting gate:1',
      'you both hold locks in x.ts',
      'your P-005 is blocked by P-003, which they hold',
      'recent coord exchange',
    ]);
    // The union collapses them onto ONE peer, keeping every signal (D-078 (a)) —
    // which is the whole reason the derived channel carries per-signal reasons.
    const peers = resolveCoupledPeers('su-me', derived, []);
    expect(peers).toHaveLength(1);
    expect(peers[0]?.derivedBecause).toBe(
      'both awaiting gate:1; you both hold locks in x.ts; your P-005 is blocked by P-003, which they hold; recent coord exchange',
    );
  });

  it('is FAIL-SOFT PER LEG — one dead source must not cost the others', async () => {
    const derived = await deriveCouplings('su-me', rows, {
      heldFiles: async () => {
        throw new Error('lock DB down');
      },
      planEdges: async () => {
        throw new Error('plan read failed');
      },
      recentPartners: async () => ['su-peer'],
    });
    // TWO legs still land — the pure roster leg and the one live source. A
    // single surviving leg would make this test unable to distinguish "the
    // others still work" from "only one thing was ever going to fire".
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'awaits', because: 'both awaiting gate:1' },
      { ownerId: 'su-peer', relation: 'coord-exchange', because: 'recent coord exchange' },
    ]);
  });

  it('NEVER WIDENS: a source naming a peer outside the roster is dropped', async () => {
    // The access guarantee must hold even if a source misbehaves (D-044/D-078(c)).
    const derived = await deriveCouplings('su-me', rows, {
      recentPartners: async () => ['su-STRANGER', 'su-peer'],
      heldFiles: async () =>
        new Map([
          ['su-me', ['x.ts']],
          ['su-GHOST', ['x.ts']],
        ]),
    });
    expect(derived.map((d) => d.ownerId)).toEqual(['su-peer', 'su-peer']);
  });

  it('works with no sources at all (pure roster derivation)', async () => {
    expect(await deriveCouplings('su-me', rows)).toEqual([
      { ownerId: 'su-peer', relation: 'awaits', because: 'both awaiting gate:1' },
    ]);
  });

  it('skips the plan read entirely when the caller declares no plan', async () => {
    let called = false;
    await deriveCouplings('su-me', [row({ ownerId: 'su-me' }), row({ ownerId: 'su-peer' })], {
      planEdges: async () => {
        called = true;
        return [];
      },
    });
    expect(called).toBe(false);
  });

  it('skips the EXPENSIVE plan read when no peer shares the plan — the common case', async () => {
    // readPlanBySlug fetches AND parses a whole plan (90KB+ here), so paying it
    // on every poll to produce nothing is the WI-6126 cost shape. Gated on a
    // precondition computed from rows already in hand.
    let called = false;
    await deriveCouplings(
      'su-me',
      [
        row({ ownerId: 'su-me', currentPlanSlug: 'p1', claimedItems: ['P-005'] }),
        row({ ownerId: 'su-peer', currentPlanSlug: 'OTHER', claimedItems: ['P-003'] }),
      ],
      {
        planEdges: async () => {
          called = true;
          return [];
        },
      },
    );
    expect(called).toBe(false);
  });

  it('skips the plan read when peers share the plan but hold NO items', async () => {
    let called = false;
    await deriveCouplings(
      'su-me',
      [
        row({ ownerId: 'su-me', currentPlanSlug: 'p1', claimedItems: ['P-005'] }),
        row({ ownerId: 'su-peer', currentPlanSlug: 'p1', claimedItems: [] }),
      ],
      {
        planEdges: async () => {
          called = true;
          return [];
        },
      },
    );
    expect(called).toBe(false);
  });

  it('DOES read the plan when a peer on the same plan holds items', async () => {
    let called = false;
    await deriveCouplings('su-me', rows, {
      planEdges: async () => {
        called = true;
        return [{ item: 'P-005', blockedBy: ['P-003'] }];
      },
    });
    expect(called).toBe(true);
  });

  it('DOES read the plan when both sides hold only WORK-ITEM occupancy (EI-20200393414409502)', async () => {
    // The gate was not merely rare, it was UNSATISFIABLE: zero plans fleet-wide had
    // the two live plan-item claim holders it demanded. This is the reachability
    // proof — same gate, both surfaces.
    let called = false;
    await deriveCouplings(
      'su-me',
      [
        row({ ownerId: 'su-me', currentPlanSlug: 'p1', claimedPlanItemRefs: ['p1#P-005'] }),
        row({ ownerId: 'su-peer', currentPlanSlug: 'p1', claimedPlanItemRefs: ['p1#P-003'] }),
      ],
      {
        planEdges: async () => {
          called = true;
          return [{ item: 'P-005', blockedBy: ['P-003'] }];
        },
      },
    );
    expect(called).toBe(true);
  });

  it('still does NOT read the plan for a LONE claimant — D-004, the fix that must not happen', async () => {
    // The one-line "fix" for the starved signal is to drop the peer clause so any
    // claimant triggers the read. That reintroduces the 90KB+ plan parse on the
    // common path (most agents are the only one on their plan), which is the cost
    // this gate exists for. Widening the OCCUPANCY SURFACE is the sanctioned fix;
    // widening the GATE is not. Asserted as a negative because nothing else fails
    // when it regresses — the signal simply gets more expensive, silently.
    let called = false;
    await deriveCouplings(
      'su-me',
      [
        row({
          ownerId: 'su-me',
          currentPlanSlug: 'p1',
          claimedItems: ['P-005'],
          claimedPlanItemRefs: ['p1#P-009'],
        }),
        row({ ownerId: 'su-peer', currentPlanSlug: 'p1' }),
      ],
      {
        planEdges: async () => {
          called = true;
          return [];
        },
      },
    );
    expect(called).toBe(false);
  });
});
