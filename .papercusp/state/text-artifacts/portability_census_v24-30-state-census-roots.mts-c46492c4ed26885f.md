---
rel_path: "portability/census/v24-30-state-census-roots.mts-c46492c4ed26885f"
updated_at: 1794230641786
_body: "content"
---

#!/usr/bin/env -S npx tsx
/** Partial writer-root diagnostic, explicitly not a whole-install ship verdict. */
import { collectStateCensus, backupCacheCensusDeclarations } from '../packages/backup/src/state-census';
import { installedRootCensusProducers, postgresStorageDeclaration, gitStorageDeclaration, peerStorageDeclaration, portalReleaseStorageDeclaration, restoredCloneCensusDeclarations, mergeNestedCensusRoots, virtualenvCacheDeclaration } from '../packages/operator-core/lib/backup/state-census-producers';
import { readdir, lstat, readFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, dirname, basename, sep, isAbsolute } from 'node:path';
import { workspacesRoot, readRegistry, DEFAULT_WORKSPACE_ID } from '../packages/operator-core/lib/workspace-registry';
import { defaultClonesDir } from '../packages/operator-core/lib/harness/clone-github';
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import { physicalDatabaseCensusEntries, integrationBaselineCensusDeclarations, templateDatabaseCensusDeclarations, unitCensusEntries, installedUnitCensusDeclarations } from '../packages/operator-core/lib/backup/state-census-producers';
import type { CensusEntry, CensusRoot, CensusDeclaration } from '../packages/backup/src/state-census';
import { configuredOperatorDatabaseCensusDeclarations, unitDatabaseCensusDeclarations, affectedTestCacheCensusProducer } from '../packages/operator-core/lib/backup/state-census-producers';
import { migrationProducerTables, migrationDatabaseCensusDeclarations, registeredProjectMigrationSources, canonicalSqlMigrationCensusSources, type MigrationCensusSource } from '../packages/operator-core/lib/backup/state-census-producers';
import { accountCredentialCensusProducer, runtimeSidefileCensusProducer, cliSetupHomeCensusProducer, runtimeRetainedCensusProducer, templateStoreCensusProducer, planTemplateStoreCensusProducer } from '../packages/operator-core/lib/backup/state-census-producers';
import { buildExpected } from './templates-mirror-sync.mjs';
import { historicalGitBlobIdentityResolver, workspaceTemplateStoreCensusProducer } from '../packages/operator-core/lib/backup/state-census-producers';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { reapArchiveCensusProducer, maintenanceDatabaseCensusDeclarations } from '../packages/operator-core/lib/backup/state-census-producers';
import { historicalHostedProfileCensusProducer, historicalPlaywrightStateCensusProducer, historicalStripeConfigCensusProducer, readHistoricalCensusWriterCandidates, recoverHistoricalCensusWriterEvidence, type HostedProfileWriterEvidence, type PlaywrightStateWriterEvidence } from '../packages/operator-core/lib/backup/state-census-producers';
import { papercuspRoot, papercuspRootForWorkspace } from '../packages/operator-core/lib/papercusp-root';
import { checkpointLogDirFromEnv } from '../packages/operator-core/lib/release/checkpoint-log-dir';
import { taskTerminalEventKey } from '../packages/operator-core/lib/task-manager/task-terminal-events';
import { TERMINAL_TASK_STATES } from '../packages/operator-core/lib/task-manager/types';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

/** Recover exact reaper identities even after terminal task-ledger retention.
 * A terminal latch proves writer identity, not tail contents or a successful task.
 * The producer still checks the archive's file type and writer size bound.
 */
