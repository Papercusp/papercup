/**
 * Shared read/write helpers for the operator-state PG tables introduced
 * by migration 020 (and later extensions through migration 027).
 *
 * Each table is single-row-per-workspace with a JSONB payload. The
 * existing module-level types (`BudgetState`, `LastScanEntry`,
 * `TtsSpendState`, etc.) continue to govern the payload shape — these
 * helpers just hide the SQL.
 *
 * Why per-workspace: prior file-backed approach had the workspace baked
 * into the path (`<ws>/.papercusp/system/operator/X.json`). Moving to
 * PG keeps the same scoping by stamping every row with workspace_id,
 * which `activeWorkspaceId()` resolves at call time.
 *
 * Encryption-at-rest: tables in `ENCRYPTED_TABLES` (migration 027) have
 * a sibling `payload_ct BYTEA` column holding pgcrypto-encrypted bytes.
 * Reads decrypt via pgp_sym_decrypt with a key sourced from
 * `~/.papercusp/db-encryption-key` (or the env-var override). Writes
 * always populate `payload_ct`; the legacy `payload` column is kept null
 * on writes so a future migration can drop it. Tables NOT in the set
 * continue to use the plaintext `payload` JSONB column unchanged.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { ENCRYPTED_TABLES, getDbEncryptionKey } from './db-encryption';

// (operator_last_scan / operator_idle_snapshot / operator_scanner_session were
// removed with the scanner teardown — unify-agent-launches D-005, migration 167.)
type StateTable =
  | 'operator_budget'
  | 'operator_standing_candidates'
  | 'operator_tts_spend'
  | 'operator_stt_spend'
  | 'operator_voice_prefs'
  | 'operator_credentials'
  // Round-2 extensions (migration 021):
  | 'operator_agent_config'
  | 'operator_first_run'
  | 'operator_user_profile'
  // Round-3 extensions (migration 022):
  | 'operator_prompt_user'
  | 'operator_preferences'
  | 'operator_publish_credentials'
  // Round-4 extension (migration 023):
  | 'operator_voice_credentials'
  // Round-5 extensions (migration 024):
  | 'operator_oracle_prompt'
  | 'operator_oracle_memory'
  | 'operator_marketplace_token'
  // Round-6 extensions (migration 025):
  | 'harness_registry'
  // Round-6 extensions (migration 026):
  | 'operator_trust_store'
  // Round-7 extension (migration 029):
  | 'operator_paused'
  // Migration 047 — search-provider keys for OMP web_search:
  | 'operator_search_provider_credentials'
  // Migration 062 — Setup Wizard state + telemetry reports buffer:
  | 'setup_wizard_state'
  | 'telemetry_reports'
  // Migration 158 — the Pot's self-declared-wake state (autoloop-pot-operator-rebuild P0):
  | 'hive_wake'
  // Migration 161 — the live-editable fleet rate-limit knobs (rate-limit-layer-v2 D-004):
  | 'operator_rate_limit_config'
  // Migration 164 — P2P voice-channel registry (holepunch-voice-channels P-007/D-011):
  | 'operator_voice_channels'
  // Migration 182 — P2P hive-directory offline cache (p2p-hive-directory P-003):
  | 'hive_directory_cache'
  // Migration 294 — withdrawal-tombstone watermarks (hive-from-repo-hardening
  // P-005). NOTE: each StateTable is its OWN harness_shared.<name> table, so
  // this needed its own migration (294) — the original "no new migration
  // needed" assumption was wrong and broke the hive-directory join path:
  | 'hive_directory_tombstones'
  // Migration 190 — Queen Claude-account pool (cloud-deployment-layer Phase 7 P-019):
  | 'operator_account_pool'
  // Migration 297 — owner's session-now account override (accounts-pool-tab P-004/D-017):
  | 'operator_account_override'
  // Migration 216 — PG-backed runtime flag overrides (audit P-070, EI-76):
  | 'operator_flag_overrides'
  // Migration 223 — P2P voice blind-relay state (holepunch-voice-channels
  // P-013/D-009; table was missing until EI-300):
  | 'voice_relay';

/**
 * Read the single row for the active workspace, or null if missing.
 * Callers cast the JSONB payload to their module's type. For tables in
 * ENCRYPTED_TABLES, decrypts payload_ct on the fly.
 */
