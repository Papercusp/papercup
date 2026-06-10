/**
 * watermark-crash-restart.integration.test.ts — P-002 of
 * coord-system-e2e-testing-2026-06-10.
 *
 * The watermark protocol's crash contract, proven on REAL Postgres across a
 * hard process kill: an agent consumes to cursor N, dies, restarts with ZERO
 * in-memory state, and resumes at exactly N+1 — no replay of ≤N after a
 * committed turn, never a skip — across BOTH surface families:
 *
 *   LINE  (`messages` — pure append ordered by id, ts-cursor
 *          `messages_since_ts`), and
 *   EVENT (`escalations` — one immutable record per (workspace, surface,
 *          msg_id), ts-cursor `escalations_since_ts`).
 *
 * A "process" here is a dedicated postgres() connection + fresh PgCoordLog /
 * PgWatermarkStore instances bound into the production host seams
 * (configureCoordLog / configureWatermarkStore); a HARD KILL closes the
 * connection and discards every in-memory object, so the only thing that can
 * carry the cursor across the kill is the PG row — exactly the crash claim.
 * Consumption drives the real adapters (readInbox / listEscalations +
 * readWatermark / writeWatermark) following the documented turn protocol:
 * read watermark → read surface since cursor → consume → COMMIT at turn end
 * (an uncommitted turn re-sees its entries — at-least-once by design, never
 * a skip).
 *
 * Envelope timestamps are EXPLICIT (appended via the coordLog facade) so the
 * scenario is fully deterministic, including the SAME-TS BOUNDARY case: the
 * ts-based cursor filters strictly-later, so committing the ts of a
 * PARTIALLY-consumed same-ts group skips its uncommitted siblings — pinned
 * here as the protocol's documented sharp edge (logged in the coverage
 * matrix), together with the safe-commit rule (commit the previous DISTINCT
 * ts → both re-seen, never skipped).
 *
 * Bootstrap mirrors cross-agent-isolation.integration.test.ts: testcontainer
 * PG via getTestPg(), canonical DDL from the package, module-top gating,
 * unique workspace + owners per case.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';

import { PgCoordLog, ensureCoordEventLogTable } from '@papercusp/coordination/event-log';
import { PgWatermarkStore, ensureCoordWatermarksTable } from '@papercusp/coordination/watermark-store';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { getTestPg } from '@papercusp/test-config';

import { configureCoordLog, resetCoordLog, coordLog } from '../log';
import { readInbox } from '../messages';
import { listEscalations } from '../escalations';
import {
  configureWatermarkStore,
  resetWatermarkStore,
  readWatermark,
  writeWatermark,
} from '../watermarks';

let url: string | null = null;
let bootSql: Sql | null = null;
let pgOk = false;

try {
  url = await getTestPg();
  bootSql = postgres(url, {
    onnotice: () => {},
    connection: { search_path: 'harness_shared, public' },
    prepare: false,
    max: 2,
  });
  await bootSql`SELECT 1`;
  await ensureCoordEventLogTable(bootSql);
  await ensureCoordWatermarksTable(bootSql);
  pgOk = true;
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[watermark-crash-restart] PG not reachable, skipping:', (e as Error)?.message);
}

const WS = `wmcr-${randomBytes(4).toString('hex')}`;
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (i: number) => new Date(BASE + i * 1_000).toISOString();

/** A simulated PROCESS: its own PG connection + fresh store instances bound
 *  into the host seams. Nothing else in the test holds coord state. */
interface Proc {
  sql: Sql;
}
function bootProcess(): Proc {
  const sql = postgres(url!, {
    onnotice: () => {},
    connection: { search_path: 'harness_shared, public' },
    prepare: false,
    max: 2,
  });
  configureCoordLog(new PgCoordLog({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: WS }));
  configureWatermarkStore(new PgWatermarkStore({ getSql: () => sql, ensureSchema: async () => {} }));
  return { sql };
}
/** HARD KILL: drop every in-memory object; only PG rows survive. */
async function hardKill(proc: Proc): Promise<void> {
  resetCoordLog();
  resetWatermarkStore();
  await proc.sql.end({ timeout: 1 });
}

