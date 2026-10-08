#!/usr/bin/env -S npx tsx
/** Partial writer-root diagnostic, explicitly not a whole-install ship verdict. */
import { collectStateCensus, backupCacheCensusDeclarations } from '../packages/backup/src/state-census';
import { installedRootCensusProducers } from '../packages/operator-core/lib/backup/state-census-producers';

const producers = installedRootCensusProducers();
const declarations = [...producers.declarations,
  ...producers.roots.flatMap(root => backupCacheCensusDeclarations(root.id))];
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
