/**
 * Filesystem layout for snapshot artifacts on the substrate machine.
 *
 *   <projectDir>/.papercusp/snapshots/<id>.tar.gz       finished tarballs
 *   <projectDir>/.papercusp/snapshot-staging/           per-capture scratch dir
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Active Papercusp root. The substrate moved to per-workspace storage at
 * ~/.papercusp-workspaces/<id>/.papercusp/. Resolver picks the active
 * workspace, falling back to default workspace, then legacy ~/.papercusp/.
 */
export function papercuspRoot(): string {
  if (process.env.PAPERCUSP_HOME) return process.env.PAPERCUSP_HOME;
  const wsIndex = join(homedir(), '.papercusp-workspaces', 'registry.json');
  if (existsSync(wsIndex)) {
    try {
      const parsed = JSON.parse(readFileSync(wsIndex, 'utf8')) as { current?: string };
      if (parsed.current) {
        const cand = join(homedir(), '.papercusp-workspaces', parsed.current, '.papercusp');
        if (existsSync(cand)) return cand;
      }
    } catch { /* fall through */ }
  }
  const def = join(homedir(), '.papercusp-workspaces', 'default', '.papercusp');
  if (existsSync(def)) return def;
  return join(homedir(), '.papercusp');
}

export function papercuspPath(...parts: string[]): string {
  return join(papercuspRoot(), ...parts);
}

export function snapshotsDir(projectDir: string): string {
  return join(projectDir, '.papercusp', 'snapshots');
}

export function snapshotPath(projectDir: string, id: string): string {
  return join(snapshotsDir(projectDir), `${id}.tar.gz`);
}

export function stagingDir(projectDir: string): string {
  return join(projectDir, '.papercusp', 'snapshot-staging');
}
