/**
 * TEMPORARY / THROWAWAY — teeth-proof for EI-10521. DELETE after running.
 *
 * Proves the BUG was real (not just that the fix is green): it re-installs the
 * PRE-FIX capture function (identical, minus the routability guard), attaches it to a
 * table with no harness_slug column — the real shape of `goals` — and asserts the
 * INSERT is rejected with 23502 not_null_violation, i.e. the AFTER trigger takes the
 * caller's write down with it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const { ensureGitExportOutbox, attachGitCaptureTrigger } = await import('./ensure-git-outbox');

let sql: postgres.Sql;

/** The capture fn EXACTLY as it was before EI-10521 — no `IF v_slug IS NULL` guard. */
const PRE_FIX_FN = `
  CREATE OR REPLACE FUNCTION harness_shared.capture_git_export_outbox()
  RETURNS TRIGGER AS $body$
  DECLARE
    v_op TEXT; v_rec RECORD; v_row JSONB; v_key TEXT; v_ws TEXT; v_slug TEXT;
    i INT;
  BEGIN
    IF (TG_OP = 'UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
    IF (TG_OP = 'DELETE') THEN v_op := 'del'; v_rec := OLD;
    ELSE v_op := 'put'; v_rec := NEW; END IF;
    v_row := to_jsonb(v_rec);
    IF COALESCE(v_row ->> 'origin', 'local') <> 'local' THEN RETURN v_rec; END IF;
    v_key := '';
    FOR i IN 0 .. TG_NARGS - 1 LOOP
      v_key := v_key || (CASE WHEN i > 0 THEN '__' ELSE '' END) || COALESCE(v_row ->> TG_ARGV[i], '');
    END LOOP;
    v_ws   := COALESCE(v_row ->> 'workspace_id', '');
    v_slug := v_row ->> 'harness_slug';
    INSERT INTO harness_shared.git_export_outbox
      (workspace_id, harness_slug, table_name, op, key, row, ts)
    VALUES (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
            (extract(epoch from now())*1000)::bigint);
    PERFORM pg_notify('git_export_outbox', v_ws || '::' || v_slug);
    RETURN v_rec;
  END;
  $body$ LANGUAGE plpgsql;
`;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `teeth_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  await ensureGitExportOutbox(sql);
  // `goals`' real shape: install-scoped, NO harness_slug column.
  await sql.unsafe(`
    CREATE TABLE harness_shared.goals_like (
      workspace_id text NOT NULL, install_slug text, id text NOT NULL, title text,
      PRIMARY KEY (workspace_id, id)
    )`);
  await attachGitCaptureTrigger(sql, 'goals_like', ['id']);
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('EI-10521 teeth-proof (throwaway)', () => {
  it('PRE-FIX fn: inserting a goal-shaped row is REJECTED 23502 — the write is aborted', async () => {
    await sql.unsafe(PRE_FIX_FN); // regress the function to its pre-EI-10521 body
    await expect(
      sql`INSERT INTO harness_shared.goals_like (workspace_id, install_slug, id, title) VALUES ('ws', 'inst-1', 'g1', 't')`,
    ).rejects.toMatchObject({ code: '23502' }); // null value in column "harness_slug"
    const rows = await sql`SELECT id FROM harness_shared.goals_like`;
    expect(rows).toHaveLength(0); // the caller's row never landed — this is the outage
  });

  it('POST-FIX fn: the same insert SUCCEEDS and simply exports nothing', async () => {
    await ensureGitExportOutbox(sql); // restore the shipped (guarded) function
    await expect(
      sql`INSERT INTO harness_shared.goals_like (workspace_id, install_slug, id, title) VALUES ('ws', 'inst-1', 'g2', 't')`,
    ).resolves.toBeDefined();
    const rows = await sql`SELECT id FROM harness_shared.goals_like`;
    expect(rows.map((r) => r.id)).toEqual(['g2']);
    const ob = await sql`SELECT count(*)::int AS n FROM harness_shared.git_export_outbox`;
    expect(ob[0]!.n).toBe(0);
  });
});
