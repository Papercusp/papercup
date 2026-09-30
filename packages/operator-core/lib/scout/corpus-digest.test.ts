/**
 * corpus-digest.test.ts — unit tests for the "state of the Hive" corpus digest
 * (hive-creative-ideation-2026-06-08 P-003 / B1).
 *
 * Pure over injected readers (the change-feed test pattern): we feed fixture
 * substrates and assert the four meta-pattern lanes + the reverts substrate +
 * the corpus rollup, the salience→weight normalisation, defensive reader
 * isolation, schema self-validation, and the structural contract with
 * scout/types.ts (the shape the P-004 ideators consume).
 */

import { describe, it, expect, vi } from 'vitest';
import type { ChangeFeedEntry } from '../curation/change-feed';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import type { CorpusDigest, MetaPattern as TypesMetaPattern } from './types';
import {
  buildFederatedMapLane,
  buildReworkLessons,
  synthesizeStateOfHive,
  revertWeight,
  DigestSchema,
  MetaPatternSchema,
  type StateOfHiveReaders,
  type RevertRecord,
  type SpendRecord,
  type DeferralRecord,
  type StructuredObservationRecord,
} from './corpus-digest';
import { flattenDigest, renderDigest } from './lenses';

const NOW = Date.parse('2026-06-08T12:00:00Z');
const daysAgo = (d: number): string => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const msAgo = (d: number): number => NOW - d * 24 * 60 * 60 * 1000;

const friction: ImprovementCandidate[] = [
  // Recurring friction: same stable signature ×2, both open.
  {
    id: 'EI-1',
    kind: 'bug',
    scope: 'operator',
    title: 'lock contention blocks file edits',
    state: 'open',
    updatedAt: daysAgo(1),
  },
  {
    id: 'EI-2',
    kind: 'bug',
    scope: 'operator',
    title: 'lock contention blocks file edits',
    state: 'open',
    updatedAt: daysAgo(5),
  },
  // One-off friction (count=1) — must NOT appear in recurringFriction.
  {
    id: 'EI-3',
    kind: 'bug',
    scope: 'operator',
    title: 'flaky vitest timeout in operator core',
    state: 'open',
    updatedAt: daysAgo(2),
  },
  // Capability gap: net-new feature ask (count=1, still surfaced as a gap).
  {
    id: 'EI-4',
    kind: 'feature',
    scope: 'operator',
    title: 'add a bulk export tool for plans',
    state: 'open',
    updatedAt: daysAgo(3),
  },
  // Capability gap via keyword, recurring ×2 ("no way to ...").
  {
    id: 'EI-5',
    kind: 'change',
    scope: 'operator',
    title: 'no way to rename a harness',
    state: 'open',
    updatedAt: daysAgo(2),
  },
  {
    id: 'EI-6',
    kind: 'change',
    scope: 'operator',
    title: 'no way to rename a harness',
    state: 'resolved',
    updatedAt: daysAgo(8),
  },
];

const spend: SpendRecord[] = [
  { harness: 'papercup', role: 'worker', costUsd: 12.5, inputTokens: 1_000_000, outputTokens: 200_000, runs: 40 },
  { harness: 'papercup', role: 'validator', costUsd: 3.25, inputTokens: 300_000, outputTokens: 50_000, runs: 12 },
  { harness: null, role: null, costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 2 }, // dropped (no spend)
];

const deferrals: DeferralRecord[] = [
  // Chronic: same thing deferred ×2 across two plans (one a hard needs-human stop).
  { planSlug: 'plan-a', refId: 'P-003', source: 'item', status: 'blocked', text: 'wire the cadence trigger primitive' },
  {
    planSlug: 'plan-b',
    refId: 'P-008',
    source: 'item',
    status: 'needs-human',
    text: 'wire the cadence trigger primitive',
  },
  // One-off deferred decision.
  {
    planSlug: 'plan-c',
    refId: 'D-009',
    source: 'decision',
    status: 'decision',
    text: 'defer the gym A/B threshold tuning',
  },
];

const reverts: RevertRecord[] = [
  { workItemId: 'F-1', from: 'passed', to: 'failing', actor: 'ci', ts: daysAgo(1) }, // regression w=5
  { workItemId: 'F-1', from: 'validating', to: 'todo', actor: 'worker', ts: daysAgo(2) }, // regression w=1
  { workItemId: 'F-2', from: 'failing', to: 'todo', actor: 'worker', ts: daysAgo(1) }, // recovery, w=0 → excluded
  { workItemId: 'F-3', from: 'passed', to: 'deprecated', actor: 'reviewer', ts: daysAgo(1) }, // killed completed, w=6
];

const completions: ChangeFeedEntry[] = [
  { id: 'wi:F-10', kind: 'completion', title: 'shipped X', ref: 'wi:F-10', ts: daysAgo(1) },
  { id: 'wi:F-11', kind: 'completion', title: 'shipped Y', ref: 'wi:F-11', ts: daysAgo(2) },
  { id: 'plan:p', kind: 'plan-run', title: 'plan done', ref: 'plan:p', ts: daysAgo(3) },
];

