/**
 * WI-6210 — class guard for `stamp_local_federated_write`'s content-diff mask.
 *
 * THE CLASS THIS GUARDS
 * PostgreSQL computes a STORED generated column AFTER every BEFORE ROW trigger runs.
 * So inside `stamp_local_federated_write_trg` (BEFORE INSERT OR UPDATE),
 * `to_jsonb(NEW)->>'<generated col>'` is NULL while `to_jsonb(OLD)->>'<same col>'`
 * already holds the stored value. Any generated column left inside the trigger's
 * content-diff therefore reports a phantom "content changed" on EVERY update —
 * including a byte-identical RE-APPLY of the same remote op — and the trigger
 * re-stamps `origin := 'local'` with a fresh, NEWER clock. The remote row is then
 * permanently shadowed: every redelivery of the publisher's genuine op loses the LWW
 * compare, with no repair path.
 *
 * It has now happened three times, each fixed by naming one more column:
 *   `_search` (mig 214/517) -> `plan_item_assignments.fed_key` (mig 653)
 *   -> `p2p_work_offers.offer_fed_key` (mig 681, found on the federation rig).
 * Mig 653 asserted by grep that its column was the last one; the grep matched the
 * literal `fed_key` and missed `offer_fed_key`.
 *
 * WHY THIS TEST IS SHAPED THIS WAY — two deliberate choices, both aimed at the reason
 * the class stayed invisible through two previous "fixed + tested" rounds:
 *
 *  1. It loads the REAL function body from the migration on disk (the highest-numbered
 *     migration that replaces it), instead of pasting a copy into the fixture. The
 *     existing plan-item-assignments fixture inlines a hand-copy, so it keeps passing
 *     no matter what the shipped function later becomes — it tests the copy.
 *  2. The generated column is given a NOVEL name the mask has never heard of. A test
 *     using `fed_key` or `offer_fed_key` only re-proves the last fix; a novel name is
 *     what distinguishes "masked generically from the catalog" (correct) from "masked
 *     by a hand-maintained list" (the bug, re-armed for the next table).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../../../libs/papercusp/libs/db/sql');

const FN_SIGNATURE = 'CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write()';

/**
 * The CURRENTLY-SHIPPING function body: the highest-numbered migration that replaces
 * it wins, exactly as it does when migrations are applied in order. Resolved at run
 * time so a future migration is picked up automatically — a hand-pinned filename here
 * would rot into testing a superseded definition, which is how this class survived.
 */
