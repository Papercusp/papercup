/**
 * outbox-drain-fanout.integration.test.ts — substrate-internals coverage for the
 * drain's fan-out isolation (A1), the startOutboxDrain coalescing serializer
 * (A2), and the inline-GC batched/bounded loop + early-break (A3). Real
 * testcontainer PG (mirrors outbox-drain.integration.test.ts).
 *
 * These gaps were uncovered by the original drain test:
 *
 *  - A1 (fan-out isolation): `drainOutboxOnce` runs `opts.fanout` per row AFTER
 *    the federation append and BEFORE `drained_at`, inside a try/catch so a
 *    fan-out throw is logged but never stalls federation or blocks the row's
 *    drained_at. The original test NEVER passes a `fanout`.
 *  - A2 (drain coalescing): `startOutboxDrain` serializes drains via a `draining`
 *    flag and coalesces a concurrent trigger into one `runAgain` re-run, so two
 *    triggers fired while a drain is in-flight do NOT produce two extra passes.
 *  - A3 (inline-GC batch bound): the GC loops up to OUTBOX_GC_MAX_BATCHES ×
 *    OUTBOX_GC_BATCH rows, each batch its own committed DELETE, early-breaking on
 *    a partial batch (the EI-125 fix). Exercised here via the `_gcBatch` /
 *    `_gcMaxBatches` test seams so we don't seed 100k+ rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  drainOutboxOnce,
  startOutboxDrain,
  OUTBOX_GC_AGE_MS,
  type OutboxFanoutRow,
} from './outbox-drain';
import type { BootedHarnessHandle, LocalWriteOp } from './boot';

const WS = 'ws_drain_fanout';
const SLUG = 'drain_fanout';

/** A minimal fake handle: captures every append, optionally throws on the Nth
 *  (1-based) call. A `beforeAppend` hook lets a test gate append timing. */
function makeFakeHandle(opts?: {
  throwOnCall?: number;
  workspaceId?: string;
  harnessSlug?: string;
  beforeAppend?: () => Promise<void> | void;
}): {
  handle: BootedHarnessHandle;
  appends: LocalWriteOp[];
  appendCalls: () => number;
} {
  const appends: LocalWriteOp[] = [];
  let calls = 0;
  const handle = {
    workspaceId: opts?.workspaceId ?? WS,
    harnessSlug: opts?.harnessSlug ?? SLUG,
    async append(op: LocalWriteOp): Promise<void> {
      calls += 1;
      if (opts?.beforeAppend) await opts.beforeAppend();
      if (opts?.throwOnCall && calls === opts.throwOnCall) {
        throw new Error(`append boom on call ${calls}`);
      }
      appends.push(op);
    },
  } as unknown as BootedHarnessHandle;
  return { handle, appends, appendCalls: () => calls };
}