// Structured (rubric-graded) observations — Overwatch-style scorecards (D-003):
// ratings is a Record keyed by criterion. Two papercusp scorecards make
// end-to-end-flow `broken` RECUR; a generic-test scorecard is a SEPARATE group by
// source-hive; the pure-`healthy` criteria must drop out of the surfaced lane.
const observations: StructuredObservationRecord[] = [
  {
    id: 'EI-OBS-1',
    title: 'pot-coordination-health scorecard',
    sourceHive: 'papercusp',
    rubricRef: 'pot-coordination-health',
    lastSeenMs: msAgo(1),
    ratings: {
      'end-to-end-flow': { rating: 'broken', evidence: '88 items unplaced despite idle capacity' },
      'ideation-quality': { rating: 'healthy', evidence: 'lens weights diverged from uniform' },
      'watchdog-determinism': { rating: 'degraded', evidence: 'two non-deterministic red-tests this wake' },
    },
  },
  {
    id: 'EI-OBS-2',
    title: 'pot-coordination-health scorecard',
    sourceHive: 'papercusp',
    rubricRef: 'pot-coordination-health',
    lastSeenMs: msAgo(3),
    ratings: {
      'end-to-end-flow': { rating: 'broken', evidence: 'frontier stuck — 0 placements last hr' },
      'ideation-quality': { rating: 'healthy', evidence: 'fresh ideas generated' },
    },
  },
  {
    id: 'EI-OBS-3',
    title: 'scorecard',
    sourceHive: 'generic-test',
    rubricRef: 'pot-coordination-health',
    lastSeenMs: msAgo(2),
    ratings: { 'end-to-end-flow': { rating: 'degraded', evidence: 'slow but moving' } },
  },
  {
    id: 'EI-OBS-4',
    title: 'scorecard',
    sourceHive: 'papercusp',
    rubricRef: 'pot-coordination-health',
    lastSeenMs: msAgo(1),
    ratings: { 'tool-utilization': { rating: 'healthy', evidence: 'all tools loading fine' } },
  },
];

function fixtureReaders(over: Partial<StateOfHiveReaders> = {}): StateOfHiveReaders {
  return {
    async completions() {
      return completions;
    },
    async reverts() {
      return reverts;
    },
    async friction() {
      return friction;
    },
    async spend() {
      return spend;
    },
    async deferrals() {
      return deferrals;
    },
    async observations() {
      return observations;
    },
    ...over,
  };
}

