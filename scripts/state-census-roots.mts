#!/usr/bin/env -S npx tsx
/** Partial writer-root diagnostic, explicitly not a whole-install ship verdict. */
import { collectStateCensus, backupCacheCensusDeclarations } from '../packages/backup/src/state-census';
import { installedRootCensusProducers, postgresStorageDeclaration, gitStorageDeclaration, peerStorageDeclaration, portalReleaseStorageDeclaration } from '../packages/operator-core/lib/backup/state-census-producers';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { workspacesRoot } from '../packages/operator-core/lib/workspace-registry';

const producers = installedRootCensusProducers();
const declarations = [...producers.declarations,
  ...producers.roots.flatMap(root => backupCacheCensusDeclarations(root.id))];
for (const root of producers.roots) {
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
        layouts.push({ name: `${workspace.name}/.restored/${snapshot.name}/${clone.name}` });
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
  ...producers, declarations,
  // This diagnostic intentionally does not certify catalogs.
  readCatalogs: async () => [],
});
console.log(JSON.stringify({
  scope: 'implemented-writer-filesystem-roots-only', wholeInstallVerified: false,
  roots: producers.roots, ...census,
}, null, 2));
if (!census.ok) process.exitCode = 1;
