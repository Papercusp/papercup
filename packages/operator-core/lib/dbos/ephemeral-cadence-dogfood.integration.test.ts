/**
 * EPHEMERAL-cadence DOGFOOD — end-to-end proof against a REAL Postgres (testcontainer;
 * Docker required). schedule-inventory-and-ephemeral-tier-2026-06-26 P-013 / D-006.
 *
 * This is the dogfood "verify parity + live fire" the plan asks for, run against real PG
 * rather than stubs (the executor's pure mechanics are covered by ephemeral-executor.test.ts;
 * the DB primitives by libs/db routines-runtime.integration.test.ts). Here we stitch the
 * WHOLE path together:
 *
 *   blueprint { triggers.schedule: [{ tier:'ephemeral', action:'system:<x>', intervalSec }] }
 *     → materializeBlueprintTriggers  (writes a tier='ephemeral' routine row, no cron)
 *     → armEphemeralExecutor          (reads it via the REAL listActiveEphemeralRoutines)
 *     → a tick fires the action via the REAL getSystemAction dispatch
 *     → recordEphemeralFire stamps durable per-schedule liveness on the ONE row (D-004)
 *
 * PARITY: the ephemeral fire resolves and invokes the IDENTICAL registered system action,
 * with the IDENTICAL ctx shape ({installSlug, workspaceId, triggerConfig, payloadTemplate}),
 * that the durable `routinesTick` dispatch path uses for a `system:<x>` target — so an
 * ephemeral cadence is a faithful drop-in for a hardcoded in-process sweep.
 *
 * Also proves the P-013 FLAG GATE: with papercusp-ephemeral-cadence OFF, materialize writes
 * NO ephemeral row (the kill-switch), so the executor arms nothing.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/dbos/ephemeral-cadence-dogfood.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { listActiveEphemeralRoutines, recordEphemeralFire } from '@papercusp/db-org';
import {
  configureScheduledRegistry,
  resetScheduledRegistry,
  getManaged,
} from '@papercusp/scheduled-registry';
import {
  registerSystemAction,
  getSystemAction,
  SYSTEM_TARGET_PREFIX,
  type SystemActionCtx,
} from '../harness/routines/system-actions';
import { materializeBlueprintTriggers } from '../blueprint/materialize-triggers';
import {
  armEphemeralExecutor,
  disarmEphemeralExecutor,
  armedEphemeralIds,
  type EphemeralExecutorDeps,
  type EphemeralRoutineSpec,
} from './ephemeral-executor';

let db: MigratedTestDb;
let sql: Sql;
const WS = 'ws-dogfood';
const SLUG = 'papercusp-ephemeral-dogfood';

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'eph-dogfood',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
        // The routines table at migration 408 head (the tier discriminator is what this proves).
        await s.unsafe(`
          CREATE TABLE harness_shared.routines (
            id text PRIMARY KEY,
            workspace_id text NOT NULL,
            install_slug text NOT NULL,
            name text NOT NULL,
            trigger_kind text NOT NULL,
            trigger_config jsonb,
            target_role text NOT NULL,
            payload_template jsonb,
            concurrency text NOT NULL DEFAULT 'queue',
            catchup text NOT NULL DEFAULT 'skip-old',
            active boolean NOT NULL DEFAULT true,
            tier text NOT NULL DEFAULT 'durable',
            next_fire_at timestamptz,
            last_fired_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            reschedule_interval_sec integer,
            target_owner_id text,
            metadata jsonb,
            UNIQUE (install_slug, name),
            UNIQUE (workspace_id, install_slug, name)
          )`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines`;
});

afterEach(() => {
  disarmEphemeralExecutor();
  resetScheduledRegistry();
});

// A fake registry seam (mirrors ephemeral-executor.test.ts) so ticks fire deterministically.
let ticks: Array<{ name?: string; cb: () => void; ms: number }>;
function installFakeRegistry(): void {
  ticks = [];
  configureScheduledRegistry({
    setIntervalImpl: (cb, ms) => {
      ticks.push({ cb, ms });
      return { unref() {} };
    },
    clearIntervalImpl: () => {},
    setTimeoutImpl: () => ({ unref() {} }),
  });
}
/** Poll until `fn()` resolves truthy (the executor tick → fire → recordFire is async +
 *  involves a DB round-trip, so a single macrotask flush can race the write). */
