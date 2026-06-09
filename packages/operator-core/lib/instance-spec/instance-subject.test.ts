/**
 * Unit tests for the eval-battery InstanceSubject wiring (P-005): a spec → a
 * beekeeper InstanceManifest, and same-origin variants for a generation.
 */
import { describe, it, expect } from 'vitest';
import { hashGenome, type Genome } from './genome';
import type { InstanceSpec } from './types';
import { instanceManifestFromSpec, sameOriginVariants } from './instance-subject';

const spec = (genome: Genome = { prompts: {}, config: {} }, repoSha: string | null = 'sha-1'): InstanceSpec => ({
  specVersion: 1,
  blueprintRef: { id: 'demo', extends: 'coding' },
  repoSha,
  deploymentConfig: { target: 'local' },
  genome,
});

describe('instanceManifestFromSpec', () => {
  it('maps repoSha→codeSha and genome→genomeId', () => {
    const g: Genome = { prompts: {}, config: { wake: { minSleepSec: 90 } } };
    const m = instanceManifestFromSpec(spec(g), { workspaceId: 'ws' });
    expect(m.codeSha).toBe('sha-1');
    expect(m.genomeId).toBe(hashGenome(g));
    expect(m.workspaceId).toBe('ws');
  });

  it('omits genomeId for an empty genome (the baseline)', () => {
    const m = instanceManifestFromSpec(spec(), { workspaceId: 'ws' });
    expect(m.genomeId).toBeUndefined();
    expect(m.codeSha).toBe('sha-1');
  });

  it('repo-less spec → codeSha "unknown"', () => {
    const m = instanceManifestFromSpec(spec({ prompts: {}, config: {} }, null), { workspaceId: 'ws' });
    expect(m.codeSha).toBe('unknown');
  });
});

describe('sameOriginVariants', () => {
  it('a generation shares the code SHA + differs only by genomeId', () => {
    const base = spec();
    const variants = sameOriginVariants(
      base,
      [{ config: { wake: { minSleepSec: 90 } } }, { config: { memory: { seed: 'champion' } } }],
      { workspaceId: 'ws' },
    );
    // 1 champion control + 2 challengers
    expect(variants).toHaveLength(3);
    // all share the base code SHA (the fairness guarantee)
    expect(new Set(variants.map((v) => v.manifest.codeSha))).toEqual(new Set(['sha-1']));
    // the champion control has no genome variation; challengers each have a distinct genomeId
    expect(variants[0]!.manifest.genomeId).toBeUndefined();
    const challengerIds = variants.slice(1).map((v) => v.manifest.genomeId);
    expect(new Set(challengerIds).size).toBe(2);
    // every variant is same-origin with the base
    for (const v of variants) {
      expect(v.spec.blueprintRef).toEqual(base.blueprintRef);
      expect(v.spec.repoSha).toBe(base.repoSha);
      expect(v.spec.deploymentConfig).toEqual(base.deploymentConfig);
    }
  });
});
