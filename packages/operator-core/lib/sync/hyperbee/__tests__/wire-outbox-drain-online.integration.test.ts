/**
 * wire-outbox-drain-online.integration.test.ts — the EI-521 send-side seam.
 *
 * ## The blind spot this closes
 * Three things were each proven in isolation, but the SEAM between them was not:
 *   - `outbox-drain.integration.test.ts` drives `startOutboxDrain` DIRECTLY.
 *   - `feature-content-federation.integration.test.ts` proves the full round-trip
 *     but calls `drainOutboxOnce` MANUALLY (never the live loop) and boots via
 *     `bootHarnessSubstrate` directly.
 *   - `join-default-boot-wiring.test.ts` proves the join orchestrator CALLS
 *     `bootSingleHarness` — but MOCKS it, so the drain wiring inside never runs.
 *
 * So NOTHING proved that `wireOutboxForHarness` (the seam `bootSingleHarness`
 * uses after a substrate boots) actually brings the drain loop ONLINE and
 * auto-drains a captured write. EI-521 is exactly that gap: a joined hive member
 * boots, `peer_connected` fires, but its outbox sits UNDRAINED forever ("0 drain
 * loops") → writes never federate. Every existing test stays green because they
 * drain by hand.
 *
 * ## What this proves
 * After `wireOutboxForHarness(handle, pg)` — and with NO manual `drainOutboxOnce`
 * — a feature inserted afterward is AUTO-drained by the live loop: the REAL
 * migration-102 capture trigger enqueues an outbox row, the LISTEN/poll loop the
 * seam started picks it up, `handle.append` carries it to the own log, and the
 * row's `drained_at` is stamped. A negative control confirms the loop is scoped:
 * a row for a DIFFERENT (workspace, harness) is left undrained.
 *
 * Real: testcontainer Postgres, the verbatim capture+fill migrations, the real
 * `wireOutboxForHarness` → `startOutboxDrain` loop. Stood in: the corestore/swarm
 * (a `makeFakeBootedHandle` captures `append`s) — irrelevant to the drain seam,
 * and proven elsewhere.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { wireOutboxForHarness } from '../wire-outbox';
import type { OutboxDrainHandle } from '../outbox-drain';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { makeFakeBootedHandle } from './fake-booted-handle';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../packages/operator-core/lib/sync/hyperbee/__tests__ → repo root is six up.
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const WORKSPACE_ID = 'ws-ei521-drain';
const HARNESS_SLUG = 'amem-ei521'; // a joined-hive-member-shaped slug

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a drain loop / db
    }
  }
});

/** Cluster-global framework roles the migration GRANTs reference (idempotent). */
const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
  END $pg$;
