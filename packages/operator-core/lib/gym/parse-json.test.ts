/**
 * Unit tests for `tryParseJson` (gym/parse-json.ts) — recover a JSON object
 * from an LLM reply that may be bare, ```-fenced, or wrapped in prose.
 *
 * The function has three distinct branches, exercised here:
 *   1. fence-regex: a `^```(json)? … ```$`-fenced block → parse the inner text.
 *   2. already-valid: a bare JSON string (no fence) → parse directly.
 *   3. `{`…`}` slice-fallback: prose surrounds a JSON object → slice from the
 *      first `{` to the last `}` and parse that.
 *   4. unrecoverable: no parseable JSON anywhere → null.
 *
 * Pure + dependency-free; no mocks needed.
 */
import { describe, expect, it } from 'vitest';
import { tryParseJson } from './parse-json';

describe('tryParseJson — already-valid (no fence) branch', () => {
  it('parses a bare JSON object', () => {
    expect(tryParseJson('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
  });

  it('parses a bare JSON array', () => {
    expect(tryParseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(tryParseJson('   \n {"ok":true}\n  ')).toEqual({ ok: true });
  });

  it('parses a JSON primitive (number) directly', () => {
    expect(tryParseJson('42')).toBe(42);
  });

  it('parses the JSON literal null directly (distinct from the unrecoverable null)', () => {
    expect(tryParseJson('null')).toBeNull();
  });
});

describe('tryParseJson — fence-regex branch', () => {
  it('unwraps a ```json … ``` fenced object', () => {
    const text = '```json\n{"score": 0.5, "pass": true}\n```';
    expect(tryParseJson(text)).toEqual({ score: 0.5, pass: true });
  });

  it('unwraps a bare ``` … ``` fence (no json language tag)', () => {
    const text = '```\n{"x": [1, 2]}\n```';
    expect(tryParseJson(text)).toEqual({ x: [1, 2] });
  });

  it('handles a fence with no inner newline padding', () => {
    expect(tryParseJson('```json {"a":1} ```')).toEqual({ a: 1 });
  });

  it('only treats it as a fence when ``` anchors both start and end (^…$)', () => {
    // The regex is anchored: a fence in the MIDDLE of prose does not match the
    // fence branch — it falls through to the `{`…`}` slice instead, which still
    // recovers the object here.
    const text = 'Here is the answer:\n```json\n{"a":1}\n```\nThanks!';
    expect(tryParseJson(text)).toEqual({ a: 1 });
  });
});

describe('tryParseJson — { … } slice-fallback branch', () => {
  it('slices a JSON object out of surrounding prose', () => {
    const text = 'Sure! Here is the result: {"verdict":"pass","n":3} — hope that helps.';
    expect(tryParseJson(text)).toEqual({ verdict: 'pass', n: 3 });
  });

  it('uses the FIRST { and the LAST } (spans nested objects)', () => {
    const text = 'noise {"outer":{"inner":1},"k":2} trailing';
    expect(tryParseJson(text)).toEqual({ outer: { inner: 1 }, k: 2 });
  });

  it('recovers when prose precedes a fenced block that is not anchored', () => {
    const text = 'The model said:\n```json\n{"a":1,"b":2}\n```';
    // Anchored at start? trimmed starts with "The", so the fence branch misses;
    // the slice branch from first { to last } recovers it.
    expect(tryParseJson(text)).toEqual({ a: 1, b: 2 });
  });
});

describe('tryParseJson — unrecoverable → null', () => {
  it('returns null for plain prose with no braces', () => {
    expect(tryParseJson('just some words, no json here')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(tryParseJson('')).toBeNull();
  });

  it('returns null when the brace span is not valid JSON', () => {
    // first { … last } exists, but the slice is malformed JSON.
    expect(tryParseJson('prefix { not: valid, json } suffix')).toBeNull();
  });

  it('returns null when there is a { but no closing }', () => {
    expect(tryParseJson('open brace only: {"a": 1')).toBeNull();
  });

  it('returns null when } precedes { (no valid span: last > first fails)', () => {
    expect(tryParseJson('} then {')).toBeNull();
  });
});
