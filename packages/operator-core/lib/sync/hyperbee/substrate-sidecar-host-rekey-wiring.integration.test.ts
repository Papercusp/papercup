/**
 * substrate-sidecar-host-rekey-wiring.integration.test.ts — EI-521 (WI-971,
 * D-037): the SIDECAR must wire the outbox DRAIN on the RE-KEY that brings a
 * joined/created hive harness onto its Hive-pubkey federation topic, not only on
 * BOOT.
 *
 * THE LIVE GAP (run10 WS-DIAG, all-fixes .deb): in SUBSTRATE_SIDECAR mode the
 * main-process `rekeyHarness` SKIPS its own send-side wiring for a
 * `RemoteBootedHarnessHandle` (boot-all.ts: `!(handle instanceof
 * RemoteBootedHarnessHandle)`), delegating to the sidecar — but
 * `substrate-sidecar-host` wired the drain ONLY in `handleBootHarness` (boot),
 * NOT in `handleRekey`. `rekeyHarness` is the SOLE production route bringing a
 * JOINED (joinHiveAsView step 2c) / from-repo-CREATED (publishCreatedHive
 * "go shared") hive harness onto the Hive topic, so its `substrate_outbox` stayed
 * UNDRAINED forever: content captured, peer_connected, never federated (the live
 * cross-machine blocker — 10 undrained rows despite peer_connected, 0 drain loops).
 *
 * This is the SIDECAR-path twin of `rekey-send-side-wiring.integration.test.ts`
 * (which drives the in-process `rekeyHarness`, D-034). It drives the host's
 * `substrate:bootHarness` → `substrate:rekey` RPCs over a REAL testcontainer PG
 * with the REAL `startOutboxDrain` loop.
 *
 * Isolating the RE-KEY wiring: `handleBootHarness` already wires on boot (that
 * code is unchanged), so to prove the re-key wiring is load-bearing the injected
 * `wireOutbox` FAILS on the boot call (modeling the live "0 drain loops at boot"
 * — boot wiring never took) and succeeds when retried. Only a re-key that
 * RE-wires (the idempotent retry) then starts the real drain.
 *
 *   Pre-fix:  handleRekey did `booted.rekey(binding)` and returned → the
 *             boot-failed wiring is never retried → drained_at stays null →
 *             FAILS (vi.waitFor times out).
 *   Post-fix: handleRekey also calls ensureRelocatedSendSideWired → the
 *             idempotent retry starts the real drain → drained_at is set → PASSES.
 *
 * A second case proves the safety contract D-037 calls out ("idempotent — safe if
 * already wired from boot"): when boot wiring SUCCEEDS, the re-key does NOT start
 * a second drain loop (a double drain would double-append + double-GC the outbox).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { createSubstrateSidecarHost } from './substrate-sidecar-host';
import { startOutboxDrain } from './outbox-drain';
import { makeFakeBootedHandle } from './__tests__/fake-booted-handle';
import type { BootedHarnessHandle, BootHarnessOpts, LocalWriteOp } from './boot';
import type { SwarmBinding } from './derive-swarm-topic';

const WS = 'ws_sidecar_rekey';
const SLUG = 'sidecar-rekey-member';
const BINDING: SwarmBinding = { kind: 'topic', topic_hex: 'a'.repeat(64) };

/**
 * A fake booted handle for the host's bootHarnessImpl. Reuses the shared fake
 * (records `append`ed ops, has a `rekey` spy) but swaps in REAL close-hook
 * semantics so `host.closeAll()` → `booted.close()` actually runs the drain's
 * stop() hook (the shared fake's registerCloseHook/close are no-ops).
 */
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

async function seedOutbox(sql: postgres.Sql, key: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.substrate_outbox
      (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at)
    VALUES
      (${WS}, ${SLUG}, 'harness_features_consolidated', 'put', ${key},
       ${sql.json(featureRow(key) as unknown as Parameters<typeof sql.json>[0])},
       ${Date.now()}, ${null})`;
}

async function undrainedCount(sql: postgres.Sql): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND drained_at IS NULL`;
  return n;
}

