/**
 * Unit tests for `tryParseJson` — recover a JSON object from an LLM reply that may be
 * bare, ```-fenced, or wrapped in prose. Ported from the gym (the source moved into the
 * shared eval-battery engine, reconciliation D-001). Pure + dependency-free.
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

  it('recovers a fenced block in the middle of prose via the slice fallback', () => {
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
});

describe('tryParseJson — unrecoverable → null', () => {
  it('returns null for plain prose with no braces', () => {
    expect(tryParseJson('just some words, no json here')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(tryParseJson('')).toBeNull();
  });

  it('returns null when the brace span is not valid JSON', () => {
    expect(tryParseJson('prefix { not: valid, json } suffix')).toBeNull();
  });

  it('returns null when there is a { but no closing }', () => {
    expect(tryParseJson('open brace only: {"a": 1')).toBeNull();
  });

  it('returns null when } precedes { (no valid span: last > first fails)', () => {
    expect(tryParseJson('} then {')).toBeNull();
  });
});
