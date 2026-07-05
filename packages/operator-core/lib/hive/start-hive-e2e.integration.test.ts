/**
 * start-hive-e2e.integration.test.ts — start-hive-wake-orchestration-2026-06-09
 * P-003: the END-TO-END missing link, against a real Postgres (testcontainer)
 * and the REAL dispatcher:
 *
 *   plans:start (dispatched) → op_status transition → postInvoke → the armed
 *   default subscription's reaction rule → pot:wake (dispatched) →
 *   floor-debounce → ONE hive launch (fireLaunchBlueprint, mocked at the
 *   loopback boundary).
 *
 * Asserts the three load-bearing behaviors:
 *   1. a real plans:start transition wakes the Queen exactly once;
 *   2. burst-coalescing — a second start inside the wake floor does NOT launch
 *      again (the floor debounce in pot:wake);
 *   3. the idempotent RE-start of an already-started plan never wakes
 *      (transitioned:false → the rule's `when` rejects), while the started
 *      plan stays visible to the Queen's survey (op_status='started' in
 *      harness_plans — the store plans:list/work-frontier reads).
 *
 * Mirrors hive-wake-pg.integration.test.ts's testcontainer setup.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');

const WS = 'default'; // = DEFAULT_WORKSPACE_ID, so plans:start + the hive state share one workspace
const SLUG = 'hive-e2e-harness';
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
const { armDefaultHiveWakeSubscriptions } = await import('./wake-defaults');
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
  const parsed = text ? JSON.parse(text) : {};
  // plans:start (and the other bulk tools) now return the house bulk envelope
  // `{ ok, results:[{ slug, status, transitioned, … }], counts }` via _bulk's
  // bulkContent (bulk-endpoint-standardization-2026-06-21). The per-item result
  // we assert against lives in results[0] for a single-slug call; unwrap it so
  // the existing `out.status` / `out.transitioned` assertions read the same
  // values they did before the bulk migration.
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { results?: unknown }).results) &&
    (parsed as { counts?: unknown }).counts !== undefined
  ) {
    return ((parsed as { results: Record<string, unknown>[] }).results[0] ?? {});
  }
  return parsed;
}

const insertPlan = async (slug: string) =>
  rootSql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, content)
    VALUES (${WS}, ${'papercup'}, ${slug}, ${slug}, 'ready', ${'# ' + slug})`;

const launches = () => fireLaunchBlueprint.mock.calls.length;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `hive_e2e_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  // max:1 — the migration files carry their own BEGIN/COMMIT (postgres.js only
  // allows that on a single-connection handle), and the dispatch path is
  // sequential anyway.
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await rootSql.unsafe(`DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  // routines (baseline shape — the one-shot wake rows live here).
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
  // Dispatch telemetry sink — recordInvocation (projected-tool-deps) now writes
  // here on EVERY dispatch; without the table each dispatch console.warns and
  // vitest-fail-on-console reddens the whole file. Minimal shape matching the
  // INSERT (incl. 205's error_code).
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
  // EI-7227: resolveWorkspaceForHarness -> fill_workspace_id_from_projects
  // (agent-tools/plans/source.ts) consults harness_shared.projects, then
  // resolveWorkspaceForHarnessSlugIn (harness-core.ts) additionally consults
  // harness_shared.harness_registry (a generic per-workspace JSONB blob,
  // migration 025) — this test's minimal hand-curated schema had neither table,
  // so plans:start failed with "relation ... does not exist". Also: this test's
  // 'papercup' harness slug canonicalizes to 'papercusp' (RETIRED_HARNESS_SLUG_ALIASES,
  // the 2026-06-19 rename-compat shim) before resolution, and plans are Hive-scoped
  // (must be a Hive home or belong to one) — so the registered slug must be
  // 'papercusp' with harness_kind:'hive'.
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
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_registry (
      workspace_id text NOT NULL,
      payload jsonb NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL
    )
  `);
  await rootSql.unsafe(
    `INSERT INTO harness_shared.harness_registry (workspace_id, payload) VALUES ('${WS}', '{"projects":[{"slug":"papercusp","path":"/tmp/papercusp","harness_kind":"hive"}]}'::jsonb)`,
  );
  // The hive started/paused KV (hive/started.ts + overwatch control-state) —
  // the start path reads/writes it; baseline shape + workspace_id (mig 453,
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
  await rootSql.unsafe(readMigration('158-pot-wake-state.sql')).simple();
  await rootSql.unsafe(readMigration('198-rename-pot-wake-to-hive-wake.sql')).simple();
  await rootSql.unsafe(readMigration('122-harness-plans.sql')).simple();
  // Stage-3 derived-index columns (items/decisions/now_*) — the write path
  // (with-plan-lock) and the start tool's source reads expect them at head.
  await rootSql.unsafe(readMigration('128-harness-plans-normalize.sql')).simple();
  // The initiative grouping column (284) — plans:start's source-derive reads/writes it.
  await rootSql.unsafe(readMigration('284-harness-plans-initiative.sql')).simple();
  // The decision-ledger sink (260) — recordDecisionLedger writes here from the
  // dispatch postInvoke seam; without it every governed dispatch console.warns
  // ("relation harness_shared.decision_ledger does not exist") and
  // vitest-fail-on-console reddens the whole file (EI-497).
  await rootSql.unsafe(readMigration('260-decision-ledger.sql')).simple();
  // The ONE shared carry-note substrate (472) — the wake path's carry-journal
  // reads/writes it (su-cold-auto-mode-2026-07-03 P-001).
  await rootSql.unsafe(readMigration('472-carry-notes.sql')).simple();
  h.sql = rootSql;

  // WI-2012 (owner directive 2026-07-03): hives are born PAUSED and the wake
  // surface refuses to arm while started=false. Start the hive the way
  // pot:start does (setHiveStarted BEFORE arming) so the chain under test
  // can fire.
  {
    const { setHiveStarted } = await import('./started');
    const { resolveHiveHomeSlug } = await import('./wake');
    await setHiveStarted(WS, resolveHiveHomeSlug('papercup', undefined)!, true);
  }

  // Arm the Queen's defaults (P-002) — the live reaction rules the chain rides.
  await armDefaultHiveWakeSubscriptions(WS, { mode: 'replace' });
}, 120_000);

afterAll(async () => {
  _resetReactionsForTests();
  await rootSql?.end({ timeout: 5 });
});

describe('the missing link, end to end (P-003)', () => {
  it('plans:start → event → reaction rule → floor-debounced pot:wake → ONE Queen launch', async () => {
    await insertPlan('plan-a');
    const out = await dispatch('plans:start', { slug: 'plan-a', harness: 'papercup' });
    expect(out.status).toBe('started');
    expect(out.transitioned).toBe(true);

    // The reaction is scheduled off the hot path — wait for the launch.
    await vi.waitFor(() => expect(launches()).toBe(1), { timeout: 5_000 });
    const [, launchOpts] = fireLaunchBlueprint.mock.calls[0] as unknown as [
      string,
      { installSlug: string; kickoff?: string },
    ];
    // The reaction ctx INHERITS the trigger's harness scope (buildReactionCtx),
    // which outranks the PAPERCUSP_HIVE_HOME_SLUG env fallback — the wake lands
    // on the harness whose plan started. EI-7227: 'papercup' canonicalizes to
    // 'papercusp' (RETIRED_HARNESS_SLUG_ALIASES, the 2026-06-19 rename-compat
    // shim) by the time it reaches the launch.
    expect(launchOpts.installSlug).toBe('papercusp');
    expect(launchOpts.kickoff).toContain('plans:start');

    // The started plan is visible to the woken Queen's survey store.
    const rows = await rootSql`
      SELECT op_status FROM harness_shared.harness_plans WHERE plan_slug = 'plan-a'`;
    expect(rows[0].op_status).toBe('started');
  });

  it('burst-coalescing: a second start INSIDE the wake floor does not launch again', async () => {
    await insertPlan('plan-b');
    const out = await dispatch('plans:start', { slug: 'plan-b', harness: 'papercup' });
    expect(out.transitioned).toBe(true);
    await settle();
    expect(launches()).toBe(1); // pot:wake fired but skipped on the floor
    // …and plan-b still started (the debounce never blocks the WORK, only the wake).
    const rows = await rootSql`
      SELECT op_status FROM harness_shared.harness_plans WHERE plan_slug = 'plan-b'`;
    expect(rows[0].op_status).toBe('started');
  });

  it("the idempotent RE-start never wakes (transitioned:false), while a fresh start outside the floor does", async () => {
    // Clear the floor (simulate the window passing) so a real wake COULD fire.
    await rootSql`UPDATE harness_shared.hive_wake SET payload = payload - 'lastWakeAt' WHERE workspace_id = ${WS}`;

    // Re-start an already-started plan: no transition → the rule's when rejects.
    const again = await dispatch('plans:start', { slug: 'plan-a', harness: 'papercup' });
    expect(again.transitioned).toBe(false);
    await settle();
    expect(launches()).toBe(1);

    // Control: a genuinely new start outside the floor DOES launch — proving
    // the negative above was the rule's gate, not a broken chain.
    await insertPlan('plan-c');
    const fresh = await dispatch('plans:start', { slug: 'plan-c', harness: 'papercup' });
    expect(fresh.transitioned).toBe(true);
    await vi.waitFor(() => expect(launches()).toBe(2), { timeout: 5_000 });
  });
});
