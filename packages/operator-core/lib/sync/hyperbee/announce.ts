/**
 * announce — the signed peer-announce wire-format (Model B substrate, Stage 3).
 *
 * Per-peer Hypercore logs replicate over the swarm. On connect, peers exchange
 * a signed announce that binds a peer's log core to its device identity:
 *
 *   { device_pubkey, github_user_id, github_login, log_core_key, ts, nonce?, sig }
 *
 *   - device_pubkey — the RAW 32-byte Ed25519 device public key, base64. This
 *     is the SAME string as the binding's `device_pubkey`
 *     (attest.ts / two-channel-verifier.ts), so a verified announce identifies
 *     a device whose binding the read-admission decision can then check.
 *   - log_core_key — the 64-hex Hypercore key of the peer's writable log
 *     (distinct from device_pubkey; one is identity, one is the core to read).
 *   - ts — epoch-ms timestamp (Date.now()) at announce-build time. Covered by
 *     the signature; `verifyAnnounce` rejects frames outside a ±windowMs
 *     freshness window (default 5 min), closing the replay-announce attack
 *     surface (D-007).
 *   - nonce — optional random string for additional replay resistance. Also
 *     covered by the signature.
 *   - sig — base64 Ed25519 signature over the canonical body (excluding `sig`).
 *
 * Crypto contract (Stage-0 spike, run-verified): Node-crypto Ed25519,
 * `sign(null, …)` / `verify(null, …)` (algorithm MUST be null for Ed25519),
 * with the raw-32-byte-base64 pubkey → SPKI-DER rebuild via the fixed 12-byte
 * Ed25519 prefix `302a300506032b6570032100`. This mirrors attest.ts's private
 * `verifyEd25519Signature` + `buildSpkiDerFromRawPubkey` and
 * two-channel-verifier.ts's `verifyContributorFileSignature` exactly, so the
 * announce sig is byte-compatible with the binding's signatures.
 *
 * attest.ts does not export those helpers (they're private and bound to the
 * AttestationGistBody schema), so the primitive is reimplemented here against
 * the announce body. The signer is INJECTED — tests pass a generated keypair;
 * production passes `bytes => signWithDeviceKey(keychainId, bytes)`.
 *
 * Canonicalization: the body is all primitives (no nested objects), so a fixed
 * field-ordered `JSON.stringify` is equivalent to JCS (RFC 8785) for this
 * schema. Field order: device_pubkey, github_user_id, github_login, log_core_key,
 * ts[, nonce].
 */

import { verify as nodeVerify, createPublicKey } from 'node:crypto';

/** The signed-over fields of an announce (everything except `sig`). */
export interface AnnounceBody {
  /** Raw 32-byte Ed25519 device public key, base64 (== binding device_pubkey). */
  device_pubkey: string;
  github_user_id: number;
  github_login: string;
  /** P-011 device-attestation gist id. The channel-2 anchor rides the SIGNED
   *  announce so a remote peer can admit via
   *  `verifyAttestation(attestation_gist_id, device_pubkey, github_user_id)`
   *  WITHOUT fetching a shared-repo contributor file — i.e. join needs no repo
   *  write (write-free join, `non-collaborator-join-fork-pr-2026-06-02`). It is
   *  covered by the signature, so it cannot be substituted in transit; and
   *  `verifyAttestation` pins gist `owner.id === github_user_id`, so a peer can
   *  only bind a gist it actually owns. */
  attestation_gist_id: string;
  /** 64-hex Hypercore key of the peer's writable log. */
  log_core_key: string;
  /** A-003 (a′): the ORIGIN harness slug this log belongs to. An instance may
   *  run several local harnesses on ONE hive topic (a hive's member harness +
   *  its hive-home harness, so hive_members/hive_settings federate), all sharing
   *  one announce channel that carries every local log's announce. Because
   *  read-admission is IDENTITY-only and every harness registers all
   *  projections, an inbound announce broadcast to all on-topic handlers would
   *  let one harness admit + apply another harness's log (cross-merge
   *  pollution). The receive-side filter (boot.ts onAnnounce) admits a frame iff
   *  `harness_slug === own slug` OR `=== joinerHiveHomeSlug(self)` — so it must
   *  ride the SIGNED frame (cannot be spoofed to mis-route a log). OPTIONAL +
   *  backward-compatible: absent → omitted from the signing bytes (identical to
   *  a pre-(a′) frame), and the receive filter treats absent as the legacy
   *  single-harness path. */
  harness_slug?: string;
  /** Epoch-ms timestamp at announce-build time. Covered by sig; used for
   *  freshness check in verifyAnnounce (D-007 replay hardening). */
  ts: number;
  /** Optional random nonce for additional replay resistance. Covered by sig. */
  nonce?: string;
}

