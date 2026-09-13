import { describe, expect, it } from 'vitest';
import {
  auditArchiveIntegrityAvailable,
  auditArchiveIntegrityViolations,
  observeAuditArchiveIntegrity,
} from './audit-archive-integrity';

const enabled = auditArchiveIntegrityAvailable();
const describeLive = enabled ? describe : describe.skip;

describeLive('macOS audit archive relocation (live host)', () => {
  it('preserves the public path and verified image on the backup filesystem', () => {
    expect(auditArchiveIntegrityViolations(observeAuditArchiveIntegrity())).toEqual([]);
  });

  it('rejects a wrong destination, stale checksum, and invalid integrity proof (negative controls)', () => {
    const observed = observeAuditArchiveIntegrity();

    expect(
      auditArchiveIntegrityViolations({
        ...observed,
        resolvedDirectory: '/mnt/backup/offload/not-the-audit-archive',
      }),
    ).toContain('wrong-symlink-target');
    expect(auditArchiveIntegrityViolations({ ...observed, checksumDigest: '0'.repeat(64) })).toContain(
      'checksum-mismatch',
    );
    expect(
      auditArchiveIntegrityViolations({ ...observed, provenanceQemuAttestation: 'not checked' }),
    ).toContain('provenance-qemu-integrity-unverified');
    expect(auditArchiveIntegrityViolations({ ...observed, imageCtimeMs: 0 })).toContain(
      'image-ctime-mismatch',
    );
  });
});
