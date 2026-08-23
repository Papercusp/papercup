import { describe, expect, it } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import { createHostedPrincipal, type HostedPermission } from './hosted-principal';
import {
  HostedAuthorizationError,
  authorizeHostedOperation,
  hostedPermissionResourceKind,
  requireHostedOperation,
  type HostedAuthorizationInput,
} from './hosted-authorization';

function principal(
  permissions: readonly HostedPermission[] = ['workspace:view'],
  selectedWorkspaceId: string | null = 'workspace-1',
) {
  return createHostedPrincipal({
    workspaceId: 'control-plane',
    userId: 'user-1',
    activeOrganizationId: 'org-1',
    selectedWorkspaceId: selectedWorkspaceId ?? undefined,
    sessionId: 'session-1',
    sessionVersion: 7,
    permissions,
  });
}

function workspaceInput(
  override: Partial<HostedAuthorizationInput> = {},
): HostedAuthorizationInput {
  return {
    principal: principal(),
    permission: 'workspace:view',
    resource: {
      kind: 'workspace',
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
    },
    session: {
      sessionId: 'session-1',
      sessionVersion: 7,
      revoked: false,
    },
    ...override,
  };
}

describe('hosted permission resource kinds', () => {
  it.each([
    ['workspace:view', 'workspace'],
    ['workspace:operate', 'workspace'],
    ['workspace:destroy', 'workspace'],
    ['cloud-connection:manage', 'organization'],
    ['members:manage', 'organization'],
    ['billing:manage', 'organization'],
    ['support:access', 'organization'],
  ] as const)('binds %s to an exact %s resource', (permission, kind) => {
    expect(hostedPermissionResourceKind(permission)).toBe(kind);
  });
});

describe('authorizeHostedOperation', () => {
  it('allows an exact live-session, tenant, workspace, and permission match', () => {
    const input = workspaceInput();
    const decision = authorizeHostedOperation(input);

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('expected authorization to pass');
    expect(decision.principal).toBe(input.principal);
    expect(decision.audit).toEqual({
      decision: 'allow',
      reason: 'authorized',
      permission: 'workspace:view',
      principalSlug: 'user-1',
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionVersion: 7,
    });
  });

  it('allows an organization operation without ambient workspace authority', () => {
    const input = workspaceInput({
      principal: principal(['billing:manage'], undefined),
      permission: 'billing:manage',
      resource: { kind: 'organization', organizationId: 'org-1' },
    });

    const decision = authorizeHostedOperation(input);
    expect(decision.allowed).toBe(true);
    expect(decision.audit.workspaceId).toBeNull();
  });

  it.each([
    ['missing', null, 'principal_missing', 401],
    [
      'local wildcard user',
      {
        kind: 'user',
        slug: 'local-user',
        workspaceId: 'control-plane',
        authMethod: 'cookie-session',
        trust: 'verified',
        capabilities: new Set(['*']),
      } satisfies Principal,
      'principal_not_hosted',
      403,
    ],
  ] as const)('denies a %s principal without hosted fallback', (_label, candidate, reason, status) => {
    const decision = authorizeHostedOperation(workspaceInput({ principal: candidate }));
    expect(decision).toMatchObject({ allowed: false, reason, status });
  });

  it('denies an operation outside the hosted vocabulary even after a runtime cast', () => {
    const decision = authorizeHostedOperation(workspaceInput({
      permission: '*' as HostedPermission,
    }));
    expect(decision).toMatchObject({
      allowed: false,
      status: 403,
      reason: 'permission_invalid',
      audit: { permission: '*' },
    });
  });

  it.each([
    ['missing', null, 'session_state_missing'],
    [
      'invalid',
      { sessionId: '', sessionVersion: 7, revoked: false },
      'session_state_invalid',
    ],
    [
      'different id',
      { sessionId: 'session-other', sessionVersion: 7, revoked: false },
      'session_id_mismatch',
    ],
    [
      'revoked',
      { sessionId: 'session-1', sessionVersion: 7, revoked: true },
      'session_revoked',
    ],
    [
      'stale version',
      { sessionId: 'session-1', sessionVersion: 8, revoked: false },
      'session_version_mismatch',
    ],
  ] as const)('denies a %s authoritative session state', (_label, session, reason) => {
    const decision = authorizeHostedOperation(workspaceInput({ session }));
    expect(decision).toMatchObject({ allowed: false, reason, status: 401 });
  });

  it.each([
    [
      'organization mismatch',
      { kind: 'workspace', organizationId: 'org-other', workspaceId: 'workspace-1' },
      'organization_mismatch',
    ],
    [
      'workspace not selected',
      { kind: 'workspace', organizationId: 'org-1', workspaceId: 'workspace-1' },
      'workspace_not_selected',
    ],
    [
      'workspace mismatch',
      { kind: 'workspace', organizationId: 'org-1', workspaceId: 'workspace-other' },
      'workspace_mismatch',
    ],
  ] as const)('denies %s', (label, resource, reason) => {
    const selected = label === 'workspace not selected' ? null : 'workspace-1';
    const decision = authorizeHostedOperation(workspaceInput({
      principal: principal(['workspace:view'], selected),
      resource,
    }));
    expect(decision).toMatchObject({ allowed: false, reason, status: 403 });
  });

  it('denies an operation whose declared resource kind does not match', () => {
    const decision = authorizeHostedOperation(workspaceInput({
      resource: { kind: 'organization', organizationId: 'org-1' },
    }));
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'resource_kind_mismatch',
    });
  });

  it('denies a malformed resource rather than using ambient scope', () => {
    const decision = authorizeHostedOperation(workspaceInput({
      resource: {
        kind: 'workspace',
        organizationId: 'org-1',
        workspaceId: '',
      },
    }));
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'resource_scope_invalid',
    });
  });

  it('fails closed without throwing when an untyped caller supplies no resource object', () => {
    const decision = authorizeHostedOperation(workspaceInput({
      resource: null as never,
    }));
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'resource_scope_invalid',
      audit: {
        organizationId: null,
        workspaceId: null,
      },
    });
  });

  it('denies by default when the exact permission is absent', () => {
    const decision = authorizeHostedOperation(workspaceInput({
      principal: principal([]),
    }));
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'permission_missing',
      audit: {
        decision: 'deny',
        reason: 'permission_missing',
        principalSlug: 'user-1',
        organizationId: 'org-1',
        workspaceId: 'workspace-1',
      },
    });
  });
});

describe('requireHostedOperation', () => {
  it('returns the narrowed principal on allow', () => {
    const input = workspaceInput();
    expect(requireHostedOperation(input)).toBe(input.principal);
  });

  it('throws a stable middleware error with an auditable refusal reason', () => {
    let thrown: unknown;
    try {
      requireHostedOperation(workspaceInput({ principal: principal([]) }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HostedAuthorizationError);
    expect(thrown).toMatchObject({
      name: 'HostedAuthorizationError',
      code: 'hosted_authorization_denied',
      status: 403,
      reason: 'permission_missing',
      audit: {
        decision: 'deny',
        reason: 'permission_missing',
        permission: 'workspace:view',
      },
    });
  });
});
