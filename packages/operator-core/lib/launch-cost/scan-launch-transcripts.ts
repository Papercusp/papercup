/**
 * Launch-cost metrics — the STREAMING half of the baseline instrument
 * (plan `agent-launch-context-cost-2026-09-18`, P-001).
 *
 * ⚠ WHY THIS STREAMS, AND WHY THAT IS THE WHOLE POINT OF THE FILE.
 * A psu Claude transcript's first entry is the system prompt, and it is ~580 KB on ONE line. The
 * first row carrying `message.usage` — the launch measurement — sits after it. So any reader that
 * looks at a bounded prefix of the file (a 600 KB read window, a `head -c`, a capped file-read
 * tool) never reaches the usage row and returns ZERO ROWS. Zero rows is indistinguishable from
 * "this session has no usage data", which is exactly the reading that makes an agent conclude the
 * corpus is empty and move on. Every read here is a `createReadStream` + `readline` pass that
 * stops at the first qualifying row, so the window can never be the reason a file measures empty.
 * `scan-launch-transcripts.test.ts` pins this with a fixture whose usage row sits past 600 KB.
 *
 * SKIPS ARE COUNTED, NOT SWALLOWED. Every file that yields no sample lands in `skipped` with a
 * typed reason. An instrument that silently drops files reports a smaller, cleaner-looking corpus
 * than it measured, and the difference is invisible at the call site.
 */

import { constants as fsConstants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { opendir, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { StableSource } from '../session-port/source';
import type { SuStdioPeer } from '../su-session-stdio-peer';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { linuxPpidFromProcStat, linuxProcessIdentityFromStat } from '../process-identity';

import {
  DEFAULT_MIN_PROMPT_TOKENS,
  extractLaunchUsage,
  extractSampleContext,
  isLaunchCandidate,
  utcDay,
  createCarryTrialRecipe,
  type LaunchSample,
} from './launch-cost-metrics';

export type SkipReason =
  /** File was read to EOF and carried no `message.usage` row at all. */
  | 'no-usage-row'
  /** Usage rows existed but every one sat at or below the `minPromptTokens` floor. */
  | 'all-below-threshold'
  /** No qualifying sample and at least one incomplete usage row: size cannot be established. */
  | 'incomplete-usage'
  /** The only qualifying rows were sub-agent turns and sidechains were excluded. */
  | 'sidechain-only'
  /** A sample was found but excluded by a caller filter (day window, model, owner prefix). */
  | 'filtered-out'
  /** The measured row had no parseable timestamp, so it cannot be placed on a day. */
  | 'undatable'
  /** The file could not be read (permissions, disappeared mid-scan, IO error). */
  | 'unreadable';

export type SkippedFile = {
  filePath: string;
  reason: SkipReason;
  detail?: string;
};

export type ScanOptions = {
  /** Transcript root, e.g. `~/.papercusp/session-claude`. */
  root: string;
  minPromptTokens?: number;
  includeSidechains?: boolean;
  /** Inclusive UTC `YYYY-MM-DD` lower bound on the measured entry's day. */
  since?: string;
  /** Inclusive UTC `YYYY-MM-DD` upper bound on the measured entry's day. */
  until?: string;
  /** Keep only owners whose id starts with this (e.g. `su-` for superuser sessions). */
  ownerPrefix?: string;
  /** Keep only samples whose model contains this substring (e.g. `opus`). */
  modelContains?: string;
  /** Max files read in parallel. Defaults to 8. */
  concurrency?: number;
  /** Bound the walk depth below `root`. Defaults to 8; the real layout needs 3. */
  maxDepth?: number;
};

export type ScanReport = {
  root: string;
  samples: LaunchSample[];
  filesScanned: number;
  filesMeasured: number;
  skipped: SkippedFile[];
  /** Skip counts by reason — the census a reader needs before trusting a small sample set. */
  skippedByReason: Record<SkipReason, number>;
};

export interface CarrySourceSnapshot {
  threadId: string;
  turnId: string;
  filePath: string;
  snapshot: StableSource;
}

export interface CarryNativeConfigurationScope {
  threadId: string;
  cwd: string;
  servers: Array<{ name: string; tools: string[]; authStatus: string }>;
}

/** Read-only manifest component, not an authorization or serving-account
 * receipt. Hash the FULL native config/layers and complete MCP inventory,
 * retaining neither credentials nor raw config in the returned evidence.
 * The caller supplies a frozen allowlist and waits for native startup first.
 * A paginated inventory must finish without duplicate servers/cursor loops.
 */
export async function captureCarryNativeConfiguration(peer: SuStdioPeer, scope: CarryNativeConfigurationScope) {
  // The controller can continue running while RPC reads await; pin its supplied
  // scope now so a concurrent mutation cannot widen the declared allowlist.
  scope = structuredClone(scope);
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!nonblank(scope.threadId) || !isAbsolute(scope.cwd) || !Array.isArray(scope.servers) ||
    new Set(scope.servers.map(server => server.name)).size !== scope.servers.length || scope.servers.some(server =>
      !nonblank(server.name) || !nonblank(server.authStatus) || !Array.isArray(server.tools) ||
      server.tools.some(tool => !nonblank(tool)) || new Set(server.tools).size !== server.tools.length)) {
    throw new Error('carry config requires exact thread/cwd and a unique server/tool allowlist');
  }
  const config = await peer.request({ method: 'config/read', params: { cwd: scope.cwd, includeLayers: true } });
  if (!record(config.config) || !Array.isArray(config.layers)) throw new Error('carry native config/layers unavailable');
  const servers = new Map<string, Record<string, unknown>>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; ; pageNumber++) {
    // Bound a malformed peer without accepting a truncated census. No retry.
    if (pageNumber >= 64) throw new Error('carry MCP inventory exceeded page bound');
    const page = await peer.request({ method: 'mcpServerStatus/list', params: {
      threadId: scope.threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}),
    } });
    if (!Array.isArray(page.data) || !Object.hasOwn(page, 'nextCursor')) throw new Error('carry MCP inventory incomplete');
    for (const value of page.data) {
      const server = record(value), tools = record(server?.tools);
      if (!server || !nonblank(server.name) || !tools || server.runtimeStatus !== 'connected' ||
        server.toolsError != null || servers.has(server.name)) throw new Error('carry MCP inventory invalid or unavailable');
      const allowed = scope.servers.find(expected => expected.name === server.name);
      if (!allowed || server.authStatus !== allowed.authStatus ||
        canonicalJson(Object.keys(tools).sort()) !== canonicalJson([...allowed.tools].sort()) ||
        Object.entries(tools).some(([name, tool]) => !record(tool) || record(tool)!.name !== name || !record(record(tool)!.inputSchema))) {
        throw new Error('carry MCP inventory differs from frozen allowlist');
      }
      servers.set(server.name, server);
    }
    if (page.nextCursor === null) break;
    if (!nonblank(page.nextCursor) || cursors.has(page.nextCursor)) throw new Error('carry MCP inventory cursor invalid or repeated');
    cursor = page.nextCursor; cursors.add(cursor);
  }
  if (servers.size !== scope.servers.length) throw new Error('carry MCP inventory missing required server');
  const ordered = [...servers.values()].sort((a, b) => String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  return { threadId: scope.threadId, cwd: scope.cwd,
    configSha256: hash(config), toolInventorySha256: hash(ordered),
    servers: ordered.map(server => ({ name: String(server.name), authStatus: String(server.authStatus),
      tools: Object.keys(server.tools as object).sort() })) };
}

