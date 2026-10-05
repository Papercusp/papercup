import { describe, expect, it, vi } from 'vitest';
import { digestAppliedMigrationRows } from './migration-drift';
import {
  composeServingGeneration,
  describeServingGeneration,
  readServingGeneration,
  type ServingGenerationInputs,
} from './serving-generation';

const appliedMigrations = {
  state: 'known' as const,
  rows: [{ filename: '001-core.sql', sha256: 'sha-core' }],
  digest: digestAppliedMigrationRows([{ filename: '001-core.sql', sha256: 'sha-core' }]),
};

function inputs(overrides: Partial<ServingGenerationInputs> = {}): ServingGenerationInputs {
  return {
    buildSha: 'loaded-build-sha',
    appliedMigrations,
    toolRegistryRevision: 'projected-tool-registry-v1:tools-sha',
    ...overrides,
  };
}

describe('serving generation', () => {
  it('composes loaded build, applied migration frontier, and projected tool contract', () => {
    const base = composeServingGeneration(inputs());
    expect(base).toMatchObject({
      state: 'known',
      buildSha: 'loaded-build-sha',
      appliedMigrationDigest: appliedMigrations.digest,
      toolRegistryRevision: 'projected-tool-registry-v1:tools-sha',
    });
    expect(base.state === 'known' && base.revision).toMatch(/^serving-generation-v1:[a-f0-9]{64}$/);

    for (const changed of [
      inputs({ buildSha: 'another-build-sha' }),
      inputs({ appliedMigrations: { ...appliedMigrations, digest: 'another-migration-digest' } }),
      inputs({ toolRegistryRevision: 'projected-tool-registry-v1:another-tools-sha' }),
    ]) {
      const result = composeServingGeneration(changed);
      expect(result.state).toBe('known');
      if (result.state === 'known' && base.state === 'known') expect(result.revision).not.toBe(base.revision);
    }
  });

  it('keeps every unprovable component explicitly unknown', () => {
    expect(composeServingGeneration(inputs({ buildSha: null }))).toEqual({
      state: 'unknown',
      reason: 'build-sha-unknown',
    });
    expect(composeServingGeneration(inputs({
      appliedMigrations: { state: 'unknown', reason: 'query-failed' },
    }))).toEqual({
      state: 'unknown',
      reason: 'applied-migrations-unknown',
      migrationReason: 'query-failed',
    });
    expect(composeServingGeneration(inputs({ toolRegistryRevision: 'unknown' }))).toEqual({
      state: 'unknown',
      reason: 'tool-registry-revision-unknown',
    });
  });

  it('reads injected inputs and renders an honest prompt marker', async () => {
    const readAppliedMigrations = vi.fn(async () => appliedMigrations);
    const generation = await readServingGeneration({
      buildSha: 'test-build',
      toolRegistryRevision: 'tools-v2',
      readAppliedMigrations,
    });
    expect(readAppliedMigrations).toHaveBeenCalledOnce();
    expect(generation.state).toBe('known');
    expect(describeServingGeneration(generation)).toMatch(/^serving-generation-v1:/);

    const unknown = await readServingGeneration({
      buildSha: 'test-build',
      toolRegistryRevision: 'tools-v2',
      readAppliedMigrations: async () => { throw new Error('db unavailable'); },
    });
    expect(describeServingGeneration(unknown)).toBe('unknown (applied-migrations-unknown)');
  });
});
