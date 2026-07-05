/**
 * carry-note.integration.test.ts — the ONE shared carry-note substrate against
 * real Postgres (su-cold-auto-mode-2026-07-03 Phase 1 / P-001·P-002).
 *
 * Proves the durable read/write round-trip (P-002's test), the D-003 semantics
 * shared by all three carriers, and the two journaling modes:
 *   - journaling ON (Queen / su loop): a write appends to the trajectory ring;
 *     a CLEAR keeps the row (note→null) while the journal survives.
 *   - journaling OFF (bee checkpoint): pure note, no ring, a CLEAR deletes the row.
 * Plus scope + workspace isolation, and that the three roles converge on ONE store.
 *
 * The inline DDL mirrors migration 472's table; the grants/RLS are validated by
 * fresh-migrate.integration.test.ts. Gated on Docker like the other *-integration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const {
  setCarryNote,
  getCarryNote,
  getCarryJournal,
  setLoopCarryNote,
  getLoopCarryNote,
  getLoopCarryJournal,
  hiveScope,
  workItemScope,
  loopScope,
  renderCarryNote,
  parseCarryNote,
} = await import('./carry-note');

const CARRY_NOTES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
    workspace_id text NOT NULL,
    scope text NOT NULL,
    note text,
    journal jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_ts bigint NOT NULL,
    PRIMARY KEY (workspace_id, scope))`;

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('carry-note');
  h.sql = db.sql;
  await db.sql.unsafe(CARRY_NOTES_DDL);
}, 60_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.carry_notes`;
});

async function rowCount(): Promise<number> {
  const r = await db.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM harness_shared.carry_notes`;
  return Number(r[0]?.n ?? 0);
}

const LOOP = { harness: 'papercusp', ownerId: 'su-94b69' } as const;

describe('su-loop carry-note read/write round-trip (P-002)', () => {
  it('write → read round-trips; replace-on-write keeps ONE row', async () => {
    expect(await getLoopCarryNote(LOOP)).toBeNull(); // fresh
    expect(await setLoopCarryNote(LOOP, '  did X; next Y  ')).toBe('did X; next Y'); // trimmed
    expect(await getLoopCarryNote(LOOP)).toBe('did X; next Y');
    await setLoopCarryNote(LOOP, 'second');
    expect(await getLoopCarryNote(LOOP)).toBe('second');
    expect(await rowCount()).toBe(1);
  });

  it('a cold wake reads the SAME note the warm session left (the whole point)', async () => {
    await setLoopCarryNote(LOOP, 'reconstruct: mid-Phase-2, psu-host verbs half-wired');
    // A "cold" reader is just a fresh read on the same (harness, ownerId).
    expect(await getLoopCarryNote(LOOP)).toBe('reconstruct: mid-Phase-2, psu-host verbs half-wired');
  });

  it('the structured shape round-trips end-to-end (render → store → read → parse)', async () => {
    const fields = { did: 'built the substrate', left: 'psu-host', insight: 'reuse bee lifecycle', next: 'P-004' };
    await setLoopCarryNote(LOOP, renderCarryNote(fields));
    const read = await getLoopCarryNote(LOOP);
    expect(parseCarryNote(read ?? '')).toEqual(fields);
  });

  it('journaling ON: the loop trajectory accumulates newest-first and survives a clear', async () => {
    await setLoopCarryNote(LOOP, 'wake 1');
    await setLoopCarryNote(LOOP, 'wake 2');
    const j = await getLoopCarryJournal(LOOP);
    expect(j.map((e) => e.note)).toEqual(['wake 2', 'wake 1']); // newest-first
    // Clear the active note — the journal (trajectory) persists, row stays.
    expect(await setLoopCarryNote(LOOP, null)).toBeNull();
    expect(await getLoopCarryNote(LOOP)).toBeNull();
    expect((await getLoopCarryJournal(LOOP)).map((e) => e.note)).toEqual(['wake 2', 'wake 1']);
    expect(await rowCount()).toBe(1); // row lingers to hold the journal
  });
});

describe('D-003 shared semantics + journaling modes', () => {
  it('journaling OFF (bee checkpoint): no ring, and a CLEAR deletes the row', async () => {
    const wi = { scope: workItemScope('h1', 'WI-1') };
    expect(await setCarryNote(wi, 'phase 2 of 5', { journal: false })).toBe('phase 2 of 5');
    expect(await getCarryNote(wi)).toBe('phase 2 of 5');
    expect(await getCarryJournal(wi)).toEqual([]); // no trajectory ring
    expect(await rowCount()).toBe(1);
    // Clear ⇒ row deleted (graceful degradation, mig 281 semantics).
    expect(await setCarryNote(wi, '  ', { journal: false })).toBeNull();
    expect(await getCarryNote(wi)).toBeNull();
    expect(await rowCount()).toBe(0);
  });

  it('any length round-trips (no cap on the active note)', async () => {
    const big = 'x'.repeat(200_000);
    await setCarryNote({ scope: workItemScope('h1', 'WI-BIG') }, big, { journal: false });
    expect(await getCarryNote({ scope: workItemScope('h1', 'WI-BIG') })).toBe(big);
  });

  it('reading a missing / cleared note returns null; missing journal returns []', async () => {
    expect(await getCarryNote({ scope: 'nope' })).toBeNull();
    expect(await getCarryJournal({ scope: 'nope' })).toEqual([]);
  });
});

describe('the three roles converge on ONE store, isolated by scope + workspace', () => {
  it('hive / workitem / loop are distinct rows in the same table', async () => {
    await setCarryNote({ scope: hiveScope() }, 'queen note');
    await setCarryNote({ scope: workItemScope('h1', 'WI-9') }, 'bee note', { journal: false });
    await setLoopCarryNote(LOOP, 'loop note');
    expect(await rowCount()).toBe(3);
    expect(await getCarryNote({ scope: hiveScope() })).toBe('queen note');
    expect(await getCarryNote({ scope: workItemScope('h1', 'WI-9') })).toBe('bee note');
    expect(await getLoopCarryNote(LOOP)).toBe('loop note');
  });

  it('base store is workspace-scoped; LOOP notes are workspace-PINNED + skew-tolerant', async () => {
    // The generic store isolates by workspace…
    await setCarryNote({ scope: 'iso-scope', workspaceId: 'other-ws' }, 'theirs', { journal: false });
    expect(await getCarryNote({ scope: 'iso-scope' })).toBeNull(); // default ws
    expect(await getCarryNote({ scope: 'iso-scope', workspaceId: 'other-ws' })).toBe('theirs');
    // …but the LOOP wrapper deliberately PINS the coord workspace on write and
    // falls back to any-workspace on read (2026-07-03 cold-auto host-skew fix:
    // the producer and the wake-executor must address the same row no matter
    // which host/ctx they run under) — a caller-supplied workspaceId is ignored,
    // so the note resolves for the same (harness, ownerId) from ANY ctx.
    await setLoopCarryNote({ ...LOOP, workspaceId: 'other-ws' }, 'mine');
    expect(await getLoopCarryNote(LOOP)).toBe('mine');
    expect(await getLoopCarryNote({ ...LOOP, workspaceId: 'other-ws' })).toBe('mine');
  });

  it('loopScope keys by ownerId — two loops on the same harness do not collide', async () => {
    await setLoopCarryNote({ harness: 'papercusp', ownerId: 'su-a' }, 'A');
    await setLoopCarryNote({ harness: 'papercusp', ownerId: 'su-b' }, 'B');
    expect(await getLoopCarryNote({ harness: 'papercusp', ownerId: 'su-a' })).toBe('A');
    expect(await getLoopCarryNote({ harness: 'papercusp', ownerId: 'su-b' })).toBe('B');
    expect(loopScope('papercusp', 'su-a')).not.toBe(loopScope('papercusp', 'su-b'));
  });
});