function readLatestStampFunctionSql(): { file: string; sql: string } {
  // TEETH SEAM: pin the loader to an OLDER migration to re-prove this test can fail.
  //   STAMP_FN_MIGRATION=653-fed-key-generated-col-stamp-mask.sql npm run test:file -- <this file>
  // must RED on the double-apply case (653 masks `fed_key` by name, so the probe's
  // novel generated column slips through and the row is re-stamped origin='local').
  // A guard nobody has watched fail is not a guard.
  const pinned = process.env.STAMP_FN_MIGRATION;
  const candidates = (pinned ? [pinned] : readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')))
    .filter((f) => readFileSync(resolve(SQL_DIR, f), 'utf8').includes(FN_SIGNATURE))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const file = candidates.at(-1);
  if (!file) throw new Error(`no migration in ${SQL_DIR} defines ${FN_SIGNATURE}`);
  const body = readFileSync(resolve(SQL_DIR, file), 'utf8');
  // Take only the function definition (from the signature to its dollar-quoted end),
  // so surrounding DDL in that migration — table rewrites, backfills, other tables'
  // triggers — is not dragged into this minimal fixture.
  const start = body.indexOf(FN_SIGNATURE);
  // The dollar-quote tag is arbitrary: `$fn$` through mig 824, `$function$` (the
  // pg_get_functiondef default) from mig 1208. Read it from the definition rather than
  // assume one, or a correct new migration fails this guard at collection time.
  const tag = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(body.slice(start))?.[1];
  if (!tag) throw new Error(`could not find the dollar-quote opener in ${file}`);
  const open = body.indexOf(tag, start);
  const end = body.indexOf(`${tag};`, open + tag.length);
  if (end === -1) throw new Error(`could not find the ${tag} terminator in ${file}`);
  return { file, sql: body.slice(start, end + `${tag};`.length) };
}

/**
 * A minimal stand-in for a federated CDC table: the columns the trigger reasons about,
 * one ordinary content column, and a STORED generated column whose name appears in no
 * mask anywhere in the codebase (see choice 2 in the header).
 */
const NOVEL_GENERATED_COL = 'widget_lookup_key';

let db: FreshPgDb;
let migrationFile: string;

beforeAll(async () => {
  db = await createFreshPgDb('stamp-gen');
  const { file, sql } = readLatestStampFunctionSql();
  migrationFile = file;

  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text
      LANGUAGE sql AS $hlc_stub$
        SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || ':stub';
      $hlc_stub$;

    -- (WI-6249 / mig-699) The real function calls hlc_recv() on both remote paths
    -- (a fed_ts-moving UPDATE, and a remote INSERT carrying fed_hlc) — this minimal
    -- fixture stubs it as a no-op, same as hlc_now above, so loading the CURRENT
    -- migration body doesn't error on a function real production always has defined
    -- (mig 314/459/460, long before this one) but this stand-alone schema does not.
    CREATE OR REPLACE FUNCTION harness_shared.hlc_recv(remote text) RETURNS void
      LANGUAGE sql AS $hlc_recv_stub$
        SELECT NULL::void;
      $hlc_recv_stub$;

    CREATE TABLE harness_shared.fed_generated_col_probe (
      workspace_id  text NOT NULL,
      row_id        text NOT NULL,
      payload       text,
      ${NOVEL_GENERATED_COL} text GENERATED ALWAYS AS (workspace_id || '/' || row_id) STORED,
      origin        text,
      author_pubkey text,
      signer_device_pubkey text,
      fed_ts        bigint,
      fed_hlc       text,
      updated_at    bigint,
      PRIMARY KEY (workspace_id, row_id)
    );
  `);

  await db.sql.unsafe(sql);

  await db.sql.unsafe(`
    DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.fed_generated_col_probe;
    CREATE TRIGGER stamp_local_federated_write_trg
      BEFORE INSERT OR UPDATE ON harness_shared.fed_generated_col_probe
      FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();
  `);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.fed_generated_col_probe`;
});

/** The projection's apply: an upsert carrying the wire op's provenance verbatim. */
async function applyRemoteOp(payload: string, fedTs: number, fedHlc: string, signerDevicePubkey: string | null = null) {
  await db.sql`
    INSERT INTO harness_shared.fed_generated_col_probe
      (workspace_id, row_id, payload, origin, author_pubkey, signer_device_pubkey,
       fed_ts, fed_hlc, updated_at)
    VALUES ('default', 'r1', ${payload}, 'remote', 'peer-b-pubkey', ${signerDevicePubkey},
            ${fedTs}, ${fedHlc}, ${Date.now()})
    ON CONFLICT (workspace_id, row_id) DO UPDATE SET
      payload              = EXCLUDED.payload,
      origin               = EXCLUDED.origin,
      author_pubkey        = EXCLUDED.author_pubkey,
      signer_device_pubkey = EXCLUDED.signer_device_pubkey,
      fed_ts               = EXCLUDED.fed_ts,
      fed_hlc              = EXCLUDED.fed_hlc,
      updated_at           = EXCLUDED.updated_at
  `;
}

async function readRow() {
  const [row] = await db.sql`
    SELECT origin, fed_ts, fed_hlc, payload FROM harness_shared.fed_generated_col_probe
     WHERE workspace_id = 'default' AND row_id = 'r1'
  `;
  return row as { origin: string; fed_ts: number; fed_hlc: string; payload: string };
}

describe(`stamp_local_federated_write generated-column mask (live body)`, () => {
  it('loads the function from the highest-numbered migration that defines it', () => {
    expect(migrationFile).toMatch(/^\d+-.*\.sql(?:\.DRAFT)?$/);
  });

  it('WI-6210: a same-op double-apply does NOT flip origin/fed_ts, whatever the generated column is called', async () => {
    const fedTs = 1_785_114_852_911;
    const fedHlc = '001785114852911:00000:d05418f20cc22d33';

    await applyRemoteOp('signed-record-bytes', fedTs, fedHlc);
    const first = await readRow();
    expect(first.origin).toBe('remote');
    expect(first.fed_ts).toBe(fedTs);

    // The identical op re-folded (a retry / a second drain pass / a backfill re-scan).
    // fed_ts is unchanged, so the trigger's "a write that moves fed_ts" early-return does
    // NOT apply and the row reaches the content-diff — the exact path that mislabelled
    // frame a's seat offer on the federation rig.
    await applyRemoteOp('signed-record-bytes', fedTs, fedHlc);

    const second = await readRow();
    expect(second.origin).toBe('remote');
    expect(second.fed_ts).toBe(fedTs);
    expect(second.fed_hlc).toBe(fedHlc);
  });

  it('still stamps origin=local when a REAL content column changes (the mask is not over-broad)', async () => {
    const fedTs = 1_785_114_852_911;
    await applyRemoteOp('signed-record-bytes', fedTs, '001785114852911:00000:d05418f20cc22d33');

    // A genuine local edit: same fed_ts, different content.
    await db.sql`
      UPDATE harness_shared.fed_generated_col_probe
         SET payload = 'locally-edited'
       WHERE workspace_id = 'default' AND row_id = 'r1'
    `;

    const row = await readRow();
    expect(row.payload).toBe('locally-edited');
    expect(row.origin).toBe('local');
    expect(row.fed_ts).toBeGreaterThan(fedTs);
  });

  it("WI-6250: a local write cannot replace a remote publisher-signed record's content", async () => {
    const fedTs = 1_785_114_852_911;
    const fedHlc = '001785114852911:00000:d05418f20cc22d33';
    await applyRemoteOp('publisher-signed-v1', fedTs, fedHlc, 'peer-b-device-pubkey');

    await expect(
      db.sql`
        UPDATE harness_shared.fed_generated_col_probe
           SET payload = 'unsigned-local-replacement'
         WHERE workspace_id = 'default' AND row_id = 'r1'
      `,
    ).rejects.toThrow(/publisher-signed.*remote/i);

    const row = await readRow();
    expect(row.payload).toBe('publisher-signed-v1');
    expect(row.origin).toBe('remote');
    expect(row.fed_ts).toBe(fedTs);
    expect(row.fed_hlc).toBe(fedHlc);
  });

  it('WI-6250: a same-millisecond remote update with a newer HLC still applies', async () => {
    const fedTs = 1_785_114_852_911;
    const firstHlc = '001785114852911:00000:d05418f20cc22d33';
    const secondHlc = '001785114852911:00001:d05418f20cc22d33';
    await applyRemoteOp('publisher-signed-v1', fedTs, firstHlc, 'peer-b-device-pubkey');

    await applyRemoteOp('publisher-signed-v2', fedTs, secondHlc, 'peer-b-device-pubkey');

    const row = await readRow();
    expect(row.payload).toBe('publisher-signed-v2');
    expect(row.origin).toBe('remote');
    expect(row.fed_ts).toBe(fedTs);
    expect(row.fed_hlc).toBe(secondHlc);
  });

  it('a bookkeeping-only touch (updated_at) keeps the prior clock and origin', async () => {
    const fedTs = 1_785_114_852_911;
    await applyRemoteOp('signed-record-bytes', fedTs, '001785114852911:00000:d05418f20cc22d33');

    await db.sql`
      UPDATE harness_shared.fed_generated_col_probe
         SET updated_at = ${Date.now() + 1000}
       WHERE workspace_id = 'default' AND row_id = 'r1'
    `;

    const row = await readRow();
    expect(row.origin).toBe('remote');
    expect(row.fed_ts).toBe(fedTs);
  });
});
