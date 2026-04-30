/**
 * §15.6 step 4 + 5 — verify integrity, extract tarball.
 *
 * Integrity: recompute tarball sha256 against the sibling `<id>.tar.gz.sha256`.
 * Per-file sha256 inside the manifest is verified during the post-extract
 * walk so any corruption surfaces before any DB writes happen.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { sha256OfFile } from './canonical-hash';
import { validateSnapshotManifest, type SnapshotManifest } from './manifest';

export async function verifyTarballSidecar(tarPath: string): Promise<void> {
  let expected: string | null = null;
  try {
    const sidecar = await fs.readFile(tarPath + '.sha256', 'utf8');
    expected = (sidecar.split(/\s+/)[0] ?? '').trim();
  } catch {
    return; // no sidecar; substrate-internal capture should always have one, but ORAS pulls don't.
  }
  if (!expected) return;
  const actual = await sha256OfFile(tarPath);
  if (actual !== expected) {
    throw new Error(`tarball sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

export async function extractTarball(args: {
  tarPath: string;
  destDir: string;
  signal?: AbortSignal;
}): Promise<{ stagingDir: string; manifest: SnapshotManifest }> {
  await fs.mkdir(args.destDir, { recursive: true });
  await runOk('tar', ['-xzf', args.tarPath, '-C', args.destDir], args.signal);

  // Tarball's top-level dir is the original staging-dir basename. Find it.
  const top = (await fs.readdir(args.destDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (top.length !== 1) {
    throw new Error(`expected exactly one top-level dir in tarball, got ${top.length}`);
  }
  const stagingDir = join(args.destDir, top[0]!);
  const manifestRaw = await fs.readFile(join(stagingDir, 'manifest.json'), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch (e) {
    throw new Error(`extracted manifest is not valid JSON: ${(e as Error).message}`);
  }
  validateSnapshotManifest(parsed);
  return { stagingDir, manifest: parsed };
}

export async function verifyPerFileHashes(args: {
  stagingDir: string;
  manifest: SnapshotManifest;
}): Promise<void> {
  for (const f of args.manifest.files) {
    const abs = join(args.stagingDir, f.path);
    const got = await sha256OfFile(abs);
    if (got !== f.sha256) {
      throw new Error(
        `file ${f.path} sha256 mismatch (manifest ${f.sha256}, got ${got})`,
      );
    }
  }
}

function runOk(cmd: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    signal?.addEventListener('abort', () => child.kill('SIGTERM'));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`)),
    );
  });
}
