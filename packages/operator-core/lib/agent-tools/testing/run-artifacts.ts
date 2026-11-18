/** Retained evidence for the existing testing:run route; this module launches nothing. */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { appendFile, mkdir, lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { papercuspHome } from '@papercusp/host-platform/home';
import { homedir } from 'node:os';
import { defaultEvidenceRoot } from '@papercusp/verification-harness/evidence-root';
import type { OwnedTestDbCleanupResult } from '@papercusp/test-config/pg';
import { retainNativeProofPacketAsync, verifyNativeProofPacket,
  type NativeCustodyAuxiliary, type NativeCustodyGroup, type NativeCustodyIdentity,
  type NativeCustodyLocator } from '../../../../../scripts/lib/budgeted-task-scheduler.mjs';

export interface TestRunDeadline {
  startedAtMs: number;
  taskDeadlineAtMs: number;
  childCutoffAtMs: number;
  cleanupReserveMs: number;
  /** Private-PG bootstrap allowance, separate from the assertion budget. */
  setupTimeoutMs?: number;
  effectiveSetupTimeoutMs?: number;
  setupDeadlineAtMs?: number;
  verificationTimeoutMs?: number;
}
export function testRunDeadline(timeoutMs: number, options: {
  now?: number; taskDeadlineAtMs?: number; cleanupReserveMs?: number; setupTimeoutMs?: number;
} = {}): TestRunDeadline {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('test run budget must be positive');
  const now = options.now ?? Date.now();
  if (options.taskDeadlineAtMs !== undefined && !Number.isFinite(options.taskDeadlineAtMs)) {
    throw new Error('absolute test task deadline must be finite');
  }
  const setupTimeoutMs = options.setupTimeoutMs ?? 0;
  if (!Number.isFinite(setupTimeoutMs) || setupTimeoutMs < 0) {
    throw new Error('private-PG setup budget must be nonnegative and finite');
  }
  const requestedWorkBudgetMs = timeoutMs + setupTimeoutMs;
  const requestedReserve = options.cleanupReserveMs ?? Math.min(30_000, Math.floor(requestedWorkBudgetMs / 3));
  if (!Number.isFinite(requestedReserve) || requestedReserve < 0 || requestedReserve >= requestedWorkBudgetMs) {
    throw new Error('test cleanup reserve must be nonnegative and smaller than the work budget');
  }
  // For private-PG runs, timeoutMs is the assertion budget. Add setup and cleanup
  // outside it; the caller's absolute deadline remains a hard cap.
  const requestedTaskDeadlineAtMs = now + requestedWorkBudgetMs + (setupTimeoutMs > 0 ? requestedReserve : 0);
  const taskDeadlineAtMs = Math.min(requestedTaskDeadlineAtMs, options.taskDeadlineAtMs ?? Infinity);
  const available = Math.max(0, taskDeadlineAtMs - now);
  // An explicit reserve defines a fixed child cutoff. Shrinking it as preparation
  // elapses would move that cutoff forward and consume the caller's cleanup time.
  const cleanupReserveMs = options.cleanupReserveMs === undefined
    ? Math.min(requestedReserve, available) : requestedReserve;
  const childCutoffAtMs = taskDeadlineAtMs - cleanupReserveMs;
  if (setupTimeoutMs <= 0) return { startedAtMs: now, taskDeadlineAtMs, cleanupReserveMs, childCutoffAtMs };
  const effectiveSetupTimeoutMs = Math.min(setupTimeoutMs,
    Math.max(0, childCutoffAtMs - now - timeoutMs));
  return { startedAtMs: now, taskDeadlineAtMs, cleanupReserveMs, childCutoffAtMs,
    setupTimeoutMs, effectiveSetupTimeoutMs, setupDeadlineAtMs: now + effectiveSetupTimeoutMs,
    verificationTimeoutMs: timeoutMs };
}

export interface TestRunArtifactPaths {
  directory: string;
  manifest: string;
  phases: string;
  reports: string;
  ownedDatabases: string;
  runtimeInputs: string;
  nativeProof: string;
}

export interface RetainedDetachedVitestReport {
  reportPath: string;
  manifestPath: string;
  sha256: string;
  byteLength: number;
}

/** The private-runtime launcher pins this existing root before replacing HOME. */
export function defaultTestRunArtifactBase(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return environment.VH_EVIDENCE_ROOT_BASE?.trim()
    ? defaultEvidenceRoot('testing-run', environment)
    : join(papercuspHome(environment, home), 'test-artifacts', 'testing-run');
}

async function ensureArtifactDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('detached_report_artifact_directory_redirected');
}

