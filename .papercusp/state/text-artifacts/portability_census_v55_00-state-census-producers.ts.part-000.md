---
rel_path: "portability/census/v55/00-state-census-producers.ts.part-000"
updated_at: 1794250602744
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
import { oauthStateKeyFilePath } from '../oauth/state';
import { fleetClaudeTokenPath } from '@papercusp/orchestrator/fleet-claude-token';
import { parseUnitEnvironment } from '../provisioner/unit-drift';
import ts from 'typescript';
import { identityDir } from '../identity/keychain';
import { anchorKeyFilePath } from '../cupboard/ledger-anchor-eas';
import { papercuspRoot } from '../papercusp-root';
import { parseCodexCliRef } from '../inference-gateway/codex-cli-bridge';
import { codexAuthPath } from '../inference-gateway/codex-oauth-proxy';
import { parseCredentialRef, parseApiKeySource } from '../inference-gateway/credential-store';
import { readPlanTemplateDirForInstall } from '../cupboard/plan-template-store';
import { REAP_TAIL_MAX_BYTES, verifyReapTailReceipt } from '../task-manager/reap-archive';
import { resolveSqlDir } from '../migration-drift';
import { stripCommentsAndStrings, stripSqlCommentsAndStrings } from '../../../../scripts/lib/strip-comments-and-strings.mjs';
import { resolveFsMutexLockRoot } from '../../../../scripts/lib/fs-mutex.mjs';
import { closureDigestManifestPath } from '../../../../scripts/lib/passing-task-verdict-cache.mjs';
import { PARTIAL_TASK_CHECKPOINT_SCHEMA } from '../../../../scripts/lib/partial-task-resume.mjs';
import { defaultTestRunArtifactBase } from '../agent-tools/testing/run-artifacts';
import { readNativeArtifactBytes, verifyNativeProofPacket } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';

