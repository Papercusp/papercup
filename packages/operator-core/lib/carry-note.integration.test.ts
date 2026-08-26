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

// Keep the contention regression fast. The production default remains 8s; this
// test only needs to prove the loop path installs a DB-side lock bound.
const priorLoopLockTimeout = process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS;
process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS = '100';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const ordersNotify = vi.hoisted(() => ({
  notifyAgentOrdersChanged: vi.fn(async (_ownerId: string | null | undefined) => {}),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./agent-orders-notify', () => ordersNotify);
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const {
  setCarryNote,
  getCarryNote,
  getCarryJournal,
  setCarryNoteWithPrior,
  setLoopCarryNote,
  setLoopCarryNoteWithPrior,
  getLoopCarryNote,
  getLoopCarryNoteWithMeta,
  getLoopCarryJournal,
  shortCarryHash,
  hiveScope,
  workItemScope,
  loopScope,
  renderCarryNote,
  parseCarryNote,
} = await import('./carry-note');

if (priorLoopLockTimeout === undefined) delete process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS;
else process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS = priorLoopLockTimeout;

const CARRY_NOTES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
    workspace_id text NOT NULL,
    scope text NOT NULL,
    note text,
    journal jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_ts bigint NOT NULL,
    deps jsonb,
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
  ordersNotify.notifyAgentOrdersChanged.mockClear();
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

  it('returns after commit when the derived Orders invalidation never settles (EI-21390376601596579)', async () => {
    let release!: () => void;
    const stalledNotification = new Promise<void>((resolve) => {
      release = resolve;
    });
    ordersNotify.notifyAgentOrdersChanged.mockImplementationOnce(() => stalledNotification);

    let timer!: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      setLoopCarryNoteWithPrior(LOOP, 'near-limit carry anchor').then(() => 'settled' as const),
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), 250);
      }),
    ]);
    clearTimeout(timer);

    // Release the deliberately stalled best-effort push so the test leaves no
    // pending promise behind, then verify the write itself completed.
    release();
    expect(result).toBe('settled');
    expect(await getLoopCarryNote(LOOP)).toBe('near-limit carry anchor');
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

  it('bounded loop writes return a typed retryable contention error and preserve the prior note', async () => {
    const scope = loopScope(LOOP.harness, LOOP.ownerId);
    await setLoopCarryNote(LOOP, 'prior cold-wake anchor');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockedResolve = resolve;
    });
    const blocker = db.sql.begin(async (tx) => {
      await tx`
        SELECT note
          FROM harness_shared.carry_notes
         WHERE workspace_id = 'default' AND scope = ${scope}
         FOR UPDATE`;
      lockedResolve();
      await held;
    });

    await locked;
    const startedAt = Date.now();
    let error: unknown;
    try {
      await setLoopCarryNoteWithPrior(LOOP, 'blocked replacement');
    } catch (caught) {
      error = caught;
    } finally {
      release();
      await blocker;
    }

    expect(error).toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '55P03' });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(await getLoopCarryNote(LOOP)).toBe('prior cold-wake anchor');
  });

  it('expectedHash prevents a stale successor from replacing a newer note', async () => {
    await setLoopCarryNote(LOOP, 'newer checkpoint');

    const result = await setLoopCarryNoteWithPrior(LOOP, 'stale successor checkpoint', {
      expectedHash: shortCarryHash('older checkpoint'),
    });

    expect(result).toMatchObject({
      stored: 'newer checkpoint',
      blockedReason: 'expected_hash_mismatch',
      conflict: {
        expectedHash: shortCarryHash('older checkpoint'),
        currentHash: shortCarryHash('newer checkpoint'),
      },
    });
    expect(await getLoopCarryNote(LOOP)).toBe('newer checkpoint');
  });

  it('serializes same-baseline writers so exactly one wins the CAS', async () => {
    await setLoopCarryNote(LOOP, 'baseline checkpoint');
    const expectedHash = shortCarryHash('baseline checkpoint');

    const results = await Promise.all([
      setLoopCarryNoteWithPrior(LOOP, 'first successor', { expectedHash }),
      setLoopCarryNoteWithPrior(LOOP, 'second successor', { expectedHash }),
    ]);

    expect(results.filter((result) => result.conflict)).toHaveLength(1);
    expect(results.filter((result) => !result.conflict && result.stored !== 'baseline checkpoint')).toHaveLength(1);
    expect(['first successor', 'second successor']).toContain(await getLoopCarryNote(LOOP));
  });

  it('discards an older in-flight writer that commits after a newer checkpoint', async () => {
    await setLoopCarryNote(LOOP, 'baseline checkpoint');
    const scope = loopScope(LOOP.harness, LOOP.ownerId);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockedResolve = resolve;
    });
    const blocker = db.sql.begin(async (tx) => {
      await tx`
        SELECT note
          FROM harness_shared.carry_notes
         WHERE workspace_id = 'default' AND scope = ${scope}
         FOR UPDATE`;
      lockedResolve();
      await held;
    });

    await locked;
    // Queue the newer writer first, then queue the stale writer with an older
    // admission watermark. Once the blocker releases, the newer commit wins
    // the lock queue and the stale writer must be rejected by the store guard.
    const newer = setLoopCarryNoteWithPrior(LOOP, 'newer checkpoint');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const staleClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 10_000);
    const stale = setLoopCarryNoteWithPrior(LOOP, 'stale checkpoint');
    staleClock.mockRestore();

    release();
    const [newerResult, staleResult] = await Promise.all([newer, stale]);
    await blocker;

    expect(newerResult.stored).toBe('newer checkpoint');
    expect(staleResult).toMatchObject({
      stored: 'newer checkpoint',
      blockedReason: 'stale_write_older_than_current',
      staleWrite: {
        currentUpdatedAtMs: expect.any(Number),
      },
    });
    expect(await getLoopCarryNote(LOOP)).toBe('newer checkpoint');
  });

  it('discards an older in-flight writer when admission timestamps are equal', async () => {
    await setLoopCarryNote(LOOP, 'baseline checkpoint');
    const scope = loopScope(LOOP.harness, LOOP.ownerId);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockedResolve = resolve;
    });
    const blocker = db.sql.begin(async (tx) => {
      await tx`
        SELECT note
          FROM harness_shared.carry_notes
         WHERE workspace_id = 'default' AND scope = ${scope}
         FOR UPDATE`;
      lockedResolve();
      await held;
    });

    await locked;
    // Force both callers to capture the same admission watermark. The newer
    // request is queued first and commits first; the older request then sees
    // an equal updated_ts. A strict `>` stale-write guard incorrectly admits
    // that older write and loses the newer checkpoint.
    const fixedNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    // Use the underlying writer without the loop wrapper's deliberately short
    // lock budget. This test owns the row lock and must isolate ordering from
    // unrelated test-container contention.
    const write = (value: string) =>
      setCarryNoteWithPrior(
        { scope, workspaceId: 'default' },
        value,
        { bounded: false },
      );
    const newer = write('newer checkpoint');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stale = write('stale checkpoint');
    clock.mockRestore();

    release();
    const [newerResult, staleResult] = await Promise.all([newer, stale]);
    await blocker;

    expect(newerResult.stored).toBe('newer checkpoint');
    expect(staleResult).toMatchObject({
      stored: 'newer checkpoint',
      blockedReason: 'stale_write_older_than_current',
      staleWrite: {
        writeStartedAtMs: fixedNow,
        currentUpdatedAtMs: fixedNow,
      },
    });
    expect(await getLoopCarryNote(LOOP)).toBe('newer checkpoint');
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

  it('loop readers choose the newest host-skew row; the coord workspace only breaks timestamp ties', async () => {
    const scope = loopScope(LOOP.harness, LOOP.ownerId);
    await db.sql`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts)
      VALUES
        ('default', ${scope}, 'stale pinned checkpoint', '[{"at":1,"note":"stale"}]'::jsonb, 1700000000000),
        ('old-host-workspace', ${scope}, 'new fallback checkpoint', '[{"at":2,"note":"new"}]'::jsonb, 1700000001000)`;

    expect(await getLoopCarryNote(LOOP)).toBe('new fallback checkpoint');
    expect(await getLoopCarryNoteWithMeta(LOOP)).toEqual({
      note: 'new fallback checkpoint',
      updatedAtMs: 1700000001000,
    });
    expect((await getLoopCarryJournal(LOOP)).map((entry) => entry.note)).toEqual(['new']);

    await db.sql`
      UPDATE harness_shared.carry_notes
         SET updated_ts = 1700000000000
       WHERE workspace_id = 'old-host-workspace' AND scope = ${scope}`;
    expect(await getLoopCarryNoteWithMeta(LOOP)).toEqual({
      note: 'stale pinned checkpoint',
      updatedAtMs: 1700000000000,
    });
  });

  it('loopScope keys by ownerId — two loops on the same harness do not collide', async () => {
    await setLoopCarryNote({ harness: 'papercusp', ownerId: 'su-a' }, 'A');
    await setLoopCarryNote({ harness: 'papercusp', ownerId: 'su-b' }, 'B');
    expect(await getLoopCarryNote({ harness: 'papercusp', ownerId: 'su-a' })).toBe('A');
    expect(await getLoopCarryNote({ harness: 'papercusp', ownerId: 'su-b' })).toBe('B');
    expect(loopScope('papercusp', 'su-a')).not.toBe(loopScope('papercusp', 'su-b'));
  });
});

