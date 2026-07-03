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
import { loadOrGenerateHiveKeypair, HIVE_KEYPAIR_SERVICE } from './identity/hive-keypair';
import { keychainLoad } from './identity/keychain';
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
  // A slug rename must NOT orphan the hive's key. The hives row's `keychain_id` is
  // AUTHORITATIVE: if the row already exists and THIS Swarm holds the key stored under
  // that id, return the row as-is — do NOT recompute the id from the (possibly renamed)
  // slug via loadOrGenerateHiveKeypair, whose miss-path would MINT a fresh divergent key
  // under the new slug id. That recompute-and-mint is exactly what orphaned canonical
  // 76dee8ea (stored under the legacy `papercup-hive` keychain id) and minted the
  // divergent ef77075a under the new `papercusp` id on the 2026-06-19 rebrand rename —
  // so the owner then announced the WRONG (empty) hive (the ef77075a divergence,
  // 2026-07-01). Only owned (non-`remote:`) rows we actually hold short-circuit here;
  // a fresh hive (no row) or a peer/orphaned key falls through to the mint-or-load path
  // unchanged.
  const existing = await getHiveBySlug(workspaceId, homeSlug);
  if (existing?.keychainId && !existing.keychainId.startsWith('remote:')) {
    const held = await keychainLoad(existing.keychainId, HIVE_KEYPAIR_SERVICE).catch(
      () => ({ kind: 'error' as const }),
    );
    if (held.kind === 'ok') return { record: existing, created: false };
  }
  // WI-1981 (the Phase-1 ownership gate, now real): a joined `remote_hive`
  // registry VIEW must NEVER reach the mint — that is a PEER's hive. The old
  // "today every kind:'hive' row is locally owned" assumption died when
  // joinHiveAsView started materializing view rows; the lazy-backfill below
  // then MINTED a second conflicting author identity on the joiner (wrong
  // epoch secrets → poison origin=local wraps → permanent mutual
  // epoch_decrypt_fail — proven live tower↔VM 2026-07-03). If the view carries
  // the verified announced pubkey (stamped by joinHiveAsView), heal the missing
  // hives row from IT (keychainId `remote:<pubkey>`, the existing non-owned
  // convention); with no stamped pubkey, refuse loudly rather than mint.
  const view = await remoteHiveView(workspaceId, homeSlug);
  if (view) {
    if (view.hive_pubkey) {
      return insertHiveIfAbsent({
        workspaceId,
        homeSlug,
        pubkeyBase64: view.hive_pubkey,
        keychainId: `remote:${view.hive_pubkey}`,
        title: meta?.title ?? null,
        description: meta?.description ?? null,
      });
    }
    const { RemoteHiveViewMintRefusedError } = await import('./identity/hive-keypair');
    throw new RemoteHiveViewMintRefusedError(workspaceId, homeSlug);
  }
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

/** WI-1981: the harness_registry view row for a JOINED remote hive, or null.
 *  Best-effort (an unreadable registry reads as "no view" — the keypair-level
 *  guard in loadOrGenerateHiveKeypair is the authoritative backstop). */
async function remoteHiveView(
  workspaceId: string,
  slug: string,
): Promise<{ hive_pubkey?: string } | null> {
  try {
    const { loadHarnessRegistry } = await import('./harness-registry');
    const reg = await loadHarnessRegistry(workspaceId);
    const entry = reg.projects?.find((p) => p.slug === slug);
    return entry?.remote_hive === true ? entry : null;
  } catch {
    return null;
  }
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
