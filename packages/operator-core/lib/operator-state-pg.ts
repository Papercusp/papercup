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
  | 'pot_wake'
  // Migration 161 — the live-editable fleet rate-limit knobs (rate-limit-layer-v2 D-004):
  | 'operator_rate_limit_config'
  // Migration 164 — P2P voice-channel registry (holepunch-voice-channels P-007/D-011):
  | 'operator_voice_channels'
  // Migration 182 — P2P hive-directory offline cache (p2p-hive-directory P-003).
  // Renamed hive_directory_cache -> pot_directory_cache by migration 557
  // (cup-lexicon rename phase 3, 2026-07-10) — WI-953: the app code still
  // said 'hive_directory_cache' after the table rename, so every
  // readOperatorState/writeOperatorState call hit "relation ... does not
  // exist" and the directory-announce cache/tombstone path silently
  // no-opped (both catch(() => null)/catch(() => {})), starving
  // /api/discovery/hives of the persisted announce even when the P2P
  // gossip layer paired + accepted it in memory. Fixed here to the
  // current table name.
  | 'pot_directory_cache'
  // Migration 294 — withdrawal-tombstone watermarks (hive-from-repo-hardening
  // P-005). NOTE: each StateTable is its OWN harness_shared.<name> table, so
  // this needed its own migration (294) — the original "no new migration
  // needed" assumption was wrong and broke the hive-directory join path.
  // Renamed hive_directory_tombstones -> pot_directory_tombstones by
  // migration 557 (see the pot_directory_cache note above — same gap, same fix):
  | 'pot_directory_tombstones'
  // Migration 190 — Queen Claude-account pool (cloud-deployment-layer Phase 7 P-019):
  | 'operator_account_pool'
  // Migration 297 — owner's session-now account override (accounts-pool-tab P-004/D-015):
  | 'operator_account_override'
  // Migration 416 — durable dynamic agent→account pins (account-dynamic-pin; gateway honors per-request):
  | 'operator_owner_pins'
  // Migration 216 — PG-backed runtime flag overrides (audit P-070, EI-76):
  | 'operator_flag_overrides'
  // Migration 223 — P2P voice blind-relay state (holepunch-voice-channels
  // P-013/D-009; table was missing until EI-300):
  | 'voice_relay'
  // Migration 337 — runtime-settable deploy-migration lock_timeout/statement_timeout
  // (live-configurability-audit-2026-06-20 P-003):
  | 'operator_migrate_policy'
  // Migration 341 — settable fleet opus-budget shed bands (live-configurability-audit P-005):
  | 'operator_opus_budget_policy'
  // Migration 342 — settable account scale-out trigger policy (live-configurability-audit P-006):
  | 'operator_scale_policy'
  // Migration 346 — settable auto-implement risk policy + dispatch limits (live-configurability-audit P-011):
  | 'operator_auto_implement_policy'
  // Migration 348 — coordination liveness/reclaim config (live-configurability-audit P-014):
  | 'operator_coord_liveness_config'
  // Migration 350 — hive placement-watchdog control policy (live-configurability-audit P-015):
  | 'operator_pot_control_policy'
  // Migration 351 — green-checkpoint / release thresholds (live-configurability-audit P-016):
  | 'operator_release_checkpoint_config'
  // Migration 352 — runtime per-role capability-envelope overrides (live-configurability-audit P-009):
  | 'operator_capability_envelopes'
  // Migration 354 — runtime telemetry-buffer overrides (live-configurability-audit P-020):
  | 'operator_telemetry_buffer_config'
  // Migration 356 — runtime per-workspace txn lock/statement timeouts (live-configurability-audit P-020):
  | 'operator_txn_timeouts_config'
  // Migration 393 — runtime Scout workspace spend-ceiling override (live-configurability-audit P-022):
  | 'operator_scout_budget'
  // Migration 394 — runtime per-(tool,role) quota overrides (live-configurability-audit P-018):
  | 'operator_quota_overrides'
  // Migration 400 — runtime §G auth/sandbox overrides, DARK (live-configurability-audit P-019):
  | 'operator_auth_config'
  // Migration 401 — runtime capability→tier overrides, DARK (live-configurability-audit P-010):
  | 'operator_capability_tiers'
  // Migration 526 — generic third-party integration API keys (owner-ask-batch-2026-07-06 P-002):
  | 'operator_integration_credentials';

// ── operator-state read cache (infra-perf-robustness-audit-2026-06-18 P-004) ────
//
// `harness_registry` is read via readOperatorState on hot request paths (the audit
// found ~13.8M seq-scans / window via loadHarnessRegistry) but written rarely (a
// harness create/remove). A tiny per-(table, workspace) cache cuts that round-trip
// volume — easing both the PG pool (R1) and the event loop the psu incident exposed.
//
// SAFETY: only an ALLOWLIST of read-mostly tables is cached. The SAME process that
// writes invalidates its entry immediately (writeOperatorState / updateOperatorState
// below), so a write-then-read in one process is never stale. ACROSS processes (the
// cluster) staleness is bounded to the short TTL — acceptable for the registry, whose
// changes are rare and tolerate a couple seconds to propagate. Disable entirely with
// PAPERCUSP_OPSTATE_CACHE_MS=0 (the kill-switch). Encrypted tables are NOT allowlisted
// (no in-process plaintext caching of secrets).
const CACHEABLE_STATE_TABLES: ReadonlySet<StateTable> = new Set<StateTable>(['harness_registry']);

