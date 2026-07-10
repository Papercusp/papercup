// @vitest-environment node
/**
 * Unit tests for the pure pot-tier model (B11 / P-014). Every GitHub permission
 * level must map deterministically, and the tier ordering must be transitive —
 * these are the security floor the gate rests on.
 */
import { describe, expect, it } from 'vitest';
import { permissionToTier, tierMeets, type PotMemberTier } from './member-tiers';
import type { GithubRepoPermission } from '../harness/binding-types';

describe('permissionToTier — every GitHub permission maps', () => {
  const cases: Array<[GithubRepoPermission, PotMemberTier]> = [
    ['admin', 'owner'],
    ['maintain', 'owner'],
    ['write', 'collaborator'],
    ['triage', 'collaborator'],
    ['read', 'read-only'],
    ['none', 'read-only'],
  ];
  for (const [perm, tier] of cases) {
    it(`${perm} → ${tier}`, () => {
      expect(permissionToTier(perm)).toBe(tier);
    });
  }

  it('an unknown/future permission level is treated as read-only (fail-safe)', () => {
    expect(permissionToTier('superadmin' as GithubRepoPermission)).toBe('read-only');
  });
});

describe('tierMeets — owner ⊇ collaborator ⊇ read-only', () => {
  it('owner satisfies every required tier', () => {
    expect(tierMeets('owner', 'owner')).toBe(true);
    expect(tierMeets('owner', 'collaborator')).toBe(true);
    expect(tierMeets('owner', 'read-only')).toBe(true);
  });

  it('collaborator satisfies collaborator + read-only, NOT owner', () => {
    expect(tierMeets('collaborator', 'owner')).toBe(false);
    expect(tierMeets('collaborator', 'collaborator')).toBe(true);
    expect(tierMeets('collaborator', 'read-only')).toBe(true);
  });

  it('read-only satisfies only read-only — denied owner + collaborator actions', () => {
    expect(tierMeets('read-only', 'owner')).toBe(false);
    expect(tierMeets('read-only', 'collaborator')).toBe(false);
    expect(tierMeets('read-only', 'read-only')).toBe(true);
  });
});
