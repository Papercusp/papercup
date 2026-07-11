/**
 * CI guard for the `shared-hive-core` Tests-tab suite (buildSharedHiveCoreChecks).
 *
 * The live suite (Tests tab, `host` runner) runs these checks against the operator's
 * org PG; this test runs the SAME checks against a fresh, throwaway testcontainer DB
 * (injected `sql`) so the suite is green-able in CI and its real shared_presence /
 * hive_members SQL paths are exercised without touching the dev/live DB.
 *
 * It is the verifiable contract behind the suite — if a federation regression turns
 * any sub-check red, this goes red too (the live suite has no other automated gate).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { buildSharedHiveCoreChecks } from './checks';
import { applyPot557RenameAndFixups } from '../../sync/hyperbee/__tests__/_hive-substrate-rig';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../../libs/papercusp/libs/db/sql');

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('shared-hive-suite');
  // shared_presence: baseline shape (000-baseline) + hive_slug (mig 187) — the two
  // PG checks read/write it. Hand-built like lock-authority.integration.test.ts
  // rather than dragging in the whole baseline.
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.shared_presence (
      workspace_id   text   NOT NULL DEFAULT '',
      harness_slug   text   NOT NULL,
      github_user_id bigint NOT NULL,
      machine_label  text   NOT NULL,
      device_pubkey  text   NOT NULL,
      intent         text,
      current_view   text,
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      schema_version bigint NOT NULL DEFAULT 1,
      pot_slug       text,
      PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
    )
  `);
  // hives (184) + hive_members (185, FK → hives) — the admission-union check.
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '184-hives-table.sql'), 'utf8'));
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '185-hive-members-admission.sql'), 'utf8'));
  await applyPot557RenameAndFixups(db.sql);
});

afterAll(async () => {
  await db?.cleanup();
});

describe('shared-hive-core suite (buildSharedHiveCoreChecks) — every sub-check green', () => {
  it('all checks pass against a real testcontainer DB', async () => {
    const checks = buildSharedHiveCoreChecks('itest', { sql: db.sql });
    const results: Array<{ id: string; status: string; actual: string }> = [];
    for (const c of checks) {
      const r = await c.run();
      results.push({ id: c.id, status: r.status, actual: r.actual });
    }
    const notPassing = results.filter((r) => r.status !== 'pass');
    // A readable failure surface: which sub-check failed and its `actual`.
    expect(notPassing, notPassing.map((r) => `${r.id} [${r.status}]: ${r.actual}`).join('\n')).toEqual([]);
    expect(results).toHaveLength(checks.length);
  });

  it('the suite is idempotent — a second run on the same DB is also green (cleanup swept the first)', async () => {
    const checks = buildSharedHiveCoreChecks('itest', { sql: db.sql });
    for (const c of checks) {
      const r = await c.run();
      expect(r.status, `${c.id}: ${r.actual}`).toBe('pass');
    }
  });
});
