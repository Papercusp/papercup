/** P-537: the production callback composes real identity, session and trial stores. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createFakeHostedIdentityProvider } from '../auth/hosted/fake-provider';
import type { HostedIdentityProvider } from '../auth/hosted/provider';
import { PostgresHostedSelfSignupAdmission, HOSTED_SELF_SIGNUP_TERMS_VERSION,
  HOSTED_SELF_SIGNUP_PRIVACY_VERSION } from '../auth/hosted/self-signup';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import { readHostedEntitlementAuthority, writeHostedEntitlementAuthority,
  type HostedTrialEntitlementPolicy } from '../auth/hosted-entitlement-store';
import { createHostedAuthRuntime } from './hosted-auth-runtime';
import type { HostedAuthFlow, HostedAuthFlowConsumeResult } from './routes/hosted-auth/flow';
import { HOSTED_AUTH_FLOW_COOKIE } from './routes/hosted-auth';
import { HOSTED_SESSION_COOKIE } from '../auth/hosted-session';

const h = vi.hoisted(() => ({ provider: undefined as unknown as HostedIdentityProvider }));
// Replace the upstream IdP and OAuth nonce storage only. The actual callback,
// membership binder, hosted roles, session persistence and entitlement store run.
vi.mock('../auth/hosted/workos-provider', () => ({ createWorkOSHostedIdentityProvider: () => h.provider }));
vi.mock('../cloud-telemetry-posthog', () => ({ deliverCloudPosthog: async () => undefined }));
vi.mock('./routes/hosted-auth/flow', () => ({
  OAuthHostedAuthFlowStore: class {
    private readonly flows = new Map<string, HostedAuthFlow>();
    async create(flow: HostedAuthFlow) { const id = randomUUID(); this.flows.set(id, flow); return id; }
    async consume(id: string): Promise<HostedAuthFlowConsumeResult> {
      const flow = this.flows.get(id); this.flows.delete(id);
      return flow ? { ok: true, flow } : { ok: false, error: 'already-consumed' };
    }
  },
}));

const configuration = {
  publicOrigin: 'https://app.papercusp.com', controlPlaneWorkspaceId: 'hosted-control-plane',
  hostedSessionCookieSecretRef: 'env:COOKIE', workosClientId: 'client-test',
  workosApiKeyRef: 'env:KEY', workosCookiePasswordRef: 'env:PASSWORD',
};
function policy(): HostedTrialEntitlementPolicy {
  return { assignmentDurationMs: 86_400_000, bundle: {
    schemaVersion: 1, bundleId: 'callback-trial-fixture', bundleVersion: 1,
    record: { source: 'trial', actor: { kind: 'service', principalId: 'service:trial-policy' },
      auditReceiptId: 'trial-policy:callback-fixture', effectiveFrom: new Date('2020-01-01'), effectiveUntil: null },
    entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 1 },
      browserAccess: { pty: true, files: true }, supportTier: 'trial',
      quotas: { 'pool.agents': 50, 'pool.hosts': 1, 'pool.cpu-millicores': 4000,
        'pool.memory-mib': 16384, 'pool.db-gib': 256, 'pool.workspace-gib': 100 },
      budgets: { 'pool.cost.usd.minor': 10000 }, rolloutFlags: {} },
  } };
}

describe('configured hosted authentication trial rollout (real PG)', () => {
  let db: OrgTestDb;
  const pending = new Set<Promise<unknown>>();
  const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
    const task = db.appSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1524-hosted-entitlement-authority.sql', import.meta.url), 'utf8'));
  }, 180_000);
  afterAll(async () => { await Promise.allSettled([...pending]); await db?.cleanup(); });

  async function fixture(trialEntitlementPolicy?: HostedTrialEntitlementPolicy) {
    const identity = { externalUserId: `callback-${randomUUID()}`, primaryEmail: `${randomUUID()}@example.test`,
      emailVerified: true as const, displayName: 'Callback Member' };
    const admitted = await new PostgresHostedSelfSignupAdmission(runService).complete({
      attemptId: randomUUID(), providerId: 'workos', identity, upstreamSessionId: randomUUID(),
      sessionExpiresAt: new Date(Date.now() + 3_600_000), acceptedAt: new Date(),
      termsVersion: HOSTED_SELF_SIGNUP_TERMS_VERSION, privacyVersion: HOSTED_SELF_SIGNUP_PRIVACY_VERSION,
    });
    if (!admitted.ok) throw new Error(`fixture admission failed: ${admitted.code}`);
    const createdAt = new Date(Date.now() - 3_600_000);
    await db.adminSql`UPDATE papercusp_auth.hosted_entitlements SET created_at = ${createdAt}
      WHERE organization_id = ${admitted.binding.organizationId}::uuid`;
    const provider = createFakeHostedIdentityProvider({ providerId: 'workos', nowMs: Date.now(),
      session: { externalSessionId: randomUUID(), identity, issuedAtMs: Date.now() - 1000,
        authenticatedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 3_600_000,
        authenticationMethods: ['pwd'], mfaVerified: false } });
    h.provider = provider;
    const runtime = await createHostedAuthRuntime({ ...configuration, trialEntitlementPolicy }, {
      runService, resolveSecret: async () => 'callback-fixture-cookie-secret-at-least-32-bytes',
    });
    async function callback(invalidState = false) {
      const start = await runtime.app.request('/api/hosted/auth/sign-in?returnTo=%2Fworkspaces');
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const cookie = start.headers.get('set-cookie')!.match(new RegExp(`${HOSTED_AUTH_FLOW_COOKIE}=([^;,]+)`))![1];
      const response = await runtime.app.request(`/api/hosted/auth/callback?code=valid&state=${invalidState ? randomUUID() : state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${cookie}` },
      });
      // onSessionEstablished is intentionally a nonblocking metadata observer.
      // Drain its actual service transaction, rather than assuming a redirect is proof.
      await Promise.all([...pending]);
      return response;
    }
    const stored = async () => (await db.adminSql`SELECT authority, authority_revision
      FROM papercusp_auth.hosted_entitlements WHERE organization_id = ${admitted.binding.organizationId}::uuid`)[0]!;
    return { ...admitted.binding, createdAt, callback, stored, provider, runtime };
  }

  it('backfills the authenticated organization from its original grant and never renews on sign-in', async () => {
    const f = await fixture(policy());
    const response = await f.callback();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://app.papercusp.com/workspaces');
    const cookie = response.headers.get('set-cookie')!.match(new RegExp(`${HOSTED_SESSION_COOKIE}=([^;,]+)`))![1];
    const sessionId = f.runtime.components.sessionCookieCodec.decode(decodeURIComponent(cookie));
    expect(sessionId).toMatch(/^hs_/);
    expect(await f.runtime.components.sessionStore.resolve(sessionId!))
      .toMatchObject({ userId: f.userId, organizationId: f.organizationId });
    const stored = await f.stored();
    expect(Number(stored.authority_revision)).toBe(1);
    expect(stored.authority.assignments[0]).toMatchObject({ organizationId: f.organizationId,
      record: { effectiveFrom: f.createdAt.toISOString(),
        effectiveUntil: new Date(f.createdAt.getTime() + 86_400_000).toISOString() } });
    expect(await runService(tx => readHostedEntitlementAuthority(tx, f.organizationId)))
      .toMatchObject({ ok: true, grantUserId: f.userId, resolution: { quotas: { 'pool.db-gib': 256, 'pool.agents': 50 } } });
    await f.callback();
    expect(await f.stored()).toEqual(stored);
    await writeHostedEntitlementAuthority({ organizationId: f.organizationId, userId: f.userId,
      kind: 'hosted-free', expectedRevision: 1, authority: null }, runService);
    await f.callback();
    expect(await f.stored()).toMatchObject({ authority: null, authority_revision: 2 });
  });

  it('does not grant allowances without server policy or before callback authentication', async () => {
    const unconfigured = await fixture();
    expect((await unconfigured.callback()).status).toBe(303);
    expect(await unconfigured.stored()).toMatchObject({ authority: null, authority_revision: 0 });
    const configured = await fixture(policy());
    const response = await configured.callback(true);
    expect(response.headers.get('location')).not.toBe('https://app.papercusp.com/workspaces');
    expect(configured.provider.calls.exchangeCallback).toHaveLength(0);
    expect(await configured.stored()).toMatchObject({ authority: null, authority_revision: 0 });
  });
});
