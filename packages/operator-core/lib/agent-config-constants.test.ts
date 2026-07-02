import { describe, expect, it } from 'vitest';
import {
  MODEL_WINDOW_1M,
  MODEL_WINDOW_DEFAULT,
  COMPACTION_LIMIT_DEFAULT_1M_CAP,
  modelWindowForSpec,
  isDefault1mModelSpec,
  defaultCompactionLimitForSpec,
  clampCompactionLimit,
  MIN_COMPACTION_LIMIT_TOKENS,
} from './agent-config-constants';

// opus + fable default to the FULL 1M window but papercusp compacts them
// preemptively at 500k (owner directive 2026-07-02). This file pins BOTH halves:
// the window (isDefault1mModelSpec / modelWindowForSpec) and the compaction cap
// (defaultCompactionLimitForSpec / clampCompactionLimit). Twin of psu-launcher
// normalizeModelSpec, which injects the [1m] launch marker for the same families.

describe('isDefault1mModelSpec (opus/fable are the default-1M families)', () => {
  it('is true for opus and fable specs (with or without effort / id prefix)', () => {
    for (const spec of ['opus', 'opus:high', 'claude-opus-4-8', 'fable', 'claude-fable-5:xhigh']) {
      expect(isDefault1mModelSpec(spec)).toBe(true);
    }
  });
  it('is false for other families and nullish specs', () => {
    for (const spec of ['sonnet', 'sonnet:high', 'haiku', 'gpt-5.5', 'ornith']) {
      expect(isDefault1mModelSpec(spec)).toBe(false);
    }
    expect(isDefault1mModelSpec(null)).toBe(false);
    expect(isDefault1mModelSpec(undefined)).toBe(false);
  });
});

describe('modelWindowForSpec', () => {
  it('opus/fable get the 1M window even without the [1m] marker', () => {
    expect(modelWindowForSpec('opus')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('claude-fable-5:xhigh')).toBe(MODEL_WINDOW_1M);
  });
  it('an explicit [1m] marker forces 1M for any family', () => {
    expect(modelWindowForSpec('sonnet[1m]')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('opus[1m]:xhigh')).toBe(MODEL_WINDOW_1M);
  });
  it('everything else (incl. null/sonnet/haiku) is the conservative 200k', () => {
    expect(modelWindowForSpec('sonnet')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('haiku')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec(null)).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec(undefined)).toBe(MODEL_WINDOW_DEFAULT);
  });
});

describe('defaultCompactionLimitForSpec', () => {
  it('opus/fable are capped at 500k (preemptive compaction despite the 1M window)', () => {
    expect(COMPACTION_LIMIT_DEFAULT_1M_CAP).toBe(500_000);
    expect(defaultCompactionLimitForSpec('opus')).toBe(500_000);
    expect(defaultCompactionLimitForSpec('opus:xhigh')).toBe(500_000);
    expect(defaultCompactionLimitForSpec('claude-fable-5:xhigh')).toBe(500_000);
  });
  it('a non-opus/fable [1m] spec keeps the window-derived 825k default', () => {
    // floor((1_000_000 - 10_000) / 1.2 / 1000) * 1000 = 825_000
    expect(defaultCompactionLimitForSpec('sonnet[1m]')).toBe(825_000);
  });
  it('a 200k-window spec derives 158k', () => {
    // floor((200_000 - 10_000) / 1.2 / 1000) * 1000 = 158_000
    expect(defaultCompactionLimitForSpec('sonnet')).toBe(158_000);
    expect(defaultCompactionLimitForSpec(null)).toBe(158_000);
  });
});

describe('clampCompactionLimit (the default is also the CEILING)', () => {
  it('clamps an opus/fable request above 500k down to the 500k cap', () => {
    expect(clampCompactionLimit(900_000, 'opus')).toBe(500_000);
    expect(clampCompactionLimit(600_000, 'claude-fable-5:xhigh')).toBe(500_000);
  });
  it('honors a leaner opus/fable request below the cap', () => {
    expect(clampCompactionLimit(120_000, 'opus')).toBe(120_000);
  });
  it('floors any request at MIN_COMPACTION_LIMIT_TOKENS', () => {
    expect(clampCompactionLimit(1_000, 'opus')).toBe(MIN_COMPACTION_LIMIT_TOKENS);
  });
});