/** Recheck using the original scope; never silently refresh a changed manifest.
 * These discrete observations do not prove there was no transient change
 * between reads, or that the effective provider honored the native settings.
 */
export async function recheckCarryNativeConfiguration(
  peer: SuStdioPeer, snapshot: Awaited<ReturnType<typeof captureCarryNativeConfiguration>>,
): Promise<void> {
  const current = await captureCarryNativeConfiguration(peer, snapshot);
  if (canonicalJson(current) !== canonicalJson(snapshot)) throw new Error('carry native configuration changed after capture');
}

export interface CarryArtifactInput {
  /** Stable role/name in the predeclared recipe, not an inferred dependency. */
  id: string;
  filePath: string;
  maxBytes: number;
}

const CARRY_DEPENDENCY_ROLES = ['launcher', 'native-runtime', 'scripts', 'task', 'seed',
  'source', 'pricing', 'checker', 'instrument'] as const;

/** A declared dependency graph, not a discovered or authenticated census.
 * Every frozen artifact must have a node and be reachable from a named root.
 * Missing roles and unresolved runtime surfaces remain visible in the binding.
 * An empty residue does not prove the caller declared all real dependencies.
 */
export interface CarryDependencyScope {
  recipeSha256: string;
  roots: Array<{ role: typeof CARRY_DEPENDENCY_ROLES[number]; artifactIds: string[] }>;
  nodes: Array<{ artifactId: string; dependsOn: string[] }>;
  unresolved: string[];
}