async function writeArtifactAtomically(path: string, bytes: Buffer): Promise<void> {
  try {
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error('detached_report_artifact_conflict');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Keep a private, content-addressed copy of a detached Vitest report before
 * the run store removes its temporary ingestion sink. The snapshot receives
 * both paths and the digest, so the bytes remain discoverable after restart.
 */
type DetachedVitestReportIdentity = {
  runId: string;
  root: string;
  sourcePath: string;
  scope?: { harnessSlug: string; workspaceId: string };
};

function detachedVitestReportPaths(input: DetachedVitestReportIdentity, sha256: string) {
  if (!input.runId || !isAbsolute(input.root) || !isAbsolute(input.sourcePath)) {
    throw new Error('detached_report_artifact_identity_invalid');
  }
  const sourceName = basename(input.sourcePath).replace(/[^A-Za-z0-9._-]/g, '_').slice(-96) || 'report.json';
  const reportName = sourceName.endsWith('.json') ? sourceName : 'report.json';
  const identity = JSON.stringify({ runId: input.runId, root: input.root, reportName, sha256, scope: input.scope ?? null });
  const runKey = createHash('sha256').update(input.runId).digest('hex').slice(0, 24);
  const artifactKey = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const base = join(defaultTestRunArtifactBase(), 'detached-recovery');
  const runDirectory = join(base, `run-${runKey}`);
  const packetDirectory = join(runDirectory, `report-${artifactKey}`);
  const reportsDirectory = join(packetDirectory, 'reports');
  return { base, runDirectory, packetDirectory, reportsDirectory, reportName,
    reportPath: join(reportsDirectory, reportName), manifestPath: join(packetDirectory, 'manifest.json') };
}

/** Read only the exact content-addressed packet recorded by this run's snapshot. */
export async function readRetainedDetachedVitestReport(input: DetachedVitestReportIdentity & {
  reference: RetainedDetachedVitestReport;
}): Promise<string | null> {
  const ref = input.reference;
  if (!ref || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)
    || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0
    || typeof ref.manifestPath !== 'string' || typeof ref.reportPath !== 'string') return null;
  const runKey = createHash('sha256').update(input.runId).digest('hex').slice(0, 24);
  const runDirectory = join(defaultTestRunArtifactBase(), 'detached-recovery', `run-${runKey}`);
  if (dirname(dirname(ref.manifestPath)) !== runDirectory || basename(ref.manifestPath) !== 'manifest.json'
    || !/^report-[a-f0-9]{24}$/.test(basename(dirname(ref.manifestPath)))) return null;
  const { realpath } = await import('node:fs/promises');
  if (await realpath(ref.manifestPath) !== resolve(ref.manifestPath)) return null;
  const manifest = JSON.parse(await readFile(ref.manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'detached-vitest-report'
    || manifest.runId !== input.runId || manifest.root !== input.root
    || manifest.scope?.workspaceId !== input.scope?.workspaceId
    || manifest.scope?.harnessSlug !== input.scope?.harnessSlug
    || manifest.report?.path !== ref.reportPath || manifest.report?.sha256 !== ref.sha256
    || manifest.report?.byteLength !== ref.byteLength) return null;
  // Keep the original scope key order used by older content-addressed packets.
  const expected = detachedVitestReportPaths({ ...input, scope: manifest.scope ?? undefined }, ref.sha256);
  if (ref.reportPath !== expected.reportPath || ref.manifestPath !== expected.manifestPath
    || await realpath(ref.reportPath) !== resolve(expected.reportPath)) return null;
  const bytes = await readFile(ref.reportPath);
  if (bytes.byteLength !== ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) return null;
  return bytes.toString('utf8');
}

export async function retainDetachedVitestReport(input: DetachedVitestReportIdentity & {
  reportText: string;
  sanitization?: string;
}): Promise<RetainedDetachedVitestReport> {
  const bytes = Buffer.from(input.reportText, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { base, runDirectory, packetDirectory, reportsDirectory, reportName } = detachedVitestReportPaths(input, sha256);
  for (const directory of [base, runDirectory, packetDirectory, reportsDirectory]) {
    await ensureArtifactDirectory(directory);
  }

  const reportPath = join(reportsDirectory, reportName);
  const manifestPath = join(packetDirectory, 'manifest.json');
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'detached-vitest-report',
    runId: input.runId,
    root: input.root,
    scope: input.scope ?? null,
    ...(input.sanitization ? { sanitization: input.sanitization } : {}),
    report: { path: reportPath, sha256, byteLength: bytes.byteLength },
  }, null, 2)}\n`);
  await writeArtifactAtomically(reportPath, bytes);
  await writeArtifactAtomically(manifestPath, manifest);
  return { reportPath, manifestPath, sha256, byteLength: bytes.byteLength };
}

export class TestRunArtifactPacket {
  readonly paths: TestRunArtifactPaths;
  childState: 'not-started' | 'pending' | 'closed' = 'not-started';
  cleanupResult?: OwnedTestDbCleanupResult;
  readonly groupCleanups: Array<{ directory: string | null; cleanup: unknown }> = [];
  private selectedFiles: string[] = [];
  private outputLogs: string[] = [];
  private custodyIdentity?: NativeCustodyIdentity;
  private nativeLocator?: NativeCustodyLocator;
  constructor(readonly runId: string, readonly root: string, readonly deadline: TestRunDeadline,
    base = defaultTestRunArtifactBase()) {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(base, 'run-'));
    this.paths = { directory, manifest: join(directory, 'manifest.json'), phases: join(directory, 'phases.jsonl'),
      reports: join(directory, 'reports'), ownedDatabases: join(directory, 'owned-databases'),
      runtimeInputs: join(directory, 'executed-inputs'), nativeProof: join(directory, 'native-proof') };
    for (const dir of [this.paths.reports, this.paths.ownedDatabases, this.paths.runtimeInputs]) {
      mkdirSync(dir, { mode: 0o700 });
    }
    this.write('manifest.json', { schemaVersion: 1, runId, root, deadline, state: 'running', paths: this.paths });
    this.stage('start');
  }
  /**
   * WI-6554700010048955: packet writes never run on the caller's thread. This
   * class runs inside the operator host, and a sync write there parks the whole
   * event loop: under IO pressure one `writeFileSync` from finish() held :3170's
   * main thread for 5.2 s (openSync alone 4.5 s), long enough for every
   * `/api/agent-mcp/tool-guard` lookup to miss its 1.5 s wall and fail closed.
   * Writes keep their call ORDER through one promise chain, each value is
   * serialized at call time (later mutation cannot leak in), and the first failure
   * is surfaced by flush(), which every read-back point awaits.
   */
  private writeChain: Promise<void> = Promise.resolve();
  private writeFailure: { error: unknown } | null = null;
  private enqueueWrite(task: () => Promise<unknown>): void {
    this.writeChain = this.writeChain.then(task).then(() => undefined, (error: unknown) => {
      this.writeFailure ??= { error };
    });
  }
  /** Settle every queued packet write; rethrows the first failure since the last flush. */
  async flush(): Promise<void> {
    await this.writeChain;
    const failure = this.writeFailure;
    this.writeFailure = null;
    if (failure) throw failure.error;
  }
  stage(stage: string, detail: Record<string, unknown> = {}): void {
    const path = this.paths.phases;
    const line = JSON.stringify({ kind: 'testing-run-phase', runId: this.runId, stage,
      atMs: Date.now(), ...detail }) + '\n';
    this.enqueueWrite(() => appendFile(path, line, { mode: 0o600 }));
  }
  write(name: string, value: unknown): void {
    const path = join(this.paths.directory, name);
    const body = JSON.stringify(value, null, 2) + '\n';
    this.enqueueWrite(() => writeFile(path, body, { mode: 0o600 }));
  }
  /** Selected bytes and dependency lock are pins, not a claim of a loaded import closure.
   * The maintained reporter owns loaded-source evidence; preserve its runtime inputs too.
   * The pins are hashed by the queued writer (async reads), ahead of every later packet
   * write, and runTestFilesCore flushes the queue before the router child starts. */
  captureSelectedSources(files: string[], worktree: unknown, root = this.root): void {
    this.selectedFiles = files.map(file => resolve(root, file));
    const names = [...new Set([...files, 'package.json', 'package-lock.json', 'scripts/test-files.mjs'])];
    const worktreeJson = JSON.stringify(worktree);
    const runtimeInputs = this.paths.runtimeInputs;
    const sourcePath = join(this.paths.directory, 'source.json');
    this.enqueueWrite(async () => {
      const inputs = await Promise.all(names.map(async file => {
        const path = resolve(root, file);
        const local = relative(root, path);
        if (local === '..' || local.startsWith('../') || isAbsolute(local)) return { path: file, status: 'outside-root' };
        try { return { path: local, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }; }
        catch { return { path: local, status: 'unavailable' }; }
      }));
      await writeFile(sourcePath, JSON.stringify({ root,
        worktree: worktreeJson === undefined ? undefined : JSON.parse(worktreeJson), inputs,
        coverage: 'selected files and dependency lock; loaded import closure is reporter-owned',
        runtimeInputs }, null, 2) + '\n', { mode: 0o600 });
    });
  }
  bindNativeIdentity(workspace: string | undefined, harness: string | undefined): void {
    this.custodyIdentity = { workspace: workspace || 'unscoped', harness: harness || 'unscoped', runId: this.runId };
  }
  captureOutputLogs(paths: string[]): void { this.outputLogs = [...paths]; }
  /** Seal after cleanup has its own outcome. No retention failure may prevent
   * confirmed-close cleanup, and a pending edition cannot be rewritten by a late close. */
  private async retainNative(detail: Record<string, unknown>): Promise<unknown> {
    const identity = this.custodyIdentity ?? { workspace: 'unscoped', harness: 'unscoped', runId: this.runId };
    const auxiliary: NativeCustodyAuxiliary[] = [];
    const required = ['source.json', 'configuration.json', 'router.json', 'ledger.json', 'phases.jsonl'];
    for (const name of required) auxiliary.push({ role: name, state: 'produced', path: join(this.paths.directory, name) });
    const inventory = async (directory: string, role: string, depth = 0): Promise<void> => {
      if (depth > 8 || auxiliary.length > 4096) throw new Error('packet auxiliary inventory limit');
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name), stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new Error('packet auxiliary redirected');
        if (stat.isDirectory()) await inventory(path, `${role}/${name}`, depth + 1);
        else auxiliary.push({ role: `${role}/${name}`, state: 'produced', path });
      }
    };
    for (const [role, path] of [['reports', this.paths.reports], ['owned-databases', this.paths.ownedDatabases],
      ['executed-inputs', this.paths.runtimeInputs]] as const) await inventory(path, role);
    this.outputLogs.forEach((path, index) => auxiliary.push({ role: `router-output/${index}`, state: 'produced', path }));
    const routers = (await readdir(this.paths.directory)).filter(name => name.startsWith('native-router-')).sort();
    const routerGroups: NativeCustodyGroup[] = [];
    const routerVerdicts = [];
    const nestedRouters = [];
    for (const name of routers) {
      const directory = join(this.paths.directory, name);
      const declaration = JSON.parse(await readFile(join(directory, 'expected.json'), 'utf8'));
      const routerIdentity: NativeCustodyIdentity = declaration.identity;
      if (!routerIdentity || routerIdentity.runId !== identity.runId || routerIdentity.harness !== identity.harness)
        throw new Error('packet router identity mismatch');
      let locator: NativeCustodyLocator;
      try {
        locator = JSON.parse(await readFile(join(directory, 'locator.json'), 'utf8'));
      } catch (error) {
        if (this.childState !== 'closed' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // The router may have captured every byte before exhausting its child
        // cutoff. Seal that exact packet within the parent's existing reserve;
        // never recapture producers or change the original execution verdict.
        const pending = JSON.parse(await readFile(join(directory, 'pending-locator.json'), 'utf8'));
        const recovered = await retainNativeProofPacketAsync(directory, { identity: routerIdentity, expected: declaration.expected,
          retainedLocator: pending, deadlineAtMs: this.deadline.taskDeadlineAtMs });
        locator = recovered.locator;
        await writeFile(join(directory, 'locator.json'), JSON.stringify(locator), { mode: 0o600, flag: 'wx' });
      }
      const verified = verifyNativeProofPacket(directory, locator, { identity: routerIdentity, expected: declaration.expected });
      if (routerIdentity.workspace === identity.workspace) routerGroups.push(...declaration.expected);
      else nestedRouters.push({ identity: routerIdentity,
        selectedFiles: (declaration.expected as NativeCustodyGroup[]).filter(group => group.attempt === 'primary')
          .flatMap(group => group.selected), custody: verified.status });
      routerVerdicts.push(verified.status);
      await inventory(directory, name);
    }
    if (routers.length) {
      const actual = routerGroups.filter(group => group.attempt === 'primary').flatMap(group => group.selected).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...this.selectedFiles].sort()))
        throw new Error('packet selected/router population mismatch');
    }
    const pending = this.childState === 'pending';
    const group: NativeCustodyGroup = { id: 'packet', attempt: 'primary', selected: this.selectedFiles.length
      ? this.selectedFiles : [this.root], runner: 'unsupported', armed: false, out: null, auxiliary };
    const saved = await retainNativeProofPacketAsync(this.paths.nativeProof, { identity, expected: [group],
      deadlineAtMs: this.deadline.taskDeadlineAtMs,
      observations: [{ id: group.id, out: null }], execution: { childState: this.childState, result: detail.result ?? null },
      cleanup: detail.cleanup ?? null, ...(this.nativeLocator ? { predecessor: this.nativeLocator } : {}) });
    this.nativeLocator = saved.locator;
    return { directory: saved.directory, locator: saved.locator, byteCustody: saved.status,
      writerState: pending ? 'pending' : 'settled', routerCustody: routerVerdicts, nestedRouters,
      nativeProof: 'unqualified', acceptance: 'unmeasured', producerRetirement: 'not-performed' };
  }
  async finish(detail: Record<string, unknown>): Promise<void> {
    this.stage('retained', { childState: this.childState });
    let nativeCustody: unknown;
    try {
      // Retention reads the packet back (phases.jsonl, source.json, ...): every queued write lands first.
      await this.flush();
      nativeCustody = await this.retainNative(detail);
    }
    catch (error) { nativeCustody = { byteCustody: 'unavailable', error: String(error),
      nativeProof: 'unqualified', acceptance: 'unmeasured', producerRetirement: 'retained' }; }
    this.write('manifest.json', { schemaVersion: 1, runId: this.runId, root: this.root,
      deadline: this.deadline, state: 'retained', childState: this.childState, paths: this.paths,
      groupCleanups: this.groupCleanups, ...detail, nativeCustody });
    // finish() resolves only once the retained manifest is durable; a failed write rejects, as before.
    await this.flush();
  }
}
