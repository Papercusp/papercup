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
  synthesizeStateOfHive,
  revertWeight,
  DigestSchema,
  MetaPatternSchema,
  type StateOfHiveReaders,
  type RevertRecord,
  type SpendRecord,
  type DeferralRecord,
  type StateOfHiveDigest,
} from './corpus-digest';

const NOW = Date.parse('2026-06-08T12:00:00Z');
const daysAgo = (d: number): string => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

const friction: ImprovementCandidate[] = [
  // Recurring friction: same stable signature ×2, both open.
  { id: 'EI-1', kind: 'bug', scope: 'operator', title: 'lock contention blocks file edits', state: 'open', updatedAt: daysAgo(1) },
  { id: 'EI-2', kind: 'bug', scope: 'operator', title: 'lock contention blocks file edits', state: 'open', updatedAt: daysAgo(5) },
  // One-off friction (count=1) — must NOT appear in recurringFriction.
  { id: 'EI-3', kind: 'bug', scope: 'operator', title: 'flaky vitest timeout in operator core', state: 'open', updatedAt: daysAgo(2) },
  // Capability gap: net-new feature ask (count=1, still surfaced as a gap).
  { id: 'EI-4', kind: 'feature', scope: 'operator', title: 'add a bulk export tool for plans', state: 'open', updatedAt: daysAgo(3) },
  // Capability gap via keyword, recurring ×2 ("no way to ...").
  { id: 'EI-5', kind: 'change', scope: 'operator', title: 'no way to rename a harness', state: 'open', updatedAt: daysAgo(2) },
  { id: 'EI-6', kind: 'change', scope: 'operator', title: 'no way to rename a harness', state: 'resolved', updatedAt: daysAgo(8) },
];

const spend: SpendRecord[] = [
  { harness: 'papercup', role: 'worker', costUsd: 12.5, inputTokens: 1_000_000, outputTokens: 200_000, runs: 40 },
  { harness: 'papercup', role: 'validator', costUsd: 3.25, inputTokens: 300_000, outputTokens: 50_000, runs: 12 },
  { harness: null, role: null, costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 2 }, // dropped (no spend)
];

const deferrals: DeferralRecord[] = [
  // Chronic: same thing deferred ×2 across two plans (one a hard needs-human stop).
  { planSlug: 'plan-a', refId: 'P-003', source: 'item', status: 'blocked', text: 'wire the cadence trigger primitive' },
  { planSlug: 'plan-b', refId: 'P-008', source: 'item', status: 'needs-human', text: 'wire the cadence trigger primitive' },
  // One-off deferred decision.
  { planSlug: 'plan-c', refId: 'D-009', source: 'decision', status: 'decision', text: 'defer the gym A/B threshold tuning' },
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

function fixtureReaders(over: Partial<StateOfHiveReaders> = {}): StateOfHiveReaders {
  return {
    async completions() { return completions; },
    async reverts() { return reverts; },
    async friction() { return friction; },
    async spend() { return spend; },
    async deferrals() { return deferrals; },
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

  it('every surfaced pattern carries a non-empty ref + summary, weight in [0,1]', async () => {
    const digest = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    const lanes = [digest.recurringFriction, digest.timeTokenSinks, digest.chronicDeferrals, digest.capabilityGaps, digest.reverts];
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
  });

  it('is deterministic given nowMs', async () => {
    const a = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    const b = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    expect(a).toEqual(b);
  });

  it('isolates a throwing reader — one bad source does not kill the digest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const digest = await synthesizeStateOfHive(
      fixtureReaders({ async spend() { throw new Error('PG down'); } }),
      { nowMs: NOW },
    );
    expect(digest.timeTokenSinks).toEqual([]); // failed lane is empty
    expect(digest.recurringFriction.length).toBeGreaterThan(0); // others unaffected
    expect(console.warn).toHaveBeenCalled();
  });

  it('handles a fully-empty corpus', async () => {
    const empty: StateOfHiveReaders = {
      async completions() { return []; },
      async reverts() { return []; },
      async friction() { return []; },
      async spend() { return []; },
      async deferrals() { return []; },
    };
    const digest = await synthesizeStateOfHive(empty, { nowMs: NOW });
    expect(() => DigestSchema.parse(digest)).not.toThrow();
    expect(digest.recurringFriction).toEqual([]);
    expect(digest.corpus.spendUsd).toBe(0);
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

  it('a digest pattern is a valid MetaPattern per the schema validator', async () => {
    const { recurringFriction } = await synthesizeStateOfHive(fixtureReaders(), { nowMs: NOW });
    expect(() => MetaPatternSchema.parse(recurringFriction[0])).not.toThrow();
  });
});

// Type-only helper so an unused StateOfHiveDigest import never trips lint.
export type _DigestType = StateOfHiveDigest;
