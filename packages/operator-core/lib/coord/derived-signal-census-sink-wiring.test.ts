/**
 * derived-signal-census-sink-wiring.test.ts — P-009's RECURRENCE GUARD.
 *
 * THE DEFECT THIS PINS: the dead-signal census `observe` sink was wired into
 * `coord:presence` ONLY — a surface with 11 calls in its entire history — so ZERO
 * rows in `tool_invocations` had ever carried `metadata_json.derivedSignals`. The
 * instrument built to answer "has this derived relation ever fired in production?"
 * was attached to the one path that never runs, which is why `holds-a-lock-on`
 * could sit dead for 12 days with nothing reporting it (D-088).
 *
 * ⚠ WHY THESE ASSERTIONS ARE SHAPED THIS WAY — read before "simplifying" them.
 * A test that merely checked `censusObserverFor` EXISTS, or that a file contains
 * the string `observe`, would pass against the exact broken state above: the
 * helper existed and presence.ts already passed a sink. The only assertion that
 * fails against the pre-fix tree is a BEHAVIOURAL one — call the real function on
 * an executing path and prove the census reached the ctx metadata channel. So each
 * case below drives the actual exported function with `deriveCouplings` stubbed to
 * invoke whatever `observe` it was handed, and asserts the payload landed.
 *
 * These are the two paths that ACTUALLY execute: `coord:send`'s divergence read
 * (the only coupling derivation that runs at volume) and the coupled-topics read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  censusObserverFor,
  censusDerivedSignals,
  DERIVED_SIGNAL_CENSUS_KEY,
  DERIVED_SIGNAL_CENSUS_VERSION,
  type DerivedSignalCensus,
} from './derived-signal-census';

/** A census with one armed leg — shaped by the real builder, never hand-faked. */
function sampleCensus(): DerivedSignalCensus {
  return censusDerivedSignals(
    {
      roster: { armed: true, inputs: 3 },
      heldFiles: { armed: true, inputs: 2 },
      planEdges: { armed: false, inputs: 0 },
      recentPartners: { armed: false, inputs: 0 },
    },
    [],
  );
}

describe('censusObserverFor — the one place the sink is built', () => {
  it('publishes the census under the documented key', () => {
    const seen: Record<string, unknown>[] = [];
    const observe = censusObserverFor({ metadata: (d: Record<string, unknown>) => void seen.push(d) });
    expect(observe).toBeTypeOf('function');

    observe!(sampleCensus());

    expect(seen).toHaveLength(1);
    const published = seen[0]![DERIVED_SIGNAL_CENSUS_KEY] as DerivedSignalCensus;
    expect(published).toBeDefined();
    expect(published.v).toBe(DERIVED_SIGNAL_CENSUS_VERSION);
    // Every relation is reported, including the zeros — a census that omitted its
    // zeros could not report the only thing it exists to report.
    expect(Object.keys(published.relations).length).toBeGreaterThan(0);
  });

  it('returns undefined when the ctx carries no metadata channel, rather than throwing', () => {
    // Non-tool callers (tests, scripts, internal re-use) must wire no instrument
    // and must not crash: every call site spreads the result conditionally.
    expect(censusObserverFor({})).toBeUndefined();
    expect(censusObserverFor(null)).toBeUndefined();
    expect(censusObserverFor(undefined)).toBeUndefined();
    expect(censusObserverFor({ metadata: 'not-a-function' })).toBeUndefined();
  });

  it('swallows a throwing metadata channel — an instrument must never fail its subject', () => {
    const observe = censusObserverFor({
      metadata: () => {
        throw new Error('metadata channel exploded');
      },
    });
    expect(() => observe!(sampleCensus())).not.toThrow();
  });
});

