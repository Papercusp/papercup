/**
 * The persistent coverage-attribution venue (design-to-code-coverage-seam P-027).
 *
 * The broad green-checkpoint command is unit-only. Its forks exercise HTTP/MCP
 * seams but correctly refuse real Postgres, while the ordinary integration lane
 * may persist but almost never reaches either observer. This one integration-
 * shaped rail joins those capabilities deliberately:
 *
 *   real RouteDefinition -> registerRoute/runRouteStack -> recordHttpTraffic
 *   real ToolDefinition  -> dispatchProjectedTool       -> recordMcpTraffic
 *   canonical admin PG   -> createPgEvidenceStore       -> coverage_evidence
 *
 * Both surface ids come from the live census, not a test-only registration. The
 * final assertion reads testing_surface_depth, so a green result proves the
 * evidence is persistent and capable of moving the ladder above depth zero.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import postgres, { type Sql } from 'postgres';
import { fileURLToPath } from 'node:url';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { registerRoute } from '../../endpoint-route/define-route';
import healthRoute from '../../endpoint-route/routes/misc/health';
import { PROJECTED_DEPS, flushPendingTelemetry } from '../../projected-tool-deps';
import { toWorkspaceRel } from '@papercusp/test-config/admin-test-runs-reporter';
import {
  ATTRIBUTION_ENV,
  resetAttributionArmingForTests,
} from './context';
import {
  attributionStatus,
  flushTrafficEvidence,
  resetAttributionSinkForTests,
  setEvidenceStoreForTests,
} from './sink';
import { createPgEvidenceStore } from './pg-evidence-store';

// Register the real read-only tool before looking it up in the projected catalog.
await import('../../agent-tools/facts/list');

const WORKSPACE = 'papercusp-workspace';
const HARNESS = 'papercusp';
const TEST_FILE = toWorkspaceRel(fileURLToPath(import.meta.url));
const EXPECTED_SURFACES = ['GET /health', 'facts:list'] as const;

let sql: Sql;
const savedEnv = new Map<string, string | undefined>();
const PINNED_ENV = [
  ATTRIBUTION_ENV,
  'PAPERCUSP_WORKSPACE_ID',
  'PAPERCUSP_TEST_RUN_HARNESS',
] as const;

function dispatchContext(): Record<string, unknown> {
  return {
    workspaceId: WORKSPACE,
    harnessSlug: HARNESS,
    role: 'operator',
    featureId: null,
    chunkId: null,
    runId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? 'coverage-attribution-venue',
    spawnId: 'coverage-attribution-venue',
    parentSpawnId: null,
    uiClientId: 'coverage-attribution-venue',
    isSuperuser: true,
    gateBypass: { capability: true, quota: true, role: true },
    profile: 'engineer',
    transport: 'in_process',
    log: () => {},
    progress: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    principal: {
      slug: 'system:coverage-attribution-venue',
      workspaceId: WORKSPACE,
      capabilities: new Set(['*']),
    },
    tx: sql,
  };
}

beforeAll(() => {
  for (const key of PINNED_ENV) savedEnv.set(key, process.env[key]);
  process.env[ATTRIBUTION_ENV] = '1';
  process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE;
  process.env.PAPERCUSP_TEST_RUN_HARNESS = HARNESS;

  // The handle points at the same canonical admin URL the production store
  // resolves. Injection exists only so this test can close the pool cleanly.
  sql = postgres(getHarnessAdminUrl(), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
});

beforeEach(() => {
  resetAttributionSinkForTests();
  resetAttributionArmingForTests();
  setEvidenceStoreForTests(createPgEvidenceStore({ getSql: () => sql }));
});

afterAll(async () => {
  resetAttributionSinkForTests();
  resetAttributionArmingForTests();
  await sql?.end({ timeout: 2 });
  for (const key of PINNED_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('persistent coverage-attribution venue', () => {
  it('drives real HTTP and MCP seams into persistent L1 evidence', async () => {
    const app = new Hono();
    registerRoute(app, healthRoute);

    const health = await app.request('/health');
    expect(health.status).toBe(200);

    const facts = lookupByMcpName('facts:list');
    expect(facts, 'facts:list must remain in the projected tool catalog').toBeTruthy();
    const dispatched = await dispatchProjectedTool(
      facts!,
      'facts:list',
      { scope: 'workspace', limit: 1 },
      dispatchContext() as never,
      PROJECTED_DEPS,
    );
    expect(dispatched.ok, JSON.stringify(dispatched.error ?? null)).toBe(true);

    await flushTrafficEvidence();
    await flushPendingTelemetry();

    expect(attributionStatus()).toMatchObject({
      armed: true,
      disabled: false,
      buffered: 0,
      unmatchedSurfaces: 0,
      lastError: null,
    });
    expect(attributionStatus().written).toBeGreaterThanOrEqual(EXPECTED_SURFACES.length);

    const rows = await sql<{
      surface_id: string;
      depth: number;
      meets_l1: boolean;
      test_file: string | null;
    }[]>`
      SELECT d.surface_id, d.depth, d.meets_l1, e.test_file
        FROM harness_shared.testing_surface_depth d
        JOIN harness_shared.coverage_evidence e ON e.surface_ref = d.id
       WHERE d.workspace_id = ${WORKSPACE}
         AND d.harness_slug = ${HARNESS}
         AND d.surface_id = ANY(${[...EXPECTED_SURFACES]}::text[])
         AND e.evidence_kind = 'traffic'
         AND e.test_file = ${TEST_FILE}
    `;

    expect(new Set(rows.map((row) => row.surface_id))).toEqual(new Set(EXPECTED_SURFACES));
    expect(rows.every((row) => row.meets_l1 && Number(row.depth) >= 1)).toBe(true);
    expect(rows.every((row) => row.test_file === TEST_FILE)).toBe(true);
  });
});
