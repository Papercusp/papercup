/** Shared admission proof for maintained, independently materialized dependencies.
 * Reuses the publisher's input and tree fingerprints, including its deliberate
 * exclusion of npm's ephemeral hidden lock. No install metadata is synthesized.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { promisify } from 'node:util';

let execMemo: typeof execFile.__promisify__ | null = null;
const exec = ((...args: unknown[]) =>
  Reflect.apply((execMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const HEX = /^[0-9a-f]{64}$/;
const safe = (path: string) => path.length > 0 && !path.startsWith('/')
  && !path.split('/').some(p => !p || p === '.' || p === '..') && !/[\x00-\x1f\\]/.test(path);

export interface DependencyLockEntry { name?: string; version?: string; link?: boolean; optional?: boolean;
  resolved?: string; integrity?: string }

async function shell(root: string, script: string, ...args: string[]) {
  const result = await exec('bash', ['-euo', 'pipefail', '-c',
    'source "$1"; shift; ' + script, 'dependency-generation-proof',
    join(root, 'apps/operator/bin/release/dependency-generation.sh'), ...args],
  { maxBuffer: 64 * 1024 * 1024 });
  return result.stdout.trimEnd();
}
function fields(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.trim().split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0 || result.has(line.slice(0, at))) throw new Error('invalid dependency marker');
    result.set(line.slice(0, at), line.slice(at + 1));
  }
  return result;
}

/** Verify both the immutable publication and its copy-normalized materialization.
 * Consumers can repeat assertUnchanged after their own census/security checks.
 */
export async function bindFrozenDependencyGeneration(root: string, sourceCommit: string) {
  const marker = fields(await readFile(join(root, 'node_modules/.papercusp-dependency-generation'), 'utf8'));
  const dependencyGeneration = marker.get('identity') ?? '';
  if (!/^v1-[0-9a-f]{64}$/.test(dependencyGeneration)) throw new Error('invalid frozen dependency generation');
  // Verification must not create ignored bookkeeping in the clean source tree.
  const generationRoot = await shell(root, 'dependency_generation_resolve_root "$1" "" 1', root);
  const generation = join(generationRoot, dependencyGeneration);
  const dependencyInputSha256 = await shell(root, 'dependency_generation_input_fingerprint_ref "$1" "$2"', root, sourceCommit);
  if (!HEX.test(dependencyInputSha256)) throw new Error('invalid committed dependency input fingerprint');
  const selector = fields(await readFile(join(generationRoot, '.inputs', dependencyInputSha256), 'utf8'));
  const publication = fields(await readFile(join(generation, '.papercusp-dependency-generation'), 'utf8'));
  if (selector.get('input') !== dependencyInputSha256 || selector.get('identity') !== dependencyGeneration ||
      publication.get('identity') !== dependencyGeneration || publication.get('scope') !== 'full' ||
      marker.get('source') !== publication.get('source')) throw new Error('frozen dependency input/generation mismatch');
  await shell(root, 'dependency_generation_select_prevalidated "$1" "$2" "$3"', generationRoot,
    dependencyGeneration, selector.get('token') ?? '');
  const assertSnapshot = async () => {
    const result = await shell(root, 'dependency_generation_set_fingerprint "$1"', join(generation, 'tree'));
    if (!HEX.test(result) || result !== publication.get('snapshot')) throw new Error('published dependency generation drift');
    return result;
  };
  const dependencyGenerationSnapshotSha256 = await assertSnapshot();
  const trees = (await shell(root, 'dependency_generation_enumerate_node_modules "$1"', join(generation, 'tree')))
    .split('\n').filter(Boolean).map(path => relative(join(generation, 'tree'), path).split('\\').join('/')).sort();
  if (!trees.includes('node_modules') || trees.some(tree => !safe(tree))) throw new Error('invalid generation tree census');
  const materialized = (await shell(root, 'dependency_generation_enumerate_node_modules "$1"', root))
    .split('\n').filter(Boolean).map(path => relative(root, path).split('\\').join('/')).sort();
  if (JSON.stringify(trees) !== JSON.stringify(materialized)) throw new Error('materialized generation tree census mismatch');
  const projection = async (tree: string) => shell(root,
    'record=$(mktemp); trap \'rm -f "$record" "$record.unsorted"\' EXIT; ' +
    'dependency_generation_source_records "$1" "$record"; ' +
    'dependency_generation_records_projection "$record" | ' +
    'awk -F "\\t" \'$1 != ".papercusp-dependency-generation" && $1 != ".papercusp-source-package-lock.json"\'', tree);
  const projections: [string, string][] = [];
  const links: string[] = [];
  for (const tree of trees) {
    const isolated = fields(await readFile(join(root, tree, '.papercusp-isolated-snapshot'), 'utf8'));
    if (isolated.get('generation') !== dependencyGeneration) throw new Error('materialized dependency pin mismatch');
    const original = await projection(join(generation, 'tree', tree));
    if (await projection(join(root, tree)) !== original) throw new Error(`materialized dependency tree drift: ${tree}`);
    projections.push([tree, hash(original)]);
    for (const line of original.split('\n')) {
      const [path, kind] = line.split('\t');
      if (kind === 'l') links.push(posix.join(tree, path));
    }
  }
  const manifest = await shell(root, 'dependency_generation_input_manifest_ref "$1" "$2" | LC_ALL=C sort', root, sourceCommit);
  const locks: { path: string; packages: Record<string, DependencyLockEntry> }[] = [];
  for (const line of manifest.split('\n')) {
    const [path, digest] = line.split('\t');
    if (!safe(path) || !HEX.test(digest)) throw new Error('invalid committed dependency manifest');
    const bytes = await readFile(join(root, path));
    if (hash(bytes) !== digest) throw new Error('committed dependency input changed');
    if (/\/(package-lock|npm-shrinkwrap)\.json$/.test('/' + path)) {
      const lock = JSON.parse(bytes.toString());
      if (!lock.packages || typeof lock.packages !== 'object') throw new Error('committed lock packages map required');
      locks.push({ path, packages: lock.packages });
    }
  }
  const assertUnchanged = async () => {
    await assertSnapshot();
    for (const [tree, digest] of projections) {
      if (hash(await projection(join(root, tree))) !== digest) throw new Error('materialized dependency tree changed while binding');
    }
  };
  await assertUnchanged();
  return { identity: { dependencyInputSha256, dependencyGeneration, dependencyGenerationSnapshotSha256,
    materializedTreesSha256: hash(JSON.stringify(projections)) }, trees, links, locks, assertUnchanged };
}
