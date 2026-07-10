/**
 * federated-column-completeness.integration.test.ts — the COLUMN-grain
 * federation-completeness guard (shared-pot-release-testing Brief B).
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
 * `shared-pot-release-testing/findings-B.md` (B-002): federate it, or confirm
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
  'fed_hlc', // projection stamps from op provenance.fedHlc (= op.hlc) — the D-001 HLC ordering key
  'author_pubkey', // projection stamps from the op's writerPubkey
  'verified_author_github_user_id', // projection derives via verified hive_members attestation (features; P-008)
  'schema_version', // rides the op envelope, not the row value
  'owner_author_pubkey', // harness_plans (mig 414/P-018-D-012): projection binds from the VERIFIED
  // source-log device on first authorized remote write (harness-plans.ts ownerToBind), preserved
  // across later overwrites — never carried from the mapper's row value.
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
    // WI-251 (findings-B B-002) RESOLVED 2026-06-20 (consensus su-328af/su-860d3):
    // the 10 content/lineage columns formerly REVIEW-tagged here are now FEDERATED
    // (toFeatureValue mapper + harness-features projection INSERT/UPSERT), so they
    // are removed from NOT_FEDERATED and this test now asserts they cross A→B.
    // work-item-release-cooldown-2026 (mig 485): per-machine claim-cooldown
    // bookkeeping (releaseWorkItem's UPDATE stamps these on the row IT frees) —
    // same call as assignee_rank/rank_writer/rank_updated_at above, local work-list
    // state, not content.
    last_released_by: 'per-machine claim-cooldown bookkeeping, local work state (mig 485)',
    last_released_at: 'per-machine claim-cooldown bookkeeping, local work state (mig 485)',
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
  hive_policy: {
    // EN-1: the federated subset is policy_json + owner_pubkey + signature + policy_version
    // (the owner-signed content, all carried by toHivePolicyValue). Only timestamps are local.
    created_at: 'machine-local row timestamp; the federated content is policy_json + signature',
    updated_at: 'machine-local row timestamp; the federated content is policy_json + signature',
  },
  hive_reports: {
    // EN-3 / P-MOD: the federated subset is report_id + reporter identity + target + status
    // (all carried by toHiveReportValue). Only the timestamps are machine-local.
    created_at: 'machine-local row timestamp; the federated content is the report fields + status',
    updated_at: 'machine-local row timestamp; the federated content is the report fields + status',
  },
  hive_pending_joins: {
    // EN-3 / P-MEMBER: the federated subset is the joiner identity + devices + the decision
    // (status/decided_*) — all carried by toHivePendingJoinValue. pending_join_fed_key is a
    // GENERATED column (auto-detected); only the timestamps are machine-local.
    created_at: 'machine-local row timestamp; the federated content is the joiner fields + decision',
    updated_at: 'machine-local row timestamp; the federated content is the joiner fields + decision',
  },
  hive_epoch_keys: {
    // shared-hive-rekey-2026-06-19 (P-005): the federated subset is the WRAPPED per-member
    // epoch key material + the epoch/member coords (carried by the value-mapper). Only the
    // row timestamps are machine-local. DARK until papercusp-hive-rekey flips (capture is
    // flag-gated), but the CDC map entry is unconditional so the column guard covers it now.
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
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
    last_progress_at: 'machine-local item-scoped progress heartbeat; claims/progress are re-established per receiver',
    base_harness_slug: 'engineer_issues view trigger identity helper (mig 510); not peer content',
    base_origin: 'engineer_issues view trigger origin-preservation helper (mig 514); op provenance supplies federation origin',
    updated_at: 'machine-local row timestamp (federated time is created_at via the mapper)',
    signal_origin: 'frontier signal provenance (organic/drill/replay/shadow) — local learning-lane tag',
  },
  harness_plan_parts: {
    author: 'rides the op provenance (writerPubkey → author_pubkey), not the row value (mapper doc)',
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
  },
  p2p_fleet_directory: {
    // P-101/D-006: the federated subset is the owner-signed record + envelope
    // (record_json/signature/signer/version/archived — all carried by
    // toFleetDirectoryValue). Only the row timestamps are machine-local.
    created_at: 'machine-local row timestamp; the federated content is record_json + signature',
    updated_at: 'machine-local row timestamp; the federated content is record_json + signature',
  },
  p2p_work_offers: {
    // P-102 store leg (WI-1935): the federated subset is the publisher-signed
    // record + envelope (record_json/signature/signer/version + the verified
    // convenience columns — all carried by toWorkOfferValue).
    local_disposition:
      "HOST-LOCAL refusal (revocation-reaper P-106 deferred #2) — deliberately never federates: a host cannot re-sign the publisher's record, it only stops serving it HERE (mig 490 masks it from the stamp trigger; the projection upsert never touches it)",
    created_at: 'machine-local row timestamp; the federated content is record_json + signature',
    updated_at: 'machine-local row timestamp; the federated content is record_json + signature',
  },
  p2p_fleet_leader_leases: {
    // P-302 LIVE-2 seam 1: the federated subset is the incumbent identity +
    // roster epoch (toFleetLeaderLeaseValue). Row timestamps are local; the
    // ordering cursor is fed_ts/fed_hlc from the op envelope.
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
  },
  agent_facts: {
    // F1-4/P-012 (mig 461/462): the federated subset is scope/scope_ref/key/body/
    // source_ref/expires_at/retracted_at/created_by (toAgentFactValue). Timestamps
    // are machine-local; source_hive is deliberately receiver-stamped from the
    // admitted log identity (never trusted from a sender-claimed value).
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
    source_hive: 'receiver-stamped from the admitted log identity — never carried (a sender-claimed source is never trusted)',
    shareable: 'send-side capture gate (mig 461/462 trigger WHEN NEW.shareable=true) — implicitly true for every row that reaches the wire at all, so redundant to carry',
  },
  gym_qd_archive: {
    // F1-2/F1-5 (mig 464/465): the federated subset is niche_key/candidate_id/scope/
    // domain/risk/fitness/descriptor/rationale/federatable/outcome_record/updated_at
    // (toGymQdEliteValue). created_at is machine-local (this row's local insert time).
    created_at: 'machine-local row timestamp (the federated cursor is updated_at, carried by the mapper)',
    // REVIEW(findings-B): `source` ('gym'|'scout' — the sender-local seed-origin tag,
    // mig 193) is real content a peer might want (weight scout-seeded elites
    // differently), but the RECEIVE-side table (gym_qd_foreign_elites) has no column
    // for it — carrying it needs a schema addition, out of scope for restoring this
    // guard (WI-2233). Tracked as a candidate gap, not silently ignored.
    source: 'sender-local seed-origin tag (gym|scout) — receive-side gym_qd_foreign_elites has no matching column yet; a real but small future gap, not carried today',
  },
  bee_claim_specs: {
    // P-016 (mig 438): federated subset is spec/revision/updated_by. updated_at is
    // machine-local. id_only is a DENORMALIZED observability tripwire the projection
    // now recomputes locally from the federated `spec` via isIdOnlySelector (never
    // carried on the wire — see bee-claim-spec.ts writeToPg).
    updated_at: 'machine-local row timestamp',
    id_only: 'denormalized tripwire recomputed locally from `spec` via isIdOnlySelector (bee-claim-spec.ts), not carried on the wire',
  },
  gate_verdicts: {
    // shared-hive-release-gate federation: the federated subset is the signed
    // verdict fields (repo_key/staging_sha/shard_id/inputs_hash/verdict/duration_ms/
    // device_pubkey/verdict_ts/sig — toGateVerdictValue). created_at is machine-local
    // (the federated timestamp is verdict_ts, carried by the mapper).
    created_at: 'machine-local row timestamp (federated time is verdict_ts, carried by the mapper)',
  },
  p2p_peer_grants: {
    // P-001 (mig 463): the federated subset is the grantor-signed record fields
    // (toP2pPeerGrantValue). Only the row timestamps are machine-local.
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
  },
  p2p_receipts: {
    // P-004 (mig 468): the federated subset is the receipt fields (toP2pReceiptValue).
    // Only the row timestamp is machine-local (receipt_ts is the federated time).
    created_at: 'machine-local row timestamp (federated time is receipt_ts, carried by the mapper)',
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
  it('sanity: the CDC-captured set is the 25 known federated tables', () => {
    // A new CDC table without a case here means a new federated table shipped —
    // the per-table loop below will still cover it (it iterates CDC_CAPTURED_TABLES).
    // 26 = 17 prior + 9 added since (p2p_fleet_directory/p2p_work_offers already
    // carried their own NOT_FEDERATED coverage when added; agent_facts,
    // gym_qd_archive, bee_claim_specs, gate_verdicts, p2p_peer_grants, p2p_receipts
    // did not — restored here, WI-2233). This count is a TRIPWIRE, not a target:
    // bump it AND add the new table's NOT_FEDERATED/mapper coverage together.
    expect(CDC_CAPTURED_TABLES.length).toBe(26);
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
