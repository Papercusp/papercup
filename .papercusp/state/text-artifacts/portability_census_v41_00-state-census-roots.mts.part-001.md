---
rel_path: "portability/census/v41/00-state-census-roots.mts.part-001"
updated_at: 1794241756285
_body: "content"
---

 content = bytes.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
    let record: unknown;
    try { record = JSON.parse(content); } catch { return; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    const fields = record as Record<string, unknown>;
    if (Object.keys(fields).some(key => !['pid', 'token', 'startedAt', 'processIdentity'].includes(key))
      || typeof fields.pid !== 'number' || !Number.isSafeInteger(fields.pid) || fields.pid <= 0
      || typeof fields.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fields.token)
      || typeof fields.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fields.startedAt)
      || !Number.isFinite(Date.parse(fields.startedAt)) || new Date(fields.startedAt).toISOString() !== fields.startedAt
      || ('processIdentity' in fields && fields.processIdentity !== null
        && (typeof fields.processIdentity !== 'string' || !fields.processIdentity.length
          || fields.processIdentity.length > 1024 || /[\u0000-\u001f\u007f]/.test(fields.processIdentity)))) return;
    return { kind: 'path', root: root.id, name, classification: 'cache', producer: 'corestore-single-instance-lock' };
  } catch (error) {
    // Missing/replaced locks and symlinks have no producer proof; all other
    // unreadable evidence must still fail discovery rather than hide a fault.
    if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

/** Discover serializable producer inputs; this alone is never a census verdict.
 * Separating the phases lets bounded diagnostics retain discovery and retry
 * collection without rescanning archives, Git history and host catalogs.
 * Importing this entry performs no census or host-catalog reads.
 */
export async function discoverRootCensusInputs(options: RootCensusOptions = {}) {
const args = options.args ?? [];
// Report stage names only: callers can time or retain progress without logging
// credential contents, archived commands, or filesystem inventory.
const stage = options.onStage ?? (() => {});
stage('installed-roots');
const installed = installedRootCensusProducers();
let hostedEvidence = options.hostedProfileEvidence ?? [];
let playwrightEvidence: PlaywrightStateWriterEvidence[] = options.historicalWriterEvidence ?? [];
if (args.includes('--host-catalogs') && options.hostedProfileEvidence === undefined && options.historicalWriterEvidence === undefined) {
  stage('historical-writer-index');
  const sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5 });
  try {
    // Bound the writer dialect, not its filenames. A new destination is derived
    // from the retained command AST and must still pass installed-content proof.
    const indexedEvidence = await readHistoricalCensusWriterCandidates(sql);
    const recovered = await recoverHistoricalCensusWriterEvidence(indexedEvidence);
    // Full index entries remain usable if their archive was never retained;
    // truncated entries still fail the whole-program validator. Browser state
    // always needs a canonical call-id-paired receipt as well as its writer.
    hostedEvidence = [...indexedEvidence.filter(indexed => !recovered.some(record => record.indexedRef === indexed.ref)), ...recovered];
    playwrightEvidence = recovered;
  } finally { await sql.end(); }
}
stage('historical-hosted-profiles');
const historicalHosted = await historicalHostedProfileCensusProducer(hostedEvidence);
stage('historical-playwright-state');
const historicalPlaywright = await historicalPlaywrightStateCensusProducer(playwrightEvidence);
stage('historical-stripe-config');
const historicalStripe = await historicalStripeConfigCensusProducer(playwrightEvidence);
const combinedHosted = mergeNestedCensusRoots({ roots: [...installed.roots, ...historicalHosted.roots, ...historicalPlaywright.roots, ...historicalStripe.roots],
  declarations: [...installed.declarations, ...historicalHosted.declarations, ...historicalPlaywright.declarations, ...historicalStripe.declarations] });
installed.roots = combinedHosted.roots;
installed.declarations = combinedHosted.declarations;
// Query exact archive identities BEFORE the ledger limit; a batch is smaller
// than the cap. GCed ledger rows need a canonical terminal latch or reaper broadcast; an archive
// filename alone never proves writer ownership.
stage('reap-archive');
const reapArchive = await reapArchiveCensusProducer(undefined, [], args.includes('--host-catalogs')
  ? taskIds => readRetainedReapTaskIds(taskIds, readRegistry().workspaces) : undefined);
