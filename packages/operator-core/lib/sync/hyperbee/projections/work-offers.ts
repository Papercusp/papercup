/**
 * Hyperbee → PG projection for `harness_shared.p2p_work_offers` — the
 * publisher-SIGNED offer store (p2p-work-distribution-2026-07-02 P-102 store
 * leg, WI-1935; migration 490).
 *
 * Mirrors projections/fleet-directory.ts (the template: a signed record riding
 * the Hive peer-log, verified BEFORE apply) with a different trust anchor: the
 * signer is a DEVICE key that must be ATTESTED to the record's PUBLISHER via
 * the hive membership (hive_members.device_attestations — the WI-1585 gist
 * flow), resolved FRESH per op (NO TTL cache in a security path). A forged /
 * unattested / wrong-publisher / tampered record is DROPPED, never
 * materialized. There is no H10-style alternate signer: only the publisher's
 * own attested device ever authors or cancels their offer.
 *
 * AUTHORITY vs AUTHENTICITY (deliberate split): this gate proves the record is
 * authentically the publisher's. Whether that publisher is AUTHORIZED for the
 * fleet — in the owner-signed publisher set, epoch not stale — is the CONSUME
 * side's P-102 receiver chain (verifyOfferAuthorship at claim time): set
 * membership can change after publish, so it must never be frozen at apply
 * time. Applying an offer row is inert until a consumer decides to act on it.
 *
 * local_disposition (HOST-LOCAL, P-106 deferred #2) is NEVER written by this
 * projection — the upsert's column list omits it, so a remote refresh of a
 * record cannot clear this host's refusal.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { listHiveMembers, loadRevokedHivePubkeys } from '../../../hive-membership-store';
import { verifyEd25519 } from '../../../identity/ed25519';
import {
  parseWorkOfferRecordJson,
  workOfferFedKey,
  workOfferStoreSignedBytes,
} from '../../../p2p/offer-store-schema';

/** Wire-shape of a p2p_work_offers row in Hyperbee — the federated signed
 *  subset (local_disposition deliberately absent). Defensive on every field:
 *  a malformed remote op is dropped. */
export interface WorkOfferWireRow {
  /** The Hive's home_slug — the per-harness projection demux key. */
  harness_slug: string;
  publisher_github_user_id: number;
  offer_id: string;
  /** The canonical signed record JSON (TEXT — the exact bytes the signature covers). */
  record_json: string;
  /** The signing pubkey (raw-32 base64): a publisher-attested DEVICE key. */
  signer_device_pubkey: string;
  /** Base64 Ed25519 signature over the canonical signed bytes. */
  signature: string;
  /** Monotone version; bumps each author. */
  record_version: number;
  /** Filter conveniences; MUST match the signed record (verified below). */
  fleet_slug: string;
  offer_kind: string;
  status: string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isWorkOfferWireRow(input: unknown): input is WorkOfferWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (typeof r.publisher_github_user_id !== 'number' || !Number.isSafeInteger(r.publisher_github_user_id) || r.publisher_github_user_id <= 0) return false;
  if (!isString(r.offer_id) || r.offer_id.length === 0) return false;
  if (!isString(r.record_json) || r.record_json.length === 0) return false;
  if (!isString(r.signer_device_pubkey) || r.signer_device_pubkey.length === 0) return false;
  if (!isString(r.signature) || r.signature.length === 0) return false;
  if (typeof r.record_version !== 'number' || !Number.isFinite(r.record_version)) return false;
  if (!isString(r.fleet_slug) || r.fleet_slug.length === 0) return false;
  if (!isString(r.offer_kind) || r.offer_kind.length === 0) return false;
  if (!isString(r.status) || r.status.length === 0) return false;
  return true;
}

/**
 * Verify an offer row before apply. True ONLY when (a) the record JSON parses
 * to a valid record whose identity/convenience fields MATCH the row's columns
 * (no cuckoo rows), and (b) the Ed25519 signature over the canonical signed
 * bytes verifies under a signer device that is attested to the record's
 * PUBLISHER and not revoked. Fails CLOSED on every edge; never throws.
 */
export type VerifyWorkOfferFn = (
  opts: WorkOffersProjectionOpts,
  row: WorkOfferWireRow,
) => Promise<boolean>;

async function realVerifyWorkOffer(
  opts: WorkOffersProjectionOpts,
  row: WorkOfferWireRow,
): Promise<boolean> {
  try {
    // (a) Structural + no-cuckoo: the signed record must BE this row.
    const record = parseWorkOfferRecordJson(row.record_json);
    if (!record) return false;
    if (record.publisherGithubUserId !== row.publisher_github_user_id) return false;
    if (record.offerId !== row.offer_id) return false;
    if (record.recordVersion !== row.record_version) return false;
    if (record.fleetSlug !== row.fleet_slug) return false;
    if (record.kind !== row.offer_kind) return false;
    if (record.status !== row.status) return false;

    let sig: Buffer;
    try {
      sig = Buffer.from(row.signature, 'base64');
    } catch {
      return false;
    }
    const bytes = workOfferStoreSignedBytes({
      workspaceId: opts.workspaceId,
      hiveHomeSlug: opts.harnessSlug,
      recordVersion: row.record_version,
      canonicalRecordJson: row.record_json,
    });

    // (b) A publisher-attested, non-revoked DEVICE key signed it. Fresh
    // membership read per op — security path, no TTL cache.
    const revoked = await loadRevokedHivePubkeys(opts.workspaceId, opts.harnessSlug, opts.sql);
    if (revoked.has(row.signer_device_pubkey)) return false;
    const members = await listHiveMembers(opts.workspaceId, opts.harnessSlug, opts.sql);
    const publisherMember = members.find((m) => m.githubUserId === record.publisherGithubUserId);
    const signerAttestedToPublisher = !!publisherMember?.deviceAttestations?.some(
      (a) => a?.device_pubkey === row.signer_device_pubkey,
    );
    if (!signerAttestedToPublisher) return false;
    return verifyEd25519(bytes, row.signer_device_pubkey, sig);
  } catch {
    return false; // any resolution failure ⇒ drop (fail closed)
  }
}

