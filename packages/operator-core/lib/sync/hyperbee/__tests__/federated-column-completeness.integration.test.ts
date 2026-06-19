/**
 * federated-column-completeness.integration.test.ts — the COLUMN-grain
 * federation-completeness guard (shared-hive-release-testing Brief B).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The two existing coverage guards prove federation at the TABLE grain:
 *   • `checkSubstrateCaptureCoverage` (capture-coverage.test.ts) — every
 *     `sync:'peer-log'` table has a producer.
 *   • `checkPeerLogConsistency` (projection-engine.test.ts) — every federated
 *     tableTag has a registered projection.
 * Neither proves that every COLUMN the writer sets survives the round trip. The
 * CDC path reshapes each `substrate_outbox` row through a hand-written value
 * mapper in `feature-issue-op-keys.ts` (`toFeatureValue`, `toIssueValue`, …) and
 * the projection then INSERTs only the keys that mapper carries. A column added
 * to a federated table by a later migration whose mapper is NOT updated is
 * SILENTLY DROPPED on every peer — the row federates, but that column lands
 * NULL/default on B. This is the generalized `requeue_count` class (a column that
 * existed in prod but not the federation path; README §"Why a new pass" bug #4),
 * and it is exactly the brief's S0/S1 concern — "captures but silently drops on
 * the apply side = data loss on a real hive" — at the column grain.
 *
 * WHY AN INTEGRATION TEST (not a parse of the DDL files)
 * -----------------------------------------------------
 * The brief is explicit: "Build test schemas from the REAL baseline DDL +
 * migrations, not hand-rolled subsets." The flagship `feature-content-federation`
 * test stands up a HAND-ROLLED subset schema (a CREATE TABLE with only the
 * columns it knows about) and asserts via `toMatchObject` — so it structurally
 * CANNOT see a column it didn't enumerate. This test instead migrates an empty DB
 * 000-baseline → head through the REAL boot-path runner and introspects
 * `information_schema.columns`, so a NEW migration column that nobody mapped trips
 * it automatically — no test edit required.
 *
 * WHAT IT ASSERTS
 * ---------------
 * For each CDC-captured federated table (`CDC_CAPTURED_TABLES`), run the REAL
 * `outboxRowToLocalWriteOp` over a synthetic full-column outbox row and collect
 * the keys the mapper carries. Every real column must be EITHER:
 *   (a) carried by the mapper (it federates as a value), OR
 *   (b) PROVENANCE — set by the projection from the op envelope, not the mapper
 *       (workspace_id/origin/fed_ts/author_pubkey/…); it lands on the peer, just
 *       not via the mapper value, so it is NOT data loss, OR
 *   (c) a GENERATED / tsvector / local-autoincrement column PG computes locally
 *       (never federated by design), auto-detected from information_schema, OR
 *   (d) explicitly listed in `NOT_FEDERATED[table]` with a one-line reason.
 * Any column outside all four FAILS, naming the column + the remediation: carry
 * it in `feature-issue-op-keys.ts`, or add it to `NOT_FEDERATED` with a reason.
 *
 * The `NOT_FEDERATED` entries tagged `REVIEW(findings-B)` are the CANDIDATE
 * FEDERATION GAPS this pass surfaced — columns currently dropped that LOOK like
 * content (notably on `harness_features_consolidated`). They are allow-listed so
 * the guard is green/CI-safe, but each is an owner decision recorded in
 * `shared-hive-release-testing/findings-B.md` (B-002): federate it, or confirm
 * intentionally-local and drop the REVIEW tag.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { outboxRowToLocalWriteOp, CDC_CAPTURED_TABLES } from '../feature-issue-op-keys';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server boot.
// Roles are cluster-global on the reused testcontainer, hence IF NOT EXISTS.
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

/**
 * PROVENANCE columns — the projection writers set these from the OP ENVELOPE /
 * derive them, not from the mapper value. They DO land on the peer (verified
 * against the projection INSERTs), just not via the mapper, so their absence
 * from the mapper output is NOT data loss. Global because the federation
 * substrate stamps them uniformly.
 */
const PROVENANCE = new Set<string>([
  'workspace_id', // op envelope → projection (the harness/workspace demux)
  'origin', // projection stamps 'local' | 'remote' (the echo-loop guard column)
  'fed_ts', // projection stamps from op provenance.ts (EI-79 LWW cursor)
  'author_pubkey', // projection stamps from the op's writerPubkey
  'verified_author_github_user_id', // projection derives via verified hive_members attestation (features; P-008)
  'schema_version', // rides the op envelope, not the row value
]);

/**
 * Per-table columns intentionally NOT federated, EACH with the reason it is safe
 * to leave local. Entries tagged `REVIEW(findings-B)` are CANDIDATE GAPS this
 * pass surfaced (content-looking columns currently dropped) — allow-listed to
 * keep the guard green, but pending an owner federate/keep-local decision
 * (findings-B.md B-002). A bare entry (no REVIEW tag) is a settled local column.
 */
