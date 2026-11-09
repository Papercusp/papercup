/** Registry preflight shared by standalone private HTTP workers and their cheap guard. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { constants as osConstants, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from 'esbuild';
import { parse as parseToml } from '@iarna/toml';
import { classifyHttpError } from '@papercusp/papercusp-shared/agent';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { readConfigurationSnapshot, readConfigurationReadObservation,
  type ConfigurationSnapshot, type ConfigurationReadObservation } from '@papercusp/test-config/configuration-snapshot';
import { CODEX_REFUSAL_BODY_MAX_BYTES, codexModelRefusalDetail, isCodexModelRefusal } from '../lib/inference-gateway/codex-model-refusals';
import { presentedSecretsFromHeaders, scrubErrorText } from '../lib/inference-gateway/error-body-scrub';
import { ensureWorkspaceEntry, isKnownWorkspace } from '../lib/workspace-registry';
import { PANEL_LABELS, type PanelKey, type SystemHealth } from '../lib/system-health/types';
import { readVerifierSourceReceiptSync, verifierSourceFiles, type VerifierSourceFile } from '../lib/verifier-source';
import { linuxProcStateFromStat, linuxStartTicksFromProcStat, readProcessIdentity } from '../lib/process-identity';
import type { CommittedReaderObservationCohort, CommittedReaderObservationIdentity,
  CommittedReaderPreparationHandoff } from './isolated-integration-proof';
import type { LegacyAdoptionEvidence, LegacyAdoptionPayload,
  readLegacyAdoptionHistoryAndEffects } from '../lib/blind-review-continuation-custody';
// @ts-ignore -- reuse the maintained JS router's watchdog policy, as isolated-integration-proof does.
import { decideWatchdogExpiry } from '../../../scripts/lib/batch-watchdog.mjs';
// @ts-ignore -- reuse install:safe's maintained direct-dependency range detector.
import { findUnsatisfiedDeclaredDepRanges } from '../../../scripts/check-declared-deps-extracted.mjs';
// @ts-ignore -- share the unit-test process boundary with other standalone runtimes.
import { isolatedRuntimeEnv } from '../../../scripts/lib/isolation-child-env.mjs';
import { hashNativeArtifactBytes, readNativeArtifactBytes, readNativeProcessTraceArtifacts } from '../../../scripts/lib/budgeted-task-scheduler.mjs';
import { nativeProcessTraceEnv, nativeSourceRetentionLimits } from '../../../scripts/lib/vitest-startup-trace.mjs';
// @ts-ignore -- share the router's evidence contract before direct bundle preparation too.
import { assertPrivateIntegrationEvidence as assertPrivatePreparationEvidence } from '../../../scripts/test-files.mjs';
import { RESTRICTED_HOLD_PREFLIGHT_TIMEOUT_MS } from '../../../scripts/lib/restricted-hold-preflight.mjs';

export interface PrivateUnrelatedCheckpointObservation {
  workspace: string;
  base: string;
  expectedBuildSha: string;
  healthBefore: { service: string; sha: string; bundleStale?: unknown };
  healthAfter: { service: string; sha: string; bundleStale?: unknown };
  itemId: string;
  harness: string;
  checkpoint: string;
  /** All times use the observing worker's monotonic clock, including body drainage. */
  startedAtMs: number;
  completedAtMs: number;
  response: { status: number; envelope: unknown };
  /** Correlate this backend with the fixture's held row before collecting these samples. */
  stallBefore: PrivateCheckpointStallSample;
  stallAfter: PrivateCheckpointStallSample;
  readback: { observedAtMs: number; workspace: string; harness: string; itemId: string; checkpoint: string };
}

interface PrivateCheckpointStallSample {
  observedAtMs: number;
  itemId: string;
  pid: number;
  backendStart: string;
  queryStart: string;
  state: string;
  waitEventType: string;
}

/** D-007/R-003's unrelated-write detector for the existing private HTTP worker.
 * This validates observations, never manufactures them. Unit inputs are not HTTP
 * acceptance evidence; the real caller still owes original source/preparation,
 * backend correlation, lifecycle cleanup, and the rest of the fault matrix.
 */
export function assertPrivateUnrelatedCheckpointObservation(o: PrivateUnrelatedCheckpointObservation) {
  assert.match(o.workspace, /^test-runtime-[a-z0-9-]+$/);
  const base = new URL(o.base);
  assert.equal(base.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'private HTTP host must be loopback');
  assert.ok(base.port && !['3070', '3170', '3055'].includes(base.port), 'use the existing disposable HTTP host');
  assert.equal(base.pathname, '/');
  assert.ok(!base.username && !base.password && !base.search && !base.hash);
  assert.match(o.expectedBuildSha, /^[a-f0-9]{10,40}$/);
  for (const health of [o.healthBefore, o.healthAfter]) {
    assert.equal(health.service, 'papercusp-operator');
    assert.equal(health.sha, o.expectedBuildSha, 'serving build changed or is not the selected build');
    assert.equal(health.bundleStale, undefined, 'stale bundle cannot qualify');
  }
  assert.ok(o.itemId && o.harness && o.checkpoint, 'select the exact item, canonical harness and nonempty checkpoint');
  const times = [o.startedAtMs, o.completedAtMs, o.stallBefore?.observedAtMs,
    o.stallAfter?.observedAtMs, o.readback?.observedAtMs];
  assert.ok(times.every(value => Number.isFinite(value) && value >= 0), 'finite monotonic observations required');
  const elapsedMs = o.completedAtMs - o.startedAtMs;
  assert.ok(elapsedMs >= 0 && elapsedMs <= 20_000, 'unrelated checkpoint must finish within D-007 20 seconds');
  for (const sample of [o.stallBefore, o.stallAfter]) {
    assert.ok(sample.itemId && sample.itemId !== o.itemId, 'stall must belong to another item');
    assert.ok(Number.isSafeInteger(sample.pid) && sample.pid > 0 && sample.backendStart && sample.queryStart,
      'retain the observed PostgreSQL backend and query identity');
    assert.equal(sample.state, 'active', 'stalled query must still be active');
    assert.equal(sample.waitEventType, 'Lock', 'retain an actual PostgreSQL lock wait');
  }
  for (const key of ['itemId', 'pid', 'backendStart', 'queryStart'] as const)
    assert.equal(o.stallAfter[key], o.stallBefore[key], 'the same stalled query must span the HTTP write');
  assert.ok(o.stallBefore.observedAtMs <= o.startedAtMs && o.stallAfter.observedAtMs >= o.completedAtMs,
    'stall observations must bracket the complete HTTP write');
  assert.equal(o.response.status, 200, 'an HTTP error is not a successful mutation receipt');
  const envelope = o.response.envelope as any;
  assert.equal(envelope?.ok, true, 'HTTP dispatch must succeed');
  assert.notEqual(envelope.result?.isError, true, 'tool refusal is not a successful mutation receipt');
  let receipt = envelope.result?.structuredContent;
  if (!receipt) {
    const json = envelope.result?.content?.filter((part: any) =>
      part.type === 'text' && typeof part.text === 'string' && part.text.trim().startsWith('{'));
    assert.equal(json?.length, 1, 'one unambiguous authoritative JSON receipt required');
    receipt = JSON.parse(json[0].text);
  }
  assert.equal(receipt?.ok, true, 'unavailable or outcome-unknown is not write success');
  assert.deepEqual(receipt.counts, { ok: 1, failed: 0 });
  assert.equal(receipt.results?.length, 1, 'receipt must name only the requested mutation');
  const row = receipt.results[0];
  assert.equal(row.ok, true);
  assert.ok(!row.error && !row.errorCode, 'a failed or ambiguous write cannot qualify');
  assert.equal(row.id, o.itemId);
  assert.equal(row.harness, o.harness);
  assert.equal(row.cleared, false);
  assert.equal(row.verified, true, 'checkpoint writer must verify persistence through its reader');
  assert.equal(row.length, o.checkpoint.length);
  assert.equal(row.contentHash, createHash('sha256').update(o.checkpoint, 'utf8').digest('hex').slice(0, 12));
  assert.ok(o.readback.observedAtMs >= o.completedAtMs, 'readback must follow the completed response');
  assert.equal(o.readback.workspace, o.workspace);
  assert.equal(o.readback.harness, o.harness);
  assert.equal(o.readback.itemId, o.itemId);
  assert.equal(o.readback.checkpoint, o.checkpoint, 'independent readback must contain the exact submitted checkpoint');
}

/** Identify a private PG socket without retaining authentication or query bytes.
 * postgres-js writes the complete startup packet before its first query. Ignore
 * SSL/cancel requests, incomplete packets and everything after that packet. */
export function privatePgStartupIdentity(chunk: unknown): { database: string | null; applicationName: string | null } | null {
  if (!(chunk instanceof Uint8Array)) return null;
  const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (bytes.length < 9) return null;
  const length = bytes.readUInt32BE(0);
  if (length < 9 || length > 16_384 || length > bytes.length || bytes.readUInt32BE(4) !== 196608) return null;
  if (bytes[length - 1] !== 0) return null;
  let database: string | null = null, applicationName: string | null = null;
  let offset = 8;
  while (offset < length - 1) {
    const keyEnd = bytes.indexOf(0, offset);
    if (keyEnd < offset || keyEnd >= length - 1) return null;
    const valueEnd = bytes.indexOf(0, keyEnd + 1);
    if (valueEnd < keyEnd + 1 || valueEnd >= length - 1) return null;
    const key = bytes.toString('utf8', offset, keyEnd);
    if (key === 'database' || key === 'application_name') {
      const value = bytes.toString('utf8', keyEnd + 1, valueEnd);
      if (value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value)) {
        if (key === 'database') database = value;
        else applicationName = value;
      }
    }
    offset = valueEnd + 1;
  }
  return offset === length - 1 ? { database, applicationName } : null;
}

/** Retain the actual provider refusal before a disposable journey asserts success.
 * Drain a clone, preserving the consumer's original body. Successful model content
 * and request content are never retained; failure details use the gateway scrubber. */
export async function retainPrivateProviderResponse(evidenceDir: string, response: Response,
  init: RequestInit & { diagnosticAccountId?: string } = {}) {
  const requestBytes = typeof init.body === 'string' ? Buffer.from(init.body)
    : init.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
  let request: any;
  try { request = JSON.parse(requestBytes.toString('utf8')); } catch { /* measured below as unparseable */ }
  const label = (value: unknown) => typeof value === 'string' && /^[a-z0-9_.-]{1,100}$/i.test(value) ? value : null;
  const fields = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter(key => /^[a-z0-9_]{1,100}$/i.test(key)).sort() : [];
  const requestShape = { bytes: requestBytes.length, parsed: Boolean(request), fields: fields(request),
    model: label(request?.model), effort: label(request?.reasoning?.effort ?? request?.output_config?.effort), stream: request?.stream === true,
    instructionsBytes: typeof request?.instructions === 'string' ? Buffer.byteLength(request.instructions) : null,
    inputCount: Array.isArray(request?.input) ? request.input.length : null,
    toolsCount: Array.isArray(request?.tools) ? request.tools.length : null,
    toolFields: Array.isArray(request?.tools) ? [...new Set(request.tools.flatMap(fields))].sort() : [] };
  const presented = presentedSecretsFromHeaders(Object.fromEntries(new Headers(init.headers).entries()));
  // Also scrub echoed request content. Schema labels still diagnose malformed tools.
  const collectContent = (value: unknown, key = '') => {
    if (typeof value === 'string' && !['model', 'effort', 'type', 'name'].includes(key) && value.length >= 12)
      presented.push(value);
    else if (value && typeof value === 'object')
      for (const [name, child] of Object.entries(value)) collectContent(child, name);
  };
  collectContent(request);
  const failed = response.status >= 400;
  // Look ahead far enough to scrub a presented value crossing the sample boundary.
  const sampleLimit = CODEX_REFUSAL_BODY_MAX_BYTES + Math.max(0, ...presented.map(value => Buffer.byteLength(value)));
  const chunks: Buffer[] = [];
  let bytes = 0, sampledBytes = 0;
  const reader = response.clone().body?.getReader();
  try {
    if (reader) for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (failed && sampledBytes < sampleLimit) {
        const sample = Buffer.from(next.value.subarray(0, sampleLimit - sampledBytes));
        chunks.push(sample); sampledBytes += sample.length;
      }
    }
  } finally { reader?.releaseLock(); }
  const text = failed ? scrubErrorText(Buffer.concat(chunks).toString('utf8'), presented) : '';
  const classified = failed ? classifyHttpError({ status: response.status, message: text }, 'openai') : null;
  const observation = { status: response.status, accountId: init.diagnosticAccountId ?? null,
    requestShape, response: { bytes, sampledBytes, truncated: failed && bytes > sampledBytes },
    error: classified ? { class: classified.class, retryable: classified.retryable,
      modelRefusal: isCodexModelRefusal(response.status, text), detail: codexModelRefusalDetail(text) } : null };
  writeFileSync(join(evidenceDir, 'provider-response.json'), JSON.stringify(observation), { mode: 0o600 });
  return observation;
}

/** Measure the native Codex launch, rather than its role spec or TOML alone.
 * Codex applies config overrides over TOML, then its dedicated model flag.
 * Like the CLI, config values that are not TOML strings remain literal strings. */
export function privateCodexModelConfig(argv: readonly string[], config: Record<string, unknown>) {
  let model = config.model;
  let effort = config.model_reasoning_effort;
  let modelFlag: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model' || arg === '-m') modelFlag = argv[++i];
    else if (arg.startsWith('--model=')) modelFlag = arg.slice('--model='.length);
    else {
      const override = arg === '-c' || arg === '--config' ? argv[++i]
        : arg.startsWith('--config=') ? arg.slice('--config='.length)
        : arg.startsWith('-c=') ? arg.slice(3) : undefined;
      if (override === undefined) continue;
      const split = override.indexOf('=');
      const key = override.slice(0, split).trim();
      if (split < 0 || !['model', 'model_reasoning_effort'].includes(key)) continue;
      const raw = override.slice(split + 1).trim();
      let value: unknown;
      try { value = parseToml(`value = ${raw}`).value; } catch { value = raw; }
      if (key === 'model') model = value;
      else effort = value;
    }
  }
  return { model: modelFlag ?? model, effort };
}

/** The isolated PG supervisor strips Docker environment and credentials.
 * Restore only the explicitly selected local endpoint from the fixture argv. */
export function privateNativeDockerHost(argv: readonly string[]): string {
  const selections = argv.filter(arg => arg.startsWith('--native-docker-host='));
  assert.equal(selections.length, 1, 'Native fixture requires exactly one explicit Docker endpoint');
  const selected = selections[0].slice('--native-docker-host='.length);
  assert.match(selected, /^unix:\/\/\/[^\s?#]+$/,
    'Native fixture requires an explicit local unix Docker endpoint');
  return selected;
}

/** Read only routing fields from the actual Claude argv/env and signed MCP file.
 * Never return the environment, token, or full MCP URL to the evidence recorder. */
export function privateClaudeModelConfig(argv: readonly string[], env: NodeJS.ProcessEnv,
  readConfig: (path: string) => string = path => readFileSync(path, 'utf8')) {
  const flag = (name: string) => {
    let value: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === name) value = argv[++i];
      else if (argv[i].startsWith(name + '=')) value = argv[i].slice(name.length + 1);
    }
    return value;
  };
  const path = flag('--mcp-config');
  assert.ok(path, 'native Claude must load its explicit signed MCP file');
  assert.ok(argv.includes('--strict-mcp-config'), 'native Claude must exclude ambient MCP servers');
  const mcp = new URL(JSON.parse(readConfig(path)).mcpServers.papercusp.url);
  const headers = Object.fromEntries((env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n').filter(Boolean).map(line => {
    const split = line.indexOf(':');
    return [line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim()];
  }));
  return { model: flag('--model'), effort: flag('--effort'), baseUrl: env.ANTHROPIC_BASE_URL,
    ownerId: headers['x-papercusp-owner'],
    accountPinPresent: Boolean(env.PAPERCUSP_ACCOUNT_ID || headers['x-papercusp-account']),
    mcpOrigin: mcp.origin, mcpOwnerId: mcp.searchParams.get('client'),
    mcpWorkspace: mcp.searchParams.get('workspace') };
}

export interface PrivateHostStopObservation {
  pid: number | null;
  phase: string;
  elapsedMs: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  sigtermAccepted: boolean | null;
  sigkillAccepted: boolean | null;
  exitObserved: boolean;
  closeObserved: boolean;
  signal?: NodeJS.Signals;
  accepted?: boolean;
  /** Pinned while still descended from this host; redirected stdio is not an exit fence. */
  postgres?: Array<{ pid: number; identity: string; postmaster: boolean; state: string | null }>;
  /** Diagnostic kernel evidence, never a replacement for exit/close events. */
  kernelProcess?: {
    status: 'present' | 'absent' | 'unavailable' | 'unsupported';
    state: string | null;
    startTicks: string | null;
    waitChannel: string | null;
  };
}

interface PrivatePostgresProcess { pid: number; identity: string; postmaster: boolean }
export interface PrivateHostStopOptions {
  /** Test seam for exercising restricted /proc/<pid>/exe access on a live tree. */
  readExecutable?: (pid: number) => string;
}

const privateHostPostgres = new WeakMap<ChildProcess, Map<number, PrivatePostgresProcess>>();