stage('affected-test-cache');
const affectedCache = await affectedTestCacheCensusProducer();
stage('workspace-setup-homes');
const setupHomes = await readWorkspaceSetupHomes(readRegistry().workspaces);
stage('runtime-sidefiles');
const sidefiles = await runtimeSidefileCensusProducer(undefined, undefined,
  setupHomes.roots.map(root => root.path), setupHomes.roots.map(root => root.path));
stage('template-mirror');
const templateExpected = (await buildExpected()).expected;
const historicalTemplateIdentity = historicalGitBlobIdentityResolver(fileURLToPath(new URL('..', import.meta.url)));
stage('template-store');
const templateStore = await templateStoreCensusProducer(undefined, templateExpected, historicalTemplateIdentity);
stage('workspace-template-stores');
const workspaceTemplateStores = await workspaceTemplateStoreCensusProducer(undefined, templateExpected, historicalTemplateIdentity);
stage('plan-template-store');
const planTemplateStore = await planTemplateStoreCensusProducer();
const hostCatalogs = args.includes('--host-catalogs');
const checkpointLogDir = options.checkpointLogDir ?? checkpointLogDirFromEnv();
const completedProducers = mergeNestedCensusRoots({ roots: [...installed.roots, ...affectedCache.roots, ...sidefiles.roots, ...setupHomes.roots, ...templateStore.roots, ...workspaceTemplateStores.roots, ...planTemplateStore.roots,
  { id: 'checkpoint-logs-parent', path: dirname(checkpointLogDir) }], declarations: [...installed.declarations, ...affectedCache.declarations, ...sidefiles.declarations, ...setupHomes.declarations, ...templateStore.declarations, ...workspaceTemplateStores.declarations, ...planTemplateStore.declarations, {
  kind: 'path', root: 'checkpoint-logs-parent', name: basename(checkpointLogDir), classification: 'state',
  producer: 'green-checkpoint-log-writer', descendants: true,
  retainedSubtree: { evidenceRef: 'release-config:checkpointLogDir' },
}] });
await options.onDiscoverySnapshot?.({ phase: 'before-account-credentials',
  ...structuredClone({ ...completedProducers, catalogEntries: [] }) });
stage('account-credentials');
const credentials = await accountCredentialCensusProducer(hostCatalogs
  ? await readWorkspaceCensusAccounts(readRegistry().workspaces) : []);
const producers = mergeNestedCensusRoots({ roots: [...completedProducers.roots, ...credentials.roots],
  declarations: [...completedProducers.declarations, ...credentials.declarations] });
const withReapArchive = mergeNestedCensusRoots({ roots: [...producers.roots, ...reapArchive.roots], declarations: [...producers.declarations, ...reapArchive.declarations] });
producers.roots = withReapArchive.roots;
producers.declarations = withReapArchive.declarations;
const declarations = [...producers.declarations,
  ...producers.roots.flatMap(root => backupCacheCensusDeclarations(root.id))];