export async function readRetainedReapTaskIds(
  taskIds: readonly string[],
  workspaces: readonly { id: string }[],
  readers: {
    readTasks?: (workspaceId: string, ids: string[]) => Promise<readonly { taskId: string }[]>;
    terminalSql?: ReturnType<typeof postgres>;
    readTerminalLatches?: (keys: string[]) => Promise<readonly {
      eventKey: string; lastFiredBy: string | null; lastPayload: unknown; fireCount: number | string;
    }[]>;
    readReaperMessages?: (workspaceIds: string[], ids: string[]) => Promise<readonly {
      workspaceId: string; writerKey: string; from: string | null; summary: string | null;
    }[]>;
  } = {},
) {
  // reapArchiveCensusProducer already batches at this bound. Refuse callers
  // that would silently truncate the ledger or perform an unbounded latch scan.
  if (taskIds.length > 1000) throw new Error('Reaper identity census batch bound exceeded');
  const requested = new Set(taskIds);
  if (!requested.size) return [];
  const readTasks = readers.readTasks ?? (async (workspaceId, ids) => {
    const { listTasks } = await import('../packages/operator-core/lib/task-manager/store');
    return listTasks({ workspaceId, includeEnded: true, taskIds: ids, limit: 2000 });
  });
  const retained = new Set<string>();
  // Both the task writer's pre-registry fallback and the coordination log's
  // pre-workspace partition remain evidence sources after registry removal.
  // sendMessage persists through coordLog, not identity.workspaceId.
  const taskWorkspaceIds = [...new Set([...workspaces.map(workspace => workspace.id), DEFAULT_WORKSPACE_ID])];
  for (const workspaceId of taskWorkspaceIds) {
    for (const task of await readTasks(workspaceId, [...requested])) {
      if (requested.has(task.taskId)) retained.add(task.taskId);
    }
  }
  const missing = [...requested].filter(id => !retained.has(id));
  if (!missing.length) return [...retained];
  const readTerminalLatches = readers.readTerminalLatches ?? (async keys => {
    // Same global event namespace and columns as getKeyFireLatch; read the
    // requested keys together rather than opening one query per archived tail.
    const sql = readers.terminalSql ?? postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5 });
    try {
      return await sql<{ eventKey: string; lastFiredBy: string | null; lastPayload: unknown; fireCount: number | string }[]>`
        SELECT event_key AS "eventKey", last_fired_by AS "lastFiredBy",
               last_payload AS "lastPayload", fire_count AS "fireCount"
          FROM harness_shared.event_key_fires
         WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
           AND event_key = ANY(${keys}::text[])
         LIMIT 1000`;
    } finally { if (!readers.terminalSql) await sql.end(); }
  });
  const missingKeys = new Set(missing.map(taskTerminalEventKey));
  const terminalStates = new Set<string>(TERMINAL_TASK_STATES);
  for (const latch of await readTerminalLatches([...missingKeys])) {
    if (!missingKeys.has(latch.eventKey) || latch.lastFiredBy !== 'task-manager'
      || !Number.isSafeInteger(Number(latch.fireCount)) || Number(latch.fireCount) <= 0) continue;
    const payload = latch.lastPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const { taskId, state } = payload as { taskId?: unknown; state?: unknown };
    if (typeof taskId === 'string' && requested.has(taskId)
      && latch.eventKey === taskTerminalEventKey(taskId)
      && typeof state === 'string' && terminalStates.has(state)) retained.add(taskId);
  }
  const unproven = [...requested].filter(id => !retained.has(id));
  const workspaceIds = [...new Set([...taskWorkspaceIds, DEFAULT_COORD_WORKSPACE])];
  if (!unproven.length) return [...retained];
  // Older archives predate terminal latches. The reaper's canonical broadcasts
  // preserve exact task identities after ledger GC, independently of filenames.
  // A failed stop can also have an archived tail; this proves identity only.
  const outcomePattern = '[✓✗] (' + unproven.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    + ') \\((terminal-residue|managed-residue|consult-settled|quiet-zombie)\\)';
  const readReaperMessages = readers.readReaperMessages ?? (async scopes => {
    const sql = readers.terminalSql ?? postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5 });
    try {
      return await sql<{ workspaceId: string; writerKey: string; from: string | null; summary: string | null }[]>`
        SELECT workspace_id AS "workspaceId", writer_key AS "writerKey",
               body->>'from' AS "from", body->>'summary' AS summary
          FROM harness_shared.coord_event_log
         WHERE workspace_id = ANY(${scopes}::text[]) AND surface = 'messages'
           AND writer_key = 'task-manager' AND body->>'summary' ~ ${outcomePattern}
         ORDER BY id LIMIT 2000`;
    } finally { if (!readers.terminalSql) await sql.end(); }
  });
  const messages = await readReaperMessages(workspaceIds, unproven);
  if (messages.length >= 2000) throw new Error('Reaper message evidence bound exceeded');
  for (const message of messages) {
    if (!workspaceIds.includes(message.workspaceId) || message.writerKey !== 'task-manager'
      || message.from !== 'task-manager' || !message.summary?.startsWith('[task-reaper] reaped ')
      || !message.summary.includes('Log tails archived under ~/.papercusp/reap-archive/. ')) continue;
    for (const match of message.summary.matchAll(new RegExp(outcomePattern, 'g'))) {
      if (requested.has(match[1])) retained.add(match[1]);
    }
  }
  return [...retained];
}

