/**
 * engineer-issue-wire-clock.integration.test.ts — WI-10002875 (mig 1208).
 *
 * An issue-family work_items row federates as the engineer-issues WIRE ROW, a fixed
 * projection of its columns. `stamp_local_federated_write` used to decide "content
 * changed" over EVERY column, so a write to a local-only column (embedding set,
 * attempts, last_released_at, worked_by_history, ...) minted a fresh fed_ts/fed_hlc,
 * the capture fired on the clock move, and a wire row identical except for its
 * clock was shipped to every peer. Measured on the tower 2026-09-24: 54% of the
 * engineer_issues outbox repeats were clock-only.
 *
 * Mig 1208 makes `harness_shared.engineer_issue_wire_row()` the one projection used
 * by both triggers. These cases pin the contract against the REAL migration chain:
 *   - local-only writes keep the clock and emit nothing (the bug, fixed);
 *   - a change confined to a non-projected payload->'_ei' key emits nothing;
 *   - a wire column outside the UPDATE trigger's WHEN list (terminal_reason) still
 *     stamps and emits exactly one op (no under-federation);
 *   - an observation promoted back to work still federates (lane is generated from
 *     payload, which is on the wire);
 *   - a feature-family write to an APPLIED column still stamps (feature content is pinned
 *     separately by mig 1226 / feature-wire-clock.integration.test.ts, WI-10002882);
 *   - other stamp_local_federated_write tables are unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

const WS = 'ws-issue-wire-clock';
const HARNESS = 'wire-clock-cell';

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'wireclock',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-WIRECLOCK-${seq}`;
}

async function insertItem(id: string, kind: 'bug' | 'feature'): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
    VALUES (${WS}, ${HARNESS}, ${id}, 'wire clock', 'body', ${kind === 'bug' ? 'open' : 'todo'},
            ${kind}, 'local', ${sql.json({ _ei: { severity: 'minor' } })})`;
}

async function clockOf(id: string): Promise<{ fed_ts: string | null; fed_hlc: string | null }> {
  const [r] = await sql<{ fed_ts: string | null; fed_hlc: string | null }[]>`
    SELECT fed_ts::text AS fed_ts, fed_hlc FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return r;
}

async function outboxCount(key: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${WS} AND key = ${key}`;
  return r.n;
}

const issueKey = (id: string) => `${HARNESS}/${id}`;

describe('engineer-issue wire row drives the stamp clock (WI-10002875, mig 1208, real PG)', () => {
  it('a local-only column write keeps the clock and emits NO wire op', async () => {
    const id = nextId('WI');
    await insertItem(id, 'bug');
    const before = await clockOf(id);
    expect(await outboxCount(issueKey(id))).toBe(1); // the INSERT

    await sql`
      UPDATE harness_shared.work_items
         SET attempts = COALESCE(attempts, 0) + 1,
             last_released_at = now(),
             last_released_by = 'reaper:dead',
             last_progress_at = now(),
             requeue_count = COALESCE(requeue_count, 0) + 1
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    expect(await clockOf(id)).toEqual(before);
    expect(await outboxCount(issueKey(id))).toBe(1);
  });

  it('an embedding write (the backfill path) keeps the clock and emits NO wire op', async () => {
    const id = nextId('WI');
    await insertItem(id, 'bug');
    const before = await clockOf(id);
    const [{ dims }] = await sql<{ dims: number | null }[]>`
      SELECT NULLIF(atttypmod, -1) AS dims FROM pg_attribute
       WHERE attrelid = 'harness_shared.work_items'::regclass AND attname = 'embedding'`;
    const vec = `[${Array.from({ length: dims ?? 3 }, () => '0.1').join(',')}]`;

    await sql`
      UPDATE harness_shared.work_items
         SET embedding = ${vec}::vector, embedding_mode = 'gemma', embedding_recipe = 2
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    expect(await clockOf(id)).toEqual(before);
    expect(await outboxCount(issueKey(id))).toBe(1);
  });

  it("a change confined to a non-projected payload->'_ei' key emits NO wire op", async () => {
    const id = nextId('WI');
    await insertItem(id, 'bug');
    const before = await clockOf(id);

    await sql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(payload, '{_ei,local_only_marker}', '1')
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    expect(await clockOf(id)).toEqual(before);
    expect(await outboxCount(issueKey(id))).toBe(1);
  });

  it('a wire column outside the UPDATE trigger WHEN list still stamps and emits exactly one op', async () => {
    const id = nextId('WI');
    await insertItem(id, 'bug');
    const before = await clockOf(id);

    await sql`
      UPDATE harness_shared.work_items SET terminal_reason = 'wire-clock-reason'
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    const after = await clockOf(id);
    expect(after.fed_hlc).not.toBe(before.fed_hlc);
    expect(await outboxCount(issueKey(id))).toBe(2);
    const [last] = await sql<{ row: Record<string, unknown>; op_hlc: string }[]>`
      SELECT row, op_hlc FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${WS} AND key = ${issueKey(id)} ORDER BY id DESC LIMIT 1`;
    expect(last.row.terminal_reason).toBe('wire-clock-reason');
    expect(last.op_hlc).toBe(after.fed_hlc);
  });

  it('an observation promoted back to work still stamps and federates', async () => {
    const id = nextId('WI');
    await insertItem(id, 'bug');
    await sql`
      UPDATE harness_shared.work_items SET payload = payload || '{"lane":"observation"}'::jsonb
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    const whileObservation = await outboxCount(issueKey(id));
    expect(whileObservation).toBe(1); // the observation lane is off the hive log

    await sql`
      UPDATE harness_shared.work_items SET payload = payload - 'lane'
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    expect(await outboxCount(issueKey(id))).toBe(2);
  });

  it('the shipped wire row IS engineer_issue_wire_row() of the stored row', async () => {
    const id = nextId('WI');
    await insertItem(id, 'bug');
    const [r] = await sql<{ same: boolean }[]>`
      SELECT o.row = harness_shared.engineer_issue_wire_row(w, o.workspace_id, 'harness:' || w.harness_slug, o.harness_slug) AS same
        FROM harness_shared.substrate_outbox o
        JOIN harness_shared.work_items w ON w.workspace_id = o.workspace_id AND w.feature_id = ${id}
       WHERE o.workspace_id = ${WS} AND o.key = ${issueKey(id)}`;
    expect(r.same).toBe(true);
  });

  it('a feature-family write to an APPLIED column (attempts) still stamps and emits', async () => {
    const id = nextId('F');
    await insertItem(id, 'feature');
    const before = await clockOf(id);
    await sql`
      UPDATE harness_shared.work_items SET attempts = COALESCE(attempts, 0) + 1
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    expect((await clockOf(id)).fed_hlc).not.toBe(before.fed_hlc);
    expect(await outboxCount(id)).toBe(2);
  });

  it('another table on the shared stamp function still stamps on a content change', async () => {
    const slug = `wire-clock-plan-${Date.now()}`;
    await sql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, content)
      VALUES (${WS}, ${HARNESS}, ${slug}, 'body')`;
    const [before] = await sql<{ fed_hlc: string | null }[]>`
      SELECT fed_hlc FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND plan_slug = ${slug}`;
    await sql`
      UPDATE harness_shared.harness_plans SET content = 'body 2'
       WHERE workspace_id = ${WS} AND plan_slug = ${slug}`;
    const [after] = await sql<{ fed_hlc: string | null }[]>`
      SELECT fed_hlc FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND plan_slug = ${slug}`;
    expect(after.fed_hlc).not.toBeNull();
    expect(after.fed_hlc).not.toBe(before.fed_hlc);
  });
});

/**
 * EI-24552921468661465 (mig 1241) — the wire row used to be ONE recursive
 * jsonb_strip_nulls over the whole object, so it deleted null-valued keys INSIDE the
 * caller-owned payload (processLifecycleVerdict.recheckAt:null on every gone/kill
 * verdict). The projection applies `payload = EXCLUDED.payload`, so a federation replay
 * overwrote the stored row with the stripped copy. These assert KEY EXISTENCE, not
 * value: `row.recheckAt === null` also passes when the key is absent under a lenient
 * reader, which is exactly how the defect hid.
 */
