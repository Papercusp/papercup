import { describe, expect, it } from 'vitest';
import type { HostedVerifiedIdentity } from './provider';
import {
  HOSTED_ONBOARDING_STEPS,
  HostedOnboardingOrchestrator,
  type HostedMembershipAdmissionResult,
  type HostedOnboardingDependencies,
  type HostedOnboardingRequest,
  type HostedOnboardingState,
} from './onboarding';

const NOW = new Date('2026-08-26T20:00:00.000Z');
const IDENTITY: HostedVerifiedIdentity = {
  externalUserId: 'user_workos_1',
  primaryEmail: 'Member@Example.com',
  emailVerified: true,
  displayName: 'Member',
};

class MemoryStateStore {
  readonly rows = new Map<string, HostedOnboardingState>();
  failCheckpointOnce = false;

  async loadOrCreate(seed: HostedOnboardingState): Promise<HostedOnboardingState> {
    const current = this.rows.get(seed.attemptId);
    if (current) return current;
    this.rows.set(seed.attemptId, seed);
    return seed;
  }

  async checkpoint(state: HostedOnboardingState): Promise<HostedOnboardingState> {
    if (this.failCheckpointOnce) {
      this.failCheckpointOnce = false;
      throw new Error('checkpoint unavailable');
    }
    this.rows.set(state.attemptId, state);
    return state;
  }
}

function request(override: Partial<HostedOnboardingRequest> = {}): HostedOnboardingRequest {
  return {
    attemptId: 'attempt-1',
    providerId: 'workos',
    identity: IDENTITY,
    admission: {
      kind: 'invitation',
      invitationId: 'invite-1',
      organizationId: 'org-1',
      expectedEmail: 'member@example.com',
      expiresAt: new Date(NOW.getTime() + 60_000),
      role: 'member',
    },
    legal: {
      termsVersion: 'terms-2026-08',
      privacyVersion: 'privacy-2026-08',
      acceptedAt: NOW,
    },
    selection: { organizationId: 'org-1' },
    providerDelegation: { provider: 'gcp', connectionId: 'connection-1' },
    workspace: { displayName: 'Production' },
    ...override,
  };
}

function setup(options: {
  admission?: HostedMembershipAdmissionResult;
  failWorkspaceOnce?: boolean;
} = {}) {
  const state = new MemoryStateStore();
  const calls: string[] = [];
  const operationResults = new Map<string, unknown>();
  let failWorkspace = options.failWorkspaceOnce ?? false;
  const once = async <T>(key: string, make: () => T): Promise<T> => {
    calls.push(key);
    if (!operationResults.has(key)) operationResults.set(key, make());
    return operationResults.get(key) as T;
  };

  const deps: HostedOnboardingDependencies = {
    state,
    identities: {
      upsertVerifiedIdentity: ({ operationKey }) => once(operationKey, () => ({ userId: 'user-1' })),
    },
    memberships: {
      admit: ({ operationKey }) => once(operationKey, () => options.admission ?? ({
        ok: true as const,
        organizationId: 'org-1',
        role: 'member' as const,
        permissionVersion: 7,
      })),
      resolveActive: async ({ organizationId }) => organizationId === 'org-2'
        ? { organizationId, role: 'admin', permissionVersion: 11 }
        : null,
    },
    legal: {
      recordAcceptance: ({ operationKey }) => once(operationKey, () => undefined),
    },
    entitlements: {
      requireBetaAccess: ({ organizationId, operationKey }) => once(
        operationKey,
        () => organizationId === 'org-denied'
          ? { allowed: false as const, retryable: false }
          : { allowed: true as const },
      ),
    },
    providerDelegation: {
      ensureDelegation: ({ operationKey }) => once(operationKey, () => undefined),
    },
    workspaces: {
      resolveSelectable: async ({ organizationId, workspaceId }) =>
        (organizationId === 'org-1' && workspaceId === 'workspace-1')
        || (organizationId === 'org-2' && workspaceId === 'workspace-2'),
      ensureProvisioned: async ({ operationKey }) => {
        calls.push(operationKey);
        if (failWorkspace) {
          failWorkspace = false;
          throw new Error('provisioning unavailable');
        }
        if (!operationResults.has(operationKey)) {
          operationResults.set(operationKey, {
            workspaceId: 'workspace-1',
            provisionOperationId: 'provision-1',
          });
        }
        return operationResults.get(operationKey) as {
          workspaceId: string;
          provisionOperationId: string;
        };
      },
    },
    sessions: {
      activate: ({ operationKey }) => once(operationKey, () => ({ sessionId: 'session-1' })),
      rotateForOrganization: async ({ sessionId, organizationId }) => ({
        sessionId: `${sessionId}:rotated:${organizationId}`,
      }),
    },
    clock: () => NOW,
  };
  return { orchestrator: new HostedOnboardingOrchestrator(deps), state, calls };
}