function opStateCacheTtlMs(): number {
  const raw = Number(process.env.PAPERCUSP_OPSTATE_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

interface OpStateCacheEntry {
  value: unknown;
  at: number;
}
const opStateCache = new Map<string, OpStateCacheEntry>();
const opStateCacheKey = (table: StateTable, ws: string): string => `${table}\x00${ws}`;

/** Invalidate a cached (table, ws) entry — called by every write path so the
 *  writing process never reads its own stale value. Exported for tests. */
export function invalidateOperatorStateCache(table: StateTable, ws: string): void {
  opStateCache.delete(opStateCacheKey(table, ws));
}

const OPERATOR_STATE_SYNC_NAMES: Partial<Record<StateTable, readonly string[]>> = {
  operator_prompt_user: ['operatorConfig.byWorkspace'],
  operator_preferences: ['operatorConfig.byWorkspace', 'operatorPreferences.byWorkspace'],
  operator_voice_prefs: ['voicePrefs.effective', 'voicePrefs.workspace'],
  operator_account_override: ['accounts.sessionOverride', 'accounts.pool'],
  operator_standing_candidates: ['operatorStandingApprovals.byWorkspace'],
};

async function notifyOperatorStateSync(table: StateTable): Promise<void> {
  const names = OPERATOR_STATE_SYNC_NAMES[table];
  if (!names?.length) return;
  try {
    const { notifySyncInvalidate } = await import('./sync-sse');
    await Promise.all(names.map((name) => notifySyncInvalidate(name, {})));
  } catch { /* the PG trigger remains the out-of-process guard */ }
}

/**
 * Read the single row for the active workspace, or null if missing.
 * Callers cast the JSONB payload to their module's type. For tables in
 * ENCRYPTED_TABLES, decrypts payload_ct on the fly.
 */
export async function readOperatorState<T>(
  table: StateTable,
  wsOverride?: string,
  opts?: { fresh?: boolean },
): Promise<T | null> {
  const { sql } = getOrgPg();
  const ws = wsOverride ?? activeWorkspaceId();

  // P-004: serve hot read-mostly tables (the allowlist — harness_registry) from a
  // tiny TTL cache. Same-process writes invalidate the entry (below), so a
  // write-then-read here is never stale; cross-process staleness is bounded by the TTL.
  //
  // WI-1378 (federation roster-empty, no-restart path): a correctness-critical caller
  // may pass { fresh:true } to BYPASS the cache READ (it still refreshes the entry
  // below). The joiner hive-home resolve (boot.ts resolveHiveHomeProjectionSlug) runs
  // on the in-place rekey INSIDE the substrate SIDECAR process (SUBSTRATE_SIDECAR),
  // a DIFFERENT process from the join-hive registry write — so the writer's
  // same-process cache invalidation never reached this process. A warm-stale
  // harness_registry entry made joinerPotHomeSlug return null at rekey → the rebind
  // block skipped → forceReFold never fired → the hive_members/hive_settings
  // projections stayed bound to the MEMBER slug → the owner's roster rows dropped
  // forever (empty until a restart cold-read fresh). A fresh read sees the committed
  // remote_hive/hive_slug (join-hive awaits the mutateRegistry commit before the rekey
  // RPC). The hot loadHarnessRegistry path does NOT pass fresh, so its cache win stands.
  const ttl = CACHEABLE_STATE_TABLES.has(table) ? opStateCacheTtlMs() : 0;
  if (ttl > 0 && !opts?.fresh) {
    const hit = opStateCache.get(opStateCacheKey(table, ws));
    if (hit && Date.now() - hit.at < ttl) return hit.value as T | null;
  }

  let result: T | null;
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
    result = rows.length > 0 ? (rows[0].plaintext ?? null) : null;
  } else {
    const rows = await sql<{ payload: T }[]>`
      SELECT payload FROM ${sql(`harness_shared.${table}`)}
       WHERE workspace_id = ${ws}
    `;
    result = rows.length > 0 ? rows[0].payload : null;
  }

  if (ttl > 0) opStateCache.set(opStateCacheKey(table, ws), { value: result, at: Date.now() });
  return result;
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
    invalidateOperatorStateCache(table, ws); // P-004: same-process read-after-write consistency
    await notifyOperatorStateSync(table);
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
  invalidateOperatorStateCache(table, ws); // P-004: same-process read-after-write consistency
  await notifyOperatorStateSync(table);
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

  const updated = (await sql.begin(async (tx) => {
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
  })) as T;
  invalidateOperatorStateCache(table, ws); // P-004: same-process read-after-write consistency
  await notifyOperatorStateSync(table);
  return updated;
}
