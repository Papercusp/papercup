---
rel_path: "portability/census/v41/01-state-census-producers.ts.part-009"
updated_at: 1794241756285
_body: "content"
---

   const type = sqlType === 'timestamptz' ? 'timestamp with time zone'
        : sqlType === 'timestamp' ? 'timestamp without time zone' : sqlType;
      tableColumns.push({ table, name: normalize(column[1]), type });
    }
    if (!tableColumns.length) return null;
    tables.push(table);
    columns.push(...tableColumns);
  }
  return tables.length >= 2 ? { producer, tables, columns } : null;
}

export async function canonicalSqlMigrationCensusSources(): Promise<MigrationCensusSource[]> {
  const directory = resolveSqlDir();
  if (!directory) return [];
  const sources: MigrationCensusSource[] = [];
  for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    const source = sqlMigrationCensusSource(await readFile(join(directory, name), 'utf8'), `canonical-sql-migration:${name}`);
    if (source) sources.push(source);
  }
  return sources;
}

export function migrationDatabaseCensusDeclarations(entry: CensusEntry, observedTables: readonly string[], sources: readonly MigrationCensusSource[], observedColumns: readonly MigrationCensusColumn[] = []): CensusDeclaration[] {
  if (entry.kind !== 'database' || !/^postgres-cluster:\d+$/.test(entry.root)) throw new Error('Missing physical migration database identity');
  return sources.flatMap(source => {
    let prefix = 0;
    while (prefix < source.tables.length && observedTables.includes(source.tables[prefix]) &&
      (!source.columns || source.columns.filter(column => column.table === source.tables[prefix]).every(column =>
        observedColumns.some(observed => observed.table === column.table && observed.name === column.name && observed.type === column.type &&
          (!column.udtName || (observed.udtSchema === column.udtSchema && observed.udtName === column.udtName)))))) prefix++;
    return prefix < 2 ? [] : [{ ...entry, classification: 'state' as const,
      producer: prefix === source.tables.length ? source.producer : `${source.producer}:migration-prefix:${prefix}/${source.tables.length}` }];
  });
}
/** Python/uv's environment marker and generated interpreter/package layout.
 * The directory name alone never establishes rebuildable ownership.
 */
