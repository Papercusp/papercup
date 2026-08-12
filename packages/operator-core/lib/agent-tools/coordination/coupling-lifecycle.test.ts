/**
 * coupling-lifecycle.test.ts — P-013's acceptance: the coupling LIFECYCLE across
 * BOTH real surfaces, and the byte-identity of the base payload under expansion
 * (plan `agent-state-plane-verification-2026-07-27`, item P-013; the surfaces
 * themselves are `unified-agent-state-plane-2026-07-27` P-023 / P-031).
 *
 * WHAT WAS ALREADY COVERED, AND WHAT WAS NOT. The three PURE cores are well
 * tested in isolation — `resolveCoupledPeers` (couplings.test.ts),
 * `buildCoupledExpansion` (coupled-expansion.test.ts) and `deriveCoupledTopics`
 * (coupled-topics.test.ts). What had NO test at all was the part that makes a
 * `coord:decouple` actually reach a reader: the two ASSEMBLIES that wire the
 * declared edges into each surface (`tools/presence.ts`'s coupling block and
 * `coupled-topics-read.ts`). Both were unreferenced by any test file when this
 * was written, and the only two existing tests that name `include_coupling`
 * (presence-cost.test.ts, tools/coordination-reads-shape.test.ts) build the
 * `expanded[]` block as a HAND-WRITTEN LITERAL — so neither exercises the union
 * and neither touches suppression at all.
 *
 * ⚠ THE VACUITY THIS FILE IS BUILT TO AVOID. "Assert it disappears after
 * decouple" passes trivially against a surface that never showed it in the first
 * place — and the coupled-topic feed is empty in production RIGHT NOW for an
 * unrelated reason (measured 2026-07-27: only 4 work-items workspace-wide carry
 * a non-null `taken_by`, and none of those 4 is topic-tagged, against 29,629
 * live issue→topic tags). A decouple test written against the live feed would
 * therefore be green whether or not suppression works. Every disappearance
 * assertion below is consequently PAIRED with the known-positive it subtracts
 * from: the peer is proven PRESENT on both surfaces first, in the same test.
 *
 * ⚠ WHY THE CHAINS ARE RE-COMPOSED HERE. The two assemblies open PG, so their
 * exact composition is mirrored below rather than imported. That alone would be
 * testing the test, which is why the structural section pins that the PRODUCTION
 * modules use this same composition — behaviour proves the chain has the
 * property, structure proves the shipped surfaces are that chain.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  resolveCoupledPeers,
  type CouplingEdge,
  type CouplingState,
  type DerivedCoupling,
} from '../../coord/couplings';
import { buildCoupledExpansion } from '../../coord/coupled-expansion';
import { deriveCoupledTopics, type CoupledTopicSources } from '../../coord/coupled-topics';

const SELF = 'su-self';
const PEER = 'su-peer';
const OTHER = 'su-other';

/** Strip comments so a structural scan reads CODE, not prose — the same helper
 *  coupled-topics.test.ts uses, for the same reason: these modules deliberately
 *  NAME the things they must do, and a raw scan would pass on the comment. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const derivedEdge = (ownerId: string): DerivedCoupling => ({
  ownerId,
  relation: 'holds-a-lock-on',
  because: 'you are both working in packages/operator-core',
});

/** A declared edge as `listCouplingsFor` returns it — normalized (least, greatest). */
const declaredEdge = (peer: string, state: CouplingState): CouplingEdge => {
  const [agentA, agentB] = [SELF, peer].sort() as [string, string];
  return {
    agentA,
    agentB,
    state,
    declaredBy: SELF,
    reason: state === 'coupled' ? 'both on the sync resolver' : 'shared work shipped',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    expiresAt: null,
  };
};

/** Roster rows in the shape `coord:presence` actually emits. */
const row = (ownerId: string) => ({
  ownerId,
  ownerLabel: `su · ${ownerId}`,
  sessionState: 'live',
  intent: `${ownerId} is working`,
  intentStale: false,
  lastActiveSecAgo: 5,
});
/**
 * ⚠ A FRESH ARRAY PER CALL, DELIBERATELY. A shared module-level fixture makes
 * the no-mutation assertions below VACUOUS: the first test to run would absorb
 * any rewrite, so every later "before" snapshot already contains the damage and
 * compares equal to itself. Caught by mutation-testing this very file — with a
 * shared fixture, a projection that rewrote `intent` on the rows it reads left
 * all 11 tests green.
 */
