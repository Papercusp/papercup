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
  validateCloudModelSpec,
  KNOWN_CLOUD_ALIASES,
} from './agent-config-constants';

// opus + fable + sonnet-5 are LAUNCHED at the full 1M window — psu-launcher
// normalizeModelSpec injects the [1m] marker for all three families — and
// papercusp compacts [1m] sessions preemptively at 500k (owner directive
// 2026-07-02). Window/limit MATH keys on the [1m] MARKER only, never the bare
// family name: live-verified via /context on CC 2.1.198 (2026-07-02), a bare
// `sonnet` session runs a 200k AUTO-COMPACT window (auto-fires ~167k — killed
// a wave of sonnet fleet members), while `sonnet[1m]` runs 967k. This file
// pins BOTH halves: the family predicate (isDefault1mModelSpec — who gets
// normalized) and the marker-keyed math (modelWindowForSpec /
// defaultCompactionLimitForSpec / clampCompactionLimit).

describe('isDefault1mModelSpec (the FAMILY predicate the [1m] launch normalizer keys on)', () => {
  it('is true for opus and fable specs (with or without effort / id prefix)', () => {
    for (const spec of ['opus', 'opus:high', 'claude-opus-4-8', 'fable', 'claude-fable-5:xhigh']) {
      expect(isDefault1mModelSpec(spec)).toBe(true);
    }
  });
  it('is true for sonnet-5 — it NEEDS the [1m] marker injected (bare = 200k auto-compact window)', () => {
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

describe('modelWindowForSpec (keys on the [1m] MARKER only)', () => {
  it('an explicit [1m] marker means 1M for any family', () => {
    expect(modelWindowForSpec('haiku[1m]')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('opus[1m]:xhigh')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('sonnet[1m]:medium')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('claude-fable-5[1m]:xhigh')).toBe(MODEL_WINDOW_1M);
  });
  it('a BARE default-1M-family spec is the conservative 200k — an un-normalized launch really runs a 200k auto-compact window (live-verified 2026-07-02)', () => {
    expect(modelWindowForSpec('opus')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('claude-fable-5:xhigh')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('claude-sonnet-5:high')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('sonnet:medium')).toBe(MODEL_WINDOW_DEFAULT);
  });
  it('everything else (incl. null/haiku/sonnet ≤4.x) is the conservative 200k', () => {
    expect(modelWindowForSpec('haiku')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('claude-sonnet-4-6:high')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec(null)).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec(undefined)).toBe(MODEL_WINDOW_DEFAULT);
  });
});

describe('defaultCompactionLimitForSpec (keys on the [1m] MARKER only)', () => {
  it('[1m] specs are capped at 500k (preemptive compaction despite the 1M window)', () => {
    expect(COMPACTION_LIMIT_DEFAULT_1M_CAP).toBe(500_000);
    expect(defaultCompactionLimitForSpec('opus[1m]')).toBe(500_000);
    expect(defaultCompactionLimitForSpec('opus[1m]:xhigh')).toBe(500_000);
    expect(defaultCompactionLimitForSpec('claude-fable-5[1m]:xhigh')).toBe(500_000);
    expect(defaultCompactionLimitForSpec('sonnet[1m]:medium')).toBe(500_000);
    expect(defaultCompactionLimitForSpec('haiku[1m]')).toBe(500_000);
  });
  it('a BARE default-1M-family spec derives 158k — BELOW CC\'s own ~167k auto trigger on the real 200k window, so papercusp compacts cleanly first', () => {
    expect(defaultCompactionLimitForSpec('opus')).toBe(158_000);
    expect(defaultCompactionLimitForSpec('claude-sonnet-5:high')).toBe(158_000);
    expect(defaultCompactionLimitForSpec('sonnet:medium')).toBe(158_000);
  });
  it('a 200k-window spec derives 158k', () => {
    // floor((200_000 - 10_000) / 1.2 / 1000) * 1000 = 158_000
    expect(defaultCompactionLimitForSpec('haiku')).toBe(158_000);
    expect(defaultCompactionLimitForSpec('claude-sonnet-4-6')).toBe(158_000);
    expect(defaultCompactionLimitForSpec(null)).toBe(158_000);
  });
});

describe('clampCompactionLimit (the default is also the CEILING)', () => {
  it('clamps a [1m] request above 500k down to the 500k cap', () => {
    expect(clampCompactionLimit(900_000, 'opus[1m]')).toBe(500_000);
    expect(clampCompactionLimit(600_000, 'claude-fable-5[1m]:xhigh')).toBe(500_000);
  });
  it('honors a leaner [1m] request below the cap', () => {
    expect(clampCompactionLimit(120_000, 'opus[1m]')).toBe(120_000);
  });
  it('clamps a bare-family request to the 158k derived ceiling (the real 200k window)', () => {
    expect(clampCompactionLimit(500_000, 'sonnet:medium')).toBe(158_000);
  });
  it('floors any request at MIN_COMPACTION_LIMIT_TOKENS', () => {
    expect(clampCompactionLimit(1_000, 'opus[1m]')).toBe(MIN_COMPACTION_LIMIT_TOKENS);
  });
});

// The TS twin of psu-launcher `validateModelSpec` (WI-1979 / WI-1993). Same vector
// table the launcher's own suite pins — a divergence here (or there) is caught by
// the parity test in apps/operator/lib/psu-launcher.test.ts, which asserts the two
// functions agree value-for-value. This suite pins the CONTRACT (what passes / what
// the corrective message says) independently of that cross-package guard.
describe('validateCloudModelSpec (tool-boundary cloud model-spec guard — WI-1993)', () => {
  it('KNOWN_CLOUD_ALIASES is the canonical short-alias set', () => {
    expect([...KNOWN_CLOUD_ALIASES]).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });
  it('accepts valid aliases, effort specs, full/provider ids, [1m] round-trips, local ids, and empty', () => {
    for (const s of [
      'fable:xhigh', 'opus:max', 'sonnet', 'sonnet:high', 'haiku',
      'opus[1m]:max', 'sonnet[1m]', 'claude-fable-5:xhigh', 'claude-fable-5[1m]',
      'claude-sonnet-5:high', 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'ollama-cc/maxwell1500/ornith-35b:IQ3_M', 'gpt-5-codex', '',
    ]) {
      expect(validateCloudModelSpec(s).ok, s).toBe(true);
    }
    expect(validateCloudModelSpec(null).ok).toBe(true);
    expect(validateCloudModelSpec(undefined).ok).toBe(true);
  });
  it('accepts an unknown-but-plausible short id that is NOT a close typo (o3 / gpt4 / grok)', () => {
    for (const s of ['o3', 'gpt4', 'grok']) expect(validateCloudModelSpec(s).ok, s).toBe(true);
  });
  it('rejects a hand-typed [1m] marker on a non-family base (the fabel5[1m] incident), with the marker tip + suggestion', () => {
    const r = validateCloudModelSpec('fabel5[1m]');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('do not type it');
    expect(r.message).toContain('fable');
  });
  it('rejects a close-typo alias — incl. transpositions — with a "did you mean" suggestion', () => {
    for (const [bad, want] of [
      ['fabel', 'fable'], ['sonet', 'sonnet'], ['sonnet5', 'sonnet'],
      ['opus4', 'opus'], ['opuss', 'opus'], ['fabel5:xhigh', 'fable'],
    ] as const) {
      const r = validateCloudModelSpec(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.message, bad).toContain(want);
    }
  });
});
