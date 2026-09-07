import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC_DIR = '/mnt/data/papercusp-audit-inputs';
const DESTINATION_DIR = '/mnt/backup/offload/papercusp-audit-inputs';
const IMAGE_BASENAME = 'mac-post-tahoe26.6.1-builddata-workspace-20260813.qcow2';
const EXPECTED_DIGEST = '6c0b30e8066892f2fc077c018018d2e59e8feb39ac5d603b0812914bc1835d9f';
const EXPECTED_IMAGE_SIZE = 283_821_408_256;
const EXPECTED_MTIME_MS = 1_786_662_480_716.52;

const enabled = existsSync(PUBLIC_DIR) && existsSync(DESTINATION_DIR);
const describeLive = enabled ? describe : describe.skip;

interface RelocationObservation {
  digest: string;
  imageSize: number;
  imageMtimeMs: number;
  imageMode: number;
  publicIsSymlink: boolean;
  resolvedDirectory: string;
  publicImageIdentity: string;
  destinationImageIdentity: string;
  qemuCheckErrors: number;
}

function imageIdentity(path: string): string {
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}`;
}

function observeRelocation(): RelocationObservation {
  const publicImage = join(PUBLIC_DIR, IMAGE_BASENAME);
  const destinationImage = join(DESTINATION_DIR, IMAGE_BASENAME);
  const checksum = readFileSync(`${publicImage}.sha256`, 'utf8').trim().split(/\s+/, 1)[0] ?? '';
  const image = statSync(publicImage);
  const qemu = JSON.parse(
    execFileSync('qemu-img', ['check', '--output=json', publicImage], {
      encoding: 'utf8',
      timeout: 60_000,
    }),
  ) as { 'check-errors'?: number };

  return {
    digest: checksum,
    imageSize: image.size,
    imageMtimeMs: image.mtimeMs,
    imageMode: image.mode & 0o777,
    publicIsSymlink: lstatSync(PUBLIC_DIR).isSymbolicLink(),
    resolvedDirectory: realpathSync(PUBLIC_DIR),
    publicImageIdentity: imageIdentity(publicImage),
    destinationImageIdentity: imageIdentity(destinationImage),
    qemuCheckErrors: qemu['check-errors'] ?? -1,
  };
}

function relocationViolations(observation: RelocationObservation): string[] {
  const violations: string[] = [];
  if (!observation.publicIsSymlink) violations.push('public-path-not-symlink');
  if (observation.resolvedDirectory !== DESTINATION_DIR) violations.push('wrong-symlink-target');
  if (observation.publicImageIdentity !== observation.destinationImageIdentity) {
    violations.push('read-through-does-not-reach-destination');
  }
  if (observation.digest !== EXPECTED_DIGEST) violations.push('checksum-mismatch');
  if (observation.imageSize !== EXPECTED_IMAGE_SIZE) violations.push('image-size-mismatch');
  if (observation.imageMode !== 0o444) violations.push('image-mode-mismatch');
  if (Math.abs(observation.imageMtimeMs - EXPECTED_MTIME_MS) >= 1) violations.push('image-mtime-mismatch');
  if (observation.qemuCheckErrors !== 0) violations.push('qemu-integrity-errors');
  return violations;
}

describeLive('macOS audit archive relocation (live host)', () => {
  it('preserves the public path and verified image on the backup filesystem', () => {
    expect(relocationViolations(observeRelocation())).toEqual([]);
  });

  it('rejects a wrong destination and a stale checksum (negative controls)', () => {
    const observed = observeRelocation();

    expect(
      relocationViolations({
        ...observed,
        resolvedDirectory: '/mnt/backup/offload/not-the-audit-archive',
      }),
    ).toContain('wrong-symlink-target');
    expect(relocationViolations({ ...observed, digest: '0'.repeat(64) })).toContain('checksum-mismatch');
  });
});
