import { dirname, basename, relative, resolve, sep, join, isAbsolute, win32 } from 'node:path';
import type { CensusDeclaration, CensusRoot, CensusEntry } from '@papercusp/backup';
import { collectStateCensus, assertStateCensusComplete } from '@papercusp/backup';
import type { Sql } from 'postgres';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { readdir, readFile, lstat, open, realpath } from 'node:fs/promises';
import { dbEncryptionKeyFilePath } from '../db-encryption';
import { superuserTokenPath } from '../superuser-token';
import { workspacesRoot, readRegistry } from '../workspace-registry';
import { scratchRoot } from '../scratch-uri';
import { googleOAuthClientPath } from '../oauth/providers';
import { parseUnitEnvironment } from '../provisioner/unit-drift';
import ts from 'typescript';
import { identityDir } from '../identity/keychain';
import { anchorKeyFilePath } from '../cupboard/ledger-anchor-eas';
import { papercuspRoot } from '../papercusp-root';
import { parseCodexCliRef } from '../inference-gateway/codex-cli-bridge';
import { codexAuthPath } from '../inference-gateway/codex-oauth-proxy';
import { readPlanTemplateDirForInstall } from '../cupboard/plan-template-store';
import { REAP_TAIL_MAX_BYTES, verifyReapTailReceipt } from '../task-manager/reap-archive';
import { resolveSqlDir } from '../migration-drift';
import { stripCommentsAndStrings, stripSqlCommentsAndStrings } from '../../../../scripts/lib/strip-comments-and-strings.mjs';