function msgEnv(i: number, from: string, to: string, opts: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return {
    ts: iso(i),
    msg_id: `m-${String(i).padStart(3, '0')}`,
    from,
    to: [to],
    kind: 'message',
    summary: `M${i}`,
    ...opts,
  };
}

function escEnv(i: number, from: string): CoordEnvelope {
  return {
    ts: iso(i),
    msg_id: `e-${String(i).padStart(3, '0')}`,
    from,
    to: ['human'],
    kind: 'escalation',
    severity: 'warn',
    summary: `E${i}`,
    resolved: null,
  };
}

/** One consumer turn on the LINE surface: read cursor → read inbox since it →
 *  consume a prefix → commit the last consumed ts (the documented protocol). */
async function lineTurn(owner: string, consume: number, opts: { commit?: boolean | string } = {}) {
  const wm = await readWatermark(owner);
  const inbox = await readInbox(owner, {
    since_ts: wm.messages_since_ts || undefined,
  });
  const consumed = inbox.slice(0, consume);
  const commit = opts.commit ?? true;
  if (commit && consumed.length) {
    const ts = typeof commit === 'string' ? commit : consumed[consumed.length - 1].ts;
    await writeWatermark(owner, { messages_since_ts: ts });
  }
  return { inbox, consumed };
}

/** One consumer turn on the EVENT surface (escalations): same protocol, the
 *  surface read being the folded immutable records filtered by the cursor. */
async function eventTurn(owner: string, consume: number) {
  const wm = await readWatermark(owner);
  const sinceMs = wm.escalations_since_ts ? Date.parse(wm.escalations_since_ts) : 0;
  const all = await listEscalations();
  const fresh = all
    .filter((e) => Date.parse(e.ts) > sinceMs)
    .sort((a, b) => (a.ts === b.ts ? a.msg_id.localeCompare(b.msg_id) : a.ts.localeCompare(b.ts)));
  const consumed = fresh.slice(0, consume);
  if (consumed.length) {
    await writeWatermark(owner, { escalations_since_ts: consumed[consumed.length - 1].ts });
  }
  return { fresh, consumed };
}

