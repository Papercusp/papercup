/**
 * _pot-scope.test.ts — P-022/P-024 pot-scope resolution (domain-generic-hive-architecture-2026-06-18).
 * Pins the auto-resolve-then-require contract with an INJECTED resolver (no PG):
 * explicit arg wins, else auto-resolve the acting harness's pot home, else `none`.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolvePotScope, type PotHomeResolver } from './_pot-scope';

describe('resolvePotScope — auto-resolve-then-require (P-024)', () => {
  const homeOf: Record<string, string> = {
    'acme-bench': 'acme-hive', // a member harness → its pot home
    'acme-hive': 'acme-hive', // a home harness → itself
  };
  const fakeResolver: PotHomeResolver = async (_ws, harness) => homeOf[harness] ?? null;

  it('explicit pot arg wins (no resolver call needed)', async () => {
    const spy = vi.fn(fakeResolver);
    const scope = await resolvePotScope('chosen-hive', { workspaceId: 'w', harnessSlug: 'acme-bench' }, spy);
    expect(scope).toEqual({ kind: 'pot', slug: 'chosen-hive' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('no arg, concrete harness + ws → auto-resolves the home-pot slug', async () => {
    const scope = await resolvePotScope(undefined, { workspaceId: 'w', harnessSlug: 'acme-bench' }, fakeResolver);
    expect(scope).toEqual({ kind: 'pot', slug: 'acme-hive' }); // member → home collapse (Q1)
  });

  it('no arg, a home harness resolves to itself', async () => {
    const scope = await resolvePotScope(undefined, { workspaceId: 'w', harnessSlug: 'acme-hive' }, fakeResolver);
    expect(scope).toEqual({ kind: 'pot', slug: 'acme-hive' });
  });

  it('no arg, operator scope (harness "*") → none (must pass explicit pot)', async () => {
    const scope = await resolvePotScope(undefined, { workspaceId: 'w', harnessSlug: '*' }, fakeResolver);
    expect(scope).toEqual({ kind: 'none' });
  });

  it('no arg, no workspaceId → none', async () => {
    const scope = await resolvePotScope(undefined, { harnessSlug: 'acme-bench' }, fakeResolver);
    expect(scope).toEqual({ kind: 'none' });
  });

  it('harness not in any pot (resolver → null) → none', async () => {
    const scope = await resolvePotScope(undefined, { workspaceId: 'w', harnessSlug: 'orphan' }, fakeResolver);
    expect(scope).toEqual({ kind: 'none' });
  });

  it('an all/* arg is NOT a pot — falls through to auto-resolve from the harness', async () => {
    const scope = await resolvePotScope('all', { workspaceId: 'w', harnessSlug: 'acme-bench' }, fakeResolver);
    expect(scope).toEqual({ kind: 'pot', slug: 'acme-hive' });
  });

  it('resolver throwing → none (best-effort, never propagates)', async () => {
    const boom: PotHomeResolver = async () => {
      throw new Error('PG down');
    };
    const scope = await resolvePotScope(undefined, { workspaceId: 'w', harnessSlug: 'acme-bench' }, boom);
    expect(scope).toEqual({ kind: 'none' });
  });
});
