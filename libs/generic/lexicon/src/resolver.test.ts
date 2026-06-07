import { describe, expect, it } from 'vitest';
import { getPack, lexiconFor, resolveTerm } from './resolver';
import { BRAND_PACKS, CLASSIC_PACK, THE_HIVE_PACK } from './packs';

describe('resolveTerm', () => {
  it('resolves singular by default', () => {
    expect(resolveTerm('classic', 'pot')).toBe('Pot');
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

  it('lowercases multi-word labels word-by-word', () => {
    expect(resolveTerm('the-hive', 'substrate', { lower: true })).toBe('hive mind');
    expect(resolveTerm('the-hive', 'brain', { lower: true })).toBe('royal jelly');
  });

  it('accepts an explicit BrandPack object', () => {
    expect(resolveTerm(THE_HIVE_PACK, 'fleet')).toBe('Swarm');
    expect(resolveTerm(CLASSIC_PACK, 'fleet')).toBe('Fleet');
  });

  it('applies the bee lexicon (D-002) across all renamed terms', () => {
    const t = lexiconFor('the-hive');
    expect(t('pot')).toBe('Hive');
    expect(t('fleet')).toBe('Swarm');
    expect(t('operator')).toBe('Queen');
    expect(t('brain')).toBe('Royal Jelly');
    expect(t('contributor')).toBe('Bee');
    expect(t('human')).toBe('Keeper');
    expect(t('chunk')).toBe('Cell');
    expect(t('cupboard')).toBe('Comb');
    expect(t('node')).toBe('Frame');
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