export async function readOperatorState<T>(table: StateTable, wsOverride?: string): Promise<T | null> {
  const { sql } = getOrgPg();
  const ws = wsOverride ?? activeWorkspaceId();

  if (ENCRYPTED_TABLES.has(table)) {
    const key = getDbEncryptionKey();
    const rows = await sql<{ plaintext: T | null }[]>`
      SELECT
        CASE
          WHEN payload_ct IS NOT NULL
            THEN pgp_sym_decrypt(payload_ct, ${key})::jsonb
          ELSE payload
        END AS plaintext
      FROM ${sql(`harness_shared.${table}`)}
       WHERE workspace_id = ${ws}
    `;
    return rows.length > 0 ? (rows[0].plaintext ?? null) : null;
  }

  const rows = await sql<{ payload: T }[]>`
    SELECT payload FROM ${sql(`harness_shared.${table}`)}
     WHERE workspace_id = ${ws}
  `;
  return rows.length > 0 ? rows[0].payload : null;
}

/** Upsert the single row for the active workspace. */
export async function writeOperatorState<T>(
  table: StateTable,
  payload: T,
  wsOverride?: string,
): Promise<void> {
  const { sql } = getOrgPg();
  const ws = wsOverride ?? activeWorkspaceId();
  const now = Date.now();

  if (ENCRYPTED_TABLES.has(table)) {
    const key = getDbEncryptionKey();
    const text = JSON.stringify(payload);
    // payload column kept-null on writes; future migration drops it.
    await sql`
      INSERT INTO ${sql(`harness_shared.${table}`)}
        (workspace_id, payload, payload_ct, updated_at)
      VALUES (
        ${ws},
        '{}'::jsonb,
        pgp_sym_encrypt(${text}, ${key}),
        ${now}
      )
      ON CONFLICT (workspace_id) DO UPDATE
        SET payload = '{}'::jsonb,
            payload_ct = EXCLUDED.payload_ct,
            updated_at = EXCLUDED.updated_at
    `;
    return;
  }

  await sql`
    INSERT INTO ${sql(`harness_shared.${table}`)}
      (workspace_id, payload, updated_at)
    VALUES (${ws}, ${JSON.stringify(payload)}::text::jsonb, ${now})
    ON CONFLICT (workspace_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at
  `;
}

/**
 * Read-modify-write atomically inside a single PG round-trip. Avoids the
 * multi-tab race condition of the file-backed approach.
 *
 * The mutator runs inside a transaction; if two tabs call this
 * concurrently, the second one sees the first's committed value as input.
 *
 * Encrypted tables: decrypt → mutate → re-encrypt happens inside the same
 * transaction so the row stays consistent.
 */
export async function updateOperatorState<T>(
  table: StateTable,
  defaultValue: T,
  mutator: (current: T) => T,
  wsOverride?: string,
): Promise<T> {
  const { sql } = getOrgPg();
  const ws = wsOverride ?? activeWorkspaceId();
  const isEncrypted = ENCRYPTED_TABLES.has(table);
  const key = isEncrypted ? getDbEncryptionKey() : null;

  return await sql.begin(async (tx) => {
    let current: T;
    if (isEncrypted && key !== null) {
      const rows = await tx<{ plaintext: T | null }[]>`
        SELECT
          CASE
            WHEN payload_ct IS NOT NULL
              THEN pgp_sym_decrypt(payload_ct, ${key})::jsonb
            ELSE payload
          END AS plaintext
        FROM ${tx(`harness_shared.${table}`)}
         WHERE workspace_id = ${ws}
         FOR UPDATE
      `;
      current = rows.length > 0 ? (rows[0].plaintext ?? defaultValue) : defaultValue;
    } else {
      const rows = await tx<{ payload: T }[]>`
        SELECT payload FROM ${tx(`harness_shared.${table}`)}
         WHERE workspace_id = ${ws}
         FOR UPDATE
      `;
      current = rows.length > 0 ? rows[0].payload : defaultValue;
    }

    const next = mutator(current);

    if (isEncrypted && key !== null) {
      const text = JSON.stringify(next);
      await tx`
        INSERT INTO ${tx(`harness_shared.${table}`)}
          (workspace_id, payload, payload_ct, updated_at)
        VALUES (
          ${ws},
          '{}'::jsonb,
          pgp_sym_encrypt(${text}, ${key}),
          ${Date.now()}
        )
        ON CONFLICT (workspace_id) DO UPDATE
          SET payload = '{}'::jsonb,
              payload_ct = EXCLUDED.payload_ct,
              updated_at = EXCLUDED.updated_at
      `;
    } else {
      await tx`
        INSERT INTO ${tx(`harness_shared.${table}`)}
          (workspace_id, payload, updated_at)
        VALUES (${ws}, ${JSON.stringify(next)}::text::jsonb, ${Date.now()})
        ON CONFLICT (workspace_id) DO UPDATE
          SET payload = EXCLUDED.payload,
              updated_at = EXCLUDED.updated_at
      `;
    }
    return next;
  }) as T;
}