const catalogEntries: CensusEntry[] = [];
const migrationSources: MigrationCensusSource[] = [];
if (hostCatalogs) {
  stage('migration-sources');
  const { loadHarnessRegistry } = await import('../packages/operator-core/lib/harness-registry');
  migrationSources.push(...await canonicalSqlMigrationCensusSources());
  for (const workspace of readRegistry().workspaces) {
    const registry = await loadHarnessRegistry(workspace.id, { fresh: true });
    migrationSources.push(...await registeredProjectMigrationSources(registry.projects));
  }
}
if (args.includes('--restore-events') || hostCatalogs) {
  stage('host-catalogs');
  const sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5 });
  try {
    for (const workspace of readRegistry().workspaces) {
      declarations.push(...await restoredCloneCensusDeclarations(sql, workspace.id, join(workspacesRoot(), workspace.id), producers.roots));
    }
    if (hostCatalogs) {
      const databases = await physicalDatabaseCensusEntries(sql);
      catalogEntries.push(...databases);
      declarations.push(...integrationBaselineCensusDeclarations(databases));
      if (databases.length) declarations.push(...await maintenanceDatabaseCensusDeclarations(sql, databases[0].root));
      if (databases.length) declarations.push(...await templateDatabaseCensusDeclarations(sql, databases[0].root));
      if (databases.length) declarations.push(...configuredOperatorDatabaseCensusDeclarations(databases[0].root, getHarnessAdminUrl()));
      const unitDeclarations = [];
      for (const scope of ['user', 'system'] as const) {
        catalogEntries.push(...await unitCensusEntries(scope));
        unitDeclarations.push(...await installedUnitCensusDeclarations(scope));
      }
      migrationSources.push(...await registeredProjectMigrationSources([], unitDeclarations));
      declarations.push(...unitDeclarations, ...await unitDatabaseCensusDeclarations(unitDeclarations, databases, getHarnessAdminUrl(), producers.roots.map(root => root.path)));
      // Catalog only declared secret paths that exist; never read their values.
      // Unknown secret locations still appear as filesystem residue.
      const secretPaths = producers.declarations.filter(entry => entry.classification === 'secret');
      for (const declaration of secretPaths.filter((entry, index) => secretPaths.findIndex(other =>
        other.root === entry.root && other.name === entry.name) === index)) {
        const root = producers.roots.find(entry => entry.id === declaration.root)!;
        try { await lstat(join(root.path, declaration.name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const entry: CensusEntry = { kind: 'secret', root: declaration.root, name: declaration.name };
        catalogEntries.push(entry);
        declarations.push({ ...declaration, kind: 'secret' });
      }
    }
  } finally { await sql.end(); }
}
await options.onDiscoverySnapshot?.({ phase: 'before-filesystem',
  ...structuredClone({ roots: producers.roots, declarations, catalogEntries }) });
stage('filesystem-storage-markers');
const recordPeerStorage = async (root: CensusRoot, name: string, harnessContainer?: string) => {
  declarations.push(await peerStorageDeclaration(root, name));
  // getHarnessStore creates .papercusp/<harness>/hyperbee recursively. Once
  // that exact direct store proves its writer, its immediate container is
  // writer-owned too. This owns only the directory entry: copied app parents
  // and unrelated children still need independent evidence.
  if (harnessContainer) declarations.push({ kind: 'path', root: root.id, name: harnessContainer,
    classification: 'state', producer: 'harness-corestore-container' });
  const advisoryLock = await corestoreAdvisoryLockDeclaration(root, name);
  if (advisoryLock) declarations.push(advisoryLock);
};
for (const [rootIndex, root] of producers.roots.entries()) {
  stage(`filesystem-root-${rootIndex}:postgres-markers`);
  const topLevel = await readdir(root.path, { withFileTypes: true });
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    try { await lstat(join(root.path, directory.name, 'PG_VERSION')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push(await postgresStorageDeclaration(root, directory.name));
  }
  // Bounded marker discovery in the home and its direct artifact containers.
  // Symlinks and retained trees are not followed or reclassified.
  stage(`filesystem-root-${rootIndex}:virtualenv-markers`);
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    // The census already represents these writer-owned caches at their roots.
    // Looking inside them can enumerate arbitrarily large spill/build trees
    // and mistakes cached copies of producer markers for installed storage.
    if (declarations.some(entry => entry.kind === 'path' && entry.root === root.id &&
      entry.name === directory.name && entry.descendants && entry.prune && !entry.anyDepth)) continue;
    const children = await readdir(join(root.path, directory.name), { withFileTypes: true });
    const candidates = [directory.name, ...children.filter(entry => entry.isDirectory()).map(entry => `${directory.name}/${entry.name}`)];
    for (const name of candidates) {
      try { await lstat(join(root.path, name, 'pyvenv.cfg')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      declarations.push(await virtualenvCacheDeclaration(root, name));
    }
  }
  stage(`filesystem-root-${rootIndex}:git-markers`);
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
  stage(`filesystem-root-${rootIndex}:workspace-layouts`);
  const workspacePrefix = relative(root.path, workspacesRoot());
  const ownsWorkspaces = !workspacePrefix.startsWith('..') && !wor