const NOT_FEDERATED: Record<string, Record<string, string>> = {
  harness_features_consolidated: {
    // Settled local — re-derived / machine-local / index / work-state, never content:
    working_users: 'derived projection of feature_working_set (recomputed locally per peer)',
    worked_by_history: 'local append-only audit of who worked it on THIS machine',
    verifier_last_error: 'verifier state, machine-local',
    verified_done_at_remote_ts: 'verifier state, re-derived per machine (polls the remote done-marker)',
    verifier_last_checked_at: 'verifier heartbeat, machine-local',
    audited_at: 'auto-review runs independently per peer (audit re-run locally)',
    audit_verdict: 'auto-review runs independently per peer',
    audit_reasons: 'auto-review runs independently per peer',
    created_by_github_user_id: 'provenance; author identity rides author_pubkey (PROVENANCE) on remote rows',
    assignee_rank: 'per-bee work-list ordering, local work state',
    rank_writer: 'per-bee work-list ordering, local work state',
    rank_updated_at: 'per-bee work-list ordering, local work state',
    requeue_count: 'local execution retry counter (per-machine dispatch state; the README §bug-4 schema-drift column)',
    schedule: 'recurring-schedule (cron/rrule) — machine-local scheduling, not content',
    schedule_active: 'machine-local scheduling state',
    scheduled_at: 'machine-local one-shot fire time',
    tzid: 'machine-local schedule timezone',
    template_slug: 'machine-local scheduled-template linkage',
    run_seq: 'machine-local scheduled-run sequence',
    // REVIEW(findings-B B-002) — content-looking columns currently dropped; owner to confirm:
    design_spec_id: 'REVIEW(findings-B): design linkage — a federated feature loses its design pointer on B',
    design_status: 'REVIEW(findings-B): design-phase status not federated',
    needs_design: 'REVIEW(findings-B): design gating flag not federated',
    discarded_design_work: 'REVIEW(findings-B): design provenance not federated',
    source_plan_slug: 'REVIEW(findings-B): plan→feature lineage lost on B (plans DO federate)',
    source_plan_item_ids: 'REVIEW(findings-B): plan-item lineage lost on B',
    see_also: 'REVIEW(findings-B): cross-feature references not federated',
    wave: 'REVIEW(findings-B): promote-wave dispatch metadata not federated (sibling feature_order IS)',
    deprecation_reason: 'REVIEW(findings-B): status federates but the reason for deprecation does not',
    completion_ref: 'REVIEW(findings-B): completion artifact pointer not federated',
  },
  harness_issues_consolidated: {
    // Issues federate every content column — only PROVENANCE is local. (Empty.)
  },
  contributor_usage_events: {
    // Append-only ledger; every content column federates. (Empty.)
  },
  harness_plans: {
    // harness_plans federates the canonical markdown `content` + content_hash +
    // scalars; the structured columns are re-derived locally from `content` (the
    // plan parser / the flag-gated recompose owns them), and the orchestrator /
    // scheduling columns are machine-local. (See projections/harness-plans.ts doc.)
    version: 'optimistic-CAS guard (D-005), machine-local row version',
    op_status: 'orchestrator picking state, machine-local',
    created_at: 'machine-local row timestamp (the federated date is the TEXT `created`)',
    updated_at: 'machine-local row timestamp (the federated date is the TEXT `updated`)',
    op_started_at: 'orchestrator picking state, machine-local',
    op_updated_at: 'orchestrator picking state, machine-local',
    op_priority: 'local dispatch priority, machine-local',
    current_wave: 'local promote-wave cursor, machine-local',
    items: 'denormalized parse of the federated `content` (re-derived on apply)',
    decisions: 'denormalized parse of the federated `content` (re-derived on apply)',
    now_state: 'denormalized parse of the federated `content` (re-derived on apply)',
    now_next: 'denormalized parse of the federated `content` (re-derived on apply)',
    schedule: 'recurring-schedule, machine-local scheduling',
    schedule_active: 'machine-local scheduling state',
    scheduled_at: 'machine-local one-shot fire time',
    expires_at: 'machine-local schedule expiry',
    tzid: 'machine-local schedule timezone',
    template_slug: 'machine-local scheduled-template linkage',
    run_seq: 'machine-local scheduled-run sequence',
  },
  coord_conversations: {
    accepted_post_id: 'local bigserial reference; the federated answer is `accepted_answer` (mapper doc)',
  },
  coord_event_log: {
    // id is a local autoincrement pk (auto-detected); msg_id is the fed key.
  },
  coord_threads: {
    // Every content column federates. (Empty.)
  },
  coord_thread_posts: {
    // id is a local autoincrement pk (auto-detected); post_msg_id is the fed key.
  },
  plan_item_assignments: {
    // fed_key is a GENERATED column (auto-detected). Content columns federate.
    created_at: 'machine-local row timestamp (federated times are assigned_ts/released_ts)',
    updated_at: 'machine-local row timestamp',
  },
  hive_settings: {
    created_at: 'machine-local row timestamp; the federated content is the `value`',
    updated_at: 'machine-local row timestamp; the federated content is the `value`',
  },
  hive_members: {
    display_name: 'GitHub-derived cosmetic, re-resolved per machine',
    avatar_url: 'GitHub-derived cosmetic, re-resolved per machine',
    joined_at: 'machine-local membership timestamp',
    last_seen_at: 'presence heartbeat, machine-local',
    channel1_verified_at: 'per-machine attestation-channel verification timestamp',
    channel2_verified_at: 'per-machine attestation-channel verification timestamp',
    channel2_branch_ref: 'per-machine attestation-channel ref',
    binding_last_checked_at: 'per-machine binding re-verify heartbeat',
    repo_permission: 'per-machine GitHub permission probe result (re-resolved locally)',
    permission_checked_at: 'per-machine permission probe timestamp',
  },
  engineer_issues: {
    assignee_rank: 'per-bee work-list ordering, local work state (mapper doc)',
    rank_writer: 'per-bee work-list ordering, local work state (mapper doc)',
    rank_updated_at: 'per-bee work-list ordering, local work state (mapper doc)',
    updated_at: 'machine-local row timestamp (federated time is created_at via the mapper)',
    signal_origin: 'frontier signal provenance (organic/drill/replay/shadow) — local learning-lane tag',
  },
  harness_plan_parts: {
    author: 'rides the op provenance (writerPubkey → author_pubkey), not the row value (mapper doc)',
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
  },
};