describe('HostedOnboardingOrchestrator', () => {
  it('composes the complete invite-to-session flow in authority order', async () => {
    const s = setup();
    const result = await s.orchestrator.run(request());

    expect(result).toMatchObject({
      ok: true,
      binding: {
        userId: 'user-1',
        organizationId: 'org-1',
        workspaceId: 'workspace-1',
        permissionVersion: 7,
        sessionId: 'session-1',
      },
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.state.completedSteps).toEqual(HOSTED_ONBOARDING_STEPS);
    expect(s.calls).toEqual(HOSTED_ONBOARDING_STEPS.filter((step) => step !== 'selection')
      .map((step) => `hosted-onboarding:attempt-1:${step}`));
  });

  it.each([
    [
      'wrong_email',
      request({
        admission: {
          kind: 'invitation',
          invitationId: 'invite-1',
          organizationId: 'org-1',
          expectedEmail: 'attacker@example.com',
          expiresAt: new Date(NOW.getTime() + 60_000),
          role: 'member',
        },
      }),
    ],
    [
      'invitation_expired',
      request({
        admission: {
          kind: 'invitation',
          invitationId: 'invite-1',
          organizationId: 'org-1',
          expectedEmail: 'member@example.com',
          expiresAt: new Date(NOW.getTime() - 1),
          role: 'member',
        },
      }),
    ],
  ] as const)('rejects %s before creating identity or local authority', async (code, input) => {
    const s = setup();
    await expect(s.orchestrator.run(input)).resolves.toEqual({ ok: false, code, retryable: false });
    expect(s.calls).toEqual([]);
    expect(s.state.rows.size).toBe(0);
  });

  it('treats an invitation replay as terminal and never advances legal/session work', async () => {
    const s = setup({
      admission: { ok: false, reason: 'invitation_replayed', retryable: false },
    });
    const result = await s.orchestrator.run(request());
    expect(result).toMatchObject({ ok: false, code: 'invitation_replayed', retryable: false });
    expect(s.calls).toEqual([
      'hosted-onboarding:attempt-1:identity',
      'hosted-onboarding:attempt-1:membership',
    ]);
  });

  it('resumes after partial provisioning failure without replaying completed steps', async () => {
    const s = setup({ failWorkspaceOnce: true });
    const first = await s.orchestrator.run(request());
    expect(first).toMatchObject({ ok: false, code: 'workspace_provisioning_failed', retryable: true });

    const callsBeforeRetry = [...s.calls];
    const second = await s.orchestrator.run(request());
    expect(second.ok).toBe(true);
    expect(s.calls.slice(callsBeforeRetry.length)).toEqual([
      'hosted-onboarding:attempt-1:workspace',
      'hosted-onboarding:attempt-1:session',
    ]);
  });

  it('replays an idempotent operation when its following checkpoint was unavailable', async () => {
    const s = setup();
    s.state.failCheckpointOnce = true;
    const first = await s.orchestrator.run(request());
    expect(first).toMatchObject({ ok: false, code: 'store_unavailable', retryable: true });
    const second = await s.orchestrator.run(request());
    expect(second.ok).toBe(true);
    expect(s.calls.filter((call) => call.endsWith(':identity'))).toHaveLength(2);
  });

  it('supports existing-user multi-organization switching only by rotating the session', async () => {
    const s = setup();
    const switched = await s.orchestrator.switchOrganization({
      sessionId: 'session-old',
      userId: 'user-1',
      organizationId: 'org-2',
      workspaceId: 'workspace-2',
      expectedPermissionVersion: 7,
      operationKey: 'switch-1',
    });
    expect(switched).toEqual({
      userId: 'user-1',
      organizationId: 'org-2',
      workspaceId: 'workspace-2',
      permissionVersion: 11,
      sessionId: 'session-old:rotated:org-2',
    });
    await expect(s.orchestrator.switchOrganization({
      sessionId: 'session-old',
      userId: 'user-1',
      organizationId: 'org-missing',
      workspaceId: 'workspace-2',
      expectedPermissionVersion: 7,
      operationKey: 'switch-2',
    })).resolves.toBeNull();
  });

  it('accepts a beta approval but binds the approved email and Papercusp role explicitly', async () => {
    const s = setup({
      admission: {
        ok: true,
        organizationId: 'org-1',
        role: 'owner',
        permissionVersion: 1,
      },
    });
    const result = await s.orchestrator.run(request({
      admission: {
        kind: 'beta-approval',
        approvalId: 'approval-1',
        organizationId: 'org-1',
        approvedEmail: 'MEMBER@example.com',
        role: 'owner',
      },
    }));
    expect(result).toMatchObject({ ok: true, state: { role: 'owner', permissionVersion: 1 } });
  });
});