`;

/**
 * Build the minimal-but-faithful federation schema and apply the REAL
 * migration-102 (capture trigger + outbox) and 103 (workspace_id fill trigger)
 * verbatim — so the send-side this test drives is the production trigger. A
 * `projects` row maps `harness_slug → WORKSPACE_ID` so the fill trigger stamps
 * the SAME workspace_id the drain filters on. Mirrors the proven setup in
 * `feature-content-federation.integration.test.ts`.
 */
async function setupSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id        TEXT NOT NULL DEFAULT '',
      harness_slug        TEXT NOT NULL,
      feature_id          TEXT NOT NULL,
      title               TEXT,
      summary             TEXT,
      status              TEXT,
      attempts            INT,
      claims              TEXT,
      notes               TEXT,
      metadata            JSONB,
      kind                TEXT,
      project_id          TEXT,
      expected_cost_cents INT,
      tags                JSONB,
      needs_human_review  BOOLEAN,
      ts                  BIGINT,
      created_ts          BIGINT,
      updated_ts          BIGINT,
      parent_id           TEXT,
      goal_id             TEXT,
      taken_by            TEXT,
      taken_at            TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      item_kind           TEXT NOT NULL DEFAULT 'feature',
      feature_order       INTEGER,
      swarm_affinity      TEXT,
      redundancy          INTEGER,
      payload             JSONB,
      author_pubkey       TEXT,
      origin              TEXT NOT NULL DEFAULT 'local',
      fed_ts              BIGINT,
      PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.harness_issues_consolidated (
      harness_slug      TEXT NOT NULL,
      issue_id          TEXT NOT NULL,
      title             TEXT NOT NULL,
      severity          TEXT NOT NULL,
      source            TEXT NOT NULL,
      status            TEXT NOT NULL,
      found_at          TIMESTAMPTZ NOT NULL,
      found_during      TEXT,
      repro             TEXT,
      evidence          TEXT,
      suggested_fix     TEXT,
      code_pointer      TEXT,
      linked_feature_id TEXT,
      attempts          INT NOT NULL DEFAULT 0,
      notes             JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_ts        BIGINT NOT NULL,
      updated_ts        BIGINT NOT NULL,
      author_pubkey     TEXT,
      origin            TEXT NOT NULL DEFAULT 'local',
      fed_ts            BIGINT,
      PRIMARY KEY (harness_slug, issue_id)
    );
    CREATE TABLE harness_shared.projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      status       TEXT NOT NULL,
      slug         TEXT,
      workspace_id TEXT,
      created_ts   BIGINT NOT NULL,
      updated_ts   BIGINT NOT NULL
    );
  `);

  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-ei521', 'EI521', 'active', ${HARNESS_SLUG}, ${WORKSPACE_ID}, 0, 0)
  `;

  for (const file of [
    'archive/102-substrate-outbox.sql',
    'archive/103-issues-workspace-id-fill-trigger.sql',
  ]) {
    await sql.unsafe(readFileSync(join(SQL_DIR, file), 'utf8'));
  }

  // EI-79 step 2 (mig 181): mask the fed_ts LWW-guard column from the broad
  // capture compare (mirrors the proven setup), so an own-log merge-back doesn't
  // re-enqueue forever.
  await sql.unsafe(`
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
      AFTER UPDATE ON harness_shared.harness_features_consolidated
      FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
      EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');
  `);
}

async function outboxRow(sql: postgres.Sql, key: string) {
  const rows = await sql<Array<{ workspace_id: string; harness_slug: string; drained_at: number | null }>>`
    SELECT workspace_id, harness_slug, drained_at
      FROM harness_shared.substrate_outbox
     WHERE table_name = 'harness_features_consolidated' AND key = ${key}
  `;
  return rows[0];
}

async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('EI-521 — wireOutboxForHarness brings the drain loop ONLINE and auto-drains a captured write', () => {
  it(
    'a feature written AFTER wireOutboxForHarness is auto-drained by the loop (no manual drainOutboxOnce)',
    async () => {
      const db: FreshPgDb = await createFreshPgDb('ei521drain');
      cleanups.push(() => db.cleanup());
      await setupSchema(db.sql);

      const { handle, appended } = makeFakeBootedHandle({
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
      });

      // THE SEAM under test: the real wiring bootSingleHarness invokes. Returns
      // the live drain handle (LISTEN + poll). Stop it in cleanup (the fake
      // handle's registerCloseHook is a no-op, so we hold the stopper directly).
      const drain: OutboxDrainHandle = await wireOutboxForHarness(handle, db.sql);
      cleanups.push(() => drain.stop());

      const lenBefore = handle.ownLog.length;

      // Write a local feature → the REAL capture trigger enqueues an outbox row.
      // (Inserted AFTER wiring, so only the live loop — NOT the boot-time catch-up
      // drain — can drain it: exactly the joined-member runtime path.)
      await db.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-ei521-1', 'EI-521 send-side', 'todo', 0, 'local', 1001, 1001, 1001)
      `;

      // The trigger enqueued it scoped to the handle's (workspace, harness).
      const enqueued = await outboxRow(db.sql, 'F-ei521-1');
      expect(enqueued, 'capture trigger did not enqueue the feature').toBeTruthy();
      expect(enqueued.workspace_id).toBe(WORKSPACE_ID);
      expect(enqueued.harness_slug).toBe(HARNESS_SLUG);

      // NO manual drain — the live loop must drain it on its own (NOTIFY or poll).
      const drained = await pollUntil(
        async () => {
          const r = await outboxRow(db.sql, 'F-ei521-1');
          return r && r.drained_at != null ? r : undefined;
        },
        { timeoutMs: 10_000, intervalMs: 150 },
      );

      expect(
        drained,
        'the feature was never auto-drained — wireOutboxForHarness did not bring the drain loop online (EI-521)',
      ).toBeTruthy();
      // The op actually reached the own log (the drain appended it, log grew).
      expect(appended.length, 'drain marked drained_at but never appended to the log').toBeGreaterThan(0);
      expect(handle.ownLog.length).toBeGreaterThan(lenBefore);
    },
    30_000,
  );

  it(
    'NEGATIVE CONTROL: the loop is scoped — a row for a DIFFERENT (workspace, harness) is NOT drained',
    async () => {
      const db: FreshPgDb = await createFreshPgDb('ei521scope');
      cleanups.push(() => db.cleanup());
      await setupSchema(db.sql);

      // Map a SECOND, unrelated harness slug onto a different workspace.
      const OTHER_SLUG = 'other-harness';
      await db.sql`
        INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
        VALUES ('p-other', 'Other', 'active', ${OTHER_SLUG}, 'ws-other', 0, 0)
      `;

      const { handle } = makeFakeBootedHandle({ workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG });
      const drain = await wireOutboxForHarness(handle, db.sql);
      cleanups.push(() => drain.stop());

      // Write under the OTHER harness — the wired loop must ignore it.
      await db.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${OTHER_SLUG}, 'F-other-1', 'not mine', 'todo', 0, 'local', 1002, 1002, 1002)
      `;

      // Give the loop ample time (well past the poll cadence) to (wrongly) drain it.
      await new Promise((r) => setTimeout(r, 1500));
      const other = await outboxRow(db.sql, 'F-other-1');
      expect(other, 'other harness row should exist').toBeTruthy();
      expect(other.harness_slug).toBe(OTHER_SLUG);
      expect(
        other.drained_at,
        "the drain loop drained another harness's row — its (workspace, harness) scoping is broken",
      ).toBeNull();
    },
    30_000,
  );
});
