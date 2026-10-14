/** Redacted browser crash reports must survive the real operator-state PG
 * write path before the hourly archive flush. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createHostedPrincipal } from './auth/hosted-principal';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from './telemetry-kinds';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const { readOperatorState } = await import('./operator-state-pg');
const { recordTelemetryReport, readCloudTelemetryConsent, writeCloudTelemetryConsent, deliverCloudTelemetry, prepareCloudTelemetryDelivery, safeCloudError } = await import('./record-telemetry');
const { normalizeRenderCrashPayload } = await import('./endpoint-route/routes/desktop/telemetry-report');

const WS = 'ws-redacted-render-crash-persistence';

describe('redacted render crash persistence (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
  }, 120_000);

  afterAll(async () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    await db?.cleanup();
  });

  it('stores the server-normalized report in the existing workspace-scoped ring', async () => {
    const payload = normalizeRenderCrashPayload({
      source: 'render-boundary', boundary: 'adv-tab', errorType: 'TypeError',
      component: 'LearningTab', tab: 'learning', message: 'secret-token=abc',
      stack: 'private stack', url: 'https://example.invalid/?secret-token=abc',
    });
    expect(payload).toMatchObject({ fingerprint: 'adv-tab:TypeError:LearningTab:learning' });
    await recordTelemetryReport({
      kind: 'crash', payload,
      receivedAt: '2026-09-25T18:00:00Z',
    });
    const ring = await readOperatorState<{ reports: Array<{ kind: string; payload: unknown }> }>('telemetry_reports');
    expect(ring?.reports).toHaveLength(1);
    expect(ring?.reports[0]).toMatchObject({ kind: 'crash', payload });
    const rows = await db.adminSql<Array<{ payload: { reports: unknown[] } }>>`
      SELECT payload FROM harness_shared.telemetry_reports WHERE workspace_id = ${WS}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.reports).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('secret-token');
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('https://');
  });

  it('uses persisted current tenant consent and keeps hostile/default/revoked exports out of the sink', async () => {
    const organizationA = randomUUID(), organizationB = randomUUID(), userA = randomUUID(), userB = randomUUID();
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: organizationA,
      userId: userA, selectedWorkspaceId: 'customer-a', sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:view'] });
    const scoped = async <T>(organization: string, user: string, fn: (tx: Sql) => Promise<T>) =>
      await db.adminSql.begin(async transaction => {
        const tx = transaction as unknown as Sql;
        await tx.unsafe('SET LOCAL ROLE hosted_app');
        await tx`SELECT set_config('app.organization_id', ${organization}, true), set_config('app.user_id', ${user}, true)`;
        return fn(tx);
      }) as T;
    const readConsent = () => scoped(organizationA, userA, tx => readCloudTelemetryConsent(tx, principal));
    const enabled = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT,
      analytics: { enabled: true, since: '2026-10-13T12:00:00Z' },
      diagnostics: { enabled: true, since: '2026-10-13T12:00:00Z' } };
    const save = (consent: unknown) => scoped(organizationA, userA, tx => tx`
      INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id, profile)
      VALUES (${organizationA}::uuid, ${userA}::uuid, ${JSON.stringify({ cloudMonitoring: consent, displayName: 'keep-local' })}::jsonb)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET profile = EXCLUDED.profile`);
    const context = { principal, environment: 'staging' as const, release: 'abcdef1234567', origin: 'portal' as const,
      hostingMode: 'byoc' as const, observedAt: '2026-10-13T13:00:00Z' };
    const event = { event: 'cloud_portal_session', operation_id: randomUUID(), properties: { action: 'signed_in' } };
    const send = vi.fn(async () => {});
    expect(await deliverCloudTelemetry(event, context, { readConsent, send })).toMatchObject({ delivered: false });
    expect(send).not.toHaveBeenCalled();
    await save(enabled);
    expect(await deliverCloudTelemetry(event, context, { readConsent, send })).toEqual({ delivered: true });
    expect(send).toHaveBeenCalledTimes(1); // same-sink positive control
    await expect(scoped(organizationB, userB, tx => readCloudTelemetryConsent(tx, principal))).rejects.toThrow('cloud_telemetry_scope_mismatch');
    const hidden = await scoped(organizationB, userB, tx => tx`
      SELECT profile FROM papercusp_auth.hosted_user_preferences WHERE organization_id = ${organizationA}::uuid AND user_id = ${userA}::uuid`);
    expect(hidden).toHaveLength(0);
    const aggregate = { event: 'cloud_diagnostic_aggregate', operation_id: randomUUID(), properties: {
      period_start: '2026-10-13T12:00:00Z', period_end: '2026-10-13T13:00:00Z', calls: 1,
      input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0,
      provider_cost_usd: null, estimated_cost_usd: 0.01, unpriced_calls: 0 } };
    const local = { ...context, origin: 'customer-runtime' as const };
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent, send })).toEqual({ delivered: true });
    expect(await deliverCloudTelemetry({ ...aggregate, properties: { ...aggregate.properties, account_id: 'secret', rlResetAt: 12 } }, local,
      { readConsent, send })).toMatchObject({ delivered: false, code: 'invalid_cloud_event' });
    await save({ ...enabled, diagnostics: { enabled: false, since: null } });
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent, send })).toMatchObject({ delivered: false, code: 'consent_disabled' });
    await save({ ...enabled, diagnostics: { enabled: true, since: '2026-10-13T12:30:00Z' } });
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent, send })).toMatchObject({ delivered: false, code: 'outside_consent_epoch' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/secret|keep-local/);
  });

  it('persists only authenticated consent choices, preserves preferences and rotates revoked epochs', async () => {
    const organization = randomUUID(), user = randomUUID();
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: organization,
      userId: user, sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:view'] });
    const scoped = async <T>(fn: (tx: Sql) => Promise<T>, scope = organization) =>
      await db.adminSql.begin(async transaction => {
        const tx = transaction as unknown as Sql;
        await tx.unsafe('SET LOCAL ROLE hosted_app');
        await tx`SELECT set_config('app.organization_id', ${scope}, true), set_config('app.user_id', ${user}, true)`;
        return fn(tx);
      }) as T;
    await scoped(tx => tx`INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id, profile)
      VALUES (${organization}::uuid, ${user}::uuid, '{"displayName":"private-profile"}'::jsonb)`);
    const disclosure_version = DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version;
    const granted = await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: true }));
    expect(granted.analytics.enabled).toBe(true);
    expect(Number.isFinite(Date.parse(granted.analytics.since!))).toBe(true);
    expect(granted.diagnostics.enabled).toBe(false);
    const unchanged = await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: true }));
    expect(unchanged.analytics.since).toBe(granted.analytics.since);
    await expect(scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, diagnostics: true }), randomUUID()))
      .rejects.toThrow('cloud_telemetry_scope_mismatch');
    await expect(scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: true, since: '2000-01-01T00:00:00Z' })))
      .rejects.toThrow();
    const revoked = await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: false }));
    expect(revoked.analytics).toEqual({ enabled: false, since: null });
    const renewed = await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: true }));
    expect(Date.parse(renewed.analytics.since!)).toBeGreaterThan(Date.parse(granted.analytics.since!));
    const [row] = await scoped(tx => tx<{ profile: { displayName: string } }[]>`
      SELECT profile FROM papercusp_auth.hosted_user_preferences WHERE organization_id = ${organization}::uuid AND user_id = ${user}::uuid`);
    expect(row.profile.displayName).toBe('private-profile');
    const send = vi.fn(async () => {});
    const context = { principal, environment: 'staging' as const, release: 'abcdef1234567', origin: 'portal' as const, hostingMode: 'byoc' as const };
    const event = { event: 'cloud_error', operation_id: randomUUID(), properties: safeCloudError('render_failure', new TypeError('private-profile')) };
    expect(await deliverCloudTelemetry(event, context, { readConsent: () => scoped(tx => readCloudTelemetryConsent(tx, principal)), send }))
      .toEqual({ delivered: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain('private-profile');
    expect(await deliverCloudTelemetry({ ...event, properties: { ...event.properties, message: 'private-profile' } }, context,
      { readConsent: () => scoped(tx => readCloudTelemetryConsent(tx, principal)), send })).toMatchObject({ delivered: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.env.PAPERCUSP_TEST_POSTHOG_LIVE === 'true')('confirms synthetic opt-in ingestion and absent default/hostile/revoked exports in configured PostHog', async () => {
    const { getPosthogConfigWithSource } = await import('./posthog-config');
    const { deliverCloudPosthog, readCloudCaptureHealth } = await import('./telemetry-flush');
    const config = getPosthogConfigWithSource().config;
    expect(config).not.toBeNull();
    if (!config) throw new Error('configured PostHog required');
    expect(await readCloudCaptureHealth(), 'PostHog capture ingress must be available before measuring privacy').toEqual({ healthy: true, status: 400 });
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(config.host.replace(/\/+$/, '') + path, { headers: {
        authorization: `Bearer ${config.personalApiKey}`, 'content-type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
      expect(response.status, `PostHog ${path} request`).toBe(200);
      return response.json();
    };
    const projects = await request('/api/projects/');
    const project = projects.results.find((value: { api_token: string }) => value.api_token === config.projectKey);
    expect(project).toBeDefined();
    const probe = await request(`/api/projects/${project.id}/query/`, { refresh: 'force_blocking', query: { kind: 'HogQLQuery', query: 'SELECT 1' } });
    expect(probe.results, 'query permission preflight').toEqual([[1]]);
    const organization = randomUUID(), user = randomUUID();
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: organization,
      userId: user, selectedWorkspaceId: randomUUID(), sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:view'] });
    const scoped = async <T>(fn: (tx: Sql) => Promise<T>) => await db.adminSql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx.unsafe('SET LOCAL ROLE hosted_app');
      await tx`SELECT set_config('app.organization_id', ${organization}, true), set_config('app.user_id', ${user}, true)`;
      return fn(tx);
    }) as T;
    const readConsent = () => scoped(tx => readCloudTelemetryConsent(tx, principal));
    const context = { principal, environment: 'staging' as const, release: process.env.PAPERCUSP_TEST_BUILD_SHA?.slice(0,40) ?? 'abcdef1234567',
      origin: 'customer-runtime' as const, hostingMode: 'byoc' as const, synthetic: true };
    const make = () => ({ event: 'cloud_diagnostic_aggregate', operation_id: randomUUID(), properties: {
      period_start: new Date().toISOString(), period_end: new Date().toISOString(), calls: 1,
      input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0,
      provider_cost_usd: null, estimated_cost_usd: 0.01, unpriced_calls: 0 } });
    const defaultEvent = make();
    expect(await deliverCloudPosthog(defaultEvent, context, readConsent)).toMatchObject({ delivered: false, code: 'consent_disabled' });
    const granted = await scoped(tx => writeCloudTelemetryConsent(tx, principal, {
      disclosure_version: DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version, diagnostics: true }));
    const positive = make(), hostile = make(), revoked = make();
    const identities = [defaultEvent, positive, hostile, revoked].map(event => {
      const prepared = prepareCloudTelemetryDelivery(event, context, { ...granted, diagnostics: { enabled: true, since: '2000-01-01T00:00:00Z' } });
      if (!prepared.ok) throw new Error('synthetic identity preparation failed');
      return prepared.envelope.properties.operation_id;
    });
    expect(await deliverCloudPosthog(positive, context, readConsent)).toEqual({ delivered: true });
    expect(await deliverCloudPosthog({ ...hostile, properties: { ...hostile.properties, prompt: 'synthetic-forbidden-field' } }, context, readConsent))
      .toMatchObject({ delivered: false, code: 'invalid_cloud_event' });
    await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version: granted.disclosure_version, diagnostics: false }));
    expect(await deliverCloudPosthog(revoked, context, readConsent)).toMatchObject({ delivered: false, code: 'consent_disabled' });
    const query = `SELECT properties.operation_id, count() FROM events WHERE event = 'cloud_diagnostic_aggregate' AND properties.operation_id IN (${identities.map(id => `'${id}'`).join(',')}) GROUP BY properties.operation_id`;
    let rows: Array<[string, number]> = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await request(`/api/projects/${project.id}/query/`, { refresh: 'force_blocking', query: { kind: 'HogQLQuery', query } });
      expect(result.is_cached, 'privacy ingestion proof must use a fresh query').toBe(false);
      rows = result.results;
      if (rows.some(([id]) => id === identities[1])) break;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    expect(rows).toEqual([[identities[1], 1]]);
  }, 90_000);
});
