/**
 * standalone-boot-sidecar-routing.integration.test.ts — the run-11 cross-machine
 * blocker (plan shared-hive-member-content-federation-2026-06-20).
 *
 * ## The live bug this closes
 * In SUBSTRATE_SIDECAR mode the OWNER creates a shared hive + content harness at
 * RUNTIME, writes plans/parts/work-items (captured into `harness_shared.substrate_outbox`
 * under workspace_id='default'), then PUBLISHES. Publish brings the content harness
 * onto the Hive topic via `publishCreatedHive` → `rekeyHarness(ws, slug)`. The
 * joiner connects (`peer_connected`), but the owner's outbox is NEVER drained
 * (`drained_at` stays NULL) → federation = 0 in both directions.
 *
 * ROOT CAUSE: the sidecar `bootHarness` factory + `skipSendSideWiring:true` were
 * wired into ONLY the single `bootAllHarnessesForActiveWorkspace(...)` call at
 * host-bootstrap. They were never registered process-globally, so a STANDALONE
 * `rekeyHarness`/`bootSingleHarness` (owner `publishCreatedHive`, joiner
 * `joinHiveAsView`/`join-shared-harness`) for a harness created AFTER bootstrap
 * (never in the registry the bootstrap sweep read) fell back to the IN-PROCESS
 * `bootHarnessSubstrate` — the WRONG process (the sidecar owns every corestore;
 * Corestore's process-level file lock makes a second-process boot non-viable). The
 * sidecar's `ensureRelocatedSendSideWired` (which starts the outbox drain) therefore
 * NEVER ran → the drain never started → the outbox never drained.
 *
 * ## Why the PRIOR sidecar tests missed it
 * `substrate-sidecar-host-rekey-wiring.integration.test.ts` drives `host.methods`
 * DIRECTLY — i.e. it ASSUMES the main process already routed to the sidecar. The
 * live bug is precisely that the main-process STANDALONE path NEVER routes to the
 * sidecar for a post-bootstrap harness. This test drives the REAL main-process
 * seam `boot-all.rekeyHarness` / `bootSingleHarness` (exactly what
 * `publishCreatedHive` / `join-shared-harness` call), with the sidecar registered
 * the way `bootSubstrateWithFallback` registers it (`setSubstrateBootDefaults`).
 *
 *   Pre-fix:  `rekeyHarness`/`bootSingleHarness` ignore the registered sidecar
 *             defaults → fall to in-process `bootHarnessSubstrate` (here mocked to
 *             THROW, modeling the corestore-lock non-viability) → boot fails →
 *             the sidecar never boots the harness (`storeCount()===0`) → the drain
 *             never starts → `drained_at` stays NULL → FAILS.
 *   Post-fix: they consult the process-global default → route to the sidecar →
 *             `handleBootHarness` → `ensureRelocatedSendSideWired` → the REAL
 *             `startOutboxDrain` loop → `drained_at` is set → PASSES.
 *
 * Real: testcontainer Postgres + the REAL `startOutboxDrain` loop + the REAL
 * `boot-all` boot/rekey functions + a REAL `RemoteBootedHarnessHandle` over an
 * in-process RPC caller bound to a REAL `createSubstrateSidecarHost`. Stood in: the
 * corestore/swarm (the sidecar's `bootHarnessImpl` returns a fake handle that
 * records `append`s — irrelevant to the boot-routing + drain-wiring seam under test).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { createSubstrateSidecarHost } from './substrate-sidecar-host';
import { startOutboxDrain } from './outbox-drain';
import { makeFakeBootedHandle } from './__tests__/fake-booted-handle';
import { RemoteBootedHarnessHandle, type SubstrateRpcCaller } from './remote-booted-harness';
import {
  rekeyHarness,
  bootSingleHarness,
  setSubstrateBootDefaults,
  _resetSubstrateBootDefaultsForTests,
  _resetHandleMapForTests,
  closeAllBootedHarnesses,
} from './boot-all';
import type { BootedHarnessHandle, BootHarnessOpts, LocalWriteOp } from './boot';
import type { SwarmBinding } from './derive-swarm-topic';

// In SUBSTRATE_SIDECAR mode the in-process `bootHarnessSubstrate` must NEVER run —
// the corestore lives in (and is process-locked by) the sidecar. Mock it to throw,
// modeling that non-viability: PRE-fix the standalone path falls back to it and the
// boot fails (so the assertion fails cleanly); POST-fix the standalone path routes
// to the sidecar and never touches this.
vi.mock('./boot', () => ({
  bootHarnessSubstrate: vi.fn(async () => {
    throw new Error(
      'in-process bootHarnessSubstrate must not run in SUBSTRATE_SIDECAR mode (corestore process-lock)',
    );
  }),
}));

const WS = 'default'; // the live owner captures content under workspace_id='default'
const SLUG = 'amem-standalone-owner'; // a runtime-created content-harness-shaped slug
const BINDING: SwarmBinding = { kind: 'topic', topic_hex: 'a'.repeat(64) };

/** A fake booted handle for the sidecar host's bootHarnessImpl — records appends and
 *  runs REAL close-hook semantics so `host.closeAll()` stops the drain it wires. */
