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

// opus + fable + sonnet-5 default to the FULL 1M window but papercusp compacts
// them preemptively at 500k (owner directive 2026-07-02). This file pins BOTH
// halves: the window (isDefault1mModelSpec / modelWindowForSpec) and the
// compaction cap (defaultCompactionLimitForSpec / clampCompactionLimit). Twin of
// psu-launcher normalizeModelSpec, which injects the [1m] launch marker for
// opus/fable (sonnet-5 needs no marker — its 1M window is Anthropic's default).

describe('isDefault1mModelSpec (opus/fable/sonnet-5 are the default-1M families)', () => {
  it('is true for opus and fable specs (with or without effort / id prefix)', () => {
    for (const spec of ['opus', 'opus:high', 'claude-opus-4-8', 'fable', 'claude-fable-5:xhigh']) {
      expect(isDefault1mModelSpec(spec)).toBe(true);
    }
  });
  it('is true for sonnet-5 (1M is its DEFAULT window per Anthropic — P-031 correction 2026-07-02)', () => {
    for (const spec of ['claude-sonnet-5', 'claude-sonnet-5:high', 'sonnet-5', 'sonnet5:medium']) {
      expect(isDefault1mModelSpec(spec)).toBe(true);
    }
  });
  it('is true for the bare `sonnet` alias — CC resolves it to the latest sonnet, i.e. sonnet-5', () => {
    for (const spec of ['sonnet', 'sonnet:medium', 'sonnet[1m]', 'sonnet[1m]:high']) {
      expect(isDefault1mModelSpec(spec)).toBe(true);
    }
  });
  it('is false for versioned sonnet ≤4.x, other families, and nullish specs', () => {
    for (const spec of ['claude-sonnet-4-5', 'claude-sonnet-4-6:high', 'anthropic.claude-3-5-sonnet-20241022-v2:0', 'haiku', 'gpt-5.5', 'ornith']) {
      expect(isDefault1mModelSpec(spec)).toBe(false);
    }
    expect(isDefault1mModelSpec(null)).toBe(false);
    expect(isDefault1mModelSpec(undefined)).toBe(false);
  });
});

describe('modelWindowForSpec', () => {
  it('opus/fable/sonnet-5 (incl. the bare alias) get the 1M window even without the [1m] marker', () => {
    expect(modelWindowForSpec('opus')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('claude-fable-5:xhigh')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('claude-sonnet-5:high')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('sonnet:medium')).toBe(MODEL_WINDOW_1M);
  });
  it('an explicit [1m] marker forces 1M for any family', () => {
    expect(modelWindowForSpec('haiku[1m]')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('opus[1m]:xhigh')).toBe(MODEL_WINDOW_1M);
  });
  it('everything else (incl. null/haiku/sonnet ≤4.x) is the conservative 200k', () => {
    expect(modelWindowForSpec('haiku')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('claude-sonnet-4-6:high')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec(null)).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec(undefined)).toBe(MODEL_WINDOW_DEFAULT);
  });
});

describe('defaultCompactionLimitForSpec', () => {
  it('opus/fable/sonnet-5 are capped at 500k (preemptive compaction despite the 1M window)', () => {
    expect(COMPACTION_LIMIT_DEFAULT_1M_CAP).toBe(500_000);
    expect(defaultCompactionLimitForSpec('opus')).toBe(500_000);
    expect(defaultCompactionLimitForSpec('opus:xhigh')).toBe(500_000);
    expect(defaultCompactionLimitForSpec('claude-fable-5:xhigh')).toBe(500_000);
    expect(defaultCompactionLimitForSpec('claude-sonnet-5:high')).toBe(500_000);
  });
  it('a [1m] spec OUTSIDE the default-1M families keeps the window-derived 825k default', () => {
    // floor((1_000_000 - 10_000) / 1.2 / 1000) * 1000 = 825_000
    expect(defaultCompactionLimitForSpec('haiku[1m]')).toBe(825_000);
  });
  it('a 200k-window spec derives 158k', () => {
    // floor((200_000 - 10_000) / 1.2 / 1000) * 1000 = 158_000
    expect(defaultCompactionLimitForSpec('haiku')).toBe(158_000);
    expect(defaultCompactionLimitForSpec('claude-sonnet-4-6')).toBe(158_000);
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
