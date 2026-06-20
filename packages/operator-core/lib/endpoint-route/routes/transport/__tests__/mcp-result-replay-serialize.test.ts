/**
 * Unit tests for serializeStoredMcpResult (app-wide-load-traps F-A1-part2).
 *
 * These are pure-unit (no DB) so they always run. The integration tests in
 * mcp-result-replay.integration.test.ts cover the full storeMcpResult round-trip
 * but require a live PG connection.
 *
 * The key invariants we pin:
 *   1. text items are correctly JSON-quoted (not bare-interpolated) — the bug
 *      that lived briefly in the initial implementation.
 *   2. isError / _meta are correctly appended inside the root object (not
 *      after the closing brace — the JSON-truncation bug that also lived briefly).
 *   3. The output is always valid JSON that round-trips back to the original shape.
 */

import { describe, it, expect } from 'vitest';
import { serializeStoredMcpResult, type StoredMcpResult } from '../_mcp-result-replay';

function roundTrip(result: StoredMcpResult): unknown {
  return JSON.parse(serializeStoredMcpResult(result));
}

describe('serializeStoredMcpResult', () => {
  it('produces valid JSON for a text item with a plain string', () => {
    const result: StoredMcpResult = {
      content: [{ type: 'text', text: 'hello world' }],
    };
    const parsed = roundTrip(result) as { content: Array<{ type: string; text: string }> };
    expect(parsed.content[0].text).toBe('hello world');
  });

  it('correctly quotes text that is itself a JSON string (the bare-interpolation bug)', () => {
    // `typed.text` must be JSON.stringify'd, not bare-interpolated —
    // bare `${typed.text}` would embed the raw JSON characters without
    // quotes, producing invalid JSON for a string value.
    const result: StoredMcpResult = {
      content: [{ type: 'text', text: '{"ok":true,"created":"WI-42"}' }],
    };
    const parsed = roundTrip(result) as { content: Array<{ type: string; text: string }> };
    // Must survive the round-trip as a string, not parsed into an object.
    expect(typeof parsed.content[0].text).toBe('string');
    expect(parsed.content[0].text).toBe('{"ok":true,"created":"WI-42"}');
  });

  it('correctly quotes text containing double-quotes and backslashes', () => {
    const result: StoredMcpResult = {
      content: [{ type: 'text', text: 'she said "hello" and \\escaped\\' }],
    };
    const parsed = roundTrip(result) as { content: Array<{ type: string; text: string }> };
    expect(parsed.content[0].text).toBe('she said "hello" and \\escaped\\');
  });

  it('appends isError INSIDE the root object (not after the closing brace)', () => {
    // The truncation bug: building `{"content":[...]}` then appending `,"isError":true`
    // produced trailing content past the root object — invalid JSON / PG cast error.
    const result: StoredMcpResult = {
      content: [{ type: 'text', text: 'claim_conflict: held by peer' }],
      isError: true,
    };
    const parsed = roundTrip(result) as { content: unknown[]; isError?: boolean };
    expect(parsed.isError).toBe(true);
  });

  it('appends _meta INSIDE the root object', () => {
    const result: StoredMcpResult = {
      content: [{ type: 'text', text: 'ok' }],
      _meta: { format: 'json', source: 'test' },
    };
    const parsed = roundTrip(result) as { content: unknown[]; _meta?: Record<string, unknown> };
    expect(parsed._meta).toEqual({ format: 'json', source: 'test' });
  });

  it('handles multiple content items — text and non-text mixed', () => {
    const result: StoredMcpResult = {
      content: [
        { type: 'text', text: 'summary line' },
        { type: 'resource', uri: 'https://example.com', mimeType: 'text/plain' } as Record<string, unknown>,
      ],
    };
    const parsed = roundTrip(result) as { content: Array<Record<string, unknown>> };
    expect(parsed.content).toHaveLength(2);
    expect(parsed.content[0].text).toBe('summary line');
    expect(parsed.content[1].uri).toBe('https://example.com');
  });

  it('handles empty content array', () => {
    const result: StoredMcpResult = { content: [] };
    const parsed = roundTrip(result) as { content: unknown[] };
    expect(parsed.content).toEqual([]);
  });

  it('omits isError when not set', () => {
    const result: StoredMcpResult = { content: [] };
    const parsed = roundTrip(result) as Record<string, unknown>;
    expect('isError' in parsed).toBe(false);
  });

  it('omits _meta when not set', () => {
    const result: StoredMcpResult = { content: [] };
    const parsed = roundTrip(result) as Record<string, unknown>;
    expect('_meta' in parsed).toBe(false);
  });

  it('full payload: content + isError + _meta all together', () => {
    const result: StoredMcpResult = {
      content: [{ type: 'text', text: '{"ok":true}' }],
      isError: false,
      _meta: { replayed: false, requestId: 'r-123' },
    };
    const parsed = roundTrip(result) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    expect(parsed.content[0].text).toBe('{"ok":true}');
    // isError:false is falsy — the serializer skips it (consistent with the
    // stored schema where absence means no error).
    expect(parsed.isError).toBeUndefined();
    expect(parsed._meta?.requestId).toBe('r-123');
  });
});