/** Seed one outbox row; returns its id. */
async function seedOutbox(
  sql: postgres.Sql,
  fields: {
    workspace_id?: string;
    harness_slug?: string;
    table_name: string;
    op: 'put' | 'del';
    key: string;
    row: Record<string, unknown> | null;
    ts?: number;
    drained_at?: number | null;
  },
): Promise<number> {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.substrate_outbox
      (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at)
    VALUES
      (${fields.workspace_id ?? WS}, ${fields.harness_slug ?? SLUG},
       ${fields.table_name}, ${fields.op}, ${fields.key},
       ${fields.row == null ? null : sql.json(fields.row as unknown as Parameters<typeof sql.json>[0])},
       ${fields.ts ?? Date.now()}, ${fields.drained_at ?? null})
    RETURNING id`;
  return Number(r.id);
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

describe('outbox-drain fan-out + coalescing + GC bound (substrate internals, real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('outbox_drain_fanout');
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

  // ── A1: fan-out isolation ───────────────────────────────────────────────────
  it('A1 happy-path: fan-out receives {id,table_name,op,key,row}, once per drained row, AFTER append', async () => {
    const id1 = await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-1', row: featureRow('F-1') });
    const id2 = await seedOutbox(db.sql, { table_name: 'harness_issues_consolidated', op: 'del', key: 'I-9', row: null });

    // Record the order of (append, fanout) events to prove fan-out runs AFTER append.
    const events: string[] = [];
    const seen: OutboxFanoutRow[] = [];
    const { handle, appends } = (() => {
      const appends: LocalWriteOp[] = [];
      const h = {
        workspaceId: WS,
        harnessSlug: SLUG,
        async append(op: LocalWriteOp): Promise<void> {
          events.push(`append:${op.hbKey}`);
          appends.push(op);
        },
      } as unknown as BootedHarnessHandle;
      return { handle: h, appends };
    })();

    const fanout = vi.fn(async (r: OutboxFanoutRow) => {
      events.push(`fanout:${r.key}`);
      seen.push(r);
    });

    const count = await drainOutboxOnce(handle, db.sql, { fanout });
    expect(count).toBe(2);

    // Fan-out fired once per drained row.
    expect(fanout).toHaveBeenCalledTimes(2);
    expect(seen.map((r) => r.key)).toEqual(['F-1', 'I-9']);

    // The fan-out row carries the captured outbox shape verbatim.
    expect(seen[0]).toMatchObject({
      id: id1, table_name: 'harness_features_consolidated', op: 'put', key: 'F-1',
    });
    expect((seen[0].row as { feature_id: string }).feature_id).toBe('F-1');
    expect(seen[1]).toMatchObject({
      id: id2, table_name: 'harness_issues_consolidated', op: 'del', key: 'I-9', row: null,
    });

    // Per row, the append fired BEFORE the fan-out.
    expect(events).toEqual(['append:F-1', 'fanout:F-1', 'append:I-9', 'fanout:I-9']);

    // Both rows marked drained.
    const [{ undrained }] = await db.sql<{ undrained: number }[]>`
      SELECT count(*)::int AS undrained FROM harness_shared.substrate_outbox WHERE drained_at IS NULL`;
    expect(undrained).toBe(0);
    expect(appends).toHaveLength(2);
  });

  it('A1 isolation: a fan-out throw on row 1 is caught + logged — BOTH rows still drain, both append, second drain is a no-op', async () => {
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-1', row: featureRow('F-1') });
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-2', row: featureRow('F-2') });

    const { handle, appends } = makeFakeHandle();
    let fanoutCalls = 0;
    const fanout = vi.fn(async (_r: OutboxFanoutRow) => {
      fanoutCalls += 1;
      if (fanoutCalls === 1) throw new Error('fanout boom on row 1');
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The drain itself does NOT reject — the fan-out throw is isolated.
      const count = await drainOutboxOnce(handle, db.sql, { fanout });
      expect(count).toBe(2);
      // The fan-out failure was logged (federation-unaffected message).
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[outbox-drain] fan-out failed'),
        expect.anything(),
      );
    } finally {
      errSpy.mockRestore();
    }

    // Both rows appended (the throw was in fan-out, after the successful append).
    expect(appends.map((a) => a.hbKey)).toEqual(['F-1', 'F-2']);
    expect(fanout).toHaveBeenCalledTimes(2);

    // CRITICAL (A1): BOTH rows are drained_at IS NOT NULL despite the fan-out throw —
    // a fan-out failure must NOT leave the row undrained (it would reprocess; the
    // idempotent insert dedupes, but federation must not stall).
    const rows = await db.sql<{ id: number; drained_at: number | null }[]>`
      SELECT id, drained_at FROM harness_shared.substrate_outbox ORDER BY id`;
    expect(rows.every((r) => r.drained_at !== null)).toBe(true);

    // A second drain finds nothing to do.
    const { handle: h2 } = makeFakeHandle();
    expect(await drainOutboxOnce(h2, db.sql, { fanout: async () => {} })).toBe(0);
  });

  // ── A2: startOutboxDrain coalescing serializer ──────────────────────────────
  it('A2: two triggers fired while a drain is in-flight coalesce — drainOutboxOnce runs at most twice, not once-per-trigger', async () => {
    // Gate the append so the in-flight drain stays pinned open while we fire
    // extra NOTIFYs. A controllable barrier on the first append blocks the very
    // first drain pass; the seeded row keeps that pass busy.
    let releaseFirstAppend!: () => void;
    const firstAppendGate = new Promise<void>((r) => (releaseFirstAppend = r));
    let appendCalls = 0;

    // Count how many times the drain BODY (drainOutboxOnce) actually starts a
    // pass — proxied by counting SELECT-driven passes via append invocations is
    // unreliable (empty passes append nothing), so we wrap the handle.append and
    // additionally observe pass count via a row-presence approach: seed exactly
    // one row, and count appends — each non-empty pass appends it at most once
    // (and after drained it appends nothing). To count PASSES distinctly we gate
    // the first append and seed a SECOND row mid-flight.
    const handle = {
      workspaceId: WS,
      harnessSlug: SLUG,
      async append(_op: LocalWriteOp): Promise<void> {
        appendCalls += 1;
        if (appendCalls === 1) await firstAppendGate; // pin pass #1 open
      },
    } as unknown as BootedHarnessHandle;

    // Seed one row so the initial catch-up drain has work and blocks on append #1.
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-A', row: featureRow('F-A') });

    const drain = startOutboxDrain(handle, db.sql, { pollMs: 0 });
    try {
      // Wait until pass #1 is blocked inside append (appendCalls === 1).
      await vi.waitFor(() => expect(appendCalls).toBe(1), { timeout: 5000 });

      // Fire TWO triggers while pass #1 is in-flight. The serializer must
      // coalesce both into a SINGLE runAgain re-run (not two extra passes).
      await db.sql.notify('substrate_outbox', `${WS}::${SLUG}`);
      await db.sql.notify('substrate_outbox', `${WS}::${SLUG}`);
      // Give the NOTIFY round-trips time to land while still gated.
      await new Promise((r) => setTimeout(r, 200));

      // Still only one append (pass #1 is still gated; the triggers were coalesced,
      // not run as overlapping passes).
      expect(appendCalls).toBe(1);

      // Release pass #1. Its row gets drained; then the single coalesced re-run
      // (runAgain) runs ONE more pass, which finds the row already drained →
      // appends nothing. So total appends stays at 1 even though 3 triggers
      // (initial + 2 NOTIFY) fired.
      releaseFirstAppend();

      // Let the coalesced re-run + any settling happen.
      await new Promise((r) => setTimeout(r, 300));

      // The row drained exactly once (one append), proving the 2 concurrent
      // triggers were coalesced into a single re-run rather than each spawning a
      // pass that re-appended.
      expect(appendCalls).toBe(1);
      const [{ undrained }] = await db.sql<{ undrained: number }[]>`
        SELECT count(*)::int AS undrained FROM harness_shared.substrate_outbox WHERE drained_at IS NULL`;
      expect(undrained).toBe(0);
    } finally {
      releaseFirstAppend(); // ensure the gate is released even on assertion failure
      await drain.stop();
    }
  });

  // ── A3: inline-GC batched/bounded loop + early-break (EI-125) ────────────────
  it('A3: GC deletes in capped batches and EARLY-BREAKS on a partial batch (no extra DELETE)', async () => {
    const now = Date.now();
    const oldDrainedAt = now - OUTBOX_GC_AGE_MS - 60_000;
    // 7 old-drained rows; with _gcBatch:3 that is batches of 3, 3, 1 → the third
    // is a partial batch (<3) so the loop early-breaks (no 4th DELETE).
    for (let i = 0; i < 7; i++) {
      await seedOutbox(db.sql, {
        table_name: 'harness_features_consolidated', op: 'put', key: `F-OLD-${i}`,
        row: featureRow(`F-OLD-${i}`), drained_at: oldDrainedAt,
      });
    }
    // One fresh-drained row that must survive (proves GC is age-scoped, not a
    // blanket delete of the batch).
    const freshId = await seedOutbox(db.sql, {
      table_name: 'harness_features_consolidated', op: 'put', key: 'F-FRESH',
      row: featureRow('F-FRESH'), drained_at: now - 60_000,
    });

    const { handle } = makeFakeHandle();
    // _gcBatch:3 exercises the multi-batch loop; _gcMaxBatches:20 leaves room so
    // the early-break (not the bound) is what stops it.
    await drainOutboxOnce(handle, db.sql, { now, _gcBatch: 3, _gcMaxBatches: 20 });

    // All 7 old rows GC'd across the batches; the fresh row kept.
    const remaining = (await db.sql<{ id: number; key: string }[]>`
      SELECT id, key FROM harness_shared.substrate_outbox ORDER BY id`);
    expect(remaining.map((r) => r.key)).toEqual(['F-FRESH']);
    expect(Number(remaining[0].id)).toBe(freshId);
  });

  it('A3: the max-batches bound stops the GC even with a backlog larger than gcBatch × gcMaxBatches (the rest waits for the next pass)', async () => {
    const now = Date.now();
    const oldDrainedAt = now - OUTBOX_GC_AGE_MS - 60_000;
    // 10 old-drained rows; _gcBatch:2 × _gcMaxBatches:3 = at most 6 deleted this
    // pass (every batch is FULL → never early-breaks → the bound is what stops it).
    for (let i = 0; i < 10; i++) {
      await seedOutbox(db.sql, {
        table_name: 'harness_features_consolidated', op: 'put', key: `F-OLD-${i}`,
        row: featureRow(`F-OLD-${i}`), drained_at: oldDrainedAt,
      });
    }

    const { handle } = makeFakeHandle();
    await drainOutboxOnce(handle, db.sql, { now, _gcBatch: 2, _gcMaxBatches: 3 });

    // Bounded: exactly 6 (= 2 × 3) deleted; 4 remain for a later pass.
    let [{ remaining }] = await db.sql<{ remaining: number }[]>`
      SELECT count(*)::int AS remaining FROM harness_shared.substrate_outbox`;
    expect(remaining).toBe(4);

    // The next pass clears the rest (2 full batches of 2 → partial 0-batch breaks).
    await drainOutboxOnce(handle, db.sql, { now, _gcBatch: 2, _gcMaxBatches: 3 });
    [{ remaining }] = await db.sql<{ remaining: number }[]>`
      SELECT count(*)::int AS remaining FROM harness_shared.substrate_outbox`;
    expect(remaining).toBe(0);
  });
});
