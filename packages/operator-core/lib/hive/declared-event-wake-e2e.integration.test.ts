/**
 * declared-event-wake-e2e.integration.test.ts — hive-loop-e2e-testing-2026-06-10
 * P-008: the DECLARED event-wake variant of the autonomous trigger chain, against
 * a real Postgres (testcontainer) and the REAL dispatcher + reaction registry:
 *
 *   hive:declare-wake { events:[{on:'plans:start'}] } (the Pot's own surface)
 *     → persisted subscription (harness_shared.hive_wake) + live reaction rule
 *     → a BURST of 3 matched tool-events
 *     → hive:wake ×3 → floor-debounce collapses to ONE hive launch
 *       (fireLaunchBlueprint, mocked at the loopback boundary).
 *
 * What this covers that start-hive-e2e.integration.test.ts (P-003 of
 * start-hive-wake-orchestration) does not: the QUEEN-DECLARED subscription path
 * (declare_wake tool → setHiveEventSubscriptions → syncHiveWakeRules) rather
 * than the armed DEFAULT subscriptions, a burst of 3 (not 2), the kickoff
 * carrying the subscription's provenance/note, and declare-wake's REPLACE
 * semantics (re-declaring with no events clears the rules — no further wakes).
 *
 * Mirrors that sibling's testcontainer + projected-dispatch scaffolding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');

const WS = 'default';
const SLUG = 'declared-wake-harness';
process.env.PAPERCUSP_HIVE_HOME_SLUG = SLUG;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown) => fn(h.sql),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS, backgroundWorkspaceIds: () => [WS] };
});

// The loopback boundary: a hive launch is an HTTP POST to the invoke route.
// Mocking fireLaunchBlueprint keeps the WHOLE upstream chain real.
const fireLaunchBlueprint = vi.fn(async () => ({ blueprintId: 'coding', role: 'operator' }));
vi.mock('../blueprint/launch-blueprint', async () => {
  const actual = await vi.importActual<typeof import('../blueprint/launch-blueprint')>(
    '../blueprint/launch-blueprint',
  );
  return { ...actual, fireLaunchBlueprint: (...a: unknown[]) => fireLaunchBlueprint(...(a as [])) };
});

// Import order matters: ../events installs the dispatcher's postInvoke handler;
// the tool modules register themselves with the projected registry at load.
const { _resetReactionsForTests } = await import('../events');
await import('../agent-tools/plans/start');
await import('../agent-tools/hive/wake');
await import('../agent-tools/hive/declare_wake');
const { lookupByMcpName, dispatchProjectedTool } = await import('@papercusp/agent-mcp');
const { PROJECTED_DEPS } = await import('../projected-tool-deps');

let rootSql: postgres.Sql;
let dbName: string;

function ctx(): Record<string, unknown> {
  return {
    workspaceId: WS,
    harnessSlug: 'papercup',
    role: 'operator',
    featureId: null,
    chunkId: null,
    runId: randomUUID(),
    spawnId: 'e2e-test',
    parentSpawnId: null,
    uiClientId: 'su-e2e-test',
    isSuperuser: true,
    gateBypass: { capability: true, quota: true, role: true },
    profile: 'engineer',
    transport: 'in_process',
    log: () => {},
    progress: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    principal: { slug: 'system:e2e-test', workspaceId: WS, capabilities: new Set(['*']) },
    tx: h.sql,
  };
}

async function dispatch(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projected = lookupByMcpName(tool);
  expect(projected, `tool ${tool} must be registered`).toBeTruthy();
  const res = await dispatchProjectedTool(projected!, tool, args, ctx() as never, PROJECTED_DEPS);
  expect(res.ok, `${tool} dispatch failed: ${JSON.stringify(res.error ?? null)}`).toBe(true);
  const text = (res.result?.content as Array<{ text: string }>)[0]?.text;
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (process.env.DEBUG_DISPATCH) console.error('DISPATCH_DEBUG', tool, '|||', text);
  // EI-7217: every defineTool handler now returns the canonical `{ data }`
  // envelope (definetool-token-optimization-adoption P-006/D-008), one level
  // OUTSIDE whatever the handler itself returns — plans:start's bulk envelope
  // `{ ok, results:[…], counts }` (bulk-endpoint-standardization-2026-06-21)
  // and hive:declare-wake's flat `{ ok, mode, eventRules, … }` alike. This test
  // used to unwrap only the bulk shape directly off `parsed`; now everything is
  // nested one level deeper under `.data` first. Unwrap `.data` unconditionally
  // (when present), THEN unwrap the bulk envelope if that's what's inside.
  const inner: unknown =
    parsed && typeof parsed === 'object' && 'data' in (parsed as Record<string, unknown>)
      ? (parsed as { data: unknown }).data
      : parsed;
  if (
    inner &&
    typeof inner === 'object' &&
    Array.isArray((inner as { results?: unknown }).results) &&
    (inner as { counts?: unknown }).counts !== undefined
  ) {
    return ((inner as { results: Record<string, unknown>[] }).results[0] ?? {});
  }
  return (inner as Record<string, unknown>) ?? {};
}

const insertPlan = async (slug: string) =>
  rootSql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, content)
    VALUES (${WS}, ${'papercup'}, ${slug}, ${slug}, 'ready', ${'# ' + slug})`;

const launches = () => fireLaunchBlueprint.mock.calls.length;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const clearWakeFloor = () =>
  rootSql`UPDATE harness_shared.hive_wake SET payload = payload - 'lastWakeAt' WHERE workspace_id = ${WS}`;

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `wake_burst_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await rootSql.unsafe(`DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text NOT NULL PRIMARY KEY,
      install_slug text NOT NULL,
      name text NOT NULL,
      trigger_kind text NOT NULL,
      trigger_config jsonb NOT NULL,
      target_role text NOT NULL,
      payload_template jsonb,
      concurrency text DEFAULT 'queue' NOT NULL,
      catchup text DEFAULT 'skip-old' NOT NULL,
      active boolean DEFAULT true NOT NULL,
      last_fired_at timestamptz,
      next_fire_at timestamptz,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      metadata jsonb,
      workspace_id text NOT NULL,
      CONSTRAINT routines_install_slug_name_key UNIQUE (install_slug, name)
    )
  `);
  // Dispatch telemetry sink (recordInvocation writes here on every dispatch —
  // minimal shape matching the projected-tool-deps INSERT incl. 205's error_code).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.tool_invocations (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plugin_name text NOT NULL,
      tool_name text NOT NULL,
      role text NOT NULL,
      feature_id text, chunk_id text, run_id text,
      spawn_id text NOT NULL, parent_spawn_id text,
      window_key text NOT NULL,
      invoked_at timestamptz DEFAULT now() NOT NULL,
      duration_ms integer, status text NOT NULL,
      output_ref text, output_size bigint, error_message text,
      args_json jsonb, transport text, event_count integer, metadata_json jsonb,
      principal_kind text, principal_auth_method text, principal_trust text,
      error_code text,
      coord_owner_id text
    )
  `);
  // EI-7217/EI-7227: resolveWorkspaceForHarness (workspace-for-harness.ts) ->
  // fill_workspace_id_from_projects (agent-tools/plans/source.ts) queries
  // harness_shared.projects as its FIRST consult before falling back to the
  // harness registry — and plans:start's resolvePlanScope now canonicalizes
  // this test's 'papercup' harness slug to 'papercusp' first (RETIRED_HARNESS_SLUG_ALIASES
  // in harness/operator-home-harness.ts, the 2026-06-19 papercup->papercusp rename-compat
  // shim), THEN looks that canonical slug up — so this test needs both (a) the table to
  // exist at all (it didn't, in this hand-curated minimal schema — "relation
  // harness_shared.projects does not exist") and (b) a row registering the CANONICAL
  // 'papercusp' slug (not the pre-rename 'papercup' this test's fixtures otherwise use)
  // to this test's workspace, or resolvePlanScope fails loud (WI-148, "refusing to
  // silently default"). Only slug/workspace_id are ever read (lookupProjectWorkspaceIds).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.projects (
      id text NOT NULL,
      name text NOT NULL,
      status text NOT NULL,
      slug text,
      workspace_id text NOT NULL
    )
  `);
  await rootSql.unsafe(
    `INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id) VALUES ('papercusp', 'papercusp', 'active', 'papercusp', '${WS}')`,
  );
  // resolveWorkspaceForHarnessSlugIn's step 1 (workspace-registry-first) additionally
  // consults harness_shared.harness_registry (harness-registry.ts loadHarnessRegistry,
  // a generic per-workspace JSONB blob, migration 025) — same missing-relation class.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_registry (
      workspace_id text NOT NULL,
      payload jsonb NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL
    )
  `);
  // resolvePlanScope also requires plans be Hive-scoped: the registry entry must
  // be its OWN Hive home (harness_kind:'hive') or belong to one (hive_slug), or
  // it fails loud ("plans are Hive-scoped, but '<slug>' is not a Hive home and
  // does not belong to one"). This test's harness is its own Hive home.
  await rootSql.unsafe(
    `INSERT INTO harness_shared.harness_registry (workspace_id, payload) VALUES ('${WS}', '{"projects":[{"slug":"papercusp","path":"/tmp/papercusp","harness_kind":"hive"}]}'::jsonb)`,
  );
  await rootSql.unsafe(readMigration('158-pot-wake-state.sql')).simple();
  await rootSql.unsafe(readMigration('198-rename-pot-wake-to-hive-wake.sql')).simple();
  await rootSql.unsafe(readMigration('122-harness-plans.sql')).simple();
  await rootSql.unsafe(readMigration('128-harness-plans-normalize.sql')).simple();
  // The initiative grouping column (284) — plans:start's source-derive reads/writes it.
  await rootSql.unsafe(readMigration('284-harness-plans-initiative.sql')).simple();
  // The decision-ledger sink (260) — recordDecisionLedger writes here from the
  // dispatch postInvoke seam; without it every governed dispatch console.warns
  // ("relation harness_shared.decision_ledger does not exist") and
  // vitest-fail-on-console reddens the whole file (EI-496).
  await rootSql.unsafe(readMigration('260-decision-ledger.sql')).simple();
  // The ONE shared carry-note substrate (472) — hive:declare-wake's { remember }
  // journal + the wake path read/write it (su-cold-auto-mode-2026-07-03 P-001).
  await rootSql.unsafe(readMigration('472-carry-notes.sql')).simple();
  // The declare-wake frontier guard (wake-frontier-guard.ts) reads this table.
  await rootSql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  // The hive started/paused KV (hive/started.ts + overwatch control-state) —
  // the declare-wake path reads it; baseline shape + workspace_id (mig 453,
  // every write stamps activeWorkspaceId()).
  await rootSql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.operator_settings (
      key text NOT NULL,
      value text NOT NULL,
      description text,
      updated_at bigint DEFAULT 0 NOT NULL,
      workspace_id text NOT NULL,
      CONSTRAINT operator_settings_pkey PRIMARY KEY (key)
    )`);
  h.sql = rootSql;
  // WI-2012 (owner directive 2026-07-03): hives are born PAUSED and
  // hive:declare-wake refuses to arm while started=false. Start the hive the
  // way hive:start does (setHiveStarted BEFORE arming) so the declared-wake
  // chain under test can register rules at all.
  {
    const { setHiveStarted } = await import('./started');
    const { resolveHiveHomeSlug } = await import('./wake');
    await setHiveStarted(WS, resolveHiveHomeSlug('papercup', undefined)!, true);
  }
  // Deliberately NOT arming the default subscriptions — every rule in this test
  // comes from the Pot's own hive:declare-wake call (the declared path).
}, 120_000);

afterAll(async () => {
  _resetReactionsForTests();
  await rootSql?.end({ timeout: 5 });
});

describe('the declared event wake, end to end (P-008)', () => {
  it('hive:declare-wake registers the subscription as a live reaction rule', async () => {
    const out = await dispatch('hive:declare-wake', {
      harness: 'papercup',
      events: [{ on: 'plans:start', note: 'P-008 burst test' }],
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.mode).toBe('event');
    expect(out.eventRules).toBe(1);
  });

  it('a burst of 3 matched events collapses to ONE wake, and the wake produces the launch', async () => {
    for (const p of ['burst-1', 'burst-2', 'burst-3']) await insertPlan(p);

    // The burst: three matched tool-events in quick succession.
    for (const p of ['burst-1', 'burst-2', 'burst-3']) {
      const out = await dispatch('plans:start', { slug: p, harness: 'papercup' });
      expect(out.transitioned).toBe(true);
    }

    // Floor-debounce: exactly ONE hive launch for the whole burst.
    await vi.waitFor(() => expect(launches()).toBe(1), { timeout: 5_000 });
    await settle();
    expect(launches()).toBe(1);

    // The wake produced an action: the hive blueprint launch, on the harness the
    // trigger ran in, with the declared subscription's provenance in the kickoff.
    const [blueprintId, launchOpts] = fireLaunchBlueprint.mock.calls[0] as unknown as [
      string,
      { installSlug: string; kickoff?: string },
    ];
    expect(blueprintId).toBe('coding');
    expect(launchOpts.installSlug).toBe('papercup');
    expect(launchOpts.kickoff).toContain('subscribed event');
    expect(launchOpts.kickoff).toContain('P-008 burst test');

    // The debounce never blocked the WORK — all three plans started.
    const rows = await rootSql`
      SELECT plan_slug FROM harness_shared.harness_plans WHERE op_status = 'started' ORDER BY plan_slug`;
    expect(rows.map((r) => r.plan_slug)).toEqual(['burst-1', 'burst-2', 'burst-3']);
  });

  it('control: a matched event OUTSIDE the floor wakes again', async () => {
    await clearWakeFloor();
    await insertPlan('after-floor');
    const out = await dispatch('plans:start', { slug: 'after-floor', harness: 'papercup' });
    expect(out.transitioned).toBe(true);
    await vi.waitFor(() => expect(launches()).toBe(2), { timeout: 5_000 });
  });

  it('REPLACE semantics: re-declaring with no events clears the subscription — no further wakes', async () => {
    const out = await dispatch('hive:declare-wake', { harness: 'papercup', mode: 'none' });
    expect(out.ok).toBe(true);
    expect(out.eventRules).toBe(0);
    expect(out.mode).toBe('none');

    await clearWakeFloor(); // a wake COULD fire — the only gate left is the cleared rule set
    await insertPlan('after-clear');
    const started = await dispatch('plans:start', { slug: 'after-clear', harness: 'papercup' });
    expect(started.transitioned).toBe(true);
    await settle();
    expect(launches()).toBe(2); // unchanged — the declared subscription is gone
  });
});
