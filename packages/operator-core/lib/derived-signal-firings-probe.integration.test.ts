/**
 * P-007 scope regression — the firing probe reads a shared telemetry ledger.
 *
 * The unit predicates cannot prove tenant isolation. This real-Postgres test
 * seeds the same relation under the target concrete harness, its legitimate
 * workspace-global `*` context, another harness, and another workspace. Only
 * the first two may contribute to the probe's evidence and edge totals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — the probe is a plain JS CLI; this test exercises its exported SQL helper.
import { readCensusRows } from '../../../scripts/check-derived-signal-firings.mjs';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WORKSPACE = 'ws-derived-signal-probe-scope-it';
const OTHER_WORKSPACE = 'ws-derived-signal-probe-other-it';
const HARNESS = 'papercusp';
const OTHER_HARNESS = 'other-harness';

function censusJson(edges: number) {
  return {
    derivedSignals: {
      v: 2,
      relations: {
        'holds-a-lock-on': { armed: true, inputs: 1, edges },
      },
    },
  };
}

async function seedInvocation(workspaceId: string, harnessSlug: string, edges: number, suffix: string): Promise<void> {
  await admin`
    INSERT INTO harness_shared.tool_invocations (
      workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
      window_key, invoked_at, status, metadata_json
    ) VALUES (
      ${workspaceId}, ${harnessSlug}, 'operator-core', 'coord:presence', 'su',
      ${`derived-signal-scope-${suffix}`}, 'scope-test', now(), 'ok', ${admin.json(censusJson(edges))}
    )
  `;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});

afterAll(async () => {
  await admin`
    DELETE FROM harness_shared.tool_invocations
     WHERE workspace_id = ${WORKSPACE} OR workspace_id = ${OTHER_WORKSPACE}
  `.catch(() => {});
  await fx.dispose();
});

beforeEach(async () => {
  await admin`
    DELETE FROM harness_shared.tool_invocations
     WHERE workspace_id = ${WORKSPACE} OR workspace_id = ${OTHER_WORKSPACE}
  `;
});

describe('readCensusRows — workspace and harness scope', () => {
  it('includes concrete + workspace-global rows but excludes other tenants', async () => {
    await seedInvocation(WORKSPACE, HARNESS, 1, 'concrete');
    await seedInvocation(WORKSPACE, '*', 2, 'global');
    await seedInvocation(WORKSPACE, OTHER_HARNESS, 100, 'other-harness');
    await seedInvocation(OTHER_WORKSPACE, HARNESS, 1000, 'other-workspace');

    const result = await readCensusRows(admin, { workspaceId: WORKSPACE, harnessSlug: HARNESS });
    const observed = result.observed.get('holds-a-lock-on');

    expect(result.censusRows).toBe(2);
    expect(result.staleVersionRows).toBe(0);
    expect(observed).toMatchObject({ runs: 2, armed_runs: 2, input_runs: 2, edges: 3 });
  });
});
