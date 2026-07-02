/**
 * hive-git/sigrefs.ts — device-signed ref snapshots (Phase 7 G-4/G-4b,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-028, P-039; D-010/D-011).
 *
 * The Radicle `refs/rad/sigrefs` model, adapted. A device periodically signs a
 * canonical snapshot of ITS OWN namespace's ref-set (each ref name → the sha it
 * points at) and stores it as a git BLOB referenced at `refs/rad/sigrefs` INSIDE
 * that namespace (`refs/namespaces/<devHex>/refs/rad/sigrefs`). Because it lives
 * under the namespace, G-2's `refs/namespaces/<devHex>/*` fetch carries it along
 * with the heads.
 *
 * WHY (the transitive-relay tamper hole): a receiver may fetch device B's
 * namespace THROUGH a relay peer C (C mirrored B, A fetches from C). C could
 * advance B's namespace heads to shas B never published. The sigrefs blob is
 * signed by B's device key over the exact (ref → sha) set, so A verifies B
 * actually published those heads before trusting them — C can relay but cannot
 * forge. Membership already device-gates WHO can be in the hive; sigrefs gates
 * WHAT a fetched namespace's heads are, independent of the relay path.
 *
 * G-4b (rollback / TUF class): the snapshot carries a monotonic `version`. A
 * receiver rejects a fetched sigrefs whose version is ≤ the one it already
 * accepted for that device — so a relay cannot roll a namespace back to a stale
 * (but validly-signed) earlier state. The watermark is simply the version of the
 * sigrefs CURRENTLY stored in the local mirror for that device (no side table):
 * accept iff `incoming.version > stored.version`.
 *
 * Pure over storage.ts's RunGit seam + ed25519.ts's key helpers, so the whole
 * module unit-tests against a real temp bare repo with an injected signer.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEd25519 } from '../../identity/ed25519';
import {
  type RunGit,
  defaultRunGit,
  deviceNamespaceKey,
  listNamespaceRefs,
  readNamespaceRef,
  writeNamespaceRef,
} from './storage';

/** The within-namespace ref that holds the signed snapshot blob. */
export const SIGREFS_REF = 'refs/rad/sigrefs';

/** Sigrefs schema version (the wire shape, distinct from the monotonic
 *  per-device `version` counter used for rollback protection). */
export const SIGREFS_SCHEMA_VERSION = 1;

/** One (ref → sha) entry of a device's namespace snapshot. */
export interface SigrefEntry {
  /** A within-namespace ref, e.g. `refs/heads/work` (NEVER the sigrefs ref). */
  ref: string;
  sha: string;
}

/** The signed payload — canonical over a fixed field order + sorted refs. */
export interface SigrefsPayload {
  /** Wire schema version. */
  v: number;
  /** The signing device's raw-32 Ed25519 pubkey (base64) — bound into the sig. */
  device_pubkey: string;
  /** Monotonic per-device counter (G-4b rollback watermark). */
  version: number;
  /** Snapshot time (epoch ms) — audit/freshness. */
  ts: number;
  /** The device's ref-set, sorted by ref name (excludes the sigrefs ref). */
  refs: SigrefEntry[];
}

export interface SignedSigrefs extends SigrefsPayload {
  /** base64 Ed25519 signature over sigrefsSigningBytes(payload). */
  sig: string;
}

/**
 * Canonical signing bytes: fixed field order + refs pre-sorted by name (the
 * hive-announce idiom). Deterministic for a given ref-set, so both ends compute
 * identical bytes. `sig` is excluded (it signs everything else).
 */
