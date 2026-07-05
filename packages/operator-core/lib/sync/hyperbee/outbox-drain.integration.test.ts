/**
 * outbox-drain.integration.test.ts — Stage 3 of the feature-content federation
 * plan (papercusp-feature-content-federation-2026-06-01). Real testcontainer PG.
 *
 * Proves the drain loop that reads undrained `substrate_outbox` rows and appends
 * the mapped `LocalWriteOp`s to the device's own Hypercore log (via a fake
 * `BootedHarnessHandle.append`), with at-least-once semantics:
 *
 *  - `drainOutboxOnce` drains undrained rows for THIS (workspace, harness) in id
 *    order, calls `handle.append` per row, marks `drained_at` ONLY after append
 *    resolves, and returns the count drained.
 *  - At-least-once: if `append` throws on row N, the drain STOPS — row N and all
 *    later rows stay undrained so a retry re-attempts them (LWW + idempotent
 *    projection tolerate the duplicate). Earlier rows stay drained.
 *  - A second drain after all succeed is a no-op (0 rows).
 *  - Inline 24h GC: a row drained > 24h ago is deleted on the next drain; a
 *    recently-drained row is kept.
 *  - `startOutboxDrain`: initial catch-up drain, a poll-fallback timer, a LISTEN
 *    on `substrate_outbox` that drains on a matching NOTIFY, and a `stop()` that
 *    clears the timer + closes the LISTEN connection. Resilient: a drain error
 *    is logged, not fatal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  drainOutboxOnce,
  startOutboxDrain,
  OUTBOX_GC_AGE_MS,
} from './outbox-drain';
import type { BootedHarnessHandle, LocalWriteOp } from './boot';

const WS = 'ws_drain';
const SLUG = 'drain';

/** A minimal fake handle: captures every append, optionally throws on the Nth
 *  (1-based) call to exercise the at-least-once stop-on-error path. */
