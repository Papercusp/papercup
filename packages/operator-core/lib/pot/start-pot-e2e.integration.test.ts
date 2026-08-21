/**
 * start-pot-e2e.integration.test.ts — start-hive-wake-orchestration-2026-06-09
 * P-003: the END-TO-END missing link, against a real Postgres (testcontainer)
 * and the REAL dispatcher:
 *
 *   plans:start (dispatched) → op_status transition → postInvoke → the armed
 *   default subscription's reaction rule → pot:wake (dispatched) →
 *   floor-debounce → ONE pot launch (fireLaunchBlueprint, mocked at the
 *   loopback boundary).
 *
 * Asserts the three load-bearing behaviors:
 *   1. a real plans:start transition wakes the Mug exactly once;
 *   2. burst-coalescing — a second start inside the wake floor does NOT launch
 *      again (the floor debounce in pot:wake);
 *   3. the idempotent RE-start of an already-started plan never wakes
 *      (transitioned:false → the rule's `when` rejects), while the started
 *      plan stays visible to the Mug's survey (op_status='started' in
 *      harness_plans — the store plans:list/work-frontier reads).
 *
 * Mirrors pot-wake-pg.integration.test.ts's testcontainer setup.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const RUNNER = resolve(
  __dirname,
  '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);
// WI-5260 (EI-540 robust fix): head-schema provisioning via the REAL migration runner
// (same pattern as work-items-cdc-capture.integration.test.ts / _org-test-db.ts) instead
// of a hand-curated readMigration() allowlist — a future migration adding a column/table
// this test's chain depends on no longer needs a matching hand-edit here to keep working.
const SKIP = (f: string) =>
  f.includes('per-harness-template') ||
  f === '040-plugin-configs-backfill.sql' ||
  f === '__seed_restored__.marker';

const WS = 'default'; // = DEFAULT_WORKSPACE_ID, so plans:start + the pot state share one workspace
const SLUG = 'pot-e2e-harness';
process.env.PAPERCUSP_POT_HOME_SLUG = SLUG;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown) => fn(h.sql),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS, backgroundWorkspaceIds: () => [WS] };
});

// The loopback boundary: a pot launch is an HTTP POST to the invoke route.
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
const { _resetReactionsForTests, listReactionRules } = await import('../events');
await import('../agent-tools/plans/start');
await import('../agent-tools/pot/wake');
const { armDefaultPotWakeSubscriptions } = await import('./wake-defaults');
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
  // max:1 — some legacy migration files carry their own BEGIN/COMMIT (postgres.js
  // only allows that on a single-connection handle), and the dispatch path under
  // test is sequential anyway.
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  // WI-5260: provision the FULL head schema via the real migration runner (mirrors
  // work-items-cdc-capture.integration.test.ts's `provision`) instead of a hand-curated
  // allowlist of ~9 migration files + hand-rolled CREATE TABLE stand-ins for
  // routines/tool_invocations/projects/harness_registry/operator_settings — all five of
  // those tables are created by 000-baseline.sql (confirmed via grep), so the full chain
  // subsumes every hand-rolled table this test used to bootstrap by hand. A FUTURE
  // migration adding a column/table this dispatch chain depends on no longer needs a
  // matching hand-edit here to keep this test green (the EI-540 class of breakage).
  await rootSql.unsafe(`
    DO $pg$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
    END $pg$;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS vector;
  `);
  {
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: {
        client: Sql;
        sqlDir: string;
        skipFile?: (f: string) => boolean;
      }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({
      client: rootSql,
      sqlDir: SQL_DIR,
      skipFile: SKIP,
    });
    if (appliedCount !== totalKnown) throw new Error(`start-pot-e2e provision: ${appliedCount}/${totalKnown}`);
  }
  // EI-7227: resolveWorkspaceForHarness -> fill_workspace_id_from_projects
  // (agent-tools/plans/source.ts) consults harness_shared.projects, then
  // resolveWorkspaceForHarnessSlugIn (harness-core.ts) additionally consults
  // harness_shared.harness_registry (a generic per-workspace JSONB blob,
  // migration 025). Also: this test's 'papercup' harness slug canonicalizes to
  // 'papercusp' (RETIRED_HARNESS_SLUG_ALIASES, the 2026-06-19 rename-compat shim)
  // before resolution, and plans are Pot-scoped (must be a Pot home or belong to
  // one) — so the registered slug must be 'papercusp' with harness_kind:'hive'.
  // Both tables now come from the migration chain above; only the seed rows are
  // this test's own responsibility.
  // head schema's `projects` (baseline) requires created_ts/updated_ts NOT NULL with
  // no default — the old hand-rolled minimal table had neither column at all.
  await rootSql.unsafe(
    `INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts) VALUES ('papercusp', 'papercusp', 'active', 'papercusp', '${WS}', ${Date.now()}, ${Date.now()})`,
  );
  await rootSql.unsafe(
    `INSERT INTO harness_shared.harness_registry (workspace_id, payload) VALUES ('${WS}', '{"projects":[{"slug":"papercusp","path":"/tmp/papercusp","harness_kind":"hive"}]}'::jsonb)`,
  );
  h.sql = rootSql;

  // WI-2012 (owner directive 2026-07-03): hives are born PAUSED and the wake
  // surface refuses to arm while started=false. Start the pot the way
  // pot:start does (setPotStarted BEFORE arming) so the chain under test
  // can fire.
  {
    const { setPotStarted } = await import('./started');
    const { resolvePotHomeSlug } = await import('./wake');
    await setPotStarted(WS, resolvePotHomeSlug('papercup', undefined)!, true);
  }

  // Arm the Mug's defaults (P-002) — the live reaction rules the chain rides.
  await armDefaultPotWakeSubscriptions(WS, { mode: 'replace' });
}, 120_000);

afterAll(async () => {
  _resetReactionsForTests();
  await rootSql?.end({ timeout: 5 });
});

describe('the missing link, end to end (P-003)', () => {
  it('plans:start → event → reaction rule → floor-debounced pot:wake → ONE Mug launch', async () => {
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
    // which outranks the PAPERCUSP_POT_HOME_SLUG env fallback — the wake lands
    // on the harness whose plan started. EI-7227: 'papercup' canonicalizes to
    // 'papercusp' (RETIRED_HARNESS_SLUG_ALIASES, the 2026-06-19 rename-compat
    // shim) by the time it reaches the launch.
    expect(launchOpts.installSlug).toBe('papercusp');
    expect(launchOpts.kickoff).toContain('plans:start');

    // The started plan is visible to the woken Mug's survey store.
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
    await rootSql`UPDATE harness_shared.pot_wake SET payload = payload - 'lastWakeAt' WHERE workspace_id = ${WS}`;

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

describe('restart recovery (WI-4890): a host reboot must not silently strand the Mug\'s event wakes', () => {
  it('registerPotWakeRules re-projects PERSISTED subscriptions after the in-memory registry is wiped, and the re-projected rule still fires a REAL launch through the real dispatcher', async () => {
    // Sanity: the subscriptions armed in beforeAll are still live from the prior
    // tests in this file.
    const before = listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`));
    expect(before.length).toBeGreaterThan(0);

    // Simulate the crash/restart: the reaction registry is process-local memory
    // (per wake.ts's module doc: "Re-registered at boot ... since the rule registry
    // is in-memory") — a host restart wipes it while Postgres still holds whatever
    // a prior (now-dead) process persisted. This is the EXACT WI-4890 incident shape:
    // "time.active=false/liveRuleIds=[] despite persisted started=true and three
    // subscription specs."
    _resetReactionsForTests();
    expect(listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`))).toHaveLength(0);

    // This is exactly what index.ts's boot wiring runs for every
    // backgroundWorkspaceIds() entry on every host start (the WI-4890 fix) —
    // re-project the persisted pot_wake subscriptions into the live registry.
    const { registerPotWakeRules } = await import('./wake');
    const n = await registerPotWakeRules(WS);
    expect(n).toBe(before.length);
    expect(listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`))).toHaveLength(before.length);

    // Prove the re-projected rule is not merely REGISTERED but genuinely LIVE:
    // clear the floor debounce (as the earlier "fresh start" test does) then fire
    // a real plans:start through the real dispatcher — the "subsequent autonomous
    // wake" the bug asked to verify.
    await rootSql`UPDATE harness_shared.pot_wake SET payload = payload - 'lastWakeAt' WHERE workspace_id = ${WS}`;
    await insertPlan('plan-restart-recovery');
    const launchesBefore = launches();
    const out = await dispatch('plans:start', { slug: 'plan-restart-recovery', harness: 'papercup' });
    expect(out.transitioned).toBe(true);
    await vi.waitFor(() => expect(launches()).toBe(launchesBefore + 1), { timeout: 5_000 });
  });
});
