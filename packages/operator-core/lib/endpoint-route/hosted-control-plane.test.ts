import { describe, expect, it } from 'vitest';
import type { HostedIdentityDirectory } from '../auth/hosted-identity-binding';
import { toAuthority, type HostedMembershipAuthorityReader } from '../auth/hosted-membership-authority';
import { type CreateHostedSessionInput, type HostedSession } from '../auth/hosted-session';
import { createFakeHostedIdentityProvider, FAKE_HOSTED_IDENTITY_NOW_MS } from '../auth/hosted/fake-provider';
import { HOSTED_AUTH_CALLBACK_PATH, HOSTED_AUTH_FLOW_COOKIE } from './routes/hosted-auth';
import type { HostedAuthFlow, HostedAuthFlowConsumeResult, HostedAuthFlowStore } from './routes/hosted-auth/flow';
import { assembleHostedControlPlane } from './hosted-control-plane';

const ORIGIN = 'https://app.papercusp.com';
const NOW = new Date(FAKE_HOSTED_IDENTITY_NOW_MS);
const COOKIE_SECRET = 'hosted-control-plane-test-cookie-secret-is-at-least-32-bytes';
const SESSION_ID = `hs_${'A'.repeat(43)}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTROL_PLANE_WORKSPACE_ID = 'hosted-control-plane';
const MEMBERSHIP_UPDATED_AT = new Date('2026-08-27T12:00:00.000Z');

class MemoryFlowStore implements HostedAuthFlowStore {
  readonly flows = new Map<string, HostedAuthFlow>();
  private next = 1;

  async create(flow: HostedAuthFlow): Promise<string> {
    const state = `state-${this.next++}`;
    this.flows.set(state, flow);
    return state;
  }

  async consume(state: string): Promise<HostedAuthFlowConsumeResult> {
    const flow = this.flows.get(state);
    if (!flow) return { ok: false, error: 'already-consumed' };
    this.flows.delete(state);
    return { ok: true, flow };
  }
}

class MemorySessionStore {
  readonly created: CreateHostedSessionInput[] = [];
  readonly revoked: Array<{ id: string; reason: string }> = [];
  current: HostedSession | null = null;

  async create(input: CreateHostedSessionInput): Promise<HostedSession> {
    this.created.push(input);
    this.current = {
      id: SESSION_ID,
      userId: input.userId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId ?? null,
      permissionVersion: input.permissionVersion,
      upstreamProvider: input.upstreamProvider,
      upstreamSessionId: input.upstreamSessionId,
      createdAt: NOW,
      rotatedAt: null,
      expiresAt: input.expiresAt,
      lastSeenAt: null,
      revokedAt: null,
      revocationReason: null,
      updatedAt: NOW,
    };
    return this.current;
  }

  async resolve(id: string): Promise<HostedSession | null> {
    return id === this.current?.id && this.current.revokedAt === null ? this.current : null;
  }

  async revoke(id: string, reason = 'logout', at = NOW): Promise<boolean> {
    if (id !== this.current?.id || this.current.revokedAt !== null) return false;
    this.revoked.push({ id, reason });
    this.current = { ...this.current, revokedAt: at, revocationReason: reason };
    return true;
  }
}

function fixedEntropy(): (size: number) => Uint8Array {
  let value = 1;
  return (size) => new Uint8Array(size).fill(value++);
}

function responseCookieValue(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${name}=([^;,]+)`));
  if (!match) throw new Error(`missing response cookie ${name}: ${header}`);
  return decodeURIComponent(match[1]);
}