/** Compose independent writers without traversing the same physical root twice. */
export function installedRootCensusProducers() {
  const producers = [workspaceRegistryCensusProducer(), secretCensusProducers(), identityKeychainCensusProducer(), anchorSecretCensusProducer(), hostedConfigurationCensusProducers(), scratchCensusProducer(), stripRangeCacheCensusProducer(), runtimeRetainedCensusProducer()];
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

/** Active workspace writers; historical workspace copies still require their own evidence. */
export function runtimeRetainedCensusProducer() {
  const root: CensusRoot = { id: 'runtime-retained', path: papercuspRoot() };
  const declarations: CensusDeclaration[] = [
    { kind: 'path', root: root.id, name: 'deploy-credentials', classification: 'state', producer: 'deployment-account-link' },
    { kind: 'path', root: root.id, name: 'crash-reports', classification: 'state', producer: 'fatal-diagnostics', descendants: true },
    { kind: 'path', root: root.id, name: 'snapshot-fold-checkpoints', classification: 'state', producer: 'hyperbee-own-compaction', descendants: true },
  ];
  return { roots: [root], declarations };
}

/** task-reconcile-action archives under OS home, independently of papercuspRoot().
 * Directory shape proves containers only; tails need a ledger identity or writer receipt. */
export async function reapArchiveCensusProducer(home = homedir(), retainedTaskIds: readonly string[] = [],
  lookupRetained?: (taskIds: string[]) => Promise<readonly string[]>) {
  const root: CensusRoot = { id: 'reap-archive-home', path: join(home, '.papercusp') };
  const declarations: CensusDeclaration[] = [];
  const archive = join(root.path, 'reap-archive');
  try { if (!(await lstat(archive)).isDirectory()) return { roots: [root], declarations }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [root], declarations }; throw error; }
  const add = (name: string) => declarations.push({ kind: 'path', root: root.id, name,
    classification: 'state', producer: 'task-reconcile-reap-tail-archive' });
  add('reap-archive');
  const identities = new Set(retainedTaskIds.filter(id => id.length > 0 && !/[\\/\0]/.test(id) && id !== '.' && id !== '..'));
  for (const entry of await readdir(archive, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const date = new Date(`${entry.name}T00:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== entry.name) continue;
    add(`reap-archive/${entry.name}`);
    const tails = await readdir(join(archive, entry.name), { withFileTypes: true });
    const candidates = tails.filter(tail => tail.isFile() && tail.name.endsWith('.tail.log'))
      .map(tail => tail.name.slice(0, -'.tail.log'.length));
    if (lookupRetained) {
      for (let offset = 0; offset < candidates.length; offset += 1000) {
        const batch = candidates.slice(offset, offset + 1000);
        const requested = new Set(batch);
        for (const id of await lookupRetained(batch)) if (requested.has(id)) identities.add(id);
      }
    }
    for (const tail of tails) {
      if (!tail.isFile() || !tail.name.endsWith('.tail.log')) continue;
      const name = `reap-archive/${entry.name}/${tail.name}`;
      const metadata = await lstat(join(root.path, name));
      if (!metadata.isFile() || metadata.size > REAP_TAIL_MAX_BYTES) continue;
      const taskId = tail.name.slice(0, -'.tail.log'.length);
      const receiptVerified = await verifyReapTailReceipt(join(root.path, name), taskId, entry.name);
      if (receiptVerified || identities.has(taskId)) add(name);
      if (receiptVerified) add(`${name}.receipt.json`);
    }
  }
  return { roots: [root], declarations };
}

/** Pool references own credential files, never every file copied into a CLI home. */
export async function accountCredentialCensusProducer(accounts: ReadonlyArray<{ credentialRef: string }>) {
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const account of accounts) {
    const home = parseCodexCliRef(account.credentialRef);
    const path = home ? codexAuthPath(home) : /^(?:file|token):(.+)$/.exec(account.credentialRef)?.[1];
    if (!path || !isAbsolute(path)) continue;
    const directory = dirname(path);
    try { await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let root = roots.find(entry => entry.path === directory);
    if (!root) { root = { id: `account-credential-${roots.length}`, path: directory }; roots.push(root); }
    const add = (name: string) => {
      if (!declarations.some(entry => entry.root === root!.id && entry.name === name)) {
        declarations.push({ kind: 'path', root: root!.id, name, classification: 'secret', producer: 'account-pool-credential-reference' });
      }
    };
    add(basename(path));
    if (home) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // persistCodexAuth's exact atomic writer; do not read token contents.
      for (const entry of entries ?? []) {
        if (entry.isFile() && /^auth\.json\.[0-9]+\.tmp$/.test(entry.name)) add(entry.name);
      }
    }
  }
  return { roots, declarations };
}

/** account-link-cli preserves completed setup homes when registration fails. */
export async function cliSetupHomeCensusProducer(path = papercuspRoot()) {
  const root: CensusRoot = { id: 'cli-setup-homes', path };
  const declarations: CensusDeclaration[] = [];
  let entries;
  try { entries = await readdir(join(path, 'deploy-credentials'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [root], declarations }; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\.(?:codex-)?setup-[A-Za-z0-9._-]+-[0-9a-f]{8}$/.test(entry.name)) continue;
    const name = `deploy-credentials/${entry.name}`;
    declarations.push({ kind: 'path', root: root.id, name, classification: 'state', producer: 'account-link-cli-setup-home' });
    if (!entry.name.startsWith('.codex-setup-')) continue;
    const files = await readdir(join(path, name), { withFileTypes: true });
    if (files.some(file => file.name === 'auth.json' && file.isFile())) {
      declarations.push({ kind: 'path', root: root.id, name: `${name}/auth.json`, classification: 'secret', producer: 'account-link-cli-completed-login' });
    }
  }
  return { roots: [root], declarations };
}

/** Prove bytes against one source path's reachable Git history, never another path. */
export function historicalGitBlobIdentityResolver(repository: string) {
  const histories = new Map<string, Promise<Set<string>>>();
  return async (source: string, bytes: Buffer): Promise<boolean> => {
    const name = relative(repository, source).split(sep).join('/');
    if (!name || name === '..' || name.startsWith('../') || isAbsolute(name)) return false;
    let history = histories.get(name);
    if (!history) {
      history = (async () => {
        const { stdout } = await execFileAsync('git', ['-C', repository, 'log', '--all', '--format=%H', '--', name], { maxBuffer: 16 * 1024 * 1024 });
        const blobs = new Set<string>();
        for (const revision of stdout.trim().split('\n').filter(Boolean)) {
          const tree = await execFileAsync('git', ['-C', repository, 'ls-tree', revision, '--', name]);
          for (const line of tree.stdout.trim().split('\n')) {
            const match = /^100(?:644|755) blob ([0-9a-f]+)\t(.+)$/.exec(line);
            if (match && match[2] === name) blobs.add(match[1]);
          }
        }
        return blobs;
      })();
      histories.set(name, history);
    }
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return (await history).has(hash);
  };
}

/** Installer/store metadata owns exact files, not arbitrary bundle descendants. */
export async function templateStoreCensusProducer(path = papercuspRoot(), expected: ReadonlyMap<string, string> = new Map(), historicalIdentity?: (source: string, bytes: Buffer) => Promise<boolean>) {
  const root: CensusRoot = { id: 'template-store', path };
  const declarations: CensusDeclaration[] = [];
  let entries;
  try { entries = await readdir(join(path, 'templates'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [root], declarations }; throw error; }
  const add = (name: string) => declarations.push({ kind: 'path', root: root.id, name, classification: 'state', producer: 'cupboard-installed-template-store' });
  add('templates');
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const name = `templates/${entry.name}`;
    const files = await readdir(join(path, name), { withFileTypes: true });
    // Historical Save Template wrote <slug>/<semver>/papercusp.json.
    // Validate its identity before declaring only the writer's exact metadata.
    if (/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(entry.name)) for (const version of files) {
      if (!version.isDirectory() || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version.name)) continue;
      const bundle = `${name}/${version.name}`;
      const children = await readdir(join(path, bundle), { withFileTypes: true });
      if (!children.some(child => child.name === 'papercusp.json' && child.isFile())) continue;
      let manifest;
      try { manifest = JSON.parse(await readFile(join(path, bundle, 'papercusp.json'), 'utf8')); }
      catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      if (manifest?.name !== entry.name || manifest?.version !== version.name || manifest?.kind !== 'template') continue;
      if (!declarations.some(declaration => declaration.name === name)) add(name);
      add(bundle);
      for (const child of children) {
        if (child.isFile() && ['papercusp.json', 'SPEC.md', 'AGENTS.md', 'README.md', '.published.json'].includes(child.name)) add(`${bundle}/${child.name}`);
        if (child.name !== '.harness' || !child.isDirectory()) continue;
        add(`${bundle}/.harness`);
        for (const config of await readdir(join(path, bundle, '.harness'), { withFileTypes: true })) {
          if (config.isFile() && ['config.json', 'validation-contract.md'].includes(config.name)) add(`${bundle}/.harness/${config.name}`);
        }
      }
    }
    // install-template-core requires this manifest before copying into the store.
    if (!files.some(file => file.name === 'template.yaml' && file.isFile())) continue;
    add(name);
    for (const file of files) {
      if (file.isFile() && ['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md'].includes(file.name)) add(`${name}/${file.name}`);
    }
    // The existing mirror map proves individual source identity. Never infer
    // ownership of a whole subtree from its manifest or installation receipt.
    for (const [mirrorName, source] of expected) {
      if (!mirrorName.startsWith(`${entry.name}/`)) continue;
      const parts = mirrorName.split('/');
      if (parts.some(part => !part || part === '.' || part === '..')) continue;
      let regular = true;
      for (let index = 1; index <= parts.length; index++) {
        try {
          const metadata = await lstat(join(path, 'templates', ...parts.slice(0, index)));
          if (index === parts.length ? !metadata.isFile() : !metadata.isDirectory()) { regular = false; break; }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
          regular = false; break;
        }
      }
      if (!regular) continue;
      const bytes = await readFile(join(path, 'templates', mirrorName));
      if (!bytes.equals(await readFile(source)) && !(await historicalIdentity?.(source, bytes))) continue;
      for (let index = 2; index <= parts.length; index++) {
        const installedName = `templates/${parts.slice(0, index).join('/')}`;
        if (!declarations.some(declaration => declaration.name === installedName)) add(installedName);
      }
    }
  }
  return { roots: [root], declarations };
}

/** Workspace homes use the same store writer, including homes no longer in the registry. */
export async function workspaceTemplateStoreCensusProducer(path = workspacesRoot(), expected: ReadonlyMap<string, string> = new Map(), historicalIdentity?: (source: string, bytes: Buffer) => Promise<boolean>) {
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const home = join(path, entry.name, '.papercusp');
    try { if (!(await lstat(home)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const store = await templateStoreCensusProducer(home, expected, historicalIdentity);
    const id = `workspace-template-store:${entry.name}`;
    roots.push({ id, path: home });
    declarations.push(...store.declarations.map(declaration => ({ ...declaration, root: id })));
  }
  return { roots, declarations };
}

/** The plan-template writer owns its parsed manifest and storefront metadata only. */
export async function planTemplateStoreCensusProducer(path = papercuspRoot()) {
  const root: CensusRoot = { id: 'plan-template-store', path };
  const declarations: CensusDeclaration[] = [];
  let entries;
  try { entries = await readdir(join(path, 'plan-templates'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [root], declarations }; throw error; }
  const add = (name: string) => declarations.push({ kind: 'path', root: root.id, name, classification: 'state', producer: 'cupboard-plan-template-writer' });
  add('plan-templates');
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const name = `plan-templates/${entry.name}`;
    const files = await readdir(join(path, name), { withFileTypes: true });
    if (!files.some(file => file.name === 'plan.md' && file.isFile())) continue;
    // The shared installer reader rejects legacy/unstructured manifests.
    if (!readPlanTemplateDirForInstall(join(path, name), entry.name)) continue;
    add(name);
    for (const file of files) {
      if (file.isFile() && ['plan.md', 'listing.json'].includes(file.name)) add(`${name}/${file.name}`);
    }
  }
  return { roots: [root], declarations };
}

/** Exact hook pacing and template gym writers; siblings require separate provenance. */
export async function runtimeSidefileCensusProducer(home = homedir()) {
  const root: CensusRoot = { id: 'runtime-sidefiles', path: join(home, '.papercusp') };
  const declarations: CensusDeclaration[] = [];
  const pacingFile = 'google-vertex-gemini-3.1-pro-preview.json';
  for (const [directory, producer, files] of [
    ['provider-pacing', 'omp-vertex-request-start', [pacingFile, `${pacingFile}.lock`]],
    ['template-gym', 'template-gym-runner', ['last-run.json', 'runs.jsonl']],
  ] as const) {
    let entries;
    try { entries = await readdir(join(root.path, directory), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push({ kind: 'path', root: root.id, name: directory, classification: 'state', producer });
    for (const entry of entries) {
      const atomic = directory === 'provider-pacing' && entry.name.startsWith(`${pacingFile}.tmp-`) &&
        /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.name.slice(`${pacingFile}.tmp-`.length));
      if (entry.isFile() && ((files as readonly string[]).includes(entry.name) || atomic)) {
        declarations.push({ kind: 'path', root: root.id, name: `${directory}/${entry.name}`, classification: 'state', producer });
      }
    }
  }
  return { roots: [root], declarations };
}

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

/** Exact affected-test writer files; unrelated cache contents remain residue. */
export async function affectedTestCacheCensusProducer(home = homedir()) {
  const directory = join(home, '.papercusp', 'cache');
  const paths = [{ path: process.env.AFFECTED_TASK_HISTORY_PATH ?? join(directory, 'papercusp-affected-task-durations-v1.json'), producer: 'affected-tests-duration-history' }];
  if (process.env.AFFECTED_TASK_VERDICT_CACHE_PATH) {
    paths.push({ path: process.env.AFFECTED_TASK_VERDICT_CACHE_PATH, producer: 'affected-tests-passing-verdict' });
  }
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const entry of entries ?? []) {
    if (entry.isFile() && /^papercusp-affected-passing-verdicts-v2-(?:committed-)?[0-9a-f]{16}\.json$/.test(entry.name)) {
      paths.push({ path: join(directory, entry.name), producer: 'affected-tests-passing-verdict' });
    }
  }
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const entry of paths) {
    const directory = dirname(resolve(entry.path));
    let root = roots.find(root => root.path === directory);
    if (!root) { root = { id: `affected-test-cache-${roots.length}`, path: directory }; roots.push(root); }
    declarations.push({ kind: 'path', root: root.id, name: basename(entry.path), classification: 'cache', producer: entry.producer });
  }
  return { roots, declarations };
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

/** Exact paths resolved by the hosted deploy and public-download publishers. */
export function hostedConfigurationCensusProducers() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const paths = [
    { path: process.env.PAPERCUSP_HOSTED_CP_ENV_FILE || join(config, 'papercusp', 'hosted-control-plane.env'), classification: 'secret' as const, producer: 'deploy-hosted-control-plane' },
    { path: process.env.PAPERCUSP_CLOUD_PORTAL_HOSTED_ENV_FILE || join(config, 'papercusp', 'hosted-control-plane.env'), classification: 'secret' as const, producer: 'deploy-cloud-portal' },
    { path: process.env.PUI_PORTAL_LINKS_ENV || join(homedir(), '.config', 'papercusp', 'portal-public-links.env'), classification: 'config' as const, producer: 'publish-tui-release' },
  ];
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const entry of paths) {
    let root = roots.find(candidate => candidate.path === dirname(entry.path));
    if (!root) { root = { id: `hosted-config-${roots.length}`, path: dirname(entry.path) }; roots.push(root); }
    declarations.push({ kind: 'path', root: root.id, name: basename(entry.path), classification: entry.classification, producer: entry.producer });
  }
  return { roots, declarations };
}

/** The keychain directory is sensitive retained material, never rebuildable. */
export function identityKeychainCensusProducer() {
  const path = identityDir();
  return { roots: [{ id: 'identity-keychain-parent', path: dirname(path) }], declarations: [{
    kind: 'path' as const, root: 'identity-keychain-parent', name: basename(path),
    classification: 'secret' as const, producer: 'identity-keychain', descendants: true,
  }] };
}

export function anchorSecretCensusProducer() {
  const path = anchorKeyFilePath();
  return { roots: [{ id: 'anchor-key-parent', path: dirname(path) }], declarations: [{
    kind: 'path' as const, root: 'anchor-key-parent', name: basename(path),
    classification: 'secret' as const, producer: 'ledger-anchor-key',
  }] };
}

/** Operator database selection is configuration evidence, not name matching. */
export function configuredOperatorDatabaseCensusDeclarations(clusterIdentity: string, operatorUrl: string): CensusDeclaration[] {
  if (!/^postgres-cluster:\d+$/.test(clusterIdentity)) throw new Error('Missing physical operator cluster identity');
  const database = decodeURIComponent(new URL(operatorUrl).pathname.slice(1));
  if (!database || database.includes('/')) throw new Error('Missing operator database identity');
  return [{ kind: 'database', root: clusterIdentity, name: database, classification: 'state', producer: 'embedded-pg-discovery-operator' },
    { kind: 'database', root: clusterIdentity, name: 'papercusp_su', classification: 'state', producer: 'su-lock-store' }];
}

/** Resolve service database configuration, without emitting credentials.
 * Unsupported specifiers and externally hosted databases remain unclassified.
 */
export async function unitDatabaseCensusDeclarations(units: readonly CensusDeclaration[], databases: readonly CensusEntry[], operatorUrl: string, environmentRoots?: readonly string[]): Promise<CensusDeclaration[]> {
  const operator = new URL(operatorUrl);
  const host = (value: string) => ['localhost', '127.0.0.1', '[::1]'].includes(value) ? 'loopback' : value;
  const result: CensusDeclaration[] = [];
  for (const unit of units) {
    if (unit.kind !== 'unit' || !unit.name.endsWith('.service') || unit.name.includes('/') || !unit.producer.startsWith('unit-definition:')) continue;
    const path = join(unit.producer.slice('unit-definition:'.length), unit.name);
    let handle;
    try {
      if (!(await lstat(path)).isFile()) continue;
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      // Transient units can disappear after catalogue discovery or lstat.
      // No surviving definition means no database ownership evidence.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let text: string;
    try {
      if ((await handle.stat()).size > 65_536) throw new Error('Service database config bound exceeded');
      text = await handle.readFile('utf8');
    } finally { await handle.close(); }
    const environment = parseUnitEnvironment(text);
    for (const line of text.split('\n')) {
      const match = line.trim().match(/^EnvironmentFile=(-?)(.*)$/);
      if (!match) continue;
      const file = match[2].trim().replace(/^["']|["']$/g, '').replace(/%h/g, homedir());
      if (!isAbsolute(file) || file.includes('%')) continue;
      // Platform census scope does not authorize inspecting arbitrary OS service
      // credentials. Out-of-scope environment files provide no ownership proof.
      const allowed = environmentRoots ?? [dirname(path)];
      if (!allowed.some(root => {
        const suffix = relative(root, file);
        return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
      })) continue;
      let fileHandle;
      try { fileHandle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (match[1] === '-' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      try {
        const stat = await fileHandle.stat();
        if (!stat.isFile() || stat.size > 65_536) throw new Error('Service environment file bound exceeded');
        const contents = await fileHandle.readFile('utf8');
        Object.assign(environment, parseUnitEnvironment(contents.split('\n').filter(row =>
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(row.trim())).map(row => `Environment=${row.trim()}`).join('\n')));
      } finally { await fileHandle.close(); }
    }
    for (const [key, value] of Object.entries(environment)) {
      if (!(key === 'DATABASE_URL' || key.endsWith('_DATABASE_URL'))) continue;
      let url;
      try { url = new URL(value); } catch { continue; }
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || host(url.hostname) !== host(operator.hostname) ||
        (url.port || '5432') !== (operator.port || '5432')) continue;
      const name = decodeURIComponent(url.pathname.slice(1));
      const entry = databases.find(database => database.kind === 'database' && database.name === name);
      if (entry) result.push({ ...entry, classification: 'state', producer: `unit-database-config:${unit.root}:${unit.name}:${key}` });
    }
  }
  return result;
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

/** initdb's fixed PostgresDbOid and catalog comment identify its maintenance DB.
 * Retain the entire database, including any application objects added later.
 * Source: PostgreSQL src/bin/initdb/initdb.c make_postgres; pg_database_d.h.
 */
export async function maintenanceDatabaseCensusDeclarations(sql: Sql, clusterIdentity: string): Promise<CensusDeclaration[]> {
  if (!/^postgres-cluster:\d+$/.test(clusterIdentity)) throw new Error('Missing physical maintenance cluster identity');
  const identity = await sql<{ system_identifier: string }[]>`SELECT system_identifier::text FROM pg_control_system()`;
  if (`postgres-cluster:${identity[0]?.system_identifier}` !== clusterIdentity) throw new Error('Maintenance database cluster identity mismatch');
  const rows = await sql<{ oid: number; datname: string; datistemplate: boolean; marker: string }[]>`
    SELECT oid, datname, datistemplate, shobj_description(oid, 'pg_database') AS marker
    FROM pg_database WHERE oid = 5
  `;
  return rows.filter(row => row.oid === 5 && row.datname === 'postgres' && row.datistemplate === false &&
    row.marker === 'default administrative connection database').map(row => ({
      kind: 'database', root: clusterIdentity, name: row.datname, classification: 'state', producer: 'postgres-initdb-maintenance',
    }));
}

/** Only the exact integration-baseline identity shape emitted by its producer. */
export function integrationBaselineCensusDeclarations(entries: readonly CensusEntry[]): CensusDeclaration[] {
  return entries.filter(entry => entry.kind === 'database' &&
    /^papercusp_it_baseline_[0-9a-f]{12}$/.test(entry.name)).map(entry => ({
      ...entry, classification: 'dev-only', producer: 'baseline-schema-global-setup',
    }));
}

/** The integration template builder stamps readiness in the shared PG catalog. */
export async function templateDatabaseCensusDeclarations(sql: Sql, clusterIdentity: string): Promise<CensusDeclaration[]> {
  if (!clusterIdentity.startsWith('postgres-cluster:') || !/^\d+$/.test(clusterIdentity.slice('postgres-cluster:'.length))) throw new Error('Missing physical template cluster identity');
  const rows = await sql<{ datname: string; marker: string }[]>`
    SELECT datname, shobj_description(oid, 'pg_database') AS marker FROM pg_database
    WHERE starts_with(datname, 'tmpl_') AND shobj_description(oid, 'pg_database') = 'pc-template-ready'
  `;
  return rows.filter(row => row.datname.startsWith('tmpl_') && row.marker === 'pc-template-ready')
    .map(row => ({ kind: 'database', root: clusterIdentity, name: row.datname, classification: 'dev-only', producer: 'pg-migrate-template-ready' }));
}

let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
/** Read literal migration arrays without importing or executing application code. */
export function migrationProducerTables(source: string): string[] {
  const file = ts.createSourceFile('migrations.ts', source, ts.ScriptTarget.Latest, true);
  const tables = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      let initializer = declaration.initializer;
      while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith('_MIGRATIONS') ||
        !initializer || !ts.isArrayLiteralExpression(initializer)) continue;
      for (const element of initializer.elements) {
        if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) continue;
        const match = element.text.match(/^\s*CREATE TABLE(?: IF NOT EXISTS)? ([a-z_][a-z0-9_]*)\s*\(/i);
        if (match) tables.add(`public.${match[1].toLowerCase()}`);
      }
    }
  }
  return [...tables];
}

/** Read literal app migrations from canonical registered project paths without executing source. */
export async function registeredProjectMigrationSources(projects: readonly { slug: string; path: string }[], units: readonly CensusDeclaration[] = []): Promise<MigrationCensusSource[]> {
  const sources: MigrationCensusSource[] = [];
  const roots = [...projects];
  // Installed definitions establish source locations; service names carry no
  // classification authority. Never inspect EnvironmentFile credential values.
  for (const unit of units) {
    if (unit.kind !== 'unit' || !unit.name.endsWith('.service') || unit.name.includes('/') || !unit.producer.startsWith('unit-definition:')) continue;
    const body = await boundedSource(join(unit.producer.slice('unit-definition:'.length), unit.name), 65_536);
    if (!body) continue;
    let section = '';
    let workingDirectory: string | undefined;
    for (const line of body.split('\n')) {
      const heading = line.trim().match(/^\[([^\]]+)\]$/);
      if (heading) { section = heading[1]; continue; }
      const match = section === 'Service' && line.trim().match(/^WorkingDirectory=(.*)$/);
      if (!match) continue;
      const value = match[1].trim().replace(/^"([^"\n]*)"$/, '$1').replace(/%h/g, homedir());
      workingDirectory = isAbsolute(value) && !/[\n%\\]/.test(value) ? value : undefined;
    }
    if (workingDirectory) roots.push({ slug: `unit:${unit.root}:${unit.name}`, path: workingDirectory });
  }
  const seen = new Set<string>();
  for (const project of roots) {
    if (seen.has(project.path)) continue;
    seen.add(project.path);
    const path = join(project.path, 'packages', 'data', 'src', 'migrations.ts');
    const literalMigrations = await boundedSource(path);
    if (literalMigrations) {
      const tables = migrationProducerTables(literalMigrations);
      if (tables.length >= 2) sources.push({ producer: `app-migrations:registry:${project.slug}:${project.path}`, tables });
    }
    const config = await boundedSource(join(project.path, 'drizzle.config.ts'));
    const output = config && literalDrizzleOutput(config);
    if (!output) continue;
    const directory = resolve(project.path, output);
    const suffix = relative(project.path, directory);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) continue;
    try {
      if (await realpath(directory) !== directory) continue;
      const names = await readdir(directory);
      if (names.length > 1000) throw new Error('Project migration directory bound exceeded');
      for (const name of names.filter(name => /^\d+[^/]*\.sql$/.test(name)).sort()) {
        const sql = await boundedSource(join(directory, name));
        const source = sql && sqlMigrationCensusSource(sql, `app-migrations:registry:${project.slug}:${project.path}:${output}/${name}`);
        if (source) sources.push(source);
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return sources;
}

async function boundedSource(path: string, bound = 1_048_576): Promise<string | null> {
  let handle;
  try {
    if (await realpath(path) !== resolve(path)) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > bound) return null;
    return await handle.readFile('utf8');
  } catch (error) {
    // An installed unit may belong to another user. No readable source means
    // no provenance declaration; the database remains census residue.
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  } finally { await handle?.close(); }
}

/** Only a literal defineConfig export is evidence; never evaluate TS or imports. */
function literalDrizzleOutput(source: string): string | null {
  const file = ts.createSourceFile('drizzle.config.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    const call = statement.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'defineConfig' || call.arguments.length !== 1) continue;
    const config = call.arguments[0];
    if (!ts.isObjectLiteralExpression(config) || config.properties.some(property => !ts.isPropertyAssignment(property))) continue;
    const outputs = config.properties.filter(property => ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'out');
    if (outputs.length !== 1 || !ts.isPropertyAssignment(outputs[0]) || !ts.isStringLiteral(outputs[0].initializer)) return null;
    const output = outputs[0].initializer.text;
    return !isAbsolute(output) && !/[\\%]/.test(output) ? output : null;
  }
  return null;
}

/** A producer's consecutive migration-table prefix establishes retained state.
 * Older schemas stay exportable without claiming the latest migrations applied.
 * This identifies schema provenance, not live application identity or contents.
 */
export interface MigrationCensusColumn {
  table: string;
  name: string;
  type: string;
  udtSchema?: string;
  udtName?: string;
}
export interface MigrationCensusSource {
  producer: string;
  tables: readonly string[];
  columns?: readonly MigrationCensusColumn[];
}

/** SQL literals/comments cannot introduce schema evidence. Unsupported column
 * syntax fails closed; later additive migrations need not erase older provenance.
 */
export function sqlMigrationCensusSource(source: string, producer: string): MigrationCensusSource | null {
  const keywords = stripCommentsAndStrings(source, 'migration.sql');
  const code = stripSqlCommentsAndStrings(source, { preserveIdentifiers: true });
  const identifier = '(?:[a-z_][a-z0-9_]*|"[a-z_][a-z0-9_]*")';
  const normalize = (name: string) => name.startsWith('"') ? name.slice(1, -1) : name.toLowerCase();
  const tables: string[] = [];
  const columns: MigrationCensusColumn[] = [];
  const enumTypes = new Set<string>();
  const enums = new RegExp(`\\bCREATE\\s+TYPE\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?\\s+AS\\s+ENUM\\s*\\([^)]*\\)\\s*;`, 'gi');
  for (const match of code.matchAll(enums)) {
    if (!/^CREATE\s+TYPE\b/i.test(keywords.slice(match.index))) continue;
    enumTypes.add(match[2] ? `${normalize(match[1])}.${normalize(match[2])}` : `public.${normalize(match[1])}`);
  }
  const creates = new RegExp(`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})(?:\\s*\\.\\s*(${identifier}))?\\s*\\(`, 'gi');
  for (const match of code.matchAll(creates)) {
    // Preserved identifiers may themselves contain SQL-looking text. Only live
    // keywords in the fully masked stream can introduce schema evidence.
    if (!/^CREATE\s+TABLE\b/i.test(keywords.slice(match.index))) continue;
    const table = match[2] ? `${normalize(match[1])}.${normalize(match[2])}` : `public.${normalize(match[1])}`;
    let depth = 1;
    let start = match.index! + match[0].length;
    const parts: string[] = [];
    let end = start;
    for (; end < code.length && depth; end++) {
      if (code[end] === '(') depth++;
      if (code[end] === ')') depth--;
      if ((code[end] === ',' && depth === 1) || depth === 0) {
        parts.push(code.slice(start, end).trim());
        start = end + 1;
      }
    }
    if (depth) return null;
    const tableColumns: typeof columns = [];
    for (const part of parts) {
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(part)) continue;
      const column = part.match(new RegExp(`^(${identifier})\\s+(text|integer|bigint|jsonb|boolean|timestamptz|timestamp(?:\\s+(?:with|without)\\s+time\\s+zone)?|double\\s+precision)\\b`, 'i'));
      if (!column) {
        const custom = part.match(new RegExp(`^(${identifier})\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?(?=\\s|$)`, 'i'));
        if (!custom) return null;
        const udtSchema = custom[3] ? normalize(custom[2]) : 'public';
        const udtName = normalize(custom[3] ?? custom[2]);
        if (!enumTypes.has(`${udtSchema}.${udtName}`) ||
          !/^(?:$|NOT\b|NULL\b|PRIMARY\b|DEFAULT\b|REFERENCES\b|UNIQUE\b|CHECK\b)/i.test(part.slice(custom[0].length).trim())) return null;
        tableColumns.push({ table, name: normalize(custom[1]), type: 'USER-DEFINED', udtSchema, udtName });
        continue;
      }
      if (!/^(?:$|NOT\b|NULL\b|PRIMARY\b|DEFAULT\b|REFERENCES\b|UNIQUE\b|CHECK\b)/i.test(part.slice(column[0].length).trim())) return null;
      const sqlType = column[2].toLowerCase().replace(/\s+/g, ' ');
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
