import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import type { DreamRun } from './dream-run-store';
import { buildCalibrationBundle } from '../../../../scratchpad/dream-study-2026-09-09/calibration.mts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runs() {
  const f = await createDreamCapabilityFixture('ws', 'pot');
  roots.push(f.root);
  return Array.from({ length: 10 }, (_, i) => ({
    workspaceId: 'ws',
    potSlug: 'pot',
    runId: 'private-run-' + i,
    status: 'rejected',
    costUsd: 0.2,
    review: { ...f.review, verdict: 'unverified', reason: i < 5 ? 'counterfactual-unknown' : 'review-unavailable' },
    outcome: {
      insight: f.insight,
      capabilityRun: {
        ...f.provenance,
        evaluation: { protocolPin: 'a'.repeat(64), arm: 'structured-pair', matchedPairIndex: i },
      },
    },
  })) as unknown as DreamRun[];
}

describe('frozen study calibration evidence preparation', () => {
  it('does not leak metadata through production-shaped truncated narrative priors or their locators', async () => {
    const rows = await runs();
    rows[0]!.review!.priorMatches = [
      { ref: 'dream:private-run-2', kind: 'rejected-attempt', text: '{"status":"rejected","outcome":{"usage":{"model":"secret-model"},"protocolPin":"private-pin"', contentHash: 'original-hash' },
      { ref: 'idea:private-run-3', kind: 'idea', text: '{"humanGrade":"reject","routedRef":"private-run-4"}', contentHash: 'idea-hash' },
      { ref: 'plan:private-run-5', kind: 'plan', text: 'Review result private-verdict', contentHash: 'plan-hash' },
      { ref: 'code:private-run-6', kind: 'implementation', text: 'function current() {}', contentHash: 'code-hash', sourceHash: 'source-hash' },
    ];
    const { blind, key } = buildCalibrationBundle([rows[0]!]);
    const wire = JSON.stringify(blind);
    for (const forbidden of ['secret-model', 'private-run-', 'private-verdict', 'private-pin', 'rejected-attempt', 'humanGrade'])
      expect(wire).not.toContain(forbidden);
    expect(blind.cases[0]!.priors.slice(0, 3).every(p => p.text === null && p.kind === 'prior-context')).toBe(true);
    expect(blind.cases[0]!.priors[3]).toMatchObject({ ref: 'prior:4', kind: 'implementation', text: 'function current() {}' });
    expect(key.selected[0]!.priorRefMapping[0]).toMatchObject({ blindRef: 'prior:1', originalRef: 'dream:private-run-2' });
    expect(key.selected[0]!.originalReview).toEqual(rows[0]!.review);
  });
  it('is deterministic across row order, covers strata, and keeps identity/verdicts out of the blind envelope', async () => {
    const rows = await runs();
    const first = buildCalibrationBundle(rows);
    expect(buildCalibrationBundle([...rows].reverse())).toEqual(first);
    expect(first.blind.cases).toHaveLength(6);
    expect(new Set(first.key.selected.map((e) => e.stratum)).size).toBe(2);
    expect(first.key.unsampled).toHaveLength(4);
    const wire = JSON.stringify(first.blind);
    for (const forbidden of [
      'private-run-',
      'structured-pair',
      'counterfactual-unknown',
      'review-unavailable',
      'protocolPin',
      'originalReview',
    ])
      expect(wire).not.toContain(forbidden);
    expect(first.key.independentLabels).toBeNull();
    expect(first.key.qualifiedFamilies).toBeNull();
    expect(first.key.flatFaceted.every((e) => e.judgment === null)).toBe(true);
  });
  it('preserves all source claims and evidence when removing facet headings', async () => {
    const { blind, key } = buildCalibrationBundle(await runs(), 2);
    for (const [i, entry] of key.flatFaceted.entries()) {
      const original = blind.cases[i]!;
      expect(entry.flattened.candidate).toEqual(original.candidate);
      expect(entry.flattened.priors).toEqual(original.priors);
      entry.flattened.units.forEach((unit, j) => {
        const before = original.units[j]!;
        expect(unit.sources).toEqual(before.sources);
        expect(unit.unit.summaryClaims).toEqual([
          ...before.unit.purpose,
          ...before.unit.mechanism,
          ...before.unit.evaluation,
        ]);
        expect(unit.unit.contracts).toEqual(before.unit.contracts);
      });
      expect(entry.facetedHash).not.toBe(entry.flatHash);
    }
  });
  it('refuses duplicate, running or unbound rows; records missing candidates without inventing a label', async () => {
    const rows = await runs();
    expect(() => buildCalibrationBundle([rows[0]!, rows[0]!])).toThrow('Duplicate');
    expect(() => buildCalibrationBundle([{ ...rows[0]!, status: 'running' }])).toThrow('still running');
    expect(() => buildCalibrationBundle([{ ...rows[0]!, outcome: null }])).toThrow('Missing frozen');
    rows[0]!.outcome = { ...rows[0]!.outcome, insight: null };
    const bundle = buildCalibrationBundle(rows);
    expect(bundle.key.eligibleCandidates).toBe(9);
    expect(bundle.key.excluded).toEqual([
      { runId: rows[0]!.runId, reason: 'No retained candidate and selected source packets' },
    ]);
  });
});
