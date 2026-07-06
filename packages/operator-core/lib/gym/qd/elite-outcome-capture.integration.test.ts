/**
 * elite-outcome-capture.integration.test.ts — real-PG proof that the device-signed
 * EliteOutcomeRecord actually reaches the peer-log (federated-scout-gym-learning
 * F1-6/P-014 SEND signing).
 *
 * THE BUG under guard: markEliteFederatable's signing path writes `outcome_record`
 * in a SECOND UPDATE that touches ONLY that column. mig 464's
 * capture_gym_qd_outbox_upd_trg had a COLUMN-SCOPED WHEN clause (fitness /
 * candidate_id / federatable only) — so that update did NOT fire the capture, and
 * because capture_substrate_outbox snapshots `to_jsonb(NEW)` AT FIRE TIME, the signed
 * record was never placed in substrate_outbox. mig 481 adds `outcome_record` to the
 * WHEN clause so the record-writing UPDATE fires and snapshots the row WITH the record.
 *
 * This test hand-provisions the minimal schema (the `_pg-helpers` subset-provisioning
 * precedent) with EACH trigger variant and asserts the observable difference: the
 * OLD trigger misses the record; the FIXED (481) trigger captures it. Keep the DDL in
 * sync with migrations 193 / 464 / 478 / 481 + the capture fn in 000-baseline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { markEliteFederatable, type EliteOutcomeSigner } from './federate-elite';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';

const WS = 'papercusp-workspace'; // must pass resolveFederationWorkspace (a real hive ws)
const SLUG = 'elite-capture-test';

/** The capture fn (verbatim from 000-baseline) + gym_qd_archive/substrate_outbox subsets. */
const CAPTURE_FN_DDL = `
  CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE v_op TEXT; v_rec RECORD; v_origin TEXT; v_key TEXT; v_row JSONB;
            v_ws TEXT; v_slug TEXT; v_keycol TEXT := TG_ARGV[0];
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_op := 'del'; v_rec := OLD;
      ELSE v_op := 'put'; v_rec := NEW; END IF;
      v_row := to_jsonb(v_rec);
      v_origin := v_row ->> 'origin';
      IF COALESCE(v_origin, 'local') <> 'local' THEN RETURN v_rec; END IF;
      v_key := v_row ->> v_keycol;
      v_ws := COALESCE(v_row ->> 'workspace_id', '');
      v_slug := v_row ->> 'harness_slug';
      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts)
      VALUES (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
              (extract(epoch from now()) * 1000)::bigint);
      RETURN v_rec;
    END; $$;
`;

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.substrate_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY,
    workspace_id text NOT NULL, harness_slug text NOT NULL, table_name text NOT NULL,
    op text NOT NULL, key text NOT NULL, "row" jsonb, ts bigint NOT NULL, drained_at bigint, drained_log_key text
  );
  CREATE TABLE IF NOT EXISTS harness_shared.gym_qd_archive (
    workspace_id text NOT NULL, harness_slug text NOT NULL, niche_key text NOT NULL,
    candidate_id text NOT NULL, scope text NOT NULL, domain text NOT NULL, risk text NOT NULL,
    fitness double precision NOT NULL, descriptor jsonb NOT NULL,
    source text NOT NULL DEFAULT 'gym', rationale text,
    created_at bigint NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::bigint,
    updated_at bigint NOT NULL,
    author_pubkey text, origin text NOT NULL DEFAULT 'local', fed_ts bigint,
    source_hive text, novelty_gift boolean NOT NULL DEFAULT false,
    federatable boolean NOT NULL DEFAULT false,
    outcome_record jsonb,
    PRIMARY KEY (workspace_id, harness_slug, niche_key)
  );
`;

/** mig 464's ORIGINAL update trigger (column-scoped — misses outcome_record). */
const OLD_TRIGGER_DDL = `
  CREATE OR REPLACE TRIGGER capture_gym_qd_outbox_upd_trg
    AFTER UPDATE ON harness_shared.gym_qd_archive FOR EACH ROW
    WHEN ((NEW.federatable = true OR OLD.federatable = true)
      AND (OLD.fitness IS DISTINCT FROM NEW.fitness
        OR OLD.candidate_id IS DISTINCT FROM NEW.candidate_id
        OR OLD.federatable IS DISTINCT FROM NEW.federatable))
    EXECUTE FUNCTION harness_shared.capture_substrate_outbox('niche_key');