describe('corpus-digest — synthesizeStateOfHive', () => {
  it('produces a DigestSchema-valid digest over all substrates', async () => {
    const digest = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    expect(() => DigestSchema.parse(digest)).not.toThrow();
    expect(digest.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it('corpus rollup counts every substrate honestly', async () => {
    const digest = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    expect(digest.corpus).toEqual({
      completions: 3,
      reverts: 4,
      frictionCaptured: 6,
      deferrals: 3,
      spendUsd: 15.75,
      spendBuckets: 3,
      observations: 4,
      rubrics: 0, // fixtureReaders provides no rubrics() reader
    });
  });

  describe('recurringFriction', () => {
    it('surfaces only recurring (count>1) signatures, not one-offs', async () => {
      const { recurringFriction } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      const summaries = recurringFriction.map((p) => p.summary);
      expect(summaries).toContain('lock contention blocks file edits');
      expect(summaries).not.toContain('flaky vitest timeout in operator core'); // count=1
      const lock = recurringFriction.find((p) => p.summary === 'lock contention blocks file edits')!;
      expect(lock.category).toBe('recurring-friction');
      expect(lock.ref).toMatch(/^wi:EI-[12]$/);
      expect(lock.detail).toContain('recurred 2×');
    });

    // ── EI-23782723592280521: lane is PROVENANCE, never a content verdict ───────
    //
    // These three tests replace one that asserted the digest printed
    // '(agent reflection; not a bug)' — i.e. it pinned the defect as a feature. The
    // cluster below is MIXED (one work-lane row, one observation row), which is exactly
    // the case the old `.some()` predicate labelled wholesale as a reflection.
    it('reports observation-lane COMPOSITION for a mixed cluster, and asserts nothing about content', async () => {
      const observed: ImprovementCandidate[] = [
        { ...friction[0], id: 'EI-WORK-F-1' },
        { ...friction[1], id: 'EI-OBS-F-2', lane: 'observation' },
      ];
      const digest = await synthesizeStateOfHive(fixtureReaders({ friction: async () => observed }), { nowMs: NOW });
      const pattern = digest.recurringFriction[0]!;
      expect(pattern.detail).toContain('1 of 2 row(s) from the observation lane');
      expect(pattern.detail).toContain('UNTRIAGED');
      expect(renderDigest(digest)).toContain('1 of 2 row(s) from the observation lane');
    });

    it('labels an all-observation cluster by provenance and its triage consequence only', async () => {
      const observed: ImprovementCandidate[] = [
        { ...friction[0], id: 'EI-OBS-F-1', lane: 'observation' },
        { ...friction[1], id: 'EI-OBS-F-2', lane: 'observation' },
      ];
      const digest = await synthesizeStateOfHive(fixtureReaders({ friction: async () => observed }), { nowMs: NOW });
      const pattern = digest.recurringFriction[0]!;
      expect(pattern.detail).toContain('source: observation lane (provenance, not a triage verdict');
      expect(pattern.detail).toContain('UNTRIAGED');
    });

    // The recurrence guard for the whole class. The digest may state WHERE a row came
    // from; it may never state WHAT IT IS on that basis. Measured 2026-09-20: a
    // four-digit recurrence count rendered beside '(agent reflection; not a bug)' is
    // what parked the corpus's highest-frequency failure in the one lane that is never
    // triaged. The first assertion is a POSITIVE CONTROL — without it an empty render
    // would satisfy every not.toContain below and the guard would pass vacuously.
    it('never derives a content verdict from the lane', async () => {
      const observed: ImprovementCandidate[] = [
        { ...friction[0], id: 'EI-OBS-V-1', lane: 'observation' },
        { ...friction[1], id: 'EI-OBS-V-2', lane: 'observation' },
      ];
      const digest = await synthesizeStateOfHive(fixtureReaders({ friction: async () => observed }), { nowMs: NOW });
      const rendered = renderDigest(digest).toLowerCase();
      expect(rendered).toContain('observation lane'); // positive control: provenance IS reported
      for (const verdict of ['not a bug', 'not bugs', 'agent reflection']) {
        expect(rendered).not.toContain(verdict);
      }
    });

    // ── EI-20587312505064997: FLOW vs STOCK ──────────────────────────────────
    //
    // The test above encodes the defect as a FEATURE: EI-3 is excluded because it is
    // "count=1". That is true of its work_items ROWS and false of the friction — dedup
    // collapses a repeat onto the canonical row and appends to work_item_occurrences,
    // so a friction reported 79× is one row. Measured on the live observation lane
    // 2026-09-06: 582 canonicals reach ≥3 occurrences while being title-singletons
    // (498 open), and `findLikelyDuplicates` only ever emits clusters of ≥2 rows, so
    // none of them can be surfaced by any amount of downstream re-ranking.
    const flowReader = (counts: Record<string, number>) => ({
      occurrences: async (ids: readonly string[]) =>
        new Map(ids.filter((id) => counts[id] !== undefined).map((id) => [id, counts[id]] as const)),
    });

    it('surfaces a ledger-only recurrence: a one-ROW friction reported many times', async () => {
      const { recurringFriction } = await synthesizeStateOfHive(
        fixtureReaders(flowReader({ 'EI-3': 5 })),
        { nowMs: NOW },
      );
      const flaky = recurringFriction.find((p) => p.summary === 'flaky vitest timeout in operator core');
      // Excluded by the stock test above; admitted here purely on ledger evidence.
      expect(flaky).toBeDefined();
      expect(flaky!.category).toBe('recurring-friction');
      expect(flaky!.ref).toBe('wi:EI-3');
      expect(flaky!.detail).toContain('recurred 5×');
      // Both axes are named when they disagree, so a one-row group ranked highly is
      // legible rather than looking like a scoring bug.
      expect(flaky!.detail).toContain('1 row(s), 5 report(s)');
    });

    it('floors each member at one report, so a ledger-less row is never counted as zero', async () => {
      // Only EI-3 is in the ledger. The lock cluster's members have NO occurrence rows —
      // the live shape for the 15,750 improvement-topic rows that predate the ledger —
      // and must keep their stock count rather than collapsing to 0 and vanishing.
      const { recurringFriction } = await synthesizeStateOfHive(
        fixtureReaders(flowReader({ 'EI-3': 3 })),
        { nowMs: NOW },
      );
      const lock = recurringFriction.find((p) => p.summary === 'lock contention blocks file edits')!;
      expect(lock.detail).toContain('recurred 2×');
      // Equal axes ⇒ no disambiguating suffix, so existing lines stay byte-identical.
      expect(lock.detail).not.toContain('row(s)');
    });

    it('adds ledger reports to a multi-row cluster too — flow generalizes stock, it does not replace it', async () => {
      const { recurringFriction } = await synthesizeStateOfHive(
        fixtureReaders(flowReader({ 'EI-1': 3, 'EI-2': 1 })),
        { nowMs: NOW },
      );
      const lock = recurringFriction.find((p) => p.summary === 'lock contention blocks file edits')!;
      expect(lock.detail).toContain('recurred 4×'); // 3 reports + 1 report
      expect(lock.detail).toContain('2 row(s), 4 report(s)');
    });

    // ── EI-24726268610417103: a MIXED cluster is labelled by its dominant member ──
    //
    // The cluster LABEL + ref used to come from the most-recently-seen member while
    // `recurred N×` is the SUM over every member, so a lexical group spanning two tools'
    // failures was named by whichever member was newest even when that member held a
    // sliver of the reports (live: 152 of 66,044). EI-1 is the newest member of the lock
    // cluster (1d ago), EI-2 the older one (5d ago); the two share a title, so the REF is
    // what tells the heads apart.
    it('labels a mixed cluster by the member holding the reports, not the newest one', async () => {
      const { recurringFriction } = await synthesizeStateOfHive(
        fixtureReaders(flowReader({ 'EI-1': 1, 'EI-2': 40 })),
        { nowMs: NOW },
      );
      const lock = recurringFriction.find((p) => p.summary === 'lock contention blocks file edits')!;
      expect(lock.ref).toBe('wi:EI-2'); // the OLDER member carries 40 of the 41 reports
      expect(lock.detail).toContain('recurred 41×');
      expect(lock.detail).toContain('mixed cluster: labelled by its dominant member (40 of 41 report(s), last 5d ago)');
      // The decay clock is still the NEWEST member's, and the suffix says so, so the
      // reader is never left wondering why "last 1d ago" sits beside a 5d-old label.
      expect(lock.detail).toContain('last 1d ago');
      expect(lock.detail).toContain('the newest member "lock contention blocks file edits" (last 1d ago)');
    });

    it('keeps the newest label and stays byte-identical when no member dominates', async () => {
      const equal = await synthesizeStateOfHive(
        fixtureReaders(flowReader({ 'EI-1': 3, 'EI-2': 3 })),
        { nowMs: NOW },
      );
      const newestDominates = await synthesizeStateOfHive(
        fixtureReaders(flowReader({ 'EI-1': 9, 'EI-2': 1 })),
        { nowMs: NOW },
      );
      const ledgerless = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      for (const digest of [equal, newestDominates, ledgerless]) {
        const lock = digest.recurringFriction.find((p) => p.summary === 'lock contention blocks file edits')!;
        // A tie breaks to the newest member, and a newest-and-dominant member is not "mixed".
        expect(lock.ref).toBe('wi:EI-1');
        expect(lock.detail).not.toContain('mixed cluster');
      }
    });

    it('degrades to stock counting — never to zero — when the occurrence reader throws', async () => {
      // A ledger blip may cost this cycle's EXTRA signal; it may not cost the cycle.
      const { recurringFriction } = await synthesizeStateOfHive(
        fixtureReaders({
          occurrences: async () => {
            throw new Error('ledger unavailable');
          },
        }),
        { nowMs: NOW },
      );
      const summaries = recurringFriction.map((p) => p.summary);
      expect(summaries).toContain('lock contention blocks file edits');
      expect(summaries).not.toContain('flaky vitest timeout in operator core');
      const lock = recurringFriction.find((p) => p.summary === 'lock contention blocks file edits')!;
      expect(lock.detail).toContain('recurred 2×');
    });

    it('widens ONLY the recurrence lane — rubricGaps still reads the ≥2-row clusters', async () => {
      // The synthesized one-row groups are passed to buildRecurringFriction alone.
      // Guards the surgical claim directly, rather than resting on the gap lane's
      // ≥3-distinct-author trigger happening to reject them.
      const withFlow = await synthesizeStateOfHive(fixtureReaders(flowReader({ 'EI-3': 9 })), { nowMs: NOW });
      const withoutFlow = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      expect(withFlow.rubricGaps).toEqual(withoutFlow.rubricGaps);
      // ...and the widening it is compared against actually happened.
      expect(withFlow.recurringFriction.length).toBeGreaterThan(withoutFlow.recurringFriction.length);
    });

    it('excludes rubric scorecard observations from friction mining while keeping free-text observations', async () => {
      const scorecardRows: ImprovementCandidate[] = [
        {
          id: 'EI-SC-1',
          kind: 'bug',
          scope: 'operator',
          title: 'pot-coordination-health scorecard',
          state: 'open',
          updatedAt: daysAgo(1),
          observation: {
            sourceHive: 'papercusp',
            rubricRef: 'pot-coordination-health',
            ratings: { 'end-to-end-flow': { rating: 'broken', evidence: 'frontier stuck' } },
          },
        },
        {
          id: 'EI-SC-2',
          kind: 'bug',
          scope: 'operator',
          title: 'pot-coordination-health scorecard',
          state: 'open',
          updatedAt: daysAgo(2),
          observation: {
            sourceHive: 'papercusp',
            rubricRef: 'pot-coordination-health',
            ratings: { 'end-to-end-flow': { rating: 'degraded', evidence: 'placements slow' } },
          },
        },
        {
          id: 'EI-FLOOR-1',
          kind: 'bug',
          scope: 'operator',
          title: 'scorecard (synthesized floor)',
          state: 'open',
          updatedAt: daysAgo(1),
          observation: { kind: 'friction', synthesized: true } as unknown as ImprovementCandidate['observation'],
        },
        {
          id: 'EI-FLOOR-2',
          kind: 'bug',
          scope: 'operator',
          title: 'scorecard (synthesized floor)',
          state: 'open',
          updatedAt: daysAgo(2),
          observation: { kind: 'friction', synthesized: true } as unknown as ImprovementCandidate['observation'],
        },
        {
          id: 'EI-FT-1',
          kind: 'bug',
          scope: 'operator',
          title: 'free-text observation reports stuck dispatch',
          state: 'open',
          updatedAt: daysAgo(1),
          observation: { kind: 'friction' },
        },
        {
          id: 'EI-FT-2',
          kind: 'bug',
          scope: 'operator',
          title: 'free-text observation reports stuck dispatch',
          state: 'open',
          updatedAt: daysAgo(3),
          observation: { kind: 'friction' },
        },
      ];

      const digest = await synthesizeStateOfHive(
        fixtureReaders({
          friction: async () => scorecardRows,
          observations: async () => [
            {
              id: 'EI-SC-1',
              title: 'pot-coordination-health scorecard',
              sourceHive: 'papercusp',
              rubricRef: 'pot-coordination-health',
              lastSeenMs: msAgo(1),
              ratings: { 'end-to-end-flow': { rating: 'broken', evidence: 'frontier stuck' } },
            },
            {
              id: 'EI-SC-2',
              title: 'pot-coordination-health scorecard',
              sourceHive: 'papercusp',
              rubricRef: 'pot-coordination-health',
              lastSeenMs: msAgo(2),
              ratings: { 'end-to-end-flow': { rating: 'degraded', evidence: 'placements slow' } },
            },
          ],
        }),
        { nowMs: NOW },
      );

      const frictionSummaries = digest.recurringFriction.map((p) => p.summary);
      expect(frictionSummaries).toEqual(['free-text observation reports stuck dispatch']);
      expect(frictionSummaries).not.toContain('pot-coordination-health scorecard');
      expect(frictionSummaries).not.toContain('scorecard (synthesized floor)');
      expect(digest.corpus.frictionCaptured).toBe(2);
      expect(digest.rubricRatings.map((p) => p.summary)).toContain(
        'pot-coordination-health · end-to-end-flow @ papercusp: broken',
      );
    });
  });

  describe('timeTokenSinks', () => {
    it('ranks heaviest spend first with weight normalised to the top sink', async () => {
      const { timeTokenSinks } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      expect(timeTokenSinks.map((p) => p.summary)).toEqual([
        '$12.5 on papercup · worker',
        '$3.25 on papercup · validator',
      ]); // the $0 bucket is dropped
      expect(timeTokenSinks[0].weight).toBe(1);
      expect(timeTokenSinks[1].weight).toBeLessThan(1);
      expect(timeTokenSinks[0].category).toBe('time-token-sink');
      expect(timeTokenSinks[0].ref).toBe('usage:papercup/worker');
    });
  });

  describe('chronicDeferrals', () => {
    it('aggregates by signature so a repeated deferral reads as chronic (ranked first)', async () => {
      const { chronicDeferrals } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      const top = chronicDeferrals[0];
      expect(top.summary).toBe('wire the cadence trigger primitive');
      expect(top.detail).toContain('deferred 2× across 2 plan(s)');
      expect(top.weight).toBe(1);
      expect(top.category).toBe('chronic-deferral');
      expect(top.ref).toMatch(/^plan:plan-[ab]#P-00[38]$/);
      // The one-off decision deferral ranks below the chronic one.
      const oneOff = chronicDeferrals.find((p) => p.summary.includes('gym A/B'));
      expect(oneOff).toBeDefined();
      expect(oneOff!.weight).toBeLessThan(1);
    });
  });

  describe('capabilityGaps', () => {
    it('surfaces net-new feature asks and keyword-named missing capabilities', async () => {
      const { capabilityGaps } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      const summaries = capabilityGaps.map((p) => p.summary);
      expect(summaries).toContain('add a bulk export tool for plans'); // feature kind
      expect(summaries).toContain('no way to rename a harness'); // keyword
      capabilityGaps.forEach((p) => expect(p.category).toBe('capability-gap'));
      const rename = capabilityGaps.find((p) => p.summary === 'no way to rename a harness')!;
      expect(rename.detail).toContain('asked 2×');
    });

    // EI-23782723592280521 — same rule on the capability-gap lane: composition, never a
    // verdict. A gap whose rows are partly real work must not be dismissed because one
    // member arrived through the observation lane.
    it('reports observation-lane composition on a mixed capability gap, without a content verdict', async () => {
      const observed: ImprovementCandidate[] = [
        { ...friction[4], id: 'EI-WORK-C-1' },
        { ...friction[5], id: 'EI-OBS-C-2', lane: 'observation' },
      ];
      const digest = await synthesizeStateOfHive(fixtureReaders({ friction: async () => observed }), { nowMs: NOW });
      const pattern = digest.capabilityGaps.find((p) => p.summary === 'no way to rename a harness')!;
      expect(pattern.detail).toContain('1 of 2 row(s) from the observation lane');
      expect(pattern.detail).not.toContain('not a bug');
      expect(renderDigest(digest)).toContain('1 of 2 row(s) from the observation lane');
    });
  });

  describe('reverts', () => {
    it('keeps only regressions, groups by item, ranks churniest first', async () => {
      const { reverts: out } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      const ids = out.map((p) => p.ref);
      expect(ids).toContain('wi:F-1');
      expect(ids).toContain('wi:F-3');
      expect(ids).not.toContain('wi:F-2'); // failing→todo is a recovery, not a revert
      const f1 = out.find((p) => p.ref === 'wi:F-1')!;
      expect(f1.summary).toContain('reverted 2×');
      // reverts is a substrate, not one of the 4 CorpusDigest lanes — no category.
      expect(f1.category).toBeUndefined();
    });
  });

  it('only promotes explicit deprecation causes into flattened rework lessons', () => {
    const lessons = buildReworkLessons([
      { workItemId: 'F-BARE', from: 'passed', to: 'failing', ts: daysAgo(1) },
      { workItemId: 'F-GENERIC', from: 'passed', to: 'deprecated', reason: 'deprecated', ts: daysAgo(1) },
      {
        workItemId: 'F-CAUSE', from: 'passed', to: 'deprecated',
        reason: 'The release assertion used a stale worktree and must be rebuilt',
        ts: daysAgo(1),
      },
    ], 10);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ category: 'rework-lesson', ref: 'wi:F-CAUSE' });
    expect(lessons[0]?.summary).toContain('stale worktree');
    expect(flattenDigest({
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      reworkLessons: lessons,
    }).map((pattern) => pattern.ref)).toEqual(['wi:F-CAUSE']);
  });

  describe('rubricRatings (P-006)', () => {
    it('groups by (rubric, source-hive, criterion), ranks degraded/broken by severity × recurrence', async () => {
      const { rubricRatings } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      // 3 surfaced groups: e2e-flow@papercusp (broken×2), watchdog-determinism@papercusp
      // (degraded×1), e2e-flow@generic-test (degraded×1). The 2 pure-healthy criteria drop.
      expect(rubricRatings).toHaveLength(3);

      const top = rubricRatings[0];
      expect(top.summary).toBe('pot-coordination-health · end-to-end-flow @ papercusp: broken');
      expect(top.ref).toBe('rubric:pot-coordination-health#end-to-end-flow@papercusp');
      expect(top.category).toBe('rubric-rating');
      expect(top.weight).toBe(1); // the most-severe group normalises to 1.0
      expect(top.detail).toContain('broken 2×');
      expect(top.detail).toContain('over 2 obs');
      expect(top.detail).toContain('latest: 88 items unplaced despite idle capacity'); // most-recent (msAgo(1))
    });

    it('separates the same criterion by source-hive into distinct groups + refs', async () => {
      const { rubricRatings } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      const refs = rubricRatings.map((p) => p.ref);
      expect(refs).toContain('rubric:pot-coordination-health#end-to-end-flow@papercusp');
      expect(refs).toContain('rubric:pot-coordination-health#end-to-end-flow@generic-test'); // separate hive
      const generic = rubricRatings.find((p) => p.ref.endsWith('@generic-test'))!;
      expect(generic.summary).toContain('generic-test: degraded');
    });

    it('drops pure-healthy criteria (nothing to ideate on) but counts every scorecard in the rollup', async () => {
      const digest = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      const summaries = digest.rubricRatings.map((p) => p.summary);
      expect(summaries.some((s) => s.includes('ideation-quality'))).toBe(false); // healthy×2 → dropped
      expect(summaries.some((s) => s.includes('tool-utilization'))).toBe(false); // healthy×1 → dropped
      expect(digest.corpus.observations).toBe(4); // all 4 scorecards scanned (honest coverage)
    });

    it('isolates a throwing observations reader — empty lane, rest of the digest intact', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const digest = await synthesizeStateOfHive(
        fixtureReaders({
          async observations() {
            throw new Error('PG down');
          },
        }),
        { nowMs: NOW },
      );
      expect(digest.rubricRatings).toEqual([]);
      expect(digest.corpus.observations).toBe(0);
      expect(digest.recurringFriction.length).toBeGreaterThan(0); // others unaffected
    });

    it('every rubric-rating pattern validates against MetaPatternSchema', async () => {
      const { rubricRatings } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
      for (const p of rubricRatings) expect(() => MetaPatternSchema.parse(p)).not.toThrow();
    });
  });

  it('every surfaced pattern carries a non-empty ref + summary, weight in [0,1]', async () => {
    const digest = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    const lanes = [
      digest.recurringFriction,
      digest.timeTokenSinks,
      digest.chronicDeferrals,
      digest.capabilityGaps,
      digest.reverts,
      digest.rubricRatings,
    ];
    for (const lane of lanes) {
      for (const p of lane) {
        expect(p.summary.length).toBeGreaterThan(0);
        expect(p.ref.length).toBeGreaterThan(0);
        expect(p.weight).toBeGreaterThanOrEqual(0);
        expect(p.weight).toBeLessThanOrEqual(1);
      }
    }
  });

  it('respects perCategory limit', async () => {
    const digest = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW, perCategory: 1 });
    expect(digest.capabilityGaps.length).toBeLessThanOrEqual(1);
    expect(digest.timeTokenSinks.length).toBe(1);
    expect(digest.rubricRatings.length).toBeLessThanOrEqual(1);
  });

  it('is deterministic given nowMs', async () => {
    const a = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    const b = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    expect(a).toEqual(b);
  });

  it('isolates a throwing reader — one bad source does not kill the digest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const digest = await synthesizeStateOfHive(
      fixtureReaders({
        async spend() {
          throw new Error('PG down');
        },
      }),
      { nowMs: NOW },
    );
    expect(digest.timeTokenSinks).toEqual([]); // failed lane is empty
    expect(digest.recurringFriction.length).toBeGreaterThan(0); // others unaffected
    expect(console.warn).toHaveBeenCalled();
  });

  it('handles a fully-empty corpus', async () => {
    const empty: StateOfHiveReaders = {
      async completions() {
        return [];
      },
      async reverts() {
        return [];
      },
      async friction() {
        return [];
      },
      async spend() {
        return [];
      },
      async deferrals() {
        return [];
      },
      async observations() {
        return [];
      },
    };
    const digest = await synthesizeStateOfHive(empty, { nowMs: NOW });
    expect(() => DigestSchema.parse(digest)).not.toThrow();
    expect(digest.recurringFriction).toEqual([]);
    expect(digest.rubricRatings).toEqual([]);
    expect(digest.rubricGaps).toEqual([]);
    expect(digest.corpus.spendUsd).toBe(0);
    expect(digest.corpus.observations).toBe(0);
    expect(digest.corpus.rubrics).toBe(0);
  });

  // ── rubricGaps (plan-templates-and-rubric-v2 P-008) ──────────────────────────
  // A recurring friction cluster (≥3 distinct authors, ≥2 day-cycles) with NO
  // covering active rubric. Uses a dedicated friction set (identical titles ⇒ one
  // exact-signature cluster) so the assertions are independent of the shared fixture.
  describe('rubricGaps', () => {
    // 3 captures of the SAME friction, 3 distinct authors, across 2 distinct days.
    const gapFriction: ImprovementCandidate[] = [
      {
        id: 'EI-G1',
        kind: 'bug',
        scope: 'operator',
        title: 'deploy gate wedges on a stale lock',
        state: 'open',
        createdBy: 'su-a',
        updatedAt: daysAgo(1),
      },
      {
        id: 'EI-G2',
        kind: 'bug',
        scope: 'operator',
        title: 'deploy gate wedges on a stale lock',
        state: 'open',
        createdBy: 'su-b',
        updatedAt: daysAgo(2),
      },
      {
        id: 'EI-G3',
        kind: 'bug',
        scope: 'operator',
        title: 'deploy gate wedges on a stale lock',
        state: 'open',
        createdBy: 'su-c',
        updatedAt: daysAgo(2),
      },
    ];

    it('flags a recurring, multi-author, multi-cycle cluster with no covering rubric', async () => {
      const digest = await synthesizeStateOfHive(
        fixtureReaders({ friction: async () => gapFriction, rubrics: async () => [] }),
        { nowMs: NOW },
      );
      expect(digest.rubricGaps).toHaveLength(1);
      const gap = digest.rubricGaps[0];
      expect(gap.summary).toContain('deploy gate');
      expect(gap.ref).toBe('wi:EI-G1'); // newest member (daysAgo(1)) is the exemplar
      expect(gap.detail).toContain('3 authors');
      expect(gap.detail).toContain('2 cycles');
      expect(gap.category).toBeUndefined(); // not a flattenDigest ideator lane
      expect(digest.corpus.rubrics).toBe(0);
    });

    it('does NOT flag when an active rubric covers the cluster theme', async () => {
      const digest = await synthesizeStateOfHive(
        fixtureReaders({
          friction: async () => gapFriction,
          rubrics: async () => [
            {
              rubricId: 'deploy-health',
              characteristic: 'deploy gate health',
              title: 'Deploy gate',
              criteriaTitles: ['lock contention'],
            },
          ],
        }),
        { nowMs: NOW },
      );
      expect(digest.rubricGaps).toEqual([]);
      expect(digest.corpus.rubrics).toBe(1);
    });

    it('does NOT flag with fewer than 3 distinct authors', async () => {
      const twoAuthors: ImprovementCandidate[] = [
        { ...gapFriction[0], createdBy: 'su-a' },
        { ...gapFriction[1], createdBy: 'su-a' },
        { ...gapFriction[2], createdBy: 'su-b' },
      ];
      const digest = await synthesizeStateOfHive(
        fixtureReaders({ friction: async () => twoAuthors, rubrics: async () => [] }),
        { nowMs: NOW },
      );
      expect(digest.rubricGaps).toEqual([]);
    });

    it('does NOT flag when the cluster recurs within a single day-cycle', async () => {
      const sameDay: ImprovementCandidate[] = gapFriction.map((c) => ({ ...c, updatedAt: daysAgo(1) }));
      const digest = await synthesizeStateOfHive(
        fixtureReaders({ friction: async () => sameDay, rubrics: async () => [] }),
        { nowMs: NOW },
      );
      expect(digest.rubricGaps).toEqual([]);
    });

    it('does NOT flag a one-off (non-recurring) capture', async () => {
      const digest = await synthesizeStateOfHive(
        fixtureReaders({ friction: async () => [gapFriction[0]], rubrics: async () => [] }),
        { nowMs: NOW },
      );
      expect(digest.rubricGaps).toEqual([]);
    });

    it('does NOT flag a recurring cluster whose captures have no author', async () => {
      // The shared fixture clusters (EI-1/EI-2) recur but carry no createdBy ⇒ 0 authors.
      const digest = await synthesizeStateOfHive(fixtureReaders({ rubrics: async () => [] }), { nowMs: NOW });
      expect(digest.rubricGaps).toEqual([]);
    });
  });
});

