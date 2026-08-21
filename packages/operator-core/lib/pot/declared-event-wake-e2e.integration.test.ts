/**
 * declared-event-wake-e2e.integration.test.ts — hive-loop-e2e-testing-2026-06-10
 * P-008: the DECLARED event-wake variant of the autonomous trigger chain, against
 * a real Postgres (testcontainer) and the REAL dispatcher + reaction registry:
 *
 *   pot:declare-wake { events:[{on:'plans:start'}] } (the Pot's own surface)
 *     → persisted subscription (harness_shared.pot_wake) + live reaction rule
 *     → a BURST of 3 matched tool-events
 *     → pot:wake ×3 → floor-debounce collapses to ONE pot launch
 *       (fireLaunchBlueprint, mocked at the loopback boundary).
 *
 * What this covers that start-pot-e2e.integration.test.ts (P-003 of
 * start-pot-wake-orchestration) does not: the MUG-DECLARED subscription path
 * (declare_wake tool → setPotEventSubscriptions → syncPotWakeRules) rather
 * than the armed DEFAULT subscriptions, a burst of 3 (not 2), the kickoff
 * carrying the subscription's provenance/note, and the EI-10525 always-armed
 * demand-wake invariant (re-declaring with no events replaces her CUSTOM subs
 * but KEEPS the three default demand wakes armed).
 *
 * Mirrors that sibling's testcontainer + projected-dispatch scaffolding.
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
// WI-5260 (EI-540 robust fix): head-schema provisioning via the REAL migration runner,
// mirroring the sibling start-pot-e2e.integration.test.ts's same swap — see that file's
// comment for the full rationale. HARNESS_FEATURES_CONSOLIDATED_DDL is no longer needed
// (the full chain creates harness_features_consolidated itself).
const SKIP = (f: string) =>
  f.includes('per-harness-template') ||
  f === '040-plugin-configs-backfill.sql' ||
  f === '__seed_restored__.marker';

const WS = 'default';
const SLUG = 'declared-wake-harness';
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
const { _resetReactionsForTests } = await import('../events');
await import('../agent-tools/plans/start');
await import('../agent-tools/pot/wake');
await import('../agent-tools/pot/declare_wake');
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
  // EI-7217: every defineTool handler now returns the canonical `{ data }`
  // envelope (definetool-token-optimization-adoption P-006/D-008), one level
  // OUTSIDE whatever the handler itself returns — plans:start's bulk envelope
  // `{ ok, results:[…], counts }` (bulk-endpoint-standardization-2026-06-21)
  // and pot:declare-wake's flat `{ ok, mode, eventRules, … }` alike. This test
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
  rootSql`UPDATE harness_shared.pot_wake SET payload = payload - 'lastWakeAt' WHERE workspace_id = ${WS}`;

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
  // WI-5260: full head-schema provisioning (see the import-block comment above).
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
    if (appliedCount !== totalKnown) {
      throw new Error(`declared-event-wake-e2e provision: ${appliedCount}/${totalKnown}`);
    }
  }
  // EI-7217/EI-7227: resolveWorkspaceForHarness (workspace-for-harness.ts) ->
  // fill_workspace_id_from_projects (agent-tools/plans/source.ts) queries
  // harness_shared.projects as its FIRST consult before falling back to the
  // harness registry — and plans:start's resolvePlanScope now canonicalizes
  // this test's 'papercup' harness slug to 'papercusp' first (RETIRED_HARNESS_SLUG_ALIASES
  // in harness/operator-home-harness.ts, the 2026-06-19 papercup->papercusp rename-compat
  // shim), THEN looks that canonical slug up — so this test needs a row registering the
  // CANONICAL 'papercusp' slug (not the pre-rename 'papercup' this test's fixtures
  // otherwise use) to this test's workspace, or resolvePlanScope fails loud (WI-148,
  // "refusing to silently default"). Both projects/harness_registry tables now come
  // from the migration chain above (baseline); only the seed rows are this test's own.
  // head schema's `projects` requires created_ts/updated_ts NOT NULL with no default.
  await rootSql.unsafe(
    `INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts) VALUES ('papercusp', 'papercusp', 'active', 'papercusp', '${WS}', ${Date.now()}, ${Date.now()})`,
  );
  // resolvePlanScope also requires plans be Pot-scoped: the registry entry must
  // be its OWN Pot home (harness_kind:'hive') or belong to one (hive_slug), or
  // it fails loud ("plans are Pot-scoped, but '<slug>' is not a Pot home and
  // does not belong to one"). This test's harness is its own Pot home.
  await rootSql.unsafe(
    `INSERT INTO harness_shared.harness_registry (workspace_id, payload) VALUES ('${WS}', '{"projects":[{"slug":"papercusp","path":"/tmp/papercusp","harness_kind":"hive"}]}'::jsonb)`,
  );
  h.sql = rootSql;
  // WI-2012 (owner directive 2026-07-03): hives are born PAUSED and
  // pot:declare-wake refuses to arm while started=false. Start the pot the
  // way pot:start does (setPotStarted BEFORE arming) so the declared-wake
  // chain under test can register rules at all.
  {
    const { setPotStarted } = await import('./started');
    const { resolvePotHomeSlug } = await import('./wake');
    await setPotStarted(WS, resolvePotHomeSlug('papercup', undefined)!, true);
  }
  // Deliberately NOT arming the default subscriptions — every rule in this test
  // comes from the Pot's own pot:declare-wake call (the declared path).
}, 120_000);

afterAll(async () => {
  _resetReactionsForTests();
  await rootSql?.end({ timeout: 5 });
});

describe('the declared event wake, end to end (P-008)', () => {
  it('pot:declare-wake registers the subscription as a live reaction rule', async () => {
    const out = await dispatch('pot:declare-wake', {
      harness: 'papercup',
      events: [{ on: 'plans:start', note: 'P-008 burst test' }],
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.mode).toBe('event');
    // EI-10525: her plans:start sub + the two uncovered defaults (work_items:create,
    // coord:escalate) are ensured. Her declared plans:start (with its note) wins for
    // that key, so the burst below still carries her provenance.
    expect(out.eventRules).toBe(3);
  });

  it('a burst of 3 matched events collapses to ONE wake, and the wake produces the launch', async () => {
    for (const p of ['burst-1', 'burst-2', 'burst-3']) await insertPlan(p);

    // The burst: three matched tool-events in quick succession.
    for (const p of ['burst-1', 'burst-2', 'burst-3']) {
      const out = await dispatch('plans:start', { slug: p, harness: 'papercup' });
      expect(out.transitioned).toBe(true);
    }

    // Floor-debounce: exactly ONE pot launch for the whole burst.
    await vi.waitFor(() => expect(launches()).toBe(1), { timeout: 5_000 });
    await settle();
    expect(launches()).toBe(1);

    // The wake produced an action: the pot blueprint launch, on the harness the
    // trigger ran in, with the declared subscription's provenance in the kickoff.
    const [blueprintId, launchOpts] = fireLaunchBlueprint.mock.calls[0] as unknown as [
      string,
      { installSlug: string; kickoff?: string },
    ];
    expect(blueprintId).toBe('coding');
    // EI-7217: the 'papercup' harness slug this test dispatches with is canonicalized
    // to 'papercusp' (RETIRED_HARNESS_SLUG_ALIASES, the 2026-06-19 papercup->papercusp
    // rename-compat shim) by the time it reaches the launch — the CANONICAL name is
    // what a real launch actually uses.
    expect(launchOpts.installSlug).toBe('papercusp');
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

  it('EI-10525: re-declaring with no events replaces her CUSTOM subs but KEEPS the default demand subs armed', async () => {
    const out = await dispatch('pot:declare-wake', { harness: 'papercup', mode: 'none' });
    expect(out.ok).toBe(true);
    // Always-armed invariant: the three defaults survive a mode:'none' re-declaration
    // (her custom plans:start note is replaced by the default plans:start sub). This
    // USED to persist [] and go fully dark to demand — the EI-10525 clobber.
    expect(out.eventRules).toBe(3);
    expect(out.mode).toBe('event');

    await clearWakeFloor();
    await insertPlan('after-clear');
    const started = await dispatch('plans:start', { slug: 'after-clear', harness: 'papercup' });
    expect(started.transitioned).toBe(true);
    // the DEFAULT plans:start demand wake is still armed → this transition wakes again
    await vi.waitFor(() => expect(launches()).toBe(3), { timeout: 5_000 });
  });
});