const freshRows = () => [row(SELF), row(PEER), row(OTHER)];

/** Held work-items and their topic tags — the feed's real join, as data. */
const HELD: Record<string, readonly string[]> = { [PEER]: ['WI-1'], [OTHER]: ['WI-2'] };
const TAGS: Record<string, readonly string[]> = { 'WI-1': ['gate-dx'], 'WI-2': ['other-topic'] };

const SOURCES: CoupledTopicSources = {
  peerWorkItems: async (ids) =>
    new Map(ids.filter((i) => HELD[i]).map((i) => [i, HELD[i] as readonly string[]])),
  itemTopics: async (refs) =>
    new Map(refs.filter((r) => TAGS[r]).map((r) => [r, TAGS[r] as readonly string[]])),
};

/** SURFACE 1 — `tools/presence.ts`'s chain: edges → union → expanded[]. */
const presenceExpanded = (
  derived: DerivedCoupling[],
  edges: CouplingEdge[],
  rows: ReturnType<typeof freshRows> = freshRows(),
) => buildCoupledExpansion(resolveCoupledPeers(SELF, derived, edges), rows);

/** SURFACE 2 — `coupled-topics-read.ts`'s chain: edges → THE SAME union → feed. */
const coupledFeed = async (derived: DerivedCoupling[], edges: CouplingEdge[]) =>
  deriveCoupledTopics(
    SELF,
    resolveCoupledPeers(SELF, derived, edges).map((p) => ({
      ownerId: p.ownerId,
      because: p.derivedBecause ?? p.reason ?? 'coupled',
    })),
    SOURCES,
    { withFeed: false },
  );

