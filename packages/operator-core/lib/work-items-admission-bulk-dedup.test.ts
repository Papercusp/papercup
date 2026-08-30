import { LlmCallError } from '@papercusp/testing-shell/llm';
import { describe, expect, it } from 'vitest';
import { classifyHttpError } from './agent-chat-stream';
import { isTransientNetworkError } from './harness/routines/hetzner-orphan-frame-reaper';
import {
  assertAdmissionCensusRatchet,
  buildBulkDedupPrompt,
  bulkJudgeMaxTokens,
  isRetryableModelCallError,
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

/**
 * A batch retry must be decided by the classifier that ALREADY RAN, not by
 * re-parsing the error message.
 *
 * Measured on wi882767-bulkfix-d035-2 (2026-08-30): model call #33 of ~37 threw
 * `anthropic-direct error: terminated` — undici's wording when a socket dies
 * mid-response. No message heuristic in the tree matches the bare word
 * `terminated`, so the batch was not retried, `judgeShard` rethrew, and a 2h34m
 * stage died at ~90% having persisted nothing. `LlmCallError.turn` had said
 * `transient_io` / `retryable: true` the whole time.
 *
 * These cases pin the SOURCE of the verdict (the turn) rather than any regex, so
 * the provider can reword its transport errors without re-opening the bug.
 */
describe('isRetryableModelCallError', () => {
  const asThrown = (message: string, status?: number) =>
    new LlmCallError(classifyHttpError({ status, message }, 'anthropic'));

  it('retries the transport termination that killed the d035-2 run', () => {
    const error = asThrown('anthropic-direct error: terminated');
    // the turn is the authority, and it classified this as a retryable blip
    expect(error.turn.class).toBe('transient_io');
    expect(isRetryableModelCallError(error)).toBe(true);
  });

  it('CONTROL: no message heuristic matches it — this is why the regex path could not retry', () => {
    // Falsifiability: if this ever starts passing, the message path became
    // capable on its own and the assertions above stop proving the fix.
    // Deliberately the raw message, not an LlmCallError — that is the input the
    // pre-fix predicate actually received.
    expect(isTransientNetworkError(new Error('anthropic-direct error: terminated'))).toBe(false);
  });

  it('still FAILS FAST on a walled account or bad token — retrying those is futile', () => {
    const auth = asThrown('invalid x-api-key', 401);
    expect(auth.turn.retryable).toBe(false);
    expect(isRetryableModelCallError(auth)).toBe(false);

    const permanent = asThrown('malformed request', 400);
    expect(isRetryableModelCallError(permanent)).toBe(false);
  });

  it('retries a rate limit / overload, which are transient by class', () => {
    expect(isRetryableModelCallError(asThrown('slow down', 429))).toBe(true);
    expect(isRetryableModelCallError(asThrown('overloaded_error', 529))).toBe(true);
  });

  it('falls back to the network heuristic when there is no turn to consult', () => {
    // a raw socket failure from some non-LlmCallError call path
    expect(isRetryableModelCallError(new Error('connect ECONNRESET 1.2.3.4:443'))).toBe(true);
    expect(isRetryableModelCallError(new Error('JSON parse error'))).toBe(false);
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