/** Original verifier outputs need the writer's terminal retained custody, not a filename match. */
async function verifierOriginalCensusDeclarations(home: string, root: string): Promise<CensusDeclaration[]> {
  const base = join(home, 'test-artifacts');
  const canonicalDirectory = async (path: string) => {
    try { return (await lstat(path)).isDirectory() && await realpath(path) === resolve(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  if (!await canonicalDirectory(base)) return [];
  const signature = (stat: Awaited<ReturnType<typeof lstat>>) =>
    [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':');
  // Dependency receipts can be large. Hash through a bounded stream rather
  // than loading them alongside the complete host inventory.
  const inspect = async (path: string, metadata = false) => {
    if (await realpath(path) !== resolve(path)) throw new Error('redirected verifier evidence');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || (metadata && stat.size > 8 * 1024 * 1024))
        throw new Error('invalid verifier evidence file');
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      let sizeBytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        sizeBytes += chunk.length; hash.update(chunk);
        if (metadata) chunks.push(chunk);
      }
      const stamp = signature(stat);
      if (sizeBytes !== stat.size || signature(await handle.stat()) !== stamp
        || signature(await lstat(path)) !== stamp || await realpath(path) !== resolve(path))
        throw new Error('verifier evidence changed during read');
      return { path, stamp, sizeBytes, sha256: hash.digest('hex'), bytes: Buffer.concat(chunks) };
    } finally { await handle.close(); }
  };
  const unchanged = async (file: Awaited<ReturnType<typeof inspect>>) =>
    signature(await lstat(file.path)) === file.stamp && await realpath(file.path) === resolve(file.path);
  const containers = [base];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'testing-run' && !entry.name.startsWith('native-router-')
      && await canonicalDirectory(join(base, entry.name))) containers.push(join(base, entry.name));
  }
  const declarations = new Map<string, CensusDeclaration>();
  const add = (path: string) => {
    const name = relative(home, path).split(sep).join('/');
    declarations.set(name, { kind: 'path', root, name, classification: 'state', producer: 'source-preview-verifier-original' });
  };
  for (const container of containers) for (const entry of await readdir(container, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.task.json')) continue;
    try {
      const task = await inspect(join(container, entry.name), true);
      const receipt = JSON.parse(task.bytes.toString('utf8'));
      if (receipt.schemaVersion !== 'verifier-task-v1' || typeof receipt.taskId !== 'string'
        || !/^[A-Za-z0-9-]{1,100}$/.test(receipt.taskId) || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0
        || typeof receipt.processIdentity !== 'string' || !receipt.processIdentity
        || typeof receipt.repoRoot !== 'string' || !isAbsolute(receipt.repoRoot)
        || typeof receipt.ownedRoot !== 'string' || !isAbsolute(receipt.ownedRoot)
        || !['completed', 'failed', 'deferred'].includes(receipt.cleanup)) continue;
      const receiptPath = task.path.slice(0, -'.task.json'.length);
      const runId = createHash('sha256').update(resolve(receiptPath)).digest('hex');
      const evidenceRoot = join(home, 'checkpoint-logs', `verifier-task-${receipt.taskId}`, runId);
      const manifestPath = join(evidenceRoot, 'manifest.json');
      if (receipt.evidenceManifestPath !== manifestPath || !await canonicalDirectory(evidenceRoot)) continue;
      const manifestFile = await inspect(manifestPath, true);
      const manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
      const suffixes: Record<string, string> = { 'task.json': '.task.json', 'phases.jsonl': '.phases.jsonl',
        'resources.jsonl': '.resources.jsonl', 'source.json': '', 'snapshot.txt': '.snapshot.txt',
        'dependencies.json': '.dependencies.json', 'dependencies-after.json': '.dependencies.after.json',
        'child.json': '.child.json', 'stdout.log': '.stdout.log', 'stderr.log': '.stderr.log' };
      if (manifest.schemaVersion !== 'verifier-task-evidence-v1' || manifest.taskId !== receipt.taskId
        || manifest.runId !== runId || typeof manifest.sourceCommit !== 'string'
        || !/^[0-9a-f]{40,64}$/.test(manifest.sourceCommit) || manifest.cleanup !== receipt.cleanup
        || !['completed', 'failed'].includes(manifest.wrapperStatus)
        || (manifest.childExitCode !== null && !Number.isSafeInteger(manifest.childExitCode))
        || manifest.childLogs?.stdout !== 'stdout.log' || manifest.childLogs?.stderr !== 'stderr.log'
        || !manifest.artifacts || !manifest.artifacts['task.json'] || !manifest.artifacts['phases.jsonl']) continue;
      const witnesses = [task, manifestFile];
      const originals: Array<Awaited<ReturnType<typeof inspect>>> = [];
      for (const [role, pin] of Object.entries(manifest.artifacts) as Array<[string, { path: string; sizeBytes: number; sha256: string }]>) {
        if (!Object.hasOwn(suffixes, role) || pin.path !== join(evidenceRoot, role)
          || !Number.isSafeInteger(pin.sizeBytes) || pin.sizeBytes < 0 || !/^[0-9a-f]{64}$/.test(pin.sha256))
          throw new Error('invalid verifier artifact pin');
        const retained = await inspect(pin.path, role === 'task.json');
        if (retained.sizeBytes !== pin.sizeBytes || retained.sha256 !== pin.sha256
          || (role === 'task.json' && !retained.bytes.equals(task.bytes))) throw new Error('invalid retained verifier artifact');
        witnesses.push(retained);
        if (role === 'task.json') continue;
        try {
          const original = await inspect(`${receiptPath}${suffixes[role]}`);
          if (original.sizeBytes === pin.sizeBytes && original.sha256 === pin.sha256) originals.push(original);
        } catch { /* Missing, linked or changed originals remain residue independently. */ }
      }
      // Publish no declaration until the complete retained bundle and its
      // external terminal receipt still match the observation above.
      if (!(await Promise.all(witnesses.map(unchanged))).every(Boolean)) continue;
      if (!await canonicalDirectory(container) || !await canonicalDirectory(evidenceRoot)) continue;
      add(base); add(container); add(task.path);
      for (const original of originals) if (await unchanged(original).catch(() => false)) add(original.path);
    } catch { /* Partial, forged, redirected or corrupt custody proves no original ownership. */ }
  }
  return [...declarations.values()];
}