export async function virtualenvCacheDeclaration(root: CensusRoot, name: string): Promise<CensusDeclaration> {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid virtualenv path');
  const path = join(root.path, name);
  if (!(await lstat(path)).isDirectory()) throw new Error('Invalid virtualenv directory');
  const handle = await open(join(path, 'pyvenv.cfg'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384) throw new Error('Invalid virtualenv marker');
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const fields = new Map(text.trim().split(/\r?\n/).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  const version = (fields.get('version') ?? fields.get('version_info'))?.match(/^(\d+\.\d+)\.\d+$/)?.[1];
  const home = fields.get('home');
  if (!version || !home || !(isAbsolute(home) || win32.isAbsolute(home)) ||
    !['true', 'false'].includes(fields.get('include-system-site-packages') ?? '')) throw new Error('Invalid virtualenv marker');
  let windows = false;
  try { await lstat(join(path, 'bin', 'python')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!(await lstat(join(path, 'Scripts', 'python.exe'))).isFile()) throw new Error('Invalid virtualenv interpreter');
    windows = true;
  }
  if (!(await lstat(windows ? join(path, 'Lib', 'site-packages') : join(path, 'lib', `python${version}`, 'site-packages'))).isDirectory()) throw new Error('Invalid virtualenv packages');
  return { kind: 'path', root: root.id, name, classification: 'cache', producer: 'python-virtualenv', descendants: true, prune: true };
}
/** Restore-to-clone completion is producer provenance, not byte certification.
 * A latest started/failed event never authorizes an opaque completed clone.
 */
export async function restoredCloneCensusDeclarations(sql: Sql, workspaceId: string, workspacePath: string, roots: readonly CensusRoot[]): Promise<CensusDeclaration[]> {
  const rows = await sql<{ id: string; target: string; phase: string }[]>`
    SELECT DISTINCT ON (payload_json->>'target') id::text,
      payload_json->>'target' AS target, payload_json->>'phase' AS phase
    FROM harness_shared.backup_events
    WHERE workspace_id = ${workspaceId} AND kind = 'restore'
      AND starts_with(payload_json->>'target', ${join(workspacePath, '.restored') + sep})
    ORDER BY payload_json->>'target', id DESC LIMIT 1001
  `;
  if (rows.length > 1000) throw new Error('Restore event census bound exceeded');
  const declarations: CensusDeclaration[] = [];
  for (const row of rows) {
    if (row.phase !== 'done') continue;
    const clone = relative(join(workspacePath, '.restored'), row.target);
    if (clone.split(sep).length !== 2 || clone.split(sep).some(part => !part || part === '.' || part === '..')) continue;
    const root = roots.find(candidate => {
      const suffix = relative(candidate.path, row.target);
      return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
    });
    if (!root || !/^\d+$/.test(row.id)) throw new Error('Unqualified restore census evidence');
    try { if (!(await lstat(row.target)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push({ kind: 'path', root: root.id, name: relative(root.path, row.target).split(sep).join('/'),
      classification: 'state', producer: 'workspace-backup-restore-to-clone', descendants: true,
      recoveryStorage: { restoreEventId: row.id, evidenceRef: `backup-restore-event:${workspaceId}:${row.id}` } });
  }
  return declarations;
}
/** Published generations are retained install state, including rollback artifacts.
 * Build provenance does not certify the bytes of a running or exported snapshot.
 */
export async function portalReleaseStorageDeclaration(root: CensusRoot, name: string): Promise<CensusDeclaration> {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid release storage path');
  }
  const path = join(root.path, name);
  if (!(await lstat(path)).isDirectory()) throw new Error('Invalid release storage directory');
  const handle = await open(join(path, '.papercusp-release.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384) throw new Error('Invalid release manifest');
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const manifest = JSON.parse(text);
  if (![1, 2].includes(manifest.schemaVersion) || manifest.release !== basename(name) ||
    typeof manifest.buildId !== 'string' || !manifest.buildId.trim() ||
    (manifest.schemaVersion === 2 && (typeof manifest.sourceRoot !== 'string' ||
      !(isAbsolute(manifest.sourceRoot) || win32.isAbsolute(manifest.sourceRoot)))) ||
    typeof manifest.publishedAt !== 'string' || !Number.isFinite(Date.parse(manifest.publishedAt))) {
    throw new Error(`Invalid release manifest: ${name}`);
  }
  if (!(await lstat(join(path, 'standalone-entry.mjs'))).isFile()) throw new Error('Missing release entry');
  return { kind: 'path', root: root.id, name, classification: 'state', producer: 'portal-standalone-publish',
    descendants: true, releaseStorage: { manifestSha256: createHash('sha256').update(text).digest('hex'),
      evidenceRef: `portal-release-manifest:${root.id}:${name}` } };
}
/** Read producer evidence without booting Corestore, acquiring its lock, or healing it.
 * The marker hash identifies this observation, not database contents or a portable key.
 */
export async function peerStorageDeclaration(root: CensusRoot, name: string): Promise<CensusDeclaration> {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid peer storage path');
  }
  const path = join(root.path, name);
  if (!(await lstat(path)).isDirectory() || !(await lstat(join(path, 'db'))).isDirectory()) {
    throw new Error('Invalid peer storage directory');
  }
  const handle = await open(join(path, 'CORESTORE'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let marker: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid peer storage marker');
    marker = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const fields = new Map<string, string>();
  for (const line of marker.trim().split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1 || fields.has(line.slice(0, separator))) throw new Error('Invalid peer storage marker');
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (!['linux', 'darwin', 'win32'].includes(fields.get('device/platform') ?? '') ||
    !/^\d+$/.test(fields.get('device/inode') ?? '') || !/^\d+$/.test(fields.get('device/created') ?? '')) {
    throw new Error('Invalid peer storage marker');
  }
  return { kind: 'path', root: root.id, name, classification: 'state', producer: 'corestore-device-file',
    descendants: true, peerStorage: { markerSha256: createHash('sha256').update(marker).digest('hex'),
      evidenceRef: `corestore-marker:${root.id}:${name}` } };
}
/** Preserve metadata only after Git confirms this exact directory owns it. */
export async function gitStorageDeclaration(root: CensusRoot, repositoryName: string, preserveWorktree = false): Promise<CensusDeclaration> {
  if (repositoryName.startsWith('/') || repositoryName.split('/').some(segment => segment === '..')) throw new Error('Invalid repository path');
  const repository = join(root.path, repositoryName);
  const options = { timeout: 5000, maxBuffer: 64 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const { stdout: gitDirectory } = await execFileAsync('git', ['-C', repository, 'rev-parse', '--absolute-git-dir'], options);
  const actualGit = resolve(gitDirectory.trim());
  if (actualGit !== resolve(repository, '.git')) {
    const pointer = await lstat(join(repository, '.git'));
    const common = (await execFileAsync('git', ['-C', repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'], options)).stdout.trim();
    const withinRoot = relative(root.path, resolve(common));
    if (!pointer.isFile() || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)) {
      throw new Error('Repository metadata outside declared root');
    }
    // Pointer is state, common metadata is owned by its primary repository.
    // Never collapse the pointer as though it contained that external subtree.
    if (!preserveWorktree) return { kind: 'path', root: root.id, name: `${repositoryName}/.git`, classification: 'state', producer: 'git-worktree-pointer' };
  }
  const { stdout } = await execFileAsync('git', ['-C', repository, 'rev-parse', '--verify', 'HEAD'], options);
  const head = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('Repository HEAD unavailable');
  return { kind: 'path', root: root.id, name: preserveWorktree ? repositoryName : `${repositoryName}/.git`, classification: 'state',
    producer: preserveWorktree ? 'clone-github-preserved-worktree' : 'git-control', descendants: true,
    gitStorage: { head, evidenceRef: `git-head:${root.id}:${repositoryName}` } };
}
/** Recognized PG storage is retained state with a measured control-file identity. */
export async function postgresStorageDeclaration(root: CensusRoot, name: string): Promise<CensusDeclaration> {
  if (name.startsWith('/') || name.split('/').some(segment => segment === '..')) throw new Error('Invalid PG storage path');
  const path = join(root.path, name);
  const version = (await readFile(join(path, 'PG_VERSION'), 'utf8')).trim();
  if (!/^\d+$/.test(version)) throw new Error('Invalid PG storage version');
  const binary = `/usr/lib/postgresql/${version}/bin/pg_controldata`;
  const { stdout } = await execFileAsync(binary, [path], {
    timeout: 5000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' },
  });
  const identity = stdout.match(/^Database system identifier:\s+(\d+)$/m)?.[1];
  if (!identity) throw new Error('PG storage control identity unavailable');
  return { kind: 'path', root: root.id, name, classification: 'state', producer: 'postgres-control',
    descendants: true, databaseStorage: { systemIdentifier: identity, evidenceRef: `pg-control:${root.id}:${name}` } };
}
/** Unit definitions supplied by an installer source, independent of live inventory. */
export async function unitCensusDeclarations(
  sourceDirectory: string, scope: 'user' | 'system',
  classification: 'config' | 'dev-only' = 'config',
) {
  const files = await readdir(sourceDirectory, { withFileTypes: true });
  // Unit aliases/masks are producer-owned configuration too; do not follow them
  // (a masked unit points at /dev/null and a broken alias still needs transport).
  return files.filter(file => (file.isFile() || file.isSymbolicLink()) && /\.(service|timer|socket|target|path|slice|scope|mount|automount|swap|device)$/.test(file.name))
    .map(file => ({ kind: 'unit' as const, root: `systemd-${scope}`, name: file.name,
      classification, producer: `unit-definition:${sourceDirectory}` }));
}

/** Service-manager source directories, shared by unit and whole-host diagnostics. */
export async function installedUnitCensusDeclarations(
  scope: 'user' | 'system',
  readUnitPaths: (sco
