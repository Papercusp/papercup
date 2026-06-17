import { describe, expect, it } from 'vitest';
import { getPack, lexiconFor, resolveTerm } from './resolver';
import { BRAND_PACKS, CLASSIC_PACK, THE_HIVE_PACK } from './packs';

describe('resolveTerm', () => {
  it('resolves singular by default', () => {
    expect(resolveTerm('classic', 'pot')).toBe('Hive');
    expect(resolveTerm('the-hive', 'pot')).toBe('Hive');
  });

  it('resolves plural with { plural: true }', () => {
    expect(resolveTerm('classic', 'harness', { plural: true })).toBe('Harnesses');
    expect(resolveTerm('the-hive', 'pot', { plural: true })).toBe('Hives');
  });

  it('uses count to pick singular vs plural', () => {
    expect(resolveTerm('the-hive', 'contributor', { count: 1 })).toBe('Bee');
    expect(resolveTerm('the-hive', 'contributor', { count: 0 })).toBe('Bees');
    expect(resolveTerm('the-hive', 'contributor', { count: 3 })).toBe('Bees');
    expect(resolveTerm('the-hive', 'contributor', { count: -1 })).toBe('Bee');
  });

  it('count overrides plural', () => {
    expect(resolveTerm('the-hive', 'pot', { count: 1, plural: true })).toBe('Hive');
  });

  it('treats a fractional 1.0 count as singular (|count| === 1)', () => {
    // 1.0 === 1 in JS, so this is the singular branch, not a surprise plural.
    expect(resolveTerm('the-hive', 'contributor', { count: 1.0 })).toBe('Bee');
    expect(resolveTerm('the-hive', 'contributor', { count: -1.0 })).toBe('Bee');
  });

  // --- Gap 13 (FIXED): a non-finite count falls through to the `plural` flag ---
  // NaN / ±Infinity is a caller bug, not a meaningful "everything else" plural.
  // After the fix it no longer forces plural; the `plural` flag decides, so an
  // explicit `plural: false` is honored instead of being silently overridden.
  it('falls through to the plural flag when count is NaN', () => {
    expect(resolveTerm('the-hive', 'contributor', { count: NaN })).toBe('Bee'); // plural defaults false → singular
    expect(resolveTerm('the-hive', 'contributor', { count: NaN, plural: true })).toBe('Bees');
    expect(resolveTerm('the-hive', 'contributor', { count: NaN, plural: false })).toBe('Bee');
  });

  it('falls through to the plural flag when count is ±Infinity', () => {
    expect(resolveTerm('the-hive', 'contributor', { count: Infinity })).toBe('Bee');
    expect(resolveTerm('the-hive', 'contributor', { count: Infinity, plural: true })).toBe('Bees');
    expect(resolveTerm('the-hive', 'contributor', { count: -Infinity, plural: true })).toBe('Bees');
  });

  it('lowercases multi-word labels word-by-word', () => {
    expect(resolveTerm('the-hive', 'substrate', { lower: true })).toBe('hive mind');
    // (operator is now single-word "Sentinel" — substrate covers the multi-word case;
    //  renamed from "Sentinel Bee", hive-agent-tabs P-003.)
  });

  // --- Gap 14 (PIN): form × case compose on the only multi-word term ---
  // applyCase is a whole-string toLowerCase(); for "Hive Mind" that happens to
  // equal the documented word-by-word result. Pin the composition so a future
  // change to either pickForm or applyCase can't silently drift.
  it('composes plural + lower on the multi-word substrate term', () => {
    expect(resolveTerm('the-hive', 'substrate', { plural: true, lower: true })).toBe('hive minds');
  });

  it('count-driven plural agrees with the plural flag under lower-casing', () => {
    expect(resolveTerm('the-hive', 'substrate', { count: 2, lower: true })).toBe('hive minds');
    // singular lower for completeness
    expect(resolveTerm('the-hive', 'substrate', { count: 1, lower: true })).toBe('hive mind');
  });

  it('accepts an explicit BrandPack object', () => {
    expect(resolveTerm(THE_HIVE_PACK, 'fleet')).toBe('Colony');
    expect(resolveTerm(CLASSIC_PACK, 'fleet')).toBe('Fleet');
  });

  it('applies the bee lexicon (D-002, revised by D-007) across all renamed terms', () => {
    const t = lexiconFor('the-hive');
    expect(t('pot')).toBe('Hive');
    // D-007: live agents are the Colony (was Swarm); Swarm is reassigned to
    // the deployment-to-instance unit (the `node` term).
    expect(t('fleet')).toBe('Colony');
    expect(t('operator')).toBe('Sentinel'); // renamed from "Sentinel Bee" (hive-agent-tabs P-003)
    expect(t('brain')).toBe('Queen');
    expect(t('contributor')).toBe('Bee');
    expect(t('human')).toBe('Keeper');
    expect(t('chunk')).toBe('Cell');
    expect(t('cupboard')).toBe('Comb');
    expect(t('node')).toBe('Swarm');
    expect(t('substrate')).toBe('Hive Mind');
    expect(t('signal')).toBe('Waggle');
  });

  it('keeps blueprint + harness unchanged across packs (D-002)', () => {
    for (const id of ['classic', 'the-hive'] as const) {
      expect(resolveTerm(id, 'blueprint')).toBe('Blueprint');
      expect(resolveTerm(id, 'harness')).toBe('Harness');
    }
  });
});

describe('getPack', () => {
  it('falls back to the default (classic) for an unknown id', () => {
    // @ts-expect-error — deliberately passing an invalid id
    expect(getPack('nope').id).toBe('classic');
    expect(getPack(undefined).id).toBe('classic');
  });

  it('returns the requested pack', () => {
    expect(getPack('the-hive')).toBe(BRAND_PACKS['the-hive']);
  });
});
