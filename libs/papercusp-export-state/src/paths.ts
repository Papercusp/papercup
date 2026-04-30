/**
 * Filesystem layout for snapshot artifacts on the substrate machine.
 *
 *   <projectDir>/.harness/snapshots/<id>.tar.gz       finished tarballs
 *   <projectDir>/.harness/snapshot-staging/           per-capture scratch dir
 */

import { join } from 'node:path';

export function snapshotsDir(projectDir: string): string {
  return join(projectDir, '.harness', 'snapshots');
}

export function snapshotPath(projectDir: string, id: string): string {
  return join(snapshotsDir(projectDir), `${id}.tar.gz`);
}

export function stagingDir(projectDir: string): string {
  return join(projectDir, '.harness', 'snapshot-staging');
}
