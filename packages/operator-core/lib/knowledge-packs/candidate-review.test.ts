/**
 * candidate-review unit tests (knowledge-pack-loop-integrity-2026-07-19
 * P-001/P-002): the transferability parse/judge contract — including the
 * D-004 error posture (unusable verdict ⇒ 'error', never a default pass) —
 * and the candidate-signature instance-token normalizer, pinned against the
 * two LIVE replication-liveness signatures that double-staged (they differ
 * only by log hash and must collapse to one).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildTransferabilityPrompt,
  judgeCandidateTransferability,
  normalizeCandidateSignature,
  parseTransferabilityResponse,
} from './candidate-review';

describe('parseTransferabilityResponse', () => {
  it('parses a pass with the distilled lesson (fields capped)', () => {
    const out = parseTransferabilityResponse(
      `Here you go:\n{"verdict":"pass","title":"Check replicator attachment, not connection count","lesson":"A live swarm connection does not imply replication: verify the log has an attached, ingesting replicator before trusting sync."}`,
    );
    expect(out).toMatchObject({
      verdict: 'pass',
      distilled: {
        title: 'Check replicator attachment, not connection count',
        text: expect.stringContaining('does not imply replication'),
      },
    });
  });

  it('parses a fail with its reason', () => {
    const out = parseTransferabilityResponse('{"verdict":"fail","reason":"ephemeral queue-depth report"}');
    expect(out).toEqual({ verdict: 'fail', reason: 'ephemeral queue-depth report' });
  });

  it('returns null (⇒ error posture) for junk, a pass without a lesson, and unknown verdicts', () => {
    expect(parseTransferabilityResponse('[]')).toBeNull(); // the no-API-key distiller's output
    expect(parseTransferabilityResponse('no json here')).toBeNull();
    expect(parseTransferabilityResponse('{"verdict":"pass"}')).toBeNull();
    expect(parseTransferabilityResponse('{"verdict":"maybe","lesson":"x"}')).toBeNull();
    expect(parseTransferabilityResponse('{"verdict":"pass","lesson":"   "}')).toBeNull();
  });
});

describe('judgeCandidateTransferability', () => {
  const candidate = {
    title: 'Hive papercup: fleet saturated',
    draftText: 'All 8 bee slot(s) are busy while 25 ready item(s) wait for placement.',
    scopes: ['harness:papercup'],
    recurrenceCount: 4,
  };

  it('sends the transferability prompt and maps a pass response', async () => {
    const llm = vi.fn(async () => ({
      text: '{"verdict":"pass","title":"Raise the ceiling before queueing","lesson":"When every worker slot is busy while work queues, widen capacity instead of letting the frontier grow."}',
      costUsd: 0,
    }));
    const out = await judgeCandidateTransferability(candidate, llm);
    expect(out.verdict).toBe('pass');
    expect(llm).toHaveBeenCalledWith(
      expect.objectContaining({
        system: buildTransferabilityPrompt(),
        user: expect.stringContaining('All 8 bee slot(s)'),
      }),
    );
  });

  it('maps an LLM throw to verdict error (D-004: stays pending, never adopt-by-default)', async () => {
    const llm = vi.fn(async () => {
      throw new Error('gateway 429');
    });
    const out = await judgeCandidateTransferability(candidate, llm);
    expect(out.verdict).toBe('error');
    expect(out.reason).toContain('gateway 429');
  });

  it('maps an unusable response to verdict error', async () => {
    const llm = vi.fn(async () => ({ text: '[]', costUsd: 0 }));
    const out = await judgeCandidateTransferability(candidate, llm);
    expect(out.verdict).toBe('error');
  });

  it("NAMES the unkeyed-distiller no-op sentinel ('[]') in the error reason — P-001, the 28-day silent-death diagnosis", async () => {
    const llm = vi.fn(async () => ({ text: '[]', costUsd: 0 }));
    const out = await judgeCandidateTransferability(candidate, llm);
    expect(out.verdict).toBe('error');
    expect(out.reason).toContain('NO-OP sentinel');
    expect(out.reason).toContain('retrying cannot help');
  });

  it('carries a bounded RAW-RESPONSE snippet in the parse-null error reason (P-001: never discard the evidence)', async () => {
    const llm = vi.fn(async () => ({
      text: 'I think this lesson is transferable because'.padEnd(500, ' etc'),
      costUsd: 0,
    }));
    const out = await judgeCandidateTransferability(candidate, llm);
    expect(out.verdict).toBe('error');
    expect(out.reason).toContain('raw response');
    expect(out.reason).toContain('I think this lesson is transferable');
    expect(out.reason).toContain('first 300 of 500 chars');
    // bounded: the reason never carries the whole response
    expect(out.reason.length).toBeLessThan(500);
  });
});

describe('normalizeCandidateSignature (P-002)', () => {
  it('collapses the two live replication-liveness signatures (differ only by log hash) to one key', () => {
    const a = normalizeCandidateSignature(
      '183 6b29d5e853eb class connected harness hello hive liveness log never replicated replication world',
    );
    const b = normalizeCandidateSignature(
      '183 5741efa1c7dd class connected harness hello hive liveness log never replicated replication world',
    );
    expect(a).toBe(b);
    expect(a).toBe('class connected harness hello hive liveness log never replicated replication world');
  });

  it('strips uuids, bare numbers, and …-truncated hex ids; keeps ordinary words', () => {
    expect(
      normalizeCandidateSignature('retry 42 f81d4fae-7dec-11d0-a765-00a0c91e6bf6 timeout 6b29d5e853eb… fleet'),
    ).toBe('retry timeout fleet');
    // pure-alpha words that happen to be hex letters survive (no digit)
    expect(normalizeCandidateSignature('deadbeef cafe added fleet')).toBe('deadbeef cafe added fleet');
  });

  it('falls back to the original when stripping would empty the signature', () => {
    expect(normalizeCandidateSignature('12345 6b29d5e853eb99')).toBe('12345 6b29d5e853eb99');
  });
});