export interface WorkOffersProjectionOpts {
  workspaceId: string;
  /** The Hive HOME slug (register-all binds this projection to the hive-home). */
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /**
   * The signature/attestation verifier. Default = realVerifyWorkOffer (the
   * security gate). Injectable so a teeth test can prove it is LOAD-BEARING:
   * neuter it (→ always true) and a forged record applies = RED.
   */
  verifyRecord?: VerifyWorkOfferFn;
}

function composeKey(row: WorkOfferWireRow): string {
  // The per-log key = the migration-490 generated offer_fed_key column.
  return workOfferFedKey(row.publisher_github_user_id, row.offer_id);
}

function decodeValue(raw: unknown): WorkOfferWireRow | null {
  return isWorkOfferWireRow(raw) ? raw : null;
}

async function writeToPg(
  opts: WorkOffersProjectionOpts,
  row: WorkOfferWireRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  // Demux: this projection only applies its own Hive's offer ops.
  if (row.harness_slug !== opts.harnessSlug) return;

  // SECURITY GATE: verify signature + attestation before applying. Forged → drop.
  const verify = opts.verifyRecord ?? realVerifyWorkOffer;
  if (!(await verify(opts, row))) return;

  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  const now = Date.now();
  const upsertResult = await sql`
    INSERT INTO harness_shared.p2p_work_offers
      (workspace_id, harness_slug, publisher_github_user_id, offer_id, record_json,
       signer_device_pubkey, signature, record_version, fleet_slug, offer_kind, status,
       author_pubkey, origin, fed_ts, fed_hlc, created_at, updated_at)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.publisher_github_user_id},
       ${row.offer_id}, ${row.record_json}, ${row.signer_device_pubkey},
       ${row.signature}, ${row.record_version}, ${row.fleet_slug}, ${row.offer_kind},
       ${row.status}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug, publisher_github_user_id, offer_id) DO UPDATE SET
      record_json          = EXCLUDED.record_json,
      signer_device_pubkey = EXCLUDED.signer_device_pubkey,
      signature            = EXCLUDED.signature,
      record_version       = EXCLUDED.record_version,
      fleet_slug           = EXCLUDED.fleet_slug,
      offer_kind           = EXCLUDED.offer_kind,
      status               = EXCLUDED.status,
      author_pubkey        = EXCLUDED.author_pubkey,
      origin               = EXCLUDED.origin,
      fed_ts               = EXCLUDED.fed_ts,
      fed_hlc              = EXCLUDED.fed_hlc,
      updated_at           = ${now}
    -- local_disposition deliberately NOT in the SET list: a remote refresh can
    -- never clear THIS host's refusal (P-106 deferred #2).
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() (mirrors lwwPick exactly).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.p2p_work_offers.fed_hlc, harness_shared.p2p_work_offers.fed_ts)
  `;

  // P-009 honor hook (the WI-1940 reaper pattern): a landed REMOTE-origin open
  // 'spawn_request' asks THIS host to spawn from its own delegated seats — hand
  // it to delegated-spawn-honor.ts (gate → target match → freshness → seat cap
  // → atomic disposition claim → spawn). Only remote ops reach here (skipOwnOps),
  // and the row is already signature-verified above. Dynamic import + best-effort:
  // the replication apply path must never drag the spawn graph in eagerly nor
  // unwind a landed write on a spawn hiccup (D-004: refusals are still loud —
  // the honor path itself emits the disposition + receipt).
  if ((upsertResult.count ?? 0) > 0 && row.offer_kind === 'spawn_request' && row.status === 'open' && provenance?.origin === 'remote') {
    try {
      const { honorSpawnRequestFromProjection } = await import('../../../p2p/delegated-spawn-honor');
      const res = await honorSpawnRequestFromProjection({
        workspaceId: opts.workspaceId,
        hiveHomeSlug: opts.harnessSlug,
        row,
        sql,
      });
      if (res.outcome === 'honored' || res.outcome === 'refused') {
        console.log(
          `[work-offers] spawn-request ${row.publisher_github_user_id}/${row.offer_id} → ${res.outcome}` +
            (res.outcome === 'honored' ? ` (${res.opened} member(s) opened${res.failed ? `, ${res.failed} failed` : ''})` : ` (${res.code})`),
        );
      }
    } catch (err) {
      console.warn(
        `[work-offers] spawn-request honor hook failed for ${row.publisher_github_user_id}/${row.offer_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function deleteFromPg(
  opts: WorkOffersProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  // Key = `<publisher-uid>/<offer-id>` (the generated fed key). Parse defensively.
  const slash = key.indexOf('/');
  if (slash <= 0) return;
  const publisher = Number(key.slice(0, slash));
  const offerId = key.slice(slash + 1);
  if (!Number.isSafeInteger(publisher) || publisher <= 0 || offerId.length === 0) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.p2p_work_offers
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND publisher_github_user_id = ${publisher}
      AND offer_id = ${offerId}
      -- guard the delete by the SAME fed_order_key() order as the put guard (EI-1698).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildWorkOffersProjection(
  opts: WorkOffersProjectionOpts,
): TableProjection<WorkOfferWireRow> {
  return {
    tableTag: 'p2p-work-offers',
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
  isWorkOfferWireRow,
  realVerifyWorkOffer,
};
