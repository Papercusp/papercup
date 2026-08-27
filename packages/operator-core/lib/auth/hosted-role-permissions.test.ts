import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOSTED_PERMISSION_VOCABULARY, type HostedPermission } from './hosted-principal';
import {
  HOSTED_MEMBERSHIP_STATUSES,
  HOSTED_ORGANIZATION_ROLES,
  hostedPermissionsForMembership,
  hostedPermissionsForRole,
  hostedRolePermissionMatrix,
  isHostedMembershipStatus,
  isHostedOrganizationRole,
} from './hosted-role-permissions';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MEMBERSHIP_MIGRATION = resolve(
  REPO_ROOT,
  'libs/papercusp/libs/db/sql/903-customer-organization-boundary.sql',
);

/** Read the values out of a `CHECK (<column> IN ('a', 'b'))` constraint. */
function checkConstraintValues(sql: string, constraintName: string): string[] {
  const constraint = new RegExp(
    `CONSTRAINT\\s+${constraintName}\\s*\\n?\\s*CHECK\\s*\\(([^)]*)\\)`,
    'm',
  ).exec(sql);
  if (!constraint) throw new Error(`constraint not found in migration: ${constraintName}`);
  return [...constraint[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

function permissions(role: (typeof HOSTED_ORGANIZATION_ROLES)[number]): string[] {
  return [...hostedPermissionsForRole(role)].sort();
}

describe('hosted role → permission matrix', () => {
  const migration = readFileSync(MEMBERSHIP_MIGRATION, 'utf8');

  it('derives its role vocabulary from the migration CHECK constraint', () => {
    // The migration is the source of truth. A role added in SQL without a
    // permission mapping here would deny-by-default at runtime and read as a
    // mysterious authorization bug; this fails the build instead.
    expect([...HOSTED_ORGANIZATION_ROLES].sort()).toEqual(
      checkConstraintValues(migration, 'organization_memberships_role_ck'),
    );
    expect(Object.keys(hostedRolePermissionMatrix()).sort()).toEqual(
      checkConstraintValues(migration, 'organization_memberships_role_ck'),
    );
  });

  it('derives its status vocabulary from the migration CHECK constraint', () => {
    expect([...HOSTED_MEMBERSHIP_STATUSES].sort()).toEqual(
      checkConstraintValues(migration, 'organization_memberships_status_ck'),
    );
  });

  it('grants every role only permissions from the hosted vocabulary', () => {
    const vocabulary = new Set<string>(HOSTED_PERMISSION_VOCABULARY);
    for (const role of HOSTED_ORGANIZATION_ROLES) {
      for (const permission of hostedPermissionsForRole(role)) {
        expect(vocabulary.has(permission)).toBe(true);
      }
    }
  });

  it('maps each role to its exact graded authority', () => {
    expect(permissions('owner')).toEqual([
      'billing:manage',
      'cloud-connection:manage',
      'members:manage',
      'workspace:destroy',
      'workspace:operate',
      'workspace:view',
    ]);
    expect(permissions('admin')).toEqual([
      'cloud-connection:manage',
      'members:manage',
      'workspace:destroy',
      'workspace:operate',
      'workspace:view',
    ]);
    expect(permissions('member')).toEqual(['workspace:operate', 'workspace:view']);
    expect(permissions('billing')).toEqual(['billing:manage', 'workspace:view']);
  });

  it('never grants support:access from any role', () => {
    // Staff support authority comes from a time-bounded support_access_grant,
    // never from customer organization membership.
    for (const role of HOSTED_ORGANIZATION_ROLES) {
      expect(hostedPermissionsForRole(role).has('support:access' as HostedPermission)).toBe(false);
    }
  });

  it('never grants a wildcard', () => {
    for (const role of HOSTED_ORGANIZATION_ROLES) {
      expect([...hostedPermissionsForRole(role)]).not.toContain('*');
    }
  });

  it('gives billing narrow authority, not senior authority', () => {
    const billing = hostedPermissionsForRole('billing');
    expect(billing.has('workspace:operate')).toBe(false);
    expect(billing.has('workspace:destroy')).toBe(false);
    expect(billing.has('members:manage')).toBe(false);
    expect(billing.has('cloud-connection:manage')).toBe(false);
  });

  it('gives every active role the workspace:view baseline', () => {
    // The hosted session/logout routes require it; a member who cannot hold it
    // could not read or end their own session.
    for (const role of HOSTED_ORGANIZATION_ROLES) {
      expect(hostedPermissionsForRole(role).has('workspace:view')).toBe(true);
    }
  });

  it('grants nothing for a membership that is not active', () => {
    for (const role of HOSTED_ORGANIZATION_ROLES) {
      expect([...hostedPermissionsForMembership({ role, status: 'active' })].length).toBeGreaterThan(0);
      expect([...hostedPermissionsForMembership({ role, status: 'suspended' })]).toEqual([]);
      expect([...hostedPermissionsForMembership({ role, status: 'revoked' })]).toEqual([]);
    }
  });

  it('denies by default for unknown roles, statuses, and wrong types', () => {
    expect([...hostedPermissionsForMembership({ role: 'superuser', status: 'active' })]).toEqual([]);
    expect([...hostedPermissionsForMembership({ role: '*', status: 'active' })]).toEqual([]);
    expect([...hostedPermissionsForMembership({ role: '', status: 'active' })]).toEqual([]);
    expect([...hostedPermissionsForMembership({ role: 'owner', status: 'pending' })]).toEqual([]);
    expect([...hostedPermissionsForMembership({ role: 'owner', status: '' })]).toEqual([]);
    expect(
      [...hostedPermissionsForMembership({
        role: 'owner',
        status: 'ACTIVE',
      })],
    ).toEqual([]);
    expect(
      [...hostedPermissionsForMembership({
        role: undefined as unknown as string,
        status: 'active',
      })],
    ).toEqual([]);
    expect(
      [...hostedPermissionsForMembership({
        role: 'owner',
        status: undefined as unknown as string,
      })],
    ).toEqual([]);
  });

  it('returns an independent set each call so a caller cannot widen the matrix', () => {
    const first = hostedPermissionsForRole('member') as Set<HostedPermission>;
    first.add('billing:manage');
    expect(hostedPermissionsForRole('member').has('billing:manage')).toBe(false);
  });

  it('type guards accept exactly the declared vocabularies', () => {
    expect(isHostedOrganizationRole('owner')).toBe(true);
    expect(isHostedOrganizationRole('Owner')).toBe(false);
    expect(isHostedOrganizationRole(null)).toBe(false);
    expect(isHostedMembershipStatus('active')).toBe(true);
    expect(isHostedMembershipStatus('deleted')).toBe(false);
  });
});
