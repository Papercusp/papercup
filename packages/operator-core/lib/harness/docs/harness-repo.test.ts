/**
 * Tests for harness-repo — resolving a harness slug to its on-disk repo root +
 * docs root (the glue the merged doc read + the FS read share).
 * Run with: cd packages/operator-core && npx vitest run lib/harness/docs/harness-repo.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const reg = vi.hoisted(() => ({ projects: [] as Array<{ slug: string; path: string }> }));
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects: reg.projects }),
}));
vi.mock('../../endpoint-route/routes/harness/project-docs', () => ({
  resolveDocsRoot: async (repoRoot: string) => `${repoRoot}/docs`,
}));

import { resolveHarnessRepoRoot, resolveHarnessDocPaths } from './harness-repo';

afterEach(() => {
  reg.projects = [];
});

describe('resolveHarnessRepoRoot', () => {
  it('returns the registry path for a known slug', async () => {
    reg.projects = [{ slug: 'papercup', path: '/repos/papercup' }, { slug: 'other', path: '/repos/other' }];
    expect(await resolveHarnessRepoRoot('papercup')).toBe('/repos/papercup');
  });

  it('returns null for an unknown slug', async () => {
    reg.projects = [{ slug: 'papercup', path: '/repos/papercup' }];
    expect(await resolveHarnessRepoRoot('nope')).toBeNull();
  });
});

describe('resolveHarnessDocPaths', () => {
  it('returns both the repo root and the resolved docs root', async () => {
    reg.projects = [{ slug: 'papercup', path: '/repos/papercup' }];
    expect(await resolveHarnessDocPaths('papercup')).toEqual({
      repoRoot: '/repos/papercup',
      docsRoot: '/repos/papercup/docs',
    });
  });

  it('returns null when the slug has no registered repo', async () => {
    expect(await resolveHarnessDocPaths('nope')).toBeNull();
  });
});
