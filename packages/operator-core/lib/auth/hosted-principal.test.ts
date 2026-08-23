import { describe, expect, it } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import {
  HOSTED_PERMISSION_VOCABULARY,
  createHostedPrincipal,
  isHostedPermission,
  isHostedPrincipal,
} from './hosted-principal';

const baseInput = () => ({
  workspaceId: 'control-plane',
  userId: 'user_123',
  activeOrganizationId: 'org_456',
  selectedWorkspaceId: 'customer-workspace-789',
  sessionId: 'session_abc',
  sessionVersion: 3,
});

describe('hosted principal permission vocabulary', () => {
  it('pins the complete hosted permission vocabulary', () => {
    expect(HOSTED_PERMISSION_VOCABULARY).toEqual([
      'workspace:view',
      'workspace:operate',
      'workspace:destroy',
      'cloud-connection:manage',
      'members:manage',
      'billing:manage',
      'support:access',
    ]);
  });

  it('accepts only vocabulary members and never the local wildcard', () => {
    expect(isHostedPermission('workspace:view')).toBe(true);
    expect(isHostedPermission('support:access')).toBe(true);
    expect(isHostedPermission('*')).toBe(false);
    expect(isHostedPermission('workspace:admin')).toBe(false);
  });
});

describe('createHostedPrincipal', () => {
  it('constructs a verified hosted user bound to organization, workspace, and session', () => {
    const principal = createHostedPrincipal({
      ...baseInput(),
      permissions: ['workspace:view', 'workspace:operate'],
      label: 'Alice',
    });

    expect(principal).toMatchObject({
      kind: 'user',
      profile: 'hosted',
      slug: 'user_123',
      userId: 'user_123',
      workspaceId: 'control-plane',
      activeOrganizationId: 'org_456',
      selectedWorkspaceId: 'customer-workspace-789',
      sessionId: 'session_abc',
      sessionVersion: 3,
      authMethod: 'cookie-session',
      trust: 'verified',
      label: 'Alice',
    });
    expect([...principal.permissions]).toEqual(['workspace:view', 'workspace:operate']);
    expect(principal.capabilities).toBe(principal.permissions);
    expect(isHostedPrincipal(principal)).toBe(true);
  });

  it('defaults to no permissions rather than wildcard authority', () => {
    const principal = createHostedPrincipal({
      ...baseInput(),
      selectedWorkspaceId: undefined,
    });

    expect([...principal.permissions]).toEqual([]);
    expect(principal.capabilities.has('*' as never)).toBe(false);
    expect(principal).not.toHaveProperty('selectedWorkspaceId');
    expect(isHostedPrincipal(principal)).toBe(true);
  });

  it.each(['*', 'workspace:admin', 'members:view'])('rejects unknown permission %s', (permission) => {
    expect(() => createHostedPrincipal({
      ...baseInput(),
      permissions: [permission],
    })).toThrow(`unknown_hosted_permission:${permission}`);
  });

  it('rejects a string masquerading as a permission iterable', () => {
    expect(() => createHostedPrincipal({
      ...baseInput(),
      permissions: 'workspace:view',
    })).toThrow('hosted_permissions_must_be_an_iterable_of_permission_values');
  });

  it.each([
    ['workspaceId', { workspaceId: ' ' }],
    ['userId', { userId: '' }],
    ['activeOrganizationId', { activeOrganizationId: '\t' }],
    ['selectedWorkspaceId', { selectedWorkspaceId: '' }],
    ['sessionId', { sessionId: '' }],
  ])('rejects an empty %s', (_field, override) => {
    expect(() => createHostedPrincipal({ ...baseInput(), ...override })).toThrow(
      /invalid_hosted_principal_/,
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid session version %s',
    (sessionVersion) => {
      expect(() => createHostedPrincipal({ ...baseInput(), sessionVersion })).toThrow(
        'invalid_hosted_principal_sessionVersion',
      );
    },
  );
});

describe('isHostedPrincipal', () => {
  it('does not treat an existing local user principal as hosted', () => {
    const local: Principal = {
      kind: 'user',
      slug: 'local-user',
      workspaceId: 'local-workspace',
      authMethod: 'cookie-session',
      trust: 'verified',
      capabilities: new Set(['*']),
    };

    expect(isHostedPrincipal(local)).toBe(false);
  });

  it('fails closed when a hosted-shaped object carries an unknown or divergent grant set', () => {
    const principal = createHostedPrincipal({
      ...baseInput(),
      permissions: ['workspace:view'],
    });
    const unknown = new Set(['workspace:view', '*']);

    expect(isHostedPrincipal({ ...principal, permissions: unknown, capabilities: unknown } as never)).toBe(false);
    expect(isHostedPrincipal({ ...principal, capabilities: new Set(principal.permissions) })).toBe(false);
  });
});
