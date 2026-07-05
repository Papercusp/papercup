/**
 * outbox-drain-rekey.integration.test.ts — the read-plane re-key CAPTURE-WIRE
 * (C-001, shared-hive-rekey-2026-06-19, su-7dcd8). Real PG outbox + a fake handle
 * + a fake EpochEncryptCapability. Proves `drainOutboxOnce`:
 *  - ENCRYPTS a hive-CONTENT put (op.value → the capability's value, op.epoch
 *    stamped) before append;
 *  - leaves an admission/key/policy op (hive_settings) PLAINTEXT — the capability
 *    is never called (op-selection: shouldEncryptOpForRekey);
 *  - skips a `del` (no payload to encrypt);
 *  - is a pure PASSTHROUGH when no capability is threaded (today's behavior);
 *  - leaves the op plaintext when the capability returns null;
 *  - treats a key-unavailable REJECTION like an append failure: the row stays
 *    UNDRAINED (at-least-once halt + retry) and is NEVER appended/federated in the
 *    clear.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { drainOutboxOnce, type EpochEncryptCapability } from './outbox-drain';
import type { BootedHarnessHandle, LocalWriteOp } from './boot';

const WS = 'ws_rekey_drain';
const SLUG = 'rekey-drain';

function makeFakeHandle(): { handle: BootedHarnessHandle; appends: LocalWriteOp[] } {
  const appends: LocalWriteOp[] = [];
  const handle = {
    workspaceId: WS,
    harnessSlug: SLUG,
    async append(op: LocalWriteOp): Promise<void> {
      appends.push(op);
    },
  } as unknown as BootedHarnessHandle;
  return { handle, appends };
}

async function seedOutbox(
  sql: postgres.Sql,
  fields: {
    table_name: string;
    op: 'put' | 'del';
    key: string;
    row: Record<string, unknown> | null;
    ts?: number;
  },
): Promise<number> {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.substrate_outbox
      (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at)
    VALUES
      (${WS}, ${SLUG}, ${fields.table_name}, ${fields.op}, ${fields.key},
       ${fields.row == null ? null : sql.json(fields.row as unknown as Parameters<typeof sql.json>[0])},
       ${fields.ts ?? Date.now()}, ${null})
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

describe('outbox-drain re-key capture-wire (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('outbox_drain_rekey');
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

  it('encrypts a hive-CONTENT put under the current epoch + stamps op.epoch before append', async () => {
    await seedOutbox(db.sql, {
      table_name: 'harness_features_consolidated',
      op: 'put',
      key: 'F-1',
      row: featureRow('F-1'),
    });
    const { handle, appends } = makeFakeHandle();
    const encryptOp = vi.fn(async (_op: LocalWriteOp) => ({ epoch: 7, value: { __rekey: 'CIPHER' } }));
    const cap: EpochEncryptCapability = { encryptOp };

    const n = await drainOutboxOnce(handle, db.sql, { epochEncrypt: cap });

    expect(n).toBe(1);
    expect(encryptOp).toHaveBeenCalledTimes(1);
    // It was handed the content op (projection tag 'features-by-id'), not the PG table name.
    expect(encryptOp.mock.calls[0]?.[0]).toMatchObject({ table: 'features-by-id', type: 'put' });
    expect(appends).toHaveLength(1);
    expect(appends[0]?.epoch).toBe(7);
    expect(appends[0]?.value).toEqual({ __rekey: 'CIPHER' });
  });

  it('leaves an admission/key/policy op (hive_settings) PLAINTEXT — capability not called', async () => {
    await seedOutbox(db.sql, {
      table_name: 'hive_settings',
      op: 'put',
      key: 'epoch',
      row: { harness_slug: SLUG, setting_key: 'epoch', value: '0' },
    });
    const { handle, appends } = makeFakeHandle();
    const encryptOp = vi.fn(async (_op: LocalWriteOp) => ({ epoch: 1, value: { __rekey: 'X' } }));

    await drainOutboxOnce(handle, db.sql, { epochEncrypt: { encryptOp } });

    expect(encryptOp).not.toHaveBeenCalled();
    expect(appends).toHaveLength(1);
    expect(appends[0]?.table).toBe('hive-settings-by-key');
    expect(appends[0]?.epoch).toBeUndefined();
  });

  it('skips a del (no payload to encrypt) — capability not called', async () => {
    await seedOutbox(db.sql, { table_name: 'harness_issues_consolidated', op: 'del', key: 'I-9', row: null });
    const { handle, appends } = makeFakeHandle();
    const encryptOp = vi.fn(async (_op: LocalWriteOp) => ({ epoch: 2, value: { __rekey: 'Y' } }));

    await drainOutboxOnce(handle, db.sql, { epochEncrypt: { encryptOp } });

    expect(encryptOp).not.toHaveBeenCalled();
    expect(appends).toHaveLength(1);
    expect(appends[0]?.type).toBe('del');
    expect(appends[0]?.epoch).toBeUndefined();
  });

  it('is a pure passthrough when no capability is threaded (today behavior, plaintext)', async () => {
    await seedOutbox(db.sql, {
      table_name: 'harness_features_consolidated',
      op: 'put',
      key: 'F-2',
      row: featureRow('F-2'),
    });
    const { handle, appends } = makeFakeHandle();

    await drainOutboxOnce(handle, db.sql, {});

    expect(appends).toHaveLength(1);
    expect(appends[0]?.epoch).toBeUndefined();
    expect(appends[0]?.value).toBeDefined(); // plaintext feature payload
  });

  it('leaves the op plaintext when the capability returns null', async () => {
    await seedOutbox(db.sql, {
      table_name: 'harness_features_consolidated',
      op: 'put',
      key: 'F-3',
      row: featureRow('F-3'),
    });
    const { handle, appends } = makeFakeHandle();
    const encryptOp = vi.fn(async (_op: LocalWriteOp) => null);

    await drainOutboxOnce(handle, db.sql, { epochEncrypt: { encryptOp } });

    expect(encryptOp).toHaveBeenCalledTimes(1);
    expect(appends).toHaveLength(1);
    expect(appends[0]?.epoch).toBeUndefined();
    expect(appends[0]?.value).toBeDefined();
  });

  it('key-unavailable rejection HALTS the drain — row stays UNDRAINED, never appended in the clear', async () => {
    const id = await seedOutbox(db.sql, {
      table_name: 'harness_features_consolidated',
      op: 'put',
      key: 'F-4',
      row: featureRow('F-4'),
    });
    const { handle, appends } = makeFakeHandle();
    const encryptOp = vi.fn(async (_op: LocalWriteOp): Promise<{ epoch: number; value: unknown }> => {
      throw new Error('no epoch key for (rekey-drain, epoch 1) on this device — cut off or not yet distributed');
    });

    await expect(drainOutboxOnce(handle, db.sql, { epochEncrypt: { encryptOp } })).rejects.toThrow(
      /epoch key/,
    );

    // Never appended (so never federated), and the row stays undrained for retry.
    expect(appends).toHaveLength(0);
    const [r] = await db.sql<{ drained_at: number | null }[]>`
      SELECT drained_at FROM harness_shared.substrate_outbox WHERE id = ${id}`;
    expect(r?.drained_at).toBeNull();
  });
});
