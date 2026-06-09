/**
 * Unit tests for the canonical genome surface (the ONE config-variation definition).
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_GENOME,
  GENOME_CONFIG_AXES,
  GENOME_SURFACE_V1,
  canonicalGenomeJson,
  genomeIsEmpty,
  hashGenome,
  mergeGenome,
  normalizeGenome,
  type Genome,
} from './genome';

const g = (over: Partial<Genome> = {}): Genome => ({ prompts: {}, config: {}, ...over });

describe('genomeIsEmpty', () => {
  it('true for the empty genome', () => {
    expect(genomeIsEmpty(EMPTY_GENOME)).toBe(true);
    expect(genomeIsEmpty(g())).toBe(true);
    expect(genomeIsEmpty(g({ config: { wake: {} } }))).toBe(true); // empty axis = empty
  });
  it('false when a prompt overlay or config knob is present', () => {
    expect(genomeIsEmpty(g({ prompts: { 'queen.md': 'hi' } }))).toBe(false);
    expect(genomeIsEmpty(g({ config: { wake: { minSleepSec: 60 } } }))).toBe(false);
  });
});

describe('hashGenome', () => {
  it('is stable + order-independent (equal genomes → equal id)', () => {
    const a = g({ prompts: { 'a.md': '1', 'b.md': '2' }, config: { wake: { x: 1 }, placement: { q: 'd' } } });
    const b = g({ prompts: { 'b.md': '2', 'a.md': '1' }, config: { placement: { q: 'd' }, wake: { x: 1 } } });
    expect(hashGenome(a)).toBe(hashGenome(b));
    expect(hashGenome(a)).toMatch(/^gnm_[0-9a-f]{16}$/);
  });
  it('changes when any knob changes', () => {
    const base = g({ config: { wake: { minSleepSec: 60 } } });
    const changed = g({ config: { wake: { minSleepSec: 90 } } });
    expect(hashGenome(base)).not.toBe(hashGenome(changed));
  });
  it('the empty genome hashes to a stable id', () => {
    expect(hashGenome(EMPTY_GENOME)).toBe(hashGenome(g()));
  });
});

describe('normalizeGenome', () => {
  it('sorts prompt keys + drops empty axes', () => {
    const n = normalizeGenome(g({ prompts: { z: '1', a: '2' }, config: { wake: {}, placement: { q: 1 } } }));
    expect(Object.keys(n.prompts)).toEqual(['a', 'z']);
    expect(n.config).toEqual({ placement: { q: 1 } });
  });
  it('canonical JSON is identical for reordered genomes', () => {
    const a = g({ prompts: { a: '1', b: '2' } });
    const b = g({ prompts: { b: '2', a: '1' } });
    expect(canonicalGenomeJson(a)).toBe(canonicalGenomeJson(b));
  });
});

describe('mergeGenome', () => {
  it('adds + replaces prompt overlays; null removes', () => {
    const base = g({ prompts: { 'keep.md': 'k', 'replace.md': 'old' } });
    const merged = mergeGenome(base, { prompts: { 'replace.md': 'new', 'add.md': 'a', 'keep.md': null } });
    expect(merged.prompts).toEqual({ 'replace.md': 'new', 'add.md': 'a' });
  });
  it('shallow-merges each config axis', () => {
    const base = g({ config: { wake: { minSleepSec: 60, other: 1 } } });
    const merged = mergeGenome(base, { config: { wake: { minSleepSec: 90 }, placement: { q: 'd' } } });
    expect(merged.config.wake).toEqual({ minSleepSec: 90, other: 1 });
    expect(merged.config.placement).toEqual({ q: 'd' });
  });
  it('does not mutate the base', () => {
    const base = g({ config: { wake: { minSleepSec: 60 } } });
    mergeGenome(base, { config: { wake: { minSleepSec: 90 } } });
    expect(base.config.wake).toEqual({ minSleepSec: 60 });
  });
  it('an empty delta is a no-op (same hash)', () => {
    const base = g({ prompts: { 'a.md': '1' }, config: { wake: { x: 1 } } });
    expect(hashGenome(mergeGenome(base, {}))).toBe(hashGenome(base));
  });
});

describe('GENOME_SURFACE_V1', () => {
  it('declares the five-axis surface + the excluded safety surface', () => {
    expect(GENOME_SURFACE_V1.configAxes).toEqual(GENOME_CONFIG_AXES);
    expect(GENOME_SURFACE_V1.excluded.join(' ')).toMatch(/safety|never-auto/i);
  });
});
