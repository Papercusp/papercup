/**
 * Snapshot capture pass — orchestrates §15.5 steps 2–9 + 13.
 *
 * Steps 1 (orchestrator pause) and 7 (review UI) are caller concerns:
 * the substrate decides drain policy and surfaces the review UI before
 * calling here. Once `capture()` returns successfully, the tarball is on
 * disk and ready to share. The substrate restarts the orchestrator if it
 * was paused.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ensureRequiredForCapture } from './binaries';
import {
  newSnapshotId,
  SNAPSHOT_SCHEMA_VERSION,
  validateSnapshotManifest,
  type SnapshotManifest,
} from './manifest';
import { snapshotPath, snapshotsDir, stagingDir } from './paths';
import { dbCapture } from './pg-dump';
import { stageHarnessSubset, stageProjectFiles } from './staging';
import { buildFileEntries, sha256OfFile } from './canonical-hash';
import { scanForSecrets, VerifiedSecretsBlocked } from './secret-scan';
import { tarGzipStaging } from './tarball';
import { excludedSharedTables } from './shared-table-filters';
import type { CaptureProgress, CaptureRequest, CaptureResult } from './capture-types';

export async function capture(req: CaptureRequest): Promise<CaptureResult> {
  const start = Date.now();
  const warnings: string[] = [];
  const onProgress = req.onProgress ?? (() => {});
  const emit = (p: CaptureProgress) => onProgress(p);

  emit({ phase: 'precheck', message: 'verifying required binaries' });
  await ensureRequiredForCapture();

  const id = newSnapshotId();
  // Use a per-capture staging dir so concurrent captures (e.g. two
  // back-to-back UI clicks) don't race on the shared base dir. The base
  // `snapshot-staging/` dir is left in place so existing tooling that
  // looks for staging-in-progress still finds something.
  const stage = join(stagingDir(req.projectDir), id);

  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });

  try {
    // ── Step 3 + 4: DB capture
    emit({ phase: 'pg-dump-per-harness', message: `dumping harness_${req.harnessSlug}` });
    const stateDir = join(stage, 'state');
    const db = await dbCapture({
      slug: req.harnessSlug,
      stateDir,
      databaseUrl: req.databaseUrl,
    });
    emit({
      phase: 'pg-dump-shared',
      message: `captured ${db.sharedTables.written.length} shared tables (${db.sharedTables.written.reduce((s, w) => s + w.rowCount, 0)} rows)`,
    });

    // ── Step 5: Filesystem walk + denylist
    emit({ phase: 'fs-walk', message: 'walking project files' });
    const fsStage = await stageProjectFiles({
      projectDir: req.projectDir,
      stagingDir: stage,
      capture: req.capture,
      acceptSoftCap: req.acceptSoftCap ?? false,
      signal: req.signal,
    });
    const harnessSubset = await stageHarnessSubset({
      projectDir: req.projectDir,
      stagingDir: stage,
      capture: req.capture,
      signal: req.signal,
    });

    // ── Step 6: Secret scan
    emit({ phase: 'secret-scan-tier-a', message: 'trufflehog --only-verified' });
    const scan = await scanForSecrets(stage, { signal: req.signal });
    if (scan.verifiedHits.length > 0 && !req.acceptVerifiedSecrets) {
      throw new VerifiedSecretsBlocked(scan.verifiedHits);
    }
    if (scan.verifiedHits.length > 0) {
      warnings.push(
        `proceeding with ${scan.verifiedHits.length} verified secret hit(s) (acceptVerifiedSecrets=true)`,
      );
    }
    if (scan.highRecallHits.length > 0) {
      emit({
        phase: 'secret-scan-tier-b',
        message: `gitleaks: ${scan.highRecallHits.length} high-recall hit(s) (warnings only)`,
      });
      warnings.push(`${scan.highRecallHits.length} gitleaks high-recall warning(s) — review before sharing`);
    }

    // ── Write the placeholder manifest with hashes computed below
    // Build one combined list of files-on-disk so the manifest's `files[]`
    // matches exactly what gets tarred.
    emit({ phase: 'manifest', message: 'computing per-file sha256 + manifest' });
    const allStaged: { rel: string; abs: string; bytes: number }[] = [
      ...fsStage.files.map((e) => ({ rel: 'source/' + e.rel, abs: e.abs, bytes: e.bytes })),
      ...harnessSubset.map((e) => ({ rel: e.rel, abs: e.abs, bytes: e.bytes })),
    ];

    // State files (db + shared)
    const stateFiles = await collectStateFiles(stateDir);
    for (const sf of stateFiles) allStaged.push(sf);

    const manifestFiles = await buildFileEntries(allStaged);

    const manifest: SnapshotManifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      kind: 'snapshot',
      id,
      name: req.name,
      description: req.description,
      harnessSlug: req.harnessSlug,
      substrateVersion: req.substrateVersion,
      schemaVersion_db: req.schemaVersionDb,
      minSubstrateVersion: req.minSubstrateVersion,
      template: req.template,
      createdAt: Date.now(),
      files: manifestFiles,
      excluded: [
        ...fsStage.excluded,
        ...excludedSharedTables().map((t) => ({
          path: `state/shared-${t.table}.csv`,
          reason: t.reason ?? 'excluded by registry',
        })),
      ],
      plugins: req.plugins,
      partial: req.drainMode === 'autonomous' && (req.signal?.aborted ?? false),
      license: req.license,
      redactions: {
        blockedSecretsTier:
          scan.verifiedHits.length > 0
            ? 'verified-block'
            : scan.highRecallHits.length > 0
              ? 'high-recall-warn'
              : 'none',
        verifiedHits: scan.verifiedHits.length,
        highRecallHits: scan.highRecallHits.length,
      },
      captureDurationMs: undefined, // filled in after tar
    };
    validateSnapshotManifest(manifest);

    await fs.writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    // README is optional; copy from project root if present.
    const projReadme = join(req.projectDir, 'README.md');
    try {
      await fs.copyFile(projReadme, join(stage, 'README.md'));
    } catch {
      /* ignore */
    }

    // ── Step 9: tar + gzip
    emit({ phase: 'tar', message: 'compressing tarball' });
    const out = snapshotPath(req.projectDir, id);
    await fs.mkdir(snapshotsDir(req.projectDir), { recursive: true });
    const tar = await tarGzipStaging({
      stagingDir: stage,
      outputPath: out,
      signal: req.signal,
    });
    const tarballSha = await sha256OfFile(out);

    // Persist tarball-side digest as a sibling for restore-time integrity check.
    await fs.writeFile(out + '.sha256', tarballSha + '  ' + id + '.tar.gz\n');

    // Patch in capture duration
    manifest.captureDurationMs = Date.now() - start;
    await fs.writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    emit({ phase: 'cleanup', message: 'removing staging dir' });
    await fs.rm(stage, { recursive: true, force: true });

    emit({ phase: 'done', message: `captured ${id} (${(tar.bytesCompressed / 1e6).toFixed(1)} MB)` });
    return {
      manifest,
      tarballPath: out,
      bytesCompressed: tar.bytesCompressed,
      durationMs: Date.now() - start,
      warnings,
    };
  } catch (e) {
    // Best-effort cleanup so a failed capture doesn't leak partial state.
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function collectStateFiles(
  stateDir: string,
): Promise<{ rel: string; abs: string; bytes: number }[]> {
  const out: { rel: string; abs: string; bytes: number }[] = [];
  const entries = await fs.readdir(stateDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(stateDir, e.name);
    const stat = await fs.stat(abs);
    out.push({ rel: 'state/' + e.name, abs, bytes: stat.size });
  }
  return out;
}
