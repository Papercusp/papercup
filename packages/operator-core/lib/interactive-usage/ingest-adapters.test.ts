import { describe, expect, it } from 'vitest';
import { parseCodexChunk, parseOmpChunk, providerForModel, defaultAdapters } from './ingest-adapters';

const codexLine = (o: unknown) => JSON.stringify(o) + '\n';

describe('parseCodexChunk (P-015)', () => {
  const turnCtx = codexLine({
    timestamp: '2026-06-01T09:56:20.343Z',
    type: 'turn_context',
    payload: { turn_id: 't-1', model: 'gpt-5.5', effort: 'high' },
  });
  const tokenCount = (input: number, cached: number, output: number) =>
    codexLine({
      timestamp: '2026-06-01T09:56:30.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 99999, cached_input_tokens: 0, output_tokens: 9999 },
          last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
        },
      },
    });

  it('sums last_token_usage per token_count event under the turn_context model', () => {
    const { perModel, consumedBytes } = parseCodexChunk(turnCtx + tokenCount(17550, 9600, 14) + tokenCount(2000, 1500, 50));
    expect(consumedBytes).toBeGreaterThan(0);
    const d = perModel.get('gpt-5.5')!;
    expect(d.turns).toBe(2);
    // input INCLUDES the cached subset → uncached = input − cached.
    expect(d.inputTokens).toBe(17550 - 9600 + (2000 - 1500));
    expect(d.cacheReadTokens).toBe(9600 + 1500);
    expect(d.outputTokens).toBe(64);
    expect(d.cacheCreationTokens).toBe(0);
  });

  it('rate-limit-only token_count (info null) contributes nothing', () => {
    const rlOnly = codexLine({ type: 'event_msg', payload: { type: 'token_count', info: null } });
    const { perModel } = parseCodexChunk(turnCtx + rlOnly);
    expect(perModel.size).toBe(0);
  });

  it('falls back to the default model when no turn_context precedes usage', () => {
    const { perModel } = parseCodexChunk(tokenCount(100, 0, 10));
    expect([...perModel.keys()]).toEqual(['gpt-5.5']);
  });

  it('incomplete trailing line is not consumed', () => {
    const { consumedBytes } = parseCodexChunk('{"type":"event_msg"'); // no newline
    expect(consumedBytes).toBe(0);
  });
});

describe('parseOmpChunk (P-015)', () => {
  const msg = (id: string, usage: Record<string, number>, model = 'claude-opus-4-8') =>
    JSON.stringify({
      type: 'message',
      id,
      timestamp: '2026-05-09T04:16:15.309Z',
      message: { role: 'assistant', provider: 'anthropic', model, usage },
    }) + '\n';

  it('sums assistant message usage per model, deduped by line id (max-merge)', () => {
    const chunk =
      msg('a1', { input: 1313, output: 52, cacheRead: 29440, cacheWrite: 100 }) +
      msg('a1', { input: 1313, output: 60, cacheRead: 29440, cacheWrite: 100 }) + // same id, grown output
      msg('a2', { input: 200, output: 10, cacheRead: 0, cacheWrite: 0 }, 'gpt-5.5');
    const { perModel } = parseOmpChunk(chunk);
    const opus = perModel.get('claude-opus-4-8')!;
    expect(opus.turns).toBe(1);
    expect(opus.inputTokens).toBe(1313);
    expect(opus.outputTokens).toBe(60); // max-merged
    expect(opus.cacheReadTokens).toBe(29440);
    expect(opus.cacheCreationTokens).toBe(100);
    expect(perModel.get('gpt-5.5')!.turns).toBe(1);
  });

  it('ignores user messages and assistant messages without usage', () => {
    const user = JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', model: 'x' } }) + '\n';
    const noUsage = JSON.stringify({ type: 'message', id: 'a9', message: { role: 'assistant', model: 'x' } }) + '\n';
    expect(parseOmpChunk(user + noUsage).perModel.size).toBe(0);
  });
});

describe('providerForModel / defaultAdapters', () => {
  it('routes gpt/codex models to openai, claude models to anthropic', () => {
    expect(providerForModel('gpt-5.5')).toBe('openai');
    expect(providerForModel('claude-opus-4-8')).toBe('anthropic');
    expect(providerForModel('o3-mini')).toBe('openai');
  });

  it('default adapter set covers claude + codex + omp roots', () => {
    const names = defaultAdapters().map((a) => a.name);
    expect(names).toEqual(['claude', 'codex', 'omp']);
    for (const a of defaultAdapters()) expect(a.root).toMatch(/\/\.(claude|codex|omp)\//);
  });
});
