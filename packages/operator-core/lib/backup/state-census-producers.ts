import { dirname, basename, relative, resolve, sep, join, isAbsolute, win32 } from 'node:path';
import type { CensusDeclaration, CensusRoot, CensusEntry } from '@papercusp/backup';
import { collectStateCensus, assertStateCensusComplete } from '@papercusp/backup';
import type { Sql } from 'postgres';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { readdir, readFile, lstat, open } from 'node:fs/promises';
import { dbEncryptionKeyFilePath } from '../db-encryption';
import { superuserTokenPath } from '../superuser-token';
import { workspacesRoot, readRegistry } from '../workspace-registry';
import { scratchRoot } from '../scratch-uri';
import { googleOAuthClientPath } from '../oauth/providers';

/** Compose independent writers without traversing the same physical root twice. */
export function installedRootCensusProducers() {
  const producers = [workspaceRegistryCensusProducer(), secretCensusProducers(), scratchCensusProducer(), stripRangeCacheCensusProducer()];
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const producer of producers) {
    const aliases = new Map<string, string>();
    for (const source of producer.roots) {
      let root = roots.find(candidate => candidate.path === source.path);
      if (!root) { root = { ...source, id: `install-root-${roots.length}` }; roots.push(root); }
      aliases.set(source.id, root.id);
    }
    for (const declaration of producer.declarations) {
      const root = aliases.get(declaration.root);
      if (!root) throw new Error('Census declaration has no producer root');
      declarations.push({ ...declaration, root });
    }
  }
  return mergeNestedCensusRoots({ roots, declarations });
}

/** Parent roots already walk descendants; preserve child ownership by prefixing names. */
export function mergeNestedCensusRoots(input: { roots: CensusRoot[]; declarations: CensusDeclaration[] }) {
  const normalized = input.roots.map(root => ({ ...root, path: resolve(root.path) }));
  const contains = (parent: CensusRoot, child: CensusRoot) => {
    const suffix = relative(parent.path, child.path);
    return !suffix || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !suffix.startsWith(sep));
  };
  const roots = normalized.filter((root, index) => !normalized.some((other, otherIndex) =>
    otherIndex !== index && contains(other, root) && (other.path !== root.path || otherIndex < index)));
  const declarations = input.declarations.map(declaration => {
    const source = normalized.find(root => root.id === declaration.root);
    if (!source) throw new Error('Census declaration has no root');
    const parent = roots.find(root => contains(root, source));
    if (!parent) throw new Error('Census root merge failed');
    const prefix = relative(parent.path, source.path).split(sep).join('/');
    return { ...declaration, root: parent.id, name: prefix ? `${prefix}/${declaration.name}` : declaration.name };
  });
  return { roots, declarations };
}

/** Result spills are rebuildable, using the actual relocated scratch writer root. */
export function scratchCensusProducer() {
  const path = scratchRoot();
  const root: CensusRoot = { id: 'scratch-parent', path: dirname(path) };
  const declaration: CensusDeclaration = {
    kind: 'path', root: root.id, name: basename(path), classification: 'cache',
    producer: 'scratch-uri', descendants: true, prune: true,
  };
  return { roots: [root], declarations: [declaration] };
}

/** Same relocated compile-analysis cache used by strip-comments-and-strings. */
export function stripRangeCacheCensusProducer() {
  const path = process.env.PAPERCUSP_STRIP_CACHE_DIR || join(homedir(), '.papercusp', 'cache', 'strip-ranges');
  return { roots: [{ id: 'strip-range-cache-parent', path: dirname(path) }], declarations: [{
    kind: 'path' as const, root: 'strip-range-cache-parent', name: basename(path),
    classification: 'cache' as const, producer: 'strip-comments-and-strings', descendants: true, prune: true,
  }] };
}

/** Registry producer's real relocated root, not the operator's remapped HOME. */
export function workspaceRegistryCensusProducer() {
  const root: CensusRoot = { id: 'workspace-registry', path: workspacesRoot() };
  const declaration: CensusDeclaration = {
    kind: 'path', root: root.id, name: 'registry.json',
    classification: 'config', producer: 'workspace-registry',
  };
  // The registry is the producer authority for directory names. Classify only
  // directory entries here: their contents still require their own producers.
  const workspaceDirectories: CensusDeclaration[] = readRegistry().workspaces.map(workspace => ({
    kind: 'path', root: root.id, name: workspace.id,
    classification: 'state', producer: 'workspace-registry',
  }));
  return { roots: [root], declarations: [declaration, ...workspaceDirectories] };
}

