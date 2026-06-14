/**
 * slot-parked-store.integration.test.ts — park → drain-once → expire against REAL
 * Postgres (B2 — directed-wake-honesty-and-spawn-handoff-2026-06-14, P-025; D-005).
 *
 * Applies migration 280 verbatim to a throwaway testcontainer DB (creating the
 * harness_app/harness_zero roles the bare container lacks so the GRANTs apply),
 * then exercises the store: a parked message is delivered EXACTLY once, harness
 * scope isolates drains, and a TTL-expired message drops visibly instead of
 * delivering.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import {
  parkSlotMessage,
  drainSlotMessages,
  expireStaleSlotMessages,
  listPendingForSlot,
} from './slot-parked-store';

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../libs/papercusp/libs/db/sql/286-slot-parked-messages.sql',
);

let db: FreshPgDb;
let sql: postgres.Sql;

function env(over: Partial<CoordEnvelope> & Pick<CoordEnvelope, 'msg_id'>): CoordEnvelope {
  return {
    ts: '2026-06-14T00:00:00.000Z',
    from: 'alice',
    to: ['@wave:W-03'],
    kind: 'message',
    ...over,
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('slot-parked');
  sql = db.sql;
  // The bare testcontainer lacks the harness_app/harness_zero roles the migration
  // GRANTs to — create them so the real migration SQL applies verbatim.
  await sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero; END IF;
  END $$;`);
  await sql.unsafe(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.slot_parked_messages`;
});

describe('park → drain', () => {
  it('delivers parked messages exactly once, in park order', async () => {
    await parkSlotMessage(sql, {
      slot: { kind: 'wave', ref: 'W-03' },
      harnessSlug: 'h',
      envelope: env({ msg_id: 'm1', ts: '2026-06-14T00:00:01.000Z', body: 'first' }),
      nowMs: 1000,
    });
    await parkSlotMessage(sql, {
      slot: { kind: 'wave', ref: 'W-03' },
      harnessSlug: 'h',
      envelope: env({ msg_id: 'm2', ts: '2026-06-14T00:00:02.000Z', body: 'second' }),
      nowMs: 2000,
    });

    const first = await drainSlotMessages(sql, {
      slot: { kind: 'wave', ref: 'W-03' },
      harnessSlug: 'h',
      toOwner: 'bee-W-03',
      nowMs: 3000,
    });
    expect(first.map((e) => e.msg_id)).toEqual(['m1', 'm2']);

    // Second drain finds nothing — claimed exactly once.
    const second = await drainSlotMessages(sql, {
      slot: { kind: 'wave', ref: 'W-03' },
      harnessSlug: 'h',
      toOwner: 'bee-W-03',
      nowMs: 3001,
    });
    expect(second).toEqual([]);
  });

  it('isolates by harness scope', async () => {
    await parkSlotMessage(sql, {
      slot: { kind: 'wave', ref: 'W-03' },
      harnessSlug: 'h1',
      envelope: env({ msg_id: 'a' }),
      nowMs: 1000,
    });
    await parkSlotMessage(sql, {
      slot: { kind: 'wave', ref: 'W-03' },
      harnessSlug: 'h2',
      envelope: env({ msg_id: 'b' }),
      nowMs: 1000,
    });

    const h1 = await drainSlotMessages(sql, {
      slot: { kind: 'wave', ref: 'W-03' },
      harnessSlug: 'h1',
      toOwner: 'bee',
      nowMs: 2000,
    });
    expect(h1.map((e) => e.msg_id)).toEqual(['a']);
  });
});

describe('TTL expiry', () => {
  it('drops an expired message visibly instead of delivering it', async () => {
    await parkSlotMessage(sql, {
      slot: { kind: 'role', ref: 'scoper' },
      harnessSlug: 'h',
      envelope: env({ msg_id: 'stale', to: ['@role:scoper'] }),
      ttlMs: 1000,
      nowMs: 0,
    });

    // After the TTL window, a drain must NOT return it.
    const drained = await drainSlotMessages(sql, {
      slot: { kind: 'role', ref: 'scoper' },
      harnessSlug: 'h',
      toOwner: 'bee',
      nowMs: 5000,
    });
    expect(drained).toEqual([]);

    // The sweep drops it visibly (a dropped row remains, counted).
    const dropped = await expireStaleSlotMessages(sql, 5000);
    expect(dropped).toBe(1);

    // And it is gone from the pending view.
    const pending = await listPendingForSlot(sql, {
      slot: { kind: 'role', ref: 'scoper' },
      harnessSlug: 'h',
      nowMs: 6000,
    });
    expect(pending).toEqual([]);
  });

  it('keeps a non-expired message available to drain', async () => {
    await parkSlotMessage(sql, {
      slot: { kind: 'feature', ref: 'F-012' },
      harnessSlug: 'h',
      envelope: env({ msg_id: 'fresh', to: ['@feature:F-012'] }),
      ttlMs: 10_000,
      nowMs: 0,
    });
    const dropped = await expireStaleSlotMessages(sql, 5000);
    expect(dropped).toBe(0);
    const drained = await drainSlotMessages(sql, {
      slot: { kind: 'feature', ref: 'F-012' },
      harnessSlug: 'h',
      toOwner: 'bee',
      nowMs: 5000,
    });
    expect(drained.map((e) => e.msg_id)).toEqual(['fresh']);
  });
});
