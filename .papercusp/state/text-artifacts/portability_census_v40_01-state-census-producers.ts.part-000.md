---
rel_path: "portability/census/v40/01-state-census-producers.ts.part-000"
updated_at: 1794240912951
_body: "content"
---

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

/** Pool references own credentials. Durable Codex homes also retain exact vendor
 * runtime files; copied or unknown children still require their own provenance. */
export async function accountCredentialCensusProducer(accounts: ReadonlyArray<{ credentialRef: string }>) {
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const account of accounts) {
    const home = parseCodexCliRef(account.credentialRef);
    const path = home ? codexAuthPath(home) : /^(?:file|token):(.+)$/.exec(account.credentialRef)?.[1];
    if (!path || !isAbsolute(path)) continue;
    const directory = dirname(path);
    let metadata;
    try { metadata = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // completeCodexCliLink creates this home and the gateway runs Codex with
    // CODEX_HOME pointing at it. A suffix without a pool reference is no proof.
    const durable = home && metadata.isDirectory() && basename(dirname(directory)) === 'deploy-credentials' &&
      /^[A-Za-z0-9._-]+\.codex-cli$/.test(basename(directory)) && (await lstat(dirname(directory))).isDirectory();
    const rootPath = durable ? dirname(directory) : directory;
    const prefix = durable ? `${basename(directory)}/` : '';
    let root = roots.find(entry => entry.path === rootPath);
    if (!root) {
      root = { id: `account-credential-${roots.length}`, path: rootPath, ...(durable ? {} : { fileNames: [] }) };
      roots.push(root);
    }
    // fileNames selects regular files only. A managed account container needs
    // ordinary traversal so foreign siblings and descendants remain residue.
    if (durable) delete root.fileNames;
    const add = (name: string, classification: CensusDeclaration['classification'] = 'secret',
      producer = 'account-pool-credential-reference') => {
      const selected = name.split('/')[0];
      if (root!.fileNames && !root!.fileNames.includes(selected)) root!.fileNames.push(selected);
      if (!declarations.some(entry => entry.root === root!.id && entry.name === name)) {
        declarations.push({ kind: 'path', root: root!.id, name, classification, producer });
      }
    };
    if (durable) add(basename(directory), 'state', 'account-link-cli-completed-home');
    add(`${prefix}${basename(path)}`);
    if (home) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // persistCodexAuth's exact atomic writer; do not read token contents.
      for (const entry of entries ?? []) {
        if (entry.isFile() && /^auth\.json\.[0-9]+\.tmp$/.test(entry.name)) add(`${prefix}${entry.name}`);
      }
      if (!durable) continue;
      const files = new Set((entries ?? []).filter(entry => entry.isFile()).map(entry => entry.name));
      // Codex rust-v0.167.0 state/src/sqlite.rs RuntimeDbSpec. Preserve the
      // database and its SQLite WAL/SHM companions together, never as cache.
      // Check only the bounded header; do not open a live database via SQLite
      // (even a read-only connection can create or mutate its shared memory).
      for (const database of ['state_5.sqlite', 'logs_2.sqlite', 'goals_1.sqlite', 'memories_1.sqlite',
        'memories_v2_1.sqlite', 'queue_1.sqlite', 'thread_history_1.sqlite']) {
        if (!files.has(database)) continue;
        let handle;
        try {
          handle = await open(join(directory, database), constants.O_RDONLY | constants.O_NOFOLLOW);
          if (!(await handle.stat()).isFile()) continue;
          const header = Buffer.alloc(16);
          const { bytesRead } = await handle.read(header, 0, header.length, 0);
          if (bytesRead !== header.length || header.toString('ascii') !== 'SQLite format 3\0') continue;
          add(`${prefix}${database}`, 'state', 'codex-sqlite-runtime');
          for (const suffix of ['-wal', '-shm']) if (files.has(`${database}${suffix}`)) {
            add(`${prefix}${database}${suffix}`, 'state', 'codex-sqlite-runtime');
          }
        } catch (error) {
          if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        } finally { await handle?.close(); }
      }
      // core/src/installation_id.rs persists a UUID, with no newline required.
      if (files.has('installation_id')) {
        let handle;
        try {
          handle = await open(join(directory, 'installation_id'), constants.O_RDONLY | constants.O_NOFOLLOW);
          const info = await handle.stat();
          if (!info.isFile() || info.size > 128) continue;
          const value = (await handle.readFile('utf8')).trim();
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
            add(`${prefix}installation_id`, 'config', 'codex-installation-id');
          }
        } catch (error) {
          if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        } finally { await handle?.close(); }
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
  try {
    if (!(await lstat(join(path, 'deploy-credentials'))).isDirectory()) return { roots: [root], declarations };
    entries = await readdir(join(path, 'deploy-credentials'), { withFileTypes: true });
  }
  catch (error) { if ((e
