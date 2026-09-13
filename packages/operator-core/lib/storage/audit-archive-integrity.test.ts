import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ARCHIVE_DESTINATION_DIR,
  AUDIT_ARCHIVE_EXPECTED_CHECKSUM_RECEIPT_SHA256,
  AUDIT_ARCHIVE_EXPECTED_CTIME_MS,
  AUDIT_ARCHIVE_EXPECTED_DIGEST,
  AUDIT_ARCHIVE_EXPECTED_IMAGE_IDENTITY,
  AUDIT_ARCHIVE_EXPECTED_IMAGE_SIZE,
  AUDIT_ARCHIVE_EXPECTED_MTIME_MS,
  AUDIT_ARCHIVE_EXPECTED_PROVENANCE_RECEIPT_SHA256,
  AUDIT_ARCHIVE_EXPECTED_VIRTUAL_SIZE,
  AUDIT_ARCHIVE_IMAGE_BASENAME,
  AUDIT_ARCHIVE_PUBLIC_DIR,
  auditArchiveIntegrityViolations,
  type AuditArchiveIntegrityObservation,
} from './audit-archive-integrity';

function healthyObservation(): AuditArchiveIntegrityObservation {
  return {
    publicIsSymlink: true,
    resolvedDirectory: AUDIT_ARCHIVE_DESTINATION_DIR,
    publicImageIdentity: AUDIT_ARCHIVE_EXPECTED_IMAGE_IDENTITY,
    destinationImageIdentity: AUDIT_ARCHIVE_EXPECTED_IMAGE_IDENTITY,
    imageSize: AUDIT_ARCHIVE_EXPECTED_IMAGE_SIZE,
    imageMtimeMs: AUDIT_ARCHIVE_EXPECTED_MTIME_MS,
    imageCtimeMs: AUDIT_ARCHIVE_EXPECTED_CTIME_MS,
    imageMode: 0o444,
    checksumDigest: AUDIT_ARCHIVE_EXPECTED_DIGEST,
    checksumReceiptSha256: AUDIT_ARCHIVE_EXPECTED_CHECKSUM_RECEIPT_SHA256,
    provenanceReceiptSha256: AUDIT_ARCHIVE_EXPECTED_PROVENANCE_RECEIPT_SHA256,
    provenanceSchema: 'papercusp-mac-audit-baseline-v1',
    provenanceImagePath: join(AUDIT_ARCHIVE_PUBLIC_DIR, AUDIT_ARCHIVE_IMAGE_BASENAME),
    provenanceImageSize: AUDIT_ARCHIVE_EXPECTED_IMAGE_SIZE,
    provenanceDigest: AUDIT_ARCHIVE_EXPECTED_DIGEST,
    provenanceMode: '0444',
    provenanceFormat: 'qcow2',
    provenanceVirtualSize: AUDIT_ARCHIVE_EXPECTED_VIRTUAL_SIZE,
    provenanceDirtyFlag: false,
    provenanceQemuAttestation: 'No errors were found on the image.',
    provenanceSourceDigest: AUDIT_ARCHIVE_EXPECTED_DIGEST,
    qemuFormat: 'qcow2',
    qemuVirtualSize: AUDIT_ARCHIVE_EXPECTED_VIRTUAL_SIZE,
    qemuDirtyFlag: false,
    qemuCorrupt: undefined,
  };
}

describe('auditArchiveIntegrityViolations', () => {
  it('accepts a live image coherently bound to its provenance and SHA receipts', () => {
    expect(auditArchiveIntegrityViolations(healthyObservation())).toEqual([]);
  });

  it('rejects a wrong destination, replacement inode, or stale checksum', () => {
    const healthy = healthyObservation();
    expect(
      auditArchiveIntegrityViolations({
        ...healthy,
        resolvedDirectory: '/mnt/backup/offload/not-the-audit-archive',
        destinationImageIdentity: '0:0',
        checksumDigest: '0'.repeat(64),
      }),
    ).toEqual(
      expect.arrayContaining([
        'wrong-symlink-target',
        'read-through-does-not-reach-destination',
        'checksum-mismatch',
      ]),
    );
  });

  it('rejects forged provenance and a current file whose unforgeable metadata moved', () => {
    const healthy = healthyObservation();
    expect(
      auditArchiveIntegrityViolations({
        ...healthy,
        imageCtimeMs: 0,
        provenanceReceiptSha256: '0'.repeat(64),
        provenanceQemuAttestation: 'not checked',
      }),
    ).toEqual(
      expect.arrayContaining([
        'image-ctime-mismatch',
        'provenance-receipt-mismatch',
        'provenance-qemu-integrity-unverified',
      ]),
    );
  });

  it('rejects a live qemu header that is dirty, corrupt, or the wrong format and size', () => {
    expect(
      auditArchiveIntegrityViolations({
        ...healthyObservation(),
        qemuFormat: 'raw',
        qemuVirtualSize: 1,
        qemuDirtyFlag: true,
        qemuCorrupt: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        'qemu-format-mismatch',
        'qemu-virtual-size-mismatch',
        'qemu-image-dirty',
        'qemu-image-corrupt',
      ]),
    );
  });
});
