#!/usr/bin/env -S npx tsx
/** Partial writer-root diagnostic, explicitly not a whole-install ship verdict. */
import { collectStateCensus, backupCacheCensusDeclarations } from '../packages/backup/src/state-census';
import { installedRootCensusProducers, postgresStorageDeclaration, gitStorageDeclaration, peerStorageDeclaration, portalReleaseStorageDeclaration, restoredCloneCensusDeclarations, mergeNestedCensusRoots, virtualenvCacheDeclaration } from '../packages/operator-core/lib/backup/state-census-producers';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join, relative, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
const { releaseConfig } = createRequire(import.meta.url)('../apps/operator/lib/release/release-config.ts');
import { workspacesRoot, readRegistry } from '../packages/operator-core/lib/workspace-registry';
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import { physicalDatabaseCensusEntries, integrationBaselineCensusDeclarations, templateDatabaseCensusDeclarations, unitCensusEntries, installedUnitCensusDeclarations } from '../packages/operator-core/lib/backup/state-census-producers';
import type { CensusEntry } from '../packages/backup/src/state-census';
import { configuredOperatorDatabaseCensusDeclarations, unitDatabaseCensusDeclarations } from '../packages/operator-core/lib/backup/state-census-producers';

const installed = installedRootCensusProducers();
const checkpointLogDir = releaseConfig().checkpointLogDir;
const producers = mergeNestedCensusRoots({ roots: [...installed.roots,
  { id: 'checkpoint-logs-parent', path: dirname(checkpointLogDir) }], declarations: [...installed.declarations, {
  kind: 'path', root: 'checkpoint-logs-parent', name: basename(checkpointLogDir), classification: 'state',
  producer: 'green-checkpoint-log-writer', descendants: true,
  retainedSubtree: { evidenceRef: 'release-config:checkpointLogDir' },
}] });
const declarations = [...producers.declarations,
  ...producers.roots.flatMap(root => backupCacheCensusDeclarations(root.id))];
