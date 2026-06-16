/**
 * source-scope.test.ts — unit coverage for source.ts:resolvePlanScope and
 * fill_workspace_id_from_projects, the (PlanSourceOpts) → concrete
 * (workspaceId, harnessSlug) PG-key resolver every plans read/write funnels
 * through (WI-148 / P-013 workspace-identity reconciliation, SAFE forward half).
 *
 * The slug→workspace lookup against harness_shared.projects is injected via the
 * `lookup` seam so every branch is exercised with no PG, no filesystem:
 *   - the papercup-primary short-circuit (empty / '*' / 'all' / papercup),
 *   - the explicit-workspaceId bypass,
 *   - the projects-table resolution for a concrete slug,
 *   - the fail-loud paths: unknown slug → THROW (no silent default), and a
 *     same-name collision across workspaces → THROW.
 *
 * The most load-bearing assertion: papercup / wildcard / empty resolve to
 * PAPERCUSP_WORKSPACE_ID (WI-148 part-B flip, owner GO 2026-06-16, in LOCKSTEP
 * with migration 295's 'default'→'papercusp-workspace' data move — either alone
 * 404s every papercup plan).
 */
import { describe, expect, it } from 'vitest';

import {
  resolvePlanScope,
  fill_workspace_id_from_projects,
  type ProjectsWorkspaceLookup,
} from '../source';
import { PAPERCUP_HARNESS_SLUG } from '../../../harness/register-papercup';
import { PAPERCUSP_WORKSPACE_ID } from '../../../harness/papercusp-workspace';

/** A lookup seam that returns a fixed match list and records the slug it saw. */
function lookupReturning(...workspaceIds: string[]): {
  lookup: ProjectsWorkspaceLookup;
  calls: string[];
} {
  const calls: string[] = [];
  const lookup: ProjectsWorkspaceLookup = async (slug) => {
    calls.push(slug);
    return workspaceIds;
  };
  return { lookup, calls };
}

describe('resolvePlanScope — papercup-primary short-circuit (WI-148 part-B)', () => {
  it('no harness → papercup primary in PAPERCUSP_WORKSPACE_ID', async () => {
    const { lookup, calls } = lookupReturning('ws-should-not-be-used');
    const r = await resolvePlanScope({ lookup });
    expect(r).toEqual({ workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: PAPERCUP_HARNESS_SLUG });
    // The short-circuit never consults the projects table.
    expect(calls).toEqual([]);
  });

  it.each(['*', 'all', PAPERCUP_HARNESS_SLUG])(
    'the %s sentinel → papercup primary in PAPERCUSP_WORKSPACE_ID (no projects lookup)',
    async (slug) => {
      const { lookup, calls } = lookupReturning('ws-should-not-be-used');
      const r = await resolvePlanScope({ harnessSlug: slug, lookup });
      expect(r).toEqual({ workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: PAPERCUP_HARNESS_SLUG });
      expect(calls).toEqual([]);
    },
  );

  it('a blank/whitespace harness is treated as "no harness"', async () => {
    const r = await resolvePlanScope({ harnessSlug: '   ' });
    expect(r).toEqual({ workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: PAPERCUP_HARNESS_SLUG });
  });

  it('an explicit workspaceId rides through the papercup short-circuit', async () => {
    const r = await resolvePlanScope({ harnessSlug: 'all', workspaceId: 'ws-xyz' });
    // For the all/papercup branch the supplied workspaceId is honored verbatim.
    expect(r).toEqual({ workspaceId: 'ws-xyz', harnessSlug: PAPERCUP_HARNESS_SLUG });
  });
});

describe('resolvePlanScope — explicit workspaceId short-circuit (concrete slug)', () => {
  it('a concrete slug + explicit workspaceId never hits the projects table', async () => {
    const { lookup, calls } = lookupReturning('ws-from-projects');
    const r = await resolvePlanScope({ harnessSlug: 'my-harness', workspaceId: 'ws-7', lookup });
    expect(r).toEqual({ workspaceId: 'ws-7', harnessSlug: 'my-harness' });
    // The explicit workspace pins the scope — no projects lookup.
    expect(calls).toEqual([]);
  });
});

describe('resolvePlanScope — concrete slug, workspace from the projects table', () => {
  it('resolves the slug to its single projects-table workspace', async () => {
    const { lookup, calls } = lookupReturning('ws-from-projects');
    const r = await resolvePlanScope({ harnessSlug: 'my-harness', lookup });
    expect(r).toEqual({ workspaceId: 'ws-from-projects', harnessSlug: 'my-harness' });
    expect(calls).toEqual(['my-harness']);
  });
});

describe('resolvePlanScope — fail-loud (NO silent default)', () => {
  it('an unregistered slug (0 matches) THROWS — never silently defaults', async () => {
    const { lookup } = lookupReturning(); // no matches
    await expect(resolvePlanScope({ harnessSlug: 'zzz-never-registered', lookup })).rejects.toThrow(
      /not registered in harness_shared\.projects/,
    );
  });

  it('a same-name collision across workspaces (2+ matches) THROWS', async () => {
    const { lookup } = lookupReturning('ws-a', 'ws-b');
    await expect(resolvePlanScope({ harnessSlug: 'dupe', lookup })).rejects.toThrow(
      /resolves to 2 workspaces/,
    );
  });
});

describe('fill_workspace_id_from_projects', () => {
  it.each(['', '   ', '*', 'all', PAPERCUP_HARNESS_SLUG, undefined])(
    'returns PAPERCUSP_WORKSPACE_ID for the papercup/wildcard scope %s (WI-148 part-B)',
    async (slug) => {
      const { lookup, calls } = lookupReturning('ws-should-not-be-used');
      const ws = await fill_workspace_id_from_projects(slug, { lookup });
      expect(ws).toBe(PAPERCUSP_WORKSPACE_ID);
      // The papercup scope never consults the projects table — it short-circuits
      // to PAPERCUSP_WORKSPACE_ID (WI-148 part-B flip, lockstep with mig 295).
      expect(calls).toEqual([]);
    },
  );

  it('returns the single matching workspace_id', async () => {
    const { lookup } = lookupReturning('ws-only');
    expect(await fill_workspace_id_from_projects('some-harness', { lookup })).toBe('ws-only');
  });

  it('dedups identical matches down to one workspace', async () => {
    const { lookup } = lookupReturning('ws-dup', 'ws-dup');
    expect(await fill_workspace_id_from_projects('some-harness', { lookup })).toBe('ws-dup');
  });

  it('returns null on 0 matches (caller fails loud)', async () => {
    const { lookup } = lookupReturning();
    expect(await fill_workspace_id_from_projects('unknown', { lookup })).toBeNull();
  });

  it('THROWS on a same-name collision across distinct workspaces', async () => {
    const { lookup } = lookupReturning('ws-a', 'ws-b');
    await expect(fill_workspace_id_from_projects('dupe', { lookup })).rejects.toThrow(
      /Ambiguous same-name collision/,
    );
  });

  it('ignores empty/blank workspace_ids in the match set', async () => {
    const { lookup } = lookupReturning('', '   ', 'ws-real');
    expect(await fill_workspace_id_from_projects('some-harness', { lookup })).toBe('ws-real');
  });
});
