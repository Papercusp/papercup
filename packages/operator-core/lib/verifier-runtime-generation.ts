/** Read the original verifier-command handoff and independently measure the
 * published and installed dependencies. Retain an interval witness in the
 * measuring process so synchronous callers only perform filesystem reads. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVerifierSourceReceiptSync, verifierSourceFiles, type VerifierSourceFile } from '@papercusp/test-config/verifier-source';
import { verifierRuntimeHandoffSha256 } from '../../../scripts/lib/runtime-compatibility.mjs';
import { bindFrozenDependencyGeneration } from './dependency-generation-proof.ts';
import { readProcessGroupId, readProcessIdentity } from './process-identity.ts';

const toolingRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const copyMetadata = ['.papercusp-dependency-generation', '.papercusp-source-package-lock.json'];

function outside(root: string, path: string) {
  const local = relative(root, path);
  return local === '..' || local.startsWith('..' + sep) || isAbsolute(local);
}

export async function bindVerifierRuntimeGeneration(root: string) {
  const { VERIFY_TAURI_SOURCE_RECEIPT: receipt, VERIFY_TAURI_SOURCE_REF: ref,
    PAPERCUSP_VERIFIER_RUNTIME_HANDOFF_SHA256: handoff } = process.env;
  assert(receipt && ref && handoff && isAbsolute(root) && realpathSync(root) === root);
  assert.equal(realpathSync(process.env.PAPERCUSP_REPO_DIR ?? ''), root, 'runtime is outside the verifier command');
  const originals = new Map<string, string>();
  const physical = (path: string) => {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stat ? [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : 'absent';
  };
  const retain = (path: string) => {
    if (!originals.has(path)) originals.set(path, physical(path));
  };
  const retainLocal = (base: string, local: string) => {
    assert(local && !isAbsolute(local) && !local.includes('\\') &&
      local.split('/').every(part => part && part !== '.' && part !== '..'));
    for (let path = join(base, local); path !== base; path = dirname(path)) retain(path);
    retain(base);
  };
  const unchanged = () => {
    for (const [path, expected] of originals) if (physical(path) !== expected) return false;
    return true;
  };
  const original = (suffix: string) => {
    const path = receipt + suffix;
    const stat = lstatSync(path);
    assert(realpathSync(path) === path && outside(root, path) && stat.isFile() && stat.nlink === 1,
      'original verifier receipt is not independent');
    retain(path);
    return readFileSync(path);
  };
  const sourceBytes = original('');
  const snapshot = original('.snapshot.txt');
  const dependencyBytes = original('.dependencies.json');
  const taskBytes = original('.task.json');
  const task = JSON.parse(taskBytes.toString('utf8'));
  const child = JSON.parse(original('.child.json').toString('utf8'));
  assert(task.schemaVersion === 'verifier-task-v1' && task.cleanup === 'pending' &&
    task.ownedRoot === dirname(root) && child.schemaVersion === 'verifier-child-v1' && child.status === 'started');
  const inInvocation = () => typeof task.processIdentity === 'string' && typeof child.processIdentity === 'string'
    && readProcessIdentity(task.pid) === task.processIdentity && readProcessIdentity(child.pid) === child.processIdentity
    && readProcessGroupId(process.pid) === child.pid;
  assert(inInvocation(), 'runtime is outside the original verifier process group');
  const verifySnapshot = () => {
    const path = join(root, '.papercusp-pinned-deps');
    assert(lstatSync(path).isFile() && readFileSync(path).equals(snapshot), 'verifier snapshot differs from original');
  };
  verifySnapshot();
  for (const path of ['.verifier-source.json', '.papercusp-pinned-deps']) retainLocal(root, path);
  const source = readVerifierSourceReceiptSync(root, receipt, { onDirectory: retain });
  assert.equal(source.sourceCommit, ref);
  for (const { path } of source.files) retainLocal(root, path);
  if (source.gitCheckout) {
    for (const local of ['', ...(source.submodules ?? []).map(row => row.path)]) {
      const git = join(root, local, '.git');
      const head = join(git, 'HEAD');
      retain(head);
      retain(join(git, 'index'));
      const name = readFileSync(head, 'utf8').trim();
      if (name.startsWith('ref: ')) {
        retainLocal(git, name.slice(5));
        retain(join(git, 'packed-refs'));
      }
    }
  }
  const dependencies = JSON.parse(dependencyBytes.toString('utf8'));
  assert(dependencies.schemaVersion === 'verifier-dependencies-v1' && dependencies.scope === 'materialized-dependency-files'
    && dependencies.root === root && dependencies.sourceCommit === ref
    && dependencies.sourceReceiptSha256 === hash(JSON.stringify(source)) && Array.isArray(dependencies.trees));
  const policy = 'apps/operator/bin/release/dependency-generation.sh';
  assert(dependencies.policy?.path === policy && dependencies.policy.sha256 === hash(readFileSync(join(toolingRoot, policy))),
    'verifier dependency census policy differs from reader');
  const trees = new Map<string, VerifierSourceFile[]>();
  for (const tree of dependencies.trees) {
    assert(typeof tree?.path === 'string' && Array.isArray(tree.files) && !trees.has(tree.path));
    trees.set(tree.path, tree.files);
  }

  const records: [string, string][] = [];
  const contents = createHash('sha256');
  const policyEnv: NodeJS.ProcessEnv = { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    DEPENDENCY_GENERATION_NODE: process.execPath, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
    VERIFY_TAURI_SOURCE_RECEIPT: receipt, VERIFY_TAURI_SOURCE_REF: ref };
  if (process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT)
    policyEnv.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT;
  let heldPublication: string | undefined;
  const binding = await bindFrozenDependencyGeneration(root, ref, {
    toolingRoot, env: policyEnv, retainProvenance: retain,
    verifyTree(tree, publication, projection, physicalSha256) {
      assert(outside(root, realpathSync(publication)) && outside(realpathSync(publication), root));
      heldPublication = publication;
      retainLocal(root, tree);
      retainLocal(publication, tree);
      const paths = new Set<string>();
      const regular = new Set<string>();
      for (const line of projection.split('\n').filter(Boolean)) {
        const [path, kind] = line.split('\t');
        assert(path && ['d', 'f', 'l'].includes(kind), 'unsupported published dependency entry');
        retainLocal(root, tree + '/' + path);
        retainLocal(publication, tree + '/' + path);
        paths.add(path);
        if (kind === 'd' || kind === 'f') regular.add(path);
        if (kind === 'f') {
          const a = lstatSync(join(publication, tree, path), { bigint: true });
          const b = lstatSync(join(root, tree, path), { bigint: true });
          assert(a.isFile() && b.isFile() && (a.dev !== b.dev || a.ino !== b.ino), 'dependent verifier file copy');
        }
      }
      const installed = verifierSourceFiles(join(root, tree), { symlinkRoot: root,
        includedPaths: new Set([...paths, ...copyMetadata]) });
      for (const path of copyMetadata) retainLocal(root, tree + '/' + path);
      assert.deepEqual(installed, trees.get(tree), 'installed bytes differ from original command census');
      // Link targets were compared by the generation projection. Workspace
      // links resolve in the invocation, even when only their outputs were published.
      const published = verifierSourceFiles(join(publication, tree), { symlinkRoot: publication, includedPaths: regular });
      assert.deepEqual(published, installed.filter(file => file.kind === 'file' && regular.has(file.path)),
        'installed bytes differ from publication');
      contents.update(JSON.stringify([tree, installed.filter(file => paths.has(file.path))]));
      records.push([tree, physicalSha256]);
    },
  });
  assert(heldPublication);
  const generationDir = dirname(heldPublication);
  for (const path of ['.tree-manifest', '.dependency-inputs/.manifest', '.verifier-closure.json'])
    retainLocal(generationDir, path);
  // The publication checker also measures generated workspace binaries outside
  // node_modules. Keep their originals in the same interval as the packages.
  const closure = JSON.parse(readFileSync(join(generationDir, '.verifier-closure.json'), 'utf8'));
  for (const workspace of closure.workspaces) {
    for (const file of [...workspace.outputs, { path: workspace.output + '/.papercusp-workspace-build.json' }]) {
      retainLocal(root, file.path);
      retainLocal(heldPublication, file.path);
    }
  }
  assert.deepEqual(binding.trees, [...trees.keys()]);
  assert.equal(verifierRuntimeHandoffSha256(receipt, hash(snapshot), hash(dependencyBytes), records, hash(taskBytes)), handoff,
    'invocation or materialized file identities differ from original command');
  verifySnapshot();
  assert(sourceBytes.equals(original('')) && snapshot.equals(original('.snapshot.txt'))
    && dependencyBytes.equals(original('.dependencies.json')), 'original verifier receipts changed');
  await binding.assertUnchanged();
  assert.deepEqual(readVerifierSourceReceiptSync(root, receipt), source);
  assert(unchanged(), 'observed files changed while binding verifier runtime');
  const identity = hash(JSON.stringify(['verified-runtime-generation-v1', binding.identity, contents.digest('hex')]));
  return () => inInvocation() && unchanged() ? identity : null;
}