describe('engineer-issue wire row carries payload/tags verbatim (EI-24552921468661465, mig 1241, real PG)', () => {
  async function latestWireRow(id: string): Promise<Record<string, unknown>> {
    const [r] = await sql<{ row: Record<string, unknown> }[]>`
      SELECT row FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${WS} AND key = ${issueKey(id)}
       ORDER BY id DESC LIMIT 1`;
    return r.row;
  }

  it('an explicit null nested in payload survives onto the shipped wire row', async () => {
    const id = nextId('WI');
    await insertItem(id, 'bug');
    const payload = {
      _ei: { severity: 'minor' },
      out: {
        processLifecycleVerdict: {
          taskId: 't-1',
          decision: 'gone',
          reason: 'process exited',
          keepCount: 0,
          recheckAt: null,
          decidedAt: '2026-09-29T00:00:00.000Z',
        },
      },
    };
    await sql`
      UPDATE harness_shared.work_items SET payload = ${JSON.stringify(payload)}::text::jsonb
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    const [probe] = await sql<{ has_key: boolean; kind: string | null; ei_shipped: boolean }[]>`
      SELECT (o.row #> '{payload,out,processLifecycleVerdict}') ? 'recheckAt' AS has_key,
             jsonb_typeof(o.row #> '{payload,out,processLifecycleVerdict,recheckAt}') AS kind,
             (o.row -> 'payload') ? '_ei' AS ei_shipped
        FROM harness_shared.substrate_outbox o
       WHERE o.workspace_id = ${WS} AND o.key = ${issueKey(id)}
       ORDER BY o.id DESC LIMIT 1`;
    expect(probe.has_key).toBe(true);
    expect(probe.kind).toBe('null');
    // _ei is still projected into top-level columns, never shipped inside payload.
    expect(probe.ei_shipped).toBe(false);
  });

  it('an explicit null nested in tags survives onto the shipped wire row', async () => {
    const id = nextId('WI');
    await insertItem(id, 'bug');
    await sql`
      UPDATE harness_shared.work_items SET tags = ${JSON.stringify({ area: { owner: null } })}::text::jsonb
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    const row = await latestWireRow(id);
    expect(Object.prototype.hasOwnProperty.call((row.tags as { area: object }).area, 'owner')).toBe(true);
  });

  it('absent TOP-LEVEL columns are still stripped off the wire (the intended half of the old strip)', async () => {
    const id = nextId('WI');
    await insertItem(id, 'bug');
    const row = await latestWireRow(id);
    // taken_by / terminal_owner / parent_id are NULL on a fresh open row.
    expect(Object.prototype.hasOwnProperty.call(row, 'assignee')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'terminal_owner')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'parent_id')).toBe(false);
    // tags is NULL on insert → omitted, never shipped as a JSON null.
    expect(Object.prototype.hasOwnProperty.call(row, 'tags')).toBe(false);
    expect(row.payload).toEqual({});
  });

  it("mig 1241's repair restores recheckAt:null on a gone verdict that lost it, and leaves keep verdicts alone", async () => {
    const gone = nextId('WI');
    const keep = nextId('WI');
    await insertItem(gone, 'bug');
    await insertItem(keep, 'bug');
    const stripped = { _ei: { severity: 'minor' }, out: { processLifecycleVerdict: { taskId: 't', decision: 'gone' } } };
    const keeper = { _ei: { severity: 'minor' }, out: { processLifecycleVerdict: { taskId: 't', decision: 'keep' } } };
    await sql`UPDATE harness_shared.work_items SET payload = ${JSON.stringify(stripped)}::text::jsonb
               WHERE workspace_id = ${WS} AND feature_id = ${gone}`;
    await sql`UPDATE harness_shared.work_items SET payload = ${JSON.stringify(keeper)}::text::jsonb
               WHERE workspace_id = ${WS} AND feature_id = ${keep}`;

    const file = readdirSync(SQL_DIR).find((f) => /^\d+-engineer-issue-wire-row-preserve-payload-nulls\.sql$/.test(f));
    expect(file, 'mig 1241 must be armed (a .sql, not a .DRAFT)').toBeTruthy();
    const text = readFileSync(resolve(SQL_DIR, file!), 'utf8');
    const repair = text.slice(text.indexOf('UPDATE harness_shared.work_items'));
    expect(repair.startsWith('UPDATE')).toBe(true);
    await sql.unsafe(repair);

    const rows = await sql<{ feature_id: string; has_key: boolean; kind: string | null }[]>`
      SELECT feature_id,
             (payload #> '{out,processLifecycleVerdict}') ? 'recheckAt' AS has_key,
             jsonb_typeof(payload #> '{out,processLifecycleVerdict,recheckAt}') AS kind
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id IN (${gone}, ${keep})`;
    const byId = Object.fromEntries(rows.map((r) => [r.feature_id, r]));
    expect(byId[gone]).toMatchObject({ has_key: true, kind: 'null' });
    expect(byId[keep].has_key).toBe(false);
    // …and the repaired value federates with the null intact.
    expect((await latestWireRow(gone)).payload).toMatchObject({
      out: { processLifecycleVerdict: { recheckAt: null } },
    });
  });
});
