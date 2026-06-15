/**
 * Coverage for getKnownRoles — blueprint-role-bundling-2026-06-15 Phase 0
 * (EI-621 / D-008): the role registry is the `AGENT_ROLES` const, no longer a
 * filesystem walk of the global `prompts/` dir. These tests pin that contract.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { getKnownRoles } from './known-roles';

describe('getKnownRoles', () => {
  it('returns exactly the AGENT_ROLES const (the registry is off the filesystem)', () => {
    expect(getKnownRoles()).toEqual([...AGENT_ROLES]);
  });

  it('includes the pipeline spine and the cross-cutting roles', () => {
    const roles = getKnownRoles();
    for (const r of ['scoper', 'worker', 'validator', 'reviewer', 'orchestrator', 'curator']) {
      expect(roles).toContain(r);
    }
  });

  it('includes the blueprint-shipped specialist roles expanded in Phase 0', () => {
    const roles = getKnownRoles();
    for (const r of ['researcher', 'scanner', 'judge', 'transformer', 'migration-director']) {
      expect(roles).toContain(r);
    }
  });

  it('returns a fresh, independently-mutable array each call', () => {
    const a = getKnownRoles();
    const b = getKnownRoles();
    expect(a).not.toBe(b);
    a.push('mutated');
    expect(getKnownRoles()).not.toContain('mutated');
  });
});
