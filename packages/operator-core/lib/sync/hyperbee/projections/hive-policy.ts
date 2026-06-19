/**
 * Hyperbee → PG projection for `harness_shared.hive_policy` — the owner-SIGNED Hive
 * policy record (shared-hive-owner-enforcement-2026-06-19 EN-1; migration 317).
 *
 * Mirrors projections/hive-settings.ts (the closest analog — a Hive-home-scoped key
 * riding the peer-log) with ONE security-critical addition: this projection VERIFIES
 * the owner signature BEFORE applying. An unsigned / forged / wrong-signer policy is
 * DROPPED, never materialized — that is what makes the policy authoritative over P2P
 * (the plan's honest-peer trust model; brief EN-1 build step 3).
 *
 * The trust anchor is the HIVE IDENTITY pubkey (`harness_shared.hives.public_key`,
 * resolved by getHiveBySlug) — known on the owner AND every member (it is the key they
 * joined / derived the federation topic from). A valid policy must (a) carry
 * `owner_pubkey === <the hive identity pubkey>` and (b) verify the Ed25519 signature
 * over the canonical signed bytes (hive-policy-schema). Either failing ⇒ drop.
 *
 * Like hive_settings, this projection is registered scoped to the HIVE-HOME slug
 * (register-all.ts `hiveScoped`), so `opts.harnessSlug` is the Hive home — both the
 * demux guard and the getHiveBySlug trust-anchor lookup key off it. No hard FK to
 * hives (migration 317): if the identity row hasn't materialized yet on a joining peer
 * the verify FAILS CLOSED (drops the policy) rather than applying it unverified.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { getHiveBySlug } from '../../../hive-store';
import { verifyEd25519 } from '../../../identity/ed25519';
import { hivePolicySignedBytes } from '../../../hive-policy-schema';

/** Wire-shape of a hive_policy row in Hyperbee — the federated signed subset.
 *  Defensive on every field: a malformed remote op is dropped (decodeValue → null). */
export interface HivePolicyRow {
  /** The Hive's home_slug — the per-harness projection demux key. */
  harness_slug: string;
  /** The canonical signed policy JSON (TEXT — the exact bytes the signature covers). */
  policy_json: string;
  /** The Hive owner Ed25519 pubkey the policy was signed with (raw-32 base64). */
  owner_pubkey: string;
  /** Base64 Ed25519 signature over the canonical signed bytes. */
  signature: string;
  /** Monotone version; bumps each owner author. */
  policy_version: number;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isHivePolicyRow(input: unknown): input is HivePolicyRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.policy_json) || r.policy_json.length === 0) return false;
  if (!isString(r.owner_pubkey) || r.owner_pubkey.length === 0) return false;
  if (!isString(r.signature) || r.signature.length === 0) return false;
  if (typeof r.policy_version !== 'number' || !Number.isFinite(r.policy_version)) return false;
  return true;
}

/**
 * Verify a policy row's owner signature against the Hive identity pubkey. Returns true
 * ONLY when the signer IS the hive owner AND the Ed25519 signature is valid over the
 * canonical bytes. Fails CLOSED (false) on a missing hive identity, a wrong signer, a
 * malformed signature, or a bad signature. Never throws.
 */
export type VerifyHivePolicyFn = (
  opts: HivePolicyProjectionOpts,
  row: HivePolicyRow,
) => Promise<boolean>;

async function realVerifyHivePolicy(
  opts: HivePolicyProjectionOpts,
  row: HivePolicyRow,
): Promise<boolean> {
  // Trust anchor: the Hive identity pubkey, known on owner + member (the hives row).
  const hive = await getHiveBySlug(opts.workspaceId, opts.harnessSlug, opts.sql);
  if (!hive) return false; // fail closed — can't verify without the identity
  // (a) The signer must BE the hive owner — not merely a valid Ed25519 key.
  if (row.owner_pubkey !== hive.pubkeyBase64) return false;
  // (b) The signature must verify over the canonical signed bytes.
  let sig: Buffer;
  try {
    sig = Buffer.from(row.signature, 'base64');
  } catch {
    return false;
  }
  const bytes = hivePolicySignedBytes({
    workspaceId: opts.workspaceId,
    hiveHomeSlug: opts.harnessSlug,
    policyVersion: row.policy_version,
    canonicalPolicyJson: row.policy_json,
  });
  return verifyEd25519(bytes, row.owner_pubkey, sig);
}