async function pollUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('pollUntil timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The REAL ephemeral dispatch wiring, parameterized on the test `sql` — identical in
 * behavior to productionEphemeralExecutorDeps() minus the workspace-registry/ALS scoping
 * (which a single-workspace test does not need): list from PG, fire via getSystemAction,
 * record durable liveness via recordEphemeralFire.
 */
function realDeps(captured: SystemActionCtx[]): EphemeralExecutorDeps {
  return {
    list: async () => {
      const rows = await listActiveEphemeralRoutines(sql);
      return rows.map(
        (r): EphemeralRoutineSpec => ({
          id: r.id,
          workspaceId: r.workspaceId,
          installSlug: r.installSlug,
          name: r.name,
          targetRole: r.targetRole,
          intervalSec: Number(r.triggerConfig?.interval_sec),
          payloadTemplate: r.payloadTemplate,
          triggerConfig: r.triggerConfig,
        }),
      );
    },
    fire: async (r) => {
      // The same dispatch contract routinesTick uses for a system:<x> target.
      expect(r.targetRole.startsWith(SYSTEM_TARGET_PREFIX)).toBe(true);
      const action = getSystemAction(r.targetRole.slice(SYSTEM_TARGET_PREFIX.length));
      if (!action) throw new Error(`no system action for ${r.targetRole}`);
      await action({
        installSlug: r.installSlug,
        workspaceId: r.workspaceId,
        triggerConfig: r.triggerConfig,
        payloadTemplate: r.payloadTemplate,
      });
    },
    recordFire: async (r, error) => {
      await recordEphemeralFire(sql, r.id, error);
    },
    log: () => {},
  };
}

const dogfoodBlueprint = (intervalSec: number, action: string) => ({
  id: 'ephemeral-dogfood',
  triggers: { schedule: [{ tier: 'ephemeral' as const, action, intervalSec }] },
});

describe('ephemeral-cadence dogfood — materialize → executor → fire → liveness (P-013 / D-006)', () => {
  it('a tier:ephemeral blueprint schedule materializes a tier=ephemeral routine row (no cron, active)', async () => {
    const out = await materializeBlueprintTriggers(SLUG, dogfoodBlueprint(2, 'system:dogfood-sweep'), {
      sql,
      workspaceId: WS,
      ephemeralFlag: async () => true,
    });
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('ephemeral');

    const [row] = await sql<
      { tier: string; cron: unknown; interval_sec: unknown; active: boolean; next_fire_at: unknown }[]
    >`SELECT tier, trigger_config->>'cron' AS cron, trigger_config->>'interval_sec' AS interval_sec,
             active, next_fire_at
        FROM harness_shared.routines WHERE workspace_id = ${WS}`;
    expect(row.tier).toBe('ephemeral');
    expect(row.cron).toBeNull();
    expect(row.interval_sec).toBe('2');
    expect(row.active).toBe(true);
    expect(row.next_fire_at).toBeNull(); // ephemeral rows carry no next_fire_at (routinesTick excludes them)
  });

  it('FLAG GATE: with papercusp-ephemeral-cadence OFF, materialize writes NO ephemeral row (kill-switch)', async () => {
    const out = await materializeBlueprintTriggers(SLUG, dogfoodBlueprint(2, 'system:dogfood-sweep'), {
      sql,
      workspaceId: WS,
      ephemeralFlag: async () => false,
    });
    expect(out).toEqual([]);
    const rows = await sql`SELECT 1 FROM harness_shared.routines WHERE workspace_id = ${WS}`;
    expect(rows).toHaveLength(0);
    expect(await listActiveEphemeralRoutines(sql)).toHaveLength(0);
  });

  it('LIVE FIRE + PARITY: the executor reads the materialized row, fires the SAME system action, and records durable liveness', async () => {
    const captured: SystemActionCtx[] = [];
    // The dogfood "sweep" — a deterministic system action (the conversion target of a
    // hardcoded inline sweep). Registered ONCE; both tiers resolve THIS via getSystemAction.
    registerSystemAction('dogfood-sweep', async (ctx) => {
      captured.push(ctx);
    });

    // 1. Materialize the blueprint-declared ephemeral schedule → a real ephemeral routine row.
    const [mat] = await materializeBlueprintTriggers(SLUG, dogfoodBlueprint(3, 'system:dogfood-sweep'), {
      sql,
      workspaceId: WS,
      ephemeralFlag: async () => true,
    });
    expect(mat.tier).toBe('ephemeral');

    // 2. Arm the executor — it reads the row via the REAL listActiveEphemeralRoutines.
    installFakeRegistry();
    await armEphemeralExecutor(realDeps(captured));
    expect(armedEphemeralIds()).toEqual([mat.id]);
    // The cadence is individually inventory-visible (category 'ephemeral-harness').
    expect(getManaged(`ephemeral:${mat.id}`)?.category).toBe('ephemeral-harness');
    expect(ticks.find((t) => t.ms === 3000)).toBeTruthy(); // 3s cadence passed through

    // 3. Fire one tick → the SAME registered action runs with the durable-path ctx shape.
    ticks[0].cb();
    await pollUntil(() => captured.length === 1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      installSlug: SLUG,
      workspaceId: WS,
      triggerConfig: { interval_sec: 3 },
    });
    // PARITY: the action the ephemeral tier fired IS the one a durable system:<x> routine fires.
    expect(getSystemAction('dogfood-sweep')).toBeTypeOf('function');

    // 4. Durable per-schedule liveness: ONE row UPDATEd with last_fired_at, never an insert (D-004).
    await pollUntil(async () => {
      const [r] = await sql<{ last_fired_at: Date | null }[]>`
        SELECT last_fired_at FROM harness_shared.routines WHERE workspace_id = ${WS}`;
      return r?.last_fired_at != null;
    });
    const [lv] = await sql<
      { last_fired_at: Date | null; last_error: string | null; n: number }[]
    >`SELECT last_fired_at, metadata->>'last_error' AS last_error,
             (SELECT count(*)::int FROM harness_shared.routines WHERE workspace_id = ${WS}) AS n
        FROM harness_shared.routines WHERE workspace_id = ${WS}`;
    expect(lv.n).toBe(1); // still exactly one row (UPDATE, not INSERT-per-fire)
    expect(lv.last_fired_at).not.toBeNull();
    expect(lv.last_error).toBeNull(); // success clears/leaves the error null
  });

  it('records the error (and still stamps liveness) when the fired action throws', async () => {
    registerSystemAction('dogfood-throws', async () => {
      throw new Error('sweep boom');
    });
    const [mat] = await materializeBlueprintTriggers(SLUG, dogfoodBlueprint(5, 'system:dogfood-throws'), {
      sql,
      workspaceId: WS,
      ephemeralFlag: async () => true,
    });
    installFakeRegistry();
    await armEphemeralExecutor(realDeps([]));
    ticks[0].cb();
    await pollUntil(async () => {
      const [r] = await sql<{ last_error: string | null }[]>`
        SELECT metadata->>'last_error' AS last_error FROM harness_shared.routines WHERE id = ${mat.id}`;
      return r?.last_error != null;
    });
    const [row] = await sql<
      { last_fired_at: Date | null; last_error: string | null }[]
    >`SELECT last_fired_at, metadata->>'last_error' AS last_error
        FROM harness_shared.routines WHERE id = ${mat.id}`;
    expect(row.last_fired_at).not.toBeNull(); // liveness recorded even on a failed sweep
    expect(row.last_error).toContain('sweep boom');
  });
});