describe('the census reaches the paths that ACTUALLY execute', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('coord:send divergence read (readPeerRelations) forwards the sink into the derivation', async () => {
    // FAILS PRE-FIX: `readPeerRelations` accepted no `observe` and passed none, so
    // the derivation on the ONE volume path was never observed.
    const observed: DerivedSignalCensus[] = [];

    vi.doMock('../agent-tools/coordination/presence-snapshot', () => ({
      resolvePresenceScope: async () => ({}),
      assemblePresenceSnapshot: async () => ({ active: [{ ownerId: 'peer-1' }] }),
    }));
    vi.doMock('../agent-tools/coordination/coupling-sources', () => ({
      couplingSourcesFor: () => ({}),
    }));
    vi.doMock('./couplings', () => ({
      listCouplingsFor: async () => [],
      resolveCoupledPeers: () => [],
      DERIVED_COUPLING_RELATIONS: [],
    }));
    vi.doMock('../agent-tools/locks/coordination-domain', () => ({
      lockCoordinationDomain: () => '/repo',
    }));
    // The stub stands in for the real derivation and simply exercises whatever
    // sink it was handed — that is precisely the wiring under test.
    vi.doMock('./coupling-derivation', () => ({
      deriveCouplings: async (_self: string, _rows: unknown[], sources: { observe?: (c: DerivedSignalCensus) => void }) => {
        sources?.observe?.(sampleCensus());
        return [];
      },
    }));

    const { readPeerRelations } = await import('../agent-tools/coordination/coupling-divergence-stamp');
    await readPeerRelations('self-owner', {
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      observe: (c) => void observed.push(c),
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]!.v).toBe(DERIVED_SIGNAL_CENSUS_VERSION);
  });

  it('resolveCouplingDivergenceStamps forwards the sink through to its reader', async () => {
    // The hop `send.ts` actually calls. Pre-fix, `observe` was not in the opts at
    // all, so a sink supplied by the tool layer was dropped on the floor here.
    const { resolveCouplingDivergenceStamps } = await import(
      '../agent-tools/coordination/coupling-divergence-stamp'
    );

    let sinkReachedReader = false;
    const fakeReader = async (
      _self: string,
      opts: { observe?: (c: DerivedSignalCensus) => void },
    ) => {
      sinkReachedReader = typeof opts.observe === 'function';
      opts.observe?.(sampleCensus());
      return new Map<string, readonly never[]>();
    };

    await resolveCouplingDivergenceStamps(
      {
        selfOwnerId: 'self-owner',
        to: ['peer-1'],
        // A comparable claim is required or the gate short-circuits before any IO.
        sections: [{ forYouBecause: { relation: 'holds-a-lock-on', ref: 'some/file.ts' } }],
        workspaceId: 'ws',
        harnessSlug: 'papercusp',
        observe: () => {},
      },
      fakeReader,
    );

    expect(sinkReachedReader).toBe(true);
  });

  it('readCoupledTopics forwards the sink into the derivation', async () => {
    // FAILS PRE-FIX: `readCoupledTopics` took only { withFeed } and passed the
    // bare `couplingSourcesFor(...)` result, so no sink could reach the derivation.
    const observed: DerivedSignalCensus[] = [];

    vi.doMock('../agent-tools/coordination/presence-snapshot', () => ({
      resolvePresenceScope: async () => ({}),
      assemblePresenceSnapshot: async () => ({ active: [{ ownerId: 'peer-1' }] }),
    }));
    vi.doMock('../agent-tools/coordination/coupling-sources', () => ({
      couplingSourcesFor: () => ({}),
    }));
    vi.doMock('../agent-tools/coordination/coupled-topic-sources', () => ({
      coupledTopicSourcesFor: () => ({}),
    }));
    vi.doMock('./couplings', () => ({
      listCouplingsFor: async () => [],
      resolveCoupledPeers: () => [],
      DERIVED_COUPLING_RELATIONS: [],
    }));
    vi.doMock('./coupled-topics', () => ({
      deriveCoupledTopics: async () => [],
    }));
    vi.doMock('./coupling-derivation', () => ({
      deriveCouplings: async (_self: string, _rows: unknown[], sources: { observe?: (c: DerivedSignalCensus) => void }) => {
        sources?.observe?.(sampleCensus());
        return [];
      },
    }));

    const { readCoupledTopics } = await import('../agent-tools/coordination/coupled-topics-read');
    await readCoupledTopics(
      'self-owner',
      { workspaceId: 'ws', harnessSlug: 'papercusp' },
      { withFeed: false, observe: (c) => void observed.push(c) },
    );

    expect(observed).toHaveLength(1);
    expect(observed[0]!.v).toBe(DERIVED_SIGNAL_CENSUS_VERSION);
  });
});
