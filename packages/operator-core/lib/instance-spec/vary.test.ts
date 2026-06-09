/**
 * Unit tests for `vary` — the fair same-origin clone primitive (P-004).
 */
import { describe, it, expect } from 'vitest';
import { canonicalGenomeJson, hashGenome, type Genome } from './genome';
import { hashInstanceSpec, specGenomeId, specOrigin, type InstanceSpec } from './types';
import { sameOrigin, specsIdentical, varyInstanceSpec } from './vary';

const baseSpec = (genome: Genome = { prompts: {}, config: {} }): InstanceSpec => ({
  specVersion: 1,
  blueprintRef: { id: 'demo', extends: 'coding', version: '1.0.0', blueprint: { id: 'demo', extends: 'coding' } },
  repoSha: 'abc123def456',
  deploymentConfig: { target: 'local' },
  genome,
});

describe('varyInstanceSpec', () => {
  it('produces a SAME-ORIGIN clone (identical blueprint + SHA + deployment)', () => {
    const base = baseSpec();
    const varied = varyInstanceSpec(base, { config: { wake: { minSleepSec: 90 } } });
    expect(sameOrigin(base, varied)).toBe(true);
    expect(specOrigin(varied)).toEqual(specOrigin(base));
  });

  it('differs ONLY by the genome delta', () => {
    const base = baseSpec();
    const varied = varyInstanceSpec(base, { config: { wake: { minSleepSec: 90 } } });
    // origins equal, genomes differ
    expect(canonicalGenomeJson(varied.genome)).not.toBe(canonicalGenomeJson(base.genome));
    expect(varied.genome.config.wake).toEqual({ minSleepSec: 90 });
    // every non-genome field is byte-equal
    expect({ ...varied, genome: null }).toEqual({ ...base, genome: null });
  });

  it('an empty delta yields an identical spec', () => {
    const base = baseSpec({ prompts: { 'q.md': 'x' }, config: { wake: { x: 1 } } });
    expect(specsIdentical(base, varyInstanceSpec(base, {}))).toBe(true);
  });

  it('changes the spec + genome content-address', () => {
    const base = baseSpec();
    const varied = varyInstanceSpec(base, { config: { memory: { seed: 'champion' } } });
    expect(hashInstanceSpec(varied)).not.toBe(hashInstanceSpec(base));
    expect(specGenomeId(varied)).not.toBe(specGenomeId(base));
    expect(specGenomeId(varied)).toBe(hashGenome(varied.genome));
  });

  it('does not mutate the base spec', () => {
    const base = baseSpec();
    varyInstanceSpec(base, { config: { wake: { minSleepSec: 90 } } });
    expect(base.genome.config).toEqual({});
  });
});

describe('sameOrigin', () => {
  it('false when the repo SHA differs', () => {
    expect(sameOrigin(baseSpec(), { ...baseSpec(), repoSha: 'different' })).toBe(false);
  });
  it('false when the deployment differs', () => {
    expect(sameOrigin(baseSpec(), { ...baseSpec(), deploymentConfig: { target: 'latitude' } })).toBe(false);
  });
  it('true regardless of genome', () => {
    const a = baseSpec({ prompts: { 'a.md': '1' }, config: {} });
    const b = baseSpec({ config: { wake: { x: 9 } }, prompts: {} });
    expect(sameOrigin(a, b)).toBe(true);
  });
});