/** A full announce frame as sent on the wire. */
export interface SignedAnnounce extends AnnounceBody {
  /** Base64 Ed25519 signature over `announceSigningBytes(body)`. */
  sig: string;
}

/** Fixed 12-byte Ed25519 SPKI DER prefix (matches attest.ts / two-channel-verifier.ts). */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Canonical signing bytes for an announce: field-ordered JSON of the body
 * EXCLUDING `sig`. All values are primitives so this equals JCS for the schema.
 * Field order: device_pubkey, github_user_id, github_login, attestation_gist_id,
 * log_core_key, ts[, harness_slug][, nonce]. The trailing optionals (harness_slug,
 * nonce) are included only when present (defined + string), so an absent optional
 * yields byte-identical bytes to a frame that never had it.
 */
export function announceSigningBytes(body: AnnounceBody): Buffer {
  // Build ordered object — nonce only when present (undefined → omit key).
  const ordered: Record<string, string | number> = {
    device_pubkey: body.device_pubkey,
    github_user_id: body.github_user_id,
    github_login: body.github_login,
    attestation_gist_id: body.attestation_gist_id,
    log_core_key: body.log_core_key,
    ts: body.ts,
  };
  // A-003 (a′): the origin harness slug, when present, is signed-over so it
  // cannot be spoofed to mis-route a log on the receive-side admission filter.
  // Conditional (like nonce) → absent yields byte-identical canonical bytes to a
  // pre-(a′) frame, so existing signatures verify unchanged (backward compat).
  if (typeof body.harness_slug === 'string') {
    ordered.harness_slug = body.harness_slug;
  }
  if (typeof body.nonce === 'string') {
    ordered.nonce = body.nonce;
  }
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/**
 * Build a signed announce. The signer is injected so tests can use a generated
 * keypair and production passes `bytes => signWithDeviceKey(keychainId, bytes)`.
 * The signer returns the raw 64-byte Ed25519 signature; it's base64-encoded here.
 *
 * `opts.nowMs` overrides `Date.now()` for the `ts` field — useful in tests that
 * need a deterministic timestamp or want to simulate stale/future announces.
 * If `body` already contains `ts`, that value is REPLACED by the opts/default clock.
 */
export async function buildAnnounce(
  body: Omit<AnnounceBody, 'ts'> & { ts?: number },
  sign: (bytes: Buffer) => Promise<Buffer>,
  opts?: { nowMs?: number },
): Promise<SignedAnnounce> {
  const stamped: AnnounceBody = { ...body, ts: opts?.nowMs ?? Date.now() };
  const sig = (await sign(announceSigningBytes(stamped))).toString('base64');
  return { ...stamped, sig };
}

/** Default freshness window for announce frames (±5 min, clock-skew tolerant). */
export const DEFAULT_ANNOUNCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Verify an announce frame's `sig` against its `device_pubkey` (raw-32-byte
 * base64 → SPKI rebuild → nodeVerify) over `announceSigningBytes(frame)`.
 * Also checks that `frame.ts` is a number within `opts.windowMs` of
 * `opts.nowMs` (defaults: `Date.now()` and `DEFAULT_ANNOUNCE_WINDOW_MS`).
 * Returns false on any tamper, stale/future ts, bad shape, or malformed
 * input — never throws.
 *
 * D-007: the `ts` (and optional `nonce`) are covered by the signature, so
 * tampering either field breaks sig verification independently of the
 * freshness check.
 */
export function verifyAnnounce(
  frame: SignedAnnounce,
  opts?: { nowMs?: number; windowMs?: number },
): boolean {
  try {
    if (!frame || typeof frame !== 'object') return false;
    if (
      typeof frame.device_pubkey !== 'string' ||
      typeof frame.github_user_id !== 'number' ||
      typeof frame.github_login !== 'string' ||
      typeof frame.attestation_gist_id !== 'string' ||
      typeof frame.log_core_key !== 'string' ||
      typeof frame.sig !== 'string'
    ) {
      return false;
    }

    // D-007 freshness check: ts must be present and within the window.
    if (typeof frame.ts !== 'number') return false;
    const nowMs = opts?.nowMs ?? Date.now();
    const windowMs = opts?.windowMs ?? DEFAULT_ANNOUNCE_WINDOW_MS;
    if (Math.abs(nowMs - frame.ts) > windowMs) return false;

    const rawPubkey = Buffer.from(frame.device_pubkey, 'base64');
    if (rawPubkey.length !== 32) return false;

    const spkiDer = Buffer.concat([SPKI_PREFIX, rawPubkey]);
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

    const bytes = announceSigningBytes(frame);
    const sig = Buffer.from(frame.sig, 'base64');
    return nodeVerify(null, bytes, publicKey, sig);
  } catch {
    return false;
  }
}
