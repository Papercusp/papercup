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
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { ingestPsuPtyHostEvents } from './psu-pty-host-events-ingest';
import { PROVIDER_RECOVERY_SOURCE } from './session-interruption-recovery';

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
  await sql`DELETE FROM harness_shared.event_wake_deliveries WHERE source = ${PROVIDER_RECOVERY_SOURCE}`;
  await sql`DELETE FROM harness_shared.event_awaits WHERE event_key LIKE ${PROVIDER_RECOVERY_SOURCE + ':%'}`;
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
  it('keeps an expired shared WAL until the workspace that owns its native proof ingests it', async () => {
    const ownerId = 'su-foreign-wal';
    const dir = await seedDir({ [ownerId]: [evt(fixtureTs(), 'native-turn-start-confirmed',
      { workspaceId: WS, deliveryId: '77' })] });
    const path = join(dir, `${ownerId}.events.jsonl`);
    const old = new Date(Date.now() - 20 * 86_400_000);
    await utimes(path, old, old);
    expect(await ingestPsuPtyHostEvents({ sql, workspaceId: 'other-ws', dir }))
      .toMatchObject({ rowsInserted: 0, filesRetainedUningested: 1, filesDeleted: 0 });
    expect((await stat(path)).isFile()).toBe(true);
    expect(await ingestPsuPtyHostEvents({ sql, workspaceId: WS, dir }))
      .toMatchObject({ rowsInserted: 1, filesRetainedUningested: 0, filesDeleted: 1 });
  });
  it.each([2, 3, 4, 9])('reaches every one of %i files under a three-file budget across repeated runs', async count => {
    const names = Array.from({ length: count }, (_, n) => `su-rotation-${n}`);
    const dir = await seedDir(Object.fromEntries(names.map((name, n) =>
      [name, [evt(fixtureTs(n), 'turn-delivered')]])));
    const first = await ingestPsuPtyHostEvents({ sql, workspaceId: WS, dir, maxFilesPerRun: 3 });
    expect(first.filesUnprocessed).toBe(Math.max(0, count - 3));
    if (count > 3) expect(first.fileRotationCursor).toEqual(expect.any(String));
    // The files remain in place. A new call must keep traversing them despite
    // seeing the same newest files and having no prior in-memory state.
    for (let n = 1; n < count; n++) {
      await ingestPsuPtyHostEvents({ sql, workspaceId: WS, dir, maxFilesPerRun: 3 });
    }
    const rows = await sql<{ owner_id: string }[]>`
      SELECT owner_id FROM harness_shared.psu_pty_host_events WHERE workspace_id = ${WS} ORDER BY owner_id
    `;
    expect(rows.map(row => row.owner_id)).toEqual(names);
  });
  it.each([499, 500, 501, 1001])('replays a %i-row WAL and schedules each distinct failure once', async count => {
    const ownerId = 'su-provider-replay';
    const nativeSessionId = '12345678-1234-4234-8234-123456789abc';
    const failedAtMs = fixtureBaseMs;
    const recovery = (offset: number) => evt(fixtureTs(10), 'session-execution-observed', {
      workspaceId: WS, ownerId, advSessionId: '77', nativeSessionId, providerRecoveryVersion: 1,
      hostStartedAt: failedAtMs - 2000, hostPid: 321,
      execution: { ownerId, nativeSessionId, childGeneration: 3, hostPid: 321, phase: 'failed',
        observedAt: failedAtMs + 500, receivedAtMs: failedAtMs - 1000, pendingTools: 0,
        pendingGateTools: 0, ownerStopRequested: false, ownerInputPending: false,
        failure: { atMs: failedAtMs + offset, retryable: true, retryAfterMs: 120_000 } },
    });
    const samples = Array.from({ length: count - 2 }, (_, n) => evt(fixtureTs(), 'fixture', { sequence: n }));
    const dir = await seedDir({ [ownerId]: [recovery(0), ...samples, recovery(10)] });
    const input = { sql, workspaceId: WS, dir };
    const first = await ingestPsuPtyHostEvents(input);
    expect(first).toMatchObject({ rowsInserted: count, ingestErrors: 0 });
    const read = () => sql<{ id: string; nextAttemptAtMs: string }[]>`
      SELECT id::text, (extract(epoch FROM next_attempt_at) * 1000)::bigint::text AS "nextAttemptAtMs"
      FROM harness_shared.event_wake_deliveries
      WHERE subscriber_id = ${ownerId} AND source = ${PROVIDER_RECOVERY_SOURCE}
      ORDER BY next_attempt_at`;
    const queued = await read();
    expect(queued.map(row => Number(row.nextAttemptAtMs))).toEqual([failedAtMs + 120_000, failedAtMs + 120_010]);
    const replay = await seedDir({ [ownerId]: [recovery(10), ...[...samples].reverse(), recovery(0)] });
    expect(await ingestPsuPtyHostEvents({ ...input, dir: replay })).toMatchObject({ rowsInserted: 0, ingestErrors: 0 });
    expect(await read()).toEqual(queued);
  });
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
      apply: (target, thisArg, args) => {
        if (Array.isArray(args[0]) && args[0].join(' ').includes('INSERT INTO harness_shared.psu_pty_host_events')) {
          throw new Error('simulated driver bind failure');
        }
        return Reflect.apply(target, thisArg, args);
      },
    }) as unknown as Sql;

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await ingestPsuPtyHostEvents({ sql: exploding, workspaceId: WS, dir });

      expect(res.rowsRead).toBe(1);
      expect(res.rowsInserted).toBe(0);
      expect(res.ingestErrors).toBeGreaterThan(0);
      expect(res.firstIngestError).toMatch(/simulated driver bind failure/);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('simulated driver bind failure'));
      // And the file must survive, because its rows exist nowhere else.
      expect(res.filesIngested).toBe(0);
    } finally {
      logged.mockRestore();
    }
  });

  it('skips a locked expired tuple, cleans the other rows, then removes the deferred row on a later run', async () => {
    await sql`
      INSERT INTO harness_shared.psu_pty_host_events
        (workspace_id, owner_id, ts, kind, payload, row_digest)
      VALUES
        (${WS}, 'su-retention-test', now() - interval '93 days', 'retention-fixture', '{}'::jsonb, 'retention-locked'),
        (${WS}, 'su-retention-test', now() - interval '92 days', 'retention-fixture', '{}'::jsonb, 'retention-free-1'),
        (${WS}, 'su-retention-test', now() - interval '91 days', 'retention-fixture', '{}'::jsonb, 'retention-free-2')
    `;
    const dir = await seedDir({});

    let signalLocked!: () => void;
    let releaseLocked!: () => void;
    const lockedReady = new Promise<void>((resolve) => { signalLocked = resolve; });
    const releaseSignal = new Promise<void>((resolve) => { releaseLocked = resolve; });
    const holder = sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id FROM harness_shared.psu_pty_host_events
         WHERE workspace_id = ${WS} AND row_digest = 'retention-locked'
         FOR UPDATE
      `;
      expect(rows).toHaveLength(1);
      signalLocked();
      await releaseSignal;
    });

    await lockedReady;
    try {
      const first = await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '250ms'`;
        return ingestPsuPtyHostEvents({
          sql: tx as unknown as Sql,
          workspaceId: WS,
          dir,
          rowRetentionDays: 90,
        });
      });

      expect(first.rowsExpired).toBe(2);
      const remaining = await sql<{ row_digest: string }[]>`
        SELECT row_digest FROM harness_shared.psu_pty_host_events
         WHERE workspace_id = ${WS}
         ORDER BY row_digest
      `;
      expect(remaining.map((row) => row.row_digest)).toEqual(['retention-locked']);
    } finally {
      releaseLocked();
      await holder;
    }

    const second = await ingestPsuPtyHostEvents({
      sql,
      workspaceId: WS,
      dir,
      rowRetentionDays: 90,
    });
    expect(second.rowsExpired).toBe(1);
    const remainingAfterRetry = await sql<{ row_digest: string }[]>`
      SELECT row_digest FROM harness_shared.psu_pty_host_events
       WHERE workspace_id = ${WS}
    `;
    expect(remainingAfterRetry).toHaveLength(0);
  }, 20_000);
});
