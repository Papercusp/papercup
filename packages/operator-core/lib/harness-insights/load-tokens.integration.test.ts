import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT, type CloudTelemetryConsent } from '../telemetry-kinds';
import { deliverCloudTelemetry } from '../cloud-telemetry';
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

it('exports only a complete selected-runtime window, rechecks revocation, and keeps local reads available', async () => {
  const exportWorkspace = `local-export-${randomUUID()}`;
  const exportHarness = 'customer-runtime';
  const userId = randomUUID(), organizationId = randomUUID(), selectedWorkspaceId = exportWorkspace;
  const principal = createHostedPrincipal({ workspaceId: 'control-plane', userId, activeOrganizationId: organizationId,
    selectedWorkspaceId, sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:operate'] });
  const end = Date.now(), since = new Date(end - 1_000).toISOString();
  await db.adminSql`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, harness_slug, ts, bucket_key, provider, model_class, source,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_source)
    VALUES (${exportWorkspace}, ${exportHarness}, ${end - 100}, 'local', 'openai', 'known', 'jsonl',
      11, 7, 3, 2, 0.04, 'provider')
  `;
  let currentConsent: CloudTelemetryConsent = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT,
    diagnostics: { enabled: true, since } };
  let authorizations = 0;
  const authorize = async () => { authorizations += 1;
    return { ok: true as const, principal, monitoringConsent: currentConsent }; };
  const sent: unknown[] = [];
  const result = await exportCustomerUsageDiagnostics(
    { operation_id: randomUUID(), window_ms: 24 * 60 * 60 * 1000 },
    { workspaceId: exportWorkspace, harnessSlug: exportHarness, organizationId, controlPlaneWorkspaceId: 'control-plane',
      authorize, now: () => end,
      runtime: { environment: 'staging', release: 'abcdef12' },
      runQuery: async <T>(query: string, params: unknown[]) => await db.adminSql.unsafe(query, params as never) as unknown as T[],
      deliver: (event, context, readConsent) => deliverCloudTelemetry(event, context, { readConsent,
        send: async envelope => { sent.push(envelope); } }),
    },
  );
  expect(result).toEqual({ delivered: true });
  expect(authorizations).toBe(2);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ event: 'cloud_diagnostic_aggregate', properties: {
    calls: 1, input_tokens: 11, output_tokens: 7, cache_read_tokens: 3, cache_creation_tokens: 2,
    source: 'customer-runtime', period_start: since, period_end: new Date(end).toISOString(),
  } });
  currentConsent = DEFAULT_CLOUD_TELEMETRY_CONSENT;
  const revoked = await exportCustomerUsageDiagnostics(
    { operation_id: randomUUID(), window_ms: 24 * 60 * 60 * 1000 },
    { workspaceId: exportWorkspace, harnessSlug: exportHarness, organizationId, controlPlaneWorkspaceId: 'control-plane',
      authorize, now: () => end, runtime: { environment: 'staging', release: 'abcdef12' },
      runQuery: async <T>(query: string, params: unknown[]) => await db.adminSql.unsafe(query, params as never) as unknown as T[],
      deliver: (event, context, readConsent) => deliverCloudTelemetry(event, context, { readConsent,
        send: async envelope => { sent.push(envelope); } }),
    },
  );
  expect(revoked).toEqual({ delivered: false, code: 'consent_disabled' });
  const local = await loadHarnessTokens({ workspace_id: exportWorkspace, harness_slug: exportHarness, windowMs: 60000,
    runQuery: async <T>(query: string, params: unknown[]) => await db.adminSql.unsafe(query, params as never) as unknown as T[] });
  expect(local.observation).toBe('observed');
  expect(local.totals).toMatchObject({ runs: 1, tokens: 23 });
  expect(sent).toHaveLength(1);
});