/** Reuse setup and runtime writers across active, registered and legacy homes. */
export async function readWorkspaceSetupHomes(
  workspaces: readonly { id: string }[],
  resolveRoot: (workspace: string) => string = papercuspRootForWorkspace,
  activeRoot = papercuspRoot(),
) {
  const paths = [...new Set([activeRoot, ...workspaces.map(workspace => resolveRoot(workspace.id))])];
  // papercuspRoot() and isKnownWorkspace() explicitly retain this pre-registry
  // fallback. Its absence from registry.json does not retire the writer home.
  // Do not infer any other unregistered home, or follow a linked default root.
  const legacyRoot = resolveRoot(DEFAULT_WORKSPACE_ID);
  if (!paths.includes(legacyRoot)) {
    try { if ((await lstat(legacyRoot)).isDirectory()) paths.push(legacyRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const producers = await Promise.all(paths.map(async (path, index) => {
    const setup = await cliSetupHomeCensusProducer(path);
    const retained = runtimeRetainedCensusProducer(path);
    const id = `cli-setup-homes-${index}`;
    return { roots: setup.roots.map(root => ({ ...root, id })),
      declarations: [...setup.declarations, ...retained.declarations]
        .map(declaration => ({ ...declaration, root: id })) };
  }));
  return { roots: producers.flatMap(producer => producer.roots),
    declarations: producers.flatMap(producer => producer.declarations) };
}

/** Credential ownership is workspace-scoped; the active pool is not a host census. */
export async function readWorkspaceCensusAccounts(
  workspaces: readonly { id: string }[],
  readPool: (workspace: string) => Promise<{ accounts: { credentialRef: string }[] }> = async workspace =>
    (await import('../packages/operator-core/lib/deployment/account-pool-store')).loadAccountPool(workspace),
) {
  const pools = await Promise.all([...new Set(workspaces.map(workspace => workspace.id))]
    .map(workspace => readPool(workspace)));
  return pools.flatMap(pool => pool.accounts);
}

/** Read only source-backed tables; unrelated schemas cannot exhaust this census. */
export async function readMigrationCensusColumns(sql: ReturnType<typeof postgres>, sources: readonly MigrationCensusSource[]) {
  const tables = [...new Set(sources.flatMap(source => [...source.tables]))];
  if (!tables.length) return [];
  const rows = await sql<{ table_schema: string; table_name: string; column_name: string; data_type: string; udt_schema: string; udt_name: string }[]>`
    SELECT table_schema, table_name, column_name, data_type, udt_schema, udt_name FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND (table_schema || '.' || table_name) = ANY(${tables})
    ORDER BY table_schema, table_name, ordinal_position LIMIT 20001`;
  if (rows.length > 20000) throw new Error('Database schema census bound exceeded');
  return rows;
}

type RootCensusOptions = {
  args?: string[];
  checkpointLogDir?: string;
  hostedProfileEvidence?: HostedProfileWriterEvidence[];
  historicalWriterEvidence?: PlaywrightStateWriterEvidence[];
  onStage?: (stage: string) => void;
  // Retain completed inputs before host credential/catalog reads and filesystem
  // discovery. These are intermediate snapshots, never collection verdicts.
  onDiscoverySnapshot?: (snapshot: { phase: 'before-account-credentials' | 'before-filesystem'; roots: CensusRoot[];
    declarations: CensusDeclaration[]; catalogEntries: CensusEntry[] }) => void | Promise<void>;
};

/** Admit only the advisory record written beside an independently proven store.
 * Never acquire, open or repair Corestore, or mutate a live owner's lock.
 */
async function corestoreAdvisoryLockDeclaration(root: CensusRoot, store: string): Promise<CensusDeclaration | undefined> {
  const name = `${store}.single-instance.lock`;
  const path = join(root.path, name);
  try {
    if (!(await lstat(path)).isFile()) return;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let content: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > 4096) return;
      // A concurrent writer can grow the file after stat. Bound the read itself
      // too, with one extra byte to distinguish a complete record from a prefix.
      const bytes = Buffer.alloc(4097);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 4096) return;
      content = bytes.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
    let record: unknown;
    try { record = JSON.parse(content); } catch { return; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    const fields = record as Record<string, unknown>;
    if (Object.keys(fields).some(key => !['pid', 'token', 'startedAt', 'processIdentity'].includes(key))
      || typeof fields.pid !== 'number' || !Number.isSafeInteger(fields.pid) || fields.pid <= 0
      || typeof fields.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fields.token)
      || typeof fields.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fields.startedAt)
      || !Number.isFinite(Date.parse(fields.startedAt)) || new Date(fields.startedAt).toISOString() !== fields.startedAt
      || ('processIdentity' in fields && fields.processIdentity !== null
        && (typeof fields.processIdentity !== 'string' || !fields.processIdentity.length
          || fields.processIdentity.length > 1024 || /[\u0000-\u001f\u007f]/.test(fields.processIdentity)))) return;
    return { kind: 'path', root: root.id, name, classification: 'cache', producer: 'corestore-single-instance-lock' };
  } catch (error) {
    // Missing/replaced locks and symlinks have no producer proof; all other
    // unreadable evidence must still fail discovery rather than hide a fault.
    if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

/** Discover serializable producer inputs; this alone is never a census verdict.
 * Separating the phases lets bounded diagnostics retain discovery and retry
 * collection without rescanning archives, Git history and host catalogs.
 * Importing this entry performs no census or host-catalog reads.
 */
export async function discoverRootCensusInputs(options: RootCensusOptions = {}) {
const args = options.args ?? [];
// Report stage names only: callers can time or retain progress without logging
// credential contents, archived commands, or filesystem inventory.
const stage = options.onStage ?? (() => {});
stage('installed-roots');
const installed = installedRootCensusProducers();
let hostedEvidence = options.hostedProfileEvidence ?? [];
let playwrightEvidence: PlaywrightStateWriterEvidence[] = options.historicalWriterEvidence ?? [];
if (args.includes('--host-catalogs') && options.hostedProfileEvidence === undefined && options.historicalWriterEvidence === undefined) {
  stage('historical-writer-index');
  const sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5 });
  try {
    // Bound the writer dialect, not its filenames. A new destination is derived
    // from the retained command AST and must still pass installed-content proof.
    const indexedEvidence = await readHistoricalCensusWriterCandidates(sql);
    const recovered = await recoverHistoricalCensusWriterEvidence(indexedEvidence);
    // Full index entries remain usable if their archive was never retained;
    // truncated entries still fail the whole-program validator. Browser state
    // always needs a canonical call-id-paired receipt as well as its writer.
    hostedEvidence = [...indexedEvidence.filter(indexed => !recovered.some(record => record.indexedRef === indexed.ref)), ...recovered];
    playwrightEvidence = recovered;
  } finally { await sql.end(); }
}
stage('historical-hosted-profiles');
const historicalHosted = await historicalHostedProfileCensusProducer(hostedEvidence);
stage('historical-playwright-state');
const historicalPlaywright = await historicalPlaywrightStateCensusProducer(playwrightEvidence);
stage('historical-stripe-config');
const historicalStripe = await historicalStripeConfigCensusProducer(playwrightEvidence);
const combinedHosted = mergeNestedCensusRoots({ roots: [...installed.roots, ...historicalHosted.roots, ...historicalPlaywright.roots, ...historicalStripe.roots],
  declarations: [...installed.declarations, ...historicalHosted.declarations, ...historicalPlaywright.declarations, ...historicalStripe.declarations] });
installed.roots = combinedHosted.roots;
installed.declarations = combinedHosted.declarations;
// Query exact archive identities BEFORE the ledger limit; a batch is smaller
// than the cap. GCed ledger rows need a canonical terminal latch or reaper broadcast; an archive
// filename alone never proves writer ownership.
stage('reap-archive');
const reapArchive = await reapArchiveCensusProducer(undefined, [], args.includes('--host-catalogs')
  ? taskIds => readRetainedReapTaskIds(taskIds, readRegistry().workspaces) : undefined);
stage('affected-test-cache');
const affectedCache = await affectedTestCacheCensusProducer();
stage('workspace-setup-homes');
const setupHomes = await readWorkspaceSetupHomes(readRegistry().workspaces);
stage('runtime-sidefiles');
const sidefiles = await runtimeSidefileCensusProducer(undefined, undefined,
  setupHomes.roots.map(root => root.path));
stage('template-mirror');
const templateExpected = (await buildExpected()).expected;
const historicalTemplateIdentity = historicalGitBlobIdentityResolver(fileURLToPath(new URL('..', import.meta.url)));
stage('template-store');
const templateStore = await templateStoreCensusProducer(undefined, templateExpected, historicalTemplateIdentity);
stage('workspace-template-stores');
const workspaceTemplateStores = await workspaceTemplateStoreCensusProducer(undefined, templateExpected, historicalTemplateIdentity);
stage('plan-template-store');
const planTemplateStore = await planTemplateStoreCensusProducer();
const hostCatalogs = args.includes('--host-catalogs');
const checkpointLogDir = options.checkpointLogDir ?? checkpointLogDirFromEnv();
const completedProducers = mergeNestedCensusRoots({ roots: [...installed.roots, ...affectedCache.roots, ...sidefiles.roots, ...setupHomes.roots, ...templateStore.roots, ...workspaceTemplateStores.roots, ...planTemplateStore.roots,
  { id: 'checkpoint-logs-parent', path: dirname(checkpointLogDir) }], declarations: [...installed.declarations, ...affectedCache.declarations, ...sidefiles.declarations, ...setupHomes.declarations, ...templateStore.declarations, ...workspaceTemplateStores.declarations, ...planTemplateStore.declarations, {
  kind: 'path', root: 'checkpoint-logs-parent', name: basename(checkpointLogDir), classification: 'state',
  producer: 'green-checkpoint-log-writer', descendants: true,
  retainedSubtree: { evidenceRef: 'release-config:checkpointLogDir' },
}] });
await options.onDiscoverySnapshot?.({ phase: 'before-account-credentials',
  ...structuredClone({ ...completedProducers, catalogEntries: [] }) });
stage('account-credentials');
const credentials = await accountCredentialCensusProducer(hostCatalogs
  ? await readWorkspaceCensusAccounts(readRegistry().workspaces) : []);
const producers = mergeNestedCensusRoots({ roots: [...completedProducers.roots, ...credentials.roots],
  declarations: [...completedProducers.declarations, ...credentials.declarations] });
const withReapArchive = mergeNestedCensusRoots({ roots: [...producers.roots, ...reapArchive.roots], declarations: [...producers.declarations, ...reapArchive.declarations] });
producers.roots = withReapArchive.roots;
producers.declarations = withReapArchive.declarations;
const declarations = [...producers.declarations,
  ...producers.roots.flatMap(root => backupCacheCensusDeclarations(root.id))];
const catalogEntries: CensusEntry[] = [];
const migrationSources: MigrationCensusSource[] = [];
if (hostCatalogs) {
  stage('migration-sources');
  const { loadHarnessRegistry } = await import('../packages/operator-core/lib/harness-registry');
  migrationSources.push(...await canonicalSqlMigrationCensusSources());
  for (const workspace of readRegistry().workspaces) {
    const registry = await loadHarnessRegistry(workspace.id, { fresh: true });
    migrationSources.push(...await registeredProjectMigrationSources(registry.projects));
  }
}
if (args.includes('--restore-events') || hostCatalogs) {
  stage('host-catalogs');
  const sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5 });
  try {
    for (const workspace of readRegistry().workspaces) {
      declarations.push(...await restoredCloneCensusDeclarations(sql, workspace.id, join(workspacesRoot(), workspace.id), producers.roots));
    }
    if (hostCatalogs) {
      const databases = await physicalDatabaseCensusEntries(sql);
      catalogEntries.push(...databases);
      declarations.push(...integrationBaselineCensusDeclarations(databases));
      if (databases.length) declarations.push(...await maintenanceDatabaseCensusDeclarations(sql, databases[0].root));
      if (databases.length) declarations.push(...await templateDatabaseCensusDeclarations(sql, databases[0].root));
      if (databases.length) declarations.push(...configuredOperatorDatabaseCensusDeclarations(databases[0].root, getHarnessAdminUrl()));
      const unitDeclarations = [];
      for (const scope of ['user', 'system'] as const) {
        catalogEntries.push(...await unitCensusEntries(scope));
        unitDeclarations.push(...await installedUnitCensusDeclarations(scope));
      }
      migrationSources.push(...await registeredProjectMigrationSources([], unitDeclarations));
      declarations.push(...unitDeclarations, ...await unitDatabaseCensusDeclarations(unitDeclarations, databases, getHarnessAdminUrl(), producers.roots.map(root => root.path)));
      // Catalog only declared secret paths that exist; never read their values.
      // Unknown secret locations still appear as filesystem residue.
      const secretPaths = producers.declarations.filter(entry => entry.classification === 'secret');
      for (const declaration of secretPaths.filter((entry, index) => secretPaths.findIndex(other =>
        other.root === entry.root && other.name === entry.name) === index)) {
        const root = producers.roots.find(entry => entry.id === declaration.root)!;
        try { await lstat(join(root.path, declaration.name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const entry: CensusEntry = { kind: 'secret', root: declaration.root, name: declaration.name };
        catalogEntries.push(entry);
        declarations.push({ ...declaration, kind: 'secret' });
      }
    }
  } finally { await sql.end(); }
}
await options.onDiscoverySnapshot?.({ phase: 'before-filesystem',
  ...structuredClone({ roots: producers.roots, declarations, catalogEntries }) });
stage('filesystem-storage-markers');
const recordPeerStorage = async (root: CensusRoot, name: string) => {
  declarations.push(await peerStorageDeclaration(root, name));
  const advisoryLock = await corestoreAdvisoryLockDeclaration(root, name);
  if (advisoryLock) declarations.push(advisoryLock);
};
for (const [rootIndex, root] of producers.roots.entries()) {
  stage(`filesystem-root-${rootIndex}:postgres-markers`);
  const topLevel = await readdir(root.path, { withFileTypes: true });
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    try { await lstat(join(root.path, directory.name, 'PG_VERSION')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push(await postgresStorageDeclaration(root, directory.name));
  }
  // Bounded marker discovery in the home and its direct artifact containers.
  // Symlinks and retained trees are not followed or reclassified.
  stage(`filesystem-root-${rootIndex}:virtualenv-markers`);
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    // The census already represents these writer-owned caches at their roots.
    // Looking inside them can enumerate arbitrarily large spill/build trees
    // and mistakes cached copies of producer markers for installed storage.
    if (declarations.some(entry => entry.kind === 'path' && entry.root === root.id &&
      entry.name === directory.name && entry.descendants && entry.prune && !entry.anyDepth)) continue;
    const children = await readdir(join(root.path, directory.name), { withFileTypes: true });
    const candidates = [directory.name, ...children.filter(entry => entry.isDirectory()).map(entry => `${directory.name}/${entry.name}`)];
    for (const name of candidates) {
      try { await lstat(join(root.path, name, 'pyvenv.cfg')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      declarations.push(await virtualenvCacheDeclaration(root, name));
    }
  }
  stage(`filesystem-root-${rootIndex}:git-markers`);
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    let metadata;
    try { metadata = await lstat(join(root.path, directory.name, '.git')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // External worktree pointers do not own their referenced Git metadata.
    // Leave them visible for cross-root qualification rather than following.
    if (!metadata.isDirectory()) continue;
    declarations.push(await gitStorageDeclaration(root, directory.name, true));
  }
  // Only the producer's exact per-workspace layout; scoped stores stay distinct.
  stage(`filesystem-root-${rootIndex}:workspace-layouts`);
  const workspacePrefix = relative(root.path, workspacesRoot());
  const ownsWorkspaces = !workspacePrefix.startsWith('..') && !workspacePrefix.startsWith('/');
  const workspaces = ownsWorkspaces ? await readdir(workspacesRoot(), { withFileTypes: true }) : [];
  const layouts = workspaces.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name }));
  // restoreToClone's exact default shape. Probe embedded producer evidence,
  // keeping the clone and snapshot containers themselves unclassified.
  for (const workspace of [...layouts]) {
    let snapshots;
    try { snapshots = await readdir(join(workspacesRoot(), workspace.name, '.restored'), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const snapshot of snapshots.filter(entry => entry.isDirectory())) {
      const clones = await readdir(join(workspacesRoot(), workspace.name, '.restored', snapshot.name), { withFileTypes: true });
      for (const clone of clones.filter(entry => entry.isDirectory())) {
        const name = `${workspace.name}/.restored/${snapshot.name}/${clone.name}`;
        const qualified = [workspacePrefix, name].filter(Boolean).join('/');
        if (declarations.some(entry => entry.root === root.id && entry.name === qualified && entry.recoveryStorage)) continue;
        layouts.push({ name });
        if (layouts.length > 1000) throw new Error('Recovery layout census bound exceeded');
      }
    }
  }
  stage(`filesystem-root-${rootIndex}:workspace-storage`);
  for (const workspace of layouts) {
    const parent = join(workspacesRoot(), workspace.name, '.papercusp');
    let harnesses;
    try { harnesses = await readdir(parent, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // Recognize producer evidence inside preserved copies too; the enclosing
    // unknown directories remain residue, never inferred state from their names.
    for (const appContainer of harnesses.filter(entry => entry.isDirectory())) {
    const appsPrefix = [workspacePrefix, workspace.name, '.papercusp', appContainer.name].filter(Boolean).join('/');
    let apps;
    try { apps = await readdir(join(root.path, appsPrefix), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const app of apps ?? []) {
      if (!app.isDirectory() || app.name.startsWith('.')) continue;
      const appName = `${appsPrefix}/${app.name}`;
      try {
        const source = await readFile(join(root.path, appName, 'packages', 'data', 'src', 'migrations.ts'), 'utf8');
        const tables = migrationProducerTables(source);
        if (tables.length >= 2) migrationSources.push({ producer: `app-migrations:${root.id}:${appName}`, tables });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let hasGit = false;
      try { await lstat(join(root.path, appName, '.git')); hasGit = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (hasGit) {
        // Full preservation includes untracked state; avoid a competing nested
        // cache override that would invalidate this opaque worktree manifest.
        declarations.push(await gitStorageDeclaration(root, appName, true));
        continue;
      }
      // Retained app copies can contain the same producer-owned stores as the
      // direct harness layout. Require the device marker at the exact path;
      // the enclosing copy remains residue unless independently accounted for.
      for (const store of ['hyperbee', 'hyperbee-scoped']) {
        const name = `${appName}/${store}`;
        try { await lstat(join(root.path, name, 'CORESTORE')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
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
        await recordPeerStorage(root, name);
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