describe.skipIf(!pgOk)('watermark crash-restart (P-002) — real PG, hard kill between turns', () => {
  let proc: Proc;

  beforeEach(() => {
    proc = bootProcess();
  });
  afterEach(async () => {
    await hardKill(proc).catch(() => {});
  });
  afterAll(async () => {
    if (!bootSql) return;
    try {
      await bootSql`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${WS}`;
      await bootSql`DELETE FROM harness_shared.coord_watermarks WHERE owner_id LIKE ${'wmcr-%'}`;
    } catch {
      /* best-effort */
    }
    await bootSql.end({ timeout: 5 });
  });

  it('LINE (messages): consume to N, hard-kill, restart → resumes at exactly N+1', async () => {
    const reader = 'wmcr-line-reader';
    const sender = 'wmcr-line-sender';
    for (let i = 1; i <= 5; i++) await coordLog.appendLine('messages', sender, msgEnv(i, sender, reader));

    // Turn 1 in process 1: sees all 5, consumes 3, COMMITS at ts(M3).
    const t1 = await lineTurn(reader, 3);
    expect(t1.inbox.map((m) => m.summary)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5']);
    expect(t1.consumed.map((m) => m.summary)).toEqual(['M1', 'M2', 'M3']);

    // HARD KILL — only the PG watermark row survives.
    await hardKill(proc);
    proc = bootProcess();

    // The cursor round-tripped through PG exactly.
    expect((await readWatermark(reader)).messages_since_ts).toBe(iso(3));

    // Turn 2 in process 2: EXACTLY N+1 first — no replay of M1–M3, no skip of M4.
    const t2 = await lineTurn(reader, 2);
    expect(t2.inbox.map((m) => m.summary)).toEqual(['M4', 'M5']);
    expect(t2.consumed.map((m) => m.summary)).toEqual(['M4', 'M5']);

    // Quiescence: a third process sees nothing new.
    await hardKill(proc);
    proc = bootProcess();
    const t3 = await lineTurn(reader, 1);
    expect(t3.inbox).toEqual([]);
  });

  it('LINE: a crash BEFORE the commit re-sees the same entries (at-least-once, never a skip)', async () => {
    const reader = 'wmcr-abort-reader';
    const sender = 'wmcr-abort-sender';
    for (let i = 1; i <= 3; i++) await coordLog.appendLine('messages', sender, msgEnv(i, sender, reader));

    // Turn 1 consumes 2 but DIES before the turn-end commit.
    const t1 = await lineTurn(reader, 2, { commit: false });
    expect(t1.consumed.map((m) => m.summary)).toEqual(['M1', 'M2']);
    await hardKill(proc);
    proc = bootProcess();

    // Restart: the watermark never advanced, so the aborted turn's entries are
    // RE-SEEN in full — the designed conservative semantics (delay, never drop).
    const t2 = await lineTurn(reader, 3);
    expect(t2.inbox.map((m) => m.summary)).toEqual(['M1', 'M2', 'M3']);
  });

  it('EVENT (escalations): consume to N, hard-kill, restart → resumes at exactly N+1; records immutable', async () => {
    const reader = 'wmcr-event-reader';
    const opener = 'wmcr-event-opener';
    for (let i = 1; i <= 4; i++) await coordLog.putEvent('escalations', `e-${String(i).padStart(3, '0')}`, escEnv(i, opener));
    // EVENT surface immutability: a re-put on an existing msg_id does NOT mint
    // a second record (one immutable record per (workspace, surface, msg_id)).
    await coordLog.putEvent('escalations', 'e-001', escEnv(1, opener));
    expect((await listEscalations()).filter((e) => e.msg_id === 'e-001')).toHaveLength(1);

    // Turn 1: consume 2 of 4, commit at ts(E2), then die.
    const t1 = await eventTurn(reader, 2);
    expect(t1.fresh.map((e) => e.summary)).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(t1.consumed.map((e) => e.summary)).toEqual(['E1', 'E2']);
    await hardKill(proc);
    proc = bootProcess();

    // Restart resumes at exactly E3 — no replay, no skip.
    expect((await readWatermark(reader)).escalations_since_ts).toBe(iso(2));
    const t2 = await eventTurn(reader, 2);
    expect(t2.fresh.map((e) => e.summary)).toEqual(['E3', 'E4']);
  });

  it('SAME-TS boundary: the ts cursor’s sharp edge, and the safe-commit rule that avoids it', async () => {
    const reader = 'wmcr-edge-reader';
    const sender = 'wmcr-edge-sender';
    // M1 at iso(1); then a SAME-TS pair at iso(2) (msg_id orders them).
    await coordLog.appendLine('messages', sender, msgEnv(1, sender, reader));
    await coordLog.appendLine('messages', sender, { ...msgEnv(2, sender, reader), msg_id: 'm-x', summary: 'Mx' });
    await coordLog.appendLine('messages', sender, { ...msgEnv(2, sender, reader), msg_id: 'm-y', summary: 'My' });

    // NAIVE commit mid-group: consume M1+Mx, commit at the shared ts(2) → the
    // strictly-later filter EXCLUDES the unconsumed My on restart. This is the
    // documented sharp edge of a ts-based cursor (coverage-matrix ⚪): a
    // consumer must never commit a partially-consumed ts group.
    const t1 = await lineTurn(reader, 2);
    expect(t1.consumed.map((m) => m.summary)).toEqual(['M1', 'Mx']);
    await hardKill(proc);
    proc = bootProcess();
    const naive = await lineTurn(reader, 3, { commit: false });
    expect(naive.inbox.map((m) => m.summary)).toEqual([]); // My is SKIPPED — the hazard, pinned

    // SAFE-COMMIT rule: roll the cursor back to the previous DISTINCT ts (what
    // a correct consumer commits when its consumption ends mid-group) → both
    // same-ts entries are re-seen — at-least-once, never a skip.
    await writeWatermark(reader, { messages_since_ts: iso(1) });
    await hardKill(proc);
    proc = bootProcess();
    const safe = await lineTurn(reader, 2);
    expect(safe.inbox.map((m) => m.summary)).toEqual(['Mx', 'My']);
  });
});
