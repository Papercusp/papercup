---
rel_path: "portability/census/v40/00-state-census-roots.mts.part-002"
updated_at: 1794240912951
_body: "content"
---

      await recordPeerStorage(root, name);
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
        await recordPeerStorage(root, name, pgName);
        if (workspace.direct) {
          // The direct Corestore writer mkdirs this entire path recursively.
          // Own the two exact ancestor entries, without claiming descendants
          // or inferring ownership of restored snapshot/clone containers.
          const workspaceName = [workspacePrefix, workspace.name].filter(Boolean).join('/');
          for (const ancestor of [workspaceName, `${workspaceName}/.papercusp`]) {
            declarations.push({ kind: 'path', root: root.id, name: ancestor,
              classification: 'state', producer: 'harness-corestore-container' });
          }
        }
      }
    }
  }
  // Derive the container from the clone writer, including relocated workspace roots.
  stage(`filesystem-root-${rootIndex}:clone-storage`);
  const clonePath = defaultClonesDir();
  const clonePrefix = relative(root.path, clonePath).split(sep).join('/');
  let clones;
  if (clonePrefix && clonePrefix !== '..' && !clonePrefix.startsWith('../') && !isAbsolute(clonePrefix)) {
    try { clones = await readdir(clonePath, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (clones) declarations.push({ kind: 'path', root: root.id, name: clonePrefix, classification: 'state', producer: 'clone-github-container' });
  }
  for (const clone of clones ?? []) {
    if (!clone.isDirectory()) continue;
    try { await lstat(join(clonePath, clone.name, '.git')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // Entire worktree is carried, including untracked files and linked pointers.
    declarations.push(await gitStorageDeclaration(root, `${clonePrefix}/${clone.name}`, true));
  }
  stage(`filesystem-root-${rootIndex}:shared-postgres-storage`);
  let children;
  try { children = await readdir(join(root.path, '.shared'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  for (const child of children) {
    if (child.isDirectory() && child.name.startsWith('embedded-pg-data')) {
      declarations.push(await postgresStorageDeclaration(root, `.shared/${child.name}`));
    }
  }
}
if (hostCatalogs && migrationSources.length) {
  stage('migration-database-columns');
  const operatorUrl = getHarnessAdminUrl();
  for (const database of catalogEntries.filter(entry => entry.kind === 'database' &&
    !declarations.some(declaration => declaration.kind === 'database' && declaration.root === entry.root && declaration.name === entry.name))) {
    const url = new URL(operatorUrl);
    url.pathname = `/${encodeURIComponent(database.name)}`;
    const sql = postgres(url.toString(), { max: 1, connect_timeout: 5 });
    try {
      const rows = await readMigrationCensusColumns(sql, migrationSources);
      declarations.push(...migrationDatabaseCensusDeclarations(database,
        [...new Set(rows.map(row => `${row.table_schema}.${row.table_name}`))], migrationSources,
        rows.map(row => ({ table: `${row.table_schema}.${row.table_name}`, name: row.column_name, type: row.data_type, udtSchema: row.udt_schema, udtName: row.udt_name }))));
    } finally { await sql.end(); }
  }
}
stage('discovery-complete');
return {
  scope: hostCatalogs ? 'implemented-writer-filesystem-roots-and-host-catalogs' : 'implemented-writer-filesystem-roots-only', wholeInstallVerified: false,
  roots: producers.roots, declarations, catalogEntries,
};
}

/** Canonical executable: discovery and collection retain the same drift contract. */
export async function runRootCensus(options: RootCensusOptions = {}) {
  const inputs = await discoverRootCensusInputs(options);
  options.onStage?.('collect-state-census');
  const census = await collectStateCensus({ roots: inputs.roots, declarations: inputs.declarations,
    representUnknownSubtrees: true, readCatalogs: async () => inputs.catalogEntries });
  options.onStage?.('complete');
  return { scope: inputs.scope, wholeInstallVerified: false, roots: inputs.roots, ...census };
}

if (isCliEntry(import.meta.url)) {
  const census = await runRootCensus({ args: process.argv.slice(2) });
  console.log(JSON.stringify(census, null, 2));
  if (!census.ok) process.exitCode = 1;
}

