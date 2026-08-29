import { describe, expect, it } from 'vitest';
import {
  assertAdmissionCensusRatchet,
  buildBulkDedupPrompt,
  bulkJudgeMaxTokens,
  maxPairsForOutputBudget,
  BULK_JUDGE_MAX_OUTPUT_TOKENS,
  BULK_JUDGE_TOKENS_PER_PAIR,
} from './work-items-admission-bulk-dedup';
import type { PromoterItem, PromoterPair } from './work-items-admission-promoter';

function item(id: string, title = id): PromoterItem {
  return {
    id,
    title,
    summary: `${title} summary`,
    state: 'open',
    kind: 'change',
    admission: 'admitted',
    conditionKey: null,
    createdAtMs: 1,
  };
}

describe('buildBulkDedupPrompt', () => {
  it('reuses the promoter charter, emits each endpoint once, and labels ghost context read-only', () => {
    const a = item('a', 'Same failure');
    const b = item('b', 'Same failure again');
    const pair: PromoterPair = {
      pairKey: 'a::b',
      a,
      b,
      pendingIds: ['a', 'b'],
      signals: ['cosine'],
      cosine: 0.97,
    };
    const prompt = buildBulkDedupPrompt([pair], [item('g', 'Nearby context')]);

    expect(prompt.system).toContain('DUPLICATION ONLY');
    expect(prompt.system).toContain('r-finding-merge');
    expect(prompt.user.match(/## item a /g)).toHaveLength(1);
    expect(prompt.user.match(/## item b /g)).toHaveLength(1);
    expect(prompt.user).toContain('a::b | signals=cosine | cosine=0.9700');
    expect(prompt.user).toContain('READ-ONLY GHOST CONTEXT');
    expect(prompt.user).toContain('g | <title>Nearby context</title>');
  });
});

/**
 * The batch size and the output-token budget must be derived FROM EACH OTHER.
 * They were not: the batch defaulted to 150 pairs while the budget asked for
 * min(8000, 500 + 150*180) = min(8000, 27500) = 8000, so every full batch was
 * truncated mid-JSON. Parsing then failed identically on all 3 retries — the
 * failure is deterministic in batch size, so retrying could never help.
 * Measured on wi882767-opus5-20260829-stage-1: 12 model calls, 36 retries
 * (= every batch exhausted), 10 of 12 batches dead, 0 pairs merged, tokens_out
 * averaging 7,974 flush against the 8,000 ceiling.
 *
 * These cases pin the relationship rather than the constants, so the ceiling or
 * the per-pair estimate can be retuned without silently re-opening the bug.
 */
describe('bulk judge output-token budget', () => {
  it('never asks for a batch whose own judgements cannot fit the ceiling', () => {
    const pairs = maxPairsForOutputBudget();
    expect(bulkJudgeMaxTokens(pairs)).toBeLessThanOrEqual(BULK_JUDGE_MAX_OUTPUT_TOKENS);
    // and it is the LARGEST such batch — one more pair overflows, so the
    // derivation is tight rather than trivially conservative
    expect(bulkJudgeMaxTokens(pairs + 1)).toBeGreaterThan(BULK_JUDGE_MAX_OUTPUT_TOKENS);
  });

  it('holds the invariant across any ceiling, not just the configured one', () => {
    for (const ceiling of [1_000, 4_000, 8_000, 16_000, 64_000]) {
      const pairs = maxPairsForOutputBudget(ceiling);
      expect(pairs).toBeGreaterThanOrEqual(1);
      expect(bulkJudgeMaxTokens(pairs)).toBeLessThanOrEqual(ceiling);
    }
  });

  it('degrades to a single pair rather than zero when the ceiling is absurdly small', () => {
    // a zero-size batch would stall the run outright, which is worse than a
    // batch that overruns its budget and merely fails
    expect(maxPairsForOutputBudget(1)).toBe(1);
    expect(maxPairsForOutputBudget(BULK_JUDGE_TOKENS_PER_PAIR)).toBe(1);
  });

  it('CONTROL: the pre-fix 150-pair batch could never have fit — this is the bug it replaced', () => {
    // the literal 150 is the historical default, deliberately not the constant:
    // retuning the default must not silence this record of why the clamp exists
    expect(bulkJudgeMaxTokens(150)).toBeGreaterThan(BULK_JUDGE_MAX_OUTPUT_TOKENS);
    expect(150).toBeGreaterThan(maxPairsForOutputBudget());
  });
});

describe('assertAdmissionCensusRatchet', () => {
  it('accepts a flat or falling census', () => {
    expect(() => assertAdmissionCensusRatchet(3, 3)).not.toThrow();
    expect(() => assertAdmissionCensusRatchet(3, 0)).not.toThrow();
  });

  it('fails loudly on an injected rise', () => {
    expect(() => assertAdmissionCensusRatchet(2, 4)).toThrow('admission census ratchet violated: 2 -> 4 (+2)');
  });
});