describe('P-013 lifecycle — a coupling reaches BOTH surfaces, and a decouple removes it from BOTH', () => {
  it('KNOWN-POSITIVE: a declared coupling appears in coord:presence expanded[] AND in the coupled-topic feed', async () => {
    const edges = [declaredEdge(PEER, 'coupled')];
    const expansion = presenceExpanded([], edges);
    const feed = await coupledFeed([], edges);

    expect(expansion.expanded.map((e) => e.ownerId)).toEqual([PEER]);
    expect(expansion.total).toBe(1);
    expect(expansion.expanded[0]?.expandedBecause).toContain('declared by');

    // The feed half must be a REAL positive — every disappearance assertion in
    // this file subtracts from this, so an empty feed here would make the rest
    // of the suite vacuous rather than merely incomplete.
    expect(feed.map((f) => f.topic)).toEqual(['gate-dx']);
    expect(feed[0]?.viaPeers).toEqual([PEER]);
    expect(feed[0]?.viaItems).toEqual(['WI-1']);
  });

  it('DECOUPLE removes it from BOTH — a surface that retains it after decouple IS the defect', async () => {
    // Present first, in this same test: the subtraction below is measured
    // against a proven positive, never against an already-empty surface.
    const coupledEdges = [declaredEdge(PEER, 'coupled')];
    expect(presenceExpanded([], coupledEdges).expanded).toHaveLength(1);
    expect(await coupledFeed([], coupledEdges)).toHaveLength(1);

    const suppressed = [declaredEdge(PEER, 'suppressed')];
    const expansion = presenceExpanded([], suppressed);
    const feed = await coupledFeed([], suppressed);

    expect(expansion.expanded, 'coord:presence expanded[] RETAINED a decoupled peer').toEqual([]);
    expect(expansion.total).toBe(0);
    expect(feed, 'the coupled-topic feed RETAINED a decoupled peer').toEqual([]);
  });

  it('a decouple beats a LIVE derivation on BOTH surfaces — the next tick must not resurrect it', async () => {
    // The D-061 R4 property, at the surface level: the shared lock is still
    // really held, so the derivation keeps firing every read. Suppression must
    // still win on BOTH, or a decouple is a lie the moment a tick re-derives.
    const derived = [derivedEdge(PEER)];

    expect(presenceExpanded(derived, [declaredEdge(PEER, 'suppressed')]).expanded).toEqual([]);
    expect(await coupledFeed(derived, [declaredEdge(PEER, 'suppressed')])).toEqual([]);

    // …and that SAME derivation with no suppression does surface on both, so the
    // two assertions above are a real subtraction rather than an inert input.
    expect(presenceExpanded(derived, []).expanded.map((e) => e.ownerId)).toEqual([PEER]);
    expect((await coupledFeed(derived, [])).map((f) => f.topic)).toEqual(['gate-dx']);
  });

  it('decoupling ONE peer leaves the other coupled on BOTH surfaces — the subtraction is per-pair', async () => {
    const derived = [derivedEdge(PEER), derivedEdge(OTHER)];
    const edges = [declaredEdge(PEER, 'suppressed')];

    expect(presenceExpanded(derived, edges).expanded.map((e) => e.ownerId)).toEqual([OTHER]);
    expect((await coupledFeed(derived, edges)).map((f) => f.topic)).toEqual(['other-topic']);
  });

  it('the two surfaces agree on the peer SET at every stage of the lifecycle', async () => {
    // The property that makes "appears in BOTH / disappears from BOTH" a single
    // contract rather than two coincidences: one input, two projections, same
    // membership. A consumer that re-derived its own notion of "coupled" would
    // diverge here even when each surface looks self-consistent.
    const stages: Array<[string, DerivedCoupling[], CouplingEdge[], string[]]> = [
      ['no coupling', [], [], []],
      ['declared', [], [declaredEdge(PEER, 'coupled')], [PEER]],
      ['derived', [derivedEdge(PEER)], [], [PEER]],
      ['both peers derived', [derivedEdge(PEER), derivedEdge(OTHER)], [], [OTHER, PEER]],
      ['decoupled', [derivedEdge(PEER)], [declaredEdge(PEER, 'suppressed')], []],
    ];

    for (const [label, derived, edges, expected] of stages) {
      const viaPresence = presenceExpanded(derived, edges).expanded.map((e) => e.ownerId).sort();
      const viaFeed = [
        ...new Set((await coupledFeed(derived, edges)).flatMap((f) => f.viaPeers)),
      ].sort();
      expect(viaPresence, `presence disagreed at stage: ${label}`).toEqual(expected);
      expect(viaFeed, `the coupled-topic feed disagreed at stage: ${label}`).toEqual(expected);
    }
  });
});

