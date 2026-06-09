/**
 * Unit tests for genome storage — prompt overlays on disk + config knobs in the
 * ProjectEntry's configOverrides, round-tripped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashGenome, type Genome } from './genome';
import {
  GENOME_CONFIG_KEY,
  applyGenomeConfig,
  readGenome,
  readGenomeConfig,
  readGenomePrompts,
  writeGenomePrompts,
} from './genome-storage';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genome-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('prompt overlays round-trip on disk', () => {
  it('writeGenomePrompts → readGenomePrompts is identity', () => {
    const prompts = { 'queen.placement.md': 'place the queen', 'persona/extra.md': 'overlay' };
    writeGenomePrompts(dir, prompts);
    expect(readGenomePrompts(dir)).toEqual(prompts);
  });

  it('writing replaces any prior overlays', () => {
    writeGenomePrompts(dir, { 'old.md': 'gone' });
    writeGenomePrompts(dir, { 'new.md': 'here' });
    expect(readGenomePrompts(dir)).toEqual({ 'new.md': 'here' });
  });

  it('empty prompts clears the dir', () => {
    writeGenomePrompts(dir, { 'a.md': '1' });
    writeGenomePrompts(dir, {});
    expect(readGenomePrompts(dir)).toEqual({});
  });

  it('rejects a path-escaping overlay key', () => {
    expect(() => writeGenomePrompts(dir, { '../escape.md': 'x' })).toThrow(/escapes/);
  });
});

describe('config knobs in configOverrides', () => {
  it('readGenomeConfig pulls only the genome key + non-empty axes', () => {
    const overrides = { maxCostUsd: 5, [GENOME_CONFIG_KEY]: { wake: { minSleepSec: 60 }, placement: {} } };
    expect(readGenomeConfig(overrides)).toEqual({ wake: { minSleepSec: 60 } });
  });

  it('applyGenomeConfig folds config under the genome key, preserving other overrides', () => {
    const next = applyGenomeConfig({ maxCostUsd: 5 }, { wake: { minSleepSec: 60 } });
    expect(next).toEqual({ maxCostUsd: 5, [GENOME_CONFIG_KEY]: { wake: { minSleepSec: 60 } } });
  });

  it('applyGenomeConfig clears the genome key when config is empty', () => {
    const next = applyGenomeConfig({ [GENOME_CONFIG_KEY]: { wake: { x: 1 } }, maxCostUsd: 5 }, {});
    expect(next).toEqual({ maxCostUsd: 5 });
  });
});

describe('readGenome (disk + overrides)', () => {
  it('assembles the full genome content-identically to its source', () => {
    const genome: Genome = {
      prompts: { 'queen.md': 'hi' },
      config: { wake: { minSleepSec: 60 } },
    };
    writeGenomePrompts(dir, genome.prompts);
    const overrides = applyGenomeConfig(undefined, genome.config);
    const read = readGenome(dir, overrides);
    expect(hashGenome(read)).toBe(hashGenome(genome));
  });

  it('a vanilla harness reads the empty genome', () => {
    expect(readGenome(dir, undefined)).toEqual({ prompts: {}, config: {} });
  });
});
