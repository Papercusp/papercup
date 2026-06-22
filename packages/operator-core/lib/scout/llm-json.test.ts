/**
 * llm-json — unit coverage for parseLlmJson, the tolerant JSON extractor for
 * Scout LLM responses. The cheaper critic/recombine models sometimes emit
 * ```json fences or prose around the object despite responseFormat:'json', so a
 * wrong/throwing parse would drop or garble a scout verdict. Pure — no IO.
 */
import { describe, it, expect } from 'vitest';
import { parseLlmJson } from './llm-json';

describe('parseLlmJson', () => {
  it('prefers the structured json field verbatim, ignoring the text', () => {
    expect(parseLlmJson({ text: 'not json at all', json: { a: 1 } })).toEqual({ a: 1 });
    expect(parseLlmJson({ text: '', json: [1, 2, 3] })).toEqual([1, 2, 3]);
  });

  it('returns falsy-but-non-null json fields verbatim (0 / false / "" — only null/undefined fall through)', () => {
    expect(parseLlmJson({ text: '{"fallback":true}', json: 0 })).toBe(0);
    expect(parseLlmJson({ text: '{"fallback":true}', json: false })).toBe(false);
    expect(parseLlmJson({ text: '{"fallback":true}', json: '' })).toBe('');
  });

  it('parses plain JSON text when no structured field is present', () => {
    expect(parseLlmJson({ text: '{"x": 1, "y": [2,3]}' })).toEqual({ x: 1, y: [2, 3] });
    expect(parseLlmJson({ text: '  [true, null, "z"]  ' })).toEqual([true, null, 'z']);
  });

  it('strips a ```json fence (and a bare ``` fence), incl. surrounding prose', () => {
    expect(parseLlmJson({ text: '```json\n{"ok": true}\n```' })).toEqual({ ok: true });
    expect(parseLlmJson({ text: '```\n{"ok": false}\n```' })).toEqual({ ok: false });
    expect(parseLlmJson({ text: 'Here you go:\n```json\n{"n": 7}\n```\nHope that helps!' })).toEqual({ n: 7 });
  });

  it('falls back to the first balanced {...} block when the whole body is not valid JSON', () => {
    expect(parseLlmJson({ text: 'The answer is {"score": 9, "why": "good"} — trust me.' })).toEqual({
      score: 9,
      why: 'good',
    });
  });

  it('returns null for unparseable / empty text — never throws', () => {
    expect(parseLlmJson({ text: 'just some prose, no json here' })).toBeNull();
    expect(parseLlmJson({ text: '' })).toBeNull();
    expect(parseLlmJson({ text: '```json\nnot { valid json\n```' })).toBeNull(); // a { but no closing }
  });
});