describe('buildFederatedMapLane', () => {
  it('surfaces crowded niches across the local+foreign union and prioritizes empty one-step neighbors of local niches', () => {
    const lane = buildFederatedMapLane([
      { nicheKey: 'module|sync|low', scope: 'module', domain: 'sync', risk: 'low', fitness: 0.91 },
      {
        nicheKey: 'module|sync|low',
        scope: 'module',
        domain: 'sync',
        risk: 'low',
        fitness: 0.88,
        sourceHive: 'peer-a',
      },
      {
        nicheKey: 'module|sync|low',
        scope: 'module',
        domain: 'sync',
        risk: 'low',
        fitness: 0.82,
        sourceHive: 'peer-b',
      },
      { nicheKey: 'module|docs|low', scope: 'module', domain: 'docs', risk: 'low', fitness: 0.73 },
    ]);

    const crowded = lane.filter((p) => p.ref.startsWith('niche:v1:crowded:'));
    const empty = lane.filter((p) => p.ref.startsWith('niche:v1:empty:'));

    expect(crowded[0]?.summary).toContain('crowded niche module|sync|low');
    expect(crowded[0]?.summary).toContain('3 elites across 3 hives');

    expect(empty[0]?.summary).toContain('adjacent to local winners');
    expect(empty[0]?.detail).toContain('one-step move from local');
    expect(empty[0]?.ref).not.toContain('module|sync|low'); // occupied niches never reappear as empty
  });
});

