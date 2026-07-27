/**
 * coupled-topics.test.ts — P-023's acceptance, plus the guards that keep the
 * projection from going quietly dead (plan unified-agent-state-plane-2026-07-27,
 * rulings D-081 / D-082).
 *
 * The three acceptance criteria from the item are covered explicitly:
 *   · a coupled peer's topic activity reaches an agent through a read-time
 *     projection with ZERO rows written to `coord_entity_subscriptions`;
 *   · a test proves the feed NARROWS automatically as coupling decays;
 *   · an out-of-audience topic never appears.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  deriveTopicsFromPeerItems,
  deriveCoupledTopics,
  COUPLED_TOPIC_CAP,
  COUPLED_TOPIC_PEERS_NAMED,
  type CoupledTopicSources,
} from './coupled-topics';
import type { DerivedCoupling } from './couplings';

const SELF = 'su-self';
const PEER_A = 'su-peer-a';
const PEER_B = 'su-peer-b';
const STRANGER = 'su-stranger';

const coupled = (...ids: string[]): DerivedCoupling[] =>
  ids.map((ownerId) => ({ ownerId, because: 'same fleet' }));

const mapOf = (o: Record<string, readonly string[]>): ReadonlyMap<string, readonly string[]> =>
  new Map(Object.entries(o));

/**
 * Strip comments so a structural scan reads CODE, not prose.
 *
 * Both modules deliberately NAME the things they must never do (`this writes
 * zero rows to coord_entity_subscriptions`, `not plan_item_claims`) — that
 * documentation is the point, and a raw substring scan would red on the very
 * comment explaining the guarantee. Scanning the stripped body asserts the
 * behaviour instead of the wording; the non-vacuity checks below prove the
 * stripped text is still real code.
 */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('deriveTopicsFromPeerItems — the pure composition', () => {
  it("surfaces a coupled peer's topics, with the peer and item that produced them", () => {
    const out = deriveTopicsFromPeerItems(
      SELF,
      coupled(PEER_A),
      mapOf({ [PEER_A]: ['WI-6386'] }),
      mapOf({ 'WI-6386': ['gate-dx', 'papercusp-improvement'] }),
    );

    expect(out.map((t) => t.topic)).toEqual(['gate-dx', 'papercusp-improvement']);
    expect(out[0]).toMatchObject({ viaPeers: [PEER_A], viaItems: ['WI-6386'] });
    expect(out[0]!.because).toContain(PEER_A);
    expect(out[0]!.because).toContain('WI-6386');
  });

  it('merges peers and items onto one topic, ranking the most-corroborated first', () => {
    const out = deriveTopicsFromPeerItems(
      SELF,
      coupled(PEER_A, PEER_B),
      mapOf({ [PEER_A]: ['WI-1'], [PEER_B]: ['WI-2'] }),
      mapOf({ 'WI-1': ['shared', 'solo-a'], 'WI-2': ['shared'] }),
    );

    expect(out[0]!.topic).toBe('shared');
    expect(out[0]!.viaPeers).toEqual([PEER_A, PEER_B]);
    expect(out[0]!.viaItems).toEqual(['WI-1', 'WI-2']);
    expect(out.map((t) => t.topic)).toContain('solo-a');
  });

  it('EXCLUDES the caller’s own work — the feed is what peers are into, not you', () => {
    const out = deriveTopicsFromPeerItems(
      SELF,
      // A malformed derivation that leaked self through is still filtered here.
      coupled(SELF),
      mapOf({ [SELF]: ['WI-mine'] }),
      mapOf({ 'WI-mine': ['my-own-topic'] }),
    );
    expect(out).toEqual([]);
  });

  it('is total: malformed rows, missing items and untagged items contribute nothing', () => {
    const out = deriveTopicsFromPeerItems(
      SELF,
      [...coupled(PEER_A), null as unknown as DerivedCoupling, { ownerId: '  ' } as DerivedCoupling],
      mapOf({ [PEER_A]: ['WI-untagged', '  ', 'WI-ok'] }),
      mapOf({ 'WI-ok': ['real', '   '] }),
    );
    expect(out.map((t) => t.topic)).toEqual(['real']);
  });

  it('caps the projection so one heavily-tagged item cannot unbound the payload', () => {
    const many = Array.from({ length: COUPLED_TOPIC_CAP + 15 }, (_, i) => `topic-${String(i).padStart(3, '0')}`);
    const out = deriveTopicsFromPeerItems(
      SELF,
      coupled(PEER_A),
      mapOf({ [PEER_A]: ['WI-1'] }),
      mapOf({ 'WI-1': many }),
    );
    expect(out).toHaveLength(COUPLED_TOPIC_CAP);
  });

  it('names a bounded number of peers in `because`, summarising the rest', () => {
    const peers = Array.from({ length: COUPLED_TOPIC_PEERS_NAMED + 3 }, (_, i) => `su-p${i}`);
    const items = Object.fromEntries(peers.map((p, i) => [p, [`WI-${i}`]]));
    const tags = Object.fromEntries(peers.map((_, i) => [`WI-${i}`, ['hot']]));

    const out = deriveTopicsFromPeerItems(SELF, coupled(...peers), mapOf(items), mapOf(tags));
    expect(out[0]!.because).toContain(`+${peers.length - COUPLED_TOPIC_PEERS_NAMED} more`);
  });
});