function bindCarryDependencyScope(scope: CarryDependencyScope, artifacts: readonly CarryArtifactInput[]) {
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const ids = new Set(artifacts.map(artifact => artifact.id));
  const references = (value: unknown): value is string[] => Array.isArray(value) && value.length <= ids.size &&
    value.every(id => typeof id === 'string' && ids.has(id)) && new Set(value).size === value.length;
  const recipe = createCarryTrialRecipe();
  if (!scope || scope.recipeSha256 !== recipe.sha256 || !Array.isArray(scope.roots) || !scope.roots.length ||
    scope.roots.length > CARRY_DEPENDENCY_ROLES.length || scope.roots.some(root => !root ||
      !CARRY_DEPENDENCY_ROLES.includes(root.role) || !references(root.artifactIds) || !root.artifactIds.length) ||
    new Set(scope.roots.map(root => root.role)).size !== scope.roots.length || !Array.isArray(scope.nodes) ||
    scope.nodes.length !== ids.size || scope.nodes.some(node => !node || !ids.has(node.artifactId) || !references(node.dependsOn)) ||
    new Set(scope.nodes.map(node => node.artifactId)).size !== ids.size || !Array.isArray(scope.unresolved) ||
    scope.unresolved.length > 64 || scope.unresolved.some(entry => !nonblank(entry) || entry.length > 2000) ||
    new Set(scope.unresolved).size !== scope.unresolved.length) {
    throw new Error('carry dependency scope requires the current recipe, unique roots and a complete declared artifact graph');
  }
  const nodes = new Map(scope.nodes.map(node => [node.artifactId, node.dependsOn]));
  const reachable = new Set<string>(), pending = scope.roots.flatMap(root => root.artifactIds);
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...nodes.get(id)!);
  }
  if (reachable.size !== ids.size) throw new Error('carry dependency scope contains artifacts unreachable from its roots');
  // Project only the public schema. Raw config, task contents and other caller
  // additions must not escape through this otherwise descriptive surface.
  const ordered = <T>(values: T[], key: (value: T) => string) => [...values].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return { evidenceKind: 'declaration-only' as const, recipeSha256: recipe.sha256,
    roots: ordered(scope.roots.map(root => ({ role: root.role, artifactIds: [...root.artifactIds].sort() })), root => root.role),
    nodes: ordered(scope.nodes.map(node => ({ artifactId: node.artifactId, dependsOn: [...node.dependsOn].sort() })), node => node.artifactId),
    missingRoles: CARRY_DEPENDENCY_ROLES.filter(role => !scope.roots.some(root => root.role === role)),
    unresolved: [...scope.unresolved].sort() };
}

export interface CarryRuntimeSnapshot {
  schemaVersion: 1;
  evidenceKind: 'observation-only';
  rootPid: number;
  processes: Array<{ pid: number; parentPid: number; identity: string; executable: string; mappedFiles: string[] }>;
  /** On-disk files observed through exe/maps, not a complete dependency graph. */
  artifacts: CarryArtifactInput[];
}

/** Observe the live native process tree, including a wrapper's children and
 * file-backed mappings. Reuse the kernel identity parsers; PID alone is not an
 * identity. All thread children lists are read because a non-main thread can
 * spawn the native child. Missing/short/oversized proc data fails closed.
 *
 * This is deliberately NOT admission: maps do not enumerate JS modules, files
 * read then closed, future/transient children, or unloaded dependencies. Hashing
 * a mapped pathname binds its current on-disk bytes, not resident memory. The
 * controller still needs declared script/data dependencies and writer exclusion.
 */
