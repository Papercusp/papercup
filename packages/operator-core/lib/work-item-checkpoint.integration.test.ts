/**
 * work-item-checkpoint.integration.test.ts — the bee work-item checkpoint store
 * (bee-context-efficiency-2026-06-14 P-010; D-002/D-003), against real Postgres.
 *
 * Asserts setHiveCarryNote semantics on a WORK-ITEM-scoped store: write→read,
 * replace-on-write, trim, blank/null/undefined ⇒ clear (row deleted), any length,
 * successor-bee inheritance (the checkpoint lives on the work-item, D-002), and
 * workspace isolation. The migration-281 grants/RLS are validated separately by
 * fresh-migrate.integration.test.ts (which seeds the framework roles); the store
 * semantics only need the table, so the inline DDL mirrors migration 281's table.
 * Gated on Docker like the other *-integration tests.
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

const { setWorkItemCheckpoint, getWorkItemCheckpoint } = await import('./work-item-checkpoint');
const { workItemScope } = await import('./carry-note');

const HARNESS = 'h1';

// As of su-cold-auto-mode P-001 the bee checkpoint IS a scope on the shared
// carry-note store (mig 472). The bee uses journal:false, so a clear DELETES the
// row exactly as the pre-P-001 work_item_checkpoints table did — this suite's
// row-existence semantics are unchanged; only the table + scope key move.
const CARRY_NOTES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
    workspace_id text NOT NULL,
    scope text NOT NULL,
    note text,
    journal jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_ts bigint NOT NULL,
    PRIMARY KEY (workspace_id, scope))`;
const WORK_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_items (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    last_progress_at timestamptz,
    PRIMARY KEY (workspace_id, harness_slug, feature_id))`;
const ENGINEER_ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default',
    issue_id text NOT NULL,
    state text NOT NULL DEFAULT 'open',
    assignee text,
    assigned_at timestamptz,
    updated_at timestamptz,
    PRIMARY KEY (workspace_id, issue_id))`;

let db: FreshPgDb;
// EI-9013: the store now canonicalizes the workspace via resolveConcreteWorkspaceId,
// whose INTERNAL fallback call to activeWorkspaceId() the module mock above cannot
// intercept (same-module internal call — see checkpoint.test.ts's EI-8824 note). Pin
// the env override (workspace-registry precedence #2) so omitted-workspace calls
// deterministically resolve to 'default' like the mock used to guarantee.
const PRIOR_WS_ENV = process.env.PAPERCUSP_WORKSPACE_ID;
beforeAll(async () => {
  process.env.PAPERCUSP_WORKSPACE_ID = 'default';
  db = await createFreshPgDb('work-item-checkpoint');
  h.sql = db.sql;
  await db.sql.unsafe(CARRY_NOTES_DDL);
  await db.sql.unsafe(WORK_ITEMS_DDL);
  await db.sql.unsafe(ENGINEER_ISSUES_DDL);
}, 60_000);
afterAll(async () => {
  if (PRIOR_WS_ENV === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = PRIOR_WS_ENV;
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.carry_notes`;
  await db.sql`DELETE FROM harness_shared.work_items`;
  await db.sql`DELETE FROM harness_shared.engineer_issues`;
});

async function rowCount(): Promise<number> {
  const r = await db.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM harness_shared.carry_notes`;
  return Number(r[0]?.n ?? 0);
}

describe('work-item checkpoint store (P-010, real PG) — setHiveCarryNote semantics', () => {
  it('write → read round-trips', async () => {
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'phase 2 of 5; edited foo.ts')).toBe(
      'phase 2 of 5; edited foo.ts',
    );
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('phase 2 of 5; edited foo.ts');
  });

  it('replace-on-write: the latest write wins (one row, not appended)', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'first');
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'second');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('second');
    expect(await rowCount()).toBe(1);
  });

  it('trims the stored value (mirrors setHiveCarryNote)', async () => {
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, '  padded  ')).toBe('padded');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('padded');
  });

  it('blank / null / undefined ⇒ CLEAR (deletes the row); re-read is null', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'state');
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, '   ')).toBeNull(); // blank clears
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull();
    expect(await rowCount()).toBe(0);

    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'again');
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, null)).toBeNull(); // null clears
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull();

    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'yet again');
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, undefined)).toBeNull(); // undefined clears
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull();
  });

  it('clearing a non-existent checkpoint is a no-op (idempotent)', async () => {
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'NOPE' }, '')).toBeNull();
    expect(await rowCount()).toBe(0);
  });

  it('reading a missing checkpoint returns null', async () => {
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'MISSING' })).toBeNull();
  });

  it('any length — a large compressed blob round-trips (no cap)', async () => {
    const big = 'x'.repeat(200_000);
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-BIG' }, big);
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-BIG' })).toBe(big);
  });

  it('WORK-ITEM-scoped (D-002): a successor reader on the SAME work-item inherits the checkpoint', async () => {
    // The bee that wrote it is irrelevant — the checkpoint lives on the work-item,
    // so any later reader (a re-woken bee OR a successor after eviction) gets it.
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-HANDOFF' }, 'predecessor left this');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-HANDOFF' })).toBe('predecessor left this');
  });

  it('checkpoint progress refreshes issue-family assigned_at, the current issue progress anchor', async () => {
    await db.sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, state, assignee, assigned_at, updated_at)
      VALUES
        ('default', 'WI-ISSUE-PROGRESS', 'open', 'su-holder', now() - interval '30 minutes', now() - interval '30 minutes')`;

    const [before] = await db.sql<{ assigned_at: Date; updated_at: Date }[]>`
      SELECT assigned_at, updated_at
        FROM harness_shared.engineer_issues
       WHERE issue_id = 'WI-ISSUE-PROGRESS'`;

    expect(await setWorkItemCheckpoint(
      { harness: HARNESS, workItemId: 'WI-ISSUE-PROGRESS' },
      'still working; refreshed progress anchor',
    )).toBe('still working; refreshed progress anchor');

    const [after] = await db.sql<{ assigned_at: Date; updated_at: Date }[]>`
      SELECT assigned_at, updated_at
        FROM harness_shared.engineer_issues
       WHERE issue_id = 'WI-ISSUE-PROGRESS'`;
    expect(after.assigned_at.getTime()).toBeGreaterThan(before.assigned_at.getTime());
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('checkpoints are independent per work-item and per harness', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'one');
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-2' }, 'two');
    await setWorkItemCheckpoint({ harness: 'h2', workItemId: 'WI-1' }, 'other-harness');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('one');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-2' })).toBe('two');
    expect(await getWorkItemCheckpoint({ harness: 'h2', workItemId: 'WI-1' })).toBe('other-harness');
  });

  it('EI-8805: a harness-null item round-trips (write → read back the same continuity state)', async () => {
    // A harness-null item — an issue-family EI filed from an unscoped su session — has
    // no harness. Previously the write silently orphaned its checkpoint (keyed under the
    // session harness while the read looked under the item's null harness); the store
    // now canonicalizes a null harness to one namespace so the checkpoint survives.
    expect(await setWorkItemCheckpoint({ harness: null, workItemId: 'EI-1' }, 'harness-null continuity')).toBe(
      'harness-null continuity',
    );
    expect(await getWorkItemCheckpoint({ harness: null, workItemId: 'EI-1' })).toBe('harness-null continuity');
  });

  it('EI-8805: cross-key agreement — a write under the unscoped wildcard reads back under the item null harness', async () => {
    // The unscoped su session resolves its harness to the '*' wildcard on write; the read
    // side (work_items:get) keys by the item's OWN null harness. null and '*' must
    // collapse onto ONE namespace or the write is invisible to the read — the exact
    // EI-8805 defect. Assert both directions.
    expect(await setWorkItemCheckpoint({ harness: '*', workItemId: 'EI-2' }, 'written under wildcard')).toBe(
      'written under wildcard',
    );
    expect(await getWorkItemCheckpoint({ harness: null, workItemId: 'EI-2' })).toBe('written under wildcard');

    expect(await setWorkItemCheckpoint({ harness: null, workItemId: 'EI-3' }, 'written under null')).toBe(
      'written under null',
    );
    expect(await getWorkItemCheckpoint({ harness: '*', workItemId: 'EI-3' })).toBe('written under null');
  });

  it("EI-9013: the unscoped-session literal '*' workspace canonicalizes to the concrete workspace on BOTH write and read", async () => {
    // The EI-9013/EI-8824 class: an unscoped su session's ctx.workspaceId is the
    // literal '*'. A write keyed under '*' is invisible to every concrete-workspace
    // read (the incident: a confirmed-successful checkpoint read back null after
    // compaction). The substrate now canonicalizes at BOTH seams.
    expect(
      await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013', workspaceId: '*' }, 'wildcard write'),
    ).toBe('wildcard write');
    // Readable with the workspace omitted (concrete), passed concretely, and passed as '*'.
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013' })).toBe('wildcard write');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013', workspaceId: 'default' })).toBe('wildcard write');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013', workspaceId: '*' })).toBe('wildcard write');
    // No literal-'*' row was ever persisted.
    const star = await db.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM harness_shared.carry_notes WHERE workspace_id = '*'`;
    expect(Number(star[0]?.n ?? 0)).toBe(0);
    // And the reverse direction: a '*'-scoped READ finds a concretely-written row.
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013-B', workspaceId: 'default' }, 'concrete write');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013-B', workspaceId: '*' })).toBe('concrete write');
  });

  it('workspace-scoped: a checkpoint in another workspace is invisible here', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1', workspaceId: 'other-ws' }, 'theirs');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull(); // default ws
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1', workspaceId: 'other-ws' })).toBe('theirs');
  });
});

// C6 [P3] — concurrency under contention + the cross-workspace PK isolation guarantee.
// The store is a single UPSERT keyed by (workspace_id, harness_slug, work_item_id). Two bees
// (a re-woken one + a successor, or two surfaces of the same bee) can race a write to the SAME
// checkpoint; the ON CONFLICT DO UPDATE must leave EXACTLY ONE coherent row — one writer's full
// value, never an interleaved/corrupted blob, never two rows. And because the PK leads with
// workspace_id, a write/clear in one workspace must NEVER perturb the same (harness, workItem)
// in another — the multi-workspace install isolation (operator_multi_workspace) rides on this.
describe('work-item checkpoint store (C6) — concurrent writes + cross-workspace PK isolation', () => {
  async function rowsFor(workItemId: string): Promise<{ workspace_id: string; checkpoint: string }[]> {
    // The bee's row is keyed by scope 'workitem:<harness>:<id>' across every workspace.
    return db.sql<{ workspace_id: string; checkpoint: string }[]>`
      SELECT workspace_id, note AS checkpoint FROM harness_shared.carry_notes
       WHERE scope = ${workItemScope(HARNESS, workItemId)} ORDER BY workspace_id`;
  }

  it('two CONCURRENT writes to the same checkpoint → exactly ONE row, value is ONE writer (never corrupted/interleaved)', async () => {
    // Fire N distinct, individually-coherent writers at the same key simultaneously. The UPSERT
    // serializes them; the survivor must be ONE of the inputs verbatim — no row gets a spliced blob.
    const writers = Array.from({ length: 12 }, (_, i) => `writer-${i}-${'='.repeat(i)}|coherent-snapshot`);
    await Promise.all(
      writers.map((cp) => setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RACE' }, cp)),
    );
    const rows = await rowsFor('WI-RACE');
    expect(rows).toHaveLength(1); // exactly one row survives — the PK held under contention
    expect(writers).toContain(rows[0].checkpoint); // it's one writer's WHOLE value, not a merge
    // The read path agrees with the stored row (no torn read).
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RACE' })).toBe(rows[0].checkpoint);
  });

  it('a concurrent write vs clear converges to a single definite state (one row, or none) — never two rows', async () => {
    // A successor writing while a predecessor clears (eviction) is a legitimate race. Whichever
    // lands last wins; either way the table holds 0-or-1 row for the key — never a duplicate.
    await Promise.all([
      setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RC' }, 'successor wrote this'),
      setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RC' }, ''), // clear
      setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RC' }, 'and another'),
    ]);
    const rows = await rowsFor('WI-RC');
    expect(rows.length).toBeLessThanOrEqual(1); // 0 (clear won) or 1 (a write won) — never 2
    if (rows.length === 1) {
      expect(['successor wrote this', 'and another']).toContain(rows[0].checkpoint);
    }
  });

  it('cross-workspace PK isolation: a write/clear in WS-A leaves the SAME (harness, workItem) in WS-B untouched', async () => {
    // Same harness + same work-item id in two workspaces are DISTINCT rows (PK leads with workspace_id).
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' }, 'A-state');
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-b' }, 'B-state');
    expect(await rowsFor('WI-ISO')).toEqual([
      { workspace_id: 'ws-a', checkpoint: 'A-state' },
      { workspace_id: 'ws-b', checkpoint: 'B-state' },
    ]);

    // Re-WRITE in WS-A → WS-B is unchanged.
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' }, 'A-state-2');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-b' })).toBe('B-state');

    // CLEAR in WS-A (delete that row) → WS-B's row is still present + intact.
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' }, null)).toBeNull();
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' })).toBeNull();
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-b' })).toBe('B-state');
    expect(await rowsFor('WI-ISO')).toEqual([{ workspace_id: 'ws-b', checkpoint: 'B-state' }]);
  });
});