describe('the audience boundary — an out-of-audience topic never appears', () => {
  it('never surfaces a topic reachable only through a NON-coupled agent', () => {
    // The stranger holds an item tagged `secret-topic`. They are not in the
    // caller's coupling set, so nothing they work may surface — this is the
    // roster boundary the projection inherits from deriveCouplings (D-081 (b)).
    const out = deriveTopicsFromPeerItems(
      SELF,
      coupled(PEER_A),
      mapOf({ [PEER_A]: ['WI-ok'], [STRANGER]: ['WI-secret'] }),
      mapOf({ 'WI-ok': ['visible'], 'WI-secret': ['secret-topic'] }),
    );

    expect(out.map((t) => t.topic)).toEqual(['visible']);
    expect(JSON.stringify(out)).not.toContain('secret-topic');
  });

  it('drops a topic the moment its only peer leaves the coupling set', () => {
    const peerItems = mapOf({ [PEER_A]: ['WI-a'], [PEER_B]: ['WI-b'] });
    const tags = mapOf({ 'WI-a': ['topic-a'], 'WI-b': ['topic-b'] });

    const both = deriveTopicsFromPeerItems(SELF, coupled(PEER_A, PEER_B), peerItems, tags);
    expect(both.map((t) => t.topic).sort()).toEqual(['topic-a', 'topic-b']);

    // Same underlying data — only the coupling shrank.
    const one = deriveTopicsFromPeerItems(SELF, coupled(PEER_A), peerItems, tags);
    expect(one.map((t) => t.topic)).toEqual(['topic-a']);
  });
});

describe('deriveCoupledTopics — the orchestrator', () => {
  const sourcesFor = (
    peerItems: Record<string, readonly string[]>,
    tags: Record<string, readonly string[]>,
  ): CoupledTopicSources => ({
    peerWorkItems: async (ids) =>
      new Map(Object.entries(peerItems).filter(([k]) => ids.includes(k))),
    itemTopics: async (refs) => new Map(Object.entries(tags).filter(([k]) => refs.includes(k))),
    feedForTopic: async (topic) => [
      { kind: 'issue', ref: `ref-for-${topic}`, title: `about ${topic}`, state: 'open' },
    ],
  });

  it("reaches an agent: a coupled peer's topic activity arrives WITH its feed", async () => {
    const out = await deriveCoupledTopics(
      SELF,
      coupled(PEER_A),
      sourcesFor({ [PEER_A]: ['WI-6386'] }, { 'WI-6386': ['gate-dx'] }),
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.topic).toBe('gate-dx');
    expect(out[0]!.items).toEqual([
      { kind: 'issue', ref: 'ref-for-gate-dx', title: 'about gate-dx', state: 'open' },
    ]);
  });

  it('NARROWS as coupling decays — the same sources, a smaller coupling set', async () => {
    const sources = sourcesFor(
      { [PEER_A]: ['WI-a'], [PEER_B]: ['WI-b'] },
      { 'WI-a': ['topic-a'], 'WI-b': ['topic-b'] },
    );

    const wide = await deriveCoupledTopics(SELF, coupled(PEER_A, PEER_B), sources);
    expect(wide.map((t) => t.topic).sort()).toEqual(['topic-a', 'topic-b']);

    const narrowed = await deriveCoupledTopics(SELF, coupled(PEER_A), sources);
    expect(narrowed.map((t) => t.topic)).toEqual(['topic-a']);

    // Fully decayed coupling ⇒ an empty projection, with no cleanup step
    // anywhere: there was never any stored state to remove (D-044).
    const gone = await deriveCoupledTopics(SELF, [], sources);
    expect(gone).toEqual([]);
  });

  it('is fail-soft per leg: a dead feed read still surfaces the topic', async () => {
    const out = await deriveCoupledTopics(SELF, coupled(PEER_A), {
      peerWorkItems: async () => new Map([[PEER_A, ['WI-1']]]),
      itemTopics: async () => new Map([['WI-1', ['still-here']]]),
      feedForTopic: async () => {
        throw new Error('feed down');
      },
    });

    expect(out.map((t) => t.topic)).toEqual(['still-here']);
    expect(out[0]!.items).toEqual([]);
  });

  it('degrades to empty — never throws — when a source leg fails outright', async () => {
    await expect(
      deriveCoupledTopics(SELF, coupled(PEER_A), {
        peerWorkItems: async () => {
          throw new Error('pg down');
        },
      }),
    ).resolves.toEqual([]);
  });

  it('skips the feed fan-out entirely when only the topic list is wanted', async () => {
    let feedCalls = 0;
    const out = await deriveCoupledTopics(
      SELF,
      coupled(PEER_A),
      {
        peerWorkItems: async () => new Map([[PEER_A, ['WI-1']]]),
        itemTopics: async () => new Map([['WI-1', ['t']]]),
        feedForTopic: async () => {
          feedCalls += 1;
          return [];
        },
      },
      { withFeed: false },
    );

    expect(out.map((t) => t.topic)).toEqual(['t']);
    expect(feedCalls).toBe(0);
  });

  it('does no work at all when the caller has no coupled peers', async () => {
    let called = 0;
    const out = await deriveCoupledTopics(SELF, [], {
      peerWorkItems: async () => {
        called += 1;
        return new Map();
      },
    });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });
});