export async function captureCarryRuntimeSnapshot(rootPid: number): Promise<CarryRuntimeSnapshot> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(rootPid) || rootPid <= 0) {
    throw new Error('carry runtime requires a live Linux peer PID');
  }
  const readProc = async (path: string): Promise<string> => {
    const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const maxBytes = 2 * 1024 * 1024, buffer = Buffer.alloc(64 * 1024), chunks: Buffer[] = [];
      let bytes = 0;
      while (bytes <= maxBytes) {
        const chunk = await file.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - bytes), bytes);
        if (!chunk.bytesRead) break;
        bytes += chunk.bytesRead;
        if (bytes > maxBytes) throw new Error('carry runtime proc record exceeds bound');
        chunks.push(Buffer.from(buffer.subarray(0, chunk.bytesRead)));
      }
      return Buffer.concat(chunks, bytes).toString('utf8');
    } finally { await file.close(); }
  };
  const boot = (await readProc('/proc/sys/kernel/random/boot_id')).trim();
  if (!/^[0-9a-f-]{36}$/i.test(boot)) throw new Error('carry runtime boot identity unavailable');
  const observe = async (): Promise<CarryRuntimeSnapshot> => {
    const processes: CarryRuntimeSnapshot['processes'] = [], files = new Set<string>();
    const queue = [{ pid: rootPid, parent: null as number | null }], seen = new Set<number>();
    while (queue.length) {
      const { pid, parent } = queue.shift()!;
      if (seen.has(pid) || seen.size >= 64) throw new Error('carry runtime process tree repeated or exceeds bound');
      seen.add(pid);
      const before = await readProc(`/proc/${pid}/stat`);
      const identity = linuxProcessIdentityFromStat(boot, before), parentPid = linuxPpidFromProcStat(before);
      if (!identity || parentPid === null || (parent !== null && parentPid !== parent)) {
        throw new Error('carry runtime process identity or parent changed');
      }
      const processName = before.slice(before.indexOf('(') + 1, before.lastIndexOf(')')).replace(/[^a-zA-Z0-9_. -]/g, '?').slice(0, 32);
      const executable = await readlink(`/proc/${pid}/exe`).catch(() => { throw new Error(`carry runtime process disappeared or executable unreadable: ${processName}`); });
      if (!isAbsolute(executable) || executable.endsWith(' (deleted)')) throw new Error('carry runtime executable unavailable');
      const mappedFiles = new Set<string>();
      const mappedIdentities = new Map<string, { ino: bigint; major: bigint; minor: bigint }>();
      const maps = await readProc(`/proc/${pid}/maps`);
      if (!maps.trim() || !maps.endsWith('\n')) throw new Error('carry runtime mappings incomplete');
      for (const line of maps.trimEnd().split('\n')) {
        const match = /^([0-9a-f]+)-([0-9a-f]+)\s+([r-][w-][x-][ps])\s+[0-9a-f]+\s+([0-9a-f]+):([0-9a-f]+)\s+(\d+)(?:\s+(.*))?$/i.exec(line);
        if (!match) throw new Error('carry runtime mapping invalid');
        const path = match[7];
        // Node 25 maps the kernel io_uring object under this pseudo-name.
        // It is neither a pathname nor an omitted disk dependency. Keep this
        // exact rather than swallowing arbitrary unrecognized/deleted files.
        if (!path || path.startsWith('[') || path === 'anon_inode:[io_uring]') continue;
        if (!isAbsolute(path) || path.endsWith(' (deleted)') || /\\[0-7]{3}/.test(path)) {
          throw new Error('carry runtime mapped pathname unavailable or ambiguous');
        }
        let identity = mappedIdentities.get(path);
        if (!identity) {
          const file = await stat(path, { bigint: true });
          if (!file.isFile()) throw new Error('carry runtime mapped file is non-regular');
          identity = { ino: file.ino, major: ((file.dev >> 8n) & 0xfffn) | ((file.dev >> 32n) & 0xfffff000n),
            minor: (file.dev & 0xffn) | ((file.dev >> 12n) & 0xffffff00n) };
          mappedIdentities.set(path, identity);
        }
        // A pathname can occur in several mappings. Validate every mapping's
        // identity before deduplicating; an older inode must not hide behind
        // a newer mapping with the same pathname.
        if (identity.ino !== BigInt(match[6]) || identity.major !== BigInt(`0x${match[4]}`) ||
          identity.minor !== BigInt(`0x${match[5]}`)) throw new Error('carry runtime mapped file replaced');
        mappedFiles.add(path);
      }
      if (!mappedFiles.has(executable)) throw new Error('carry runtime executable absent from mappings');
      for (const path of mappedFiles) files.add(path);
      if (files.size > 256) throw new Error('carry runtime artifact population exceeds bound');
      const threads = await readdir(`/proc/${pid}/task`).catch(() => { throw new Error(`carry runtime process disappeared or tasks unreadable: ${processName}`); });
      if (!threads.length || threads.length > 512 || threads.some(tid => !/^[1-9]\d*$/.test(tid))) {
        throw new Error('carry runtime thread population invalid or exceeds bound');
      }
      const children = new Set<number>();
      for (const tid of threads) {
        const text = (await readProc(`/proc/${pid}/task/${tid}/children`)).trim();
        if (!text) continue;
        for (const child of text.split(/\s+/)) {
          const childPid = Number(child);
          if (!/^[1-9]\d*$/.test(child) || !Number.isSafeInteger(childPid)) throw new Error('carry runtime child PID invalid');
          children.add(childPid);
          if (seen.size + children.size + queue.length > 64) throw new Error('carry runtime process tree exceeds bound');
        }
      }
      if (linuxProcessIdentityFromStat(boot, await readProc(`/proc/${pid}/stat`)) !== identity ||
        await readlink(`/proc/${pid}/exe`) !== executable) throw new Error('carry runtime process changed during observation');
      processes.push({ pid, parentPid, identity, executable, mappedFiles: [...mappedFiles].sort() });
      queue.push(...[...children].sort((a, b) => a - b).map(child => ({ pid: child, parent: pid })));
    }
    return { schemaVersion: 1, evidenceKind: 'observation-only', rootPid,
      processes: processes.sort((a, b) => a.pid - b.pid),
      artifacts: [...files].sort().map(filePath => ({
        id: `runtime:${createHash('sha256').update(filePath).digest('hex')}`, filePath, maxBytes: 512 * 1024 * 1024,
      })) };
  };
  const before = await observe(), after = await observe();
  if ((await readProc('/proc/sys/kernel/random/boot_id')).trim() !== boot || canonicalJson(before) !== canonicalJson(after)) {
    throw new Error(`carry runtime tree or mappings changed during observation (${before.processes.map(p => basename(p.executable)).join(',')} -> ${after.processes.map(p => basename(p.executable)).join(',')})`);
  }
  return before;
}