function makeFake(): { handle: BootedHarnessHandle; appended: LocalWriteOp[] } {
  const base = makeFakeBootedHandle({ workspaceId: WS, harnessSlug: SLUG });
  const hooks = new Set<() => void | Promise<void>>();
  base.handle.registerCloseHook = (hook) => {
    hooks.add(hook);
    return () => hooks.delete(hook);
  };
  base.handle.close = async () => {
    for (const h of [...hooks]) {
      try {
        await h();
      } catch {
        /* best-effort, mirrors production close */
      }
    }
  };
  return { handle: base.handle, appended: base.appended };
}

const featureRow = (id: string) => ({
  workspace_id: WS,
  harness_slug: SLUG,
  feature_id: id,
  title: `T ${id}`,
  summary: 's',
  status: 'todo',
  attempts: 0,
  claims: null,
  notes: null,
  metadata: null,
  kind: null,
  project_id: null,
  expected_cost_cents: null,
  tags: null,
  needs_human_review: false,
  ts: 1,
  created_ts: 1,
  updated_ts: 1,
  parent_id: null,
  goal_id: null,
  taken_by: null,
  taken_at: null,
  expires_at: null,
  origin: 'local',
});

async function seedOutbox(sql: postgres.Sql, slug: string, key: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.substrate_outbox
      (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at)
    VALUES
      (${WS}, ${slug}, 'harness_features_consolidated', 'put', ${key},
       ${sql.json({ ...featureRow(key), harness_slug: slug } as unknown as Parameters<typeof sql.json>[0])},
       ${Date.now()}, ${null})`;
}

async function undrainedCount(sql: postgres.Sql, slug: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${WS} AND harness_slug = ${slug} AND drained_at IS NULL`;
  return n;
}

/**
 * Register the sidecar boot defaults exactly the way `bootSubstrateWithFallback`
 * does — but pointed at an IN-PROCESS host (no socket). Returns the host + its fake
 * (whose `append`s the drain carries to the own log).
 */
function installSidecar(db: FreshPgDb): {
  host: ReturnType<typeof createSubstrateSidecarHost>;
  fake: ReturnType<typeof makeFake>;
} {
  const fake = makeFake();
  const host = createSubstrateSidecarHost({
    bootHarnessImpl: (async () => fake.handle) as (opts: BootHarnessOpts) => Promise<BootedHarnessHandle>,
    // The real send-side wiring: start the REAL drain loop on the test PG and register
    // its stop() as a close-hook (mirrors wire-outbox.ts).
    wireOutbox: async (h) => {
      const drain = startOutboxDrain(h, db.sql, { pollMs: 50 });
      h.registerCloseHook(() => drain.stop());
    },
    wirePresence: async () => {},
  });
  const caller: SubstrateRpcCaller = {
    call: <T>(method: string, params?: unknown) =>
      Promise.resolve(host.methods[method](params)) as Promise<T>,
  };
  const sidecarBootHarness = async (bootOpts: BootHarnessOpts): Promise<BootedHarnessHandle> => {
    const booted = (await host.methods['substrate:bootHarness']({
      workspaceRoot: bootOpts.workspaceRoot,
      workspaceId: bootOpts.workspaceId,
      harnessSlug: bootOpts.harnessSlug,
      swarmBinding: bootOpts.swarmBinding ?? null,
    })) as { storeId: string; ownLogKey: string; ownLogLength?: number };
    return new RemoteBootedHarnessHandle({
      workspaceId: bootOpts.workspaceId,
      harnessSlug: bootOpts.harnessSlug,
      storeId: booted.storeId,
      ownLogKey: booted.ownLogKey,
      ownLogLength: booted.ownLogLength,
      client: caller,
    });
  };
  setSubstrateBootDefaults({ bootHarness: sidecarBootHarness, skipSendSideWiring: true });
  return { host, fake };
}