export interface HivePolicyProjectionOpts {
  workspaceId: string;
  /** The Hive HOME slug (register-all binds this projection to the hive-home, like hive_settings). */
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /**
   * The owner-signature verifier. Default = realVerifyHivePolicy (the security gate).
   * Injectable so the teeth test can prove it is LOAD-BEARING: neuter it (→ always true)
   * and a forged policy applies = RED (brief EN-1 test posture).
   */
  verifyPolicy?: VerifyHivePolicyFn;
}

function composeKey(row: HivePolicyRow): string {
  // Singleton per Hive — the per-log key is the hive home slug.
  return row.harness_slug;
}

function decodeValue(raw: unknown): HivePolicyRow | null {
  return isHivePolicyRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HivePolicyProjectionOpts,
  row: HivePolicyRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  // Demux: this projection only applies its own Hive's policy ops.
  if (row.harness_slug !== opts.harnessSlug) return;

  // SECURITY GATE: verify the owner signature before applying. Forged/unsigned → drop.
  const verify = opts.verifyPolicy ?? realVerifyHivePolicy;
  if (!(await verify(opts, row))) return;

  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  // D-001: the op's HLC ordering key — the SAME causal key the merge fold uses.
  const fedHlc = provenance?.fedHlc ?? null;
  const now = Date.now();
  await sql`
    INSERT INTO harness_shared.hive_policy
      (workspace_id, harness_slug, policy_json, owner_pubkey, signature, policy_version,
       author_pubkey, origin, fed_ts, fed_hlc, created_at, updated_at)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.policy_json}, ${row.owner_pubkey},
       ${row.signature}, ${row.policy_version},
       ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE SET
      policy_json    = EXCLUDED.policy_json,
      owner_pubkey   = EXCLUDED.owner_pubkey,
      signature      = EXCLUDED.signature,
      policy_version = EXCLUDED.policy_version,
      author_pubkey  = EXCLUDED.author_pubkey,
      origin         = EXCLUDED.origin,
      fed_ts         = EXCLUDED.fed_ts,
      fed_hlc        = EXCLUDED.fed_hlc,
      updated_at     = ${now}
    -- PG-level LWW guard (D-001): order by the HLC (fed_hlc) when BOTH sides carry one,
    -- else fall back to the wall-clock fed_ts guard (pre-314 history). A newer policy
    -- (later author ⇒ later fed_hlc, monotone with policy_version) wins deterministically.
    WHERE (EXCLUDED.fed_hlc IS NOT NULL AND harness_shared.hive_policy.fed_hlc IS NOT NULL
             AND EXCLUDED.fed_hlc >= harness_shared.hive_policy.fed_hlc)
       OR ((EXCLUDED.fed_hlc IS NULL OR harness_shared.hive_policy.fed_hlc IS NULL)
             AND (harness_shared.hive_policy.fed_ts IS NULL
                  OR EXCLUDED.fed_ts >= harness_shared.hive_policy.fed_ts))
  `;
}

async function deleteFromPg(
  opts: HivePolicyProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  // A delete carries no signed row to verify; the demux + the LWW guard bound it. Only
  // the Hive's own home-scoped delete (key === harnessSlug) applies.
  if (key !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.hive_policy
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      -- D-001: guard the delete by the same HLC-then-fed_ts order as the put guard.
      AND (
        (${hlc}::text IS NOT NULL AND fed_hlc IS NOT NULL AND ${hlc}::text >= fed_hlc)
        OR ((${hlc}::text IS NULL OR fed_hlc IS NULL)
              AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint))
      )
  `;
}

export function buildHivePolicyProjection(
  opts: HivePolicyProjectionOpts,
): TableProjection<HivePolicyRow> {
  return {
    tableTag: 'hive-policy',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHivePolicyRow,
  realVerifyHivePolicy,
};