/** Equal snapshots establish observations at the boundaries, never absence of
 * a transient child/mapping or an authenticated provider-send event. */
export async function recheckCarryRuntimeSnapshot(snapshot: CarryRuntimeSnapshot): Promise<void> {
  snapshot = structuredClone(snapshot);
  const current = await captureCarryRuntimeSnapshot(snapshot.rootPid);
  if (canonicalJson(current) !== canonicalJson(snapshot)) {
    throw new Error(`carry runtime changed after capture (${snapshot.processes.map(p => basename(p.executable)).join(',')} -> ${current.processes.map(p => basename(p.executable)).join(',')})`);
  }
}

/** Freeze the declared file set alongside its native configuration observation.
 * Reuses the existing canonical serializer and configuration capture. This is
 * an artifact binding, NOT a complete dependency census, approval, provider
 * identity, output-limit receipt, or permission to send a charged request.
 * Callers must enumerate the binary, task/recipe, checker, pricing, launcher,
 * instruments and their dependencies before freezing the controller manifest.
 * File contents (including private configuration) never leave this function.
 */
export async function captureCarryArtifactManifest(input: {
  protocolRef: string;
  artifacts: readonly CarryArtifactInput[];
  configuration: Awaited<ReturnType<typeof captureCarryNativeConfiguration>>;
  dependencyScope?: CarryDependencyScope;
}) {
  input = structuredClone(input);
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!nonblank(input.protocolRef) || !Array.isArray(input.artifacts) || !input.artifacts.length ||
    input.artifacts.length > 256 || new Set(input.artifacts.map(a => a.id)).size !== input.artifacts.length ||
    input.artifacts.some(a => !nonblank(a.id) || !isAbsolute(a.filePath) ||
      !Number.isSafeInteger(a.maxBytes) || a.maxBytes <= 0)) {
    throw new Error('carry manifest requires a protocol and a bounded unique artifact set');
  }
  const dependencyScope = input.dependencyScope === undefined ? undefined :
    bindCarryDependencyScope(input.dependencyScope, input.artifacts);
  const observed = input.configuration;
  if (!observed || !Array.isArray(observed.servers) || observed.servers.some(server =>
    !nonblank(server.name) || !nonblank(server.authStatus) || !Array.isArray(server.tools) ||
    server.tools.some(tool => !nonblank(tool)) || new Set(server.tools).size !== server.tools.length) ||
    new Set(observed.servers.map(server => server.name)).size !== observed.servers.length) {
    throw new Error('carry manifest requires a complete native configuration scope');
  }
  // Copy only the observation schema; never propagate caller-added raw config
  // or artifact contents into the serializable evidence artifact.
  const config = { threadId: observed.threadId, cwd: observed.cwd, configSha256: observed.configSha256,
    toolInventorySha256: observed.toolInventorySha256,
    servers: observed.servers.map(({ name, authStatus, tools }) => ({ name, authStatus, tools })) };
  if (!config || !nonblank(config.threadId) || !isAbsolute(config.cwd) ||
    !/^[a-f0-9]{64}$/.test(config.configSha256) || !/^[a-f0-9]{64}$/.test(config.toolInventorySha256)) {
    throw new Error('carry manifest requires a native configuration observation');
  }
  const artifacts = [];
  for (const artifact of [...input.artifacts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    // Legitimate executable links are resolved and bound, so later retargeting
    // fails even if both destinations contain identical bytes. O_NONBLOCK keeps
    // a substituted FIFO from hanging before the regular-file check.
    const resolvedPath = await realpath(artifact.filePath);
    const fh = await open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const before = await fh.stat({ bigint: true });
      if (!before.isFile() || before.size <= 0n || before.size > BigInt(artifact.maxBytes)) {
        throw new Error(`carry artifact ${artifact.id} is empty, non-regular or oversized`);
      }
      const identity = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while (true) {
        const read = await fh.read(buffer, 0, Math.min(buffer.length, artifact.maxBytes - bytes + 1), bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        if (bytes > artifact.maxBytes) throw new Error(`carry artifact ${artifact.id} exceeded its byte bound`);
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await fh.stat({ bigint: true });
      if (BigInt(bytes) !== before.size || canonicalJson(identity(before)) !== canonicalJson(identity(after)) ||
        await realpath(artifact.filePath) !== resolvedPath ||
        canonicalJson(identity(await stat(resolvedPath, { bigint: true }))) !== canonicalJson(identity(before))) {
        throw new Error(`carry artifact ${artifact.id} changed during capture`);
      }
      artifacts.push({ id: artifact.id, filePath: artifact.filePath, maxBytes: artifact.maxBytes,
        resolvedPath, bytes, sha256: hash.digest('hex'), identity: identity(before) });
    } finally { await fh.close(); }
  }
  const body = { schemaVersion: 1 as const, evidenceKind: 'observation-only' as const,
    protocolRef: input.protocolRef, configuration: config, artifacts,
    ...(dependencyScope ? { dependencyScope } : {}) };
  return { ...body, sha256: createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

/** Re-read the same declared population; never update a frozen manifest to
 * accommodate drift. Like native configuration snapshots, equal observations
 * cannot rule out transient changes between reads; execution still requires
 * source/writer exclusion and independent admission checks.
 */
export async function recheckCarryArtifactManifest(
  manifest: Awaited<ReturnType<typeof captureCarryArtifactManifest>>,
  peer: SuStdioPeer,
): Promise<void> {
  manifest = structuredClone(manifest);
  const { sha256, ...body } = manifest;
  if (createHash('sha256').update(canonicalJson(body)).digest('hex') !== sha256) {
    throw new Error('carry artifact manifest binding is invalid');
  }
  await recheckCarryNativeConfiguration(peer, manifest.configuration);
  const current = await captureCarryArtifactManifest({ protocolRef: manifest.protocolRef,
    configuration: manifest.configuration,
    dependencyScope: manifest.dependencyScope,
    artifacts: manifest.artifacts.map(({ id, filePath, maxBytes }) => ({ id, filePath, maxBytes })) });
  if (current.sha256 !== sha256) throw new Error('carry artifacts changed after manifest freeze');
}

/** Capture an owned native preparation peer at its last completed turn. The
 * native process is stopped before reading its original rollout; the existing
 * bounded JSONL reader supplies the exact bytes/hash. This does not copy or
 * rewrite native history, nor prove serving-account identity or tool authority.
 * The returned cut is a snapshot, not a promise that the pathname stays frozen:
 * recheckCarrySourceSnapshot must pass before each comparison arm.
 */
export async function captureCompletedCarrySource(
  peer: SuStdioPeer,
  threadId: string,
  turnId: string,
  maxBytes?: number,
): Promise<CarrySourceSnapshot> {
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!threadId.trim() || !turnId.trim()) throw new Error('carry source requires exact native identity');
  // Ordinary launch scanning does not need the archive module's DB/zstd
  // dependencies; load the shared reader only for this source-capture path.
  const { MAX_SESSION_PORT_SOURCE_BYTES, readStableLiveJsonl } = await import('../session-port/source');
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SESSION_PORT_SOURCE_BYTES)) {
    throw new Error('carry source byte cap must be positive and within the existing source limit');
  }
  const response = await peer.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
  const thread = record(response.thread), turns = thread?.turns;
  const last = Array.isArray(turns) ? record(turns.at(-1)) : null;
  if (thread?.id !== threadId || record(thread.status)?.type !== 'idle' ||
    !Array.isArray(turns) || turns.filter(turn => record(turn)?.id === turnId).length !== 1 || last?.id !== turnId ||
    last.status !== 'completed' || last.error != null || !Array.isArray(last.items) ||
    (last.itemsView !== undefined && last.itemsView !== 'full')) {
    throw new Error('carry source requires a full, idle, completed final native turn');
  }
  if (typeof thread.path !== 'string' || !isAbsolute(thread.path)) throw new Error('carry source native path is unavailable');
  // A successful thread/read is not writer exclusion. Both tracked teardown
  // and its process-exit receipt must finish before the source file is opened.
  await peer.close();
  await peer.done;
  const snapshot = await readStableLiveJsonl(thread.path, maxBytes);
  if (!snapshot.completeBytes || snapshot.completeBytes !== snapshot.highWaterBytes) {
    throw new Error('carry source is empty, short, or ends with a partial record');
  }
  let headerCount = 0, lastBoundary: Record<string, unknown> | null = null;
  let offset = 0, records = 0;
  while (offset < snapshot.bytes.length) {
    const end = snapshot.bytes.indexOf(0x0a, offset);
    const line = snapshot.bytes.subarray(offset, end).toString('utf8');
    offset = end + 1;
    const entry = record(JSON.parse(line)), payload = record(entry?.payload);
    if (!entry || !payload) throw new Error('carry source contains a malformed native record');
    if (records++ === 0 && entry.type !== 'session_meta') throw new Error('carry source lacks its native header');
    if (entry.type === 'session_meta') {
      headerCount++;
      if (payload.id !== threadId) throw new Error('carry source native header identity mismatch');
    }
    if (entry.type === 'event_msg' && ['task_started', 'task_complete', 'turn_completed', 'turn_aborted'].includes(String(payload.type))) {
      lastBoundary = payload;
    }
  }
  if (headerCount !== 1 || !lastBoundary || !['task_complete', 'turn_completed'].includes(String(lastBoundary.type)) ||
    lastBoundary.turn_id !== turnId || lastBoundary.error != null ||
    ['error', 'failed', 'failure'].includes(String(lastBoundary.status ?? ''))) {
    throw new Error('carry source terminal record does not match the completed native cut');
  }
  return { threadId, turnId, filePath: thread.path, snapshot };
}