/** Run the REAL mapper over a synthetic full-column row and return the keys it
 *  carries onto the peer-log op value (the federated column set). The mapper
 *  builds a fixed-shape object, so the carried KEY set is independent of the
 *  sentinel values — we only need every real column present so a future column
 *  the mapper happens to read is exercised. */
function carriedColumns(tableName: string, realColumns: string[]): Set<string> {
  const row: Record<string, unknown> = { origin: 'local' };
  for (const c of realColumns) {
    if (!(c in row)) row[c] = `sentinel:${c}`;
  }
  const op = outboxRowToLocalWriteOp({ table_name: tableName, op: 'put', key: 'k-sentinel', ts: 1700, row });
  if (op.type !== 'put') throw new Error('expected a put op');
  return new Set(Object.keys(op.value as Record<string, unknown>));
}

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'fedcol',
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

describe('federated CDC tables — every column federates or is documented-local (column-drift guard)', () => {
  it('sanity: the CDC-captured set is the 13 known federated tables', () => {
    // A new CDC table without a case here means a new federated table shipped —
    // the per-table loop below will still cover it (it iterates CDC_CAPTURED_TABLES).
    expect(CDC_CAPTURED_TABLES.length).toBe(13);
  });

  for (const table of CDC_CAPTURED_TABLES) {
    it(`${table}: mapper carries every real column except documented-local`, async () => {
      // The REAL applied schema — not a hand-rolled subset.
      const cols = await sql<
        Array<{
          column_name: string;
          is_generated: string;
          is_identity: string;
          data_type: string;
          column_default: string | null;
        }>
      >`
        SELECT column_name, is_generated, is_identity, data_type, column_default
          FROM information_schema.columns
         WHERE table_schema = 'harness_shared' AND table_name = ${table}
      `;
      expect(cols.length, `table harness_shared.${table} not found in the migrated schema`).toBeGreaterThan(0);

      const realColumns = cols.map((c) => c.column_name);
      const carried = carriedColumns(table, realColumns);
      const local = NOT_FEDERATED[table] ?? {};

      const dropped: string[] = [];
      for (const c of cols) {
        const name = c.column_name;
        if (carried.has(name)) continue; // federates as a value
        if (PROVENANCE.has(name)) continue; // set by the projection from the op envelope
        if (c.is_generated === 'ALWAYS') continue; // PG-generated (fed_key, part_fed_key)
        if (c.data_type === 'tsvector') continue; // local search index (_search)
        // a local autoincrement pk the mapper does not carry — the federated
        // identity is a different key column (msg_id / post_msg_id). Covers both
        // bigserial (nextval default) and GENERATED-AS-IDENTITY pks.
        if ((c.column_default ?? '').includes('nextval(')) continue;
        if (c.is_identity === 'YES') continue;
        if (name in local) continue; // documented intentionally-local
        dropped.push(name);
      }

      expect(
        dropped,
        `harness_shared.${table} has column(s) that federation SILENTLY DROPS — they land ` +
          `NULL/default on every peer (data loss). For each: carry it in the value mapper ` +
          `(feature-issue-op-keys.ts) + the projection INSERT, OR add it to NOT_FEDERATED['${table}'] ` +
          `in this test with the reason it is safe to keep local. Dropped: ${dropped.join(', ')}`,
      ).toEqual([]);
    });
  }
});
