import { dirname, basename, relative, resolve, sep } from 'node:path';
import type { CensusDeclaration, CensusRoot, CensusEntry } from '@papercusp/backup';
import { collectStateCensus, assertStateCensusComplete } from '@papercusp/backup';
import type { Sql } from 'postgres';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { dbEncryptionKeyFilePath } from '../db-encryption';
import { superuserTokenPath } from '../superuser-token';
import { workspacesRoot, readRegistry } from '../workspace-registry';
import { scratchRoot } from '../scratch-uri';

/** Compose independent writers without traversing the same physical root twice. */
export function installedRootCensusProducers() {
  const producers = [workspaceRegistryCensusProducer(), secretCensusProducers(), scratchCensusProducer()];
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

const execFileAsync = promisify(execFile);
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