/** Source drift is a stop condition, never a reason to silently select a new
 * cutoff or regenerate preparation after comparison results are visible. */
export async function recheckCarrySourceSnapshot(source: CarrySourceSnapshot): Promise<void> {
  const { readStableLiveJsonl } = await import('../session-port/source');
  const current = await readStableLiveJsonl(source.filePath, source.snapshot.highWaterBytes);
  if (current.completeBytes !== current.highWaterBytes || current.completeBytes !== source.snapshot.completeBytes ||
    current.sha256 !== source.snapshot.sha256) throw new Error('carry source changed after its frozen cut');
}

/**
 * Recursively collect `*.jsonl` paths under `root`.
 *
 * Does NOT follow directory symlinks. The repo guide's `find -L` incident (a symlink DAG through
 * `node_modules/@papercusp/*` that ran 32h and consumed 1.86 TB of swap) is the reason: a
 * transcript tree has no legitimate need to traverse a link, and an unbounded symlink walk is
 * indistinguishable from a hang. `maxDepth` is a second, independent bound.
 */
export async function collectTranscriptFiles(root: string, maxDepth = 8): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    for await (const entry of handle) {
      // isSymbolicLink() is checked BEFORE isDirectory(): a symlink to a directory reports
      // isDirectory() === false from opendir's dirent, but being explicit keeps the intent
      // readable and survives a future switch to a stat-following API.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  found.sort();
  return found;
}

