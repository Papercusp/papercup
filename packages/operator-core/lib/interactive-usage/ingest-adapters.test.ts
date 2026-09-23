import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  advSessionIdFromCodexHome,
  codexSessionIdForFile,
  codexSessionRoots,
  defaultAdapters,
  parseCodexChunk,
  parseOmpChunk,
  providerForModel,
  UNKNOWN_CODEX_MODEL,
} from './ingest-adapters';

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
          total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
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

  it('keeps the model unknown when no observed turn_context precedes usage', () => {
    const { perModel } = parseCodexChunk(tokenCount(100, 0, 10));
    expect([...perModel.keys()]).toEqual([UNKNOWN_CODEX_MODEL]);
    expect(providerForModel(UNKNOWN_CODEX_MODEL)).toBe('openai');
  });

  it('preserves the native turn identity across chunks without inventing a trigger', () => {
    const first = parseCodexChunk(turnCtx);
    const second = parseCodexChunk(tokenCount(1000, 600, 40), JSON.parse(JSON.stringify(first.parserState)));
    expect(second.events?.[0].turnId).toBe('t-1');
    expect(second.parserState?.turnId).toBe('t-1');
    const sparse = parseCodexChunk(codexLine({ type: 'turn_context', payload: { turn_id: 't-2' } }) + tokenCount(2000, 600, 40), second.parserState);
    expect(sparse.events?.[0]).toMatchObject({ turnId: 't-2', model: 'gpt-5.5' });
  });

  it('preserves an observed model across a chunk boundary and a serialized restart', () => {
    const first = parseCodexChunk(codexLine({ type: 'turn_context', payload: { model: 'gpt-6-luna' } }));
    const persisted = JSON.parse(JSON.stringify(first.parserState));
    const second = parseCodexChunk(tokenCount(1000, 600, 40), persisted);
    expect([...second.perModel.keys()]).toEqual(['gpt-6-luna']);
    expect(second.perModel.get('gpt-6-luna')?.inputTokens).toBe(400);
    expect(persisted).toEqual({ model: 'gpt-6-luna' }); // parsing does not mutate the committed state
  });

  it('updates the model when the source changes it, without relabeling earlier usage', () => {
    const chunk = turnCtx + tokenCount(1000, 600, 40) +
      codexLine({ type: 'turn_context', payload: { model: 'gpt-6-astra' } }) + tokenCount(2000, 1500, 60);
    const parsed = parseCodexChunk(chunk);
    expect([...parsed.perModel.keys()]).toEqual(['gpt-5.5', 'gpt-6-astra']);
    expect(parsed.parserState?.model).toBe('gpt-6-astra');
  });

  it('deduplicates repeated cumulative usage across chunks but counts distinct requests with identical last usage', () => {
    const event = tokenCount(1000, 600, 40);
    const first = parseCodexChunk(turnCtx + event + event);
    expect(first.perModel.get('gpt-5.5')?.turns).toBe(1);
    const second = parseCodexChunk(event, JSON.parse(JSON.stringify(first.parserState)));
    expect(second.perModel.size).toBe(0);
    const next = JSON.parse(event);
    next.payload.info.total_token_usage = { input_tokens: 2000, cached_input_tokens: 1200, output_tokens: 80 };
    expect(parseCodexChunk(codexLine(next), second.parserState).perModel.get('gpt-5.5')?.turns).toBe(1);
  });

  it('ignores zero-usage resets and records sparse fork lineage without guessing its model', () => {
    const parsed = parseCodexChunk(
      codexLine({ type: 'session_meta', payload: { forked_from_id: 'parent-session' } }) +
      tokenCount(0, 0, 0) + codexLine({ type: 'compacted' }) + tokenCount(1000, 600, 40),
    );
    expect(parsed.perModel.get(UNKNOWN_CODEX_MODEL)?.turns).toBe(1);
    expect(parsed.parserState).toMatchObject({ predecessorSessionId: 'parent-session', contextGeneration: 1 });
    expect(parsed.parserState?.model).toBeUndefined();
  });

  it('does not treat empty or invalid cumulative metadata as a request identity', () => {
    for (const total of [{}, { unrelated: 1 }, { input_tokens: -1 }, { input_tokens: 'bad' }]) {
      const event = JSON.parse(tokenCount(1000, 600, 40));
      event.payload.info.total_token_usage = total;
      const parsed = parseCodexChunk(turnCtx + codexLine(event) + codexLine(event));
      expect(parsed.perModel.get('gpt-5.5')?.turns).toBe(2);
      expect(parsed.events?.map((e) => e.sourceId)[0]).not.toBe(parsed.events?.map((e) => e.sourceId)[1]);
    }
  });

  it('ignores changing non-token metadata in a repeated cumulative notification', () => {
    const event = JSON.parse(tokenCount(1000, 600, 40));
    const first = parseCodexChunk(turnCtx + codexLine(event));
    event.payload.info.total_token_usage.received_at = 123;
    expect(parseCodexChunk(codexLine(event), first.parserState).events).toEqual([]);
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

describe('codex session identity + per-session isolation roots (WI-2140701 (a))', () => {
  it('codexSessionIdForFile: rollout-<ts>-<uuid>.jsonl → the bare uuid (= adv_sessions.session_id)', () => {
    expect(
      codexSessionIdForFile(
        '/home/x/.papercusp/su-codex-homes/session-21396/sessions/2026/09/02/rollout-2026-09-02T01-10-49-01a06086-e882-7e10-9079-aa29e6a00097.jsonl',
      ),
    ).toBe('01a06086-e882-7e10-9079-aa29e6a00097');
  });

  it('codexSessionIdForFile: a non-rollout name falls back to the basename (the pre-fix behaviour)', () => {
    expect(codexSessionIdForFile('/tmp/whatever/abc-123.jsonl')).toBe('abc-123');
  });

  it('only the default codex adapter carries the rollout extractor; claude/omp keep the basename default', () => {
    const byName = new Map(defaultAdapters().map((a) => [a.name, a]));
    expect(byName.get('codex')?.sessionIdForFile).toBe(codexSessionIdForFile);
    expect(byName.get('claude')?.sessionIdForFile).toBeUndefined();
    expect(byName.get('omp')?.sessionIdForFile).toBeUndefined();
  });

  it('parseCodexChunk captures cache_write_input_tokens as cacheCreationTokens', () => {
    const chunk = codexLine({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 250, output_tokens: 40 },
        },
      },
    });
    const d = parseCodexChunk(chunk).perModel.get(UNKNOWN_CODEX_MODEL)!;
    expect(d).toMatchObject({ turns: 1, inputTokens: 150, cacheReadTokens: 600, cacheCreationTokens: 250, outputTokens: 40 });
    expect(d.inputTokens + d.cacheReadTokens + d.cacheCreationTokens).toBe(1000);
  });

  it('codexSessionRoots: one root per <base>/<home>/sessions; homes without one and stray files are skipped; missing base → []', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-homes-'));
    try {
      await fs.mkdir(path.join(base, 'session-1', 'sessions', '2026', '09', '02'), { recursive: true });
      await fs.mkdir(path.join(base, 'session-2', 'config-only'), { recursive: true });
      await fs.writeFile(path.join(base, 'stray.txt'), 'x');
      expect(await codexSessionRoots(base)).toEqual([path.join(base, 'session-1', 'sessions')]);
      expect(await codexSessionRoots(path.join(base, 'does-not-exist'))).toEqual([]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  // WI-2144763 / migration 1120. The value this lifts is adv_sessions.id (the PK),
  // which is what lets the INSERT stamp harness_slug for a psu codex session
  // without a join. Codex was ~92% of the post-1119 attribution gap because its
  // adapter carried no such key and fell through to the session route, which
  // cannot find these rows at all (their session_id is the rollout uuid).
  describe('advSessionIdFromCodexHome', () => {
    it('lifts adv_sessions.id from a <base>/session-<advId>/sessions root', () => {
      expect(advSessionIdFromCodexHome(path.join('/b', 'session-12441', 'sessions'))).toBe(12441);
      // Pairs with codexSessionRoots above: whatever that returns must be parseable.
      expect(advSessionIdFromCodexHome(path.join('/tmp/codex-homes-x', 'session-1', 'sessions'))).toBe(1);
    });

    it('returns undefined — never NaN — for a root that carries no adv id', () => {
      // Each of these would bind NaN into the INSERT if this parsed loosely, and a
      // NaN bind is far worse than the NULL that degrades to the session fallback.
      for (const root of [
        path.join('/b', 'notsession-1', 'sessions'), // wrong prefix
        path.join('/b', 'session-abc', 'sessions'), // non-numeric id
        path.join('/b', 'session-', 'sessions'), // empty id
        path.join('/b', 'session-12x4', 'sessions'), // partially numeric
        path.join('/home/u', '.claude', 'projects'), // a claude root, not codex
      ]) {
        expect(advSessionIdFromCodexHome(root)).toBeUndefined();
      }
    });

    it('rejects a non-positive or unsafe id rather than binding it', () => {
      expect(advSessionIdFromCodexHome(path.join('/b', 'session-0', 'sessions'))).toBeUndefined();
      expect(
        advSessionIdFromCodexHome(path.join('/b', `session-${'9'.repeat(25)}`, 'sessions')),
      ).toBeUndefined();
    });
  });
});
