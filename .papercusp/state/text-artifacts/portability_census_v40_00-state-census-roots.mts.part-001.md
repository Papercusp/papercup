---
rel_path: "portability/census/v40/00-state-census-roots.mts.part-001"
updated_at: 1794240912951
_body: "content"
---

stage names only: callers can time or retain progress without logging
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
  const ownsWorkspaces = !workspacePrefix.startsWith('..') && !workspacePrefix.startsWith('/');
  const workspaces = ownsWorkspaces ? await readdir(workspacesRoot(), { withFileTypes: true }) : [];
  const layouts = workspaces.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, direct: true }));
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
        layouts.push({ name, direct: false });
        if (layouts.length > 1000) throw new Error('Recovery layout census bound exceeded');
      }
    }
  }
  stage(`filesystem-root-${rootIndex}:workspace-storage`);
  for (const workspace of layouts) {
    const parent = join(workspacesRoot(), workspace.name, '.papercusp');
    let harnesses;
    try {
      // A linked .papercusp is not this workspace writer's directory entry.
      if (!(await lstat(parent)).isDirectory()) continue;
      harnesses = await readdir(parent, { withFileTypes: true });
    }
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
      try {
        const source = await readFile(join(root.path, appName, 'packages', 'data', 'src', 'migrations.ts'), 'utf8');
        const tables = migrationProducerTables(source);
        if (tables.length >= 2) migrationSources.push({ producer: `app-migrations:${root.id}:${appName}`, tables });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let hasGit = false;
      try { await lstat(join(root.path, appName, '.git')); hasGit = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (hasGit) {
        // Full preservation includes untracked state; avoid a competing nested
        // cache override that would invalidate this opaque worktree manifest.
        declarations.push(await gitStorageDeclaration(root, appName, true));
        continue;
      }
      // Retained app copies can contain the same producer-owned stores as the
      // direct harness layout. Require the device marker at the exact path;
      // the enclosing copy remains residue unless independently accounted for.
      for (const store of ['hyperbee', 'hyperbee-scoped']) {
        const name = `${appName}/${store}`;
        try { await lstat(join(root.path, name, 'CORESTORE')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  