/**
 * Derive the owner id from a transcript path: the first segment below `root`.
 * Layout is `<root>/<ownerId>/projects/<munged-cwd>/<sessionId>.jsonl`.
 */
export function ownerIdFromPath(root: string, filePath: string): string {
  const rel = relative(root, filePath);
  const first = rel.split(sep)[0];
  return first && first !== '..' ? first : 'unknown';
}

type FileOutcome = { sample: LaunchSample } | { skip: SkippedFile };

/**
 * Read ONE transcript and return its launch sample, or a typed skip.
 *
 * Exported so a caller can measure a single session without walking a tree, and so the streaming
 * guarantee can be tested in isolation.
 */
export async function measureTranscriptFile(
  filePath: string,
  options: ScanOptions,
): Promise<FileOutcome> {
  const minPromptTokens = options.minPromptTokens ?? DEFAULT_MIN_PROMPT_TOKENS;
  const includeSidechains = options.includeSidechains ?? false;
  const ownerId = ownerIdFromPath(options.root, filePath);

  if (options.ownerPrefix && !ownerId.startsWith(options.ownerPrefix)) {
    return { skip: { filePath, reason: 'filtered-out', detail: `owner ${ownerId}` } };
  }

  let sawUsageRow = false;
  let sawBelowThreshold = false;
  let sawIncompleteUsage = false;
  let sawSidechainOnly = false;
  let found: { entry: unknown; lineNumber: number; bytesBefore: number } | null = null;
  let readError: string | null = null;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let bytesConsumed = 0;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      // +1 for the newline the reader stripped. Approximate for multi-byte content, which is
      // fine: this figure is evidence for "the usage row sits deep in the file", not an exact
      // byte offset anyone indexes with.
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) {
        bytesConsumed += lineBytes;
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        bytesConsumed += lineBytes;
        continue;
      }
      const usage = extractLaunchUsage(entry);
      if (!usage) {
        bytesConsumed += lineBytes;
        continue;
      }
      sawUsageRow = true;
      if (usage.usageCountsComplete !== true) sawIncompleteUsage = true;
      if (usage.totalPromptTokens <= minPromptTokens) {
        sawBelowThreshold = true;
        bytesConsumed += lineBytes;
        continue;
      }
      if (!isLaunchCandidate(entry, usage, { minPromptTokens, includeSidechains })) {
        // Passed the token floor, so the only remaining rejection is the sidechain rule.
        sawSidechainOnly = true;
        bytesConsumed += lineBytes;
        continue;
      }
      found = { entry, lineNumber, bytesBefore: bytesConsumed };
      break;
    }
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  } finally {
    // Close both ends. `reader.close()` alone leaves the underlying stream open, and a
    // partially-drained readline can still emit one more buffered line to a stale listener —
    // the exact behaviour that made an earlier ad-hoc probe print two "first" rows.
    reader.close();
    stream.destroy();
  }

  if (readError) return { skip: { filePath, reason: 'unreadable', detail: readError } };
  if (!found) {
    if (sawSidechainOnly) return { skip: { filePath, reason: 'sidechain-only' } };
    if (sawIncompleteUsage) return { skip: { filePath, reason: 'incomplete-usage' } };
    if (sawBelowThreshold) return { skip: { filePath, reason: 'all-below-threshold' } };
    if (sawUsageRow) return { skip: { filePath, reason: 'all-below-threshold' } };
    return { skip: { filePath, reason: 'no-usage-row' } };
  }

  const usage = extractLaunchUsage(found.entry)!;
  const context = extractSampleContext(found.entry);
  const day = utcDay(context.timestamp);
  if (!day) {
    return { skip: { filePath, reason: 'undatable', detail: String(context.timestamp) } };
  }
  if (options.since && day < options.since) {
    return { skip: { filePath, reason: 'filtered-out', detail: `day ${day} < since` } };
  }
  if (options.until && day > options.until) {
    return { skip: { filePath, reason: 'filtered-out', detail: `day ${day} > until` } };
  }
  if (options.modelContains && !(context.model ?? '').includes(options.modelContains)) {
    return { skip: { filePath, reason: 'filtered-out', detail: `model ${context.model}` } };
  }

  return {
    sample: {
      ...usage,
      ownerId,
      sessionId: context.sessionId ?? basename(filePath, '.jsonl'),
      filePath,
      timestamp: context.timestamp!,
      day,
      model: context.model,
      entrypoint: context.entrypoint,
      cliVersion: context.cliVersion,
      cwd: context.cwd,
      lineNumber: found.lineNumber,
      bytesBeforeSample: found.bytesBefore,
    },
  };
}

const EMPTY_SKIP_CENSUS: Record<SkipReason, number> = {
  'no-usage-row': 0,
  'all-below-threshold': 0,
  'incomplete-usage': 0,
  'sidechain-only': 0,
  'filtered-out': 0,
  undatable: 0,
  unreadable: 0,
};

/** Walk `root`, measure every transcript, and return samples plus a full skip census. */
export async function scanLaunchTranscripts(options: ScanOptions): Promise<ScanReport> {
  const files = await collectTranscriptFiles(options.root, options.maxDepth ?? 8);
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const samples: LaunchSample[] = [];
  const skipped: SkippedFile[] = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= files.length) return;
      const outcome = await measureTranscriptFile(files[index]!, options);
      if ('sample' in outcome) samples.push(outcome.sample);
      else skipped.push(outcome.skip);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));

  samples.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const skippedByReason = { ...EMPTY_SKIP_CENSUS };
  for (const skip of skipped) skippedByReason[skip.reason] += 1;

  return {
    root: options.root,
    samples,
    filesScanned: files.length,
    filesMeasured: samples.length,
    skipped,
    skippedByReason,
  };
}
