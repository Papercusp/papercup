/**
 * agent-facts store — unit tests for the pure parts (queen-memory-hybrid L1b):
 * scope validation per D-001 (harness/work_item optional; workspace ref-less)
 * and the deterministic fold rendering. SQL paths are exercised by the tools'
 * live-verify (the store is a thin tagged-template layer over one table).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  assertFact,
  renderFactsFold,
  resolveFederationWorkspace,
  validateFactScope,
  type AgentFact,
} from './store';

describe('resolveFederationWorkspace (F1-4 / WI-1564)', () => {
  it('returns the workspace when it federates', () => {
    expect(resolveFederationWorkspace('papercusp-workspace')).toBe('papercusp-workspace');
    expect(resolveFederationWorkspace('  oddsmith-ws  ')).toBe('oddsmith-ws');
  });

  it('returns undefined for the non-federating coordination / wildcard / empty partitions', () => {
    expect(resolveFederationWorkspace('default')).toBeUndefined(); // DEFAULT_COORD_WORKSPACE
    expect(resolveFederationWorkspace('*')).toBeUndefined();
    expect(resolveFederationWorkspace('')).toBeUndefined();
    expect(resolveFederationWorkspace('   ')).toBeUndefined();
    expect(resolveFederationWorkspace(null)).toBeUndefined();
    expect(resolveFederationWorkspace(undefined)).toBeUndefined();
  });
});

describe('assertFact WI-1564 stranding guard (F1-4)', () => {
  // A stub that throws if the SQL layer is ever reached — proves whether the
  // guard refuses BEFORE any write (a refused shareable assert must never touch
  // the table) vs. lets a private assert through to SQL.
  const failSql = (() => {
    throw new Error('SQL SHOULD NOT BE REACHED — the WI-1564 guard must refuse first');
  }) as unknown as Sql;

  it('refuses a SHAREABLE fact on the non-federating coordination partition (loud, not stranded)', async () => {
    await expect(
      assertFact(
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', shareable: true, workspaceId: 'default' },
        failSql,
      ),
    ).rejects.toThrow(/WI-1564/);
  });

  it('refuses a shareable fact whose workspace resolves to the wildcard partition', async () => {
    await expect(
      assertFact(
        { scope: 'role', scopeRef: 'queen', key: 'k', body: 'b', createdBy: 'su-test', shareable: true, workspaceId: '*' },
        failSql,
      ),
    ).rejects.toThrow(/never federates/);
  });

  it('lets a hive-PRIVATE fact through the guard on any partition (reaches SQL)', async () => {
    // shareable !== true ⇒ never rides the wire ⇒ the coordination partition is
    // fine; the assert must get PAST the guard (and hit the failSql stub).
    await expect(
      assertFact(
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', workspaceId: 'default' },
        failSql,
      ),
    ).rejects.toThrow(/SQL SHOULD NOT BE REACHED/);
  });
});

describe('validateFactScope (D-001 scoping)', () => {
  it('workspace scope is global — carries NO ref', () => {
    expect(validateFactScope('workspace', null)).toBeNull();
    expect(validateFactScope('workspace', 'papercusp')).toMatch(/no scope_ref/);
  });

  it('every other scope requires a ref', () => {
    for (const scope of ['role', 'owner', 'harness', 'work_item']) {
      expect(validateFactScope(scope, 'x')).toBeNull();
      expect(validateFactScope(scope, '')).toMatch(/requires scope_ref/);
      expect(validateFactScope(scope, null)).toMatch(/requires scope_ref/);
    }
  });

  it('rejects unknown scopes', () => {
    expect(validateFactScope('galaxy', 'x')).toMatch(/unknown scope/);
  });
});

describe('renderFactsFold', () => {
  const fact = (over: Partial<AgentFact>): AgentFact => ({
    scope: 'role',
    scopeRef: 'queen',
    key: 'k',
    body: 'WI-1439 is owner-residue — exclude from the placeable frontier',
    sourceRef: 'WI-1574',
    createdBy: 'su-test',
    updatedAt: new Date(0).toISOString(),
    expiresAt: new Date(3 * 86_400_000).toISOString(),
    ...over,
  });

  it('renders one deterministic line per fact with scope, expiry and source', () => {
    const out = renderFactsFold([fact({})], 0);
    expect(out).toContain('### Standing facts');
    expect(out).toContain('[role:queen] WI-1439 is owner-residue');
    expect(out).toContain('expires ~3d');
    expect(out).toContain('src WI-1574');
  });

  it('workspace-scoped facts render without a ref; empty set renders nothing', () => {
    const out = renderFactsFold([fact({ scope: 'workspace', scopeRef: null, sourceRef: null })], 0);
    expect(out).toContain('[workspace]');
    expect(out).not.toContain('src ');
    expect(renderFactsFold([])).toBe('');
  });
});