describe("WI-3648: a '*' workspaceId (the unscoped-superuser read wildcard) never keys its own row", () => {
  // Same bug class as EI-8824/EI-3409/WI-892, but on the READ side: '*' is
  // TRUTHY, so a bare `ref.workspaceId ?? activeWorkspaceId()` let it win
  // outright instead of falling back — silently keying a wildcard-scoped
  // caller's read/write under the literal workspace_id='*', divergent from
  // every concrete-workspace write/read of the SAME scope. Observed live: a
  // work_items:checkpoint write (which resolves through
  // resolveConcreteWorkspaceId, per EI-8824) landed under the concrete ws, but
  // orient's post-compaction recovery fold (carry-brief.ts's
  // readHeldWorkItems → getWorkItemCheckpoint) passed ctx.workspaceId — '*'
  // for an unscoped su session — straight through, so the read missed the
  // fresh write and silently returned a stale row (or nothing).
  it("'*' resolves to the SAME concrete row as omitting workspaceId — not its own separate row", async () => {
    const scope = workItemScope('h1', 'WI-wildcard');
    expect(await setCarryNote({ scope }, 'written under the concrete default ws', { journal: false })).toBe(
      'written under the concrete default ws',
    );
    // A caller passing the wildcard explicitly (e.g. an unscoped superuser
    // ctx.workspaceId) must read back the SAME row as a caller that omitted
    // workspaceId entirely — never a distinct, always-empty '*'-keyed row.
    expect(await getCarryNote({ scope, workspaceId: '*' })).toBe('written under the concrete default ws');
    // And a write under the wildcard lands on that same concrete row too —
    // round-trips through the wildcard exactly like omitting it.
    expect(await setCarryNote({ scope, workspaceId: '*' }, 'updated via wildcard', { journal: false })).toBe(
      'updated via wildcard',
    );
    expect(await getCarryNote({ scope })).toBe('updated via wildcard');
    expect(await rowCount()).toBe(1); // never a second, orphaned '*' row
  });

  it('an empty-string workspaceId is treated the same as omitted/wildcard — not its own row', async () => {
    const scope = workItemScope('h1', 'WI-empty-ws');
    await setCarryNote({ scope, workspaceId: '' }, 'via empty string', { journal: false });
    expect(await getCarryNote({ scope })).toBe('via empty string');
    expect(await rowCount()).toBe(1);
  });
});