describe('standalone boot routing — SUBSTRATE_SIDECAR (run-11 federation blocker)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('standalone_sidecar_route');
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.substrate_outbox (
        id           BIGSERIAL PRIMARY KEY,
        workspace_id TEXT   NOT NULL,
        harness_slug TEXT   NOT NULL,
        table_name   TEXT   NOT NULL,
        op           TEXT   NOT NULL CHECK (op IN ('put', 'del')),
        key          TEXT   NOT NULL,
        row          JSONB,
        ts           BIGINT NOT NULL,
        enqueued_at_ms BIGINT NOT NULL DEFAULT ((EXTRACT(epoch FROM now()) * 1000)::bigint),
        drained_at   BIGINT,
        -- mig 495 (WI-2136): the drain now stamps the own-log key it appended into
        drained_log_key TEXT
      );
      CREATE INDEX substrate_outbox_drain_idx
        ON harness_shared.substrate_outbox (workspace_id, harness_slug, drained_at, id);
    `);
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.substrate_outbox RESTART IDENTITY`;
  });

  afterEach(async () => {
    _resetSubstrateBootDefaultsForTests();
    await closeAllBootedHarnesses();
    _resetHandleMapForTests();
  });

  it('OWNER publish seam: rekeyHarness routes an unbooted content harness to the sidecar → drain wires', async () => {
    const { host, fake } = installSidecar(db);

    // The content captured at runtime (plans/parts/work-items/features) sits undrained,
    // on a harness the bootstrap sweep never booted (created post-bootstrap).
    await seedOutbox(db.sql, SLUG, 'F-OWNER-1');
    expect(await undrainedCount(db.sql, SLUG)).toBe(1);

    // THE PRODUCTION SEAM: publishCreatedHive calls exactly `rekeyHarness(ws, slug)`.
    // (resolveSwarmBinding injected only to keep binding resolution hermetic — it is
    // orthogonal to the boot-routing + drain-wiring property under test.)
    const res = await rekeyHarness(WS, SLUG, { resolveSwarmBinding: async () => BINDING });

    // It was not booted → a fresh boot through the sidecar (rekeyed:false, boot 'booted').
    expect(res.rekeyed).toBe(false);
    expect(res.boot?.state).toBe('booted');

    // POST-FIX: the SIDECAR booted it (the standalone path consulted the global default).
    // PRE-FIX: the in-process bootHarnessSubstrate ran (mocked → threw) → boot failed →
    // the sidecar never booted it → storeCount()===0 (and res.boot.state==='failed').
    expect(host.storeCount()).toBe(1);

    // The REAL startOutboxDrain loop the sidecar wired drains the captured row.
    await vi.waitFor(async () => expect(await undrainedCount(db.sql, SLUG)).toBe(0), {
      timeout: 5000,
      interval: 50,
    });

    // And the drained row was appended to the harness's own log (federation send-side).
    expect(fake.appended.map((a) => [a.table, a.type, a.hbKey])).toEqual([
      ['features-by-id', 'put', 'F-OWNER-1'],
    ]);
  });

  it('JOINER seam: bootSingleHarness routes an unbooted member harness to the sidecar → drain wires', async () => {
    const { host } = installSidecar(db);

    const joinerSlug = SLUG; // the fake/host are bound to SLUG
    await seedOutbox(db.sql, joinerSlug, 'F-JOIN-1');
    expect(await undrainedCount(db.sql, joinerSlug)).toBe(1);

    // The production seam: join-shared-harness stepBootFederate calls `bootSingleHarness(ws, slug)`.
    const r = await bootSingleHarness(WS, joinerSlug, { resolveSwarmBinding: async () => BINDING });
    expect(r.state).toBe('booted');
    expect(host.storeCount()).toBe(1);

    await vi.waitFor(async () => expect(await undrainedCount(db.sql, joinerSlug)).toBe(0), {
      timeout: 5000,
      interval: 50,
    });
  });
});
