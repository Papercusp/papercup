import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelClassForModel, parseTranscriptChunk, readFileDelta } from './ingest-claude-transcripts';

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
    });
  });

  it('counts bytes, not characters, for multibyte content', () => {
    const line = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 }, note: 'héllo — ünïcode ✓' } }) + '\n';
    const { consumedBytes } = parseTranscriptChunk(line);
    expect(consumedBytes).toBe(Buffer.byteLength(line, 'utf8'));
    expect(consumedBytes).toBeGreaterThan(line.length); // multibyte ⇒ bytes > chars
  });
});

describe('modelClassForModel', () => {
  it('maps model ids to bucket classes', () => {
    expect(modelClassForModel('claude-opus-4-8')).toBe('opus');
    expect(modelClassForModel('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelClassForModel('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelClassForModel('gpt-5.2')).toBe('default');
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
