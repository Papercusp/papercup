import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costFromTokens } from '@papercusp/model-pricing';
import { mergeTranscriptUsage, modelClassForModel, parseTranscriptChunk, readFileDelta, transcriptEventTime } from './ingest-claude-transcripts';

const turn = (model: string, usage: Record<string, number>, type = 'assistant', id?: string): string =>
  JSON.stringify({ type, message: { ...(id ? { id } : {}), model, usage } });

describe('parseTranscriptChunk', () => {
  it('accumulates assistant usage per model and ignores other event types', () => {
    const chunk =
      [
        turn('claude-opus-4-8', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        turn('claude-opus-4-8', { input_tokens: 5, output_tokens: 5 }),
        turn('claude-haiku-4-5-20251001', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 30 }),
      ].join('\n') + '\n';
    const { perModel, consumedBytes } = parseTranscriptChunk(chunk);
    expect(consumedBytes).toBe(Buffer.byteLength(chunk, 'utf8'));
    expect(perModel.get('claude-opus-4-8')).toEqual({
      turns: 2,
      inputTokens: 15,
      outputTokens: 25,
      cacheReadTokens: 1000,
      cacheCreationTokens: 500,
      cacheCreationTierUnknown: true,
    });
    expect(perModel.get('claude-haiku-4-5-20251001')?.cacheReadTokens).toBe(30);
  });

  it('leaves a trailing partial line unconsumed (mid-write tail)', () => {
    const complete = turn('claude-opus-4-8', { input_tokens: 1, output_tokens: 1 }) + '\n';
    const partial = '{"type":"assistant","message":{"model":"claude-opus-4-8","usa';
    const { perModel, consumedBytes } = parseTranscriptChunk(complete + partial);
    expect(consumedBytes).toBe(Buffer.byteLength(complete, 'utf8'));
    expect(perModel.get('claude-opus-4-8')?.turns).toBe(1);
  });

  it('consumes nothing when there is no complete line', () => {
    const { perModel, consumedBytes } = parseTranscriptChunk('{"type":"assi');
    expect(consumedBytes).toBe(0);
    expect(perModel.size).toBe(0);
  });

  it('skips synthetic models and torn lines but still consumes them', () => {
    const chunk =
      [turn('<synthetic>', { input_tokens: 99, output_tokens: 99 }), 'not-json-at-all', turn('claude-sonnet-4-6', { input_tokens: 3, output_tokens: 4 })].join('\n') +
      '\n';
    const { perModel, consumedBytes } = parseTranscriptChunk(chunk);
    expect(consumedBytes).toBe(Buffer.byteLength(chunk, 'utf8'));
    expect([...perModel.keys()]).toEqual(['claude-sonnet-4-6']);
  });

  it('dedupes multi-line messages sharing one message.id (one API call = one turn)', () => {
    const u = { input_tokens: 7, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 };
    const chunk =
      [
        turn('claude-opus-4-8', u, 'assistant', 'msg_01'), // text block
        turn('claude-opus-4-8', u, 'assistant', 'msg_01'), // tool_use block — same call, repeated usage
        turn('claude-opus-4-8', { ...u, output_tokens: 120 }, 'assistant', 'msg_01'), // streamed growth — max wins
        turn('claude-opus-4-8', u, 'assistant', 'msg_02'),
      ].join('\n') + '\n';
    const { perModel } = parseTranscriptChunk(chunk);
    expect(perModel.get('claude-opus-4-8')).toEqual({
      turns: 2,
      inputTokens: 14,
      outputTokens: 220, // 120 (max of msg_01) + 100 (msg_02)
      cacheReadTokens: 10000,
      cacheCreationTokens: 400,
      cacheCreationTierUnknown: true,
    });
  });

  it('counts bytes, not characters, for multibyte content', () => {
    const line = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 }, note: 'héllo — ünïcode ✓' } }) + '\n';
    const { consumedBytes } = parseTranscriptChunk(line);
    expect(consumedBytes).toBe(Buffer.byteLength(line, 'utf8'));
    expect(consumedBytes).toBeGreaterThan(line.length); // multibyte ⇒ bytes > chars
  });
  it('carries reported write tiers through message deduplication into the canonical price calculation', () => {
    const line = JSON.stringify({ type: 'assistant', message: {
      id: 'tiered-message', model: 'claude-opus-4-8', usage: {
        input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 2_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      },
    } }) + '\n';
    const usage = parseTranscriptChunk(line + line).perModel.get('claude-opus-4-8')!;
    expect(usage).toEqual({ turns: 1, inputTokens: 100_000, outputTokens: 0,
      cacheReadTokens: 2_000_000, cacheCreationTokens: 1_000_000,
      cacheCreation5mTokens: 0, cacheCreation1hTokens: 1_000_000 });
    expect(costFromTokens('claude-opus-4-8', usage)).toEqual({ priced: true, usd: 11.5 });
  });
  it('does not price an unreported write tier as five minutes', () => {
    const usage = parseTranscriptChunk(turn('claude-opus-4-8', {
      input_tokens: 5, cache_creation_input_tokens: 1000,
    }) + '\n').perModel.get('claude-opus-4-8')!;
    expect(usage.cacheCreationTierUnknown).toBe(true);
    expect(costFromTokens('claude-opus-4-8', usage)).toEqual({ priced: false, usd: 0 });
  });

  it('retains stable source identity and timestamp separately from chunk-relative offsets', () => {
    const event = JSON.stringify({ type: 'assistant', timestamp: '2026-09-23T10:00:00Z',
      message: { id: 'native-request', model: 'claude-opus-4-8', usage: { input_tokens: 1 } } }) + '\n';
    const first = parseTranscriptChunk(event);
    const second = parseTranscriptChunk('garbage\n' + event);
    expect(first.events?.[0].sourceId).toBe(second.events?.[0].sourceId);
    expect(second.events?.[0].relativeOffset).toBe(8);
    expect(second.events?.[0].eventTime).toBe(Date.parse('2026-09-23T10:00:00Z'));
    expect(transcriptEventTime('not-a-time')).toBeNull();
    expect(transcriptEventTime(undefined)).toBeNull();
  });

  it('preserves known tiers on a repeat, but does not assume them when total writes grow', () => {
    const known = { turns: 1, inputTokens: 1, outputTokens: 10, cacheReadTokens: 50,
      cacheCreationTokens: 100, cacheCreation5mTokens: 0, cacheCreation1hTokens: 100 };
    const repeated = { turns: 1, inputTokens: 1, outputTokens: 12, cacheReadTokens: 50,
      cacheCreationTokens: 100, cacheCreationTierUnknown: true };
    expect(mergeTranscriptUsage(known, repeated)).toEqual({ ...known, outputTokens: 12 });
    expect(mergeTranscriptUsage(known, { ...repeated, cacheCreationTokens: 200 })).toEqual({
      ...repeated, cacheCreationTokens: 200,
    });
  });
});

describe('modelClassForModel', () => {
  it('maps model ids to bucket classes', () => {
    expect(modelClassForModel('claude-opus-4-8')).toBe('opus');
    expect(modelClassForModel('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelClassForModel('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelClassForModel('gpt-5.2')).toBe('gpt'); // P-015: codex models get their own bucket class
    expect(modelClassForModel('mystery-model')).toBe('default');
  });
});

describe('readFileDelta', () => {
  it('reads only past the offset and respects the byte cap', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-test-'));
    const file = path.join(dir, 's.jsonl');
    const a = turn('claude-opus-4-8', { input_tokens: 1, output_tokens: 1 }) + '\n';
    const b = turn('claude-opus-4-8', { input_tokens: 2, output_tokens: 2 }) + '\n';
    await fs.writeFile(file, a + b);
    const offsetOfB = Buffer.byteLength(a, 'utf8');
    expect(await readFileDelta(file, offsetOfB, 1024 * 1024)).toBe(b);
    expect(await readFileDelta(file, 0, 5)).toBe((a + b).slice(0, 5));
    expect(await readFileDelta(file, Buffer.byteLength(a + b, 'utf8'), 1024)).toBe('');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
