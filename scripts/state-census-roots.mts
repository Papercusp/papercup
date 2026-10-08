#!/usr/bin/env -S npx tsx
/** Partial writer-root diagnostic, explicitly not a whole-install ship verdict. */
import { collectStateCensus, backupCacheCensusDeclarations } from '../packages/backup/src/state-census';
import { installedRootCensusProducers, postgresStorageDeclaration, gitStorageDeclaration } from '../packages/operator-core/lib/backup/state-census-producers';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

const producers = installedRootCensusProducers();
const declarations = [...producers.declarations,
  ...producers.roots.flatMap(root => backupCacheCensusDeclarations(root.id))];
for (const root of producers.roots) {
  let clones;
  try { clones = await readdir(join(root.path, 'clones'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const clone of clones ?? []) {
    if (!clone.isDirectory()) continue;
    try { await lstat(join(root.path, 'clones', clone.name, '.git')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push(await gitStorageDeclaration(root, `clones/${clone.name}`));
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
  ...producers, declarations, maxEntries: 10_000,
  // This diagnostic intentionally does not certify catalogs.
  readCatalogs: async () => [],
});
console.log(JSON.stringify({
  scope: 'implemented-writer-filesystem-roots-only', wholeInstallVerified: false,
  roots: producers.roots, ...census,
}, null, 2));
if (!census.ok) process.exitCode = 1;