describe('substrate-sidecar-host — EI-521: handleRekey wires the REAL outbox drain', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('sidecar_rekey_wire');
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

  it('re-key STARTS the drain when boot-time wiring never took → undrained rows get drained_at set', async () => {
    const fake = makeFake();

    // ensureRelocatedSendSideWired swallows + console.error()s the failed boot-time
    // wiring leg (best-effort by design). That console.error is EXPECTED here, so
    // mock it out (vitest-fail-on-console otherwise fails the test) and assert it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The injected outbox wiring: FAIL on the boot call (live: "0 drain loops" —
    // boot wiring never started a drain), then start the REAL drain when the
    // re-key retries it. The host's idempotence guard only marks a leg wired on
    // SUCCESS, so the failed boot leg stays un-wired and the re-key re-attempts it.
    let wireCalls = 0;
    const host = createSubstrateSidecarHost({
      bootHarnessImpl: (async () => fake.handle) as (opts: BootHarnessOpts) => Promise<BootedHarnessHandle>,
      wireOutbox: async (h) => {
        wireCalls += 1;
        if (wireCalls === 1) {
          // Expected: swallowed + logged by ensureRelocatedSendSideWired (best-effort).
          throw new Error('simulated boot-time outbox wiring failure (0 drain loops at boot)');
        }
        const drain = startOutboxDrain(h, db.sql, { pollMs: 50 });
        h.registerCloseHook(() => drain.stop());
      },
      wirePresence: async () => {},
    });

    const boot = (await host.methods['substrate:bootHarness']({
      workspaceId: WS,
      harnessSlug: SLUG,
    })) as { storeId: string };
    expect(wireCalls).toBe(1); // boot attempted wiring — and it failed (no drain running)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[substrate-sidecar-host] outbox wiring failed'),
      expect.stringContaining('simulated boot-time outbox wiring failure'),
    );

    // Content captured into the outbox (the mig-102 trigger's job) but undrained,
    // sitting on a peer_connected-but-undrained harness — the live state.
    await seedOutbox(db.sql, 'F-SIDECAR-1');
    expect(await undrainedCount(db.sql)).toBe(1);

    // The production seam: the main-process RemoteBootedHarnessHandle.rekey() →
    // `substrate:rekey`. Brings the harness onto its Hive federation topic.
    const result = (await host.methods['substrate:rekey']({
      storeId: boot.storeId,
      binding: BINDING,
    })) as { ok: boolean; rekeyed: boolean };

    expect(result.rekeyed).toBe(true);
    expect(fake.handle.rekey).toHaveBeenCalledWith(BINDING);

    // THE ASSERTION: the re-key re-wired the send-side, so the REAL startOutboxDrain
    // loop (not a manual drainOutboxOnce) drains the captured row. Pre-fix
    // handleRekey never re-wired → drained_at stays null → waitFor times out → FAIL.
    await vi.waitFor(async () => expect(await undrainedCount(db.sql)).toBe(0), {
      timeout: 5000,
      interval: 50,
    });
    expect(wireCalls).toBe(2); // the re-key retried the wiring (the fix)

    // And the drained row was appended to the harness's own log (federation send-side).
    expect(fake.appended.map((a) => [a.table, a.type, a.hbKey])).toEqual([
      ['features-by-id', 'put', 'F-SIDECAR-1'],
    ]);

    await host.closeAll();
    errSpy.mockRestore();
  });

  it('re-key is idempotent: it does NOT start a second drain when boot already wired', async () => {
    const fake = makeFake();

    // Boot-time wiring SUCCEEDS here (the common path). The re-key must then be a
    // no-op — a second drain loop would double-append + double-GC the same outbox.
    let wireCalls = 0;
    const host = createSubstrateSidecarHost({
      bootHarnessImpl: (async () => fake.handle) as (opts: BootHarnessOpts) => Promise<BootedHarnessHandle>,
      wireOutbox: async (h) => {
        wireCalls += 1;
        const drain = startOutboxDrain(h, db.sql, { pollMs: 50 });
        h.registerCloseHook(() => drain.stop());
      },
      wirePresence: async () => {},
    });

    const boot = (await host.methods['substrate:bootHarness']({
      workspaceId: WS,
      harnessSlug: SLUG,
    })) as { storeId: string };
    expect(wireCalls).toBe(1); // boot wired the drain

    // The boot-wired drain already drains a seeded row.
    await seedOutbox(db.sql, 'F-SIDECAR-2');
    await vi.waitFor(async () => expect(await undrainedCount(db.sql)).toBe(0), {
      timeout: 5000,
      interval: 50,
    });

    // Re-key onto the Hive topic — must NOT wire a second drain (already wired).
    const result = (await host.methods['substrate:rekey']({
      storeId: boot.storeId,
      binding: BINDING,
    })) as { rekeyed: boolean };
    expect(result.rekeyed).toBe(true);
    expect(fake.handle.rekey).toHaveBeenCalledWith(BINDING);
    expect(wireCalls).toBe(1); // idempotent — the re-key did NOT re-wire

    await host.closeAll();
  });
});