/** Inspect the router's retained packets, never arbitrary artifact siblings. */
async function nativeRouterCensusDeclarations(home: string, root: string): Promise<CensusDeclaration[]> {
  const declarations = new Map<string, CensusDeclaration>();
  const base = join(home, 'test-artifacts');
  const directory = async (path: string) => {
    try { return (await lstat(path)).isDirectory() && await realpath(path) === resolve(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  if (!await directory(base)) return [];
  const add = (path: string) => {
    const name = relative(home, path).split(sep).join('/');
    if (!name || name === '..' || name.startsWith('../') || isAbsolute(name)) return;
    declarations.set(name, { kind: 'path', root, name, classification: 'state', producer: 'test-file-native-router-custody' });
  };
  const json = async (path: string) => {
    const stat = await lstat(path);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 8 * 1024 * 1024) throw new Error('unproven router metadata');
    const bytes = readNativeArtifactBytes(path, stat.size, 8 * 1024 * 1024);
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  };
  // PAPERCUSP_TEST_ARTIFACT_DIR can select an immediate artifact container.
  // Do not recurse through unrelated outputs or the already-retained testing-run.
  const containers = [base];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'testing-run' && !entry.name.startsWith('native-router-')) {
      const path = join(base, entry.name);
      if (await directory(path)) containers.push(path);
    }
  }
  for (const container of containers) for (const entry of await readdir(container, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^native-router-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const packet = join(container, entry.name);
    try {
      const expected = await json(join(packet, 'expected.json'));
      const locator = await json(join(packet, 'locator.json'));
      const verified = verifyNativeProofPacket(packet, locator.value, expected.value);
      // Custody is an ownership witness even for a partial capture. Its native
      // proof and acceptance verdicts remain unqualified and unmeasured.
      const manifest = verified.manifest;
      if (!expected.value.expected.every((group: { id: string }) => /^group-[0-9]+(?:-detail-[0-9]+)?$/.test(group.id))) continue;
      const pins = [locator.value.manifest, ...(manifest.segments ?? []).map((segment: { artifact: unknown }) => segment.artifact)];
      const manifestObject = await json(join(packet, 'objects', locator.value.manifest.ref));
      if (manifestObject.value.schemaVersion === 'native-proof-index-v1') {
        pins.push(...manifestObject.value.parts.map((part: { artifact: unknown }) => part.artifact));
      }
      const originals: Array<{ path: string; artifact: { sha256: string; byteLength: number } }> = [];
      for (const group of manifest.groups) {
        for (const family of group.families) for (const captured of family.entries) {
          if (captured.chunked) pins.push(...captured.chunked.parts.map((part: { artifact: unknown }) => part.artifact));
          else pins.push(captured.artifact);
        }
        for (const auxiliary of group.auxiliary) if (auxiliary.artifact) {
          pins.push(auxiliary.artifact);
          if (['stdout', 'stderr', 'command-exit.json'].includes(auxiliary.role)
            && auxiliary.path === join(packet, `${group.id}.${auxiliary.role}`)) {
            originals.push({ path: auxiliary.path, artifact: auxiliary.artifact });
          }
        }
      }
      if (!(await json(join(packet, 'expected.json'))).bytes.equals(expected.bytes)
        || !(await json(join(packet, 'locator.json'))).bytes.equals(locator.bytes)) continue;
      add(base); add(container); add(packet); add(join(packet, 'objects'));
      add(join(packet, 'expected.json')); add(join(packet, 'locator.json'));
      for (const pin of pins) if (pin) add(join(packet, 'objects', pin.ref));
      // Original child streams can change independently of retained custody.
      // Only claim exact local originals still matching their retained bytes.
      for (const original of originals) {
        try {
          const bytes = readNativeArtifactBytes(original.path, original.artifact.byteLength, 8 * 1024 * 1024);
          if (createHash('sha256').update(bytes).digest('hex') === original.artifact.sha256) add(original.path);
        } catch { /* Changed, linked or missing originals remain unresolved. */ }
      }
    } catch { /* An incomplete, redirected or corrupt packet proves no ownership. */ }
  }
  return [...declarations.values()];
}

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
    let path = home ? codexAuthPath(home) : undefined;
    if (!home) {
      // Use the same path expansion and source grammar as the credential reader.
      // Unsupported references own no filesystem path; filesystem failures below
      // must still surface instead of disappearing as malformed references.
      try {
        const ref = parseCredentialRef(account.credentialRef);
        if (ref.kind === 'file' || ref.kind === 'token') path = ref.path;
        else if (ref.kind === 'apikey') {
          const source = parseApiKeySource(ref.path);
          if (source.kind === 'file') path = source.path;
        }
      } catch { continue; }
    }
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
    const files = await readdir(join(path, name), { withFileTypes: true });
    if (!entry.name.startsWith('.codex-setup-')) {
      // account-link-cli selects CLAUDE_CONFIG_DIR for these homes. Claude's
      // config writer retains .claude.json and exact timestamped backup or
      // corruption copies under backups (including its legacy adjacent copy).
      // Config can embed MCP credentials: preserve every such copy as secret.
      const configCopy = /^\.claude\.json\.(?:backup|corrupted)\.[0-9]{13}$/;
      const addSecret = (file: string) => declarations.push({ kind: 'path', root: root.id,
        name: `${name}/${file}`, classification: 'secret', producer: 'claude-cli-setup-config' });
      for (const file of files) {
        if (file.isFile() && (file.name === '.claude.json' || file.name === '.claude.json.backup' || configCopy.test(file.name))) addSecret(file.name);
        if (file.name !== 'backups' || !file.isDirectory()) continue;
        declarations.push({ kind: 'path', root: root.id, name: `${name}/backups`,
          classification: 'state', producer: 'claude-cli-setup-config' });
        for (const backup of await readdir(join(path, name, 'backups'), { withFileTypes: true })) {
          if (backup.isFile() && configCopy.test(backup.name)) addSecret(`backups/${backup.name}`);
        }
      }
      continue;
    }
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
  workingDirectories: readonly string[] = [], runtimeHomes: readonly string[] = []) {
  const root: CensusRoot = { id: 'runtime-sidefiles', path: join(home, '.papercusp') };
  const roots = [root];
  const declarations: CensusDeclaration[] = [];
  // console-spawn preserves the displaced project config and writes an atomic
  // replacement; psu-launcher parks role configs before installing an empty
  // stub. They can contain bearer credentials, so retain them as secrets.
  // Only inspect explicit writer roots and exact names; arbitrary backups and
  // other MCP servers are not evidence of a Papercusp writer.
  for (const directory of new Set([root.path, papercuspHome(environment, home), ...workingDirectories])) {
    try {
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== resolve(directory)) continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:\.mcp\.json(?:\.papercusp\.bak|\.su-parked)?|\.mcp\.json\.tmp-[1-9][0-9]*-[0-9]+-[0-9a-f]{12}|\.mcp\.json\.su-stub\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)$/.test(entry.name)) continue;
      let handle;
      try {
        handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > 65_536) continue;
        const config = JSON.parse(await handle.readFile('utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config)
          || Object.keys(config).length !== 1 || !config.mcpServers
          || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) continue;
        const servers = Object.keys(config.mcpServers);
        if (servers.length !== 0) {
          if (servers.length !== 1 || servers[0] !== 'papercusp') continue;
          const server = config.mcpServers.papercusp;
          if (!server || typeof server !== 'object' || Array.isArray(server)
            || Object.keys(server).some(key => !['url', 'headers', 'type'].includes(key))
            || typeof server.url !== 'string' || (server.type !== undefined && server.type !== 'http')) continue;
          const url = new URL(server.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/api/mcp'
            || !url.searchParams.get('workspace') || (url.searchParams.get('superuser') !== '1'
              && !['role', 'run', 'spawn', 'client', 'exp', 'sig'].every(key => url.searchParams.get(key)))) continue;
        }
        let mcpRoot = roots.find(candidate => candidate.path === directory);
        if (!mcpRoot) { mcpRoot = { id: `runtime-mcp-${roots.length}`, path: directory }; roots.push(mcpRoot); }
        declarations.push({ kind: 'path', root: mcpRoot.id, name: entry.name,
          classification: 'secret', producer: 'console-project-mcp-writer' });
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof TypeError)
          && !['ENOENT', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { await handle?.close(); }
    }
  }
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
    catch (error) { if ((error as NodeJS.ErrnoException)
