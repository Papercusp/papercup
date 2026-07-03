/**
 * scope-roster.test.ts — P-006 §5.2/§5.3 roster seam. Pure over an injected
 * sql (epoch) + optional directory (P-101), no real PG.
 *
 * The load-bearing properties:
 *   - tier-1 (no directory): membership is OWNER-ONLY, and the owner is a member
 *     even with no epoch/grant row (bootstrap-safe);
 *   - with a P-101 directory: membership widens to {owner} ∪ publisher-set, and
 *     the owner is always included even if the directory omits them;
 *   - X6: currentEpoch reads the owner's grantor high-water live (cache-
 *     bypassing), 0 when absent, 0 on an unresolvable workspace (fail-closed).
 */
import { describe, expect, it, vi } from 'vitest';
import { GrantBackedScopeRoster, type FleetDirectory } from './scope-roster';
import type { ScopeId } from '../sync/hive-git/scope-repo';

const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'widgets' };

/** A fake `sql` tag returning a fixed grantor-epoch row set. */
function fakeSql(rows: { high_water_epoch: number }[]) {
  const calls: unknown[][] = [];
  const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve(rows);
  }) as unknown as import('../work-items').OrgSql;
  return { tag, calls };
}

describe('tier-1 (no directory) — owner-only', () => {
  it('the owner is a member; everyone else is not', async () => {
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', hiveSlug: 'papercusp', sqlOverride: tag });
    expect(await roster.isMember(SCOPE, 42)).toBe(true);
    expect(await roster.isMember(SCOPE, 999)).toBe(false);
    expect(await roster.members(SCOPE)).toEqual([42]);
  });

  it('the owner is a member even with NO epoch/grant row (bootstrap-safe, no read)', async () => {
    const sql = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', hiveSlug: 'papercusp', sqlOverride: sql.tag });
    expect(await roster.isMember(SCOPE, 42)).toBe(true);
    // Owner membership must not have needed a PG read.
    expect(sql.calls.length).toBe(0);
  });

  it('the predicate is the same membership answer', async () => {
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', hiveSlug: 'papercusp', sqlOverride: tag });
    expect(await roster.predicate(SCOPE, 42)).toBe(true);
    expect(await roster.predicate(SCOPE, 7)).toBe(false);
  });
});

describe('with a P-101 directory — {owner} ∪ publisher-set', () => {
  it('admits publisher-set members and always includes the owner', async () => {
    const directory: FleetDirectory = { scopeMembers: vi.fn(async () => [100, 200]) };
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', hiveSlug: 'papercusp', directory, sqlOverride: tag });
    expect(await roster.isMember(SCOPE, 100)).toBe(true);
    expect(await roster.isMember(SCOPE, 42)).toBe(true); // owner
    expect(await roster.isMember(SCOPE, 300)).toBe(false);
    expect((await roster.members(SCOPE)).sort((a, b) => a - b)).toEqual([42, 100, 200]);
  });

  it('does not duplicate the owner when the directory already lists them', async () => {
    const directory: FleetDirectory = { scopeMembers: async () => [42, 100] };
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', hiveSlug: 'papercusp', directory, sqlOverride: tag });
    expect(await roster.members(SCOPE)).toEqual([42, 100]);
  });

  it('a directory MISS (null) falls back to owner-only', async () => {
    const directory: FleetDirectory = { scopeMembers: async () => null };
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', hiveSlug: 'papercusp', directory, sqlOverride: tag });
    expect(await roster.isMember(SCOPE, 100)).toBe(false);
    expect(await roster.members(SCOPE)).toEqual([42]);
  });
});

describe('currentEpoch (X6)', () => {
  it('reads the owner grantor high-water live', async () => {
    const sql = fakeSql([{ high_water_epoch: 5 }]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', hiveSlug: 'papercusp', sqlOverride: sql.tag });
    expect(await roster.currentEpoch(SCOPE)).toBe(5);
    // The query bound the owner id, not some other grantor.
    expect(sql.calls[0]).toContain(42);
  });

  it('is 0 when the owner has no epoch row', async () => {
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', hiveSlug: 'papercusp', sqlOverride: tag });
    expect(await roster.currentEpoch(SCOPE)).toBe(0);
  });

  it('is 0 (fail-closed, no read) on an unresolvable workspace partition', async () => {
    const sql = fakeSql([{ high_water_epoch: 9 }]);
    // 'default' resolves to undefined via resolveP2pGrantWorkspace (WI-1564).
    const roster = new GrantBackedScopeRoster({ workspaceId: 'default', hiveSlug: 'papercusp', sqlOverride: sql.tag });
    expect(await roster.currentEpoch(SCOPE)).toBe(0);
    expect(sql.calls.length).toBe(0);
  });
});
