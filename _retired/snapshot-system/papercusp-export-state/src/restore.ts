/**
 * Snapshot restore — orchestrates §15.6 steps 1–14 (sans live-orchestrator
 * pause, which is the substrate's caller concern).
 *
 *   1.  compat info — done by caller via `compat.ts` before invoking us
 *   2.  pause autonomous loop — caller
 *   3.  ORAS pull / file-on-disk — caller hands us a path
 *   4.  verify integrity (tarball sha + per-file sha after extract)
 *   5.  extract tarball
 *   6.  generate fork slug
 *   7.  ALTER SCHEMA + slug-prefix shared rows
 *   8.  forward migrations (caller-provided hook)
 *   9.  slug rewrite (structured contexts only)
 *  10.  plugin re-enable (caller surfaces consent UI; we accept the decision)
 *  11.  project context — implicit; shared rows already imported
 *  12.  final verification
 *  13.  restart orchestrator — caller
 *  14.  print post-restore checklist
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyPerHarnessDump,
  releaseRestoreLock,
  schemaExists,
  takeRestoreLock,
  TargetSchemaExists,
} from './alter-schema';
import { extractTarball, verifyPerFileHashes, verifyTarballSidecar } from './extract';
import { applyHarnessSharedRestore } from './shared-row-restore';
import { rewriteSlugInDir } from './slug-rewrite';
import { buildConsentSummary, persistPluginConfigs } from './plugin-reenable';
import { resolveDatabaseUrl } from './pg-dump';
import { newForkSlugSuffix } from './manifest';
import { papercuspPath, papercuspRoot } from './paths';
import { assertValidSlug } from './shared-table-filters';
import type { RestoreProgress, RestoreRequest, RestoreResult } from './restore-types';

export async function restore(req: RestoreRequest): Promise<RestoreResult> {
  const onProgress = req.onProgress ?? (() => {});
  const emit = (p: RestoreProgress) => onProgress(p);
  const warnings: string[] = [];

  const url = resolveDatabaseUrl(req.databaseUrl);
  emit({ phase: 'verify', message: 'verifying tarball integrity' });
  await verifyTarballSidecar(req.snapshotPath);

  emit({ phase: 'extract', message: 'extracting' });
  const workRoot = await fs.mkdtemp(join(tmpdir(), 'papercusp-restore-'));
  const { stagingDir, manifest } = await extractTarball({
    tarPath: req.snapshotPath,
    destDir: workRoot,
  });

  if (manifest.partial && !req.acceptPartial) {
    await fs.rm(workRoot, { recursive: true, force: true });
    throw new Error(
      `snapshot is marked partial=true; pass acceptPartial=true to install anyway`,
    );
  }

  await verifyPerFileHashes({ stagingDir, manifest });

  emit({ phase: 'fork-slug', message: 'allocating fork slug' });
  const forkSuffix = newForkSlugSuffix();
  const newSlug = `${manifest.harnessSlug}_fork_${forkSuffix}`;
  assertValidSlug(newSlug);

  if (await schemaExists(url, `harness_${newSlug}`)) {
    await fs.rm(workRoot, { recursive: true, force: true });
    throw new TargetSchemaExists(newSlug);
  }

  // Stage the project files into a fresh `<targetProjectsDir>/<newSlug>/`
  emit({ phase: 'extract', message: 'placing project files' });
  const projectDir = join(req.targetProjectsDir, newSlug);
  await fs.mkdir(projectDir, { recursive: true });
  // Copy `source/` from the extracted staging dir into projectDir
  await copyDir(join(stagingDir, 'source'), projectDir);

  // Copy `state/harness/*` into <projectDir>/.papercusp/ for operator artifacts
  const harnessDest = join(projectDir, '.papercusp');
  await fs.mkdir(harnessDest, { recursive: true });
  await copyDir(join(stagingDir, 'state', 'harness'), harnessDest).catch(() => {});

  // ── Step 7: ALTER SCHEMA flow + shared-row restore
  emit({ phase: 'alter-schema', message: `restoring per-harness schema as harness_${newSlug}` });
  await takeRestoreLock({ url, originalSlug: manifest.harnessSlug });
  let lockReleased = false;
  try {
    await applyPerHarnessDump({
      url,
      originalSlug: manifest.harnessSlug,
      newSlug,
      pgDumpPath: join(stagingDir, 'state', 'db.sql.gz'),
      workDir: workRoot,
    });

    emit({ phase: 'shared-rows', message: 'importing harness_shared subset' });
    await applyHarnessSharedRestore({
      url,
      originalSlug: manifest.harnessSlug,
      newSlug,
      forkSuffix,
      stateDir: join(stagingDir, 'state'),
      workDir: workRoot,
      perHarnessSchema: `harness_${newSlug}`,
    });
  } finally {
    if (!lockReleased) {
      await releaseRestoreLock({ url, originalSlug: manifest.harnessSlug }).catch(() => {});
      lockReleased = true;
    }
  }

  // ── Step 8: forward migrations (caller-provided)
  if (req.runForwardMigrations) {
    emit({ phase: 'migrate', message: `running forward migrations for harness_${newSlug}` });
    await req.runForwardMigrations(newSlug);
  }

  // ── Step 9: slug rewrite (structured contexts)
  emit({ phase: 'slug-rewrite', message: 'rewriting slug references' });
  const rewriteResult = await rewriteSlugInDir({
    rootDir: projectDir,
    originalSlug: manifest.harnessSlug,
    newSlug,
    ambiguousPolicy: req.ambiguousMatchPolicy,
    signal: req.signal,
  });
  if (rewriteResult.ambiguous.length > 0 && req.ambiguousMatchPolicy !== 'rewrite-all') {
    warnings.push(
      `${rewriteResult.ambiguous.length} ambiguous slug match(es) skipped — pass --rewrite-ambiguous-slugs at install time, or review and edit by hand`,
    );
  }

  // ── Step 10: plugin re-enable
  emit({ phase: 'plugins', message: 'reading installed plugin manifests' });
  const consent = await buildConsentSummary(manifest.plugins);
  if (consent.missing.length > 0) {
    warnings.push(
      `${consent.missing.length} plugin(s) referenced by snapshot are not installed locally: ` +
        consent.missing.map((m) => m.name).join(', '),
    );
  }
  if (consent.capDeltas.length > 0) {
    warnings.push(
      `${consent.capDeltas.length} plugin(s) had cap-set changes between capture and now`,
    );
  }
  if (req.consent === 'reject') {
    throw new Error('plugin consent rejected — restore aborted');
  }
  await persistPluginConfigs({ newSlug, plugins: consent.plugins });
  // Note: we don't call `papercusp plugin enable` for each here. The caller
  // invokes the substrate's enable flow as a separate step (so its existing
  // CLI-or-server gate enforcement remains the single source of truth).

  // ── Step 12: final verification
  emit({ phase: 'verify-final', message: 'verification queries' });
  // (placeholder: caller can run `papercusp doctor --slug <newSlug>` per checklist)

  // ── Register the new harness in ~/.papercusp/registry.json
  await registerHarness(newSlug, projectDir);

  await fs.rm(workRoot, { recursive: true, force: true });
  emit({ phase: 'done', message: `restored as harness_${newSlug}` });
  return {
    newSlug,
    projectDir,
    manifest,
    warnings,
    ambiguousSlugMatches: rewriteResult.ambiguous.slice(0, 50),
  };
}

async function copyDir(src: string, dest: string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  await fs.mkdir(dest, { recursive: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) {
      await copyDir(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function registerHarness(slug: string, projectDir: string): Promise<void> {
  const registryPath = papercuspPath('registry.json');
  let reg: { projects: { slug: string; path: string }[] } = { projects: [] };
  try {
    const raw = await fs.readFile(registryPath, 'utf8');
    reg = JSON.parse(raw);
    if (!Array.isArray(reg.projects)) reg.projects = [];
  } catch {
    /* fresh registry */
  }
  if (!reg.projects.some((p) => p.slug === slug)) {
    reg.projects.push({ slug, path: projectDir });
  }
  await fs.mkdir(papercuspRoot(), { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify(reg, null, 2) + '\n');
}

/**
 * §15.6 step 14 — what the operator should do after the substrate prints
 * "restore complete". Auto-running these would be an RCE surface (§15.24).
 */
export function postRestoreChecklist(newSlug: string, projectDir: string): string {
  return [
    `Restore complete: harness_${newSlug}`,
    ``,
    `Before running \`papercusp run\`:`,
    `  1. Review the restored source code:`,
    `       cd ${projectDir} && less docs/features/F-001.md  (etc.)`,
    `  2. Install dependencies (snapshot excluded node_modules/, dist/, etc.):`,
    `       cd ${projectDir}`,
    `       npm ci          (Node projects)`,
    `       pip install -r requirements.txt    (Python)`,
    `       cargo build     (Rust)`,
    `       bundle install  (Ruby)`,
    `  3. Configure secrets the snapshot couldn't carry:`,
    `       cp .env.example .env  &&  edit .env`,
    `  4. Optional sanity check:`,
    `       papercusp doctor --slug ${newSlug}`,
    `  5. Start the autonomous loop:`,
    `       papercusp run --slug ${newSlug}`,
  ].join('\n');
}
