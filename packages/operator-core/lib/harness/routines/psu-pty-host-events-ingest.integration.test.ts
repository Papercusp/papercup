/**
 * psu-pty-host-events-ingest — the INSERT proven against a real migrated Postgres
 * (psu-pty-turn-boundary-generalization-2026-09-22, P-007 / plan decision D-014).
 *
 * WHY THIS FILE EXISTS, AND WHY THE UNIT SUITE COULD NOT HAVE CAUGHT THE BUG IT GUARDS.
 * The sibling `psu-pty-host-events-ingest.test.ts` drives the ingester through `makeFakeSql`,
 * a hand-rolled stand-in that records the statements it is handed. That seam is genuinely
 * useful for GC/retention logic, but it can NEVER observe this class of defect, because the
 * failure happens inside the real postgres.js client while BINDING the parameters — before
 * any SQL is sent and long before a fake would be asked to return rows.
 *
 * The defect (measured 2026-09-22, D-014): `${rows.map(r => r.ts)}::timestamptz[]` throws
 *   TypeError ERR_INVALID_ARG_TYPE: The "string" argument must be of type string or an
 *   instance of Buffer or ArrayBuffer. Received an instance of Array
 * on EVERY row. It sat inside a bare `catch {}`, so a 100%-failing write reported
 * `rowsInserted: 0` — byte-identical to "there was nothing to ingest". The table stayed empty
 * for a full day while the unit suite stayed green and the routine reported success.
 *
 * The unit suite already guards the EI-607 jsonb footgun ("binds jsonb as a pre-stringified
 * ::jsonb[] parameter"), which does not actually fire here. The one that did fire had no
 * guard at all. A shape assertion over the statement text would only have encoded today's
 * spelling; only a real driver + real table can answer "does this actually persist".
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/psu-pty-host-events-ingest.integration.test.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { ingestPsuPtyHostEvents } from './psu-pty-host-events-ingest';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-psu-pty-ingest';
let dirs: string[] = [];

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
afterEach(async () => {
  await sql`DELETE FROM harness_shared.psu_pty_host_events WHERE workspace_id = ${WS}`;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

/** A host ledger directory holding one JSONL file per owner, as the hosts actually write it. */
async function seedDir(files: Record<string, unknown[]>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'psu-pty-ingest-'));
  dirs.push(dir);
  for (const [owner, rows] of Object.entries(files)) {
    await writeFile(
      join(dir, `${owner}.events.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
  }
  return dir;
}

const evt = (ts: string, kind: string, extra: Record<string, unknown> = {}) => ({
  ts,
  kind,
  ...extra,
});
// Keep fixtures inside the production retention window as the calendar moves.
const fixtureBaseMs = Date.now() - 60_000;
const fixtureTs = (seconds = 0) => new Date(fixtureBaseMs + seconds * 1_000).toISOString();

describe('ingestPsuPtyHostEvents against a real Postgres', () => {
  it('actually PERSISTS rows — the whole-run failure a fake sql cannot see', async () => {
    const dir = await seedDir({
      'su-aaaa': [
        evt(fixtureTs(), 'turn-delivered', { mode: 'wake', attempts: 1 }),
        evt(fixtureTs(12), 'wake-rearm-queued', { mode: 'wake' }),
      ],
      'su-bbbb': [evt(fixtureTs(30), 'respawn-carry-delivered', { attempts: 1 })],
    });

    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: WS, dir });

    // The assertion that would have failed before the fix: rows READ but none PERSISTED.
    expect(res.rowsRead).toBe(3);
    expect(res.rowsInserted).toBe(3);
    expect(res.ingestErrors).toBe(0);
    expect(res.firstIngestError).toBeUndefined();
    expect(res.filesIngested).toBe(2);

    const [{ n }] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.psu_pty_host_events
       WHERE workspace_id = ${WS}
    `;
    expect(n).toBe('3');
  });

  it('round-trips ts as a real timestamptz, not a string or a null', async () => {
    // Directly pins the column whose binding threw. A regression to ::timestamptz[] fails the
    // test above; this one additionally catches a "fix" that stores the wrong INSTANT (e.g. by
    // dropping the timezone and re-reading it as local), which a bare count cannot detect.
    const dir = await seedDir({
      'su-cccc': [evt(fixtureTs(), 'turn-delivered')],
    });

    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: WS, dir });
    expect(res.rowsInserted).toBe(1);

    const [row] = await sql<{ ts: Date; kind: string }[]>`
      SELECT ts, kind FROM harness_shared.psu_pty_host_events WHERE workspace_id = ${WS}
    `;
    expect(row.ts).toBeInstanceOf(Date);
    expect(row.ts.toISOString()).toBe(fixtureTs());
    expect(row.kind).toBe('turn-delivered');
  });

  it('stores payload as queryable jsonb, not a double-encoded string', async () => {
    // The EI-607 sibling footgun, proven on the real client rather than asserted on statement
    // text: a double-encoded payload reads back as a jsonb STRING and every ->> below is null.
    const dir = await seedDir({
      'su-dddd': [
        evt(fixtureTs(), 'turn-delivered', { mode: 'wake', attempts: 1 }),
      ],
    });

    await ingestPsuPtyHostEvents({ sql, workspaceId: WS, dir });

    const [row] = await sql<{ mode: string | null; typ: string }[]>`
      SELECT payload->>'mode' AS mode, jsonb_typeof(payload) AS typ
        FROM harness_shared.psu_pty_host_events WHERE workspace_id = ${WS}
    `;
    expect(row.typ).toBe('object');
    expect(row.mode).toBe('wake');
  });

  it('is idempotent across runs — ON CONFLICT (row_digest) DO NOTHING holds on real rows', async () => {
    const dir = await seedDir({
      'su-eeee': [
        evt(fixtureTs(), 'turn-delivered'),
        evt(fixtureTs(1), 'turn-delivered'),
      ],
    });

    const first = await ingestPsuPtyHostEvents({ sql, workspaceId: WS, dir });
    expect(first.rowsInserted).toBe(2);

    const second = await ingestPsuPtyHostEvents({ sql, workspaceId: WS, dir });
    expect(second.rowsRead).toBe(2);
    expect(second.rowsInserted).toBe(0); // deduped, not re-inserted
    expect(second.ingestErrors).toBe(0); // and NOT via a swallowed failure

    const [{ n }] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.psu_pty_host_events
       WHERE workspace_id = ${WS}
    `;
    expect(n).toBe('2');
  });

  it('SURFACES an insert failure instead of reporting it as an empty ingest', async () => {
    // The detector half of D-014. `rowsInserted: 0` must never again be the only trace of a
    // write that failed: a caller has to be able to tell "nothing to do" from "nothing worked".
    const dir = await seedDir({
      'su-ffff': [evt(fixtureTs(), 'turn-delivered')],
    });

    const exploding = new Proxy(sql, {
      apply: () => {
        throw new Error('simulated driver bind failure');
      },
    }) as unknown as Sql;

    const res = await ingestPsuPtyHostEvents({ sql: exploding, workspaceId: WS, dir });

    expect(res.rowsRead).toBe(1);
    expect(res.rowsInserted).toBe(0);
    expect(res.ingestErrors).toBeGreaterThan(0);
    expect(res.firstIngestError).toMatch(/simulated driver bind failure/);
    // And the file must survive, because its rows exist nowhere else.
    expect(res.filesIngested).toBe(0);
  });
});
