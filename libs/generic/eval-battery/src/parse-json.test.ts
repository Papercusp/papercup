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

describe('tryParseJson — balanced-scan branch (WI-35902)', () => {
  // The first-{-to-last-} slice assumes the reply's FIRST brace opens the payload. A
  // judge that reasons before answering breaks that assumption routinely, and every
  // case below returned null (→ "no parseable JSON output", a dead gym cycle) before
  // the balanced scan was added.
  it('recovers the payload when PROSE contains an earlier balanced brace', () => {
    const text = 'The harness wrote { a stub } in code. Verdict:\n{"d1":8,"d2":6,"d3":4,"rationale":"ok"}';
    expect(tryParseJson(text)).toEqual({ d1: 8, d2: 6, d3: 4, rationale: 'ok' });
  });

  it('recovers the payload when an earlier prose brace never closes at all', () => {
    const text = 'The trace showed { and then the verdict: {"d1":1,"d2":2,"d3":3,"rationale":"r"}';
    expect(tryParseJson(text)).toEqual({ d1: 1, d2: 2, d3: 3, rationale: 'r' });
  });

  it('recovers a fenced payload that follows brace-bearing prose', () => {
    const text = 'Considered { x } first.\n```json\n{"d1":5,"d2":5,"d3":5,"rationale":"r"}\n```\nDone.';
    expect(tryParseJson(text)).toEqual({ d1: 5, d2: 5, d3: 5, rationale: 'r' });
  });

  it('does NOT miscount braces that live inside a string literal', () => {
    const text = 'Note { pre } then {"rationale":"the harness emitted { } literally","d1":7}';
    expect(tryParseJson(text)).toEqual({ rationale: 'the harness emitted { } literally', d1: 7 });
  });

  it('skips a non-JSON balanced span and keeps scanning to the real payload', () => {
    const text = 'prefix { not: valid, json } then {"ok":true}';
    expect(tryParseJson(text)).toEqual({ ok: true });
  });

  it('still returns null for a TRUNCATED object (nothing balanced to recover)', () => {
    expect(tryParseJson('{"d1":8,"d2":6,"rationale":"cut off mid-str')).toBeNull();
  });

  it('does not invent data from a partial ARRAY span', () => {
    expect(tryParseJson('scores: [1, 2, ')).toBeNull();
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

describe('tryParseJson — whole-document validity precedence (pinned)', () => {
  // Found by fast-check (gym parse-json.property seed 1619552845, counterexample
  // [{}, '"', '"']): quote-pair "prose" around a JSON payload makes the ENTIRE
  // reply a valid JSON *string* — `" {} "` IS the JSON string " {} ". The parser's
  // documented precedence is whole-document validity FIRST, slice recovery only
  // when the whole document does not parse. Pinning it here keeps the choice
  // deliberate: flipping it would break bare-string round-trips (a plain string
  // value containing "{}" would start parsing as an object).
  it('a quote-wrapped object parses as the JSON string, not the embedded object', () => {
    expect(tryParseJson('" {} "')).toBe(' {} ');
  });

  it('an ESCAPED json-in-string stays a string (no double-unwrap)', () => {
    expect(tryParseJson('"{\\"a\\":1}"')).toBe('{"a":1}');
  });
});
