import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const VM_UNIT = 'papercusp-vm-mac.service';
const VM_PUBLIC_DIR = join(homedir(), 'macos-vm/OSX-KVM');
const VM_DESTINATION_DIR = '/mnt/backup/offload/macos-vm/OSX-KVM';
const AUDIT_PUBLIC_DIR = '/mnt/data/papercusp-audit-inputs';
const AUDIT_DESTINATION_DIR = '/mnt/backup/offload/papercusp-audit-inputs';
const AUDIT_IMAGE_BASENAME = 'mac-post-tahoe26.6.1-builddata-workspace-20260813.qcow2';
const AUDIT_EXPECTED_DIGEST = '6c0b30e8066892f2fc077c018018d2e59e8feb39ac5d603b0812914bc1835d9f';
const EXPECTED_OPEN_VM_FILES = [
  join(VM_DESTINATION_DIR, 'mac_hdd_ng.img'),
  join(VM_DESTINATION_DIR, 'builddata-20260820-160g.qcow2'),
  join(VM_DESTINATION_DIR, 'OpenCore/OpenCore.qcow2'),
];

interface FinalReconciliationObservation {
  availableBytes: Record<'root' | 'data' | 'backup', bigint>;
  vmPublicIsSymlink: boolean;
  vmResolvedDirectory: string;
  auditPublicIsSymlink: boolean;
  auditResolvedDirectory: string;
  auditDigest: string;
  auditPublicImageIdentity: string;
  auditDestinationImageIdentity: string;
  auditProvenanceBytes: number;
  auditQemuCheckErrors: number;
  service: Record<string, string>;
  vmProcessCwd: string;
  vmOpenFiles: string[];
}

function availableBytes(path: string): bigint {
  const fs = statfsSync(path, { bigint: true });
  return fs.bavail * fs.bsize;
}

function fileIdentity(path: string): string {
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}`;
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
  const auditPublicImage = join(AUDIT_PUBLIC_DIR, AUDIT_IMAGE_BASENAME);
  const auditDestinationImage = join(AUDIT_DESTINATION_DIR, AUDIT_IMAGE_BASENAME);
  const auditChecksum = readFileSync(`${auditPublicImage}.sha256`, 'utf8').trim().split(/\s+/, 1)[0] ?? '';
  const auditProvenance = JSON.parse(
    readFileSync(join(AUDIT_PUBLIC_DIR, AUDIT_IMAGE_BASENAME.replace(/\.qcow2$/, '.provenance.json')), 'utf8'),
  ) as unknown;
  const auditQemu = JSON.parse(
    execFileSync('qemu-img', ['check', '--output=json', auditPublicImage], {
      encoding: 'utf8',
      timeout: 60_000,
    }),
  ) as { 'check-errors'?: number };
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
    auditPublicIsSymlink: lstatSync(AUDIT_PUBLIC_DIR).isSymbolicLink(),
    auditResolvedDirectory: realpathSync(AUDIT_PUBLIC_DIR),
    auditDigest: auditChecksum,
    auditPublicImageIdentity: fileIdentity(auditPublicImage),
    auditDestinationImageIdentity: fileIdentity(auditDestinationImage),
    auditProvenanceBytes: Buffer.byteLength(JSON.stringify(auditProvenance)),
    auditQemuCheckErrors: auditQemu['check-errors'] ?? -1,
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
  if (!observation.auditPublicIsSymlink) violations.push('audit-public-path-not-symlink');
  if (observation.auditResolvedDirectory !== AUDIT_DESTINATION_DIR) {
    violations.push('audit-wrong-symlink-target');
  }
  if (observation.auditDigest !== AUDIT_EXPECTED_DIGEST) violations.push('audit-checksum-mismatch');
  if (observation.auditPublicImageIdentity !== observation.auditDestinationImageIdentity) {
    violations.push('audit-read-through-does-not-reach-destination');
  }
  if (observation.auditProvenanceBytes <= 0) violations.push('audit-provenance-empty');
  if (observation.auditQemuCheckErrors !== 0) violations.push('audit-qemu-integrity-errors');
  if (observation.service.ActiveState !== 'active') violations.push('vm-unit-not-active');
  if (observation.service.SubState !== 'running') violations.push('vm-unit-not-running');
  if (observation.service.Result !== 'success') violations.push('vm-unit-result-not-success');
  if (observation.service.NRestarts !== '0') violations.push('vm-unit-restarted');
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
  existsSync(AUDIT_PUBLIC_DIR) &&
  existsSync(AUDIT_DESTINATION_DIR);
const describeLive = enabled ? describe : describe.skip;

describeLive('final disk-space recovery reconciliation (live host)', () => {
  it('keeps both relocations healthy and the macOS VM running from backup storage', () => {
    expect(finalReconciliationViolations(observeFinalReconciliation())).toEqual([]);
  });

  it('rejects degraded filesystem, relocation, integrity, process, and service observations', () => {
    const observed = observeFinalReconciliation();
    const degraded = {
      ...observed,
      availableBytes: { ...observed.availableBytes, backup: 0n },
      vmResolvedDirectory: '/mnt/backup/offload/not-the-macos-vm',
      auditResolvedDirectory: '/mnt/backup/offload/not-the-audit-archive',
      auditDigest: '0'.repeat(64),
      auditDestinationImageIdentity: '0:0',
      auditProvenanceBytes: 0,
      auditQemuCheckErrors: 1,
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
        'audit-provenance-empty',
        'audit-qemu-integrity-errors',
        'vm-unit-not-active',
        'vm-unit-restarted',
        'vm-process-cwd-not-on-backup',
        ...EXPECTED_OPEN_VM_FILES.map((path) => `vm-file-not-open:${path}`),
      ]),
    );
  });
});