describe('P-013 byte-identity — expansion APPENDS a block and rewrites nothing (D-053)', () => {
  const META = {
    summary: { active: 3 },
    etag: '5a96f1b69293aa34',
    as_of: '2026-07-27T23:26:52.359Z',
    scope: 'workspace',
  };

  it('the base payload is identical with and without expansion, differing ONLY by the appended keys', () => {
    // The two payloads are built over INDEPENDENT row arrays: the no-expansion
    // one is never handed to the projection, so if expansion rewrote anything
    // in the rows it read, `active` diverges here instead of both sides moving
    // together.
    const base = { ...META, active: freshRows() } as Record<string, unknown>;
    const rows = freshRows();
    const expansion = presenceExpanded([], [declaredEdge(PEER, 'coupled')], rows);
    // Assembled exactly as tools/presence.ts assembles it: `{ ...snapshot, active, ...coupling }`.
    const withExpansion: Record<string, unknown> = {
      ...META,
      active: rows,
      expanded: expansion.expanded,
      expandedTotal: expansion.total,
    };

    expect(expansion.expanded, 'the expansion under test must be non-empty').toHaveLength(1);
    expect(Object.keys(withExpansion).filter((k) => !(k in base)).sort()).toEqual([
      'expanded',
      'expandedTotal',
    ]);
    for (const key of Object.keys(base)) {
      expect(
        JSON.stringify(withExpansion[key]),
        `expansion rewrote base key \`${key}\` — it may only APPEND`,
      ).toBe(JSON.stringify(base[key]));
    }
  });

  it('does not mutate the roster rows it projects from', () => {
    const rows = freshRows();
    const before = JSON.stringify(freshRows());
    const expansion = presenceExpanded([derivedEdge(OTHER)], [declaredEdge(PEER, 'coupled')], rows);
    expect(expansion.expanded).toHaveLength(2);
    expect(JSON.stringify(rows), 'the projection rewrote the rows it only reads').toBe(before);
  });

  it('describes the same peer identically in expanded[] and in active[] — one payload must not contradict itself', () => {
    // presence.ts projects the block from the PRE-overlay snapshot rows while
    // `active` is the POST-overlay array. Every overlay today is purely additive
    // (`{ ...r, modes }`, `{ ...r, parkedOn }`, `{ ...r, coordHook }`), so the
    // two agree. One that REWROTE a projected field — an idle-prefixing intent
    // overlay is the obvious future candidate — would make a single payload
    // describe the same peer two different ways, and reds here.
    // `overlaid` is built from an INDEPENDENT pristine array — it stands in for
    // the post-overlay `active[]`, and must not be able to inherit a rewrite the
    // projection made to the rows it was given.
    const overlaid = freshRows().map((r) => ({ ...r, modes: ['auto'], parkedOn: ['coord:inbox-wake'] }));
    const expansion = presenceExpanded([], [declaredEdge(PEER, 'coupled')]);

    expect(expansion.expanded).toHaveLength(1);
    for (const entry of expansion.expanded) {
      const active = overlaid.find((r) => r.ownerId === entry.ownerId);
      expect(active, `expanded[] named a peer absent from active[]: ${entry.ownerId}`).toBeDefined();
      expect(entry.ownerLabel).toBe(active?.ownerLabel);
      expect(entry.sessionState).toBe(active?.sessionState);
      expect(entry.intent).toBe(active?.intent);
      expect(entry.intentStale).toBe(active?.intentStale);
      expect(entry.lastActiveSecAgo).toBe(active?.lastActiveSecAgo);
    }
  });
});

describe('P-013 structural — every surface that projects coupling routes through the suppression-carrying union', () => {
  /**
   * DISCOVERED, not enumerated. A hardcoded list of two files cannot catch the
   * failure this guard exists for — a THIRD surface added later that derives
   * couplings without ever reading the declared edges, and so shows a decoupled
   * peer forever while every test above still passes.
   */
  const COORD_DIR = fileURLToPath(new URL('.', import.meta.url));
  const PROJECTS_COUPLING = /\b(deriveCouplings|buildCoupledExpansion|deriveCoupledTopics)\s*\(/;

  const consumers = readdirSync(COORD_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('__tests__'))
    .map((f) => [f.split('\\').join('/'), codeOnly(readFileSync(join(COORD_DIR, f), 'utf8'))] as const)
    .filter(([, text]) => PROJECTS_COUPLING.test(text));

  it('is non-vacuous: the scan found the real consumer population', () => {
    // The corpus floor. A refactor that renames the projectors would otherwise
    // empty this list and turn every assertion below into a green no-op.
    expect(consumers.length).toBeGreaterThanOrEqual(2);
    expect(consumers.map(([f]) => f)).toEqual(
      expect.arrayContaining(['tools/presence.ts', 'coupled-topics-read.ts']),
    );
  });

  it('every coupling-projecting surface resolves its peer set through resolveCoupledPeers', () => {
    for (const [file, text] of consumers) {
      expect(text, `${file} projects coupling without the shared union`).toMatch(
        /resolveCoupledPeers\s*\(/,
      );
    }
  });

  it('every one of them FETCHES the declared edges — the half a decouple travels on', () => {
    // `resolveCoupledPeers` can only subtract a suppression it is HANDED. A
    // surface that derives couplings and passes `[]` for the declared edges
    // still calls the union, still looks correct, and can never be decoupled
    // from — so calling the union is not on its own sufficient.
    for (const [file, text] of consumers) {
      expect(text, `${file} never reads declared edges — a coord:decouple cannot reach it`).toMatch(
        /listCouplingsFor\s*\(/,
      );
    }
  });
});
