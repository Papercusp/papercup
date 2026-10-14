import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from '../telemetry-kinds';
import { deliverCloudTelemetry, readCloudTelemetryConsent, writeCloudTelemetryConsent, type CloudTelemetryEnvelope } from '../cloud-telemetry';
import { exportCustomerUsageDiagnostics, loadHarnessTokens } from './load-tokens';

let db: OrgTestDb;
const workspace = `local-usage-${randomUUID()}`;
const harness = 'customer-runtime';
beforeAll(async () => { db = await createOrgTestDb(); });
afterAll(async () => { await db?.cleanup(); });

it('reads scoped local per-call usage with honest costs independently of analytics consent', async () => {
  const now = Date.now();
  await db.adminSql`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, harness_slug, ts, bucket_key, provider, model_class, source,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_source)
    VALUES
      (${workspace}, ${harness}, ${now}, 'local', 'openai', 'known', 'jsonl', 100, 20, 50, 5, 0.2, 'provider'),
      (${workspace}, ${harness}, ${now - 1}, 'local', 'openai', 'known', 'jsonl', 200, 30, 60, 6, 0.1, 'estimated'),
      (${workspace}, ${harness}, ${now - 2}, 'local', 'other', 'unknown', 'jsonl', NULL, 40, 0, NULL, NULL, NULL),
      (${workspace}, ${harness}, ${now - 3}, 'local', 'other', 'unknown', 'jsonl', 10, 10, 0, 0, 999, NULL),
      (${workspace + '-other'}, ${harness}, ${now}, 'private-other', 'openai', 'known', 'jsonl', 99999, 99999, 99999, 99999, 99999, 'provider'),
      (${workspace}, 'different-harness', ${now}, 'private-other', 'openai', 'known', 'jsonl', 99999, 99999, 99999, 99999, 99999, 'provider')
  `;
  const read = () => loadHarnessTokens({ workspace_id: workspace, harness_slug: harness, windowMs: 60000,
    runQuery: async <T>(query: string, params: unknown[]) => await db.adminSql.unsafe(query, params as never) as unknown as T[],
  });
  const snapshot = await read();
  expect(snapshot.observation).toBe('observed');
  expect(snapshot.totals).toMatchObject({ runs: 4, tokens: 531, reportedUsd: 0.2, estimatedUsd: 0.1, unpricedCalls: 2 });
  expect(snapshot.totals.costUsd).toBeCloseTo(0.3);
  expect(snapshot.recentCalls).toHaveLength(4);
  expect(snapshot.recentCalls?.map(row => row.costSource)).toEqual(['provider', 'estimated', 'unknown', 'unknown']);
  expect(snapshot.recentCalls?.[2]).toMatchObject({ inputTokens: null, cacheCreationTokens: null, costUsd: null });
  expect(snapshot.recentCalls?.[3].costUsd).toBeNull();
  expect(snapshot.byModel.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(0.3);
  // No hosted preferences or analytics sender exists in this fixture. A local
  // read is still available, and never uses consent as authority to read usage.
  expect((await read()).totals).toEqual(snapshot.totals);
  const empty = await loadHarnessTokens({ workspace_id: workspace + '-absent', harness_slug: harness,
    runQuery: async <T>(query: string, params: unknown[]) => await db.adminSql.unsafe(query, params as never) as unknown as T[],
  });
  expect(empty.observation).toBe('observed');
  expect(empty.totals.runs).toBe(0);
});

async function exportFixture() {
  const exportWorkspace = `local-export-${randomUUID()}`;
  const exportHarness = 'customer-runtime';
  const userId = randomUUID(), organizationId = randomUUID(), selectedWorkspaceId = exportWorkspace;
  const principal = createHostedPrincipal({ workspaceId: 'control-plane', userId, activeOrganizationId: organizationId,
    selectedWorkspaceId, sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:operate'] });
  const scoped = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => await db.adminSql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    await tx.unsafe('SET LOCAL ROLE hosted_app');
    await tx`SELECT set_config('app.organization_id', ${organizationId}, true), set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  }) as T;
  const choice = (diagnostics: boolean) => scoped(tx => writeCloudTelemetryConsent(tx, principal, {
    disclosure_version: DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version, diagnostics }));
  let authorizations = 0;
  const authorize = async () => { authorizations += 1;
    return { ok: true as const, principal, monitoringConsent: await scoped(tx => readCloudTelemetryConsent(tx, principal)) }; };
  const sent: CloudTelemetryEnvelope[] = [];
  const opts: Parameters<typeof exportCustomerUsageDiagnostics>[1] = {
      workspaceId: exportWorkspace, harnessSlug: exportHarness, organizationId, controlPlaneWorkspaceId: 'control-plane',
      authorize,
      runtime: { environment: 'staging', release: process.env.PAPERCUSP_TEST_BUILD_SHA?.slice(0, 40) ?? 'abcdef12', synthetic: true },
      runQuery: async <T>(query: string, params: unknown[]) => await db.adminSql.unsafe(query, params as never) as unknown as T[],
      deliver: (event, context, readConsent) => deliverCloudTelemetry(event, context, { readConsent,
        send: async envelope => { sent.push(envelope); } }),
  };
  const input = (operation_id = randomUUID()) => ({ operation_id, window_ms: 24 * 60 * 60 * 1000 });
  const seed = async (since: string) => {
    const start = Date.parse(since);
    await db.adminSql`
      INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, harness_slug, ts, bucket_key, provider, model_class, source,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_source)
      VALUES
        (${exportWorkspace}, ${exportHarness}, ${start}, 'local', 'openai', 'known', 'jsonl', 11, 7, 3, 2, 0.04, 'provider'),
        (${exportWorkspace}, ${exportHarness}, ${start - 1}, 'pre-consent', 'openai', 'known', 'jsonl', 9000, 9000, 9000, 9000, 9000, 'provider'),
        (${exportWorkspace}, ${exportHarness}, ${start + 86400000}, 'future', 'openai', 'known', 'jsonl', 9000, 9000, 9000, 9000, 9000, 'provider'),
        (${exportWorkspace + '-other'}, ${exportHarness}, ${start}, 'foreign', 'openai', 'known', 'jsonl', 9000, 9000, 9000, 9000, 9000, 'provider'),
        (${exportWorkspace}, 'other-harness', ${start}, 'foreign', 'openai', 'known', 'jsonl', 9000, 9000, 9000, 9000, 9000, 'provider')
    `;
  };
  const local = () => loadHarnessTokens({ workspace_id: exportWorkspace, harness_slug: exportHarness,
    windowMs: 60000, runQuery: opts.runQuery });
  return { opts, input, choice, seed, local, sent, principal, authorizations: () => authorizations };
}

it('exports only a complete selected-runtime window, rechecks revocation, and keeps local reads available', async () => {
  const f = await exportFixture();
  expect(await exportCustomerUsageDiagnostics(f.input(), f.opts)).toEqual({ delivered: false, code: 'consent_disabled' });
  const grant = await f.choice(true);
  await f.seed(grant.diagnostics.since!);
  const result = await exportCustomerUsageDiagnostics(f.input(), f.opts);
  expect(result).toEqual({ delivered: true });
  expect(f.authorizations()).toBe(3);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ event: 'cloud_diagnostic_aggregate', properties: {
    calls: 1, input_tokens: 11, output_tokens: 7, cache_read_tokens: 3, cache_creation_tokens: 2,
    source: 'customer-runtime', period_start: grant.diagnostics.since,
  } });
  await f.choice(false);
  const revoked = await exportCustomerUsageDiagnostics(f.input(), f.opts);
  expect(revoked).toEqual({ delivered: false, code: 'consent_disabled' });
  const local = await f.local();
  expect(local.observation).toBe('observed');
  expect(local.totals).toMatchObject({ runs: 2, tokens: 36023 });
  expect(f.sent).toHaveLength(1);
  const renewed = await f.choice(true);
  expect(Date.parse(renewed.diagnostics.since!)).toBeGreaterThan(Date.parse(grant.diagnostics.since!));
  expect(await exportCustomerUsageDiagnostics(f.input(), f.opts)).toEqual({ delivered: true });
  expect(f.sent[1]).toMatchObject({ properties: { calls: 0, input_tokens: 0, period_start: renewed.diagnostics.since } });
  const late = { ...f.opts, runQuery: async <T>(query: string, params: unknown[]) => {
    const rows = await f.opts.runQuery<T>(query, params);
    if (query.includes('SELECT COUNT(*)')) await f.choice(false);
    return rows;
  } };
  expect((await exportCustomerUsageDiagnostics(f.input(), late)).delivered).toBe(false);
  expect(f.sent).toHaveLength(2);
  expect((await f.local()).totals).toEqual(local.totals);
});

it.runIf(process.env.PAPERCUSP_TEST_POSTHOG_LIVE === 'true')('witnesses actual PostHog ingestion of local ledger aggregate beside default, revoked and hostile-request absence', async () => {
  const { getPosthogConfigWithSource } = await import('../posthog-config');
  const config = getPosthogConfigWithSource().config;
  if (!config?.personalApiKey) throw new Error('posthog_query_credentials_required');
  const origin = new URL(config.host).origin;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${config.personalApiKey}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200); return response.json();
  };
  const projects = await request('/api/projects/');
  const project = projects.results.find((row: { api_token: string }) => row.api_token === config.projectKey);
  expect(project).toBeDefined();
  expect((await request(`/api/projects/${project.id}/query/`, { refresh: 'force_blocking',
    query: { kind: 'HogQLQuery', query: 'SELECT 1' } })).results).toEqual([[1]]);
  const f = await exportFixture(), opts = { ...f.opts, deliver: undefined };
  const off = f.input(), positive = f.input(), revoked = f.input(), hostile = f.input();
  const windowStart = new Date(Date.now() - 1000).toISOString();
  expect(await exportCustomerUsageDiagnostics(off, opts)).toMatchObject({ delivered: false, code: 'consent_disabled' });
  const grant = await f.choice(true); await f.seed(grant.diagnostics.since!);
  expect(await exportCustomerUsageDiagnostics(positive, opts)).toEqual({ delivered: true });
  expect(await exportCustomerUsageDiagnostics({ ...hostile, calls: 999, destination: 'https://invalid.example' }, opts))
    .toMatchObject({ delivered: false, code: 'invalid_export_request' });
  await f.choice(false);
  expect(await exportCustomerUsageDiagnostics(revoked, opts)).toMatchObject({ delivered: false, code: 'consent_disabled' });
  expect((await f.local()).totals).toMatchObject({ runs: 2, tokens: 36023 });
  const opaque = (id: string) => createHash('sha256').update(JSON.stringify(['papercusp-cloud-v1', 'operation',
    'staging', f.principal.activeOrganizationId, id])).digest('hex');
  const operations = [off, positive, revoked, hostile].map(value => opaque(value.operation_id));
  const windowEnd = new Date(Date.now() + 1000).toISOString();
  const query = `SELECT properties.operation_id, distinct_id, properties.organization_id, properties.workspace_id, uuid, properties.calls, properties.input_tokens, properties.output_tokens, properties.cache_read_tokens, properties.cache_creation_tokens, properties.provider_cost_usd, properties.period_start, properties.period_end, properties.source, properties.synthetic FROM events WHERE event = 'cloud_diagnostic_aggregate' AND timestamp >= parseDateTimeBestEffort('${windowStart}') AND timestamp <= parseDateTimeBestEffort('${windowEnd}') AND properties.operation_id IN (${operations.map(id => `'${id}'`).join(',')})`;
  let receipt: { results: unknown[][]; is_cached: boolean } | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    receipt = await request(`/api/projects/${project.id}/query/`, { refresh: 'force_blocking', query: { kind: 'HogQLQuery', query } });
    expect(receipt!.is_cached).toBe(false);
    if (receipt!.results.some(row => row[0] === operations[1])) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  expect(receipt!.results.map(row => row[0])).toEqual([operations[1]]);
  expect(receipt!.results[0]!.slice(5, 11).map(Number)).toEqual([1, 11, 7, 3, 2, 0.04]);
  for (const index of [1, 2, 3]) expect(receipt!.results[0]![index]).toMatch(/^[a-f0-9]{64}$/);
  for (const raw of [f.principal.userId, f.principal.activeOrganizationId, f.principal.selectedWorkspaceId!, f.principal.sessionId])
    expect(JSON.stringify(receipt)).not.toContain(raw);
  console.info('CUSTOMER_USAGE_EXPORT_POSTHOG_RECEIPT', JSON.stringify({ projectId: project.id, windowStart, windowEnd,
    query, result: receipt, approvedOperations: [operations[1]], excludedOperations: [operations[0], ...operations.slice(2)],
    grantEpoch: grant.diagnostics.since, localContinuity: { calls: 2, tokens: 36023 } }));
}, 90_000);
