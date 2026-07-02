/**
 * agent-facts store — unit tests for the pure parts (queen-memory-hybrid L1b):
 * scope validation per D-001 (harness/work_item optional; workspace ref-less)
 * and the deterministic fold rendering. SQL paths are exercised by the tools'
 * live-verify (the store is a thin tagged-template layer over one table).
 */
import { describe, expect, it } from 'vitest';
import { renderFactsFold, validateFactScope, type AgentFact } from './store';

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