describe('revertWeight', () => {
  it('scores regressions, zero for recoveries/lateral, extra for undoing terminal-good', () => {
    expect(revertWeight('passed', 'failing')).toBe(5); // 4→1 (+2 terminal-good)
    expect(revertWeight('passed', 'deprecated')).toBe(6); // 4→0 (+2)
    expect(revertWeight('validating', 'todo')).toBe(1); // 3→2
    expect(revertWeight('failing', 'todo')).toBe(0); // recovery (1→2)
    expect(revertWeight('todo', 'todo')).toBe(0); // lateral
    expect(revertWeight('passed', 'passed')).toBe(0); // lateral terminal
    expect(revertWeight('done', 'wip')).toBe(3); // 4→3 (+2)
  });
});

describe('structural contract with scout/types.ts', () => {
  it('the production digest is assignable to the shared CorpusDigest (the 4 lanes)', async () => {
    const digest = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    const asCorpus: CorpusDigest = digest; // compile-time: superset assignable to CorpusDigest
    expect(asCorpus.recurringFriction).toBe(digest.recurringFriction);
    expect(asCorpus.capabilityGaps).toBe(digest.capabilityGaps);
  });

  it('MetaPatternSchema and types.ts MetaPattern are the same shape (both directions)', () => {
    const fromSchema: import('zod').infer<typeof MetaPatternSchema> = {
      category: 'recurring-friction',
      summary: 's',
      ref: 'wi:1',
      weight: 0.5,
    };
    const asTypes: TypesMetaPattern = fromSchema; // schema-output → types.ts
    const backToSchema: import('zod').infer<typeof MetaPatternSchema> = asTypes; // types.ts → schema-output
    expect(backToSchema.ref).toBe('wi:1');
  });

  it('the rubric-rating category is in sync across the schema enum + types.ts (P-006)', () => {
    // Pins META_PATTERN_CATEGORIES ↔ types.ts MetaPatternCategory for the 5th lane.
    const pattern: TypesMetaPattern = { category: 'rubric-rating', summary: 's', ref: 'rubric:r#c@h', weight: 1 };
    expect(() => MetaPatternSchema.parse(pattern)).not.toThrow();
    const asSchema: import('zod').infer<typeof MetaPatternSchema> = pattern; // types.ts → schema-output
    expect(asSchema.category).toBe('rubric-rating');
  });

  it('the four P-011 curation categories stay in sync across the schema enum + types.ts', () => {
    for (const category of ['spend-anomaly', 'owner-correction', 'knowledge-reuse-gap', 'plan-health'] as const) {
      const pattern: TypesMetaPattern = { category, summary: 's', ref: `${category}:x`, weight: 1 };
      expect(() => MetaPatternSchema.parse(pattern)).not.toThrow();
    }
  });

  it('the recent-commit category (NOV-2 / WI-4635) stays in sync across the schema enum + types.ts', () => {
    const pattern: TypesMetaPattern = {
      category: 'recent-commit',
      summary: 's',
      ref: 'commit-churn:area',
      weight: 1,
    };
    expect(() => MetaPatternSchema.parse(pattern)).not.toThrow();
  });

  it('a digest pattern is a valid MetaPattern per the schema validator', async () => {
    const { recurringFriction } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    expect(() => MetaPatternSchema.parse(recurringFriction[0])).not.toThrow();
  });
});
