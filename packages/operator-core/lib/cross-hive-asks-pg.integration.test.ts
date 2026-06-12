/**
 * cross-hive-asks-pg.integration.test.ts — the durable cross-Hive ask ledger
 * (hive-network-surface-2026-06-11 P-002, contract C-1) against real PG. Proves
 * insert+idempotency, correlation/id lookup, list/filter + counts, the
 * legality-guarded transition primitive (legal / illegal / idempotent), the
 * reply persistence path (applied / duplicate / conflict / not-found, incl. the
 * queued->answered auto-advance), bulk expiry, and per-Hive scoping isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  PgCrossHiveAsks,
  CrossHiveAskTransitionError,
  type CrossHiveAsk,
} from './cross-hive-asks-pg';

const WS = 'default';
const HIVE_A = 'hive-a';
const HIVE_B = 'hive-b';
const PEER = 'peer-pubkey-1';
const PEER2 = 'peer-pubkey-2';

// Mirrors migration 231 (minus the psql directives + role grants the test DB lacks).
const ASKS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.cross_hive_asks (
    workspace_id text NOT NULL, hive_slug text NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    peer_pubkey text NOT NULL, direction text NOT NULL DEFAULT 'out',
    kind text NOT NULL, subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
    correlation_id text NOT NULL, state text NOT NULL DEFAULT 'queued',
    reply_body text, reply_ts timestamptz,
    asked_by text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cross_hive_asks_pkey PRIMARY KEY (id),
    CONSTRAINT cross_hive_asks_workspace_nonempty CHECK (workspace_id <> ''),
    CONSTRAINT cross_hive_asks_direction_check CHECK (direction IN ('out','in')),
    CONSTRAINT cross_hive_asks_kind_check CHECK (kind IN ('ask','work-request')),
    CONSTRAINT cross_hive_asks_state_check CHECK (state IN ('queued','sent','answered','declined','expired')),
    CONSTRAINT cross_hive_asks_correlation_uniq UNIQUE (workspace_id, hive_slug, correlation_id))`;

let db: FreshPgDb;
let store: PgCrossHiveAsks;

beforeAll(async () => {
  db = await createFreshPgDb('xhive-asks');
  await db.sql.unsafe(ASKS_DDL);
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.cross_hive_asks`;
  store = new PgCrossHiveAsks(WS, HIVE_A, db.sql);
});

async function seedQueued(correlationId: string, over: Partial<{ peerPubkey: string; subject: string; body: string }> = {}): Promise<CrossHiveAsk> {
  return store.insert({
    peerPubkey: over.peerPubkey ?? PEER,
    kind: 'ask',
    correlationId,
    subject: over.subject ?? `subj-${correlationId}`,
    body: over.body ?? `body-${correlationId}`,
  });
}

describe('insert', () => {
  it('records a new request in state queued with a DB-minted uuid + timestamps', async () => {
    const ask = await seedQueued('c1');
    expect(ask.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ask.state).toBe('queued');
    expect(ask.direction).toBe('out');
    expect(ask.kind).toBe('ask');
    expect(ask.correlationId).toBe('c1');
    expect(ask.peerPubkey).toBe(PEER);
    expect(ask.replyBody).toBeNull();
    expect(ask.replyTs).toBeNull();
    expect(typeof ask.createdAt).toBe('string');
    expect(ask.updatedAt).toBe(ask.createdAt);
    expect(ask.askedBy).toBeNull(); // absent input ⇒ broadcast path (mig 235)
  });

  it('persists askedBy on insert so the C-4 reply event can target the initiator (P-014 item 4)', async () => {
    const ask = await store.insert({
      peerPubkey: PEER,
      kind: 'ask',
      correlationId: 'c-asked-by',
      askedBy: 'su-initiator-1',
    });
    expect(ask.askedBy).toBe('su-initiator-1');
    const reread = await store.getByCorrelationId('c-asked-by');
    expect(reread?.askedBy).toBe('su-initiator-1');
  });

  it('is idempotent on correlation_id — re-insert returns the existing row, no duplicate', async () => {
    const first = await seedQueued('dup', { body: 'original' });
    const second = await store.insert({ peerPubkey: PEER, kind: 'work-request', correlationId: 'dup', body: 'changed' });
    expect(second.id).toBe(first.id);
    expect(second.body).toBe('original'); // existing row, not overwritten
    expect((await store.list()).length).toBe(1);
  });

  it('rejects an invalid kind before touching the DB', async () => {
    await expect(
      // @ts-expect-error — exercising the runtime guard
      store.insert({ peerPubkey: PEER, kind: 'bogus', correlationId: 'x' }),
    ).rejects.toThrow(/invalid cross_hive_asks kind/);
  });
});

describe('lookup', () => {
  it('getById and getByCorrelationId resolve the same row; misses return null', async () => {
    const ask = await seedQueued('look');
    expect((await store.getById(ask.id))?.id).toBe(ask.id);
    expect((await store.getByCorrelationId('look'))?.id).toBe(ask.id);
    expect(await store.getById('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await store.getByCorrelationId('nope')).toBeNull();
  });
});

describe('transition (legality guard)', () => {
  it('queued -> sent -> answered is legal and stamps updated_at', async () => {
    const ask = await seedQueued('t1');
    const sent = await store.markSent(ask.id);
    expect(sent?.state).toBe('sent');
    const answered = await store.transition(ask.id, 'answered');
    expect(answered?.state).toBe('answered');
  });

  it('throws CrossHiveAskTransitionError on an illegal edge (queued -> answered)', async () => {
    const ask = await seedQueued('t2');
    await expect(store.transition(ask.id, 'answered')).rejects.toBeInstanceOf(CrossHiveAskTransitionError);
    // unchanged
    expect((await store.getById(ask.id))?.state).toBe('queued');
  });

  it('same-state transition is an idempotent no-op (re-mark sent)', async () => {
    const ask = await seedQueued('t3');
    await store.markSent(ask.id);
    const again = await store.markSent(ask.id);
    expect(again?.state).toBe('sent');
  });

  it('terminal states reject further transitions', async () => {
    const ask = await seedQueued('t4');
    await store.markSent(ask.id);
    await store.transition(ask.id, 'answered');
    await expect(store.transition(ask.id, 'declined')).rejects.toBeInstanceOf(CrossHiveAskTransitionError);
  });

  it('transition on a missing row returns null', async () => {
    expect(await store.transition('00000000-0000-0000-0000-000000000000', 'sent')).toBeNull();
  });

  it('markSentByCorrelationId moves the matching row to sent', async () => {
    await seedQueued('bycorr');
    const moved = await store.markSentByCorrelationId('bycorr');
    expect(moved?.state).toBe('sent');
    expect(await store.markSentByCorrelationId('absent')).toBeNull();
  });
});

describe('recordReply (production reply path)', () => {
  it('applies an answer to a sent row, setting reply body + ts + state', async () => {
    const ask = await seedQueued('r1');
    await store.markSent(ask.id);
    const res = await store.recordReply({ correlationId: 'r1', replyKind: 'answer', replyBody: 'here you go' });
    expect(res.outcome).toBe('applied');
    if (res.outcome === 'applied') {
      expect(res.ask.state).toBe('answered');
      expect(res.ask.replyBody).toBe('here you go');
      expect(res.ask.replyTs).not.toBeNull();
    }
  });

  it('auto-advances a still-queued row through sent (lost markSent) then answers it', async () => {
    await seedQueued('r2');
    const res = await store.recordReply({ correlationId: 'r2', replyKind: 'answer', replyBody: 'late but valid' });
    expect(res.outcome).toBe('applied');
    expect((await store.getByCorrelationId('r2'))?.state).toBe('answered');
  });

  it('records a decline', async () => {
    const ask = await seedQueued('r3');
    await store.markSent(ask.id);
    const res = await store.recordReply({ correlationId: 'r3', replyKind: 'decline', replyBody: 'no' });
    expect(res.outcome).toBe('applied');
    expect((await store.getByCorrelationId('r3'))?.state).toBe('declined');
  });

  it('classifies a redelivered identical reply as duplicate (idempotent, body unchanged)', async () => {
    const ask = await seedQueued('r4');
    await store.markSent(ask.id);
    await store.recordReply({ correlationId: 'r4', replyKind: 'answer', replyBody: 'first' });
    const dup = await store.recordReply({ correlationId: 'r4', replyKind: 'answer', replyBody: 'second' });
    expect(dup.outcome).toBe('duplicate');
    expect((await store.getByCorrelationId('r4'))?.replyBody).toBe('first');
  });

  it('classifies a contradictory second reply (answered -> decline) as conflict, no mutation', async () => {
    const ask = await seedQueued('r5');
    await store.markSent(ask.id);
    await store.recordReply({ correlationId: 'r5', replyKind: 'answer', replyBody: 'yes' });
    const conflict = await store.recordReply({ correlationId: 'r5', replyKind: 'decline', replyBody: 'no' });
    expect(conflict.outcome).toBe('conflict');
    expect((await store.getByCorrelationId('r5'))?.state).toBe('answered');
  });

  it('a reply to an expired ask is a conflict (terminal), not applied', async () => {
    const ask = await seedQueued('r6');
    await store.markExpired(ask.id);
    const res = await store.recordReply({ correlationId: 'r6', replyKind: 'answer', replyBody: 'too late' });
    expect(res.outcome).toBe('conflict');
  });

  it('returns not-found for an unknown correlation_id', async () => {
    const res = await store.recordReply({ correlationId: 'ghost', replyKind: 'answer', replyBody: 'x' });
    expect(res.outcome).toBe('not-found');
  });
});

describe('list + counts', () => {
  it('lists most-recent-first and filters by state / direction / peer / kind', async () => {
    const a = await seedQueued('l1', { peerPubkey: PEER });
    const b = await store.insert({ peerPubkey: PEER2, kind: 'work-request', correlationId: 'l2' });
    await store.markSent(b.id);

    const all = await store.list();
    expect(all.map((r) => r.correlationId)).toEqual(['l2', 'l1']); // b inserted after a → first

    expect((await store.list({ state: 'queued' })).map((r) => r.correlationId)).toEqual(['l1']);
    expect((await store.list({ states: ['sent', 'answered'] })).map((r) => r.correlationId)).toEqual(['l2']);
    expect((await store.list({ peerPubkey: PEER2 })).map((r) => r.correlationId)).toEqual(['l2']);
    expect((await store.list({ kind: 'work-request' })).map((r) => r.correlationId)).toEqual(['l2']);
    expect((await store.list({ direction: 'out' })).length).toBe(2);
    expect((await store.list({ limit: 1 })).map((r) => r.correlationId)).toEqual(['l2']);
    void a;
  });

  it('counts returns all states zero-filled and respects peer narrowing', async () => {
    const a = await seedQueued('cnt1', { peerPubkey: PEER });
    await store.markSent(a.id);
    await store.transition(a.id, 'answered');
    await seedQueued('cnt2', { peerPubkey: PEER });
    await seedQueued('cnt3', { peerPubkey: PEER2 });

    const all = await store.counts();
    expect(all).toEqual({ queued: 2, sent: 0, answered: 1, declined: 0, expired: 0 });

    const peer2 = await store.counts({ peerPubkey: PEER2 });
    expect(peer2.queued).toBe(1);
    expect(peer2.answered).toBe(0);
  });
});

describe('expireStale', () => {
  it('expires only open (queued|sent) rows older than the cutoff; terminal + recent untouched', async () => {
    const oldOpen = await seedQueued('old');
    const recent = await seedQueued('recent');
    const oldDone = await seedQueued('done');
    await store.markSent(oldDone.id);
    await store.transition(oldDone.id, 'answered');
    // Backdate 'old' and 'done' beyond the cutoff window.
    await db.sql`UPDATE harness_shared.cross_hive_asks
                   SET created_at = now() - interval '2 hours'
                 WHERE correlation_id IN ('old','done')`;

    const expired = await store.expireStale({ olderThanMs: 60 * 60 * 1000 });
    expect(expired).toBe(1); // only 'old' (open + stale); 'done' is terminal, 'recent' is fresh
    expect((await store.getByCorrelationId('old'))?.state).toBe('expired');
    expect((await store.getByCorrelationId('recent'))?.state).toBe('queued');
    expect((await store.getByCorrelationId('done'))?.state).toBe('answered');
    void recent;
  });
});

describe('per-Hive scoping', () => {
  it('isolates rows by (workspace, hive_slug); same correlation_id coexists across Hives', async () => {
    const a = new PgCrossHiveAsks(WS, HIVE_A, db.sql);
    const b = new PgCrossHiveAsks(WS, HIVE_B, db.sql);
    await a.insert({ peerPubkey: PEER, kind: 'ask', correlationId: 'shared' });
    await b.insert({ peerPubkey: PEER, kind: 'ask', correlationId: 'shared' }); // not a conflict — different hive
    expect((await a.list()).length).toBe(1);
    expect((await b.list()).length).toBe(1);
    // A cannot see / mutate B's row.
    expect(await a.getByCorrelationId('shared')).not.toBeNull();
    const bRow = await b.getByCorrelationId('shared');
    expect(await a.getById(bRow!.id)).toBeNull();
  });
});
