/**
 * federation-scope.test.ts — the workspace shared-Hive default-scope resolver
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-001). Pure over injected
 * deps. Pins:
 *   • exactly one shared Hive → { kind:'one', homeSlug } (owned-published OR joined);
 *   • private / un-published owned hives are NEVER a scope (no DHT leak);
 *   • zero / several shared → none / many (ambiguity never guessed);
 *   • resolution errors fail SOFT to none (a scope lookup never breaks a send);
 *   • TTL cache: second call within the window does not re-read; fresh bypasses.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/federation-scope.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWorkspaceHiveScope,
  resetFederationScopeCache,
  type FederationScopeDeps,
} from './federation-scope';

function makeDeps(over?: Partial<FederationScopeDeps>): FederationScopeDeps {
  return {
    listHives: vi.fn(async () => [{ homeSlug: 'hive-a' }]),
    loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    getOwnedHiveMeta: vi.fn(async () => ({ visibility: 'public' })),
    ...over,
  };
}

beforeEach(() => {
  resetFederationScopeCache();
});

describe('resolveWorkspaceHiveScope', () => {
  it('exactly one owned PUBLISHED hive → one', async () => {
    const deps = makeDeps();
    const r = await resolveWorkspaceHiveScope('ws1', { deps });
    expect(r).toEqual({ kind: 'one', homeSlug: 'hive-a' });
  });

  it('a JOINED remote_hive view counts as shared without owned meta', async () => {
    const deps = makeDeps({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'hive-a', remote_hive: true }],
      })),
      getOwnedHiveMeta: vi.fn(async () => null),
    });
    const r = await resolveWorkspaceHiveScope('ws1', { deps });
    expect(r).toEqual({ kind: 'one', homeSlug: 'hive-a' });
    expect(deps.getOwnedHiveMeta).not.toHaveBeenCalled(); // joined ⇒ meta not consulted
  });

  it('a PRIVATE owned hive is never a scope (no DHT leak)', async () => {
    const deps = makeDeps({ getOwnedHiveMeta: vi.fn(async () => ({ visibility: 'private' })) });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({ kind: 'none' });
  });

  it('an UN-PUBLISHED owned hive (no meta) is never a scope', async () => {
    const deps = makeDeps({ getOwnedHiveMeta: vi.fn(async () => null) });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({ kind: 'none' });
  });

  it('no hives at all → none (registry never read)', async () => {
    const deps = makeDeps({ listHives: vi.fn(async () => []) });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({ kind: 'none' });
    expect(deps.loadHarnessRegistry).not.toHaveBeenCalled();
  });

  it('several shared hives → many with sorted candidates (never guessed)', async () => {
    const deps = makeDeps({
      listHives: vi.fn(async () => [{ homeSlug: 'hive-b' }, { homeSlug: 'hive-a' }]),
    });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({
      kind: 'many',
      candidates: ['hive-a', 'hive-b'],
    });
  });

  it('mixed: one published + one private → the published one wins alone', async () => {
    const deps = makeDeps({
      listHives: vi.fn(async () => [{ homeSlug: 'pub' }, { homeSlug: 'priv' }]),
      getOwnedHiveMeta: vi.fn(async (home: string) =>
        home === 'pub' ? { visibility: 'invite' } : { visibility: 'private' },
      ),
    });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({
      kind: 'one',
      homeSlug: 'pub',
    });
  });

  it('a resolution error fails SOFT to none — a scope lookup never breaks a send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps({
        listHives: vi.fn(async () => {
          throw new Error('pg down');
        }),
      });
      expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({ kind: 'none' });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('caches per workspace within the TTL; { fresh:true } bypasses', async () => {
    const deps = makeDeps();
    await resolveWorkspaceHiveScope('ws1', { deps });
    await resolveWorkspaceHiveScope('ws1', { deps });
    expect(deps.listHives).toHaveBeenCalledTimes(1); // second hit served from cache
    await resolveWorkspaceHiveScope('ws1', { deps, fresh: true });
    expect(deps.listHives).toHaveBeenCalledTimes(2);
    // a different workspace is its own cache key
    await resolveWorkspaceHiveScope('ws2', { deps });
    expect(deps.listHives).toHaveBeenCalledTimes(3);
  });
});
