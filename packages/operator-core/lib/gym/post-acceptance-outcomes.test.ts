/**
 * Unit tests for the pure core of gym post-acceptance outcome tracking
 * (P-030 / B-09, self-improvement-consume-edges-2026-06-12): verdict math,
 * priming-entry formatting (scout C-4 shape: caps, ordering, empty ⇒ nothing),
 * and the proposer-prompt additivity contract (zero outcomes ⇒ byte-identical).
 * The SQL legs live in __tests__/post-acceptance-outcomes.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAMPION_OUTCOMES_HEADING,
  MAX_OUTCOME_ENTRIES,
  computeOutcomeVerdict,
  formatChampionOutcomeEntries,
  formatChampionOutcomeEntry,
  successRate,
  type ChampionOutcomeRow,
  type LiveRunStats,
} from './post-acceptance-outcomes';
import { buildProposerPrompt, type ProposeInput } from './proposer';

const stats = (succeeded: number, failed: number): LiveRunStats => ({
  runs: succeeded + failed,
  succeeded,
  failed,
});

function row(overrides: Partial<ChampionOutcomeRow> = {}): ChampionOutcomeRow {
  return {
    proposalId: 'v-1__worker',
    workspaceId: 'ws',
    harnessSlug: 'alpha',
    role: 'worker',
    variantId: 'v-1',
    cycle: 3,
    acceptedAt: 1_000_000,
    baselineDevAnchorDelta: 0.31,
    baselineCostDelta: -0.02,
    baselineProbeStatus: 'pass',
    baseline: stats(6, 2),
    postWindowEndsAt: 2_000_000,
    post: stats(9, 1),
    successRateDelta: 0.15,
    verdict: 'improved',
    evaluatedAt: 2_000_001,
    ...overrides,
  };
}

describe('successRate', () => {
  it('is null for an empty window and the ratio otherwise', () => {
    expect(successRate(stats(0, 0))).toBeNull();
    expect(successRate(stats(3, 1))).toBeCloseTo(0.75, 5);
  });
});

describe('computeOutcomeVerdict', () => {
  it('improves / regresses beyond the neutral band', () => {
    expect(computeOutcomeVerdict(stats(5, 5), stats(9, 1)).verdict).toBe('improved');
    expect(computeOutcomeVerdict(stats(9, 1), stats(5, 5)).verdict).toBe('regressed');
  });

  it('is neutral within the band, including exactly at the edge', () => {
    // Binary-exact rates so the edge is exact: 0.5 → 0.5625 with band 0.0625.
    const v = computeOutcomeVerdict(stats(8, 8), stats(9, 7), { neutralBand: 0.0625 });
    expect(v.verdict).toBe('neutral');
    expect(v.successRateDelta).toBeCloseTo(0.0625, 5);
  });

  it('is insufficient-data when either side is under minRuns — but still reports the delta when computable', () => {
    const thinPost = computeOutcomeVerdict(stats(6, 2), stats(2, 0), { minRuns: 5 });
    expect(thinPost.verdict).toBe('insufficient-data');
    expect(thinPost.successRateDelta).toBeCloseTo(1 - 0.75, 5); // informative even when thin
    const thinBase = computeOutcomeVerdict(stats(1, 0), stats(6, 0), { minRuns: 5 });
    expect(thinBase.verdict).toBe('insufficient-data');
  });

  it('has a null delta when a side saw zero runs (the judge-role case)', () => {
    const v = computeOutcomeVerdict(stats(0, 0), stats(0, 0));
    expect(v.verdict).toBe('insufficient-data');
    expect(v.successRateDelta).toBeNull();
  });
});

describe('formatChampionOutcomeEntry', () => {
  it('renders a measured row with rates, delta, run counts, and the accept-time anchor', () => {
    const line = formatChampionOutcomeEntry(row());
    expect(line).toBe(
      '- [worker · improved] cycle 3: live success 0.75→0.90 (Δ +0.15, 8→10 runs); accept-time dev-anchor Δ +0.31',
    );
  });

  it('renders insufficient-data rows without fabricating rates', () => {
    const line = formatChampionOutcomeEntry(
      row({ verdict: 'insufficient-data', successRateDelta: null, post: stats(1, 0), baselineDevAnchorDelta: null }),
    );
    expect(line).toBe('- [worker · insufficient-data] cycle 3: 8 baseline / 1 post live runs — too thin to judge');
  });
});

describe('formatChampionOutcomeEntries', () => {
  it('returns [] for no rows and for pending-only rows (prompt stays untouched)', () => {
    expect(formatChampionOutcomeEntries([])).toEqual([]);
    expect(formatChampionOutcomeEntries([row({ verdict: 'pending' })])).toEqual([]);
  });

  it('orders newest-first by acceptedAt and caps the window', () => {
    const rows = Array.from({ length: MAX_OUTCOME_ENTRIES + 3 }, (_, i) =>
      row({ proposalId: `p-${i}`, cycle: i, acceptedAt: 1_000 + i }),
    );
    const entries = formatChampionOutcomeEntries(rows);
    expect(entries).toHaveLength(MAX_OUTCOME_ENTRIES);
    expect(entries[0]).toContain(`cycle ${MAX_OUTCOME_ENTRIES + 2}:`); // newest first
  });

  it('truncates per entry and drops oldest entries until the block fits', () => {
    const entries = formatChampionOutcomeEntries([row(), row({ proposalId: 'p-2', acceptedAt: 999 })], {
      maxEntryChars: 30,
      maxBlockChars: CHAMPION_OUTCOMES_HEADING.length + 1 + 30, // room for exactly one entry
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].length).toBeLessThanOrEqual(30);
    expect(entries[0].endsWith('…')).toBe(true);
  });
});

describe('proposer prompt additivity (P-030 contract)', () => {
  const base: ProposeInput = {
    parentOverlay: { promptOverrides: {} },
    worstTraces: [{ taskId: 't1', composite: 4.2, rationale: 'missed acceptance criteria' }],
    changelog: 'cycle 1: accept — dev-anchor Δ +0.10, cost Δ +0.00, probe caught — tightened worker',
    proposerModel: 'test-model',
  };

  it('is byte-identical without champion outcomes (absent and empty alike)', () => {
    const bare = buildProposerPrompt(base);
    expect(buildProposerPrompt({ ...base, championOutcomes: [] })).toEqual(bare);
    expect(buildProposerPrompt({ ...base, championOutcomes: undefined })).toEqual(bare);
  });

  it('adds the champion-outcomes section with the entry lines when present', () => {
    const entry = formatChampionOutcomeEntry(row());
    const { user } = buildProposerPrompt({ ...base, championOutcomes: [entry] });
    expect(user).toContain('## Recent champion outcomes (live post-acceptance measurement)');
    expect(user).toContain(entry);
    // The rest of the prompt is preserved around it.
    expect(user).toContain('## Running changelog');
    expect(user).toContain('## Worst-scoring runs (judge rationales)');
  });
});
