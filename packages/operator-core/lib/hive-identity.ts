/**
 * hive-identity — get-or-mint orchestration for the first-class Hive entity
 * (shared-hive-federation-2026-06-08 P-002/P-003).
 *
 * Bridges the two halves of Phase 0:
 *   - identity/hive-keypair.ts — mint/load the per-Hive Ed25519 keypair (secret in
 *     the OS keychain; the owning Swarm only).
 *   - hive-store.ts — persist + read the PUBLIC identity row in PG.
 *
 * `ensureHiveIdentity` is the single entry point both `hive:create` (fresh) and
 * `resolveHive` (lazy-backfill of a pre-existing hive) call: it mints-or-loads the
 * keypair and get-or-creates the hives row, returning the Hive's public identity.
 */
import { loadOrGenerateHiveKeypair } from './identity/hive-keypair';
import { deriveHiveFederationTopic } from './sync/hyperbee/derive-swarm-topic';
import { getHiveBySlug, insertHiveIfAbsent, type HiveRecord } from './hive-store';

export interface EnsureHiveIdentityResult {
  record: HiveRecord;
  /** True when the hives row was inserted now; false when it already existed. */
  created: boolean;
}

/**
 * Get-or-mint a Hive's identity. MUST run on the Hive's OWNING Swarm (the one that
 * holds, or will mint, the secret) — a peer Swarm that only has the pubkey must not
 * call this (it would mint a conflicting key; hive-keypair.ts guards the intent).
 * Today every `kind:'hive'` project in the local registry is locally owned, so this
 * is always safe; Phase 1 gates it on real ownership once peer Swarms exist.
 *
 * Idempotent: the keypair is stable (hive-keypair load-or-gen) and the row is
 * get-or-created (never clobbered). `meta` (title/description) applies only on the
 * first insert.
 */
export async function ensureHiveIdentity(
  workspaceId: string,
  homeSlug: string,
  meta?: { title?: string | null; description?: string | null },
): Promise<EnsureHiveIdentityResult> {
  const kp = await loadOrGenerateHiveKeypair(workspaceId, homeSlug);
  return insertHiveIfAbsent({
    workspaceId,
    homeSlug,
    pubkeyBase64: kp.pubkeyBase64,
    keychainId: kp.keychainId,
    title: meta?.title ?? null,
    description: meta?.description ?? null,
  });
}

/**
 * The Hive's public identity for the read path: the stored pubkey, or — for a
 * pre-existing hive that predates the entity — a best-effort lazy-backfill (mint +
 * persist on this owning Swarm). Returns `undefined` only if backfill genuinely
 * fails (e.g. the keychain is unavailable); a resolve must never throw because of
 * it (the hive stays usable by slug). Cheap in steady state: one PG read once the
 * row exists.
 */
export async function resolveHivePubkey(
  workspaceId: string,
  homeSlug: string,
): Promise<string | undefined> {
  const existing = await getHiveBySlug(workspaceId, homeSlug);
  if (existing) return existing.pubkeyBase64;
  try {
    const { record } = await ensureHiveIdentity(workspaceId, homeSlug);
    return record.pubkeyBase64;
  } catch (e) {
    console.warn(
      `[hive-identity] backfill failed for ${workspaceId}/${homeSlug}: ${e instanceof Error ? e.message : e}`,
    );
    return undefined;
  }
}

/** Hex-rendered federation topic for a Hive pubkey — surfaced in hive:get + logs.
 *  The actual swarm-join call-site swap is the Phase-1 boundary (P-004). */
export function hiveFederationTopicHex(pubkeyBase64: string): string {
  return deriveHiveFederationTopic(pubkeyBase64).toString('hex');
}
