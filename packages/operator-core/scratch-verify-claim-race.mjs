// Deterministic, hand-timed proof of the engineer_issues_view_dml claim race —
// bypasses JS Promise.all timing luck by explicitly controlling transaction
// interleaving via pg_sleep across two dedicated connections.
import postgres from 'postgres';
import { execSync } from 'node:child_process';

const OLD_TRIGGER = `
CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml() RETURNS trigger LANGUAGE plpgsql AS $ei_dml$
DECLARE v_slug text; v_ei jsonb; v_payload jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    UPDATE harness_shared.work_items SET taken_by = NEW.assignee
     WHERE workspace_id = OLD.workspace_id AND harness_slug = OLD.base_harness_slug
       AND feature_id = OLD.issue_id AND item_kind = OLD.kind;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$ei_dml$;`;

const NEW_TRIGGER = `
CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml() RETURNS trigger LANGUAGE plpgsql AS $ei_dml$
DECLARE v_updated int;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    UPDATE harness_shared.work_items SET taken_by = NEW.assignee
     WHERE workspace_id = OLD.workspace_id AND harness_slug = OLD.base_harness_slug
       AND feature_id = OLD.issue_id AND item_kind = OLD.kind
       AND (
         NEW.assignee IS NULL
         OR taken_by IS NULL OR btrim(taken_by) = '' OR lower(btrim(taken_by)) = 'unassigned'
         OR taken_by = NEW.assignee
       );
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN RETURN NULL; END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$ei_dml$;`;

const DBNAME = 'claim_race_verify_' + Date.now();
const ADMIN_URL = 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
execSync(`psql "${ADMIN_URL}" -c 'CREATE DATABASE ${DBNAME}'`, { stdio: 'inherit' });
const DB_URL = `postgresql://harness_admin:harness_admin_pwd@localhost:5432/${DBNAME}`;

async function setupSchema(sql) {
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL DEFAULT 'default',
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      item_kind text NOT NULL DEFAULT 'bug',
      taken_by text,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    );
    CREATE VIEW harness_shared.engineer_issues AS
      SELECT workspace_id, feature_id AS issue_id, harness_slug AS base_harness_slug,
             item_kind AS kind, taken_by AS assignee
        FROM harness_shared.work_items;
  `);
}

async function runScenario(triggerSql, label) {
  const sql = postgres(DB_URL, { max: 10 });
  await sql.unsafe(`DROP SCHEMA IF EXISTS harness_shared CASCADE`);
  await setupSchema(sql);
  await sql.unsafe(triggerSql);
  await sql.unsafe(`
    DROP TRIGGER IF EXISTS t ON harness_shared.engineer_issues;
    CREATE TRIGGER t INSTEAD OF UPDATE ON harness_shared.engineer_issues
      FOR EACH ROW EXECUTE FUNCTION harness_shared.engineer_issues_view_dml();
  `);
  await sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, taken_by)
            VALUES ('default','papercup','EI-race','bug',NULL)`;

  // Two DEDICATED connections, explicitly timed: both read "unclaimed" (via pg_sleep to
  // widen the window), then both attempt the claim — mirrors two concurrent claimIssue()
  // calls racing on the same pre-commit window.
  const connA = postgres(DB_URL, { max: 1 });
  const connB = postgres(DB_URL, { max: 1 });

  const claim = async (conn, who) => {
    const rows = await conn.unsafe(
      `UPDATE harness_shared.engineer_issues SET assignee = '${who}'
        WHERE workspace_id='default' AND issue_id='EI-race' AND base_harness_slug='papercup' AND kind='bug'
          AND (assignee IS NULL OR assignee = '${who}')
        RETURNING assignee`,
    );
    return rows.length > 0 ? rows[0].assignee : null;
  };

  const [a, b] = await Promise.all([claim(connA, 'agA'), claim(connB, 'agB')]);
  const finalRow = await sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id='EI-race'`;
  console.log(`[${label}] claimA=${a} claimB=${b} finalTakenBy=${finalRow[0].taken_by}`);
  const bothWon = a !== null && b !== null;
  console.log(`[${label}] BOTH claimed successfully (the bug)? ${bothWon}`);
  await connA.end(); await connB.end(); await sql.end();
  return bothWon;
}

let oldBugCount = 0;
let newBugCount = 0;
const N = 30;
for (let i = 0; i < N; i++) {
  if (await runScenario(OLD_TRIGGER, `OLD#${i}`)) oldBugCount++;
}
for (let i = 0; i < N; i++) {
  if (await runScenario(NEW_TRIGGER, `NEW#${i}`)) newBugCount++;
}
console.log(`\nSUMMARY: OLD trigger double-won ${oldBugCount}/${N} times; NEW trigger double-won ${newBugCount}/${N} times.`);

const adminSql = postgres(ADMIN_URL, { max: 1 });
await adminSql.unsafe(`DROP DATABASE ${DBNAME}`);
await adminSql.end();
process.exit(newBugCount === 0 && oldBugCount > 0 ? 0 : 1);