const hostCatalogs = process.argv.includes('--host-catalogs');
const catalogEntries: CensusEntry[] = [];
if (process.argv.includes('--restore-events') || hostCatalogs) {
  const sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5 });
  try {
    for (const workspace of readRegistry().workspaces) {
      declarations.push(...await restoredCloneCensusDeclarations(sql, workspace.id, join(workspacesRoot(), workspace.id), producers.roots));
    }
    if (hostCatalogs) {
      const databases = await physicalDatabaseCensusEntries(sql);
      catalogEntries.push(...databases);
      declarations.push(...integrationBaselineCensusDeclarations(databases));
      if (databases.length) declarations.push(...await templateDatabaseCensusDeclarations(sql, databases[0].root));
      if (databases.length) declarations.push(...configuredOperatorDatabaseCensusDeclarations(databases[0].root, getHarnessAdminUrl()));
      const unitDeclarations = [];
      for (const scope of ['user', 'system'] as const) {
        catalogEntries.push(...await unitCensusEntries(scope));
        unitDeclarations.push(...await installedUnitCensusDeclarations(scope));
      }
      declarations.push(...unitDeclarations, ...await unitDatabaseCensusDeclarations(unitDeclarations, databases, getHarnessAdminUrl()));
      // Catalog only declared secret paths that exist; never read their values.
      // Unknown secret locations still appear as filesystem residue.
      const secretPaths = installed.declarations.filter(entry => entry.classification === 'secret');
      for (const declaration of secretPaths.filter((entry, index) => secretPaths.findIndex(other =>
        other.root === entry.root && other.name === entry.name) === index)) {
        const root = installed.roots.find(entry => entry.id === declaration.root)!;
        try { await lstat(join(root.path, declaration.name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const entry: CensusEntry = { kind: 'secret', root: declaration.root, name: declaration.name };
        catalogEntries.push(entry);
        declarations.push({ ...declaration, kind: 'secret' });
      }
    }
  } finally { await sql.end(); }
}
for (const root of producers.roots) {
  const topLevel = await readdir(root.path, { withFileTypes: true });
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    try { await lstat(join(root.path, directory.name, 'PG_VERSION')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push(await postgresStorageDeclaration(root, directory.name));
  }
  // Bounded marker discovery in the home and its direct artifact containers.
  // Symlinks and retained trees are not followed or reclassified.
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    const children = await readdir(join(root.path, directory.name), { withFileTypes: true });
    const candidates = [directory.name, ...children.filter(entry => entry.isDirectory()).map(entry => `${directory.name}/${entry.name}`)];
    for (const name of candidates) {
      try { await lstat(join(root.path, name, 'pyvenv.cfg')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      declarations.push(await virtualenvCacheDeclaration(root, name));
    }
  }
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    let metadata;
    try { metadata = await lstat(join(root.path, directory.name, '.git')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // External worktree pointers do not own their referenced Git metadata.
    // Leave them visible for cross-root qualification rather than following.
    if (!metadata.isDirectory()) continue;
    declarations.push(await gitStorageDeclaration(root, directory.name, true));
  }
  // Only the producer's exact per-workspace layout; scoped stores stay distinct.
  const workspacePrefix = relative(root.path, workspacesRoot());
  const ownsWorkspaces = !workspacePrefix.startsWith('..') && !workspacePrefix.startsWith('/');
  const workspaces = ownsWorkspaces ? await readdir(workspacesRoot(), { withFileTypes: true }) : [];
  const layouts = workspaces.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name }));
  // restoreToClone's exact default shape. Probe embedded producer evidence,
  // keeping the clone and snapshot containers themselves unclassified.
  for (const workspace of [...layouts]) {
    let snapshots;
    try { snapshots = await readdir(join(workspacesRoot(), workspace.name, '.restored'), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const snapshot of snapshots.filter(entry => entry.isDirectory())) {
      const clones = await readdir(join(workspacesRoot(), workspace.name, '.restored', snapshot.name), { withFileTypes: true });
      for (const clone of clones.filter(entry => entry.isDirectory())) {
        const name = `${workspace.name}/.restored/${snapshot.name}/${clone.name}`;
        const qualified = [workspacePrefix, name].filter(Boolean).join('/');
        if (declarations.some(entry => entry.root === root.id && entry.name === qualified && entry.recoveryStorage)) continue;
        layouts.push({ name });
        if (layouts.length > 1000) throw new Error('Recovery layout census bound exceeded');
      }
    }
  }
  for (const workspace of layouts) {
    const parent = join(workspacesRoot(), workspace.name, '.papercusp');
    let harnesses;
    try { harnesses = await readdir(parent, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // Recognize producer evidence inside preserved copies too; the enclosing
    // unknown directories remain residue, never inferred state from their names.
    for (const appContainer of harnesses.filter(entry => entry.isDirectory())) {
    const appsPrefix = [workspacePrefix, workspace.name, '.papercusp', appContainer.name].filter(Boolean).join('/');
    let apps;
    try { apps = await readdir(join(root.path, appsPrefix), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const app of apps ?? []) {
      if (!app.isDirectory() || app.name.startsWith('.')) continue;
      const appName = `${appsPrefix}/${app.name}`;
      let hasGit = false;
      try { await lstat(join(root.path, appName, '.git')); hasGit = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (hasGit) {
        // Full preservation includes untracked state; avoid a competing nested
        // cache override that would invalidate this opaque worktree manifest.
        declarations.push(await gitStorageDeclaration(root, appName, true));
        continue;
      }
      let buildProducer;
      try { buildProducer = await readFile(join(root.path, appName, 'scripts', 'build-standalone.mjs'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // Pin this exception to the actual Next build writer, not a generic
      // filename heuristic: published releases are separately retained state.
      if (buildProducer?.includes('const buildDistDir = ".next-build";')) {
        const output = await readdir(join(root.path, appName), { withFileTypes: true });
        for (const child of output) {
          if (child.isDirectory() && /^\.next-build(?:-\d+-\d+-[0-9a-f]+)?$/.test(child.name)) {
            declarations.push({ kind: 'path', root: root.id, name: `${appName}/${child.name}`,
              classification: 'cache', producer: 'portal-build-standalone', descendants: true, prune: true });
          }
        }
      }
    }
    const runtimePrefix = `${appsPrefix}/.portal-runtime`;
    let runtimes;
    try { runtimes = await readdir(join(root.path, runtimePrefix), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const runtime of runtimes ?? []) {
      if (!runtime.isDirectory()) continue;
      const releasePrefix = `${runtimePrefix}/${runtime.name}/releases`;
      let releases;
      try { releases = await readdir(join(root.path, releasePrefix), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const release of releases) {
        if (release.isDirectory()) declarations.push(await portalReleaseStorageDeclaration(root, `${releasePrefix}/${release.name}`));
      }
    }
    }
    for (const harness of harnesses.filter(entry => entry.isDirectory())) {
      const pgName = [workspacePrefix, workspace.name, '.papercusp', harness.name].filter(Boolean).join('/');
      let hasPgControl = false;
      try { await lstat(join(root.path, pgName, 'PG_VERSION')); hasPgControl = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (hasPgControl) declarations.push(await postgresStorageDeclaration(root, pgName));
      for (const store of ['hyperbee', 'hyperbee-scoped']) {
        const name = [workspacePrefix, workspace.name, '.papercusp', harness.name, store].filter(Boolean).join('/');
        // Legacy or uninitialized directories have no device marker. Walk them
        // normally so they remain visible residue instead of assuming ownership.
        try { await lstat(join(root.path, name, 'CORESTORE')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        declarations.push(await peerStorageDeclaration(root, name));
      }
    }
  }
  let clones;
  try { clones = await readdir(join(root.path, 'clones'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const clone of clones ?? []) {
    if (!clone.isDirectory()) continue;
    try { await lstat(join(root.path, 'clones', clone.name, '.git')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // Entire worktree is carried, including untracked files and linked pointers.
    declarations.push(await gitStorageDeclaration(root, `clones/${clone.name}`, true));
  }
  let children;
  try { children = await readdir(join(root.path, '.shared'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  for (const child of children) {
    if (child.isDirectory() && child.name.startsWith('embedded-pg-data')) {
      declarations.push(await postgresStorageDeclaration(root, `.shared/${child.name}`));
    }
  }
}
const census = await collectStateCensus({
  ...producers, declarations, representUnknownSubtrees: true,
  // This diagnostic intentionally does not certify catalogs.
  readCatalogs: async () => catalogEntries,
});
console.log(JSON.stringify({
  scope: hostCatalogs ? 'implemented-writer-filesystem-roots-and-host-catalogs' : 'implemented-writer-filesystem-roots-only', wholeInstallVerified: false,
  roots: producers.roots, ...census,
}, null, 2));
if (!census.ok) process.exitCode = 1;