function privatePostgresState(pin: PrivatePostgresProcess): string | null {
  try {
    const stat = readFileSync(`/proc/${pin.pid}/stat`, 'utf8');
    const identity = readProcessIdentity(pin.pid);
    if (!identity && !existsSync(`/proc/${pin.pid}`)) return null;
    assert.ok(identity, 'private PostgreSQL identity is unreadable');
    if (identity !== pin.identity) return null;
    const state = linuxProcStateFromStat(stat);
    assert.ok(state, 'private PostgreSQL process state is unreadable');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function privatePostgresAlive(pin: PrivatePostgresProcess) {
  const state = privatePostgresState(pin);
  return state !== null && state !== 'Z' && state !== 'X';
}

/** Inspect only this host's descendant tree, never a host-wide PID/name search.
 * A root must also own its exact PGDATA pid file. Retain stable kernel identities
 * across host exit/reparenting, and recheck them before sending any signal. */
function isPostgresExecutable(pid: number, readExecutable: (pid: number) => string) {
  let processName: string;
  try { processName = basename(readExecutable(pid)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
    // The exe symlink can be unreadable for a live descendant even when its
    // command line is readable. argv[0] only identifies a candidate here;
    // exact -D, pid-file, PGDATA realpath, and process-identity checks below
    // remain mandatory before it can be pinned or signalled.
    const argv0 = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] ?? '';
    processName = basename(argv0);
  }
  return processName === 'postgres' || processName.startsWith('postgres:') || processName.startsWith('postgres ');
}

function capturePrivatePostgres(host: ChildProcess, readExecutable: (pid: number) => string) {
  const pins = privateHostPostgres.get(host) ?? new Map<number, PrivatePostgresProcess>();
  privateHostPostgres.set(host, pins);
  if (process.platform !== 'linux' || !host.pid) return pins;
  const visited = new Set<number>();
  const visit = (pid: number, identity: string, owned: boolean) => {
    if (visited.has(pid) || readProcessIdentity(pid) !== identity) return;
    visited.add(pid);
    assert.ok(visited.size <= 256, 'private PostgreSQL descendant census exceeded its bound');
    let children: string;
    try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const raw of children.trim().split(/\s+/).filter(Boolean)) {
      const childPid = Number(raw), childIdentity = readProcessIdentity(childPid);
      if (!childIdentity) {
        assert.ok(!existsSync(`/proc/${childPid}`), 'private descendant identity is unreadable');
        continue;
      }
      if (!privatePostgresAlive({ pid: childPid, identity: childIdentity, postmaster: false })) continue;
      let postmaster = false;
      if (!owned) {
        try {
          if (isPostgresExecutable(childPid, readExecutable)) {
            const argv = readFileSync(`/proc/${childPid}/cmdline`, 'utf8').split('\0');
            const at = argv.lastIndexOf('-D');
            assert.ok(at >= 0 && argv[at + 1], 'private postmaster must name its PGDATA');
            const dataDir = realpathSync(argv[at + 1]);
            const [recordedPid, recordedDir] = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n');
            assert.equal(Number(recordedPid), childPid, 'private postmaster pid file identity mismatch');
            assert.equal(realpathSync(recordedDir), dataDir, 'private postmaster PGDATA mismatch');
            postmaster = true;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          assert.ok(!privatePostgresAlive({ pid: childPid, identity: childIdentity, postmaster: false }),
            'live private postmaster ownership could not be verified');
        }
      }
      if (readProcessIdentity(childPid) !== childIdentity) continue;
      if (owned || postmaster) pins.set(childPid, { pid: childPid, identity: childIdentity, postmaster });
      visit(childPid, childIdentity, owned || postmaster);
    }
  };
  // Once Node has reaped the host, its numeric PID may be reused. Only the
  // already-pinned PG identities remain ours to inspect after that boundary.
  if (host.exitCode === null && host.signalCode === null) {
    const hostIdentity = readProcessIdentity(host.pid);
    if (hostIdentity) visit(host.pid, hostIdentity, false);
  }
  for (const pin of pins.values()) if (privatePostgresAlive(pin)) visit(pin.pid, pin.identity, true);
  return pins;
}

/** Stop admission before reaping descendants that can keep the host's pipes open.
 * A rejected stop retains observations on the error, independently of the optional
 * diagnostic sink. Neither a signal attempt nor ended pipes prove process exit. */
export async function stopPrivateOperatorHost(host: ChildProcess, afterExit?: () => Promise<void>, graceMs = 5_000,
  observe?: (observation: PrivateHostStopObservation) => void, options: PrivateHostStopOptions = {}) {
  const readExecutable = options.readExecutable ?? (pid => readlinkSync(`/proc/${pid}/exe`));
  const started = Date.now();
  const alreadyExited = host.exitCode !== null || host.signalCode !== null;
  const pipesEnded = () => [host.stdout, host.stderr].every(stream => !stream || stream.destroyed || stream.readableEnded);
  let exitObserved = alreadyExited, closeObserved = alreadyExited && pipesEnded();
  let sigtermAccepted: boolean | null = null, sigkillAccepted: boolean | null = null;
  let phase = 'start';
  const observations: PrivateHostStopObservation[] = [];
  let postgres = privateHostPostgres.get(host) ?? new Map<number, PrivatePostgresProcess>();
  privateHostPostgres.set(host, postgres);
  const kernelProcess = (): NonNullable<PrivateHostStopObservation['kernelProcess']> => {
    const unknown = { state: null, startTicks: null, waitChannel: null };
    if (process.platform !== 'linux') return { ...unknown, status: 'unsupported' };
    if (!host.pid) return { ...unknown, status: 'unavailable' };
    try {
      const stat = readFileSync(`/proc/${host.pid}/stat`, 'utf8');
      let waitChannel: string | null = null;
      try { waitChannel = readFileSync(`/proc/${host.pid}/wchan`, 'utf8').trim() || null; }
      catch { /* the process may exit between these two diagnostic reads */ }
      return { status: 'present', state: linuxProcStateFromStat(stat),
        startTicks: linuxStartTicksFromProcStat(stat), waitChannel };
    } catch (error) {
      return { ...unknown, status: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'absent' : 'unavailable' };
    }
  };
  const snapshot = (name: string): PrivateHostStopObservation => ({
    pid: host.pid ?? null, phase: name, elapsedMs: Date.now() - started,
    exitCode: host.exitCode, signalCode: host.signalCode,
    sigtermAccepted, sigkillAccepted, exitObserved, closeObserved,
    kernelProcess: kernelProcess(),
    ...(postgres.size ? { postgres: [...postgres.values()].map(pin => {
      try { return { ...pin, state: privatePostgresState(pin) }; }
      catch { return { ...pin, state: 'unavailable' }; }
    }) } : {}),
  });
  const record = (name: string, detail: Partial<PrivateHostStopObservation> = {}) => {
    const observation = { ...snapshot(name), ...detail };
    observations.push(observation);
    try { observe?.(observation); } catch { /* diagnostics must not prevent teardown */ }
  };
  let resolveExit!: () => void, resolveClose!: () => void;
  const exited = new Promise<void>(done => { resolveExit = done; });
  const closed = new Promise<void>(done => { resolveClose = done; });
  const onExit = () => { exitObserved = true; record('exit'); resolveExit(); };
  const onClose = () => { closeObserved = true; record('close'); resolveClose(); };
  if (exitObserved) resolveExit();
  else host.once('exit', onExit);
  if (closeObserved) resolveClose();
  else host.once('close', onClose);
  const bounded = async (promise: Promise<void>, label: string) => {
    phase = label;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Private host ${label} did not settle`)), graceMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const signal = (value: 'SIGTERM' | 'SIGKILL') => {
    phase = 'signal';
    let accepted = false;
    try { accepted = host.kill(value); }
    finally {
      if (value === 'SIGTERM') sigtermAccepted = accepted;
      else sigkillAccepted = accepted;
      record('signal', { signal: value, accepted });
    }
  };
  try {
    record('start');
    // Capture before the parent disappears: PG can outlive a successful host
    // exit without holding either of its stdout/stderr descriptors open.
    let captureError: unknown;
    try { postgres = capturePrivatePostgres(host, readExecutable); }
    catch (error) { captureError = error; }
    if (postgres.size) record('postgres captured');
    if (!alreadyExited) {
      signal('SIGTERM');
      try { await bounded(exited, 'exit'); }
      catch { signal('SIGKILL'); await bounded(exited, 'forced exit'); }
    }
    if (captureError) { phase = 'postgres capture'; throw captureError; }
    if (postgres.size) {
      phase = 'postgres shutdown';
      const signalPostgres = (pin: PrivatePostgresProcess, value: NodeJS.Signals) => {
        if (!privatePostgresAlive(pin)) return;
        try { process.kill(pin.pid, value); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      for (const pin of postgres.values()) if (pin.postmaster) signalPostgres(pin, 'SIGINT');
      const wait = async () => {
        const deadline = Date.now() + graceMs;
        while ([...capturePrivatePostgres(host, readExecutable).values()].some(privatePostgresAlive)) {
          if (Date.now() >= deadline) return false;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return true;
      };
      if (!await wait()) {
        record('postgres shutdown timed out');
        // A disposable fixture must not leave live PG behind for its task's
        // service teardown. Even observed forced cleanup remains a failed run.
        for (const pin of postgres.values()) signalPostgres(pin, 'SIGKILL');
        const stopped = await wait();
        throw new Error(stopped ? 'Private PostgreSQL required forced cleanup'
          : 'Private PostgreSQL exit did not settle');
      }
      record('postgres stopped');
    }
    phase = 'dependent cleanup';
    await afterExit?.();
    await bounded(closed, 'stdio drainage');
    // A native crash can close every pipe and release PG while still being a
    // failed teardown. Finish dependent cleanup first, then retain the failure.
    if (host.signalCode && ['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGTRAP', 'SIGSYS'].includes(host.signalCode)) {
      phase = 'native process termination';
      throw new Error(`Private host crashed during teardown: ${host.signalCode}`);
    }
    record('complete');
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    record('failed');
    Object.assign(failure, { privateHostStop: { ...snapshot(phase), observations } });
    throw failure;
  } finally {
    host.removeListener('exit', onExit);
    host.removeListener('close', onClose);
  }
}

/** MCP needs an attributable serving generation. Use the bundler's own source
 * resolver before compilation, private PG or native launch; a dirty checkout
 * cannot be relabelled with an inherited environment SHA. */
export function privateMcpSourceSha(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const common = resolve(import.meta.dirname, '../../../apps/operator/bin/bundle-host-common.sh');
  const sourceSha = execFileSync('bash', ['-c',
    'source "$1"; shift; bundle_host_source_sha "$@"', 'private-mcp-source', common, root,
    process.execPath, '--import', join(root, 'scripts/lib/committed-source-loader.mjs')],
  { env, encoding: 'utf8', timeout: 60_000 }).trim();
  assert.match(sourceSha, /^[a-f0-9]{7,64}$/,
    'Private MCP requires attributable source before compilation; run through scripts/source-preview.mjs verifier-run');
  return sourceSha;
}

/** Prepared ESM bundles must not inherit test transformers or Vitest's passive
 * startup tracer into their confined native descendants. Keep source guards,
 * unrelated preloads and all resource limits. */
export function privateBundleRuntimeEnv(env: NodeJS.ProcessEnv,
  observation?: { traceOut: string; pinnedSources?: Array<{ path: string; sha256: string; byteLength: number }> }): NodeJS.ProcessEnv {
  const tokens = (env.NODE_OPTIONS ?? '').match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
  const value = (token: string) => token.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g,
    (_, double: string | undefined, single: string | undefined) => double?.replace(/\\(["\\])/g, '$1') ?? single!);
  const testPreload = (specifier: string) => /^tsx(?:\/(?:esm|cjs))?$/.test(specifier)
    || /(?:^|\/)node_modules\/tsx\//.test(specifier)
    || /(?:^|\/)scripts\/lib\/vitest-startup-trace\.mjs$/.test(specifier);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = value(tokens[i]);
    const inline = token.match(/^(?:--import|--loader|--experimental-loader|--require|-r)=(.+)$/);
    if (inline && testPreload(inline[1])) continue;
    if (/^(?:--import|--loader|--experimental-loader|--require|-r)$/.test(token)
      && tokens[i + 1] && testPreload(value(tokens[i + 1]))) { i++; continue; }
    kept.push(tokens[i]);
  }
  const runtime = { ...env, NODE_OPTIONS: kept.join(' ') };
  if (!observation) return runtime;
  assert.ok(isAbsolute(observation.traceOut) && observation.traceOut.trim() === observation.traceOut,
    'Private host trace requires an absolute channel');
  assert.ok(!existsSync(observation.traceOut) && !existsSync(observation.traceOut + '.native-processes'),
    'Private host trace requires a fresh channel');
  // Select the maintained passive preload only after removing inherited test
  // transformers and trace preloads. Its evidence remains loader-return only.
  return nativeProcessTraceEnv({ ...runtime, PC_EXECUTED_SOURCE_MAP_OUT: observation.traceOut },
    { pinnedSources: observation.pinnedSources ?? [] });
}

/** Retain readiness evidence even when the host exits, is signaled, or fails
 * to spawn. Request failures converge; process termination never retries. */
export async function waitForPrivateOperator(options: {
  host: ChildProcess; base: string; headers?: Record<string, string>; evidenceDir: string;
  hostIdentity?: string | null; environment: NodeJS.ProcessEnv; timeoutMs?: number;
  requireBuildIdentity?: boolean;
}) {
  const { host, base, headers, evidenceDir, environment } = options;
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 90_000);
  const probes: Array<{ elapsedMs: number; status?: number; service?: unknown; error?: string }> = [];
  let attempts = 0;
  let health: any;
  let failure: unknown;
  let spawnError: Error | undefined;
  const onError = (error: Error) => { spawnError = error; };
  host.once('error', onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(host.exitCode, null, 'private host exited before readiness');
      assert.equal(host.signalCode, null, 'private host was signaled before readiness');
      attempts++;
      try {
        const response = await fetch(base + '/api/health', { headers, signal: AbortSignal.timeout(2_000) });
        const probe = { elapsedMs: Date.now() - started, status: response.status, service: undefined as unknown };
        probes.push(probe);
        if (response.ok) { health = await response.json(); probe.service = health?.service; break; }
      } catch (error) {
        probes.push({ elapsedMs: Date.now() - started,
          error: error instanceof Error ? `${error.name}: ${error.message}; cause=${String(error.cause ?? '')}` : String(error) });
      }
      if (probes.length > 24) probes.shift();
      await new Promise(done => setTimeout(done, 250));
    }
    assert.equal(health?.service, 'papercusp-operator', 'private operator never became ready');
    if (options.requireBuildIdentity) assert.ok(typeof health.sha === 'string' && /^[a-f0-9]{7,64}$/.test(health.sha),
      'Private MCP requires an attributable serving build before native launch; use the verified-source route');
    return health;
  } catch (error) { failure = error; throw error; }
  finally {
    host.off('error', onError);
    writeFileSync(join(evidenceDir, 'readiness.json'), JSON.stringify({ base, pid: host.pid,
      hostIdentity: options.hostIdentity, mallocArenaMax: environment.MALLOC_ARENA_MAX ?? null,
      nodeOptions: environment.NODE_OPTIONS ?? null, exitCode: host.exitCode, signalCode: host.signalCode,
      elapsedMs: Date.now() - started, attempts, probes: probes.slice(-24),
      ...(options.requireBuildIdentity ? { buildSha: health?.sha ?? null } : {}),
      failure: failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure) }));
  }
}

/** Additional pins on the existing operator-api-preflight.json receipt. This
 * is preparation evidence, not proof that a host loaded or served the bundle.
 * The selected source/dependency/graph receipt must come from the independent
 * preparation phase; an in-process snapshot cannot certify its own selection.
 */
export interface CommittedReaderClosure {
  sourceCommit: string;
  sha256: string;
  metafileSha256: string;
  testPaths: string[];
  helperPaths: string[];
  configPaths: string[];
  executedImports: string[];
  dependencyFiles: VerifierSourceFile[];
  externalResolutions: Record<string, string>;
  copiedSources: string[];
  artifacts: { path: string; sha256: string; sourcePath?: string }[];
  schema: Record<string, string>;
  environment: Record<string, string>;
  omitted: string[];
  opaque: string[];
  artifactCensus?: VerifierSourceFile[];
  phase?: 'produced';
  inputReceipt?: { path: string; sha256: string };
  qualification?: { status: 'pending' | 'preparation-qualified' };
}

/** Independent input pins have no predicted bundle or graph digest. Copied
 * artifact paths are relative to the recorder's allocated preparation folder. */
export interface CommittedReaderPreparationInputs extends Omit<CommittedReaderClosure,
  'sha256' | 'metafileSha256' | 'artifacts' | 'artifactCensus' | 'phase' | 'inputReceipt' | 'qualification'> {
  phase: 'planned';
  copiedArtifacts: { path: string; sourcePath: string }[];
}

function assertCommittedReaderInputs(closure: Omit<CommittedReaderClosure,
  'sha256' | 'metafileSha256' | 'artifacts' | 'artifactCensus' | 'phase' | 'inputReceipt' | 'qualification'>) {
  assert.ok(closure && typeof closure === 'object' && !Array.isArray(closure),
    'Independent closure receipt must be an object');
  for (const key of ['testPaths', 'helperPaths', 'configPaths', 'executedImports', 'copiedSources',
    'dependencyFiles', 'omitted', 'opaque'] as const)
    assert.ok(Array.isArray(closure[key]), `Required closure dimension missing: ${key}`);
  for (const key of ['schema', 'environment', 'externalResolutions'] as const)
    assert.ok(closure[key] && typeof closure[key] === 'object' && !Array.isArray(closure[key]),
      `Required closure dimension missing: ${key}`);
  assert.deepEqual(closure.omitted, [], 'Required closure has omitted dimensions');
  assert.deepEqual(closure.opaque, [], 'Required closure has opaque dimensions');
  for (const key of ['testPaths', 'helperPaths', 'configPaths', 'executedImports'] as const)
    assert.ok(closure[key].length, `Required closure dimension empty: ${key}`);
  assert.ok(Object.keys(closure.schema).length && Object.keys(closure.environment).length,
    'Required private schema and environment pins are missing');
  for (const [key, expected] of Object.entries(closure.environment))
    assert.match(expected, /^[a-f0-9]{64}$/, `Environment digest missing: ${key}`);
}

function assertCommittedReaderClosure(closure: CommittedReaderClosure) {
  assertCommittedReaderInputs(closure);
  // Producer markers cannot downgrade a partial receipt into the legacy path.
  if (['phase', 'inputReceipt', 'artifactCensus'].some(key => Object.hasOwn(closure, key))
    || closure.qualification?.status === 'pending')
    assert.equal(closure.phase, 'produced', 'Produced preparation phase is required');
  assert.ok(Array.isArray(closure.artifacts), 'Required closure dimension missing: artifacts');
  assert.ok(closure.artifacts.length, 'Required closure dimension empty: artifacts');
  for (const key of ['sha256', 'metafileSha256'] as const) {
    assert.ok(typeof closure[key] === 'string', `Required closure digest missing: ${key}`);
    assert.match(closure[key], /^[a-f0-9]{64}$/, `Required closure digest invalid: ${key}`);
  }
}

const digestBytes = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export { censusPrivateRuntimeArtifact, type PrivateArtifactReadAdvice } from './private-runtime-artifact-census.mts';
function inside(root: string, path: string) {
  const rel = relative(realpathSync(root), realpathSync(path));
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

/** The same independent archive/dependency contract runs before building and
 * when consuming. Static graph membership never supplies observed imports. */
function qualifyCommittedReaderInputs(root: string, sourceReceiptPath: string, selectedCommit: string,
  closure: Omit<CommittedReaderClosure,
    'sha256' | 'metafileSha256' | 'artifacts' | 'artifactCensus' | 'phase' | 'inputReceipt' | 'qualification'>) {
  assertCommittedReaderInputs(closure);
  assert.match(selectedCommit, /^[a-f0-9]{40}$/, 'Exact selected committed source is required');
  assert.equal(closure.sourceCommit, selectedCommit, 'Closure differs from selected committed source');
  const source = readVerifierSourceReceiptSync(root, sourceReceiptPath);
  assert.equal(source.sourceCommit, selectedCommit, 'Archive differs from selected committed source');
  const sourceFiles = new Map(source.files.map(file => [file.path, file]));
  const sourcePath = (path: string) => {
    assert.ok(path && !isAbsolute(path) && !path.split('/').some(part => !part || part === '.' || part === '..')
      && !path.includes('\\'), `Invalid closure source path: ${path}`);
    assert.ok(sourceFiles.has(path), `Required source is outside selected archive: ${path}`);
    assert.ok(inside(root, join(root, path)), `Required source resolves outside selected archive: ${path}`);
  };
  for (const input of source.testedInputs) {
    sourcePath(input.path);
    assert.equal(sourceFiles.get(input.path)!.sha256, input.sha256, `Tested input differs: ${input.path}`);
  }
  for (const path of [...closure.testPaths, ...closure.helperPaths, ...closure.configPaths,
    ...closure.executedImports, ...closure.copiedSources]) sourcePath(path);
  for (const path of closure.testPaths)
    assert.ok(source.testedInputs.some(input => input.path === path), `Test is absent from selected tested inputs: ${path}`);
  const dependencies = verifierSourceFiles(join(root, 'node_modules'), { symlinkRoot: root });
  assert.deepEqual(dependencies, closure.dependencyFiles, 'Materialized dependency census differs');
  return { source, sourcePath, dependencies };
}

/** Receipt files are pinned separately. Every other retained output, including
 * logs and copied helpers, remains in the produced artifact census. */
const retainedReceiptNames = ['operator-api-preflight.json', 'operator-api-inputs.json', 'verifier-source.json'];
function preparedArtifactCensus(evidenceDir: string, sourceRoot: string) {
  // bundle-host.sh binds custom outputs to the already pinned dependency
  // tree. Verify that exact binding separately; it is not a copied artifact.
  // Custom outputs outside the source root require this binding even when
  // consuming retained artifacts. Its removal must not fall back to an
  // ancestor's dependencies. Never follow a foreign or independent tree.
  const dependencyPath = join(evidenceDir, 'node_modules');
  const dependencies = lstatSync(dependencyPath, { throwIfNoEntry: false });
  assert.ok(dependencies?.isSymbolicLink()
    && resolve(evidenceDir, readlinkSync(dependencyPath)) === resolve(sourceRoot, 'node_modules'),
    'Prepared runtime dependency binding differs');
  assert.equal(realpathSync(dependencyPath), realpathSync(join(sourceRoot, 'node_modules')),
    'Prepared runtime dependency binding differs');
  // Enumerate every other entry without following links, then reuse the
  // maintained byte census and its strict symlink checks for that population.
  const includedPaths = new Set(readdirSync(evidenceDir, { recursive: true, withFileTypes: true })
    .map(entry => relative(evidenceDir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter(path => path !== 'node_modules'));
  return verifierSourceFiles(evidenceDir, { includedPaths }).filter(file =>
    !retainedReceiptNames.includes(file.path));
}

function plannedCopies(inputs: CommittedReaderPreparationInputs) {
  assert.equal(inputs.phase, 'planned', 'Independent planned inputs are required before building');
  assertCommittedReaderInputs(inputs);
  assert.ok(Array.isArray(inputs.copiedArtifacts), 'Planned copied artifact census is required');
  const copies = new Map<string, string>();
  for (const copy of inputs.copiedArtifacts) {
    assert.ok(copy.path && !isAbsolute(copy.path) && !copy.path.includes('\\')
      && !copy.path.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid planned artifact path');
    assert.ok(!retainedReceiptNames.includes(copy.path)
      && !['hono-host.mjs', 'hono-host.mjs.meta.json', 'operator-api-build.log'].includes(copy.path),
      'Planned copied artifact uses a reserved preparation path');
    assert.ok(!copies.has(copy.path), 'Duplicate planned copied artifact');
    copies.set(copy.path, copy.sourcePath);
  }
  assert.deepEqual([...new Set(copies.values())].sort(), [...new Set(inputs.copiedSources)].sort(),
    'Planned copied source census differs');
  return copies;
}

/** Read-only validation of independently selected planned inputs. Returned
 * bytes are copies; recheck keeps the original pins private and never builds
 * or fills missing observations from this process's environment. */
export function qualifyCommittedReaderPlannedInputs(root: string, selected: {
  inputReceiptPath: string; sourceReceiptPath: string; selectedCommit: string;
  inputReceiptSha256?: string; sourceReceiptSha256?: string;
}) {
  assert.ok(!inside(root, selected.inputReceiptPath),
    'Input receipt must be independent of the source archive');
  const sourceBytes = readFileSync(selected.sourceReceiptPath);
  const inputBytes = readFileSync(selected.inputReceiptPath);
  for (const [pin, bytes] of [[selected.sourceReceiptSha256, sourceBytes],
    [selected.inputReceiptSha256, inputBytes]] as const) {
    if (pin !== undefined) {
      assert.match(pin, /^[a-f0-9]{64}$/, 'Planned receipt digest is required');
      assert.equal(digestBytes(bytes), pin, 'Pinned planned receipt changed');
    }
  }
  const inputs: CommittedReaderPreparationInputs = JSON.parse(String(inputBytes));
  const copies = plannedCopies(inputs);
  const validate = () => {
    const qualified = qualifyCommittedReaderInputs(root, selected.sourceReceiptPath, selected.selectedCommit, inputs);
    for (const source of copies.values()) qualified.sourcePath(source);
    return qualified.source;
  };
  const unchanged = () => {
    assert.deepEqual(readFileSync(selected.sourceReceiptPath), sourceBytes, 'Selected source receipt changed during preparation');
    assert.deepEqual(readFileSync(selected.inputReceiptPath), inputBytes, 'Selected input receipt changed during preparation');
  };
  unchanged();
  const source = validate();
  unchanged();
  return { source, inputs: structuredClone(inputs), copies: new Map(copies),
    sourceBytes: Buffer.from(sourceBytes), inputBytes: Buffer.from(inputBytes),
    sourceReceiptSha256: digestBytes(sourceBytes), inputReceiptSha256: digestBytes(inputBytes),
    recheck: () => { unchanged(); validate(); unchanged(); } };
}

export function qualifyCommittedReaderOriginalPreparation(handoff: CommittedReaderPreparationHandoff | void,
  expected: CommittedReaderObservationIdentity) {
  assert.ok(handoff && typeof handoff === 'object', 'Required original preparation handoff is missing');
  handoff = structuredClone(handoff);
  expected = structuredClone(expected);
  assert.match(expected.sourceCommit, /^[a-f0-9]{40}$/, 'Original selected reference is required');
  assert.ok(expected.runId && Number.isSafeInteger(expected.process?.pid) && expected.process.pid > 0
    && expected.process.identity, 'Original run/process identity is required');
  for (const pin of [handoff.sourceReceiptSha256, handoff.inputReceiptSha256, handoff.observationReceiptSha256])
    assert.match(pin, /^[a-f0-9]{64}$/, 'Original receipt digest is required');
  assert.equal(handoff.selectedCommit, expected.sourceCommit, 'Original selected reference differs');
  const bytes = readFileSync(handoff.observationReceiptPath);
  assert.equal(digestBytes(bytes), handoff.observationReceiptSha256, 'Original observation receipt changed');
  const cohort: CommittedReaderObservationCohort = JSON.parse(String(bytes));
  const identity = (value: CommittedReaderObservationIdentity) => {
    assert.ok(value && typeof value === 'object', 'Original dimension identity is missing');
    assert.deepEqual({ sourceCommit: value.sourceCommit, runId: value.runId, process: value.process }, expected,
      'Original observation cohort identity differs');
  };
  identity(cohort);
  assert.deepEqual(cohort.omitted, [], 'Original observation cohort has omitted dimensions');
  assert.deepEqual(cohort.opaque, [], 'Original observation cohort has opaque dimensions');
  assert.equal(cohort.sourceRoot, handoff.root, 'Original selected source root differs');
  assert.deepEqual(cohort.sourceReceipt, { path: handoff.sourceReceiptPath, sha256: handoff.sourceReceiptSha256 },
    'Original source receipt pin differs');
  assert.deepEqual(cohort.inputReceipt, { path: handoff.inputReceiptPath, sha256: handoff.inputReceiptSha256 },
    'Original input receipt pin differs');
  const planned = qualifyCommittedReaderPlannedInputs(handoff.root, handoff);
  const inputs: CommittedReaderPreparationInputs = planned.inputs;
  const values = { source: planned.source,
    dependencies: { files: inputs.dependencyFiles, externalResolutions: inputs.externalResolutions },
    config: inputs.configPaths, imports: inputs.executedImports, schema: inputs.schema, environment: inputs.environment };
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    const observed = cohort.observations?.[key];
    identity(observed);
    assert.deepEqual(observed.value, values[key], `Original ${key} observation differs from planned inputs`);
  }
  const recheck = () => {
    assert.deepEqual(readFileSync(handoff.observationReceiptPath), bytes, 'Original observation receipt changed during handoff');
    planned.recheck();
  };
  recheck();
  return { planned, cohort, bytes, recheck, handoff };
}

/** Explicit caller expectations constrain originals; they never produce them. */
export interface CommittedReaderCallerContract {
  selectedCommit: string;
  original: { handoff: CommittedReaderPreparationHandoff; identity: CommittedReaderObservationIdentity };
  testPath: string;
  helperPaths: string[];
  configPaths: string[];
  schema: Record<string, string>;
  environment: Record<string, string>;
}

function qualifyCommittedReaderCallerContract(contract: CommittedReaderCallerContract | undefined) {
  assert.ok(contract, 'Explicit committed reader caller contract is required before allocations');
  const o = structuredClone(contract);
  assert.ok(o.original, 'Pinned original preparation handoff is required before producer effects');
  assert.ok(typeof o.selectedCommit === 'string', 'Explicit selected committed source is required');
  assert.match(o.selectedCommit, /^[a-f0-9]{40}$/, 'Exact selected committed source is required');
  assert.ok(typeof o.testPath === 'string' && o.testPath, 'Explicit selected test is required');
  for (const key of ['helperPaths', 'configPaths'] as const)
    assert.ok(Array.isArray(o[key]), `Explicit ${key} population is required`);
  for (const key of ['schema', 'environment'] as const)
    assert.ok(o[key] && typeof o[key] === 'object' && !Array.isArray(o[key]),
      `Explicit ${key} constraints are required`);
  assert.equal(o.original.identity.sourceCommit, o.selectedCommit, 'Original selected reference differs');
  const original = qualifyCommittedReaderOriginalPreparation(o.original.handoff, o.original.identity);
  const { inputs } = original.planned;
  assert.ok(inputs.testPaths.includes(o.testPath), 'Original selected test differs');
  for (const key of ['helperPaths', 'configPaths'] as const)
    assert.deepEqual([...new Set(inputs[key])].sort(), [...new Set(o[key])].sort(),
      `Original ${key} population differs from requested preparation`);
  assert.deepEqual(inputs.schema, o.schema, 'Original schema differs from requested preparation');
  assert.deepEqual(inputs.environment,
    Object.fromEntries(Object.entries(o.environment).map(([key, value]) => [key, digestBytes(value)])),
    'Original environment differs from requested preparation');
  original.recheck();
  return { ...original.handoff, identity: structuredClone(o.original.identity) };
}

/** Caller-entry barrier: the callback owns every allocation/build/runtime effect.
 * Missing delivery/provider inputs refuse here, before invoking that callback. */
export async function withCommittedReaderOriginalPreparation<T>(contract: CommittedReaderCallerContract | undefined,
  prepare: (original: CommittedReaderPreparationHandoff & { identity: CommittedReaderObservationIdentity }) => Promise<T>): Promise<T> {
  const original = qualifyCommittedReaderCallerContract(contract);
  return prepare(original);
}

/** Consume an independently supplied original cohort. Static archive/build
 * metadata and caller values are preparation inputs, never measurements of
 * invoked config, imports, applied schema or the original worker environment.
 * This facade is read-only and allocates no producer/private runtime. */
export async function produceCommittedReaderOriginalPreparation(o: {
  repositoryRoot: string; workRoot: string; selectedCommit: string; testPath: string;
  helperPaths: string[]; configPaths: string[]; schema: Record<string, string>;
  environment: Record<string, string>;
  original?: { handoff: CommittedReaderPreparationHandoff; identity: CommittedReaderObservationIdentity };
}): Promise<CommittedReaderPreparationHandoff & { identity: CommittedReaderObservationIdentity }> {
  assert.ok(o.original, 'Pinned original preparation handoff is required before producer effects');
  return qualifyCommittedReaderCallerContract({ ...o, original: o.original });
}

/** Fixture consumer of independently pinned records, never a canonical producer
 * or a production admission grant. In particular this does not install the
 * missing HTTP readEvidence dependency. Keep the transaction supplied by the
 * custody caller; recheck originals after the current ledger/host read waits. */
export async function readCommittedReaderLegacyAdoptionFixtureEvidence(
  tx: Parameters<typeof readLegacyAdoptionHistoryAndEffects>[0], payload: LegacyAdoptionPayload,
  retained: {
    original: { handoff: CommittedReaderPreparationHandoff; identity: CommittedReaderObservationIdentity };
    hostObservation: { path: string; sha256: string };
    manifests: Record<keyof LegacyAdoptionPayload['qualification'], { path: string; sha256: string }>;
    terminal: { path: string; sha256: string };
  },
  readCurrent: (tx: Parameters<typeof readLegacyAdoptionHistoryAndEffects>[0], payload: LegacyAdoptionPayload)
    => Promise<Omit<LegacyAdoptionEvidence, 'qualification'>>,
): Promise<LegacyAdoptionEvidence> {
  assert.equal(typeof (tx as unknown as { savepoint?: unknown })?.savepoint, 'function',
    'Fixture evidence requires the custody transaction');
  const selected = structuredClone(retained), request = structuredClone(payload);
  const original = qualifyCommittedReaderOriginalPreparation(selected.original.handoff, selected.original.identity);
  const pins: Array<{ path: string; bytes: Buffer }> = [];
  const readPin = (pin: { path: string; sha256: string }) => {
    assert.ok(pin && typeof pin.path === 'string', 'Retained fixture receipt pin required');
    assert.match(pin.sha256, /^[a-f0-9]{64}$/, 'Retained fixture receipt digest required');
    const bytes = readFileSync(pin.path);
    assert.ok(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024, 'Retained fixture receipt size invalid');
    assert.equal(digestBytes(bytes), pin.sha256, 'Retained fixture receipt changed');
    pins.push({ path: pin.path, bytes });
    return JSON.parse(String(bytes));
  };
  // Consume the actual host observer's retained output separately from the
  // six-dimension cohort. A caller-authored cohort or parent-PG observation
  // cannot fill an unknown/pending leg of this process-bound observation.
  const host = readPin(selected.hostObservation) as ReturnType<typeof observeCommittedReaderLoadedSources>;
  assert.ok(host?.schemaVersion === 'committed-reader-loader-source-v1'
    && host.scope === 'node-loader-returned-source', 'Retained fixture host observation kind differs');
  assert.deepEqual({ sourceCommit: host.sourceCommit, runId: host.runId,
    process: { pid: host.pid, identity: host.kernelProcessIdentity } },
  selected.original.identity, 'Retained fixture host identity differs');
  assert.equal(host.sourceReceiptSha256, selected.original.handoff.sourceReceiptSha256,
    'Retained fixture host source receipt differs');
  assert.ok(host.status === 'bound' && host.exitObserved === true
    && typeof host.processIdentity === 'string' && host.processIdentity.length > 0,
  'Retained fixture host observation incomplete');
  assert.deepEqual(host.gaps, [], 'Retained fixture host observation has gaps');
  assert.deepEqual(host.pending, [], 'Retained fixture host observation pending');
  for (const [key, status, scope] of [
    ['configurationInputs', 'matched', 'native-node-entry-configuration-inputs'],
    ['configurationReads', 'observed', 'javascript-configuration-property-gets'],
    ['privateSchema', 'observed', 'api-worker-information-schema-columns'],
    ['appliedSql', 'observed', 'migration-client-unsafe-query'],
    ['engineExecution', 'observed', 'independently-pinned-bundle-outer-execution'],
    ['resolutions', 'bound', 'native-node-resolver-returned-edges'],
  ] as const) {
    assert.ok(host[key]?.status === status && host[key].scope === scope,
      `Retained fixture host ${key} observation incomplete`);
    assert.deepEqual(host[key].gaps, [], `Retained fixture host ${key} has gaps`);
  }
  assert.ok(host.configurationInputs.snapshot
    && host.configurationInputs.snapshot.fingerprint === host.configurationInputs.expectedFingerprint,
  'Retained fixture host configuration input proof missing');
  assert.ok(host.configurationReads.observation?.captureComplete === true
    && host.configurationReads.observation.activeAtTermination === true,
  'Retained fixture host configuration read proof incomplete');
  assert.deepEqual(host.privateSchema.schema, original.planned.inputs.schema,
    'Retained fixture host schema differs from original');
  assert.ok(Array.isArray(host.appliedSql.attempts) && host.appliedSql.attempts.length > 0
    && host.appliedSql.attempts.some(attempt => attempt.outcome === 'returned'),
  'Retained fixture host applied SQL proof missing');
  for (const hash of [host.configurationReads.receiptSha256, host.privateSchema.receiptSha256,
    host.privateSchema.querySha256, host.engineExecution.sourceTextSha256,
    ...host.appliedSql.attempts.flatMap(attempt => [attempt.rawSource?.sha256, attempt.query?.sha256,
      attempt.plannedReceiptSha256, attempt.terminalReceiptSha256])])
    assert.ok(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
      'Retained fixture host observation proof digest missing');
  assert.ok(host.engineExecution.coverageRangesComplete === true
    && host.engineExecution.coverageRanges?.some(range => range.startOffset === 0
      && range.endOffset === host.engineExecution.sourceTextLength && range.count > 0),
  'Retained fixture host engine execution proof incomplete');
  const read = (pin: { path: string; sha256: string }) => {
    const record = readPin(pin);
    assert.deepEqual({ sourceCommit: record.sourceCommit, runId: record.runId, process: record.process },
      selected.original.identity, 'Retained fixture cohort identity differs');
    assert.equal(record.observationReceiptSha256, selected.original.handoff.observationReceiptSha256,
      'Retained fixture observation receipt differs');
    assert.deepEqual(record.omitted, [], 'Retained fixture observation incomplete');
    assert.deepEqual(record.opaque, [], 'Retained fixture observation opaque');
    assert.deepEqual(record.hostObservationReceipt, selected.hostObservation,
      'Retained fixture host observation receipt differs');
    return record;
  };
  const terminal = read(selected.terminal);
  assert.ok(terminal.state === 'complete' && terminal.exitCode === 0 && terminal.signalCode === null
    && terminal.cleanupComplete === true, 'Retained fixture terminal outcome incomplete or failed');
  assert.notEqual(readProcessIdentity(selected.original.identity.process.pid), selected.original.identity.process.identity,
    'Original fixture worker still alive');
  const keys = ['apiManifestHash', 'launcherManifestHash', 'plannedHostManifestHash',
    'executedInputsHash', 'dependencyManifestHash'] as const;
  assert.deepEqual(Object.keys(selected.manifests).sort(), [...keys].sort(), 'Exact five fixture manifests required');
  const qualification = {} as LegacyAdoptionPayload['qualification'];
  for (const key of keys) {
    const pin = selected.manifests[key], record = read(pin);
    assert.equal(record.qualificationKey, key, 'Retained fixture manifest kind differs');
    assert.equal(record.scope, 'fixture-only', 'Fixture manifest scope required');
    assert.deepEqual(record.terminalReceipt, selected.terminal, 'Retained fixture terminal receipt differs');
    assert.equal(pin.sha256, request.qualification[key], 'Retained fixture qualification digest differs');
    qualification[key] = pin.sha256;
  }
  const recheck = () => {
    original.recheck();
    for (const pin of pins) assert.deepEqual(readFileSync(pin.path), pin.bytes,
      'Retained fixture receipt changed during current evidence read');
  };
  recheck();
  try {
    const current = await readCurrent(tx, request);
    return { ...structuredClone(current), qualification };
  } finally { recheck(); }
}

/** Observe the original exec environment while the selected worker is alive.
 * /proc/environ describes exec-time bytes, not subsequent process.env changes.
 * This closes only that input leg; it cannot qualify invoked configuration,
 * loaded code, schema, or a complete API cohort. The independently selected
 * commit must still be joined to the same worker's source observations. */
export function observeCommittedReaderWorkerEnvironment(expected: CommittedReaderObservationIdentity,
  keys: readonly string[]): CommittedReaderObservationCohort['observations']['environment'] {
  const identity = structuredClone(expected);
  assert.match(identity.sourceCommit, /^[a-f0-9]{40}$/, 'Exact original source selection is required');
  assert.ok(identity.runId && Number.isSafeInteger(identity.process?.pid) && identity.process.pid > 0
    && identity.process.identity, 'Original run/process identity is required');
  assert.ok(keys.length && new Set(keys).size === keys.length
    && keys.every(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)), 'Explicit unique environment keys required');
  const sameProcess = () => assert.equal(readProcessIdentity(identity.process.pid), identity.process.identity,
    'Original worker kernel identity changed or ended');
  sameProcess();
  const bytes = readFileSync(`/proc/${identity.process.pid}/environ`);
  const environment = new Map<string, Buffer>();
  let start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 0) continue;
    const entry = bytes.subarray(start, end); start = end + 1;
    const equals = entry.indexOf(61);
    assert.ok(equals > 0, 'Malformed original exec environment');
    const key = entry.subarray(0, equals).toString('utf8');
    assert.ok(!environment.has(key), 'Ambiguous duplicate original environment key');
    environment.set(key, entry.subarray(equals + 1));
  }
  assert.equal(start, bytes.length, 'Unterminated original exec environment');
  assert.equal(environment.get('PAPERCUSP_TEST_RUN_GROUP')?.toString('utf8'), identity.runId,
    'Original worker environment belongs to another run');
  const value = Object.fromEntries([...keys].sort().map(key => {
    const original = environment.get(key);
    assert.ok(original, `Original worker environment input missing: ${key}`);
    return [key, digestBytes(original)];
  }));
  sameProcess();
  return { ...identity, value };
}

/** Retain this narrow observation independently, then require its original bytes
 * and the same worker's observed exit before returning a terminal join. */
export function retainCommittedReaderWorkerEnvironment(expected: CommittedReaderObservationIdentity,
  keys: readonly string[], receiptPath: string) {
  const identity = structuredClone(expected);
  const observation = observeCommittedReaderWorkerEnvironment(identity, keys);
  const bytes = Buffer.from(JSON.stringify(observation));
  writeFileSync(receiptPath, bytes, { flag: 'wx', mode: 0o600 });
  const recheck = () => assert.deepEqual(readFileSync(receiptPath), bytes,
    'Original worker environment receipt changed');
  return { observation, recheck, terminal: (host: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>) => {
    recheck();
    assert.equal(host.pid, identity.process.pid, 'Terminal worker differs from original observation');
    assert.ok((Number.isSafeInteger(host.exitCode) && host.exitCode !== null
      && host.exitCode >= 0 && host.exitCode <= 255 && host.signalCode === null)
      || (host.exitCode === null && typeof host.signalCode === 'string'
        && Object.hasOwn(osConstants.signals, host.signalCode)), 'Original worker terminal outcome missing or invalid');
    assert.notEqual(readProcessIdentity(identity.process.pid), identity.process.identity,
      'Original worker still alive at terminal join');
    return { ...structuredClone(identity), observationReceipt: { path: receiptPath, sha256: digestBytes(bytes) },
      exitCode: host.exitCode, signalCode: host.signalCode };
  } };
}

/** The digested input receipt stays separate from the producer's output claims. */
function retainedProducedInputs(closure: CommittedReaderClosure, bundle: string) {
  const input = closure.inputReceipt;
  assert.ok(input && input.path === join(dirname(bundle), 'operator-api-inputs.json'),
    'Produced preparation requires its retained independent input receipt');
  assert.match(input.sha256, /^[a-f0-9]{64}$/, 'Produced input receipt digest is required');
  const bytes = readFileSync(input.path);
  assert.equal(digestBytes(bytes), input.sha256, 'Retained independent input receipt changed');
  const inputs: CommittedReaderPreparationInputs = JSON.parse(String(bytes));
  const copies = plannedCopies(inputs);
  for (const key of ['sourceCommit', 'testPaths', 'helperPaths', 'configPaths', 'executedImports',
    'dependencyFiles', 'externalResolutions', 'copiedSources', 'schema', 'environment', 'omitted', 'opaque'] as const)
    assert.deepEqual(closure[key], inputs[key], `Produced input pin differs: ${key}`);
  assert.deepEqual(closure.artifacts.filter(artifact => artifact.sourcePath)
    .map(artifact => [relative(dirname(bundle), artifact.path), artifact.sourcePath]).sort(),
  [...copies.entries()].sort(), 'Produced copied artifact mapping differs from independent inputs');
  return { path: input.path, bytes };
}

/** Qualify the selected committed preparation before creating a sidecar/host.
 * Source files reuse the independent full archive census. Dependencies remain
 * a separate full materialized census, including bytes and symlink identities;
 * a lockfile is never substituted for the files Node will resolve. Unknown
 * executed imports (including an unobserved subprocess graph) must be recorded
 * as opaque and refuse this required closure.
 */
type CommittedReaderSourceOptions = {
  root: string; bundle: string; receiptPath: string; sourceReceiptPath: string;
  selectedCommit: string;
  receiptSha256?: string; sourceReceiptSha256?: string;
} & ({ preparationOnly: true } | {
  preparationOnly?: false; schema: Record<string, string>; environment: NodeJS.ProcessEnv;
});

/** Original compiler inputs can be retained before runtime observations exist.
 * These receipts deliberately cannot enter the qualified consumer path. */
type ObservedPrivateApiBuildInputs = {
  phase: 'build-observation'; sourceCommit: string; dependencyFiles: VerifierSourceFile[];
};
type ObservedPrivateApiBuild = ObservedPrivateApiBuildInputs & {
  path: string; sha256: string; metafileSha256: string;
  inputReceipt: { path: string; sha256: string };
  artifacts: { path: string; sha256: string }[]; artifactCensus: VerifierSourceFile[];
  qualification: { status: 'pending' };
};

function qualifyObservedPrivateApiBuild(o: CommittedReaderSourceOptions) {
  assert.equal(o.preparationOnly, true, 'Build observations never qualify runtime inputs');
  assert.ok(!inside(o.root, o.receiptPath), 'Build receipt must be independent of the source archive');
  const bytes = readFileSync(o.receiptPath), sourceBytes = readFileSync(o.sourceReceiptPath);
  if (o.receiptSha256) assert.equal(digestBytes(bytes), o.receiptSha256, 'Pinned build observation changed');
  if (o.sourceReceiptSha256) assert.equal(digestBytes(sourceBytes), o.sourceReceiptSha256, 'Pinned selected source receipt changed');
  const receipt: ObservedPrivateApiBuild = JSON.parse(String(bytes));
  assert.equal(receipt.phase, 'build-observation', 'Original build observation required');
  assert.deepEqual(receipt.qualification, { status: 'pending' }, 'Build observation cannot qualify preparation');
  assert.equal(receipt.path, o.bundle, 'Observed bundle path differs');
  assert.equal(receipt.sourceCommit, o.selectedCommit, 'Observed selected source differs');
  assert.equal(receipt.inputReceipt.path, join(dirname(o.bundle), 'operator-api-inputs.json'));
  const inputs = readFileSync(receipt.inputReceipt.path);
  assert.equal(digestBytes(inputs), receipt.inputReceipt.sha256, 'Original build inputs changed');
  assert.deepEqual(JSON.parse(String(inputs)), { phase: 'build-observation',
    sourceCommit: o.selectedCommit, dependencyFiles: receipt.dependencyFiles });
  const source = readVerifierSourceReceiptSync(o.root, o.sourceReceiptPath);
  assert.equal(source.sourceCommit, o.selectedCommit, 'Archive differs from observed selected source');
  assert.deepEqual(verifierSourceFiles(join(o.root, 'node_modules'), { symlinkRoot: o.root }), receipt.dependencyFiles,
    'Observed materialized dependency census changed');
  assert.deepEqual(preparedArtifactCensus(dirname(o.bundle), o.root), receipt.artifactCensus, 'Observed artifact census changed');
  assert.ok(receipt.artifactCensus.length && receipt.artifactCensus.every(file => file.kind === 'file'),
    'Observed artifact census requires regular files');
  assert.deepEqual(receipt.artifacts, receipt.artifactCensus.map(file => ({
    path: join(dirname(o.bundle), file.path), sha256: file.sha256 })));
  for (const [path, expected] of [[o.bundle, receipt.sha256], [`${o.bundle}.meta.json`, receipt.metafileSha256]]) {
    assert.match(expected, /^[a-f0-9]{64}$/);
    assert.ok(receipt.artifacts.some(file => file.path === path && file.sha256 === expected), 'Observed artifact pin missing');
    assert.equal(digestBytes(readFileSync(path)), expected, 'Observed artifact changed');
  }
  assert.deepEqual(readFileSync(o.receiptPath), bytes, 'Build receipt changed during observation');
  assert.deepEqual(readFileSync(o.sourceReceiptPath), sourceBytes, 'Source receipt changed during observation');
  assert.deepEqual(readFileSync(receipt.inputReceipt.path), inputs, 'Build inputs changed during observation');
  return { sourceCommit: source.sourceCommit };
}

export function qualifyCommittedReaderSource(o: CommittedReaderSourceOptions) {
  return qualifyCommittedReaderArtifacts(o);
}

/** Bind only the existing loader's returned bytes to independent preparation
 * pins. This never qualifies evaluation, descendants, config, PG or sidecars.
 * Missing/limited observations stay unknown; disk bytes cannot fill a load gap.
 */
export function observeCommittedReaderLoadedSources(o: CommittedReaderSourceOptions & {
  traceOut: string; pid: number; startedAtMs: number; finishedAtMs: number;
  kernelProcessIdentity?: string; runId?: string; buildObservationOnly?: boolean;
  configuration?: ConfigurationSnapshot;
}) {
  const closureBytes = readFileSync(o.receiptPath), sourceBytes = readFileSync(o.sourceReceiptPath);
  const preparation = (o.buildObservationOnly ? qualifyObservedPrivateApiBuild : qualifyCommittedReaderSource)({ ...o,
    receiptSha256: o.receiptSha256 ?? digestBytes(closureBytes),
    sourceReceiptSha256: o.sourceReceiptSha256 ?? digestBytes(sourceBytes) });
  const sources: Array<{ url: string; loadId: number; sha256: string; byteLength: number; ref: string }> = [];
  const gaps: string[] = [];
  const result = {
    schemaVersion: 'committed-reader-loader-source-v1', scope: 'node-loader-returned-source',
    status: 'unknown' as 'bound' | 'unknown', sourceCommit: preparation.sourceCommit,
    preparationSha256: digestBytes(closureBytes),
    sourceReceiptSha256: digestBytes(sourceBytes),
    traceOut: o.traceOut, pid: o.pid, runId: null as string | null, processIdentity: null as string | null,
    kernelProcessIdentity: null as string | null,
    startedAtMs: o.startedAtMs, finishedAtMs: o.finishedAtMs,
    population: null as ReturnType<typeof readNativeProcessTraceArtifacts>['population'] | null,
    entrySha256: null as string | null, exitObserved: false,
    engineExecution: { scope: 'independently-pinned-bundle-outer-execution',
      status: 'unknown' as 'observed' | 'unknown', scriptId: null as string | null,
      sourceTextSha256: null as string | null, sourceTextLength: null as number | null,
      coverageRangesComplete: false,
      coverageRanges: [] as Array<{ functionName: string; startOffset: number; endOffset: number; count: number }>,
      gaps: [] as string[] },
    configurationInputs: {
      scope: 'native-node-entry-configuration-inputs', status: 'unknown' as 'matched' | 'unknown',
      snapshot: null as ConfigurationSnapshot | null,
      expectedFingerprint: o.configuration?.fingerprint ?? null,
      gaps: ['host entry not validated'],
    },
    configurationReads: {
      scope: 'javascript-configuration-property-gets', status: 'unknown' as 'observed' | 'unknown',
      observation: null as ConfigurationReadObservation | null,
      receiptSha256: null as string | null, gaps: ['host entry not validated'],
    },
    privateSchema: {
      scope: 'api-worker-information-schema-columns', status: 'unknown' as 'observed' | 'unknown',
      schema: null as Record<string, string> | null, backendPid: null as number | null,
      querySha256: null as string | null, receiptSha256: null as string | null,
      gaps: ['host entry not validated'],
    },
    appliedSql: {
      scope: 'migration-client-unsafe-query', status: 'unknown' as 'observed' | 'unknown',
      attempts: [] as Array<{ attemptId: string; file: string; migrationPath: string;
        chunkIndex: number; chunkCount: number; attempt: number; outcome: 'returned' | 'failed';
        rawSource: { ref: string; sha256: string; byteLength: number };
        query: { ref: string; sha256: string; byteLength: number };
        plannedReceiptSha256: string; terminalReceiptSha256: string }>,
      gaps: ['host entry not validated'],
    },
    resolutions: {
      scope: 'native-node-resolver-returned-edges', status: 'unknown' as 'bound' | 'unknown',
      edges: [] as Array<{ resolveId: number; specifier: string; parentURL: string | null;
        conditions: string[]; url: string; format: string | null }>, gaps: [] as string[],
    },
    limits: { loads: 128, ...nativeSourceRetentionLimits },
    sources, gaps, pending: [...(o.buildObservationOnly ? ['preparation-qualification', 'build-imports', 'observed-imports'] : []),
      'module-evaluation', 'runtime-config', 'private-pg', 'sidecars',
      'descendant-imports', 'complete-runtime-closure'],
  };
  try {
    assert.ok(Number.isSafeInteger(o.pid) && o.pid > 0 && Number.isSafeInteger(o.startedAtMs)
      && Number.isSafeInteger(o.finishedAtMs) && o.startedAtMs <= o.finishedAtMs, 'invalid observation window');
    const trace = readNativeProcessTraceArtifacts(o.traceOut, o.startedAtMs, o.finishedAtMs);
    result.population = trace.population;
    assert.ok(trace.population.complete, 'native trace population incomplete');
    const own = trace.rows.filter(({ row }) => row.pid === o.pid);
    const entries = own.filter(({ row }) => row.event === 'node-entry');
    assert.equal(entries.length, 1, 'one host entry required');
    const entry = entries[0];
    if (o.runId !== undefined) {
      assert.ok(o.runId.length > 0, 'independent host run identity required');
      assert.equal(entry.row.runGroupId, o.runId, 'host entry belongs to another run');
      result.runId = o.runId;
    }
    const identity = entry.row.processIdentity;
    assert.ok(identity && own.every(({ row }) => row.processIdentity === identity), 'mixed host trace identities');
    const kernelIdentity = entry.row.kernelProcessIdentity;
    assert.ok(typeof kernelIdentity === 'string' && kernelIdentity.length > 0, 'host kernel process identity missing');
    assert.ok(own.every(({ row }) => row.kernelProcessIdentity === kernelIdentity), 'mixed host kernel process identities');
    if (o.kernelProcessIdentity) assert.equal(kernelIdentity, o.kernelProcessIdentity, 'host kernel process identity changed');
    assert.equal(entry.row.cwd, realpathSync(o.root), 'host trace cwd differs');
    assert.equal(entry.row.executable, process.execPath, 'host trace executable differs');
    assert.equal(entry.row.argv?.[1], o.bundle, 'host trace bundle argv differs');
    assert.equal(entry.row.reporterOut, o.traceOut, 'host trace channel differs');
    assert.ok(own.every(({ row }) => row.atMs >= entry.row.atMs), 'host event predates entry');
    result.processIdentity = identity;
    result.kernelProcessIdentity = kernelIdentity;
    result.entrySha256 = digestBytes(entry.bytes);
    result.exitObserved = own.some(({ row }) => row.event === 'node-exit' && row.exitListenersComplete === true);
    // Bind only the authenticated host entry. Parent launch values, a source
    // archive or a later process.env read cannot fill a missing observation.
    result.configurationInputs.gaps.length = 0;
    try {
      const actual = readConfigurationSnapshot(entry.row.configuration);
      assert.ok(actual, 'host entry configuration snapshot missing or invalid');
      result.configurationInputs.snapshot = actual;
      const expected = readConfigurationSnapshot(o.configuration);
      assert.ok(expected, 'independent prelaunch configuration snapshot missing or invalid');
      assert.deepEqual(actual, expected, 'host entry configuration inputs differ');
      result.configurationInputs.status = 'matched';
    } catch (error) { result.configurationInputs.gaps.push((error as Error).message.split('\n')[0]); }
    // A catalogue observation establishes only its observed columns. Applied
    // migration SQL, database lifetime/cleanup and full private-PG stay pending.
    result.privateSchema.gaps.length = 0;
    try {
      assert.ok(result.runId, 'independent host run identity required for schema');
      const exits = own.filter(({ row }) => row.event === 'node-exit');
      assert.ok(exits.length === 1 && exits[0].row.exitListenersComplete === true,
        'host schema terminal observation missing or incomplete');
      assert.ok(!own.some(({ row }) => ['trace-limit', 'trace-event-too-large',
        'api-worker-schema-unavailable'].includes(row.event)), 'host schema capture incomplete');
      const receipts = own.filter(({ row }) => row.event === 'api-worker-schema');
      assert.equal(receipts.length, 1, 'one host schema receipt required');
      const receipt = receipts[0], row = receipt.row, pin = row.artifact;
      assert.equal(row.runGroupId, result.runId, 'host schema receipt belongs to another run');
      assert.ok(row.threadId === entry.row.threadId && row.atMs <= exits[0].row.atMs,
        'host schema receipt isolate or terminal order differs');
      assert.equal(row.scope, result.privateSchema.scope, 'host schema observation scope differs');
      assert.ok(Number.isSafeInteger(row.backendPid) && row.backendPid > 0
        && typeof row.querySha256 === 'string' && /^[a-f0-9]{64}$/.test(row.querySha256),
        'host schema query identity missing');
      assert.ok(pin && /^[a-f0-9]{64}$/.test(pin.sha256) && pin.ref === `${pin.sha256}.schema`
        && Number.isSafeInteger(pin.byteLength) && pin.byteLength > 0 && pin.byteLength <= 8 * 1024 * 1024,
        'host schema artifact missing or limited');
      const bytes = readNativeArtifactBytes(join(trace.sourceRoot, pin.ref), pin.byteLength, 8 * 1024 * 1024);
      assert.equal(digestBytes(bytes), pin.sha256, 'retained host schema digest differs');
      const schema = JSON.parse(bytes.toString('utf8'));
      assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema)
        && Number.isSafeInteger(row.columns) && row.columns > 0 && row.columns <= 32768
        && Object.keys(schema).length === row.columns && Object.entries(schema).every(([key, value]) =>
          key.startsWith('harness_shared.') && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)),
        'host schema catalogue invalid or limited');
      // Build-only receipts intentionally have no prepared schema. Retain the
      // actual worker catalogue as an original observation, while keeping its
      // preparation/private-PG qualification pending. The qualified path still
      // requires independent prepared bytes and exact agreement.
      if (!o.buildObservationOnly) {
        const expectedSchema = (JSON.parse(closureBytes.toString('utf8')) as Partial<CommittedReaderClosure>).schema;
        assert.ok(expectedSchema && Object.keys(expectedSchema).length, 'independent prepared schema missing');
        assert.deepEqual(schema, expectedSchema, 'actual API worker schema differs from preparation');
      }
      result.privateSchema.schema = schema;
      result.privateSchema.backendPid = row.backendPid;
      result.privateSchema.querySha256 = row.querySha256;
      result.privateSchema.receiptSha256 = digestBytes(receipt.bytes);
      result.privateSchema.status = 'observed';
    } catch (error) { result.privateSchema.gaps.push((error as Error).message.split('\n')[0]); }
    // This is a bounded record of actual JS property gets, not resolved config
    // or a full configuration population. Keep runtime-config pending.
    result.configurationReads.gaps.length = 0;
    try {
      assert.ok(result.runId, 'independent host run identity required for configuration reads');
      const exits = own.filter(({ row }) => row.event === 'node-exit');
      assert.ok(exits.length === 1 && exits[0].row.exitListenersComplete === true,
        'host configuration read terminal observation missing or incomplete');
      assert.ok(!own.some(({ row }) => ['trace-limit', 'trace-event-too-large',
        'configuration-reads-unavailable'].includes(row.event)), 'host configuration read capture incomplete');
      const receipts = own.filter(({ row }) => row.event === 'configuration-reads');
      assert.equal(receipts.length, 1, 'one host configuration read receipt required');
      const receipt = receipts[0];
      assert.equal(receipt.row.runGroupId, result.runId, 'host configuration read receipt belongs to another run');
      const exitStarts = own.filter(({ row }) => row.event === 'node-exit-start');
      assert.ok(exitStarts.length === 1 && exitStarts[0].row.threadId === entry.row.threadId
        && exits[0].row.threadId === entry.row.threadId
        && receipt.row.threadId === entry.row.threadId
        && exitStarts[0].row.atMs <= receipt.row.atMs && receipt.row.atMs <= exits[0].row.atMs,
        'host configuration read receipt isolate or terminal order differs');
      const observation = readConfigurationReadObservation(receipt.row.observation);
      assert.ok(observation, 'host configuration read observation missing or invalid');
      assert.ok(observation.captureComplete && observation.activeAtTermination,
        'host configuration read capture limited or replaced');
      result.configurationReads.observation = observation;
      result.configurationReads.receiptSha256 = digestBytes(receipt.bytes);
      result.configurationReads.status = 'observed';
    } catch (error) { result.configurationReads.gaps.push((error as Error).message.split('\n')[0]); }
    const source = JSON.parse(sourceBytes.toString('utf8'));
    const closure: CommittedReaderClosure = JSON.parse(closureBytes.toString('utf8'));
    const pins = new Map<string, string>();
    const pin = (path: string, sha256: string) => {
      const key = resolve(path), previous = pins.get(key);
      assert.ok(!previous || previous === sha256, 'conflicting independent source pins');
      pins.set(key, sha256);
    };
    for (const file of source.files as VerifierSourceFile[])
      if (file.kind === 'file') pin(join(o.root, file.path), file.sha256);
    for (const file of closure.dependencyFiles)
      if (file.kind === 'file') pin(join(o.root, 'node_modules', file.path), file.sha256);
    for (const artifact of closure.artifacts) pin(artifact.path, artifact.sha256);
    // Bind the actual SQL call boundary, including failed retries. A catalogue
    // or migration ledger alone cannot supply these original query bytes.
    result.appliedSql.gaps.length = 0;
    try {
      assert.ok(result.runId, 'independent host run identity required for SQL');
      const exits = own.filter(({ row }) => row.event === 'node-exit');
      assert.ok(exits.length === 1 && exits[0].row.exitListenersComplete === true && exits[0].row.code === 0,
        'host SQL terminal observation missing or incomplete');
      assert.ok(!own.some(({ row }) => ['trace-limit', 'trace-event-too-large',
        'migration-transaction-unavailable'].includes(row.event)), 'host SQL capture incomplete');
      const receipts = own.filter(({ row }) => row.event === 'migration-transaction')
        .sort((a, b) => a.row.sequence - b.row.sequence);
      assert.ok(receipts.length > 0 && receipts.length <= 512, 'host SQL receipts missing or limited');
      const planned = new Map<string, typeof receipts[number]>(), ended = new Set<string>();
      const files = new Map<string, { sha256: string; chunks: number; nextChunk: number; nextAttempt: number }>();
      let sequence = 0, bytesRead = 0;
      for (const receipt of receipts) {
        const row = receipt.row;
        assert.equal(row.sequence, ++sequence, 'host SQL sequence missing or duplicated');
        assert.equal(row.runGroupId, result.runId, 'host SQL receipt belongs to another run');
        assert.ok(row.threadId === entry.row.threadId && row.atMs <= exits[0].row.atMs,
          'host SQL receipt isolate or terminal order differs');
        assert.equal(row.scope, result.appliedSql.scope, 'host SQL scope differs');
        assert.ok(typeof row.attemptId === 'string' && /^[a-f0-9-]{36}$/.test(row.attemptId)
          && ['planned', 'returned', 'failed'].includes(row.phase)
          && typeof row.file === 'string' && row.file.endsWith('.sql')
          && typeof row.migrationPath === 'string' && isAbsolute(row.migrationPath)
          && basename(row.migrationPath) === row.file
          && Number.isSafeInteger(row.chunkIndex) && row.chunkIndex >= 0
          && Number.isSafeInteger(row.chunkCount) && row.chunkCount > row.chunkIndex && row.chunkCount <= 256
          && Number.isSafeInteger(row.attempt) && row.attempt >= 1 && row.attempt <= 256
          && row.isFinalChunk === (row.chunkIndex === row.chunkCount - 1), 'host SQL attempt identity invalid');
        for (const artifact of [row.rawSource, row.query]) {
          assert.ok(artifact && /^[a-f0-9]{64}$/.test(artifact.sha256)
            && artifact.ref === `${artifact.sha256}.source` && Number.isSafeInteger(artifact.byteLength)
            && artifact.byteLength > 0 && artifact.byteLength <= 8 * 1024 * 1024,
            'host SQL artifact missing or limited');
          assert.ok(bytesRead + artifact.byteLength <= 64 * 1024 * 1024, 'host SQL total byte limit');
          const bytes = readNativeArtifactBytes(join(trace.sourceRoot, artifact.ref), artifact.byteLength,
            8 * 1024 * 1024);
          bytesRead += bytes.length;
          assert.equal(digestBytes(bytes), artifact.sha256, 'retained host SQL digest differs');
        }
        assert.equal(pins.get(resolve(row.migrationPath)), row.rawSource.sha256,
          'host SQL raw source lacks matching independent pin');
        if (row.phase === 'planned') {
          assert.ok(!planned.has(row.attemptId), 'duplicate host SQL planned attempt');
          const state = files.get(row.migrationPath) ?? { sha256: row.rawSource.sha256,
            chunks: row.chunkCount, nextChunk: 0, nextAttempt: 1 };
          assert.ok(state.sha256 === row.rawSource.sha256 && state.chunks === row.chunkCount
            && state.nextChunk === row.chunkIndex && state.nextAttempt === row.attempt,
            'host SQL chunk or retry sequence incomplete');
          assert.ok([...planned.keys()].every(id => ended.has(id)), 'overlapping host SQL attempts');
          files.set(row.migrationPath, state);
          planned.set(row.attemptId, receipt);
        } else {
          const start = planned.get(row.attemptId);
          assert.ok(start && !ended.has(row.attemptId) && start.row.atMs <= row.atMs,
            'unmatched or duplicate host SQL terminal attempt');
          for (const key of ['file', 'migrationPath', 'chunkIndex', 'chunkCount', 'attempt',
            'isFinalChunk', 'rawSource', 'query'])
            assert.deepEqual(row[key], start.row[key], 'host SQL planned and terminal inputs differ');
          ended.add(row.attemptId);
          const state = files.get(row.migrationPath)!;
          if (row.phase === 'returned') { state.nextChunk++; state.nextAttempt = 1; }
          else state.nextAttempt++;
          result.appliedSql.attempts.push({ attemptId: row.attemptId, file: row.file,
            migrationPath: row.migrationPath, chunkIndex: row.chunkIndex, chunkCount: row.chunkCount,
            attempt: row.attempt, outcome: row.phase, rawSource: row.rawSource, query: row.query,
            plannedReceiptSha256: digestBytes(start.bytes), terminalReceiptSha256: digestBytes(receipt.bytes) });
        }
      }
      assert.equal(ended.size, planned.size, 'host SQL planned attempt has no terminal receipt');
      assert.ok([...files.values()].every(state => state.nextChunk === state.chunks),
        'host SQL migration has failed or missing chunks');
      result.appliedSql.status = 'observed';
    } catch (error) { result.appliedSql.gaps.push((error as Error).message.split('\n')[0]); }
    const starts = new Map<number, { url: string; atMs: number }>(), returned = new Set<number>();
    let bytesRead = 0, pinnedBytesRead = 0;
    const pinnedPaths = new Set<string>();
    for (const { row } of own) {
      if (['trace-limit', 'trace-event-too-large', 'module-load-limit', 'module-load-unavailable',
        'module-load-error', 'module-source-pins-invalid'].includes(row.event)) gaps.push(row.event);
      if (row.event !== 'module-load-start') continue;
      assert.ok(Number.isSafeInteger(row.loadId) && row.loadId > 0 && row.loadId <= result.limits.loads
        && !starts.has(row.loadId) && typeof row.url === 'string', 'invalid or duplicate load start');
      starts.set(row.loadId, { url: row.url, atMs: row.atMs });
    }
    for (const { row } of own) {
      if (row.event !== 'module-load-return') continue;
      try {
        const start = starts.get(row.loadId);
        assert.ok(start && start.url === row.url && start.atMs <= row.atMs && !returned.has(row.loadId),
          'unmatched or duplicate loader return');
        returned.add(row.loadId);
        const source = row.source;
        assert.ok(source?.status === 'hashed' && source.scope === result.scope && !source.artifactUnavailable
          && /^[a-f0-9]{64}$/.test(source.sha256) && source.ref === `${source.sha256}.source`
          && Number.isSafeInteger(source.byteLength) && source.byteLength >= 0,
          'loader source unavailable or limited');
        const url = new URL(row.url);
        assert.ok(url.protocol === 'file:' && !url.search && !url.hash, 'unsupported loader source URL');
        const expected = pins.get(fileURLToPath(url));
        assert.ok(expected, 'loaded source lacks independent pin');
        assert.equal(source.sha256, expected, 'returned loader bytes differ from independent pin');
        const pinned = source.byteLength > result.limits.sourceBytes;
        assert.ok(!pinned || source.admission === 'independently-pinned-large-source-v1' &&
          source.byteLength <= result.limits.pinnedSourceBytes, 'loader source unavailable or limited');
        if (pinned) {
          pinnedPaths.add(row.url);
          assert.ok(pinnedPaths.size <= result.limits.pins, 'pinned loader source population limit');
        }
        const retainedHash = hashNativeArtifactBytes(join(trace.sourceRoot, source.ref), source.byteLength,
          pinned ? result.limits.pinnedProcessBytes - pinnedBytesRead : result.limits.processBytes - bytesRead,
          count => { if (pinned) pinnedBytesRead += count; else bytesRead += count; });
        assert.equal(retainedHash, source.sha256, 'retained loader source digest differs');
        sources.push({ url: row.url, loadId: row.loadId, sha256: source.sha256,
          byteLength: source.byteLength, ref: source.ref });
      } catch (error) { gaps.push((error as Error).message.split('\n')[0]); }
    }
    if (!starts.size) gaps.push('host loader observations missing');
    if (starts.size !== returned.size) gaps.push('pending loader calls');
    if (!sources.some(source => source.url === pathToFileURL(o.bundle).href)) gaps.push('loaded bundle unbound');
    // Resolver edges have their own verdict: no claim about module evaluation,
    // dependency-generation custody or descendants follows from these returns.
    try {
      assert.ok(result.exitObserved, 'host resolver terminal observation missing');
      assert.ok(!own.some(({ row }) => ['trace-limit', 'trace-event-too-large',
        'module-resolve-limit', 'module-resolve-error'].includes(row.event)), 'host resolver capture incomplete');
      const attempts = own.filter(({ row }) => row.event === 'module-resolve-start');
      const returns = own.filter(({ row }) => row.event === 'module-resolve-return');
      assert.ok(attempts.length > 0 && attempts.length <= 128, 'host resolver observations missing or limited');
      assert.equal(returns.length, attempts.length, 'pending host resolver calls');
      const seen = new Set<number>();
      for (const { row } of attempts) {
        assert.ok(Number.isSafeInteger(row.resolveId) && row.resolveId > 0 && row.resolveId <= 128 &&
          !seen.has(row.resolveId) && typeof row.specifier === 'string' && row.specifier.length > 0 &&
          (row.parentURL === null || typeof row.parentURL === 'string') &&
          Array.isArray(row.conditions) && row.conditions.every((value: unknown) => typeof value === 'string') &&
          row.scope === 'node-sync-resolve-hook' && row.threadId === entry.row.threadId,
        'host resolver attempt invalid or isolate differs');
        seen.add(row.resolveId);
        const matched = returns.filter(({ row: returned }) => returned.resolveId === row.resolveId);
        assert.equal(matched.length, 1, 'host resolver return missing or duplicated');
        const returned = matched[0].row;
        for (const key of ['specifier', 'parentURL', 'conditions', 'scope', 'threadId'])
          assert.deepEqual(returned[key], row[key], 'host resolver edge identity differs');
        assert.ok(returned.atMs >= row.atMs && typeof returned.url === 'string' &&
          (returned.format === null || typeof returned.format === 'string'), 'host resolver return invalid');
        const url = new URL(returned.url);
        assert.ok(url.protocol === 'node:' || url.protocol === 'file:' && !url.search && !url.hash,
          'host resolver URL opaque');
        if (url.protocol === 'file:') {
          const loaded = sources.filter(source => source.url === returned.url);
          assert.ok(loaded.length > 0,
            `host resolved file lacks independently pinned loader bytes: ${returned.url}`);
          // Build observations have no planned resolver map; their returned
          // edges still require the independently pinned loader bytes above.
          if (!o.buildObservationOnly && Object.hasOwn(closure.externalResolutions, row.specifier))
            assert.equal(fileURLToPath(url), resolve(o.root, closure.externalResolutions[row.specifier]),
              'host external resolution differs from independent pin');
        }
        result.resolutions.edges.push({ resolveId: row.resolveId, specifier: row.specifier,
          parentURL: row.parentURL, conditions: [...row.conditions], url: returned.url, format: returned.format });
      }
      assert.ok(!gaps.length, 'host loader evidence incomplete');
      result.resolutions.status = 'bound';
    } catch (error) { result.resolutions.gaps.push((error as Error).message.split('\n')[0]); }
    // Positive outer execution is narrower than module/import closure. Consume
    // the engine's script-id/source/range tuple only inside this process-bound
    // channel; a loader return or source-map association cannot substitute.
    try {
      const events = own.filter(({ row }) => row.event === 'engine-script-execution');
      assert.equal(events.length, 1, 'one host engine execution snapshot required');
      assert.equal(events[0].row.threadId, entry.row.threadId, 'host engine isolate differs');
      const observation = events[0].row.observation;
      assert.ok(observation?.schemaVersion === 'node-engine-script-observations-v1' &&
        observation.basis === 'v8-script-id-source-and-best-effort-coverage' &&
        observation.scope === 'observed-independently-pinned-engine-scripts' &&
        observation.sourceEncoding === 'utf8-of-engine-source-text' &&
        observation.offsetUnits === 'utf16-code-units' && observation.populationStatus === 'unknown',
      'unsupported host engine observation');
      assert.ok(Array.isArray(observation.reasons) && observation.reasons.every(
        (reason: unknown) => reason === 'engine-execution-range-limit'), 'host engine observation incomplete');
      assert.ok(Array.isArray(observation.scripts) && observation.scripts.length <= result.limits.pins &&
        new Set(observation.scripts.map((script: { scriptId: string }) => script.scriptId)).size === observation.scripts.length,
      'host engine script population invalid');
      const matches = observation.scripts.filter((script: { url: string }) => script.url === pathToFileURL(o.bundle).href);
      assert.equal(matches.length, 1, 'one pinned bundle engine script required');
      const script = matches[0], loaded = sources.find(source => source.url === script.url);
      assert.ok(loaded && script.path === o.bundle && typeof script.scriptId === 'string' && script.scriptId.length > 0 &&
        script.sourceTextSha256 === loaded.sha256 && loaded.sha256 === closure.sha256 &&
        Number.isSafeInteger(script.sourceTextLength) && script.sourceTextLength > 0 &&
        script.sourceTextLength <= loaded.byteLength, 'bundle engine text differs from independent loader pin');
      assert.deepEqual(script.independentPin, { path: o.bundle, sha256: closure.sha256, byteLength: loaded.byteLength },
        'bundle engine independent pin differs');
      assert.ok(typeof script.coverageRangesComplete === 'boolean' &&
        Array.isArray(script.coverageRanges) && script.coverageRanges.length <= 128 &&
        script.coverageRanges.every((range: { functionName: string; startOffset: number; endOffset: number; count: number }) =>
          typeof range.functionName === 'string' && Number.isSafeInteger(range.count) && range.count >= 0 &&
          Number.isSafeInteger(range.startOffset) && Number.isSafeInteger(range.endOffset) &&
          range.startOffset >= 0 && range.endOffset > range.startOffset && range.endOffset <= script.sourceTextLength),
      'bundle engine ranges invalid');
      assert.ok(script.execution === 'observed' && script.coverageRanges.some(
        (range: { startOffset: number; endOffset: number; count: number }) =>
          range.startOffset === 0 && range.endOffset === script.sourceTextLength && range.count > 0),
      'bundle outer execution not observed');
      Object.assign(result.engineExecution, { status: 'observed', scriptId: script.scriptId,
        sourceTextSha256: script.sourceTextSha256, sourceTextLength: script.sourceTextLength,
        coverageRanges: script.coverageRanges, coverageRangesComplete: script.coverageRangesComplete });
    } catch (error) { result.engineExecution.gaps.push((error as Error).message.split('\n')[0]); }
    assert.deepEqual(readFileSync(o.receiptPath), closureBytes, 'preparation receipt changed during observation');
    assert.deepEqual(readFileSync(o.sourceReceiptPath), sourceBytes, 'source receipt changed during observation');
    if (!gaps.length) result.status = 'bound';
  } catch (error) { gaps.push((error as Error).message.split('\n')[0]); }
  return result;
}

/** Only the producer can validate an intermediate receipt; public consumers
 * require the completed preparation status before allocating any runtime. */
function qualifyCommittedReaderArtifacts(o: CommittedReaderSourceOptions, producing = false) {
  const digest = digestBytes;
  assert.match(o.selectedCommit, /^[a-f0-9]{40}$/, 'Exact selected committed source is required');
  assert.ok(!inside(o.root, o.receiptPath), 'Closure receipt must be independent of the source archive');
  const closureBytes = readFileSync(o.receiptPath);
  if (o.receiptSha256) assert.equal(digest(closureBytes), o.receiptSha256, 'Pinned preparation receipt changed');
  const closure: CommittedReaderClosure = JSON.parse(String(closureBytes));
  assertCommittedReaderClosure(closure);
  let retainedInputs: ReturnType<typeof retainedProducedInputs> | undefined;
  if (closure.phase === 'produced') {
    if (!producing) assert.equal(closure.qualification?.status, 'preparation-qualified',
      'Partial produced preparation is not qualified for consumption');
    retainedInputs = retainedProducedInputs(closure, o.bundle);
  }
  assert.equal(closure.sourceCommit, o.selectedCommit, 'Closure differs from selected committed source');
  const assertSourceReceiptUnchanged = () => {
    if (o.sourceReceiptSha256) assert.equal(digest(readFileSync(o.sourceReceiptPath)), o.sourceReceiptSha256,
      'Pinned selected source receipt changed');
  };
  assertSourceReceiptUnchanged();
  const { source, sourcePath, dependencies } = qualifyCommittedReaderInputs(o.root, o.sourceReceiptPath,
    o.selectedCommit, closure);
  assertSourceReceiptUnchanged();
  const dependencyFiles = new Set(dependencies.map(file => `node_modules/${file.path}`));
  const graphBytes = readFileSync(`${o.bundle}.meta.json`);
  assert.equal(digest(graphBytes), closure.metafileSha256, 'Prepared build graph changed');
  const graph = JSON.parse(String(graphBytes));
  assert.ok(graph.inputs && Object.keys(graph.inputs).length && graph.outputs && Object.keys(graph.outputs).length,
    'Complete prepared build graph is required');
  const externals = new Set<string>();
  const graphImports = new Set<string>();
  const graphPath = (path: string) => {
    assert.ok(!isAbsolute(path) && !path.split('/').includes('..'), `Build input escapes selected root: ${path}`);
    if (path.startsWith('node_modules/')) assert.ok(dependencyFiles.has(path), `Unpinned dependency input: ${path}`);
    else { sourcePath(path); graphImports.add(path); }
  };
  for (const [path, input] of Object.entries(graph.inputs) as [string, { imports?: { path: string; external?: boolean }[] }][]) {
    graphPath(path);
    assert.ok(Array.isArray(input.imports), `Build imports are unknown: ${path}`);
    for (const edge of input.imports!) {
      if (edge.external) { if (!isBuiltin(edge.path)) externals.add(edge.path); }
      else graphPath(edge.path);
    }
  }
  for (const output of Object.values(graph.outputs) as { imports?: { path: string; external?: boolean }[] }[]) {
    assert.ok(Array.isArray(output.imports), 'Build output imports are unknown');
    for (const edge of output.imports!) if (edge.external && !isBuiltin(edge.path)) externals.add(edge.path);
  }
  for (const path of graphImports)
    assert.ok(closure.executedImports.includes(path), `Build source is absent from observed import closure: ${path}`);
  assert.deepEqual(Object.keys(closure.externalResolutions).sort(), [...externals].sort(), 'External resolution census differs');
  const fromBundle = createRequire(o.bundle);
  for (const specifier of externals) {
    const actual = realpathSync(fromBundle.resolve(specifier));
    const expected = closure.externalResolutions[specifier];
    assert.ok(dependencyFiles.has(expected), `External lacks dependency pin: ${specifier}`);
    assert.equal(actual, realpathSync(join(o.root, expected)), `External resolution differs: ${specifier}`);
  }
  const artifactPaths = new Set<string>();
  for (const artifact of closure.artifacts) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/, 'Artifact digest is required');
    assert.ok(!artifactPaths.has(artifact.path), 'Duplicate artifact pin');
    artifactPaths.add(artifact.path);
    assert.ok(isAbsolute(artifact.path) && inside(dirname(o.bundle), artifact.path), 'Artifact escapes private preparation');
    assert.equal(digest(readFileSync(artifact.path)), artifact.sha256, `Prepared artifact changed: ${artifact.path}`);
  }
  assert.ok(artifactPaths.has(o.bundle) && artifactPaths.has(`${o.bundle}.meta.json`), 'Bundle and graph artifact pins are required');
  if (closure.phase === 'produced') {
    assert.ok(Array.isArray(closure.artifactCensus) && closure.artifactCensus.length,
      'Produced artifact census is required');
    assert.ok(closure.artifactCensus.every(file => file.kind === 'file'),
      'Produced symlink artifacts require independent qualification');
    assert.deepEqual(preparedArtifactCensus(dirname(o.bundle), o.root), closure.artifactCensus,
      'Produced artifact census changed');
    assert.deepEqual([...artifactPaths].sort(), closure.artifactCensus.map(file => join(dirname(o.bundle), file.path)).sort(),
      'Produced artifact census lacks digest pins');
  }
  for (const path of closure.copiedSources) {
    const copies = closure.artifacts.filter(artifact => artifact.sourcePath === path);
    assert.ok(copies.length, `Copied source lacks retained artifact mapping: ${path}`);
    for (const copy of copies)
      assert.equal(copy.sha256, digest(readFileSync(join(o.root, path))), `Copied artifact differs from selected source: ${path}`);
  }
  assert.equal(digest(readFileSync(o.bundle)), closure.sha256, 'Prepared bundle changed');
  for (const [key, expected] of Object.entries(closure.environment)) {
    if (!o.preparationOnly) {
      assert.ok(o.environment[key] !== undefined, `Required private environment missing: ${key}`);
      assert.equal(digest(o.environment[key]!), expected, `Required private environment differs: ${key}`);
    }
  }
  if (!o.preparationOnly) assert.deepEqual(o.schema, closure.schema, 'Applied required private schema differs');
  if (retainedInputs) assert.deepEqual(readFileSync(retainedInputs.path), retainedInputs.bytes,
    'Retained independent input receipt changed during qualification');
  return { status: 'preparation-qualified' as const,
    sourceCommit: source.sourceCommit, sha256: closure.sha256, metafileSha256: closure.metafileSha256,
    checked: ['source', 'tested-inputs', 'build-imports', 'observed-imports', 'dependencies', 'externals',
      'config', 'copied-sources', 'artifacts',
      ...(!o.preparationOnly ? ['required-private-schema', 'required-environment'] : [])],
    pending: o.preparationOnly ? ['actual-private-schema', 'actual-private-environment', 'loaded-host'] : ['loaded-host'],
    omitted: closure.omitted, opaque: closure.opaque, hostStarted: false, httpStarted: false };
}

/** Complete, typed private Health seed; nullable data remains per-panel typed. */
export function createPrivateHealthSnapshot(workspaceId: string, foreign: boolean, evaluatedAt: number): SystemHealth {
  const panel = <K extends PanelKey>(key: K): SystemHealth['panels'][K] => ({ key, label: PANEL_LABELS[key],
    status: key === 'workItems' || key === 'plans' ? 'warn' : 'unknown',
    summary: foreign ? 'private-health-foreign' : key === 'workItems' ? 'private-health-selected'
      : key === 'plans' ? 'private-health-neighbor' : 'private-health-unmeasured',
    metrics: [], data: null,
    ...(key === 'workItems' ? { link: { label: 'Work', href: '/adv?tab=harnesses' } } : {}),
  });
  return { workspaceId, evaluatedAt, overall: 'warn', crossMonitor: { queenAlive: true, overwatchAlive: null }, panels: {
    queen: panel('queen'), bees: panel('bees'), workItems: panel('workItems'), workFeed: panel('workFeed'),
    loops: panel('loops'), tokens: panel('tokens'), watchdog: panel('watchdog'), deploy: panel('deploy'),
    plans: panel('plans'), escalations: panel('escalations'), autonomy: panel('autonomy'),
    observations: panel('observations'), improvements: panel('improvements'), infra: panel('infra'),
    suFleet: panel('suFleet'), coordination: panel('coordination'), overwatch: panel('overwatch'),
    scout: panel('scout'), memory: panel('memory'), toolEfficiency: panel('toolEfficiency'), contextInjection: panel('contextInjection'),
  } };
}

/** Read the same declared corpus as the real Docs API before allocating PG. */
export async function preparePrivateDocsBrowserDocuments(repoRoot: string, selection = {
  selectedDoc: 'branding.mdx', neighborDoc: 'index.mdx',
  selectedHeading: 'Classic Identity', neighborHeading: 'What this is',
}) {
  const { resolveDocsRoot, resolveDocsSources } = await import('../lib/endpoint-route/routes/harness/project-docs');
  const { readDocBody } = await import('../lib/harness/docs/doc-fs');
  const docsRoot = await resolveDocsRoot(repoRoot);
  const sources = await resolveDocsSources(repoRoot);
  const bodies: Record<string, string> = {};
  for (const [docId, heading] of [[selection.selectedDoc, selection.selectedHeading],
    [selection.neighborDoc, selection.neighborHeading]]) {
    const body = await readDocBody({ docsRoot, sources }, docId);
    assert.ok(body, `Private Docs target ${docId} has no body in the configured corpus`);
    assert.ok(body.split('\n').some(line => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, '').trim() === heading),
      `Private Docs target ${docId} lacks its expected heading ${heading}`);
    bodies[docId] = body;
  }
  return { selection, bodies, docsRoot, sourcePaths: ['.papercusp/docs.json',
    ...[selection.selectedDoc, selection.neighborDoc].map(docId => relative(repoRoot, join(docsRoot, docId)))] };
}

/** Match with-test-pg's six-character runtime allocation and the native fixture's
 * existing conservative socket limit before paying for PG startup/migrations. */
export function preparePrivateWorkerSources(root: string, paths: string[], env: NodeJS.ProcessEnv = process.env,
  readCommitted: (path: string) => Uint8Array = path => execFileSync('git', ['show', 'HEAD:' + path],
    { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })) {
  const committed = (env.NODE_OPTIONS ?? '').includes('committed-source-loader.mjs');
  assert.ok(paths.length > 0, 'Private worker source population is required');
  // Matching HEAD at one instant does not isolate a minutes-long proof from
  // peer edits. Committed proofs use the existing verifier-run route; local
  // development without a selected archive keeps its working-source label.
  const frozen = committed || Boolean(env.VERIFY_TAURI_SOURCE_RECEIPT)
    || existsSync(join(root, '.verifier-source.json'));
  const selected = frozen ? readVerifierSourceReceiptSync(root, env.VERIFY_TAURI_SOURCE_RECEIPT ?? '') : undefined;
  if (selected && env.VERIFY_TAURI_SOURCE_REF)
    assert.equal(selected.sourceCommit, env.VERIFY_TAURI_SOURCE_REF, 'Private worker selected source differs');
  const files = [...new Set(paths)].map(path => {
    assert.ok(!isAbsolute(path) && !path.split('/').includes('..') && !path.includes('\\'),
      'Private worker source must be repository-relative: ' + path);
    const bytes = readFileSync(join(root, path));
    const sha256 = digestBytes(bytes);
    if (selected) assert.equal(selected.files.find(file => file.path === path)?.sha256, sha256,
      'Private worker source is outside the selected archive: ' + path);
    if (committed) {
      assert.equal(digestBytes(readCommitted(path)), sha256,
        'Private worker would execute different HEAD bytes: ' + path
        + '; publish the authorized source through git-sync before private allocation');
    }
    return { path, sha256 };
  });
  return { loader: committed ? 'committed-source' : selected ? 'verifier-source' : 'working-source', files,
    ...(selected ? { frozenSource: { sourceCommit: selected.sourceCommit,
      receiptPath: realpathSync(env.VERIFY_TAURI_SOURCE_RECEIPT!),
      receiptSha256: digestBytes(readFileSync(env.VERIFY_TAURI_SOURCE_RECEIPT!)) } } : {}) };
}

export function preparePrivateRosterSocketRoot(scratchRoot = tmpdir()) {
  assert.ok(isAbsolute(scratchRoot), 'Private roster scratch root must be absolute');
  const socket = join(scratchRoot, 'papercusp-test-runtime-XXXXXX', 'tmp', 'rs-XXXXXX', 'su-rs-123456789-neighbor.sock');
  assert.ok(Buffer.byteLength(socket) < 104,
    'Private roster scratch root exceeds native socket capacity; select a shorter task-owned TMPDIR before private PG');
  return socket;
}

/** A nested Git clone has its own source pin, not its donor archive's marker. */
export function privateGitCloneBundleEnv(root: string, selectedCommit: string,
  env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  assert.match(selectedCommit, /^[a-f0-9]{40}$/, 'Private clone needs the full selected source commit');
  assert.ok(!existsSync(join(root, '.verifier-source.json')), 'Private clone must be a Git checkout, not an archive');
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args],
    { encoding: 'utf8', timeout: 10_000 }).trim();
  assert.equal(realpathSync(git(['rev-parse', '--show-toplevel'])), realpathSync(root),
    'Private clone must own its Git source root');
  assert.equal(git(['rev-parse', 'HEAD']), selectedCommit, 'Private clone source differs from the selected commit');
  const environment = { ...env };
  delete environment.VERIFY_TAURI_SOURCE_RECEIPT;
  delete environment.VERIFY_TAURI_SOURCE_REF;
  return environment;
}

type PrivateBundleBuilder = { command?: string; args?: string[]; timeoutMs: number; maxMs?: number; pollMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Original diagnostics must outlive a disposable bundle/source directory. */
  retainedEvidenceDir?: string;
  onProgress?: (progress: { step: string; completedSteps: number;
    completedFiles?: number; totalFiles?: number; bytesRead?: number }) => void };
type PrivateBundleReceipt = { path: string; sha256: string };

/** The final restricted-hold census verifies the complete selected source after
 * compilation. Its existing child deadline must fit in the enclosing builder:
 * the compilation allowance alone left only 22s for this 120s child in WI-6464.
 * Callers reserve this same total in isolatedWorkerOptions' preparation budget.
 */
export function privateOperatorApiBuildBudget() {
  return { timeoutMs: 240_000, maxMs: 420_000 + RESTRICTED_HOLD_PREFLIGHT_TIMEOUT_MS };
}

/** Preserve a retired build before rebuilding at the runtime's canonical output path. */
export function archivePrivateOperatorApiBuild(evidenceDir: string, archive: string): string {
  assert.ok(!existsSync(archive), 'Previous private build archive must not be overwritten');
  assert.ok(statSync(evidenceDir).isDirectory(), 'Private build output must be a directory');
  renameSync(evidenceDir, archive);
  mkdirSync(evidenceDir);
  return archive;
}

export function buildPrivateOperatorApiBundle(root: string, evidenceDir: string,
  builder: PrivateBundleBuilder & { maxMs: number }): Promise<PrivateBundleReceipt>;
export function buildPrivateOperatorApiBundle(root: string, evidenceDir: string,
  builder?: PrivateBundleBuilder): PrivateBundleReceipt;
export function buildPrivateOperatorApiBundle(root: string, evidenceDir: string, builder?: PrivateBundleBuilder) {
  // EI-26701352410915960: a readable but out-of-range SDK survived the lock/tree
  // audit and cost an entire private build before failing at host startup.
  // Use the installer's Node-resolution check before allocating build artifacts.
  const invalidDependencies = findUnsatisfiedDeclaredDepRanges({ repoRoot: root,
    workspaceDirs: ['packages/operator-core'] });
  assert.equal(invalidDependencies.length, 0, `Private operator dependencies violate their declared ranges: ${
    invalidDependencies.map(({ dep, declared, installed }: { dep: string; declared: string; installed: string }) =>
      `${dep}: declared ${declared}, installed ${installed}`).join('; ')}`);
  const path = join(evidenceDir, 'hono-host.mjs');
  const stepPath = `${path}.build-steps.jsonl`;
  const timeoutMs = builder?.timeoutMs ?? 240_000;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Private builder deadline must be positive');
  if (builder?.maxMs !== undefined) {
    assert.ok(Number.isSafeInteger(builder.maxMs) && builder.maxMs >= timeoutMs, 'Private builder ceiling must cover its checkpoint');
    assert.ok(builder.pollMs === undefined || Number.isSafeInteger(builder.pollMs) && builder.pollMs > 0);
    assert.ok(!existsSync(stepPath), 'Progress build requires a fresh retained step journal');
  }
  // Write both streams directly to retained evidence: a timeout, signal or
  // parent failure must not erase the compiler/census's original diagnostics.
  const log = openSync(join(evidenceDir, 'operator-api-build.log'), 'w', 0o600);
  const started = Date.now();
  let receipt: Record<string, unknown> = { startedAt: new Date(started).toISOString() };
  const stopGroup = (pid?: number) => {
    if (!pid) return;
    try { process.kill(-pid, 'SIGKILL'); receipt.groupStop = 'signaled'; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      receipt.groupStop = 'already-exited';
    }
  };
  const finish = () => {
    closeSync(log);
    if (existsSync(stepPath)) {
      // A timeout may interrupt the final append. Preserve the original journal.
      const lines = readFileSync(stepPath, 'utf8').trim().split('\n');
      const steps: Array<{ at: number; pid: number; step: string; event: string; status?: number }> = [];
      const unreadableRows: number[] = [];
      for (const [index, line] of lines.entries()) {
        try { steps.push(JSON.parse(line)); } catch { unreadableRows.push(index + 1); }
      }
      const last = steps.at(-1);
      const activeSteps: typeof steps = [];
      const durationsMs: Array<{ step: string; elapsedMs: number; status?: number }> = [];
      for (const step of steps) {
        if (step.event === 'start') activeSteps.push(step);
        else if (step.event === 'end') {
          let index = activeSteps.length - 1;
          while (index >= 0 && (activeSteps[index].pid !== step.pid || activeSteps[index].step !== step.step)) index--;
          if (index < 0) continue;
          const [open] = activeSteps.splice(index, 1);
          durationsMs.push({ step: step.step, elapsedMs: Math.round((step.at - open.at) * 1000), status: step.status });
        }
      }
      receipt.steps = { path: stepPath, count: steps.length, unreadableRows,
        last: last ?? null, active: activeSteps.at(-1)?.step ?? null,
        activeSteps: activeSteps.map(({ pid, step }) => ({ pid, step })), durationsMs };
    }
    writeFileSync(join(evidenceDir, 'operator-api-build-result.json'), JSON.stringify({ ...receipt,
      endedAt: new Date().toISOString(), elapsedMs: Date.now() - started }));
    if (builder?.retainedEvidenceDir) {
      mkdirSync(builder.retainedEvidenceDir, { recursive: true });
      for (const name of ['operator-api-build.log', 'operator-api-build-result.json', 'hono-host.mjs.build-steps.jsonl']) {
        const original = join(evidenceDir, name);
        if (existsSync(original)) copyFileSync(original, join(builder.retainedEvidenceDir, name));
      }
    }
  };
  const command = builder?.command ?? 'bash';
  const args = builder?.args ?? [join(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', path];
  const environment = isolatedRuntimeEnv(builder?.env ?? process.env);
  if (builder?.maxMs !== undefined) {
    const maxMs = builder.maxMs;
    return new Promise<PrivateBundleReceipt>((resolveBuild, reject) => {
      let child: ChildProcess;
      try { child = spawn(command, args, { cwd: root, env: environment, stdio: ['ignore', log, log], detached: true }); }
      catch (error) { finish(); reject(error); return; }
      const completed = new Set<string>();
      const openSteps = new Set<string>();
      const censuses = new Map<string, { files: number; total: number; bytes: number }>();
      let rowsSeen = 0;
      let lastProgressAt: number | null = null;
      let failure: Error | undefined;
      let extensions = 0;
      const sample = () => {
        if (!existsSync(stepPath)) return;
        // Only fully appended rows can advance. Nested shell steps may interleave.
        const lines = readFileSync(stepPath, 'utf8').split('\n').slice(0, -1);
        const progress: Array<Parameters<NonNullable<PrivateBundleBuilder['onProgress']>>[0]> = [];
        for (const line of lines.slice(rowsSeen)) {
          try {
            const step = JSON.parse(line);
            if (!Number.isFinite(step.at) || step.at < started / 1000 || !Number.isSafeInteger(step.pid) || step.pid <= 0
              || typeof step.step !== 'string' || !step.step) continue;
            const key = `${step.pid}:${step.step}`;
            if (step.event === 'start' && !completed.has(step.step)) openSteps.add(key);
            else if (step.event === 'end') {
              if (openSteps.delete(key) && step.status === 0 && !completed.has(step.step)) {
                completed.add(step.step); lastProgressAt = Date.now();
                progress.push({ step: step.step, completedSteps: completed.size });
              }
            } else if (step.event === 'progress' && step.step.endsWith('source-census')
              && openSteps.has(key) && !completed.has(step.step)
              && Number.isSafeInteger(step.completedFiles) && Number.isSafeInteger(step.totalFiles)
              && step.completedFiles >= 0 && step.totalFiles > 0 && step.completedFiles <= step.totalFiles
              && Number.isSafeInteger(step.bytesRead) && step.bytesRead >= 0) {
              const previous = censuses.get(key);
              if (previous && (step.totalFiles !== previous.total || step.completedFiles < previous.files
                || step.bytesRead < previous.bytes)) continue;
              censuses.set(key, { files: step.completedFiles, total: step.totalFiles, bytes: step.bytesRead });
              if (step.completedFiles > (previous?.files ?? 0)) {
                lastProgressAt = Date.now();
                progress.push({ step: step.step, completedSteps: completed.size,
                  completedFiles: step.completedFiles, totalFiles: step.totalFiles, bytesRead: step.bytesRead });
              }
            }
          } catch { /* an invalid journal row cannot extend the deadline */ }
        }
        rowsSeen = lines.length;
        // Forward the same validated work that renews this builder's
        // deadline, so enclosing watchdogs need no synthetic heartbeat.
        for (const step of progress) builder.onProgress?.(step);
      };
      const observeProgress = () => {
        try { sample(); }
        catch (error) { failure = error as Error; stopGroup(child.pid); }
      };
      const poll = managedSetInterval('private-operator-bundle-build-progress', builder.pollMs ?? 250,
        observeProgress, { category: 'watchdog', classification: 'must-sample', instanced: true, allowInTest: true });
      let deadline: ReturnType<typeof setTimeout>;
      const expire = () => {
        observeProgress();
        if (failure) return;
        const decision = decideWatchdogExpiry({ elapsedMs: Date.now() - started, maxMs,
          lastProgressAgeMs: lastProgressAt === null ? null : Date.now() - lastProgressAt,
          stallWindowMs: timeoutMs, extensionMs: timeoutMs });
        if (decision.action === 'extend') { extensions++; deadline = setTimeout(expire, decision.extendByMs); return; }
        receipt.watchdog = { ...decision, extensions, completedSteps: completed.size, timeoutMs, maxMs };
        failure = Object.assign(new Error(`Private operator builder ETIMEDOUT (${decision.reason}); see operator-api-build.log`),
          { code: 'ETIMEDOUT' });
        stopGroup(child.pid);
      };
      deadline = setTimeout(expire, timeoutMs);
      child.once('error', error => { failure = error; stopGroup(child.pid); });
      child.once('close', (status, signal) => {
        poll.stop(); clearTimeout(deadline);
        observeProgress();
        receipt = { ...receipt, pid: child.pid, status, signal,
          progress: { extensions, completedSteps: completed.size },
          error: failure && { code: (failure as NodeJS.ErrnoException).code, message: failure.message } };
        try {
          if (failure || status !== 0) stopGroup(child.pid);
          finish();
          if (failure || status !== 0) reject(failure ?? new Error(`Private operator builder exited ${status}/${signal}; see operator-api-build.log`));
          else resolveBuild({ path, sha256: digestBytes(readFileSync(path)) });
        } catch (error) { reject(failure ?? error); }
      });
    });
  }
  try {
    // The shell starts compiler, checker and guard descendants. Killing just
    // the shell on timeout lets them keep changing the failed run's evidence.
    // Node's synchronous spawn supports detached process groups; the pinned
    // typings expose that option only on SpawnOptions.
    const buildOptions: SpawnSyncOptions & Pick<SpawnOptions, 'detached'> = {
      cwd: root, env: environment, stdio: ['ignore', log, log], detached: true,
      timeout: timeoutMs, killSignal: 'SIGKILL',
    };
    const result = spawnSync(command, args, buildOptions);
    receipt = { ...receipt, pid: result.pid, status: result.status, signal: result.signal,
      error: result.error && { code: (result.error as NodeJS.ErrnoException).code, message: result.error.message } };
    if (result.error || result.status !== 0) {
      stopGroup(result.pid);
      throw result.error ?? new Error(`Private operator builder exited ${result.status}/${result.signal}; see operator-api-build.log`);
    }
  } finally {
    finish();
  }
  return { path, sha256: digestBytes(readFileSync(path)) };
}

/** Consume independently retained artifacts without invoking the builder. The
 * optional branch leaves the generic preparation callers unchanged. */
type PrivateApiBundleReceipt = PrivateBundleReceipt & {
  qualification?: { status: 'pending' | 'preparation-qualified' };
  selectedSource?: { receiptPath: string; sha256: string; sourceCommit: string };
};
type PreparedPrivateApiBundleReceipt = PrivateApiBundleReceipt & { receiptSha256: string };
type CommittedPrivateApiBundle = {
  committedReader: { receiptPath: string; sourceReceiptPath: string; selectedCommit: string };
};
type ProgressPrivateApiBundle = { builder: PrivateBundleBuilder & { maxMs: number } };
type ObservedSourcePrivateApiBundle = {
  observedSource: { sourceReceiptPath: string; selectedCommit: string; sourceReceiptSha256: string };
};
export function preparePrivateOperatorApiBundle(root: string, evidenceDir: string,
  options: ProgressPrivateApiBundle & Partial<ObservedSourcePrivateApiBundle>): Promise<PreparedPrivateApiBundleReceipt>;
export function preparePrivateOperatorApiBundle(root: string, evidenceDir: string,
  options?: CommittedPrivateApiBundle | ObservedSourcePrivateApiBundle): PreparedPrivateApiBundleReceipt;
export function preparePrivateOperatorApiBundle(root: string, evidenceDir: string, options?: {
  committedReader: CommittedPrivateApiBundle['committedReader'];
} | ObservedSourcePrivateApiBundle | (ProgressPrivateApiBundle & Partial<ObservedSourcePrivateApiBundle>)) {
  assertPrivatePreparationEvidence();
  const retain = (receipt: PrivateApiBundleReceipt): PreparedPrivateApiBundleReceipt => {
    const receiptBytes = JSON.stringify(receipt);
    writeFileSync(join(evidenceDir, 'operator-api-preflight.json'), receiptBytes);
    return { ...receipt, receiptSha256: digestBytes(receiptBytes) };
  };
  if (options && 'observedSource' in options && options.observedSource) {
    const selected = options.observedSource;
    assert.ok(!inside(root, evidenceDir), 'Observed build outputs must be independent of the source archive');
    assert.deepEqual(verifierSourceFiles(evidenceDir), [], 'Observed build requires a fresh preparation directory');
    const sourceBytes = readFileSync(selected.sourceReceiptPath);
    assert.match(selected.sourceReceiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(digestBytes(sourceBytes), selected.sourceReceiptSha256, 'Pinned selected source receipt changed');
    const source = readVerifierSourceReceiptSync(root, selected.sourceReceiptPath);
    assert.equal(source.sourceCommit, selected.selectedCommit, 'Observed selected source differs');
    const inputs: ObservedPrivateApiBuildInputs = { phase: 'build-observation', sourceCommit: selected.selectedCommit,
      dependencyFiles: verifierSourceFiles(join(root, 'node_modules'), { symlinkRoot: root }) };
    const inputBytes = Buffer.from(JSON.stringify(inputs));
    const sourceReceiptPath = join(evidenceDir, 'verifier-source.json');
    const inputReceiptPath = join(evidenceDir, 'operator-api-inputs.json');
    writeFileSync(sourceReceiptPath, sourceBytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(inputReceiptPath, inputBytes, { flag: 'wx', mode: 0o600 });
    const complete = (bundle: PrivateBundleReceipt) => {
      assert.deepEqual(readFileSync(selected.sourceReceiptPath), sourceBytes, 'Original source receipt changed during build');
      assert.deepEqual(readFileSync(sourceReceiptPath), sourceBytes, 'Retained source receipt changed during build');
      assert.deepEqual(readFileSync(inputReceiptPath), inputBytes, 'Original build inputs changed during build');
      readVerifierSourceReceiptSync(root, selected.sourceReceiptPath);
      assert.deepEqual(verifierSourceFiles(join(root, 'node_modules'), { symlinkRoot: root }), inputs.dependencyFiles,
        'Materialized dependencies changed during build');
      const artifactCensus = preparedArtifactCensus(evidenceDir, root);
      assert.ok(artifactCensus.every(file => file.kind === 'file'), 'Observed build symlinks are not qualified');
      const receipt = retain({ ...inputs, ...bundle, qualification: { status: 'pending' },
        metafileSha256: digestBytes(readFileSync(`${bundle.path}.meta.json`)), artifactCensus,
        artifacts: artifactCensus.map(file => ({ path: join(evidenceDir, file.path), sha256: file.sha256 })),
        inputReceipt: { path: inputReceiptPath, sha256: digestBytes(inputBytes) },
        selectedSource: { receiptPath: sourceReceiptPath, sha256: digestBytes(sourceBytes), sourceCommit: selected.selectedCommit },
      } as PrivateApiBundleReceipt);
      qualifyObservedPrivateApiBuild({ root, bundle: bundle.path, receiptPath: join(evidenceDir, 'operator-api-preflight.json'),
        sourceReceiptPath, selectedCommit: selected.selectedCommit, receiptSha256: receipt.receiptSha256,
        sourceReceiptSha256: selected.sourceReceiptSha256, preparationOnly: true });
      return receipt;
    };
    return 'builder' in options
      ? buildPrivateOperatorApiBundle(root, evidenceDir, options.builder).then(complete)
      : complete(buildPrivateOperatorApiBundle(root, evidenceDir));
  }
  if (options && 'builder' in options)
    return buildPrivateOperatorApiBundle(root, evidenceDir, options.builder).then(retain);
  const selected = options && 'committedReader' in options ? options.committedReader : undefined;
  let receipt: PrivateApiBundleReceipt;
  if (!selected) receipt = buildPrivateOperatorApiBundle(root, evidenceDir);
  else {
    const sourceBytes = readFileSync(selected.sourceReceiptPath);
    const closureBytes = readFileSync(selected.receiptPath);
    const closure: CommittedReaderClosure = JSON.parse(String(closureBytes));
    assertCommittedReaderClosure(closure);
    const path = join(evidenceDir, 'hono-host.mjs');
    const qualification = qualifyCommittedReaderSource({ root, bundle: path, ...selected, preparationOnly: true,
      sourceReceiptSha256: digestBytes(sourceBytes), receiptSha256: digestBytes(closureBytes) });
    assert.deepEqual(readFileSync(selected.sourceReceiptPath), sourceBytes, 'Selected source receipt changed during preparation');
    assert.deepEqual(readFileSync(selected.receiptPath), closureBytes, 'Selected closure receipt changed during preparation');
    const sourcePath = join(evidenceDir, 'verifier-source.json');
    const retainedReceiptPath = join(evidenceDir, 'operator-api-preflight.json');
    if (selected.receiptPath === retainedReceiptPath) {
      const retained = JSON.parse(String(closureBytes));
      assert.deepEqual(retained.selectedSource, { receiptPath: sourcePath, sha256: digestBytes(sourceBytes),
        sourceCommit: selected.selectedCommit }, 'Retained selected source handoff differs');
      assert.equal(retained.path, path, 'Retained bundle path differs');
      // Keep the producer's original bytes and digest across this handoff.
      return { ...retained, receiptSha256: digestBytes(closureBytes) } as typeof receipt & { receiptSha256: string };
    }
    writeFileSync(sourcePath, sourceBytes);
    receipt = { ...closure, path, sha256: closure.sha256, qualification,
      selectedSource: { receiptPath: sourcePath, sha256: digestBytes(sourceBytes), sourceCommit: selected.selectedCommit } };
  }
  return retain(receipt);
}

/** Run once in recordIsolatedIntegrationProof's existing allocated prepare
 * folder. Required independent input gaps refuse before the compiler. Produced
 * digests come only from retained bytes; actual schema/env/host stay pending. */
export function produceCommittedReaderPrivateApiBundle(root: string, evidenceDir: string, selected: {
  inputReceiptPath: string; sourceReceiptPath: string; selectedCommit: string;
}) {
  assertPrivatePreparationEvidence();
  assert.ok(!inside(root, evidenceDir) && !inside(root, selected.inputReceiptPath),
    'Preparation outputs and input receipt must be independent of the source archive');
  const planned = qualifyCommittedReaderPlannedInputs(root, selected);
  const { sourceBytes, inputBytes, inputs, copies } = planned;
  assert.deepEqual(verifierSourceFiles(evidenceDir), [], 'Producer requires a fresh allocated preparation directory');
  const unchanged = planned.recheck;
  unchanged();
  const { path, sha256 } = buildPrivateOperatorApiBundle(root, evidenceDir);
  unchanged();
  const artifactCensus = preparedArtifactCensus(evidenceDir, root);
  assert.ok(artifactCensus.every(file => file.kind === 'file'), 'Produced symlink artifacts require independent qualification');
  const artifacts = artifactCensus.map(file => ({ path: join(evidenceDir, file.path), sha256: file.sha256,
    ...(copies.has(file.path) ? { sourcePath: copies.get(file.path)! } : {}) }));
  for (const [output, source] of copies)
    assert.ok(artifacts.some(artifact => artifact.path === join(evidenceDir, output) && artifact.sourcePath === source),
      `Planned copied artifact missing: ${output}`);
  const { phase: _phase, copiedArtifacts: _copies, ...pins } = inputs;
  const closure: CommittedReaderClosure = { ...pins, phase: 'produced', sha256,
    metafileSha256: digestBytes(readFileSync(`${path}.meta.json`)), artifacts, artifactCensus };
  const sourcePathRetained = join(evidenceDir, 'verifier-source.json');
  const inputsPathRetained = join(evidenceDir, 'operator-api-inputs.json');
  const receiptPath = join(evidenceDir, 'operator-api-preflight.json');
  writeFileSync(sourcePathRetained, sourceBytes);
  writeFileSync(inputsPathRetained, inputBytes);
  const receipt = { ...closure, path,
    inputReceipt: { path: inputsPathRetained, sha256: digestBytes(inputBytes) },
    selectedSource: { receiptPath: sourcePathRetained, sha256: digestBytes(sourceBytes), sourceCommit: selected.selectedCommit } };
  // This intermediate receipt remains explicitly unqualified if output checks
  // fail. No worker allocation or generic fallback is possible on that path.
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, qualification: { status: 'pending' } }));
  unchanged();
  const qualification = qualifyCommittedReaderArtifacts({ root, bundle: path, receiptPath,
    sourceReceiptPath: sourcePathRetained, sourceReceiptSha256: digestBytes(sourceBytes),
    selectedCommit: selected.selectedCommit, preparationOnly: true }, true);
  unchanged();
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, qualification }));
  return preparePrivateOperatorApiBundle(root, evidenceDir, { committedReader: {
    receiptPath, sourceReceiptPath: sourcePathRetained, selectedCommit: selected.selectedCommit,
  } });
}

/** Read and parse the receipt from the same bytes whose digest was verified. */
function readPreparedPrivateApiBundle(argv: readonly string[], evidenceDir: string) {
  const values = argv.filter(value => value.startsWith('--prepared-api-sha='));
  if (!values.length) return undefined;
  assert.equal(values.length, 1, 'Pass exactly one prepared API digest');
  const sha256 = values[0].slice('--prepared-api-sha='.length);
  assert.match(sha256, /^[a-f0-9]{64}$/, 'Prepared API digest must be SHA256');
  const path = join(dirname(evidenceDir), 'prepare', 'hono-host.mjs');
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sha256,
    'Prepared private API changed after preflight');
  const receipts = argv.filter(value => value.startsWith('--prepared-receipt-sha='));
  let receipt: { path: string; sha256: string; sourceCommit?: string; selectedSource?: {
    receiptPath: string; sha256: string; sourceCommit: string;
  } } | undefined;
  let receiptSha256: string | undefined;
  if (receipts.length) {
    assert.equal(receipts.length, 1, 'Pass exactly one prepared receipt digest');
    receiptSha256 = receipts[0].slice('--prepared-receipt-sha='.length);
    assert.match(receiptSha256, /^[a-f0-9]{64}$/, 'Prepared receipt digest must be SHA256');
    const receiptBytes = readFileSync(join(dirname(path), 'operator-api-preflight.json'));
    assert.equal(createHash('sha256').update(receiptBytes).digest('hex'), receiptSha256,
      'Prepared private receipt changed after preflight');
    receipt = JSON.parse(String(receiptBytes));
    assert.equal(receipt!.path, path, 'Prepared private receipt names another artifact');
    assert.equal(receipt!.sha256, sha256, 'Prepared private receipt names another digest');
  }
  return { path, receipt, receiptSha256 };
}

/** A worker may reuse only the artifact from its own original prepare phase. */
export function resolvePreparedPrivateApiBundle(argv: readonly string[], evidenceDir: string) {
  return readPreparedPrivateApiBundle(argv, evidenceDir)?.path;
}

/** Selected source crosses the sanitized child boundary through the parent's
 * pinned preparation receipt, never through an ambient selection default. */
export function resolvePreparedCommittedReaderSource(argv: readonly string[], evidenceDir: string,
  observation?: { buildObservationOnly: true; root: string }) {
  assert.equal(argv.filter(value => value.startsWith('--prepared-receipt-sha=')).length, 1,
    'Committed reader requires one pinned preparation receipt');
  const prepared = readPreparedPrivateApiBundle(argv, evidenceDir);
  assert.ok(prepared?.receipt, 'Committed reader requires an independently prepared pinned API');
  const { path: bundle, receipt } = prepared;
  const closure = receipt as unknown as CommittedReaderClosure;
  if (!observation) assertCommittedReaderClosure(closure);
  if (!observation && closure.phase === 'produced') {
    assert.equal(closure.qualification?.status, 'preparation-qualified',
      'Partial produced preparation is not qualified for consumption');
    retainedProducedInputs(closure, bundle);
  }
  const source = receipt.selectedSource;
  assert.ok(source && source.receiptPath === join(dirname(bundle), 'verifier-source.json'),
    'Committed reader requires the retained independent selected source receipt');
  assert.match(source.sourceCommit, /^[a-f0-9]{40}$/, 'Exact selected committed source is required');
  assert.equal(source.sourceCommit, receipt.sourceCommit, 'Prepared source selection differs');
  assert.equal(createHash('sha256').update(readFileSync(source.receiptPath)).digest('hex'), source.sha256,
    'Retained selected source receipt changed after preflight');
  if (observation) {
    // The explicit observation lane validates original build/source/dependency
    // bytes, while preserving pending qualification. It cannot enter the
    // ordinary committed-reader branch above or certify runtime inputs.
    assert.equal(observation.buildObservationOnly, true, 'Explicit build observation mode required');
    qualifyObservedPrivateApiBuild({ root: observation.root, bundle,
      receiptPath: join(dirname(bundle), 'operator-api-preflight.json'),
      receiptSha256: prepared.receiptSha256!, sourceReceiptPath: source.receiptPath,
      sourceReceiptSha256: source.sha256, selectedCommit: source.sourceCommit, preparationOnly: true });
  }
  return { sourceReceiptPath: source.receiptPath, selectedCommit: source.sourceCommit,
    sourceReceiptSha256: source.sha256, receiptSha256: prepared.receiptSha256! };
}

/** Isolated workers intentionally discard PAPERCUSP_* ambient settings.
 * Explicit readonly source selection travels in argv and is validated by the
 * parent BEFORE booting a runtime, then by the child before bundling its API. */
export function preparePortalBrowserSource(argv: readonly string[]) {
  const values = argv.filter(value => value.startsWith('--portal-source='));
  assert.equal(values.length, 1, 'Pass exactly one explicit --portal-source argument');
  const value = values[0].slice('--portal-source='.length);
  assert.ok(isAbsolute(value), 'Portal source must be an absolute maintained checkout path');
  const root = realpathSync(value);
  for (const file of ['packages/ui/src/agents-popover.tsx', 'app/tokens.css', 'app/globals.css',
    'node_modules/react/package.json', 'node_modules/react-dom/package.json']) {
    assert.ok(statSync(join(root, file)).isFile(), `Portal browser preflight requires ${file}`);
  }
  const fromPortal = createRequire(join(root, 'package.json'));
  for (const specifier of ['nuqs', 'nuqs/adapters/react']) {
    assert.ok(statSync(fromPortal.resolve(specifier)).isFile(), `Portal browser preflight requires ${specifier}`);
  }
  return root;
}

/** Resolve shared browser stores through one maintained package's exports map.
 * Directory aliases bypass adapter exports; duplicate installations split the
 * Nuqs and TanStack router contexts and Sonner's toast/Toaster observer.
 * Sync must come from the selected operator checkout: the Portal package link
 * still points to the canonical tree when that checkout is a frozen verifier. */
export function portalBrowserPackagesPlugin(portalSourceRoot: string,
  operatorSourceRoot = resolve(import.meta.dirname, '../../..')): Plugin {
  const fromPortal = createRequire(join(realpathSync(portalSourceRoot), 'package.json'));
  const fromOperator = createRequire(join(realpathSync(operatorSourceRoot), 'package.json'));
  return { name: 'portal-browser-package-exports', setup(builder) {
    builder.onResolve({ filter: /^@papercusp\/sync(?:\/.*)?$/ }, ({ path }) => ({ path: fromOperator.resolve(path) }));
    builder.onResolve({ filter: /^(?:nuqs(?:\/.*)?|sonner|@tanstack\/react-router)$/ }, ({ path }) => ({ path: fromPortal.resolve(path) }));
  } };
}

/** Use the exact maintained Portal client boundary, including router and
 * server-only aliases. Do not duplicate the table in a fixture. */
export async function portalBrowserSurfaceBuild(portalSourceRoot: string, options: { standaloneRouter?: boolean } = {}) {
  const portal = realpathSync(portalSourceRoot);
  const root = resolve(import.meta.dirname, '../../..');
  const source = join(portal, 'apps/host/src/operator-surface-build.mjs');
  const { assertShimsResolvable, operatorSurfaceShims, operatorSurfaceImportMetaEnv, operatorSurfaceAliases } = await import(pathToFileURL(source).href);
  const shims: Array<{ pattern: RegExp; replacement: string }> = assertShimsResolvable(operatorSurfaceShims(root, portal));
  // The static private ADV fixture mounts the operator's real TanStack router,
  // while the Portal host mounts Next. Keep the native router-compat modules
  // for that fixture; all server-only boundaries still come from the registry.
  const activeShims = options.standaloneRouter ? shims.filter(shim => ![
    join(portal, 'apps/host/shims/router-compat-navigation.tsx'),
    join(portal, 'apps/host/shims/router-compat-link.tsx'),
  ].includes(shim.replacement)) : shims;
  const plugin: Plugin = { name: 'maintained-portal-surface-boundary', setup(builder) {
    for (const shim of activeShims) builder.onResolve({ filter: shim.pattern }, () => ({ path: shim.replacement }));
  } };
  // Prefix aliases are part of the same maintained boundary as the shims.
  // tsconfig paths preserve onResolve shim precedence and let esbuild resolve
  // directory barrels (e.g. the real Dev IPC transport) without fixture stubs.
  const paths: Record<string, string[]> = {};
  for (const [prefix, replacement] of Object.entries(operatorSurfaceAliases(root) as Record<string, string>)) {
    paths[prefix] = [replacement];
    paths[prefix + '/*'] = [replacement + '/*'];
  }
  return { plugin, paths, define: { 'import.meta.env': JSON.stringify(operatorSurfaceImportMetaEnv()) }, source };
}

/** Validate the launcher's single selected alias, without admitting an ambient
 * fallback. The alias keeps the source socket's peer/message-bus protocol. */
export function assertPrivateManagedTaskRoute(env: NodeJS.ProcessEnv) {
  assert.ok(env.HOME && env.XDG_RUNTIME_DIR, 'private managed-task runtime required');
  const runtime = join(resolve(env.HOME, '..'), 'xdg-runtime');
  assert.equal(env.XDG_RUNTIME_DIR, runtime, 'managed-task route must use the private runtime');
  assert.equal(realpathSync(runtime), runtime, 'private runtime must not redirect outside its root');
  const routes = ['systemd/private', 'bus'];
  const selected = routes.find(route => env.DBUS_SESSION_BUS_ADDRESS === `unix:path=${join(runtime, route)}`);
  assert.ok(selected, 'one exact private managed-task bus address required');
  const alias = join(runtime, selected);
  const link = lstatSync(alias);
  assert.ok(link.isSymbolicLink() && link.uid === process.getuid!(), 'selected route must be an owned alias');
  const socket = realpathSync(alias);
  const sourceRuntime = resolve(socket, selected === 'bus' ? '..' : '../..');
  assert.equal(join(sourceRuntime, selected), socket, 'selected alias must preserve the socket protocol');
  const target = statSync(alias);
  assert.ok(target.isSocket() && target.uid === process.getuid!(), 'selected route must reach an owned socket');
  for (const route of routes.filter(route => route !== selected)) {
    assert.equal(lstatSync(join(runtime, route), { throwIfNoEntry: false }), undefined,
      'an unselected manager route must not be exposed');
  }
  return { address: env.DBUS_SESSION_BUS_ADDRESS, alias, socket };
}

export function preparePrivateHttpWorkspaces() {
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID ?? '';
  assert.match(workspace, /^test-runtime-/);
  const runtimeRoot = resolve(process.env.HOME ?? '', '..');
  assert.equal(process.env.PAPERCUSP_WORKSPACES_ROOT, join(runtimeRoot, 'workspaces'),
    'HTTP controls must use the disposable runtime registry');
  assert.equal(process.env.TMPDIR, join(runtimeRoot, 'tmp'),
    'HTTP controls must use the disposable runtime scratch');
  const foreignWorkspace = workspace + '-foreign';
  ensureWorkspaceEntry(workspace);
  ensureWorkspaceEntry(foreignWorkspace);
  assert.ok(isKnownWorkspace(workspace) && isKnownWorkspace(foreignWorkspace));
  return { workspace, foreignWorkspace };
}
