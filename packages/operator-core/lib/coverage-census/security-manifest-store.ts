/** P-001 snapshots reuse canonical text artifacts with immutable content addresses.
 * No new table, routine, public tool or parallel evidence store. Stored snapshots
 * grant no approval or execution authority: host commitment is a separate gate.
 */
import { loadImmutableTextArtifact, saveImmutableTextArtifact } from '../text-artifacts';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalJson } from '@papercusp/hash-chain';
import { advanceSecuritySourceProgress, type SecuritySourceProgress, type SecuritySourceShard } from './security-source-census';
import {
  createSecurityManifest, createSecurityTupleLedger,
  type SecurityManifest, type SecuritySnapshot, type SecurityTupleLedger,
} from './security-manifest';

function exact<T>(claimed: SecuritySnapshot<T>, rebuilt: SecuritySnapshot<T>): void {
  if (claimed.sha256 !== rebuilt.sha256 || claimed.bytes !== rebuilt.bytes) throw new Error('security_snapshot_identity_mismatch');
}

export async function saveSecurityManifest(harness: string, manifest: SecuritySnapshot<SecurityManifest>) {
  exact(manifest, createSecurityManifest(manifest.body));
  return saveImmutableTextArtifact(harness, manifest.bytes);
}
export async function loadSecurityManifest(harness: string, sha256: string): Promise<SecuritySnapshot<SecurityManifest> | null> {
  const bytes = await loadImmutableTextArtifact(harness, sha256);
  if (bytes === null) return null;
  const rebuilt = createSecurityManifest(JSON.parse(bytes) as SecurityManifest);
  if (rebuilt.bytes !== bytes || rebuilt.sha256 !== sha256) throw new Error('security_snapshot_identity_mismatch');
  return rebuilt;
}
export async function saveSecurityTupleLedger(harness: string, ledger: SecuritySnapshot<SecurityTupleLedger>) {
  const manifest = await loadSecurityManifest(harness, ledger.body.manifestSha256);
  if (!manifest) throw new Error('security_ledger_manifest_missing');
  const rebuilt = createSecurityTupleLedger({ manifest, producer: ledger.body.producer,
    tuples: ledger.body.rows.map(row => row.tuple), dispositions: ledger.body.rows.map(row => row.disposition) });
  exact(ledger, rebuilt);
  return saveImmutableTextArtifact(harness, ledger.bytes);
}
export async function loadSecurityTupleLedger(harness: string, sha256: string): Promise<SecuritySnapshot<SecurityTupleLedger> | null> {
  const bytes = await loadImmutableTextArtifact(harness, sha256);
  if (bytes === null) return null;
  const body = JSON.parse(bytes) as SecurityTupleLedger;
  const manifest = await loadSecurityManifest(harness, body.manifestSha256);
  if (!manifest) throw new Error('security_ledger_manifest_missing');
  const rebuilt = createSecurityTupleLedger({ manifest, producer: body.producer,
    tuples: body.rows.map(row => row.tuple), dispositions: body.rows.map(row => row.disposition) });
  if (rebuilt.bytes !== bytes || rebuilt.sha256 !== sha256) throw new Error('security_snapshot_identity_mismatch');
  return rebuilt;
}

/** Persist the exact discovery before advancing its queue. Both objects reuse
 * immutable artifacts; an interrupted save leaves the prior queue usable. */
export async function saveSecuritySourceShard(harness: string, progress: SecuritySourceProgress, shard: SecuritySourceShard) {
  const raw = canonicalJson(shard.discovery);
  const rawSha256 = createHash('sha256').update(raw).digest('hex');
  const envelope = canonicalJson({ schema: 'security-source-discovery-archive-v1', encoding: 'gzip+base64',
    parentArchive: progress.parentArchive, progressSha256: shard.progressSha256,
    rawSha256, rawBytes: Buffer.byteLength(raw), data: gzipSync(raw).toString('base64') });
  const sha256 = createHash('sha256').update(envelope).digest('hex');
  const receipt = { sha256, censusFingerprint: shard.discovery.fingerprint,
    parentArchive: progress.parentArchive, rawSha256, rawBytes: Buffer.byteLength(raw),
    files: shard.discovery.inventory.files.length, sites: shard.discovery.sites.length,
    gaps: shard.discovery.inventory.unresolved.length, closureAccepted: false, executionAdmitted: false };
  // Refuse stale or substituted input before writing either object.
  const next = advanceSecuritySourceProgress(progress, shard, receipt);
  const archive = await saveImmutableTextArtifact(harness, envelope);
  const stored = await loadImmutableTextArtifact(harness, archive.sha256);
  if (stored !== envelope) throw new Error('security_source_archive_readback_mismatch');
  const decoded = gunzipSync(Buffer.from(JSON.parse(stored).data, 'base64'), { maxOutputLength: receipt.rawBytes });
  if (decoded.length !== receipt.rawBytes || createHash('sha256').update(decoded).digest('hex') !== rawSha256
    || decoded.toString('utf8') !== raw) throw new Error('security_source_archive_decode_mismatch');
  const progressBytes = canonicalJson(next);
  const progressArchive = await saveImmutableTextArtifact(harness, progressBytes);
  if (await loadImmutableTextArtifact(harness, progressArchive.sha256) !== progressBytes) {
    throw new Error('security_source_progress_readback_mismatch');
  }
  return { archive, progressArchive, progress: next, receipt: { ...receipt, readbackVerified: true, decodedVerified: true } };
}
