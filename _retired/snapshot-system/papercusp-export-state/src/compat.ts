/**
 * Snapshot compatibility check (§15.6 step 1) — `papercusp snapshot info <id>`.
 *
 * Reads `manifest.json` (without extracting the rest of the tarball) and
 * compares the snapshot's `minSubstrateVersion` against the running
 * substrate. Refuses on incompatibility before any data is touched.
 *
 * Tarball is read via `tar -tzf` for the listing and `tar -xzf` for just
 * the manifest entry (both system binaries).
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { validateSnapshotManifest, type SnapshotManifest } from './manifest';

export interface CompatReport {
  manifest: SnapshotManifest;
  substrate: { current: string; required: string };
  schema: { current: number; capturedAt: number };
  compatible: boolean;
  reason?: string;
}

export async function readManifestFromTarball(tarPath: string): Promise<SnapshotManifest> {
  // Tar entries inside the snapshot use the staging-dir basename as a prefix
  // (we tar the whole staging dir, not its contents). Find the manifest path
  // by listing first.
  const list = await runStdoutString('tar', ['-tzf', tarPath]);
  const manifestEntry = list
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.endsWith('/manifest.json') || l === 'manifest.json');
  if (!manifestEntry) {
    throw new Error(`tarball ${tarPath} contains no manifest.json`);
  }
  // Pipe just the manifest entry to stdout.
  const json = await runStdoutString('tar', ['-xzOf', tarPath, manifestEntry]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`manifest is not valid JSON: ${(e as Error).message}`);
  }
  validateSnapshotManifest(parsed);
  return parsed;
}

export async function readManifestFromPath(path: string): Promise<SnapshotManifest> {
  if (path.endsWith('manifest.json')) {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    validateSnapshotManifest(parsed);
    return parsed;
  }
  return readManifestFromTarball(path);
}

export function checkCompat(
  manifest: SnapshotManifest,
  substrate: { version: string; schemaVersion: number },
): CompatReport {
  const cmp = compareSemver(substrate.version, manifest.minSubstrateVersion);
  const compatible = cmp >= 0;
  return {
    manifest,
    substrate: { current: substrate.version, required: manifest.minSubstrateVersion },
    schema: { current: substrate.schemaVersion, capturedAt: manifest.schemaVersion_db },
    compatible,
    reason: compatible
      ? undefined
      : `snapshot requires substrate ≥ ${manifest.minSubstrateVersion}; current ${substrate.version}`,
  };
}

/** Returns: a > b → 1, a == b → 0, a < b → -1. Strict semver MAJOR.MINOR.PATCH. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return Math.sign(pa.major - pb.major);
  if (pa.minor !== pb.minor) return Math.sign(pa.minor - pb.minor);
  return Math.sign(pa.patch - pb.patch);
}

function parseSemver(v: string): { major: number; minor: number; patch: number } {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.replace(/^v/, ''));
  if (!m) throw new Error(`invalid semver: ${v}`);
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]! };
}

export function formatCompatReport(c: CompatReport): string {
  const lines: string[] = [];
  lines.push(`Snapshot ${c.manifest.id} (${c.manifest.name})`);
  lines.push(`  Built on substrate v${c.manifest.substrateVersion}, schema v${c.manifest.schemaVersion_db}`);
  lines.push(`  Requires substrate ≥ v${c.manifest.minSubstrateVersion}`);
  lines.push(`  Your substrate: v${c.substrate.current}, schema v${c.schema.current}`);
  if (c.compatible) {
    lines.push(`  Compatibility: ✓ COMPATIBLE`);
    if (c.schema.capturedAt < c.schema.current) {
      lines.push(
        `    Schema migration: v${c.schema.capturedAt} → v${c.schema.current} (will run ${c.schema.current - c.schema.capturedAt} forward migration(s))`,
      );
    }
  } else {
    lines.push(`  Compatibility: ✗ INCOMPATIBLE`);
    lines.push(`    ${c.reason}`);
    lines.push(`    Action: upgrade substrate first (papercusp upgrade)`);
  }
  return lines.join('\n');
}

function runStdoutString(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

void dirname; // satisfy unused import in some strict modes