describe('assembleHostedControlPlane', () => {
  it('shares one authority, session store, and cookie codec from mint through first request', async () => {
    const membership = toAuthority({
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      role: 'admin',
      status: 'active',
      updated_at: MEMBERSHIP_UPDATED_AT,
    });
    if (!membership) throw new Error('test membership must be authoritative');

    const authorityCalls: Array<{ userId: string; organizationId: string }> = [];
    const membershipAuthority: HostedMembershipAuthorityReader = {
      async resolveActive(input) {
        authorityCalls.push(input);
        return membership;
      },
      async workspaceBelongsToOrganization() {
        return true;
      },
    };
    const identityDirectory: HostedIdentityDirectory = {
      async resolveLinkedUser() {
        return { userId: USER_ID };
      },
      async resolveOrganization() {
        return { organizationId: ORGANIZATION_ID };
      },
      async listActiveOrganizationIds() {
        return [ORGANIZATION_ID];
      },
    };
    const sessionStore = new MemorySessionStore();
    const flowStore = new MemoryFlowStore();
    const provider = createFakeHostedIdentityProvider();

    const plane = assembleHostedControlPlane({
      provider,
      publicOrigin: ORIGIN,
      sessionCookieSecret: COOKIE_SECRET,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE_ID,
      sessionStore,
      membershipAuthority,
      identityDirectory,
      flowStore,
      clock: () => NOW,
      randomBytes: fixedEntropy(),
    });

    expect(plane.components.sessionStore).toBe(sessionStore);
    expect(plane.components.membershipAuthority).toBe(membershipAuthority);
    expect(plane.components.identityDirectory).toBe(identityDirectory);
    expect(plane.mounted.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /health',
      'GET /health/ready',
      'GET /hosted/auth/sign-in',
      'GET /hosted/auth/callback',
      'POST /hosted/auth/logout',
      'GET /hosted/auth/session',
    ]);

    const signIn = await plane.app.request(`/api/hosted/auth/sign-in?returnTo=${encodeURIComponent('/workspaces')}`);
    expect(signIn.status).toBe(302);
    const state = new URL(signIn.headers.get('location') ?? '').searchParams.get('state');
    expect(state).toBeTruthy();
    const flowCookie = responseCookieValue(signIn, HOSTED_AUTH_FLOW_COOKIE);

    const callback = await plane.app.request(
      `/api/hosted/auth/callback?code=code-1&state=${encodeURIComponent(state ?? '')}`,
      {
        headers: {
          cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(flowCookie)}`,
        },
      },
    );
    expect(callback.status).toBe(303);
    const sessionCookie = responseCookieValue(callback, '__Host-papercusp_session');
    expect(sessionStore.created).toHaveLength(1);
    expect(sessionStore.created[0]).toMatchObject({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      workspaceId: null,
      permissionVersion: membership.permissionVersion,
      upstreamProvider: provider.providerId,
      upstreamSessionId: 'session_test_001',
    });

    const firstAuthenticatedRequest = await plane.app.request('/api/hosted/auth/session', {
      headers: {
        cookie: `__Host-papercusp_session=${encodeURIComponent(sessionCookie)}`,
      },
    });
    expect(firstAuthenticatedRequest.status).toBe(200);
    expect(await firstAuthenticatedRequest.json()).toMatchObject({
      ok: true,
      session: {
        sessionId: SESSION_ID,
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        workspaceId: null,
        permissionVersion: membership.permissionVersion,
      },
    });

    // One call minted the snapshot; the second re-derived it during the very
    // first authenticated request. A second authority instance/store/codec on
    // either side makes this route fail even though the callback succeeded.
    expect(authorityCalls).toEqual([
      { userId: USER_ID, organizationId: ORGANIZATION_ID },
      { userId: USER_ID, organizationId: ORGANIZATION_ID },
    ]);
  });

  it('refuses an empty control-plane workspace at boot', () => {
    expect(() =>
      assembleHostedControlPlane({
        provider: createFakeHostedIdentityProvider(),
        publicOrigin: ORIGIN,
        sessionCookieSecret: COOKIE_SECRET,
        controlPlaneWorkspaceId: '  ',
      }),
    ).toThrow('hosted_control_plane_requires_a_control_plane_workspace_id');
  });
});