export function sigrefsSigningBytes(payload: SigrefsPayload): Buffer {
  const ordered = {
    v: payload.v,
    device_pubkey: payload.device_pubkey,
    version: payload.version,
    ts: payload.ts,
    refs: [...payload.refs]
      .sort((a, b) => a.ref.localeCompare(b.ref))
      .map((r) => ({ ref: r.ref, sha: r.sha })),
  };
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/** hash-object a UTF-8 blob into `repoPath`'s ODB (via a temp file, so the
 *  stdin-free RunGit seam still works) → the blob sha. */
async function hashBlob(repoPath: string, content: string, runGit: RunGit): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sigrefs-'));
  try {
    const f = join(dir, 'blob');
    await writeFile(f, content, 'utf8');
    const r = await runGit(['hash-object', '-w', '-t', 'blob', f], repoPath);
    if (r.code !== 0) throw new Error(`sigrefs: hash-object failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Read + parse the sigrefs blob currently stored for a device in `repoPath`
 * (null if none, or if it's malformed). Used both to read a peer's fetched
 * sigrefs and to compute the local rollback watermark.
 */
export async function readSigrefs(
  repoPath: string,
  devicePubkeyBase64: string,
  runGit: RunGit = defaultRunGit,
): Promise<SignedSigrefs | null> {
  const blobSha = await readNamespaceRef(repoPath, devicePubkeyBase64, SIGREFS_REF, runGit);
  if (!blobSha) return null;
  const r = await runGit(['cat-file', 'blob', blobSha], repoPath);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as SignedSigrefs;
    if (!isSignedSigrefs(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSignedSigrefs(x: unknown): x is SignedSigrefs {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.v === 'number' &&
    typeof s.device_pubkey === 'string' &&
    typeof s.version === 'number' &&
    Number.isFinite(s.version) &&
    typeof s.ts === 'number' &&
    Array.isArray(s.refs) &&
    s.refs.every(
      (e) =>
        e && typeof e === 'object' && typeof (e as SigrefEntry).ref === 'string' && typeof (e as SigrefEntry).sha === 'string',
    ) &&
    typeof s.sig === 'string'
  );
}

/**
 * Build + STORE this device's sigrefs snapshot: read its namespace ref-set
 * (excluding the sigrefs ref itself), sign it, write the blob, point
 * `refs/rad/sigrefs` at it. `version` auto-increments off the currently-stored
 * snapshot unless overridden. Returns the signed snapshot. `sign` is the device
 * signer seam (prod: `bytes => signWithDeviceKey(keychainId, bytes)`).
 */
export async function buildSigrefs(
  repoPath: string,
  devicePubkeyBase64: string,
  sign: (bytes: Buffer) => Promise<Buffer>,
  opts: { nowMs: number; version?: number; runGit?: RunGit } = { nowMs: 0 },
): Promise<SignedSigrefs> {
  const runGit = opts.runGit ?? defaultRunGit;
  const all = await listNamespaceRefs(repoPath, devicePubkeyBase64, runGit);
  const refs: SigrefEntry[] = all
    .filter((r) => r.ref !== SIGREFS_REF)
    .map((r) => ({ ref: r.ref, sha: r.sha }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
  let version = opts.version;
  if (version === undefined) {
    const prior = await readSigrefs(repoPath, devicePubkeyBase64, runGit);
    version = (prior?.version ?? 0) + 1;
  }
  const payload: SigrefsPayload = {
    v: SIGREFS_SCHEMA_VERSION,
    device_pubkey: devicePubkeyBase64,
    version,
    ts: opts.nowMs,
    refs,
  };
  const sig = (await sign(sigrefsSigningBytes(payload))).toString('base64');
  const signed: SignedSigrefs = { ...payload, sig };
  const blobSha = await hashBlob(repoPath, JSON.stringify(signed), runGit);
  // The sigrefs ref points at the blob (a ref may reference any object type).
  await writeNamespaceRef(repoPath, devicePubkeyBase64, SIGREFS_REF, blobSha, runGit);
  return signed;
}

/**
 * Verify a signed sigrefs blob: the embedded device_pubkey must equal the
 * EXPECTED device, and the signature must validate over the canonical bytes.
 * Never throws.
 */
export function verifySigrefs(signed: SignedSigrefs, expectedDevicePubkeyBase64: string): boolean {
  if (!isSignedSigrefs(signed)) return false;
  if (signed.device_pubkey !== expectedDevicePubkeyBase64) return false;
  try {
    const bytes = sigrefsSigningBytes(signed);
    return verifyEd25519(bytes, expectedDevicePubkeyBase64, Buffer.from(signed.sig, 'base64'));
  } catch {
    return false;
  }
}

export type SigrefsAcceptance =
  | { ok: true }
  | { ok: false; reason: 'bad-signature' | 'wrong-device' | 'rollback' | 'malformed' };

/**
 * Decide whether to ACCEPT a fetched sigrefs for `expectedDevice`, given the
 * version already accepted (`priorVersion`, from readSigrefs on the local mirror
 * — null if none). Combines the signature/device check (G-4) with the monotonic
 * rollback guard (G-4b): the incoming version must strictly exceed the prior.
 * Pure — the caller persists acceptance by storing the new blob.
 */
export function acceptFetchedSigrefs(
  signed: SignedSigrefs,
  expectedDevicePubkeyBase64: string,
  priorVersion: number | null,
): SigrefsAcceptance {
  if (!isSignedSigrefs(signed)) return { ok: false, reason: 'malformed' };
  if (signed.device_pubkey !== expectedDevicePubkeyBase64) return { ok: false, reason: 'wrong-device' };
  if (!verifySigrefs(signed, expectedDevicePubkeyBase64)) return { ok: false, reason: 'bad-signature' };
  if (priorVersion !== null && signed.version <= priorVersion) return { ok: false, reason: 'rollback' };
  return { ok: true };
}

/**
 * Cross-check a fetched namespace's ACTUAL heads (post-fetch) against the shas a
 * verified sigrefs claims. Returns the refs whose fetched sha does NOT match the
 * signed snapshot (an empty array ⇒ every head is exactly what the device
 * signed). The integrator (G-5) trusts only refs that match. Excludes the
 * sigrefs ref itself.
 */
export async function reconcileFetchedHeads(
  repoPath: string,
  devicePubkeyBase64: string,
  signed: SignedSigrefs,
  runGit: RunGit = defaultRunGit,
): Promise<{ ref: string; expected: string; actual: string | null }[]> {
  const signedByRef = new Map(signed.refs.map((r) => [r.ref, r.sha]));
  const actual = await listNamespaceRefs(repoPath, devicePubkeyBase64, runGit);
  const actualByRef = new Map(actual.filter((r) => r.ref !== SIGREFS_REF).map((r) => [r.ref, r.sha]));
  const mismatches: { ref: string; expected: string; actual: string | null }[] = [];
  // A ref the device signed but that is missing/wrong locally, OR a local ref
  // the signature does NOT cover (a relay-injected extra) — both are mismatches.
  for (const [ref, expected] of signedByRef) {
    const got = actualByRef.get(ref) ?? null;
    if (got !== expected) mismatches.push({ ref, expected, actual: got });
  }
  for (const [ref, got] of actualByRef) {
    if (!signedByRef.has(ref)) mismatches.push({ ref, expected: '(unsigned)', actual: got });
  }
  return mismatches;
}

/** The namespace key (hex) for a device — re-exported convenience so callers
 *  don't reach into storage just for the mapping. */
export function sigrefsNamespaceHex(devicePubkeyBase64: string): string {
  return deviceNamespaceKey(devicePubkeyBase64);
}
