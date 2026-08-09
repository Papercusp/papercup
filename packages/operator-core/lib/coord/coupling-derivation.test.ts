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

  it('couples peers holding an overlapping file, naming it', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', currentFiles: ['a.ts', 'b.ts'] }),
      row({ ownerId: 'su-peer', currentFiles: ['b.ts', 'c.ts'] }),
      row({ ownerId: 'su-far', currentFiles: ['z.ts'] }),
    ]);
    expect(derived).toEqual([{ ownerId: 'su-peer', relation: 'shared-file', because: 'both working in b.ts' }]);
  });

  it('bounds how many overlapping files it names and summarises the rest', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', currentFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }),
      row({ ownerId: 'su-peer', currentFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }),
    ]);
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'shared-file', because: 'both working in a.ts, b.ts (+2 more shared files)' },
    ]);
  });

  it('couples peers parked on the SAME awaited event', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', awaitingEventKey: 'fleet:x:gate' }),
      row({ ownerId: 'su-peer', awaitingEventKey: 'fleet:x:gate' }),
      row({ ownerId: 'su-other', awaitingEventKey: 'fleet:y:gate' }),
    ]);
    expect(derived).toEqual([{ ownerId: 'su-peer', relation: 'awaits', because: 'both awaiting fleet:x:gate' }]);
  });

  it('emits EVERY signal a peer trips, in a fixed order', () => {
    // The reason the derived channel carries reasons at all (D-078 (a)): the
    // interesting answer is that a peer is coupled three ways, not one.
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
    // The shared `alpha` fleet is left in the fixture ON PURPOSE: it contributes
    // NOTHING (D-054), so this doubles as a second guard that the cut edge stays
    // cut even on a row that trips every other signal.
    expect(derived.map((d) => d.because)).toEqual([
      'both working in x.ts',
      'both awaiting gate:1',
    ]);
  });

  it('never couples the caller to itself', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', fleetSlug: 'alpha', currentFiles: ['x.ts'] }),
    ]);
    expect(derived).toEqual([]);
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
    // The junk entries are now EXERCISED INTO AN EMITTED EDGE rather than sitting
    // beside one: the caller's list is well-formed, so the peer's `[null, 7,
    // 'x.ts']` must be cleaned down to the single real overlap. Until 2026-08-09
    // this asserted a `same-fleet` edge derived from `fleetSlug`, which meant the
    // malformed `currentFiles` never actually reached the emit path it names.
    const derived = deriveCouplingsFromRoster('su-me', [
      { ownerId: 'su-me', fleetSlug: 'alpha', currentFiles: ['x.ts'] },
      { ownerId: 'su-peer', fleetSlug: 'alpha', currentFiles: [null, 7, 'x.ts'] },
    ]);
    expect(derived).toEqual([
      { ownerId: 'su-peer', relation: 'shared-file', because: 'both working in x.ts' },
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
    const rows = [
      row({ ownerId: 'su-me', currentFiles: ['x.ts'], awaitingEventKey: 'gate:1' }),
      row({ ownerId: 'su-peer', currentFiles: ['x.ts'], awaitingEventKey: 'gate:1' }),
    ];
    const peers = resolveCoupledPeers('su-me', deriveCouplingsFromRoster('su-me', rows), []);
    expect(peers).toEqual([
      {
        ownerId: 'su-peer',
        source: 'derived',
        derivedBecause: 'both working in x.ts; both awaiting gate:1',
        // D-087: the typed half survives END-TO-END, derivation through union —
        // asserted here on the real path, not only on hand-built rows.
        derivedRelations: ['shared-file', 'awaits'],
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
      'currentFiles',
      'awaitingEventKey',
      'currentPlanSlug',
      'claimedItems',
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
});
