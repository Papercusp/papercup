/**
 * source-scope.test.ts — unit coverage for source.ts:resolvePlanScope, the
 * (PlanSourceOpts) → concrete (workspaceId, harnessSlug) PG-key resolver every
 * plans read/write funnels through.
 *
 * The pure decision cores (parser / lint / effective-status / evaluateSetContent)
 * are well-tested; resolvePlanScope's BRANCHING — the papercup-primary
 * short-circuit, the explicit-workspaceId bypass, and the unknown-harness →
 * DEFAULT_WORKSPACE_ID fallback (the resolveProject→null catch) — was not.
 *
 * `resolveProject` (the registry lookup) is mocked so the branches are exercised
 * without a harness registry on disk. No PG, no filesystem.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
  // Controls what the mocked registry lookup returns for a concrete slug.
  resolveProject: vi.fn(),
}));

vi.mock('../../../harness-core', async (orig) => {
  const actual = await orig<typeof import('../../../harness-core')>();
  return { ...actual, resolveProject: H.resolveProject };
});

import { resolvePlanScope } from '../source';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { PAPERCUP_HARNESS_SLUG } from '../../../harness/register-papercup';

beforeEach(() => {
  H.resolveProject.mockReset();
});

describe('resolvePlanScope — papercup-primary short-circuit', () => {
  it('no harness → papercup primary in the default workspace', async () => {
    const r = await resolvePlanScope({});
    expect(r).toEqual({ workspaceId: DEFAULT_WORKSPACE_ID, harnessSlug: PAPERCUP_HARNESS_SLUG });
    // The short-circuit never consults the registry.
    expect(H.resolveProject).not.toHaveBeenCalled();
  });

  it.each(['*', 'all', PAPERCUP_HARNESS_SLUG])(
    'the %s sentinel → papercup primary (no registry lookup)',
    async (slug) => {
      const r = await resolvePlanScope({ harnessSlug: slug });
      expect(r).toEqual({ workspaceId: DEFAULT_WORKSPACE_ID, harnessSlug: PAPERCUP_HARNESS_SLUG });
      expect(H.resolveProject).not.toHaveBeenCalled();
    },
  );

  it('a blank/whitespace harness is treated as "no harness"', async () => {
    const r = await resolvePlanScope({ harnessSlug: '   ' });
    expect(r).toEqual({ workspaceId: DEFAULT_WORKSPACE_ID, harnessSlug: PAPERCUP_HARNESS_SLUG });
  });

  it('an explicit workspaceId rides through the papercup short-circuit', async () => {
    const r = await resolvePlanScope({ harnessSlug: 'all', workspaceId: 'ws-xyz' });
    // For the all/papercup branch the supplied workspaceId is honored verbatim.
    expect(r).toEqual({ workspaceId: 'ws-xyz', harnessSlug: PAPERCUP_HARNESS_SLUG });
    expect(H.resolveProject).not.toHaveBeenCalled();
  });
});

describe('resolvePlanScope — explicit workspaceId short-circuit (concrete slug)', () => {
  it('a concrete slug + explicit workspaceId never hits the registry', async () => {
    const r = await resolvePlanScope({ harnessSlug: 'my-harness', workspaceId: 'ws-7' });
    expect(r).toEqual({ workspaceId: 'ws-7', harnessSlug: 'my-harness' });
    // The explicit workspace pins the scope — no resolveProject lookup.
    expect(H.resolveProject).not.toHaveBeenCalled();
  });
});

describe('resolvePlanScope — concrete slug, workspace from the registry', () => {
  it('resolves the slug to the registry-reported workspace', async () => {
    H.resolveProject.mockResolvedValue({ slug: 'my-harness', path: '/x', workspaceId: 'ws-from-registry' });
    const r = await resolvePlanScope({ harnessSlug: 'my-harness' });
    expect(r).toEqual({ workspaceId: 'ws-from-registry', harnessSlug: 'my-harness' });
    expect(H.resolveProject).toHaveBeenCalledWith('my-harness');
  });

  it('a registry hit WITHOUT a workspaceId falls back to DEFAULT', async () => {
    // The cross-workspace fallback can return a project with no workspaceId field.
    H.resolveProject.mockResolvedValue({ slug: 'my-harness', path: '/x' });
    const r = await resolvePlanScope({ harnessSlug: 'my-harness' });
    expect(r).toEqual({ workspaceId: DEFAULT_WORKSPACE_ID, harnessSlug: 'my-harness' });
  });
});

describe('resolvePlanScope — unknown harness → DEFAULT_WORKSPACE_ID fallback', () => {
  it('an unregistered slug (resolveProject → null) defaults the workspace', async () => {
    H.resolveProject.mockResolvedValue(null);
    const r = await resolvePlanScope({ harnessSlug: 'zzz-never-registered' });
    // Workspace defaults; the harness slug is preserved so the SELECT just
    // returns no rows (the documented behavior).
    expect(r).toEqual({ workspaceId: DEFAULT_WORKSPACE_ID, harnessSlug: 'zzz-never-registered' });
  });

  it('a registry THROW is swallowed → DEFAULT workspace (the catch branch)', async () => {
    H.resolveProject.mockRejectedValue(new Error('registry unreadable'));
    const r = await resolvePlanScope({ harnessSlug: 'broken-harness' });
    expect(r).toEqual({ workspaceId: DEFAULT_WORKSPACE_ID, harnessSlug: 'broken-harness' });
  });
});