`;

/** mig 481's FIXED update trigger (also fires on an outcome_record change). */
const FIXED_TRIGGER_DDL = `
  CREATE OR REPLACE TRIGGER capture_gym_qd_outbox_upd_trg
    AFTER UPDATE ON harness_shared.gym_qd_archive FOR EACH ROW
    WHEN ((NEW.federatable = true OR OLD.federatable = true)
      AND (OLD.fitness IS DISTINCT FROM NEW.fitness
        OR OLD.candidate_id IS DISTINCT FROM NEW.candidate_id
        OR OLD.federatable IS DISTINCT FROM NEW.federatable
        OR OLD.outcome_record IS DISTINCT FROM NEW.outcome_record))
    EXECUTE FUNCTION harness_shared.capture_substrate_outbox('niche_key');
`;

function testSigner(): EliteOutcomeSigner {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { devicePubkeyBase64: pubkeyBase64, sign: async (b) => signWithPrivateKeyDer(privateKeyDer, b) };
}

async function seedLocalElite(sql: postgres.Sql, nicheKey: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.gym_qd_archive
      (workspace_id, harness_slug, niche_key, candidate_id, scope, domain, risk,
       fitness, descriptor, updated_at, federatable)
    VALUES
      (${WS}, ${SLUG}, ${nicheKey}, 'cand-1', 'local', 'execution', 'low',
       7.5, ${JSON.stringify({ v: 1 })}::text::jsonb, 1000, false)`;
}

async function capturedRecords(sql: postgres.Sql, nicheKey: string): Promise<Array<unknown>> {
  const rows = (await sql`
    SELECT row->'outcome_record' AS rec FROM harness_shared.substrate_outbox
     WHERE table_name = 'gym_qd_archive' AND op = 'put' AND key = ${nicheKey}
     ORDER BY id`) as unknown as Array<{ rec: unknown }>;
  return rows.map((r) => r.rec);
}

describe('gym_qd_archive outcome_record capture (F1-6/P-014, mig 481)', () => {
  let db: FreshPgDb;
  beforeAll(async () => {
    db = await createFreshPgDb('elite-capture');
    await db.sql.unsafe(SCHEMA_DDL);
    await db.sql.unsafe(CAPTURE_FN_DDL);
  }, 120_000);
  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('OLD (mig 464) trigger MISSES the signed record — the bug', async () => {
    const niche = 'niche-old';
    await db.sql.unsafe(OLD_TRIGGER_DDL);
    await seedLocalElite(db.sql, niche);
    const res = await markEliteFederatable(
      { workspaceId: WS, harnessSlug: SLUG, nicheKey: niche, eligibility: { outcome: 'won' }, outcomeSigner: testSigner() },
      db.sql,
    );
    expect(res.federatable).toBe(true);
    // The row's outcome_record IS set locally …
    const [{ has }] = (await db.sql`
      SELECT (outcome_record IS NOT NULL) AS has FROM harness_shared.gym_qd_archive
       WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND niche_key = ${niche}`) as unknown as Array<{ has: boolean }>;
    expect(has).toBe(true);
    // … but NO captured outbox op carries it (the record-only UPDATE never fired capture).
    const recs = await capturedRecords(db.sql, niche);
    expect(recs.length).toBeGreaterThan(0); // the federatable flip DID capture (record NULL)
    expect(recs.every((r) => r == null)).toBe(true);
  });

  it('FIXED (mig 481) trigger CAPTURES the signed record onto the outbox', async () => {
    const niche = 'niche-fixed';
    await db.sql.unsafe(FIXED_TRIGGER_DDL);
    await seedLocalElite(db.sql, niche);
    const signer = testSigner();
    const res = await markEliteFederatable(
      { workspaceId: WS, harnessSlug: SLUG, nicheKey: niche, eligibility: { outcome: 'won' }, outcomeSigner: signer },
      db.sql,
    );
    expect(res.federatable).toBe(true);
    const recs = await capturedRecords(db.sql, niche);
    // At least one captured op carries the signed record (the record-writing UPDATE fired).
    const withRecord = recs.filter((r) => r != null) as Array<Record<string, unknown>>;
    expect(withRecord.length).toBeGreaterThan(0);
    // And it is OUR device's signed record (anti-lift parity: the stamped pubkey is ours).
    expect(withRecord.some((r) => r['device_pubkey'] === signer.devicePubkeyBase64)).toBe(true);
  });

  it('no-signer (tier-1) still federates the federatable stamp, record NULL', async () => {
    const niche = 'niche-tier1';
    await db.sql.unsafe(FIXED_TRIGGER_DDL);
    await seedLocalElite(db.sql, niche);
    const res = await markEliteFederatable(
      { workspaceId: WS, harnessSlug: SLUG, nicheKey: niche, eligibility: { outcome: 'won' } },
      db.sql,
    );
    expect(res.federatable).toBe(true);
    const recs = await capturedRecords(db.sql, niche);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r == null)).toBe(true);
  });
});