/** Derive secret locations from their writers, including relocated mounted keys. */
export function secretCensusProducers() {
  const paths = [
    { path: dbEncryptionKeyFilePath(), producer: 'db-encryption' },
    { path: superuserTokenPath(), producer: 'superuser-token' },
    { path: googleOAuthClientPath(), producer: 'google-oauth-desktop-client' },
  ];
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const { path, producer } of paths) {
    const directory = dirname(path);
    let root = roots.find(candidate => candidate.path === directory);
    if (!root) {
      root = { id: `secret-directory-${roots.length}`, path: directory };
      roots.push(root);
    }
    declarations.push({ kind: 'path', root: root.id, name: basename(path),
      classification: 'secret', producer });
  }
  return { roots, declarations };
}

/**
 * Read the actual cluster catalog, including disconnected databases. Classification
 * belongs to each database producer; an unexpected DB remains census residue.
 * Cluster identity is supplied explicitly so equal names on two clusters never alias.
 */
export async function databaseCensusEntries(sql: Sql, clusterIdentity: string): Promise<CensusEntry[]> {
  if (!clusterIdentity.trim()) throw new Error('Missing census cluster identity');
  const rows = await sql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname
  `;
  return rows.map(row => ({ kind: 'database', root: clusterIdentity, name: row.datname }));
}

/** Resolve the same physical cluster identity used by backup receipt coverage. */
export async function physicalDatabaseCensusEntries(sql: Sql) {
  const rows = await sql<{ system_identifier: string }[]>`
    SELECT system_identifier::text FROM pg_control_system()
  `;
  const identity = rows[0]?.system_identifier;
  if (!identity || !/^\d+$/.test(identity)) throw new Error('Unavailable physical database cluster identity');
  return databaseCensusEntries(sql, `postgres-cluster:${identity}`);
}

/** Only the exact integration-baseline identity shape emitted by its producer. */
export function integrationBaselineCensusDeclarations(entries: readonly CensusEntry[]): CensusDeclaration[] {
  return entries.filter(entry => entry.kind === 'database' &&
    /^papercusp_it_baseline_[0-9a-f]{12}$/.test(entry.name)).map(entry => ({
      ...entry, classification: 'dev-only', producer: 'baseline-schema-global-setup',
    }));
}

const execFileAsync = promisify(execFile);
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
export async function installedUnitCensusDeclarations(scope: 'user' | 'system'): Promise<CensusDeclaration[]> {
  if (process.platform !== 'linux') throw new Error('Systemd census requires Linux');
  const runtime = scope === 'system' ? '/run/systemd' : `/run/user/${process.getuid!()}/systemd`;
  const sources = scope === 'system'
    ? ['/usr/lib/systemd/system', '/etc/systemd/system', '/run/systemd/system']
    : [join(homedir(), '.config/systemd/user'), '/usr/lib/systemd/user', '/etc/systemd/user'];
  sources.push(...['generator', 'generator.early', 'generator.late', 'transient'].map(name => join(runtime, name)));
  const declarations: CensusDeclaration[] = [];
  for (const source of sources) {
    try { await lstat(source); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push(...await unitCensusDeclarations(source, scope, source === join(runtime, 'transient') ? 'dev-only' : 'config'));
  }
  return declarations;
}
/** Installed units, not just currently running services; no shell parsing. */
export async function unitCensusEntries(
  scope: 'user' | 'system',
  read: () => Promise<string> = async () => (await execFileAsync('systemctl', [
    ...(scope === 'user' ? ['--user'] : []), 'list-unit-files', '--output=json', '--no-pager',
  ], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
): Promise<CensusEntry[]> {
  const rows: unknown = JSON.parse(await read());
  if (!Array.isArray(rows)) throw new Error('Invalid unit census catalog');
  return rows.map(row => {
    if (!row || typeof row !== 'object' || !('unit_file' in row) ||
      typeof row.unit_file !== 'string' || !row.unit_file.trim()) {
      throw new Error('Invalid unit census entry');
    }
    return { kind: 'unit', root: `systemd-${scope}`, name: row.unit_file };
  });
}

/** Host integration route; declarations come from producers, never observed names. */
export async function verifyHostStateCensus(input: {
  roots: readonly CensusRoot[];
  declarations: readonly CensusDeclaration[];
  readDatabases: () => Promise<readonly CensusEntry[]>;
  readUnits: () => Promise<readonly CensusEntry[]>;
  readSecrets: () => Promise<readonly CensusEntry[]>;
}) {
  const census = await collectStateCensus({
    roots: input.roots, declarations: input.declarations,
    readCatalogs: async () => {
      const catalogs = await Promise.all([
        input.readDatabases(), input.readUnits(), input.readSecrets(),
      ]);
      return catalogs.flat();
    },
  });
  assertStateCensusComplete(census);
  return census;
}