/**
 * ⚠ THE GUARD THAT MATTERS MOST. A structural interface over hand-built
 * fixtures tests the code against ITSELF: every test above would still pass if
 * the projection were keyed off an id space that does not exist in production.
 * That is exactly how the `currentFiles` coupling signal shipped green and
 * derived nothing (EI-18772330418885814; class EI-18801000813757662), and it is
 * what D-082 caught here before this module was written.
 */
describe('D-082 — the id space, pinned against the producer', () => {
  const sourceText = codeOnly(
    readFileSync(new URL('../agent-tools/coordination/coupled-topic-sources.ts', import.meta.url), 'utf8'),
  );

  it('is non-vacuous: the source module was actually read', () => {
    // The non-vacuity rule every structural-scan gate owes (D-076).
    expect(sourceText.length).toBeGreaterThan(500);
    expect(sourceText).toContain('fetchPeerWorkItems');
  });

  it('keys peer objects off `taken_by`/`feature_id`, the WORK-ITEM id space', () => {
    expect(sourceText).toContain('taken_by');
    expect(sourceText).toContain('feature_id');
  });

  it('never keys off `plan_item_claims` — those ids can never match a topic tag', () => {
    // `claimedItems` (plan_item_claims → `P-023`) and topic tags (coord_links
    // src_ref → `WI-…`/`EI-…`) are disjoint id spaces. Reading the roster field
    // whose name suggests otherwise is the trap D-082 records.
    expect(sourceText).not.toContain('plan_item_claims');
  });

  it('REGRESSION: plan-item ids against work-item-keyed tags derive nothing', () => {
    // This is the production failure that would have shipped silently. Encoded
    // as behaviour so re-introducing the wrong field reds this test rather than
    // producing an empty feed nobody notices.
    const out = deriveTopicsFromPeerItems(
      SELF,
      coupled(PEER_A),
      mapOf({ [PEER_A]: ['P-023', 'P-013'] }), // what `claimedItems` actually holds
      mapOf({ 'WI-6386': ['gate-dx'], 'EI-1880': ['papercusp-improvement'] }), // what tags key on
    );
    expect(out).toEqual([]);
  });
});

describe('D-081 (c) — a PULL projection, structurally', () => {
  const moduleText = codeOnly(readFileSync(new URL('./coupled-topics.ts', import.meta.url), 'utf8'));
  const sourceText = codeOnly(
    readFileSync(new URL('../agent-tools/coordination/coupled-topic-sources.ts', import.meta.url), 'utf8'),
  );

  it('is non-vacuous: both modules were actually read', () => {
    expect(moduleText).toContain('deriveCoupledTopics');
    expect(sourceText).toContain('coupledTopicSourcesFor');
  });

  it('writes ZERO subscription rows — no INSERT, no subscription table, anywhere', () => {
    for (const [name, text] of [
      ['coupled-topics.ts', moduleText],
      ['coupled-topic-sources.ts', sourceText],
    ] as const) {
      expect(text, `${name} must not write subscriptions`).not.toContain('coord_entity_subscriptions');
      expect(text, `${name} must not write predicate watches`).not.toContain('predicate_watches');
      expect(text, `${name} must not INSERT`).not.toMatch(/\bINSERT\s+INTO\b/i);
    }
  });

  it('keeps the derivation pure: the core imports no store', () => {
    expect(moduleText).not.toContain('@papercusp/db-org');
    expect(moduleText).not.toContain('getOrgPg');
  });
});