function makeFakeHandle(opts?: {
  throwOnCall?: number;
  workspaceId?: string;
  harnessSlug?: string;
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
      if (opts?.throwOnCall && calls === opts.throwOnCall) {
        throw new Error(`append boom on call ${calls}`);
      }
      appends.push(op);
    },
    // Unused-by-drain members of the handle interface — stubbed.
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

const issueRow = (id: string) => ({
  workspace_id: WS,
  harness_slug: SLUG,
  issue_id: id,
  title: `I ${id}`,
  severity: 'high',
  source: 'manual',
  status: 'open',
  found_at: '2024-05-29T12:00:00.000Z',
  attempts: 0,
  notes: [],
  created_ts: 1,
  updated_ts: 1,
  origin: 'local',
});

describe('outbox-drain (Stage 3, real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('outbox_drain');
    // The drain only needs the outbox table — create it directly (not the full
    // 102 migration, which also touches the consolidated tables + GRANTs).
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

  it('drains undrained rows in id order, appends each, marks drained, returns count', async () => {
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-1', row: featureRow('F-1') });
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-2', row: featureRow('F-2') });
    await seedOutbox(db.sql, { table_name: 'harness_issues_consolidated', op: 'del', key: 'I-9', row: null });

    const { handle, appends } = makeFakeHandle();
    const count = await drainOutboxOnce(handle, db.sql);
    expect(count).toBe(3);

    // Appended in id order, mapped to the projection tableTags.
    expect(appends.map((a) => [a.table, a.type, a.hbKey])).toEqual([
      ['features-by-id', 'put', 'F-1'],
      ['features-by-id', 'put', 'F-2'],
      ['issues', 'del', 'I-9'],
    ]);

    // All three rows marked drained.
    const [{ undrained }] = await db.sql<{ undrained: number }[]>`
      SELECT count(*)::int AS undrained FROM harness_shared.substrate_outbox WHERE drained_at IS NULL`;
    expect(undrained).toBe(0);
  });

  it('only drains rows for THIS (workspace, harness)', async () => {
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-MINE', row: featureRow('F-MINE') });
    await seedOutbox(db.sql, { harness_slug: 'other', table_name: 'harness_features_consolidated', op: 'put', key: 'F-OTHER', row: featureRow('F-OTHER') });
    await seedOutbox(db.sql, { workspace_id: 'other_ws', table_name: 'harness_features_consolidated', op: 'put', key: 'F-OTHERWS', row: featureRow('F-OTHERWS') });

    const { handle, appends } = makeFakeHandle();
    const count = await drainOutboxOnce(handle, db.sql);
    expect(count).toBe(1);
    expect(appends.map((a) => a.hbKey)).toEqual(['F-MINE']);

    // The other-harness/other-ws rows stay undrained.
    const [{ undrained }] = await db.sql<{ undrained: number }[]>`
      SELECT count(*)::int AS undrained FROM harness_shared.substrate_outbox WHERE drained_at IS NULL`;
    expect(undrained).toBe(2);
  });

  it('a second drain after all succeed is a no-op (0 rows)', async () => {
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-1', row: featureRow('F-1') });
    const { handle } = makeFakeHandle();
    expect(await drainOutboxOnce(handle, db.sql)).toBe(1);
    expect(await drainOutboxOnce(handle, db.sql)).toBe(0);
  });

  it('AT-LEAST-ONCE: append throws on row 2 → row 1 drained, rows 2+3 still undrained', async () => {
    const id1 = await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-1', row: featureRow('F-1') });
    const id2 = await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-2', row: featureRow('F-2') });
    const id3 = await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-3', row: featureRow('F-3') });

    const { handle, appends, appendCalls } = makeFakeHandle({ throwOnCall: 2 });
    await expect(drainOutboxOnce(handle, db.sql)).rejects.toThrow(/boom/);

    // append was called for row 1 (succeeded) and attempted for row 2 (threw).
    expect(appendCalls()).toBe(2);
    expect(appends.map((a) => a.hbKey)).toEqual(['F-1']);

    // Row 1 drained; rows 2 + 3 left undrained for the retry.
    const drained = await db.sql<{ id: number; drained_at: number | null }[]>`
      SELECT id, drained_at FROM harness_shared.substrate_outbox ORDER BY id`;
    const byId = new Map(drained.map((r) => [Number(r.id), r.drained_at]));
    expect(byId.get(id1)).not.toBeNull();
    expect(byId.get(id2)).toBeNull();
    expect(byId.get(id3)).toBeNull();

    // A retry (no throw this time) drains the remaining 2.
    const { handle: h2, appends: a2 } = makeFakeHandle();
    expect(await drainOutboxOnce(h2, db.sql)).toBe(2);
    expect(a2.map((x) => x.hbKey)).toEqual(['F-2', 'F-3']);
  });

  it('FORWARD-COMPAT: an unmapped table_name is SKIPPED (left undrained) — the drain does NOT halt, known rows still drain', async () => {
    // Simulates a co-located OLDER operator hitting a NEWER capture trigger's table
    // (the exact wedge a migration landing ahead of code would cause). The drain
    // must skip the unmapped row + keep federating the rows it knows.
    const idKnown1 = await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-1', row: featureRow('F-1') });
    const idUnknown = await seedOutbox(db.sql, { table_name: 'some_future_federated_table', op: 'put', key: 'X-1', row: { workspace_id: WS, harness_slug: SLUG, id: 'X-1' } });
    const idKnown2 = await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-2', row: featureRow('F-2') });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Does NOT throw; drains the 2 known rows, skips the unknown.
      const count = await drainOutboxOnce(makeFakeHandle().handle, db.sql);
      expect(count).toBe(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('some_future_federated_table'));
    } finally {
      warnSpy.mockRestore();
    }

    const rows = await db.sql<{ id: number; drained_at: number | null }[]>`
      SELECT id, drained_at FROM harness_shared.substrate_outbox ORDER BY id`;
    const byId = new Map(rows.map((r) => [Number(r.id), r.drained_at]));
    expect(byId.get(idKnown1)).not.toBeNull(); // drained
    expect(byId.get(idKnown2)).not.toBeNull(); // drained (drain did NOT halt at the unknown row)
    expect(byId.get(idUnknown)).toBeNull();    // left undrained for a newer build to federate
  });

  it('respects the batch limit (drains LIMIT rows, leaves the rest for the next pass)', async () => {
    for (let i = 0; i < 5; i++) {
      await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: `F-${i}`, row: featureRow(`F-${i}`) });
    }
    const { handle } = makeFakeHandle();
    expect(await drainOutboxOnce(handle, db.sql, { batch: 2 })).toBe(2);
    expect(await drainOutboxOnce(handle, db.sql, { batch: 2 })).toBe(2);
    expect(await drainOutboxOnce(handle, db.sql, { batch: 2 })).toBe(1);
    expect(await drainOutboxOnce(handle, db.sql, { batch: 2 })).toBe(0);
  });

  it('issue put maps to a valid HarnessIssueRow value (found_at → epoch ms)', async () => {
    await seedOutbox(db.sql, { table_name: 'harness_issues_consolidated', op: 'put', key: 'I-1', row: issueRow('I-1') });
    const { handle, appends } = makeFakeHandle();
    await drainOutboxOnce(handle, db.sql);
    const v = appends[0].value as { found_at: number; issue_id: string };
    expect(v.issue_id).toBe('I-1');
    expect(v.found_at).toBe(Date.parse('2024-05-29T12:00:00.000Z'));
  });

  // ── 24h inline GC ───────────────────────────────────────────────────────────
  it('GC: a row drained > 24h ago is deleted on the next drain; a fresh-drained row is kept', async () => {
    const now = Date.now();
    // An old-drained row (> 24h) — should be GC'd.
    const oldId = await seedOutbox(db.sql, {
      table_name: 'harness_features_consolidated', op: 'put', key: 'F-OLD',
      row: featureRow('F-OLD'), drained_at: now - OUTBOX_GC_AGE_MS - 60_000,
    });
    // A recently-drained row (< 24h) — should be kept.
    const freshId = await seedOutbox(db.sql, {
      table_name: 'harness_features_consolidated', op: 'put', key: 'F-FRESH',
      row: featureRow('F-FRESH'), drained_at: now - 60_000,
    });
    // An undrained row — drained this pass.
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-NEW', row: featureRow('F-NEW') });

    const { handle } = makeFakeHandle();
    await drainOutboxOnce(handle, db.sql, { now });

    const remaining = await db.sql<{ id: number }[]>`
      SELECT id FROM harness_shared.substrate_outbox ORDER BY id`;
    const ids = remaining.map((r) => Number(r.id));
    expect(ids).not.toContain(oldId);   // GC'd
    expect(ids).toContain(freshId);     // kept (drained < 24h ago)
  });

  it('GC is SCOPED: a drain only GCs its own (workspace, harness) rows — other scopes keep their old-drained rows (EI-125)', async () => {
    const now = Date.now();
    const oldDrainedAt = now - OUTBOX_GC_AGE_MS - 60_000;
    // Old-drained rows in THREE scopes: mine, same-ws other-harness, other-ws.
    const mineOld = await seedOutbox(db.sql, {
      table_name: 'harness_features_consolidated', op: 'put', key: 'F-MINE-OLD',
      row: featureRow('F-MINE-OLD'), drained_at: oldDrainedAt,
    });
    const otherHarnessOld = await seedOutbox(db.sql, {
      harness_slug: 'other', table_name: 'harness_features_consolidated', op: 'put',
      key: 'F-OTHER-OLD', row: featureRow('F-OTHER-OLD'), drained_at: oldDrainedAt,
    });
    const otherWsOld = await seedOutbox(db.sql, {
      workspace_id: 'other_ws', table_name: 'harness_features_consolidated', op: 'put',
      key: 'F-OTHERWS-OLD', row: featureRow('F-OTHERWS-OLD'), drained_at: oldDrainedAt,
    });

    // Drain as (WS, SLUG): only mineOld may be GC'd.
    await drainOutboxOnce(makeFakeHandle().handle, db.sql, { now });
    let ids = (await db.sql<{ id: number }[]>`
      SELECT id FROM harness_shared.substrate_outbox ORDER BY id`).map((r) => Number(r.id));
    expect(ids).not.toContain(mineOld);        // own scope GC'd
    expect(ids).toContain(otherHarnessOld);    // other harness untouched
    expect(ids).toContain(otherWsOld);         // other workspace untouched

    // The other-harness drain GCs its own row; the other-ws row still survives.
    const otherHandle = makeFakeHandle({ harnessSlug: 'other' }).handle;
    await drainOutboxOnce(otherHandle, db.sql, { now });
    ids = (await db.sql<{ id: number }[]>`
      SELECT id FROM harness_shared.substrate_outbox ORDER BY id`).map((r) => Number(r.id));
    expect(ids).not.toContain(otherHarnessOld);
    expect(ids).toContain(otherWsOld);
  });

  // ── startOutboxDrain ─────────────────────────────────────────────────────────
  it('startOutboxDrain runs an initial catch-up drain immediately', async () => {
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-INIT', row: featureRow('F-INIT') });
    const { handle, appends } = makeFakeHandle();

    // pollMs:0 disables the timer; listen connection still opens.
    const drain = startOutboxDrain(handle, db.sql, { pollMs: 0 });
    try {
      await vi.waitFor(() => expect(appends.map((a) => a.hbKey)).toContain('F-INIT'), { timeout: 5000 });
    } finally {
      await drain.stop();
    }
  });

  it('startOutboxDrain drains on a matching NOTIFY (LISTEN path)', async () => {
    const { handle, appends } = makeFakeHandle();
    const drain = startOutboxDrain(handle, db.sql, { pollMs: 0 });
    try {
      // Wait for the initial (empty) drain + the LISTEN to be established.
      await new Promise((r) => setTimeout(r, 200));
      // Insert a row, then fire the NOTIFY the trigger would fire.
      await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-NOTIFY', row: featureRow('F-NOTIFY') });
      await db.sql.notify('substrate_outbox', `${WS}::${SLUG}`);
      await vi.waitFor(() => expect(appends.map((a) => a.hbKey)).toContain('F-NOTIFY'), { timeout: 5000 });
    } finally {
      await drain.stop();
    }
  });

  it('startOutboxDrain ignores a NOTIFY for a different (workspace, harness)', async () => {
    const { handle, appends } = makeFakeHandle();
    const drain = startOutboxDrain(handle, db.sql, { pollMs: 0 });
    try {
      await new Promise((r) => setTimeout(r, 200));
      // A row for THIS harness, but a NOTIFY naming a DIFFERENT one → no drain.
      await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-MISMATCH', row: featureRow('F-MISMATCH') });
      await db.sql.notify('substrate_outbox', `${WS}::someone-else`);
      // Give it a moment; it should NOT have drained.
      await new Promise((r) => setTimeout(r, 300));
      expect(appends.map((a) => a.hbKey)).not.toContain('F-MISMATCH');
    } finally {
      await drain.stop();
    }
  });

  it('startOutboxDrain poll-fallback timer drains even with no NOTIFY', async () => {
    const { handle, appends } = makeFakeHandle();
    const drain = startOutboxDrain(handle, db.sql, { pollMs: 50 });
    try {
      // No initial row; insert AFTER start so only the poll can catch it.
      await new Promise((r) => setTimeout(r, 100));
      await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-POLL', row: featureRow('F-POLL') });
      await vi.waitFor(() => expect(appends.map((a) => a.hbKey)).toContain('F-POLL'), { timeout: 5000 });
    } finally {
      await drain.stop();
    }
  });

  it('startOutboxDrain stop() clears the poll timer + closes the LISTEN connection (no drain after stop)', async () => {
    const { handle, appends } = makeFakeHandle();
    const drain = startOutboxDrain(handle, db.sql, { pollMs: 30 });
    await new Promise((r) => setTimeout(r, 100));
    await drain.stop();

    // After stop, neither the timer nor a NOTIFY should drive a drain.
    await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-AFTERSTOP', row: featureRow('F-AFTERSTOP') });
    await db.sql.notify('substrate_outbox', `${WS}::${SLUG}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(appends.map((a) => a.hbKey)).not.toContain('F-AFTERSTOP');
  });

  it('startOutboxDrain is resilient: a drain error is logged, not fatal', async () => {
    // Handle throws on every append, so each drain pass fails. We assert the
    // loop swallows the error (logs it via console.error) rather than crashing
    // the process, and that stop() resolves cleanly. The console.error is the
    // EXPECTED resilience behavior, so we mock it out + assert it fired.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await seedOutbox(db.sql, { table_name: 'harness_features_consolidated', op: 'put', key: 'F-ERR', row: featureRow('F-ERR') });
      const { handle } = makeFakeHandle({ throwOnCall: 1 });
      const drain = startOutboxDrain(handle, db.sql, { pollMs: 40 });
      // Give the initial drain (which throws) + a couple poll passes time to run.
      await vi.waitFor(
        () => expect(errSpy).toHaveBeenCalledWith(
          expect.stringContaining('[outbox-drain] drain failed'),
          expect.anything(),
        ),
        { timeout: 5000 },
      );
      // The process is still alive and stop resolves — the throw was swallowed.
      await expect(drain.stop()).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});
