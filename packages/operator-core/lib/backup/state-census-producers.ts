import { papercuspHome, papercuspPath } from '@papercusp/host-platform/home';
import { dirname, basename, relative, resolve, sep, join, isAbsolute, win32 } from 'node:path';
import type { CensusDeclaration, CensusRoot, CensusEntry } from '@papercusp/backup';
import { collectStateCensus, assertStateCensusComplete } from '@papercusp/backup';
import type { Sql } from 'postgres';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { moduleRepoRoot } from '../module-repo-root';
import { createRequire } from 'node:module';
import { createHash, createDecipheriv, scryptSync } from 'node:crypto';
import { constants } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
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
import { resolveFsMutexLockRoot } from '../../../../scripts/lib/fs-mutex.mjs';
import { closureDigestManifestPath } from '../../../../scripts/lib/passing-task-verdict-cache.mjs';
import { PARTIAL_TASK_CHECKPOINT_SCHEMA } from '../../../../scripts/lib/partial-task-resume.mjs';

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

/** Runtime writers at an active or registered workspace root. Credential children
 * still need exact account references or setup-writer evidence. */
export function runtimeRetainedCensusProducer(path = papercuspRoot()) {
  const root: CensusRoot = { id: 'runtime-retained', path };
  const declarations: CensusDeclaration[] = [
    { kind: 'path', root: root.id, name: 'deploy-credentials', classification: 'state', producer: 'deployment-account-link' },
    { kind: 'path', root: root.id, name: 'crash-reports', classification: 'state', producer: 'fatal-diagnostics', descendants: true },
    { kind: 'path', root: root.id, name: 'snapshot-fold-checkpoints', classification: 'state', producer: 'hyperbee-own-compaction', descendants: true },
    // Keep the enabled-environment choice across transfer. Unlike endpoint
    // discovery and console markers, this is a durable preference, not a lease.
    { kind: 'path', root: root.id, name: 'env-switcher-prefs.json', classification: 'config', producer: 'env-switcher-prefs' },
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
    const receipts = new Set(tails.filter(tail => tail.isFile() && tail.name.endsWith('.tail.log.receipt.json'))
      .map(tail => tail.name));
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
      const taskId = tail.name.slice(0, -'.tail.log'.length);
      const hasReceipt = receipts.has(`${tail.name}.receipt.json`);
      // Without either identity source this is residue regardless of metadata.
      // Do not open thousands of absent sidecars or stat unproven tails.
      if (!hasReceipt && !identities.has(taskId)) continue;
      const name = `reap-archive/${entry.name}/${tail.name}`;
      const metadata = await lstat(join(root.path, name));
      if (!metadata.isFile() || metadata.size > REAP_TAIL_MAX_BYTES) continue;
      const receiptVerified = hasReceipt && await verifyReapTailReceipt(join(root.path, name), taskId, entry.name);
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
    if (!root) { root = { id: `account-credential-${roots.length}`, path: directory, fileNames: [] }; roots.push(root); }
    const add = (name: string) => {
      if (!root!.fileNames!.includes(name)) root!.fileNames!.push(name);
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

/** Resolve an installed CLI without executing its launcher or native helper. */
async function nativeCodexCli(selectedCli: string | null) {
  let nativeCodex: string | null = null;
  try {
    const cli = await realpath(selectedCli ?? '');
    const handle = await open(cli, 'r');
    let header: Buffer;
    try { header = Buffer.alloc(4); await handle.read(header, 0, 4, 0); }
    finally { await handle.close(); }
    if (header.subarray(0, 2).toString() !== '#!') nativeCodex = cli;
    else if (basename(cli) === 'codex.js') {
      const packageRoot = dirname(dirname(cli));
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      if (manifest.name === '@openai/codex' && manifest.bin?.codex === 'bin/codex.js') {
        const cpu = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null;
        const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : null;
        if (cpu && os) {
          let vendor = join(packageRoot, 'vendor');
          try {
            const packageName = `@openai/codex-${process.platform}-${process.arch}`;
            const packageJson = createRequire(cli).resolve(`${packageName}/package.json`);
            // Node caches resolution paths; existence and identity must still
            // be checked after an optional package is removed or replaced.
            const optional = JSON.parse(await readFile(packageJson, 'utf8'));
            // npm aliases retain the published package's name. Bind that
            // identity to the owning CLI's exact dependency and target rather
            // than trusting either the alias directory or package name alone.
            const aliased = optional.name === '@openai/codex'
              && typeof optional.version === 'string' && optional.version.length > 0
              && manifest.optionalDependencies?.[packageName] === `npm:@openai/codex@${optional.version}`
              && Array.isArray(optional.os) && optional.os.length === 1 && optional.os[0] === process.platform
              && Array.isArray(optional.cpu) && optional.cpu.length === 1 && optional.cpu[0] === process.arch;
            if (optional.name !== packageName && !aliased) return null;
            vendor = join(dirname(packageJson), 'vendor');
          }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error; }
          nativeCodex = await realpath(join(vendor, `${cpu}-${os}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
        }
      }
    }
    if (nativeCodex && !(await lstat(nativeCodex)).isFile()) nativeCodex = null;
  } catch { nativeCodex = null; } // Missing/unrecognized install leaves helpers visibly unclassified.
  return nativeCodex;
}

/** account-link-cli preserves completed setup homes when registration fails. */
export async function cliSetupHomeCensusProducer(path = papercuspRoot(), codexCli?: string | null) {
  const root: CensusRoot = { id: 'cli-setup-homes', path };
  const declarations: CensusDeclaration[] = [];
  let entries;
  try { entries = await readdir(join(path, 'deploy-credentials'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [root], declarations }; throw error; }
  // Keep explicit selection authoritative. Default discovery also proves older
  // npm installs: login-shell and operator PATHs may select different copies.
  let selectedCli = codexCli ?? null;
  if (codexCli === undefined) {
    try { selectedCli = (await import('../deployment/account-cli-bin')).resolveCliBin('codex'); }
    catch { /* Independently verified npm installs can still own their helpers. */ }
  }
  const nativeCodex = await nativeCodexCli(selectedCli);
  const installedTargets = new Map<string, boolean>();
  async function ownsHelper(target: string) {
    if (target === nativeCodex) return true;
    if (codexCli !== undefined) return false;
    if (!installedTargets.has(target)) {
      const boundaries = [
        `${sep}node_modules${sep}@openai${sep}codex${sep}`,
        `${sep}node_modules${sep}@openai${sep}codex-${process.platform}-${process.arch}${sep}`,
      ];
      // The package manifest and its actual optional/bundled native resolution
      // must agree with the target, including npm's sibling (hoisted) optional
      // package layout. A package-looking path alone proves nothing.
      let proven = false;
      for (const boundary of boundaries) {
        const offset = target.indexOf(boundary);
        if (offset < 0) continue;
        const launcher = join(target.slice(0, offset), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (await nativeCodexCli(launcher) === target) { proven = true; break; }
      }
      installedTargets.set(target, proven);
    }
    return installedTargets.get(target)!;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\.(?:codex-)?setup-[A-Za-z0-9._-]+-[0-9a-f]{8}$/.test(entry.name)) continue;
    const name = `deploy-credentials/${entry.name}`;
    declarations.push({ kind: 'path', root: root.id, name, classification: 'state', producer: 'account-link-cli-setup-home' });
    if (!entry.name.startsWith('.codex-setup-')) continue;
    const files = await readdir(join(path, name), { withFileTypes: true });
    if (files.some(file => file.name === 'auth.json' && file.isFile())) {
      declarations.push({ kind: 'path', root: root.id, name: `${name}/auth.json`, classification: 'secret', producer: 'account-link-cli-completed-login' });
    }
    // Installed Codex device-auth startup writes this exact log even when the
    // network request fails. Preserve it; neither foreign siblings nor tmp
    // descendants inherit ownership from the setup directory.
    if (files.some(file => file.name === 'log' && file.isDirectory())) {
      declarations.push({ kind: 'path', root: root.id, name: `${name}/log`, classification: 'state', producer: 'account-link-cli-device-auth-log' });
      const logs = await readdir(join(path, name, 'log'), { withFileTypes: true });
      if (logs.some(file => file.name === 'codex-login.log' && file.isFile())) {
        declarations.push({ kind: 'path', root: root.id, name: `${name}/log/codex-login.log`, classification: 'state', producer: 'account-link-cli-device-auth-log' });
      }
    }
    // Codex arg0 startup owns these exact directories and regular lock files.
    // Helper symlinks need separate executable identity proof; do not claim
    // them or arbitrary descendants merely because their parent is known.
    if (files.some(file => file.name === 'tmp' && file.isDirectory())) {
      const temporary = await readdir(join(path, name, 'tmp'), { withFileTypes: true });
      declarations.push({ kind: 'path', root: root.id, name: `${name}/tmp`, classification: 'cache', producer: 'codex-arg0-dispatch' });
      if (temporary.some(file => file.name === 'arg0' && file.isDirectory())) {
        const arg0 = `${name}/tmp/arg0`;
        declarations.push({ kind: 'path', root: root.id, name: arg0, classification: 'cache', producer: 'codex-arg0-dispatch' });
        for (const directory of await readdir(join(path, arg0), { withFileTypes: true })) {
          if (!directory.isDirectory() || !/^codex-arg0[A-Za-z0-9]{6}$/.test(directory.name)) continue;
          const session = `${arg0}/${directory.name}`;
          declarations.push({ kind: 'path', root: root.id, name: session, classification: 'cache', producer: 'codex-arg0-dispatch' });
          const children = await readdir(join(path, session), { withFileTypes: true });
          if (children.some(file => file.name === '.lock' && file.isFile())) {
            declarations.push({ kind: 'path', root: root.id, name: `${session}/.lock`, classification: 'cache', producer: 'codex-arg0-dispatch' });
          }
          for (const child of children) {
            if (!child.isSymbolicLink() || !['apply_patch', 'applypatch', 'codex-linux-sandbox', 'codex-execve-wrapper'].includes(child.name)) continue;
            try {
              if (await ownsHelper(await realpath(join(path, session, child.name)))) {
                declarations.push({ kind: 'path', root: root.id, name: `${session}/${child.name}`, classification: 'cache', producer: 'codex-arg0-dispatch' });
              }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ELOOP') throw error; }
          }
        }
      }
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
        // Raw path-scoped changes contain the same regular-file blob identities
        // in one Git read, instead of one subprocess for every revision.
        const { stdout } = await execFileAsync('git', ['-C', repository, 'log', '--all', '--format=',
          '--raw', '--no-abbrev', '--no-renames', '-z', '--', name], { maxBuffer: 16 * 1024 * 1024 });
        const blobs = new Set<string>();
        const fields = stdout.split('\0');
        for (let index = 0; index + 1 < fields.length; index += 2) {
          const match = /^:\d{6} (100(?:644|755)) [0-9a-f]+ ([0-9a-f]+) [AMT]$/.exec(fields[index].trim());
          if (match && fields[index + 1] === name) blobs.add(match[2]);
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

/** Exact runtime sidefile writers; siblings require separate provenance. */
export async function runtimeSidefileCensusProducer(home = homedir(), environment: NodeJS.ProcessEnv = process.env,
  workingDirectories: readonly string[] = []) {
  const root: CensusRoot = { id: 'runtime-sidefiles', path: join(home, '.papercusp') };
  const roots = [root];
  const declarations: CensusDeclaration[] = [];
  // Before console-spawn moved sentinels into scratch, its interactive shell
  // used `touch .papercup-console-active.$$` in the launch cwd (2b9578d44c^).
  // These empty process leases are regenerated on the destination. Do not
  // infer ownership of nonempty files, linked directories or neighboring data.
  for (const directory of new Set([root.path, papercuspHome(environment, home), ...workingDirectories])) {
    try { if (!(await lstat(directory)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = /^\.papercup-console-active\.([1-9][0-9]{0,9})$/.exec(entry.name);
      if (!entry.isFile() || !match || Number(match[1]) > 2147483647) continue;
      let handle;
      try {
        handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size !== 0) continue;
        let consoleRoot = roots.find(candidate => candidate.path === directory);
        if (!consoleRoot) { consoleRoot = { id: `runtime-console-${roots.length}`, path: directory }; roots.push(consoleRoot); }
        declarations.push({ kind: 'path', root: consoleRoot.id, name: entry.name,
          classification: 'cache', producer: 'console-spawn-legacy-sentinel' });
      } catch (error) {
        if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { await handle?.close(); }
    }
  }
  const pacingFile = 'google-vertex-gemini-3.1-pro-preview.json';
  for (const [directory, producer, files, classification] of [
    ['provider-pacing', 'omp-vertex-request-start', [pacingFile, `${pacingFile}.lock`], 'state'],
    ['template-gym', 'template-gym-runner', ['last-run.json', 'runs.jsonl'], 'state'],
    ['cache', 'tui-shared-query-cache', ['plans-list-standard-v1.json'], 'cache'],
    ['cache/bundle-free-refs', 'bundle-free-reference-analysis', [], 'cache'],
  ] as const) {
    let entries;
    try {
      if (!(await lstat(join(root.path, directory))).isDirectory()) continue;
      // A symlinked cache container cannot establish ownership of its target.
      if (directory.startsWith('cache/') && !(await lstat(join(root.path, 'cache'))).isDirectory()) continue;
      entries = await readdir(join(root.path, directory), { withFileTypes: true });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push({ kind: 'path', root: root.id, name: directory, classification, producer });
    for (const entry of entries) {
      const atomic = directory === 'provider-pacing' && entry.name.startsWith(`${pacingFile}.tmp-`) &&
        /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.name.slice(`${pacingFile}.tmp-`.length));
      const queryTemporary = directory === 'cache' && /^\.plans-list-standard-v1\.[0-9]+\.tmp$/.test(entry.name);
      const bundle = directory === 'cache/bundle-free-refs' && /^[0-9a-f]{64}\.json(?:\.[0-9]+\.tmp)?$/.test(entry.name);
      if (entry.isFile() && ((files as readonly string[]).includes(entry.name) || atomic || queryTemporary || bundle)) {
        declarations.push({ kind: 'path', root: root.id, name: `${directory}/${entry.name}`, classification, producer });
      }
    }
  }
  // These writers use host-home resolution, not the active-workspace registry.
  // Include the ordinary home as well as the configured home: a relocation
  // does not remove older cache files from the whole-install inventory.
  // The embedding worker uses ||, while the co-change host helper trims the
  // pin; preserve both writer contracts rather than substituting papercuspRoot.
  const ordinaryHome = join(home, '.papercusp');
  // endpoint-ipc-discovery uses host-platform/home, including its override;
  // these advertisements and interrupted atomic writes describe live processes
  // and must be regenerated on the destination rather than transported.
  for (const directory of new Set([ordinaryHome, papercuspHome(environment, home)])) {
    try { if (!(await lstat(directory)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let endpointRoot = roots.find(candidate => candidate.path === directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = /^endpoint-ipc(?:\.(\d{1,5}))?\.json(?:\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)?$/.exec(entry.name);
      if (!entry.isFile() || !match || (match[1] && (Number(match[1]) < 1 || Number(match[1]) > 65535))) continue;
      // An existing directory alone is not provenance for another census root.
      if (!endpointRoot) { endpointRoot = { id: `runtime-endpoint-${roots.length}`, path: directory }; roots.push(endpointRoot); }
      declarations.push({ kind: 'path', root: endpointRoot.id, name: entry.name,
        classification: 'cache', producer: 'endpoint-ipc-discovery' });
    }
  }
  // The desktop version reporter writes under shared_sidecar_home(), not
  // PAPERCUSP_HOME or the workspace registry. `home` is the sidecar's actual
  // HOME (including a baked channel subhome); also retain the GUI's real home.
  // Do not guess other channel homes from arbitrary directory names or env stamps.
  const desktopHome = environment.HOME ?? environment.USERPROFILE;
  for (const directory of new Set([ordinaryHome, ...(desktopHome === undefined ? [] : [resolve(desktopHome, '.papercusp')])])) {
    try { if (!(await lstat(directory)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let desktopRoot = roots.find(candidate => candidate.path === directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (environment.HOME !== undefined && directory === resolve(environment.HOME, '.papercusp') && entry.name === 'desktop-build-target.json') {
        if (!desktopRoot) { desktopRoot = { id: `runtime-desktop-${roots.length}`, path: directory }; roots.push(desktopRoot); }
        declarations.push({ kind: 'path', root: desktopRoot.id, name: entry.name,
          classification: 'config', producer: 'desktop-env-switch-target' });
      }
      if (!/^desktop-app-version(?:-[^/\\:.\0]+)?\.json$/.test(entry.name)) continue;
      let handle;
      try {
        handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > 64 * 1024) continue;
        const report = JSON.parse(await handle.readFile('utf8'));
        if (!report || typeof report.display !== 'string' || typeof report.version !== 'string' ||
          !Number.isSafeInteger(report.pid) || report.pid < 1 || !Number.isFinite(report.startedAtMs) ||
          typeof report.role !== 'string' || typeof report.isDev !== 'boolean') continue;
        const expected = report.display === '' ? 'desktop-app-version.json' :
          `desktop-app-version-${report.display.replaceAll(':', '').replaceAll('.', '_')}.json`;
        if (entry.name !== expected) continue;
        if (!desktopRoot) { desktopRoot = { id: `runtime-desktop-${roots.length}`, path: directory }; roots.push(desktopRoot); }
        declarations.push({ kind: 'path', root: desktopRoot.id, name: entry.name,
          classification: 'cache', producer: 'desktop-app-version-report' });
      } catch (error) {
        if (!(error instanceof SyntaxError) && !['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { await handle?.close(); }
    }
  }
  // sidecar-main resolves through host-platform/home, not the workspace
  // registry. Preserve the old default after relocation, the configured home,
  // and an explicit log override. Its writer retains exactly one rotation.
  const gatewayLogs = new Set([join(ordinaryHome, 'gateway.log'),
    join(papercuspHome(environment, home), 'gateway.log')]);
  if (environment.PAPERCUSP_GATEWAY_LOG) gatewayLogs.add(resolve(environment.PAPERCUSP_GATEWAY_LOG));
  for (const log of gatewayLogs) {
    try { if (!(await lstat(dirname(log))).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const path of [log, `${log}.1`]) {
      try { if (!(await lstat(path)).isFile()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const directory = dirname(path);
      let logRoot = roots.find(candidate => candidate.path === directory);
      if (!logRoot) {
        // An override authorizes these exact files, not their parent's other
        // contents (which may be outside the Papercusp data tree altogether).
        logRoot = { id: `runtime-gateway-log-${roots.length}`, path: directory, fileNames: [] };
        roots.push(logRoot);
      }
      if (logRoot.fileNames && !logRoot.fileNames.includes(basename(path))) logRoot.fileNames.push(basename(path));
      declarations.push({ kind: 'path', root: logRoot.id, name: basename(path),
        classification: 'state', producer: 'inference-gateway-lifecycle-log' });
    }
  }
  // Session hooks retain their own records, independently of workspace roots.
  // Match the writers' direct-file grammar rather than claiming whole trees:
  // arbitrary siblings, nested source and symlinks remain census residue.
  const ledgerDirectories = new Set([join(ordinaryHome, 'artifact-url-ledger'),
    join(papercuspHome(environment, home), 'artifact-url-ledger')]);
  if (environment.PAPERCUSP_ARTIFACT_LEDGER_DIR) ledgerDirectories.add(environment.PAPERCUSP_ARTIFACT_LEDGER_DIR);
  // papercup-backup-health-check.sh retains trend baselines and alert memory.
  // Its shell override is independent of PAPERCUSP_HOME. Keep the ordinary
  // directory in the inventory after relocation, without claiming arbitrary
  // marker-looking files or recursively hiding unknown contents.
  const backupHealthFiles = new Set([
    'db-disk-history', 'db-disk-history.tmp', 'backup-volume-history', 'backup-volume-history.tmp',
    'db-disk-red-ei-filed', 'db-relation-bloat-ei-filed', 'backup-volume-red-ei-filed',
    'workspace-dead-dump-tmp', 'consecutive-fails', 'stale-tmp',
  ]);
  const artifacts = (environment.BACKUP_ARTIFACTS || 'pg/papercusp-state pg/papercusp-transcript pg/restart').split(/[ \t\n]+/);
  // Explicit optional paths are usable evidence; unexpanded globs are not.
  const optionalArtifacts = (environment.BACKUP_OPTIONAL_ARTIFACTS || '').split(/[ \t\n]+/);
  for (const artifact of [...artifacts, ...optionalArtifacts]) {
    if (!artifact || /[*?\[]/.test(artifact)) continue;
    for (const prefix of ['missing', 'stale']) backupHealthFiles.add(`${prefix}-${artifact.replaceAll('/', '-')}`);
  }
  for (const directory of (environment.BACKUP_TMPDIR_WATCH || '/tmp:/tmp/pcv').split(':')) {
    if (!directory) continue;
    // `tr -c 'A-Za-z0-9' '-'` replaces bytes, including each UTF-8 byte.
    const suffix = Array.from(Buffer.from(directory), byte =>
      (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
        ? String.fromCharCode(byte) : '-').join('');
    backupHealthFiles.add(`tmpdir-entries-red${suffix}`);
  }
  const backupHealthDirectories = new Set([join(ordinaryHome, 'backup-health')]);
  if (environment.BACKUP_STATE_DIR) backupHealthDirectories.add(environment.BACKUP_STATE_DIR);
  // Kopia shares the default directory, but has its own relocation contract
  // and owns only the alert-delivery timestamp, not the probe's other markers.
  const kopiaHealthDirectories = new Set([join(ordinaryHome, 'backup-health')]);
  if (environment.HEALTHCHECK_STATE_DIR) kopiaHealthDirectories.add(environment.HEALTHCHECK_STATE_DIR);
  const stateDirectories = [
    { path: join(ordinaryHome, 'advisory-seen'), producer: 'bash-resource-gate-advisory-seen',
      file: /^[A-Za-z0-9_.-]{1,120}$/ },
    ...[...ledgerDirectories].map(path => ({ path, producer: 'artifact-url-delivery-ledger',
      file: /^[A-Za-z0-9_.-]{1,120}\.ids$/ })),
    ...[...backupHealthDirectories].map(path => ({ path, producer: 'backup-health-probe',
      file: { test: (name: string) => backupHealthFiles.has(name) } })),
    ...[...kopiaHealthDirectories].map(path => ({ path, producer: 'kopia-healthcheck',
      file: { test: (name: string) => name === 'last-alert' } })),
  ];
  for (const directory of stateDirectories) {
    try {
      if (!(await lstat(directory.path)).isDirectory()) continue;
      if (dirname(directory.path) === ordinaryHome && !(await lstat(ordinaryHome)).isDirectory()) continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const local = dirname(directory.path) === ordinaryHome;
    const sessionRoot = local ? root : roots.find(candidate => candidate.path === directory.path)
      ?? { id: `runtime-session-records-${roots.length}`, path: directory.path };
    if (!local && !roots.includes(sessionRoot)) roots.push(sessionRoot);
    const prefix = local ? `${basename(directory.path)}/` : '';
    if (local) declarations.push({ kind: 'path', root: root.id, name: basename(directory.path),
      classification: 'state', producer: directory.producer });
    for (const entry of await readdir(directory.path, { withFileTypes: true })) {
      if (entry.isFile() && directory.file.test(entry.name)) declarations.push({
        kind: 'path', root: sessionRoot.id, name: `${prefix}${entry.name}`,
        classification: 'state', producer: directory.producer,
      });
    }
  }
  const cacheHomes = new Set([ordinaryHome, papercuspHome(environment, home), environment.PAPERCUSP_HOME || ordinaryHome]);
  for (const cacheHome of cacheHomes) {
    try {
      if (!(await lstat(cacheHome)).isDirectory() || !(await lstat(join(cacheHome, 'cache'))).isDirectory()) continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let cacheRoot = roots.find(entry => entry.path === cacheHome);
    if (!cacheRoot) { cacheRoot = { id: `runtime-cache-home-${roots.length}`, path: cacheHome }; roots.push(cacheRoot); }
    for (const [name, producer] of [
      ['cochange-index', 'warm-cochange-snapshot'],
      ['transformers', 'local-embedder-worker-cache'],
    ] as const) {
      const directory = join(cacheHome, 'cache', name);
      try { if (!(await lstat(directory)).isDirectory()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      declarations.push({ kind: 'path', root: cacheRoot.id, name: 'cache', classification: 'cache', producer });
      declarations.push({ kind: 'path', root: cacheRoot.id, name: `cache/${name}`, classification: 'cache', producer,
        ...(name === 'transformers' ? { descendants: true, prune: true } : {}) });
      if (name === 'cochange-index') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && /^[0-9a-f]{16}\.json(?:\.[0-9]+\.tmp)?$/.test(entry.name)) {
            declarations.push({ kind: 'path', root: cacheRoot.id, name: `cache/${name}/${entry.name}`,
              classification: 'cache', producer });
          }
        }
      }
    }
  }
  // Mutex leases are host-local process metadata, recreated by the primitive.
  // Transporting them would copy stale ownership onto a different machine.
  // Resolve the writer's real root (including relocation), never inspect or
  // delete a live lease merely to establish this export classification.
  const mutex = resolveFsMutexLockRoot(process.env, { homeDir: home });
  let mutexExists = false;
  try { mutexExists = (await lstat(mutex)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (mutexExists) {
    let parent = roots.find(entry => entry.path === dirname(mutex));
    if (!parent) { parent = { id: 'runtime-mutex-parent', path: dirname(mutex) }; roots.push(parent); }
    declarations.push({ kind: 'path', root: parent.id, name: basename(mutex), classification: 'cache',
      producer: 'filesystem-mutex-runtime', descendants: true, prune: true });
  }
  return { roots, declarations };
}

export function mergeNestedCensusRoots(input: { roots: CensusRoot[]; declarations: CensusDeclaration[] }) {
  const normalized = input.roots.map(root => ({ ...root, path: resolve(root.path) }));
  const contains = (parent: CensusRoot, child: CensusRoot) => {
    const suffix = relative(parent.path, child.path);
    return !suffix || (parent.fileNames === undefined &&
      !suffix.startsWith(`..${sep}`) && suffix !== '..' && !suffix.startsWith(sep));
  };
  const roots = normalized.filter((root, index) => !normalized.some((other, otherIndex) =>
    otherIndex !== index && contains(other, root) && (other.path !== root.path ||
      (other.fileNames === undefined && root.fileNames !== undefined) ||
      ((other.fileNames === undefined) === (root.fileNames === undefined) && otherIndex < index))));
  for (const root of roots) {
    if (root.fileNames !== undefined) root.fileNames = [...new Set(normalized
      .filter(other => other.path === root.path).flatMap(other => other.fileNames ?? []))].sort();
  }
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
export function stripRangeCacheCensusProducer(home = homedir()) {
  const path = process.env.PAPERCUSP_STRIP_CACHE_DIR || join(home, '.papercusp', 'cache', 'strip-ranges');
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
    paths.push({ path: closureDigestManifestPath(process.env.AFFECTED_TASK_VERDICT_CACHE_PATH), producer: 'affected-tests-closure-manifest' });
  }
  const closureSuffix = closureDigestManifestPath('');
  const verdictName = /^papercusp-affected-passing-verdicts-v2-(?:committed-)?[0-9a-f]{16}\.json$/;
  const partialName = new RegExp(`^papercusp-affected-partial-v${PARTIAL_TASK_CHECKPOINT_SCHEMA}-[0-9a-f]{24}\\.json$`);
  const partialDirectory = process.env.AFFECTED_PARTIAL_RESUME_CACHE_DIR || directory;
  for (const cacheDirectory of new Set([directory, partialDirectory].map(path => resolve(path)))) {
    // A relocated writer directory is not authority to follow a symlink or own
    // all of its contents. Enumerate only exact regular writer files.
    try { if (!(await lstat(cacheDirectory)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of await readdir(cacheDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const closure = entry.name.endsWith(closureSuffix);
      const verdict = closure ? entry.name.slice(0, -closureSuffix.length) : entry.name;
      if (cacheDirectory === resolve(directory) && verdictName.test(verdict)) {
        paths.push({ path: join(cacheDirectory, entry.name),
          producer: closure ? 'affected-tests-closure-manifest' : 'affected-tests-passing-verdict' });
      } else if (partialName.test(entry.name)) {
        paths.push({ path: join(cacheDirectory, entry.name), producer: 'affected-tests-partial-checkpoint' });
      }
    }
  }
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    const path = resolve(entry.path);
    if (seen.has(path)) continue;
    seen.add(path);
    try { if (!(await lstat(entry.path)).isFile()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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

/** One measured historical writer dialect. Whole-program matching prevents a
 * later overwrite, reassignment or unrelated call from masquerading as proof.
 * Only the three AST-derived path/URL literals may vary; nothing is evaluated.
 */
const hostedProfileWriter = `import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createCipheriv,scryptSync,randomBytes} from 'node:crypto';
import {hostname,userInfo} from 'node:os';
import {runInNewContext} from 'node:vm';
const fixture=resolve(userInfo().homedir,'FIXTURE');
const destination=resolve(userInfo().homedir,'DESTINATION');
if(existsSync(destination)) throw new Error('Destination exists: inspect before overwrite');
if((statSync(fixture).mode&0o777)!==0o600) throw new Error('Fixture must remain private');
const source=readFileSync('node_modules/verdict-cli/src/server.mjs','utf8');
const start=source.indexOf('const MACHINE_KEY =');
const end=source.indexOf('function decryptData',start);
const encrypt=runInNewContext(source.slice(start,end)+'\\nencryptData;', {hostname,userInfo,scryptSync,randomBytes,createCipheriv,Buffer});
const state=JSON.parse(readFileSync(fixture,'utf8'));
writeFileSync(destination,encrypt({cookies:state.cookies,storage:{localStorage:{},sessionStorage:{}},url:'URL',savedAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({profile:destination,mode:'0600',cookieCount:state.cookies.length,expirationPreserved:true,valuesPrinted:false}));`;

function sourceTokens(source: string, replacements = new Map<string, string>()) {
  const parsed = ts.createSourceFile('evidence.js', source, ts.ScriptTarget.Latest, true);
  const transformed = ts.transform(parsed, [context => node => {
    const visit: ts.Visitor = child => ts.isStringLiteral(child)
      ? ts.factory.createStringLiteral(replacements.get(child.text) ?? child.text)
      : ts.visitEachChild(child, visit, context);
    return ts.visitNode(node, visit) as ts.SourceFile;
  }]);
  const normalized = ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]);
  transformed.dispose();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, normalized);
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const value = token === ts.SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText();
    tokens.push(JSON.stringify([token, value]));
  }
  return tokens.join('|');
}

export function historicalHostedProfileConstruction(toolInput: string, home = homedir()) {
  if (toolInput.length > 65_536) return null;
  const outer = ts.createSourceFile('tool.js', toolInput, ts.ScriptTarget.Latest, true);
  const commands: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(outer) === 'tools.exec_command' &&
      node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const property of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(outer) === 'cmd' && ts.isStringLiteralLike(property.initializer)) commands.push(property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(outer);
  // A native exec input can batch the writer with a subsequent browser snapshot.
  // Select the supported quoted program, not the last cmd property in the AST.
  const candidates = commands.map(command => command.match(/^node --input-type=module <<'JS'\n([\s\S]*)\nJS$/)).filter(match => match !== null);
  if (candidates.length !== 1) return null;
  const match = candidates[0];
  const program = ts.createSourceFile('writer.js', match[1], ts.ScriptTarget.Latest, true);
  const literals = new Map<string, string>();
  for (const statement of program.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !['fixture', 'destination'].includes(declaration.name.text) ||
        !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
      const value = declaration.initializer.arguments[1];
      if (value && ts.isStringLiteralLike(value)) literals.set(declaration.name.text, value.text);
    }
  }
  let url: string | undefined;
  const findUrl = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(program) === 'url' && ts.isStringLiteralLike(node.initializer)) url = node.initializer.text;
    ts.forEachChild(node, findUrl);
  };
  findUrl(program);
  const fixture = literals.get('fixture');
  const destination = literals.get('destination');
  if (!fixture || !destination || !url || new Set([fixture, destination, url]).size !== 3) return null;
  if (commands.some(command => !command.match(/^node --input-type=module <<'JS'\n([\s\S]*)\nJS$/) &&
    (command.includes(fixture) || command.includes(destination)))) return null;
  const replacements = new Map([[fixture, 'FIXTURE'], [destination, 'DESTINATION'], [url, 'URL']]);
  if (sourceTokens(match[1], replacements) !== sourceTokens(hostedProfileWriter)) return null;
  // Historical evidence grants inspection of exact Papercusp configuration files,
  // not arbitrary paths mentioned in a transcript or linked destinations.
  const config = join(home, '.config', 'papercusp');
  const input = resolve(home, fixture);
  const output = resolve(home, destination);
  if (dirname(input) !== config || dirname(output) !== config || input === output) return null;
  return { input, output, url };
}

export interface HostedProfileWriterEvidence { ref: string; toolInput: string; startedAt: string; finishedAt: string }

// Archived call_dQMd66bJTVYVPiteJs6wlHg9, 2026-09-05. Only path literals vary.
// This program is evidence to parse, never a command to execute.
const playwrightStateWriter = String.raw`const { chromium }=require('./node_modules/@playwright/test');
const fs=require('fs');
const identity=JSON.parse(fs.readFileSync('IDENTITY','utf8'));
const password=fs.readFileSync('PASSWORD','utf8').trim();
const statePath='DESTINATION';
(async()=>{
  const browser=await chromium.launch({headless:true,proxy:{server:'socks5://127.0.0.1:18029'}});
  const c=await browser.newContext({serviceWorkers:'block'});const p=await c.newPage();
  await p.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces',{waitUntil:'domcontentloaded',timeout:60000});
  for(let i=0;i<3;i++){
    const pw=p.locator('input[type=password],input[name=password]').first();if(await pw.isVisible().catch(()=>false))break;
    const em=p.locator('input[name=email],input[type=email]').first();await em.waitFor({state:'visible',timeout:30000});await em.fill(identity.email);
    await p.getByRole('button',{name:/continue with email|continue|sign in/i}).first().click();await p.waitForTimeout(2500);
  }
  const pw=p.locator('input[type=password],input[name=password]').first();await pw.waitFor({state:'visible',timeout:30000});await pw.fill(password);
  await p.getByRole('button',{name:/sign in|continue/i}).first().click();
  await p.waitForURL(u=>u.hostname==='app.papercusp.com'&&u.pathname!=='/api/hosted/auth/callback',{timeout:60000,waitUntil:'domcontentloaded'});
  const session=await p.evaluate(async()=>{const r=await fetch('/api/hosted/auth/session',{cache:'no-store'});const b=await r.json().catch(()=>null);return{status:r.status,ok:b?.ok===true,session:b?.session?{workspaceId:b.session.workspaceId??null,organizationId:b.session.organizationId??null,expiresAtMs:b.session.expiresAtMs??null,sessionVersion:b.session.sessionVersion??null}:null,error:b?.error??null}});
  await c.storageState({path:statePath});fs.chmodSync(statePath,0o600);const st=fs.statSync(statePath);
  console.log(JSON.stringify({final:{host:new URL(p.url()).host,path:new URL(p.url()).pathname},session,storageState:{path:statePath,mode:(st.mode&0o777).toString(8),bytes:st.size}},null,2));
  await browser.close();
})().catch(e=>{console.error(JSON.stringify({error:String(e),name:e?.name||null}));process.exit(1)});`;

// Exact inner program from SHA-verified codex archive 01a07742, line 614.
// Authentication metadata is a receipt, not a digest of the complete saved file.
const playwrightStateWriterSept6 = "const { chromium } = require('./node_modules/@playwright/test');\nconst fs = require('fs');\nconst crypto = require('crypto');\nconst identity = JSON.parse(fs.readFileSync('IDENTITY', 'utf8'));\nconst password = fs.readFileSync('PASSWORD', 'utf8').trim();\nconst statePath = 'DESTINATION';\n(async () => {\n  const startedAt = Date.now();\n  const browser = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:18029' } });\n  try {\n    const context = await browser.newContext({ serviceWorkers: 'block' });\n    const page = await context.newPage();\n    await page.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces', { waitUntil: 'domcontentloaded', timeout: 60000 });\n    const editableEmail = page.locator('input[name=email]:not([readonly]),input[type=email]:not([readonly])').first();\n    const passwordInput = page.locator('input[type=password],input[name=password]').first();\n    await Promise.race([editableEmail.waitFor({ state: 'visible', timeout: 30000 }), passwordInput.waitFor({ state: 'visible', timeout: 30000 })]);\n    if (await editableEmail.isVisible().catch(() => false)) {\n      await editableEmail.fill(identity.email);\n      await page.getByRole('button', { name: /continue with email|continue|sign in/i }).first().click();\n    }\n    await passwordInput.waitFor({ state: 'visible', timeout: 30000 });\n    await passwordInput.fill(password);\n    await page.getByRole('button', { name: /sign in|continue/i }).first().click();\n    await page.waitForURL((url) => url.hostname === 'app.papercusp.com', { timeout: 60000 });\n    let session = null;\n    for (let attempt = 0; attempt < 30; attempt += 1) {\n      const response = await context.request.get('https://app.papercusp.com/api/hosted/auth/session', { failOnStatusCode: false });\n      const body = await response.json().catch(() => null);\n      if (response.status() === 200 && body?.ok === true && body?.session?.sessionId && body?.session?.userId && body?.session?.organizationId) {\n        session = body.session;\n        break;\n      }\n      await page.waitForTimeout(1000);\n    }\n    if (!session) throw new Error('authenticated session metadata did not become available');\n    await context.storageState({ path: statePath });\n    fs.chmodSync(statePath, 0o600);\n    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));\n    const appCookie = saved.cookies.find((cookie) => cookie.name === '__Host-papercusp_session');\n    console.log(JSON.stringify({\n      ok: true,\n      statePath,\n      mode: (fs.statSync(statePath).mode & 0o777).toString(8),\n      sessionHash: crypto.createHash('sha256').update(session.sessionId).digest('hex').slice(0, 12),\n      userPresent: Boolean(session.userId),\n      organizationPresent: Boolean(session.organizationId),\n      workspaceBound: Boolean(session.workspaceId),\n      cookiePresent: Boolean(appCookie),\n      cookieExpires: appCookie?.expires ?? null,\n      durationMs: Date.now() - startedAt,\n    }));\n  } finally {\n    await browser.close();\n  }\n})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });";

export function historicalPlaywrightStateConstruction(toolInput: string, home = homedir()) {
  if (toolInput.length > 65_536) return null;
  const outer = ts.createSourceFile('tool.js', toolInput, ts.ScriptTarget.Latest, true);
  const commands: string[] = [];
  // September 6 uses a top-level const and prints the terminal envelope. Resolve
  // that binding only for the complete measured wrapper, never arbitrary JS.
  const commandDeclaration = outer.statements[0];
  if (commandDeclaration && ts.isVariableStatement(commandDeclaration) &&
    (commandDeclaration.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    commandDeclaration.declarationList.declarations.length === 1) {
    const declaration = commandDeclaration.declarationList.declarations[0];
    if (ts.isIdentifier(declaration.name) && declaration.name.text === 'cmd' &&
      declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
      const wrapper = `const cmd = 'COMMAND';
let r=await tools.exec_command({cmd,workdir:'WORKDIR',yield_time_ms:30000,max_output_tokens:3000});
while('session_id'in r&&!Object.prototype.hasOwnProperty.call(r,'exit_code'))r=await tools.write_stdin({session_id:r.session_id,chars:'',yield_time_ms:30000,max_output_tokens:3000});
text(r);`;
      if (sourceTokens(toolInput, new Map([[declaration.initializer.text, 'COMMAND'],
        [join(home, 'papercupai-workspace', 'papercusp'), 'WORKDIR']])) !== sourceTokens(wrapper)) return null;
      commands.push(declaration.initializer.text);
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(outer) === 'tools.exec_command' &&
      node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const property of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(outer) === 'cmd' && ts.isStringLiteralLike(property.initializer)) commands.push(property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(outer);
  if (commands.length !== 1) return null;
  const match = commands[0].match(/^node - <<'NODE'\n([\s\S]*)\nNODE$/);
  if (!match) return null;
  const program = ts.createSourceFile('writer.js', match[1], ts.ScriptTarget.Latest, true);
  const paths = new Map<string, string>();
  const findPaths = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === 'statePath' && ts.isStringLiteral(node.initializer)) paths.set('DESTINATION', node.initializer.text);
      if (['identity', 'password'].includes(node.name.text)) {
        const literals: string[] = [];
        const findRead = (child: ts.Node) => {
          if (ts.isCallExpression(child) && child.expression.getText(program) === 'fs.readFileSync' &&
            child.arguments[0] && ts.isStringLiteral(child.arguments[0])) literals.push(child.arguments[0].text);
          ts.forEachChild(child, findRead);
        };
        findRead(node.initializer);
        if (literals.length === 1) paths.set(node.name.text.toUpperCase(), literals[0]);
      }
    }
    ts.forEachChild(node, findPaths);
  };
  findPaths(program);
  const output = paths.get('DESTINATION'); const identity = paths.get('IDENTITY'); const password = paths.get('PASSWORD');
  if (!output || !identity || !password || new Set(paths.values()).size !== 3 ||
    dirname(output) !== join(home, '.config', 'papercusp') ||
    !/^\/run\/user\/\d+\//.test(identity) || dirname(identity) !== dirname(password)) return null;
  const normalized = sourceTokens(match[1], new Map([...paths].map(([key, value]) => [value, key])));
  if (![playwrightStateWriter, playwrightStateWriterSept6].some(writer => normalized === sourceTokens(writer))) return null;
  return { output };
}

export interface PlaywrightStateWriterEvidence extends HostedProfileWriterEvidence { receipt: string; indexedRef?: string }

export interface IndexedCensusWriterEvidence extends HostedProfileWriterEvidence { sessionId: string }

/** Locate writers independently of receipt layout. An adjacent result is only
 * the legacy fallback timestamp; canonical archive recovery pairs by call_id.
 */
export async function readHistoricalCensusWriterCandidates(sql: Sql) {
  const candidates = await sql<IndexedCensusWriterEvidence[]>`
    SELECT 'session-part:' || writer.source_kind || ':' || writer.session_id || ':' || writer.part_idx AS ref,
      writer.session_id AS "sessionId", writer.text AS "toolInput", writer.ts::text AS "startedAt",
      COALESCE(receipt.ts::text, '') AS "finishedAt"
    FROM harness_shared.session_turn_parts writer
    LEFT JOIN harness_shared.session_turn_parts receipt
      ON receipt.workspace_id = writer.workspace_id AND receipt.source_kind = writer.source_kind
      AND receipt.session_id = writer.session_id AND receipt.part_idx = writer.part_idx + 1
      AND receipt.part_kind = 'tool_result'
    WHERE writer.workspace_id = 'default' AND writer.source_kind = 'codex' AND writer.part_kind = 'tool_use'
      AND (writer.text LIKE '%writeFileSync(destination,encrypt(%'
        OR (writer.text LIKE '%chromium%' AND writer.text LIKE '%statePath%')
        OR writer.text LIKE '%securewrite(%')
    ORDER BY writer.session_id, writer.part_idx
    LIMIT 101
  `;
  if (candidates.length > 100) throw new Error('Historical census evidence bound exceeded');
  return candidates;
}

/** Attest the complete measured Python dialect without executing archived code.
 * Only its three private path literals vary. The hash covers securewrite, test
 * account checks, result construction, the final write and printed receipt.
 */
export function historicalStripeConfigConstruction(toolInput: string, home = homedir()) {
  if (toolInput.length > 65_536) return null;
  const outer = ts.createSourceFile('tool.js', toolInput, ts.ScriptTarget.Latest, true);
  const commands: string[] = [];
  for (const statement of outer.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
      statement.expression.expression.getText(outer) !== 'text' || statement.expression.arguments.length !== 1) return null;
    const awaited = statement.expression.arguments[0];
    if (!ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression)) return null;
    const call = awaited.expression;
    if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) return null;
    const properties = call.arguments[0].properties;
    const literal = (name: string) => {
      const matches = properties.filter(property => ts.isPropertyAssignment(property) && property.name.getText(outer) === name);
      return matches.length === 1 && ts.isPropertyAssignment(matches[0]) && ts.isStringLiteralLike(matches[0].initializer)
        ? matches[0].initializer.text : null;
    };
    switch (call.expression.getText(outer)) {
      case 'tools.exec_command': {
        const command = literal('cmd');
        if (command === null) return null;
        commands.push(command);
        break;
      }
      case 'tools.write_stdin': if (literal('chars') !== '') return null; break;
      case 'tools.mcp__papercusp_su__tools_invoke':
        if (!['rubrics:propose', 'locks:acquire'].includes(literal('name') ?? '')) return null;
        break;
      default: return null;
    }
  }
  if (commands.length !== 1) return null;
  const program = commands[0].match(/^python3 - <<'PY'\n([\s\S]*)\nPY$/)?.[1];
  if (!program) return null;
  const key = program.match(/^key=Path\('([^'\n]+)'\)\.read_text\(\)\.strip\(\)$/m)?.[1];
  const secret = program.match(/^securewrite\('([^'\n]+)',hook\['secret'\]\+'\\n'\)$/m)?.[1];
  const output = program.match(/^securewrite\('([^'\n]+)',json\.dumps\(result,indent=2\)\+'\\n'\)$/m)?.[1];
  if (!key || !secret || !output || new Set([key, secret, output]).size !== 3 ||
    dirname(key) !== join(home, '.papercusp', 'secrets') || dirname(secret) !== dirname(key) ||
    dirname(output) !== join(home, '.config', 'papercusp')) return null;
  const normalized = program.replaceAll(key, 'KEY').replaceAll(secret, 'WEBHOOK_SECRET').replaceAll(output, 'DESTINATION');
  if (createHash('sha256').update(normalized).digest('hex') !== 'da6deb2c614f4489b872a79fcd08aae8085265c1cfdd825ddeb550d529cdcd88') return null;
  return { output, accountId: program.match(/^ACCOUNT='([^']+)'$/m)![1] };
}

/** A successful receipt transports content; only matching installed bytes admit it.
 * No keys, configuration values or archived executable source enter the census.
 */
export async function historicalStripeConfigCensusProducer(evidence: readonly PlaywrightStateWriterEvidence[], home = homedir()) {
  const roots: CensusRoot[] = []; const declarations: CensusDeclaration[] = [];
  if (evidence.length > 100) throw new Error('Stripe configuration evidence bound exceeded');
  for (const record of evidence) {
    const construction = historicalStripeConfigConstruction(record.toolInput, home);
    const from = Date.parse(record.startedAt); const to = Date.parse(record.finishedAt);
    if (!construction || !record.ref || !Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 300_000) continue;
    const recovered = historicalCensusReceipt(record.receipt);
    if (!recovered) continue;
    const receipt = JSON.parse(recovered);
    if (Object.keys(receipt).sort().join() !== 'accountId,accountName,mode,plans,portalConfigurationId,webhookEndpointId,webhookUrl,workItem' ||
      receipt.accountId !== construction.accountId || receipt.accountName !== 'Papercusp LLC' || receipt.workItem !== 'WI-10005826' ||
      receipt.webhookUrl !== 'https://app.papercusp.com/api/hosted/billing/webhook' ||
      !receipt.plans.every((plan: Record<string, unknown>) => Object.keys(plan).sort().join() === 'description,label,planKey,priceId,productId')) continue;
    // Python json.dumps(indent=2) defaults to ensure_ascii=True. These fields
    // contain strings only, so escaping UTF-16 code units also covers astral text.
    const expected = Buffer.from(JSON.stringify(receipt, null, 2).replace(/[\u007f-\uffff]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n');
    if (expected.length > 1_048_576) continue;
    let handle;
    try {
      if (await realpath(dirname(construction.output)) !== dirname(construction.output)) continue;
      handle = await open(construction.output, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expected.length || (stat.mode & 0o777) !== 0o600 || stat.mtimeMs < from || stat.mtimeMs > to) continue;
      if (!(await handle.readFile()).equals(expected)) continue;
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || (after.mode & 0o777) !== 0o600) continue;
      const root: CensusRoot = { id: `stripe-config-${roots.length}`, path: dirname(construction.output) };
      roots.push(root); declarations.push({ kind: 'path', root: root.id, name: basename(construction.output),
        classification: 'secret', producer: `historical-stripe-test-config:${record.ref}` });
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally { await handle?.close(); }
  }
  return { roots, declarations };
}

/** Native exec can print a completed shell envelope instead of its stdout.
 * Only unwrap the documented successful terminal envelope; a yielded handle,
 * failed command, or arbitrary nested object is not a writer receipt.
 */
function historicalCensusReceipt(text: string): string | null {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('exit_code' in value || 'session_id' in value) {
    if (value.exit_code !== 0 || 'session_id' in value || typeof value.output !== 'string') return null;
    try { value = JSON.parse(value.output); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  }
  // Preserve the complete historical configuration, not a path-only summary.
  // Recovery is evidence transport; installed-content admission remains separate.
  const stripeConfig = value.mode === 'test' && typeof value.accountId === 'string' &&
    value.accountId.startsWith('acct_') && typeof value.accountName === 'string' &&
    Array.isArray(value.plans) && value.plans.length > 0 &&
    value.plans.every((plan: Record<string, unknown>) => plan && typeof plan === 'object' &&
      ['planKey', 'priceId', 'productId', 'label', 'description'].every(key => typeof plan[key] === 'string')) &&
    ['portalConfigurationId', 'webhookEndpointId', 'webhookUrl', 'workItem'].every(key => typeof value[key] === 'string');
  return stripeConfig || value.storageState !== undefined ||
    (value.ok === true && typeof value.statePath === 'string' && typeof value.sessionHash === 'string')
    ? JSON.stringify(value) : null;
}

/** The search index locates a session/time; it is not the complete source.
 * Reuse the session-port reader's manifest, bounded decompression and SHA checks.
 * Pair calls by call_id, never by adjacent lines/parts (outputs can interleave).
 */
export async function recoverHistoricalCensusWriterEvidence(candidates: readonly IndexedCensusWriterEvidence[],
  readArchive: (sessionId: string) => Promise<{ bytes: Buffer; sha256: string }> = async sessionId => {
    const { readCanonicalNativeArchive } = await import('../session-port/source');
    const { pgSessionArchiveStore } = await import('../session-archive');
    return readCanonicalNativeArchive({ backend: 'codex', sessionId }, pgSessionArchiveStore());
  }): Promise<PlaywrightStateWriterEvidence[]> {
  if (candidates.length > 100) throw new Error('Historical census evidence bound exceeded');
  const result: PlaywrightStateWriterEvidence[] = [];
  for (const sessionId of new Set(candidates.map(candidate => candidate.sessionId))) {
    let source;
    try { source = await readArchive(sessionId); }
    catch (error) {
      if (error instanceof Error && error.message === 'canonical codex archive not found') continue;
      throw error;
    }
    if (source.bytes.length > 64 * 1024 * 1024 || createHash('sha256').update(source.bytes).digest('hex') !== source.sha256) throw new Error('Historical census archive SHA/size mismatch');
    const selected = candidates.filter(candidate => candidate.sessionId === sessionId);
    const calls = new Map<string, { input: string; timestamp: string; line: number }>();
    const outputs = new Map<string, { output: unknown; timestamp: string }>();
    const duplicate = new Set<string>();
    let line = 0;
    for (const raw of source.bytes.toString('utf8').split('\n')) {
      line++;
      if (!raw.trim()) continue;
      let record;
      try { record = JSON.parse(raw); } catch { throw new Error('Historical census archive JSONL malformed'); }
      const payload = record?.payload;
      if (record?.type !== 'response_item' || typeof payload?.call_id !== 'string') continue;
      if (['custom_tool_call', 'function_call'].includes(payload.type) && payload.name === 'exec' &&
        selected.some(candidate => Date.parse(candidate.startedAt) === Date.parse(record.timestamp))) {
        let input = payload.input ?? payload.arguments;
        if (payload.type === 'function_call' && typeof input === 'string') {
          try { const args = JSON.parse(input); if (typeof args.code === 'string') input = args.code; } catch { /* Raw code is also a native dialect. */ }
        }
        if (typeof input !== 'string' || input.length > 65_536) continue;
        if (calls.has(payload.call_id)) duplicate.add(payload.call_id);
        calls.set(payload.call_id, { input, timestamp: record.timestamp, line });
      }
      if (['custom_tool_call_output', 'function_call_output'].includes(payload.type)) {
        if (outputs.has(payload.call_id)) duplicate.add(payload.call_id);
        outputs.set(payload.call_id, { output: payload.output, timestamp: record.timestamp });
      }
    }
    for (const [callId, call] of calls) {
      const output = outputs.get(callId);
      if (!output || duplicate.has(callId)) continue;
      const texts = typeof output.output === 'string' ? [output.output] : Array.isArray(output.output)
        ? output.output.flatMap(block => typeof block?.text === 'string' ? [block.text] : []) : [];
      const receipts = texts.flatMap(text => {
        const receipt = historicalCensusReceipt(text);
        return receipt === null ? [] : [receipt];
      });
      if (result.length >= 100) throw new Error('Historical census recovered call bound exceeded');
      result.push({ ref: `archive:codex:${sessionId}:sha256:${source.sha256}:line:${call.line}:call:${callId}`,
        indexedRef: selected.find(candidate => Date.parse(candidate.startedAt) === Date.parse(call.timestamp))?.ref,
        toolInput: call.input, startedAt: call.timestamp, finishedAt: output.timestamp,
        receipt: receipts.length === 1 ? receipts[0] : '' });
    }
  }
  return result;
}

/** Receipt, complete writer, private file metadata and storage-state schema must
 * agree. A filename or an indexed/truncated command alone proves nothing.
 */
export async function historicalPlaywrightStateCensusProducer(evidence: readonly PlaywrightStateWriterEvidence[], home = homedir()) {
  const roots: CensusRoot[] = []; const declarations: CensusDeclaration[] = [];
  if (evidence.length > 100) throw new Error('Playwright state evidence bound exceeded');
  for (const record of evidence) {
    const construction = historicalPlaywrightStateConstruction(record.toolInput, home);
    const from = Date.parse(record.startedAt); const to = Date.parse(record.finishedAt);
    if (!construction || !record.ref || !Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 300_000) continue;
    let receipt;
    try { receipt = JSON.parse(record.receipt); } catch { continue; }
    if (!receipt || typeof receipt !== 'object' || receipt.final?.host !== 'app.papercusp.com' || receipt.final?.path !== '/cloud-workspaces' ||
      receipt.session?.status !== 200 || receipt.session?.ok !== true || receipt.session?.error !== null ||
      receipt.storageState?.path !== construction.output || receipt.storageState?.mode !== '600' ||
      !Number.isSafeInteger(receipt.storageState?.bytes) || receipt.storageState.bytes <= 0 || receipt.storageState.bytes > 1_048_576) continue;
    let handle;
    try {
      if (await realpath(dirname(construction.output)) !== dirname(construction.output)) continue;
      handle = await open(construction.output, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== receipt.storageState.bytes || (stat.mode & 0o777) !== 0o600 ||
        stat.mtimeMs < from || stat.mtimeMs > to) continue;
      const state = JSON.parse(await handle.readFile('utf8'));
      if (!state || typeof state !== 'object' || Object.keys(state).sort().join() !== 'cookies,origins' || !Array.isArray(state.cookies) || !state.cookies.length || !Array.isArray(state.origins)) continue;
      if (!state.cookies.every((cookie: Record<string, unknown>) => cookie && typeof cookie === 'object' && typeof cookie.name === 'string' && typeof cookie.value === 'string' &&
        typeof cookie.domain === 'string' && typeof cookie.path === 'string' && typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) &&
        typeof cookie.httpOnly === 'boolean' && typeof cookie.secure === 'boolean' && ['Strict', 'Lax', 'None'].includes(String(cookie.sameSite)))) continue;
      if (!state.cookies.some((cookie: { domain: string }) => ['app.papercusp.com', '.papercusp.com'].includes(cookie.domain))) continue;
      if (!state.origins.every((origin: { origin?: unknown; localStorage?: unknown }) => origin && typeof origin === 'object' && typeof origin.origin === 'string' &&
        Array.isArray(origin.localStorage) && origin.localStorage.every(value => typeof value?.name === 'string' && typeof value?.value === 'string'))) continue;
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || (after.mode & 0o777) !== 0o600) continue;
      const root: CensusRoot = { id: `playwright-state-${roots.length}`, path: dirname(construction.output) };
      roots.push(root); declarations.push({ kind: 'path', root: root.id, name: basename(construction.output),
        classification: 'secret', producer: `historical-playwright-storage-state:${record.ref}` });
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') && !(error instanceof SyntaxError)) throw error;
    } finally { await handle?.close(); }
  }
  return { roots, declarations };
}

/** Extend the hosted surface with content-proven historical destinations only.
 * The input's own provenance remains independent: consuming it is not creating it.
 * Decrypted values never leave this function or appear in the census manifest.
 */
export async function historicalHostedProfileCensusProducer(evidence: readonly HostedProfileWriterEvidence[],
  home = homedir(), readerPath = join(moduleRepoRoot(import.meta.url), 'node_modules/verdict-cli/src/server.mjs')) {
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  if (evidence.length > 100) throw new Error('Hosted profile evidence bound exceeded');
  if (!evidence.length) return { roots, declarations };
  let reader: string;
  try { reader = await readFile(readerPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots, declarations }; throw error; }
  const expectedReader = `const MACHINE_KEY = scryptSync(\
    \`\${hostname()}-\${userInfo().username}-verdict-cli\`, 'verdict-cli-salt-v1', 32);
function encryptData(data) { const iv = randomBytes(16); const cipher = createCipheriv('aes-256-cbc', MACHINE_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex') }); }
function decryptData(raw) { const { iv, data } = JSON.parse(raw);
  const decipher = createDecipheriv('aes-256-cbc', MACHINE_KEY, Buffer.from(iv, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')); }`;
  const start = reader.indexOf('const MACHINE_KEY =');
  const end = reader.indexOf('function profilePath', start);
  if (start < 0 || end < 0 || sourceTokens(reader.slice(start, end)) !== sourceTokens(expectedReader)) return { roots, declarations };
  const privateFile = async (path: string) => {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1_048_576 || (stat.mode & 0o777) !== 0o600) return null;
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  };
  const key = scryptSync(`${hostname()}-${userInfo().username}-verdict-cli`, 'verdict-cli-salt-v1', 32);
  for (const record of evidence) {
    const construction = historicalHostedProfileConstruction(record.toolInput, home);
    const from = Date.parse(record.startedAt); const to = Date.parse(record.finishedAt);
    if (!construction || !record.ref || !Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 300_000) continue;
    try { if (await realpath(dirname(construction.output)) !== dirname(construction.output)) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const input = await privateFile(construction.input); const output = await privateFile(construction.output);
    if (input === null || output === null) continue;
    try {
      const state = JSON.parse(input); const envelope = JSON.parse(output);
      if (Object.keys(envelope).sort().join() !== 'data,iv' || typeof envelope.iv !== 'string' || !/^[0-9a-f]{32}$/.test(envelope.iv) ||
        typeof envelope.data !== 'string' || !/^(?:[0-9a-f]{32})+$/.test(envelope.data)) continue;
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(envelope.iv, 'hex'));
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'hex')), decipher.final()]).toString('utf8'));
      const savedAt = Date.parse(value.savedAt);
      if (Object.keys(value).sort().join() !== 'cookies,savedAt,storage,url' || !Array.isArray(state.cookies) ||
        JSON.stringify(value.cookies) !== JSON.stringify(state.cookies) || value.url !== construction.url ||
        JSON.stringify(value.storage) !== '{"localStorage":{},"sessionStorage":{}}' || !Number.isFinite(savedAt) || savedAt < from || savedAt > to) continue;
      const root: CensusRoot = { id: `hosted-profile-${roots.length}`, path: dirname(construction.output) };
      roots.push(root);
      declarations.push({ kind: 'path', root: root.id, name: basename(construction.output), classification: 'secret', producer: `historical-hosted-profile:${record.ref}` });
    } catch { /* Corrupt or nonmatching content supplies no ownership proof. */ }
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
/** Read complete literal migration arrays without executing application code. */
function literalMigrationStatements(source: string): string[] {
  const file = ts.createSourceFile('migrations.ts', source, ts.ScriptTarget.Latest, true);
  const statements: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      let initializer = declaration.initializer;
      while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith('_MIGRATIONS') ||
        !initializer || !ts.isArrayLiteralExpression(initializer)) continue;
      if (initializer.elements.some(element => !ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element))) continue;
      statements.push(...initializer.elements.map(element => (element as ts.StringLiteralLike).text));
    }
  }
  return statements;
}

export function migrationProducerTables(source: string): string[] {
  return [...new Set(literalMigrationStatements(source).flatMap(statement => {
    const match = statement.match(/^\s*CREATE TABLE(?: IF NOT EXISTS)? ([a-z_][a-z0-9_]*)\s*\(/i);
    return match ? [`public.${match[1].toLowerCase()}`] : [];
  }))];
}

/** Bound history to this registered repository and this exact regular-file path.
 * Historical schemas require columns/types, never an arbitrary table overlap.
 */
async function historicalProjectMigrationSources(repository: string, producer: string): Promise<MigrationCensusSource[]> {
  const options = { timeout: 5000, maxBuffer: 4 * 1024 * 1024 };
  let root: string;
  try { root = (await execFileAsync('git', ['-C', repository, 'rev-parse', '--show-toplevel'], options)).stdout.trim(); }
  catch (error) {
    if ((error as { code?: number | string }).code === 128) return [];
    throw error;
  }
  if (resolve(root) !== resolve(repository)) return [];
  const name = 'packages/data/src/migrations.ts';
  const { stdout } = await execFileAsync('git', ['-C', repository, 'log', '--all', '--max-count=128',
    '--format=', '--raw', '--no-abbrev', '--no-renames', '-z', '--', name], options);
  const fields = stdout.split('\0');
  const blobs = new Set<string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const match = /^:\d{6} 100(?:644|755) [0-9a-f]+ ([0-9a-f]+) [AMT]$/.exec(fields[index].trim());
    if (match && fields[index + 1] === name) blobs.add(match[1]);
  }
  const sources: MigrationCensusSource[] = [];
  const schemas = new Set<string>();
  for (const blob of blobs) {
    const size = Number((await execFileAsync('git', ['-C', repository, 'cat-file', '-s', blob], options)).stdout.trim());
    if (!Number.isSafeInteger(size) || size <= 0 || size > 1_048_576) continue;
    const text = (await execFileAsync('git', ['-C', repository, 'cat-file', 'blob', blob], options)).stdout;
    // Functions, prose and ALTER statements cannot introduce CREATE evidence.
    const sql = literalMigrationStatements(text).filter(statement => /^\s*CREATE\s+TABLE\b/i.test(statement)).join(';\n');
    const source = sqlMigrationCensusSource(sql, `${producer}:git-blob:${blob}:${name}`);
    if (!source) continue;
    const identity = JSON.stringify([source.tables, source.columns]);
    if (!schemas.has(identity)) { schemas.add(identity); sources.push(source); }
  }
  return sources;
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
      sources.push(...await historicalProjectMigrationSources(project.path, `app-migrations:registry:${project.slug}:${project.path}`));
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
      const column = part.match(new RegExp(`^(${identifier})\\s+(text|integer|bigint|jsonb|boolean|tsvector|timestamptz|timestamp(?:\\s+(?:with|without)\\s+time\\s+zone)?|double\\s+precision)\\b`, 'i'));
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
export async function installedUnitCensusDeclarations(
  scope: 'user' | 'system',
  readUnitPaths: (scope: 'user' | 'system') => Promise<readonly string[]> = async scope => {
    const { stdout } = await execFileAsync('systemd-analyze', [`--${scope}`, 'unit-paths'], { encoding: 'utf8' });
    return stdout.split('\n').map(path => path.trim()).filter(Boolean);
  },
): Promise<CensusDeclaration[]> {
  if (process.platform !== 'linux') throw new Error('Systemd census requires Linux');
  const runtime = scope === 'system' ? '/run/systemd'
    : join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`, 'systemd');
  // Use systemd's load-path resolver: fixed directory lists miss runtime user
  // units, XDG data roots and control directories. Names in the live unit
  // catalog still cannot establish ownership without an actual definition.
  const sources = [...new Set(await readUnitPaths(scope))];
  if (!sources.length || sources.some(source => !isAbsolute(source))) {
    throw new Error('Invalid systemd unit source paths');
  }
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
