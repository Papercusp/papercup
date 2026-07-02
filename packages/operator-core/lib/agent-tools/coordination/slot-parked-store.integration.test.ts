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
  drainUserMailbox,
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

  // WI-682: the workspace Queen is ONE session covering every started hive, but
  // senders park @role:queen rows under whatever harness context they had —
  // including NULL. A slug-keyed drain stranded those rows forever (18 undelivered
  // nudges 06-25→07-02); anyHarnessSlug drains the slot across the whole workspace.
  it('anyHarnessSlug drains across every harness scope, including NULL-slug rows', async () => {
    await parkSlotMessage(sql, {
      slot: { kind: 'role', ref: 'queen' },
      harnessSlug: 'h1',
      envelope: env({ msg_id: 'slugged', to: ['@role:queen'] }),
      nowMs: 1000,
    });
    await parkSlotMessage(sql, {
      slot: { kind: 'role', ref: 'queen' },
      envelope: env({ msg_id: 'slugless', ts: '2026-06-14T00:00:01.000Z', to: ['@role:queen'] }),
      nowMs: 1001,
    });
    await parkSlotMessage(sql, {
      // A DIFFERENT slot must stay untouched — anyHarnessSlug widens the slug key only.
      slot: { kind: 'wave', ref: 'W-03' },
      harnessSlug: 'h1',
      envelope: env({ msg_id: 'other-slot' }),
      nowMs: 1002,
    });

    const drained = await drainSlotMessages(sql, {
      slot: { kind: 'role', ref: 'queen' },
      anyHarnessSlug: true,
      toOwner: 'queen-owner',
      nowMs: 2000,
    });
    expect(drained.map((e) => e.msg_id).sort()).toEqual(['slugged', 'slugless']);

    // Claimed exactly once — a second any-slug drain finds nothing.
    const again = await drainSlotMessages(sql, {
      slot: { kind: 'role', ref: 'queen' },
      anyHarnessSlug: true,
      toOwner: 'queen-owner',
      nowMs: 2001,
    });
    expect(again).toEqual([]);

    // The unrelated slot is still drainable under its own key.
    const other = await drainSlotMessages(sql, {
      slot: { kind: 'wave', ref: 'W-03' },
      harnessSlug: 'h1',
      toOwner: 'bee',
      nowMs: 2002,
    });
    expect(other.map((e) => e.msg_id)).toEqual(['other-slot']);
  });

  it('anyHarnessSlug stays workspace-scoped (never drains another workspace)', async () => {
    await parkSlotMessage(sql, {
      slot: { kind: 'role', ref: 'queen' },
      harnessSlug: 'h1',
      envelope: env({ msg_id: 'ws-other', to: ['@role:queen'] }),
      nowMs: 1000,
      workspaceId: 'ws-other',
    });
    const drained = await drainSlotMessages(sql, {
      slot: { kind: 'role', ref: 'queen' },
      anyHarnessSlug: true,
      toOwner: 'queen-owner',
      nowMs: 2000,
    });
    expect(drained).toEqual([]);
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

// Offline-member assign mailbox (shared-hive-collaboration P-016): a @user: slot is
// parked by the same store (zero schema change — slot_kind is just another TEXT
// value) but drains on the MEMBER's RETURN, matching ANY rung of their actorUserKey
// ladder, and is identity-scoped (no harness match) — an assignment follows a person.
describe('user mailbox (@user: offline-member assign)', () => {
  // An offline-member assignment: addressed by the member's github id, parked with
  // NO harness scope (it follows the person, not a harness) and NO TTL (an
  // assignment must not silently vanish before the member returns).
  async function parkAssignment(msgId: string, ref: string, nowMs: number): Promise<void> {
    await parkSlotMessage(sql, {
      slot: { kind: 'user', ref },
      harnessSlug: null,
      envelope: env({
        msg_id: msgId,
        to: [`@user:${ref}`],
        from: 'pc-admin-coord-ui',
        summary: '📋 Assigned to you: plan shared-hive-collaboration',
      }),
      nowMs,
    });
  }

  it('delivers a parked @user: assignment when the member returns, exactly once', async () => {
    await parkAssignment('asg1', 'gh:12345', 1000);

    // The member returns; their session resolves the full key ladder.
    const keys = ['gh:12345', 'avi@storewolf.com', 'pus-returning-session'];
    const first = await drainUserMailbox(sql, { keys, toOwner: 'pus-returning-session', nowMs: 2000 });
    expect(first.map((e) => e.msg_id)).toEqual(['asg1']);

    // Claim-once: the member's NEXT session drains nothing (no double-deliver).
    const second = await drainUserMailbox(sql, { keys, toOwner: 'pus-returning-session', nowMs: 2001 });
    expect(second).toEqual([]);
  });

  it('matches ANY rung of the ladder (assigned by gh id, member resolves a weaker key today)', async () => {
    // Assigner used the github id (from the membership roster). On a gh-unauth box
    // the returning session might only resolve its userId/ownerId — but the github
    // key is still one of its candidate keys, so it matches.
    await parkAssignment('asg-by-gh', 'gh:777', 1000);
    const got = await drainUserMailbox(sql, {
      keys: ['gh:777', 'userId-x', 'su-owner'],
      toOwner: 'su-owner',
      nowMs: 2000,
    });
    expect(got.map((e) => e.msg_id)).toEqual(['asg-by-gh']);
  });

  it('does NOT deliver another member’s assignment, and is harness-agnostic', async () => {
    await parkAssignment('mine', 'gh:111', 1000);
    await parkAssignment('theirs', 'gh:222', 1000);

    // Returning member gh:111 drains only their own row — even though the park set
    // no harness scope and this drain names none either (identity, not harness).
    const mine = await drainUserMailbox(sql, { keys: ['gh:111'], toOwner: 'pus-111', nowMs: 2000 });
    expect(mine.map((e) => e.msg_id)).toEqual(['mine']);

    // gh:222's row is untouched and still pending for them.
    const theirs = await drainUserMailbox(sql, { keys: ['gh:222'], toOwner: 'pus-222', nowMs: 2001 });
    expect(theirs.map((e) => e.msg_id)).toEqual(['theirs']);
  });

  it('is a no-op for an empty key set (a session with no resolvable identity)', async () => {
    await parkAssignment('asg', 'gh:9', 1000);
    expect(await drainUserMailbox(sql, { keys: [], toOwner: 'x', nowMs: 2000 })).toEqual([]);
  });
});
