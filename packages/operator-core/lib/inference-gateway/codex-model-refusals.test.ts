/**
 * WI-10003306 — the per-(account, model) refusal registry that lets the gateway route around a
 * ChatGPT account for ONE model without removing it from the pool or parking it for others.
 */
import { describe, expect, it } from 'vitest';
import {
  CODEX_MODEL_REFUSAL_RE,
  codexModelRefusalDetail,
  createCodexModelRefusalRegistry,
  isCodexModelRefusal,
} from './codex-model-refusals';

const LIVE_BODY = `{"detail":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}`;

describe('isCodexModelRefusal', () => {
  it('recognises the live backend refusal body (captured 2026-09-26)', () => {
    expect(isCodexModelRefusal(400, LIVE_BODY)).toBe(true);
    expect(CODEX_MODEL_REFUSAL_RE.test(LIVE_BODY)).toBe(true);
  });

  it('ignores auth, rate-limit and server statuses even when the wording matches', () => {
    for (const status of [200, 401, 403, 429, 500, 503]) expect(isCodexModelRefusal(status, LIVE_BODY)).toBe(false);
  });

  it('ignores an ordinary 4xx that is not about the model', () => {
    expect(isCodexModelRefusal(400, '{"detail":"Input must be a list"}')).toBe(false);
  });

  it('extracts the backend detail for logs and stats', () => {
    expect(codexModelRefusalDetail(LIVE_BODY)).toBe(
      "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(codexModelRefusalDetail('plain text refusal')).toBe('plain text refusal');
  });
});

describe('createCodexModelRefusalRegistry', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('marks exactly the refused (account, model) pair — other models and accounts stay eligible', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, now: c.now });

    expect(reg.record('aviynw3_codex', 'gpt-6-sol', 'refused')).toBe(true);

    expect(reg.isRefused('aviynw3_codex', 'gpt-6-sol')).toBe(true);
    expect(reg.isRefused('aviynw3_codex', 'GPT-6-SOL ')).toBe(true);
    expect(reg.isRefused('aviynw3_codex', 'gpt-5.6-luna')).toBe(false);
    expect(reg.isRefused('aviynw6_codex', 'gpt-6-sol')).toBe(false);
  });

  it('reports a transition only once per episode, extending the window on repeats', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, now: c.now });

    expect(reg.record('a', 'm', 'first')).toBe(true);
    c.advance(50_000);
    expect(reg.record('a', 'm', 'again')).toBe(false);
    c.advance(50_000); // 100s after the first hit, 50s after the repeat
    expect(reg.isRefused('a', 'm')).toBe(true);
    expect(reg.snapshot()).toEqual([expect.objectContaining({ accountId: 'a', model: 'm', hits: 2, detail: 'again' })]);
  });

  it('recovers automatically: the mark lapses after the TTL, and a 2xx clears it at once', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, now: c.now });

    reg.record('a', 'm', 'x');
    c.advance(60_001);
    expect(reg.isRefused('a', 'm')).toBe(false);
    expect(reg.snapshot()).toEqual([]);

    reg.record('b', 'm', 'x');
    expect(reg.clear('b', 'm')).toBe(true);
    expect(reg.isRefused('b', 'm')).toBe(false);
    expect(reg.clear('b', 'm')).toBe(false);
  });

  it('stays bounded under a flood of distinct pairs', () => {
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, maxEntries: 3 });
    for (let i = 0; i < 10; i++) reg.record(`acct-${i}`, 'm', 'x');
    expect(reg.snapshot()).toHaveLength(3);
  });
});
