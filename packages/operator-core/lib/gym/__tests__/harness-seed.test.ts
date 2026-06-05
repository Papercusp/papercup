import { describe, it, expect } from 'vitest';
import { seedThrowawayHarness, type SeedHarnessDeps, type SeedHarnessInput } from '../../harness-seed';

/**
 * Shared hermetic-seed primitive (coordinated with the harness-test-coverage owner,
 * su-8adcf0a9): register a throwaway harness pointing at a (clone) path, pre-seed
 * workspace files, apply prompt overrides, file the feature. The SPAWN + CAPTURE +
 * TEARDOWN stay caller-specific (gym = full DBOS pipeline + git-diff; their target =
 * single-role invoke-once + filesWritten). Effects injected; filing path is injectable
 * (HTTP for the external gym controller vs in-proc for a co-located caller).
 */
const input: SeedHarnessInput = {
  slug: 'gym-abc',
  repoOrClonePath: '/scratch/gym/clones/gym-abc',
  workspaceId: 'gym-ws',
  feature: { id: 'F-GYM-AA', title: 'Add /health', spec: 'add a liveness probe', acceptance: ['VAL-1'], status: 'todo' },
};

function makeDeps(over: Partial<SeedHarnessDeps> = {}): { d: SeedHarnessDeps; calls: string[] } {
  const calls: string[] = [];
  const d: SeedHarnessDeps = {
    async registerHarness(i) { calls.push(`register:${i.slug}@${i.path}`); },
    async fileFeature(i) { calls.push(`feature:${i.feature.id}`); },
    async writeFile(i) { calls.push(`file:${i.relPath}`); },
    async setOverride(i) { calls.push(`override:${i.role}`); },
    ...over,
  };
  return { d, calls };
}

describe('seedThrowawayHarness', () => {
  it('registers the harness first, then files + overrides, then files the feature', async () => {
    const { d, calls } = makeDeps();
    const res = await seedThrowawayHarness(
      {
        ...input,
        files: [{ path: 'src/health.ts', content: 'x' }],
        promptOverrides: { worker: '# worker v2' },
      },
      d,
    );
    expect(res.harnessSlug).toBe('gym-abc');
    expect(calls[0]).toBe('register:gym-abc@/scratch/gym/clones/gym-abc');
    expect(calls).toContain('file:src/health.ts');
    expect(calls).toContain('override:worker');
    // feature filed last (after register + files + overrides)
    expect(calls[calls.length - 1]).toBe('feature:F-GYM-AA');
  });

  it('baseline (no files/overrides) just registers + files the feature', async () => {
    const { d, calls } = makeDeps();
    await seedThrowawayHarness(input, d);
    expect(calls).toEqual(['register:gym-abc@/scratch/gym/clones/gym-abc', 'feature:F-GYM-AA']);
  });

  it('writes pre-seed files under the clone base path', async () => {
    let seen: { basePath?: string; relPath?: string } = {};
    const { d } = makeDeps({ async writeFile(i) { seen = { basePath: i.basePath, relPath: i.relPath }; } });
    await seedThrowawayHarness({ ...input, files: [{ path: 'a/b.ts', content: 'c' }] }, d);
    expect(seen.basePath).toBe('/scratch/gym/clones/gym-abc');
    expect(seen.relPath).toBe('a/b.ts');
  });

  it('rejects an unknown override role (protects the frozen judge)', async () => {
    const { d } = makeDeps();
    await expect(
      seedThrowawayHarness({ ...input, promptOverrides: { judge: 'nope' } }, d),
    ).rejects.toThrow(/judge|unknown/i);
  });
});
