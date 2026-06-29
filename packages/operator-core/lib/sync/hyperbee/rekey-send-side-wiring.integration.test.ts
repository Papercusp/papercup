/**
 * rekey-send-side-wiring.integration.test.ts — EI-521 (WI-971): the SEND-side
 * outbox DRAIN must RUN for a joined/created hive harness.
 *
 * THE GAP this test pins (real testcontainer PG, the REAL startOutboxDrain loop):
 * a joined/created hive harness's ONLY route onto its Hive federation topic is
 * `rekeyHarness` (publishCreatedHive's "go shared" + joinHiveAsView step 2c). A
 * re-key joins the topic IN PLACE so the harness peer_connects — but, unlike
 * `bootSingleHarness`, the existing-handle branch never wired the outbox DRAIN. So
 * a harness booted WITHOUT its send-side wired stayed peer_connected with its
 * `substrate_outbox` UNDRAINED forever: content captured, never federated (the
 * live cross-machine blocker — 10 undrained rows on the peer despite
 * peer_connected, ZERO drain loops).
 *
 * Why this catches what the other federation tests miss: they call
 * `drainOutboxOnce` MANUALLY, so they never exercise whether the boot/re-key path
 * actually STARTS a drain loop. This one drives the production seam
 * (`rekeyHarness`) and asserts the REAL `startOutboxDrain` loop sets `drained_at`
 * — no manual drain anywhere.
 *
 * Pre-fix: rekeyHarness's existing-handle branch did `handle.rekey(binding)` and
 *          returned — `drained_at` stays null → this test FAILS (waitFor times out).
 * Post-fix: rekeyHarness also calls `ensureSendSideWired` → the real drain loop
 *          starts → `drained_at` is set → this test PASSES.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { startOutboxDrain } from './outbox-drain';
import {
  rekeyHarness,
  _setHandleForTests,
  _resetHandleMapForTests,
  closeAllBootedHarnesses,
} from './boot-all';
import type { BootedHarnessHandle, LocalWriteOp } from './boot';
import type { SwarmBinding } from './derive-swarm-topic';

const WS = 'ws_rekey_wire';
const SLUG = 'rekey-member';

/**
 * A minimal IN-PROCESS fake handle (NOT a RemoteBootedHarnessHandle) standing in
 * for a harness that is BOOTED + peer_connected but whose send-side was never
 * wired — the live "booted but undrained" state. It records every append, the
 * re-key binding, and runs its close-hooks on close() so the drain loop is torn
 * down (closeAllBootedHarnesses → handle.close()).
 */
function makeBootedButUnwiredHandle(): {
  handle: BootedHarnessHandle;
  appends: LocalWriteOp[];
  rekeys: SwarmBinding[];
} {
  const appends: LocalWriteOp[] = [];
  const rekeys: SwarmBinding[] = [];
  const hooks = new Set<() => void | Promise<void>>();
  const handle = {
    workspaceId: WS,
    harnessSlug: SLUG,
    async append(op: LocalWriteOp): Promise<void> {
      appends.push(op);
    },
    async rekey(binding: SwarmBinding): Promise<void> {
      rekeys.push(binding);
    },
    registerCloseHook(hook: () => void | Promise<void>) {
      hooks.add(hook);
      return () => hooks.delete(hook);
    },
    async close(): Promise<void> {
      for (const h of [...hooks]) {
        try {
          await h();
        } catch {
          /* best-effort, mirrors production close */
        }
      }
    },
    // Unused-by-this-path members of the interface — stubbed.
  } as unknown as BootedHarnessHandle;
  return { handle, appends, rekeys };
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

describe('rekeyHarness — EI-521: the in-place re-key wires the REAL outbox drain', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('rekey_wire');
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
        drained_at   BIGINT
      );
      CREATE INDEX substrate_outbox_drain_idx
        ON harness_shared.substrate_outbox (workspace_id, harness_slug, drained_at, id);
    `);
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    _resetHandleMapForTests();
    await db.sql`TRUNCATE harness_shared.substrate_outbox RESTART IDENTITY`;
  });

  afterEach(async () => {
    // Stop the real drain loop (clears its poll timer + LISTEN connection) and
    // reset the module's handle / wired-state maps so tests don't bleed.
    await closeAllBootedHarnesses();
    _resetHandleMapForTests();
  });

  it('re-keying a booted-but-unwired harness STARTS the drain → undrained rows get drained_at set', async () => {
    // A booted, peer_connected harness whose send-side was never wired (the live
    // state). _setHandleForTests injects it WITHOUT marking it send-side-wired.
    const { handle, appends, rekeys } = makeBootedButUnwiredHandle();
    _setHandleForTests(WS, SLUG, handle);

    // Content captured into the outbox (the mig-102 trigger's job) but undrained.
    await seedOutbox(db.sql, 'F-REKEY-1');
    expect(await undrainedCount(db.sql)).toBe(1);

    // The production seam: bring the harness onto its Hive federation topic.
    // wireSendSide injects the REAL startOutboxDrain loop bound to the test PG (so
    // we exercise the actual drain loop, NOT a manual drainOutboxOnce) and a no-op
    // presence wire. Pre-fix rekeyHarness never invokes wireOutbox here.
    const result = await rekeyHarness(WS, SLUG, {
      resolveSwarmBinding: async (): Promise<SwarmBinding> => ({
        kind: 'topic',
        topic_hex: 'a'.repeat(64),
      }),
      wireSendSide: {
        wireOutbox: async (h) => {
          const drain = startOutboxDrain(h, db.sql, { pollMs: 50 });
          h.registerCloseHook(() => drain.stop());
        },
        wirePresence: async () => {},
      },
    });

    // The re-key happened (joined the new topic in place).
    expect(result.rekeyed).toBe(true);
    expect(rekeys).toHaveLength(1);

    // THE ASSERTION: the REAL drain loop (not a manual drainOutboxOnce) drains the
    // captured row. Pre-fix this never happens → waitFor times out → test FAILS.
    await vi.waitFor(async () => expect(await undrainedCount(db.sql)).toBe(0), {
      timeout: 5000,
      interval: 50,
    });

    // And the drained row was appended to the harness's own log (federation send-side).
    expect(appends.map((a) => [a.table, a.type, a.hbKey])).toEqual([
      ['features-by-id', 'put', 'F-REKEY-1'],
    ]);
  });
});
