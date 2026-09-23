import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statfsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditArchiveIntegrityAvailable,
  auditArchiveIntegrityViolations,
  observeAuditArchiveIntegrity,
  type AuditArchiveIntegrityObservation,
} from './audit-archive-integrity';

const VM_UNIT = 'papercusp-vm-mac.service';
const VM_PUBLIC_DIR = join(homedir(), 'macos-vm/OSX-KVM');
const VM_DESTINATION_DIR = '/mnt/backup/offload/macos-vm/OSX-KVM';
const EXPECTED_OPEN_VM_FILES = [
  join(VM_DESTINATION_DIR, 'mac_hdd_ng.img'),
  join(VM_DESTINATION_DIR, 'builddata-20260820-160g.qcow2'),
  join(VM_DESTINATION_DIR, 'OpenCore/OpenCore.qcow2'),
];

interface FinalReconciliationObservation {
  availableBytes: Record<'root' | 'data' | 'backup', bigint>;
  vmPublicIsSymlink: boolean;
  vmResolvedDirectory: string;
  auditArchive: AuditArchiveIntegrityObservation;
  service: Record<string, string>;
  vmProcessCwd: string;
  vmOpenFiles: string[];
}

function availableBytes(path: string): bigint {
  const fs = statfsSync(path, { bigint: true });
  return fs.bavail * fs.bsize;
}

function readSystemdProperties(): Record<string, string> {
  const output = execFileSync(
    'systemctl',
    [
      '--user',
      'show',
      VM_UNIT,
      '--property=ActiveState',
      '--property=SubState',
      '--property=MainPID',
      '--property=NRestarts',
      '--property=Result',
      '--property=ExecMainCode',
      '--property=ExecMainStatus',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );

  return Object.fromEntries(
    output
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function canonicalOpenFiles(pid: number): string[] {
  const fdDirectory = `/proc/${pid}/fd`;
  return readdirSync(fdDirectory)
    .flatMap((fd) => {
      try {
        const target = readlinkSync(join(fdDirectory, fd)).replace(/ \(deleted\)$/, '');
        if (!target.startsWith('/') || !existsSync(target)) return [];
        return [realpathSync(target)];
      } catch {
        return [];
      }
    })
    .sort();
}

function observeFinalReconciliation(): FinalReconciliationObservation {
  const service = readSystemdProperties();
  const mainPid = Number(service.MainPID ?? '0');

  return {
    availableBytes: {
      root: availableBytes('/'),
      data: availableBytes('/mnt/data'),
      backup: availableBytes('/mnt/backup'),
    },
    vmPublicIsSymlink: lstatSync(VM_PUBLIC_DIR).isSymbolicLink(),
    vmResolvedDirectory: realpathSync(VM_PUBLIC_DIR),
    auditArchive: observeAuditArchiveIntegrity(),
    service,
    vmProcessCwd: mainPid > 0 ? realpathSync(`/proc/${mainPid}/cwd`) : '',
    vmOpenFiles: mainPid > 0 ? canonicalOpenFiles(mainPid) : [],
  };
}

function finalReconciliationViolations(observation: FinalReconciliationObservation): string[] {
  const violations: string[] = [];
  for (const [filesystem, bytes] of Object.entries(observation.availableBytes)) {
    if (bytes <= 0n) violations.push(`${filesystem}-has-no-available-bytes`);
  }
  if (!observation.vmPublicIsSymlink) violations.push('vm-public-path-not-symlink');
  if (observation.vmResolvedDirectory !== VM_DESTINATION_DIR) violations.push('vm-wrong-symlink-target');
  for (const violation of auditArchiveIntegrityViolations(observation.auditArchive)) {
    violations.push(`audit-${violation}`);
  }
  if (observation.service.ActiveState !== 'active') violations.push('vm-unit-not-active');
  if (observation.service.SubState !== 'running') violations.push('vm-unit-not-running');
  if (observation.service.Result !== 'success') violations.push('vm-unit-result-not-success');
  if (Number(observation.service.MainPID ?? '0') <= 0) violations.push('vm-unit-has-no-main-pid');
  if (observation.vmProcessCwd !== VM_DESTINATION_DIR) violations.push('vm-process-cwd-not-on-backup');
  for (const expected of EXPECTED_OPEN_VM_FILES) {
    if (!observation.vmOpenFiles.includes(expected)) violations.push(`vm-file-not-open:${expected}`);
  }
  return violations;
}

const enabled =
  existsSync(VM_PUBLIC_DIR) &&
  existsSync(VM_DESTINATION_DIR) &&
  auditArchiveIntegrityAvailable();
const describeLive = enabled ? describe : describe.skip;

describeLive('final disk-space recovery reconciliation (live host)', () => {
  it('keeps both relocations healthy and the macOS VM running from backup storage', () => {
    expect(finalReconciliationViolations(observeFinalReconciliation())).toEqual([]);
  });

  it('does not treat a historical systemd restart count as current relocation damage', () => {
    // NRestarts is cumulative for this unit invocation. This test observes the
    // final state; it does not execute the relocation or own a before/after
    // restart baseline, so a deliberate maintenance restart days later cannot
    // be attributed to the storage recovery here.
    const observed = observeFinalReconciliation();
    const historicalRestart = {
      ...observed,
      service: { ...observed.service, NRestarts: '1' },
    };

    expect(finalReconciliationViolations(historicalRestart)).not.toContain('vm-unit-restarted');
  });

  it('rejects degraded filesystem, relocation, integrity, process, and service observations', () => {
    const observed = observeFinalReconciliation();
    const degraded = {
      ...observed,
      availableBytes: { ...observed.availableBytes, backup: 0n },
      vmResolvedDirectory: '/mnt/backup/offload/not-the-macos-vm',
      auditArchive: {
        ...observed.auditArchive,
        resolvedDirectory: '/mnt/backup/offload/not-the-audit-archive',
        checksumDigest: '0'.repeat(64),
        destinationImageIdentity: '0:0',
        provenanceReceiptSha256: '0'.repeat(64),
        qemuDirtyFlag: true,
      },
      service: { ...observed.service, ActiveState: 'inactive', NRestarts: '1' },
      vmProcessCwd: '/tmp',
      vmOpenFiles: [],
    };

    expect(finalReconciliationViolations(degraded)).toEqual(
      expect.arrayContaining([
        'backup-has-no-available-bytes',
        'vm-wrong-symlink-target',
        'audit-wrong-symlink-target',
        'audit-checksum-mismatch',
        'audit-read-through-does-not-reach-destination',
        'audit-provenance-receipt-mismatch',
        'audit-qemu-image-dirty',
        'vm-unit-not-active',
        'vm-process-cwd-not-on-backup',
        ...EXPECTED_OPEN_VM_FILES.map((path) => `vm-file-not-open:${path}`),
      ]),
    );
  });
});
