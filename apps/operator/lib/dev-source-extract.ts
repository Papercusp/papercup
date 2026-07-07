import { createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';

/**
 * First-boot extraction of the bundled runnable dev/local source tree (WI-3308,
 * plan env-switcher-packaged-all-platforms-2026-07-06 seam 2).
 *
 * The "all-5-buttons" dogfood bundle ships the runnable monorepo as a single
 * compressed resource `sidecar/source.tar.zst` (staged by
 * papercusp-desktop/bin/stage-source-tree.sh). Rust (main.rs seam 1) passes its
 * path as PAPERCUSP_SOURCE_ARCHIVE + a writable target as PAPERCUSP_DEV_SOURCE_DIR
 * (`<shared_state_dir>/dev-source`, distro-local ext4 on Windows). On first boot
 * we extract it there, then set PAPERCUSP_DEV_SOURCE_ROOT — which the launcher's
 * defaultDetectSourceRoot prefers (env-operator-launcher.ts, seam 3, b0fbf) so
 * the dev(:3270)/local(:3055) env operators run from THIS tree with the bundled
 * node's own tsx/vite. We deliberately do NOT touch PAPERCUSP_INTEGRATION_ROOT on
 * the primary operator (the install IS the release; repointing its prompt/tool
 * resolution at a staging tree would be wrong) — the source tree is confined to
 * the dev/local children via PAPERCUSP_DEV_SOURCE_ROOT.
 *
 * zstd is decoded with node's built-in zlib.createZstdDecompress (present on the
 * bundled node v24.15.0; verified decoding the real --long=27 archive) and
 * un-tarred with tar-fs (preserves the node_modules/.bin symlinks the toolchain
 * needs). Both are injectable so the unit test never depends on the host node's
 * zstd support.
 */

/** Markers that identify a runnable papercup tree — mirror detectPapercupRoot
 *  (register-papercusp.ts) so a half-extracted tree is treated as "not ready". */
export function hasPapercupMarkers(root: string): boolean {
  return (
    existsSync(join(root, 'apps', 'operator', 'package.json')) &&
    existsSync(join(root, 'libs', 'papercusp', 'package.json'))
  );
}

export interface ExtractDevSourceDeps {
  /** zstd decompress transform factory (default: node zlib createZstdDecompress). */
  makeDecompress?: () => NodeJS.ReadWriteStream;
  /** tar extract sink factory for a dir (default: tar-fs extract). */
  makeExtract?: (dir: string) => Writable;
  log?: (m: string) => void;
}

export interface ExtractDevSourceOpts extends ExtractDevSourceDeps {
  /** Bundled source.tar.zst path (PAPERCUSP_SOURCE_ARCHIVE). undefined ⇒ no-op. */
  archivePath: string | undefined;
  /** Writable extract target (PAPERCUSP_DEV_SOURCE_DIR). Its root becomes the tree. */
  targetDir: string | undefined;
}

/**
 * Extract the dev-source tree if a bundle is present and the target isn't already
 * populated. Idempotent (marker-gated: an already-extracted tree is reused, so a
 * Server-only REINSTALL keeps it — WI-3244 no-wipe runbook) and NEVER throws: on
 * any failure it returns null and dev/local simply stay skipped 'no-source-tree',
 * exactly as before this feature. Returns the extracted root path on success (the
 * caller sets PAPERCUSP_DEV_SOURCE_ROOT to it) or null when there's nothing to do.
 */
export async function extractDevSourceTree(
  opts: ExtractDevSourceOpts,
): Promise<string | null> {
  const { archivePath, targetDir, log = () => {} } = opts;
  if (!archivePath || !targetDir) return null;
  if (!existsSync(archivePath)) {
    log(
      `[dev-source] no bundle at ${archivePath} — dev/local run from source only on a source-bundled build`,
    );
    return null;
  }
  if (hasPapercupMarkers(targetDir)) {
    log(`[dev-source] tree already present at ${targetDir} (reusing)`);
    return targetDir;
  }
  try {
    await mkdir(targetDir, { recursive: true });
    const makeDecompress = opts.makeDecompress ?? (await defaultDecompress());
    const makeExtract = opts.makeExtract ?? (await defaultExtract());
    log(`[dev-source] extracting ${archivePath} → ${targetDir} (first boot; ~2 min)`);
    await pipeline(createReadStream(archivePath), makeDecompress(), makeExtract(targetDir));
    if (!hasPapercupMarkers(targetDir)) {
      log(
        `[dev-source] extract finished but markers missing at ${targetDir} — treating as failed (dev/local skip)`,
      );
      return null;
    }
    log(`[dev-source] tree extracted → ${targetDir}`);
    return targetDir;
  } catch (e) {
    log(`[dev-source] extract failed (non-fatal; dev/local skip): ${(e as Error)?.message ?? e}`);
    return null;
  }
}

async function defaultDecompress(): Promise<() => NodeJS.ReadWriteStream> {
  const zlib = await import('node:zlib');
  const make = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream })
    .createZstdDecompress;
  if (typeof make !== 'function') {
    throw new Error(
      'node zlib lacks createZstdDecompress (needs node ≥22.15/24) — the bundled runtime has it',
    );
  }
  return () => make();
}

async function defaultExtract(): Promise<(dir: string) => Writable> {
  const tarfs = (await import('tar-fs')) as unknown as {
    extract?: (dir: string) => Writable;
    default?: { extract?: (dir: string) => Writable };
  };
  const extract = tarfs.extract ?? tarfs.default?.extract;
  if (typeof extract !== 'function') throw new Error('tar-fs extract unavailable');
  return (dir: string) => extract(dir);
}
