/**
 * _hive-scope.test.ts — P-022/P-024 hive-scope resolution (domain-generic-hive-architecture-2026-06-18).
 * Pins the auto-resolve-then-require contract with an INJECTED resolver (no PG):
 * explicit arg wins, else auto-resolve the acting harness's hive home, else `none`.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveHiveScope, type HiveHomeResolver } from './_hive-scope';

describe('resolveHiveScope — auto-resolve-then-require (P-024)', () => {
  const homeOf: Record<string, string> = {
    'acme-bench': 'acme-hive', // a member harness → its hive home
    'acme-hive': 'acme-hive', // a home harness → itself
  };
  const fakeResolver: HiveHomeResolver = async (_ws, harness) => homeOf[harness] ?? null;

  it('explicit hive arg wins (no resolver call needed)', async () => {
    const spy = vi.fn(fakeResolver);
    const scope = await resolveHiveScope('chosen-hive', { workspaceId: 'w', harnessSlug: 'acme-bench' }, spy);
    expect(scope).toEqual({ kind: 'hive', slug: 'chosen-hive' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('no arg, concrete harness + ws → auto-resolves the home-hive slug', async () => {
    const scope = await resolveHiveScope(undefined, { workspaceId: 'w', harnessSlug: 'acme-bench' }, fakeResolver);
    expect(scope).toEqual({ kind: 'hive', slug: 'acme-hive' }); // member → home collapse (Q1)
  });

  it('no arg, a home harness resolves to itself', async () => {
    const scope = await resolveHiveScope(undefined, { workspaceId: 'w', harnessSlug: 'acme-hive' }, fakeResolver);
    expect(scope).toEqual({ kind: 'hive', slug: 'acme-hive' });
  });

  it('no arg, operator scope (harness "*") → none (must pass explicit hive)', async () => {
    const scope = await resolveHiveScope(undefined, { workspaceId: 'w', harnessSlug: '*' }, fakeResolver);
    expect(scope).toEqual({ kind: 'none' });
  });

  it('no arg, no workspaceId → none', async () => {
    const scope = await resolveHiveScope(undefined, { harnessSlug: 'acme-bench' }, fakeResolver);
    expect(scope).toEqual({ kind: 'none' });
  });

  it('harness not in any hive (resolver → null) → none', async () => {
    const scope = await resolveHiveScope(undefined, { workspaceId: 'w', harnessSlug: 'orphan' }, fakeResolver);
    expect(scope).toEqual({ kind: 'none' });
  });

  it('an all/* arg is NOT a hive — falls through to auto-resolve from the harness', async () => {
    const scope = await resolveHiveScope('all', { workspaceId: 'w', harnessSlug: 'acme-bench' }, fakeResolver);
    expect(scope).toEqual({ kind: 'hive', slug: 'acme-hive' });
  });

  it('resolver throwing → none (best-effort, never propagates)', async () => {
    const boom: HiveHomeResolver = async () => {
      throw new Error('PG down');
    };
    const scope = await resolveHiveScope(undefined, { workspaceId: 'w', harnessSlug: 'acme-bench' }, boom);
    expect(scope).toEqual({ kind: 'none' });
  });
});
