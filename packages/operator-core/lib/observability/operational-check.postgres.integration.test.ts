import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- mirror the production postgres-js JSON binder
import { restoreRawJsonbSerializer } from '../../../../libs/papercusp/libs/db/src/raw-serializers';

const fixture = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: fixture.sql! }) }));
vi.mock('../serving-host-identity', () => ({ getServingHostIdentity: () => ({
  host: 'port-3070', processId: 'release-test-process', buildSha: 'a'.repeat(40),
}) }));
const paths = [
  'packages/operator-core/lib/observability/runtime.ts',
  'packages/operator-core/lib/observability/tracing.ts',
  'packages/operator-core/lib/observability/posthog-exporter.ts',
  'packages/operator-core/lib/projected-tool-deps.ts',
  'packages/operator-core/lib/inference-gateway/gateway.ts',
  'apps/operator/bin/host-bootstrap.ts',
];
vi.mock('./runtime', () => ({ runtimeObservabilityHealth: () => ({
  initialized: true, globalProviderRegistered: true,
  artifact: { status: 'measured', sourceSha: 'a'.repeat(40), bundleSha256: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64), sourceBlobs: Object.fromEntries(paths.map(path => [path, 'd'.repeat(40)])) },
}) }));
vi.mock('../git-pipeline-position', () => ({ gitPipelinePosition: async () => ({
  servingRuntimes: [{ runtime: 'release-operator', containsChange: true, buildSha: 'a'.repeat(40) }],
}) }));
vi.mock('./project-readback', () => ({ readConfiguredTraceProject: vi.fn() }));
import { measureOperationalObservability } from './operational-check';

describe('release writer population with real PostgreSQL null semantics', () => {
  let db: FreshPgDb;
  const scope = { workspaceId: 'release-writer-test', harnessSlug: 'release-test' };
  const valid = () => ({ sourceSha: 'a'.repeat(40), bundleSha256: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64), sourceBlobs: Object.fromEntries(paths.map(path => [path, 'd'.repeat(40)])) });
  beforeAll(async () => {
    db = await createFreshPgDb('otel-writer-population');
    restoreRawJsonbSerializer(db.sql);
    fixture.sql = db.sql;
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.audit_log (id text PRIMARY KEY, workspace_id text, action text, details jsonb);
      CREATE TABLE harness_shared.pipeline_events (id bigserial PRIMARY KEY, workspace_id text,
        install_slug text, kind text, detail jsonb, created_at timestamptz DEFAULT now());
      CREATE TABLE harness_shared.tool_invocations (id bigserial, metadata_json jsonb, status text,
        invoked_at timestamptz, duration_ms integer, workspace_id text, harness_slug text,
        serving_process_id text, serving_build_sha text);
    `);
    await db.sql`INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, detail)
      VALUES (${scope.workspaceId}, ${scope.harnessSlug}, 'green_checkpoint',
        ${JSON.stringify({ candidate: 'a'.repeat(40), green: true, runId: 'green-test-run' })}::jsonb)`;
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.audit_log`;
    await db.sql`INSERT INTO harness_shared.audit_log VALUES
      ('valid', ${scope.workspaceId}, 'release.artifact.built', ${JSON.stringify(valid())}::jsonb)`;
  });

  const assertWriterAccepted = async () => {
    // No invocation is fabricated: reaching this next unknown proves only that
    // writer and green joins passed, never operational shipment.
    expect(await measureOperationalObservability('release', scope)).toEqual({
      verdict: 'unknown', detail: 'No fresh invocation identity with persisted call/trace/span metadata.',
    });
  };
  it('accepts identical repeated writer identities without claiming shipment', async () => {
    await db.sql`INSERT INTO harness_shared.audit_log VALUES
      ('repeat', ${scope.workspaceId}, 'release.artifact.built', ${JSON.stringify(valid())}::jsonb)`;
    await assertWriterAccepted();
  });
  it.each(['sourceSha', 'sourceBlobs', 'manifestSha256'] as const)(
    'rejects an incomplete %s receipt even beside a valid receipt', async field => {
      await assertWriterAccepted();
      const incomplete: Record<string, unknown> = valid();
      delete incomplete[field];
      await db.sql`INSERT INTO harness_shared.audit_log VALUES
        ('incomplete', ${scope.workspaceId}, 'release.artifact.built', ${JSON.stringify(incomplete)}::jsonb)`;
      expect(await measureOperationalObservability('release', scope)).toEqual({
        verdict: 'fail', detail: 'Release artifact writer and boot measurements differ.',
      });
      await db.sql`DELETE FROM harness_shared.audit_log WHERE id = 'incomplete'`;
      await assertWriterAccepted();
    },
  );
});
