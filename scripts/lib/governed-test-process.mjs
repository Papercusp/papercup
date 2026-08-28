/**
 * Plain-Node bridge for the TypeScript resource-governor execution seam.
 *
 * The two repository test CLIs are intentionally `.mjs` entrypoints: they are
 * also used by packaged installs where starting Node with a project-wide loader
 * is not an option.  Importing `execution.ts` directly from plain Node fails
 * because its internal imports are extensionless.  Load tsx only when a real
 * child is about to start, register the loader once, and keep the CLI itself
 * executable by `node scripts/*.mjs`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const EXECUTION_MODULE_URL = new URL(
  '../../packages/operator-core/lib/resource-governor/execution.ts',
  import.meta.url,
).href;
const WORKSPACE_MODULE_URL = new URL(
  '../../packages/operator-core/lib/workspace-registry.ts',
  import.meta.url,
).href;

let tsxRegistered = false;
let executionModulePromise = null;
let workspaceModulePromise = null;

/** Load the canonical TypeScript seam lazily, preserving direct Node CLI startup. */
export async function loadGovernedExecutionModule() {
  if (!executionModulePromise) {
    executionModulePromise = (async () => {
      const loader = await import('tsx/esm/api');
      if (!tsxRegistered) {
        // Keep the hook installed for the process lifetime.  Both runners can
        // admit several tasks concurrently, and unregistering after one import
        // would race a sibling's first import.
        loader.register();
        tsxRegistered = true;
      }
      return import(EXECUTION_MODULE_URL);
    })().catch((error) => {
      // A transient loader/module failure must be retryable on the next child,
      // rather than poisoning the process-local promise forever.
      executionModulePromise = null;
      throw error;
    });
  }
  return executionModulePromise;
}

async function loadWorkspaceModule() {
  if (!workspaceModulePromise) {
    workspaceModulePromise = loadGovernedExecutionModule()
      .then(() => import(WORKSPACE_MODULE_URL))
      .catch((error) => {
        workspaceModulePromise = null;
        throw error;
      });
  }
  return workspaceModulePromise;
}

/** Test-only cache reset; no production caller needs to unload the loader. */
export function resetGovernedTestProcessLoaderForTests() {
  executionModulePromise = null;
  workspaceModulePromise = null;
}

/** Resolve a concrete workspace without silently inventing a tenant. */
export async function resolveGovernedWorkspaceId(value, env = process.env) {
  const explicit = typeof value === 'string' ? value.trim() : '';
  if (explicit) return explicit;
  const ambient = String(env.PAPERCUSP_WORKSPACE_ID ?? env.PAPERCUSP_WORKSPACE ?? '').trim();
  if (ambient) return ambient;
  const registry = await loadWorkspaceModule();
  const resolved = String(registry.activeWorkspaceId?.() ?? '').trim();
  if (!resolved) throw new Error('resource-governor workspace id could not be resolved');
  return resolved;
}

/**
 * Stable, bounded idempotency identity for one resident test process.
 * @param {string} [scope]
 * @param {string} [identity]
 */
export function governedProcessIdempotencyKey(scope = 'test', identity = randomUUID()) {
  const label = String(scope).trim().replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 72) || 'test';
  const digest = createHash('sha256').update(`${label}\0${String(identity)}`).digest('hex').slice(0, 40);
  return `test-process:${label}:${digest}`;
}

export const GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES = 1024 * 1024 * 1024;
export const GOVERNED_TEST_PROCESS_DEFAULT_DISK_BYTES = 256 * 1024 * 1024;
export const GOVERNED_TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS = 16;
export const GOVERNED_TEST_PROCESS_SAMPLE_INTERVAL_MS = 250;

/** Build a process reservation; measured peak values replace it at settlement. */
export function buildGovernedProcessDemand(options = {}) {
  const fileCount = Number.isFinite(options.fileCount)
    ? Math.max(1, Math.floor(options.fileCount))
    : 1;
  const memoryBytes = Number.isFinite(options.memoryBytes) && options.memoryBytes > 0
    ? Math.floor(options.memoryBytes)
    : GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES;
  const diskBytes = Number.isFinite(options.diskBytes) && options.diskBytes > 0
    ? Math.floor(options.diskBytes)
    : GOVERNED_TEST_PROCESS_DEFAULT_DISK_BYTES;
  const fileDescriptors = Number.isFinite(options.fileDescriptors) && options.fileDescriptors > 0
    ? Math.floor(options.fileDescriptors)
    : GOVERNED_TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS + fileCount;
  return {
    cpuWeight: Number.isFinite(options.cpuWeight) && options.cpuWeight >= 0 ? options.cpuWeight : 1,
    memoryBytes,
    diskBytes,
    fileDescriptors,
  };
}

function procField(text, field) {
  const match = new RegExp(`^${field}:\\s+([0-9]+)\\s*(?:kB)?$`, 'm').exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function procStatus(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    const parent = procField(text, 'PPid');
    const rssKb = procField(text, 'VmHWM') ?? procField(text, 'VmRSS');
    return {
      parentPid: parent == null ? null : Math.floor(parent),
      rssBytes: rssKb == null ? null : rssKb * 1024,
    };
  } catch {
    return null;
  }
}

function procCpuMicros(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = text.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = text.slice(commandEnd + 2).trim().split(/\s+/);
    const user = Number(fields[11]);
    const system = Number(fields[12]);
    if (!Number.isFinite(user) || !Number.isFinite(system)) return null;
    // Linux's normal user-HZ is 100.  This is a relative delta, so retaining
    // the historical conversion is sufficient even on a non-standard host.
    return (user + system) * 10_000;
  } catch {
    return null;
  }
}

function processTreePids(rootPid) {
  if (process.platform !== 'linux' || !Number.isInteger(rootPid) || rootPid <= 0) return [rootPid];
  const children = new Map();
  let entries;
  try {
    entries = readdirSync('/proc', { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [rootPid];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const status = procStatus(pid);
    if (status?.parentPid == null) continue;
    const siblings = children.get(status.parentPid) ?? [];
    siblings.push(pid);
    children.set(status.parentPid, siblings);
  }
  const result = [rootPid];
  for (let index = 0; index < result.length; index += 1) {
    for (const pid of children.get(result[index]) ?? []) {
      if (!result.includes(pid)) result.push(pid);
    }
  }
  return result;
}

/** Fail-soft aggregate resource snapshot for one child process tree. */
export function readGovernedProcessResourceSnapshot(pid) {
  const pids = processTreePids(pid);
  let cpuMicros = 0;
  let rssBytes = 0;
  let fileDescriptors = 0;
  let cpuMeasured = false;
  let rssMeasured = false;
  let fdMeasured = false;
  for (const childPid of pids) {
    const cpu = procCpuMicros(childPid);
    if (cpu != null) {
      cpuMicros += cpu;
      cpuMeasured = true;
    }
    const status = procStatus(childPid);
    if (status?.rssBytes != null) {
      rssBytes += status.rssBytes;
      rssMeasured = true;
    }
    if (process.platform === 'linux') {
      try {
        fileDescriptors += readdirSync(`/proc/${childPid}/fd`).length;
        fdMeasured = true;
      } catch {
        // The process may exit between status and fd reads.
      }
    }
  }
  return {
    cpuMicros: cpuMeasured ? cpuMicros : null,
    rssBytes: rssMeasured ? rssBytes : null,
    fileDescriptors: fdMeasured ? fileDescriptors : null,
  };
}

/**
 * Sample peak process residency while a child is alive.  The reader and clock
 * are injectable so the accounting contract is testable without procfs.
 */
export function createGovernedProcessDemandSampler(
  planned,
  { readSnapshot = readGovernedProcessResourceSnapshot, intervalMs = GOVERNED_TEST_PROCESS_SAMPLE_INTERVAL_MS, now = Date.now } = {},
) {
  let pid = null;
  let timer = null;
  let stopped = false;
  let peakRss = null;
  let peakFds = null;
  let firstCpu = null;
  let lastCpu = null;
  let firstAt = null;
  let lastAt = null;
  let cpuWeight = null;
  let stoppedDemand = null;

  const sample = () => {
    if (stopped || pid == null) return;
    let snapshot;
    try {
      snapshot = readSnapshot(pid);
    } catch {
      return;
    }
    const at = now();
    if (Number.isFinite(snapshot?.rssBytes)) peakRss = peakRss == null ? snapshot.rssBytes : Math.max(peakRss, snapshot.rssBytes);
    if (Number.isFinite(snapshot?.fileDescriptors)) peakFds = peakFds == null ? snapshot.fileDescriptors : Math.max(peakFds, snapshot.fileDescriptors);
    if (Number.isFinite(snapshot?.cpuMicros)) {
      if (firstCpu == null) {
        firstCpu = snapshot.cpuMicros;
        firstAt = at;
      }
      lastCpu = snapshot.cpuMicros;
      lastAt = at;
      if (firstAt != null && lastAt > firstAt && firstCpu != null && lastCpu != null) {
        cpuWeight = Math.max(0.01, (lastCpu - firstCpu) / ((lastAt - firstAt) * 1_000));
      }
    }
  };

  return {
    attach(nextPid) {
      if (stopped || !Number.isInteger(nextPid) || nextPid <= 0) return;
      pid = nextPid;
      sample();
      timer = setInterval(sample, intervalMs);
      timer.unref?.();
    },
    sample,
    stop(extra = {}) {
      if (stoppedDemand) return stoppedDemand;
      if (!stopped) sample();
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      stoppedDemand = {
        cpuWeight: extra.cpuWeight ?? cpuWeight ?? planned?.cpuWeight ?? 1,
        memoryBytes: extra.memoryBytes ?? peakRss ?? planned?.memoryBytes,
        diskBytes: extra.diskBytes ?? planned?.diskBytes,
        fileDescriptors: extra.fileDescriptors ?? peakFds ?? planned?.fileDescriptors,
      };
      return stoppedDemand;
    },
  };
}

/** Classify whether a child produced a trustworthy test verdict. */
export function classifyGovernedTestProcessOutcome(outcome = {}) {
  const output = `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}\n${outcome.output ?? ''}`;
  const timedOut = outcome.timedOut === true || outcome.__watchdogTimedOut === true || outcome.watchdogTimedOut === true;
  if (timedOut) return { kind: 'cancel', reason: 'test process timed out before a verdict was produced' };
  if (outcome.aborted === true) return { kind: 'cancel', reason: 'test process was aborted before a verdict was produced' };
  if (outcome.spawnError || outcome.__spawnError) {
    return { kind: 'cancel', reason: `test process spawn failed: ${outcome.spawnError ?? outcome.__spawnError}` };
  }
  const code = outcome.code ?? outcome.status ?? null;
  const signal = outcome.signal ?? null;
  if (outcome.error && (code == null || code < 0 || output.trim() === '')) {
    return { kind: 'cancel', reason: `test process failed to start: ${outcome.error.message ?? outcome.error}` };
  }
  if (/TEST_FILE_WATCHDOG|TEST_FILE_ROUTE_ERROR|worker\s+(?:exited|crash)|TasksMax|SIG(?:TERM|KILL)/i.test(output)) {
    return { kind: 'cancel', reason: 'test worker/route exited without a trustworthy verdict' };
  }
  if (code == null || signal) {
    return {
      kind: 'cancel',
      reason: `test process exited without a trustworthy verdict (code=${code ?? 'null'} signal=${signal ?? 'none'})`,
    };
  }
  return { kind: 'release', actualDemand: outcome.actualDemand };
}

/** Add a typed lineage context to a child environment. */
export function withGovernedAdmissionContext(env, context) {
  return { ...env, PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(context) };
}

/**
 * Run a child behind one durable process receipt.  A valid inherited context
 * means the caller already owns the resident process receipt, so no second
 * admission is created; the same typed context is simply forwarded.
 *
 * The callback receives `(context, childEnv, { inherited })` and must resolve
 * only after the child lifetime has ended.  That keeps the lease alive through
 * the actual process, rather than releasing it immediately after `spawn()`.
 */
export async function runGovernedTestProcess(options, run) {
  if (!options || typeof options !== 'object') throw new Error('governed test process options are required');
  if (typeof run !== 'function') throw new Error('governed test process callback is required');
  const env = { ...(options.env ?? process.env) };
  const api = options.executionApi ?? await loadGovernedExecutionModule();
  const inherited = api.admissionContextFromEnvironment?.(env.PAPERCUSP_ADMISSION_CONTEXT);
  if (inherited) {
    return run(inherited, withGovernedAdmissionContext(env, inherited), { inherited: true });
  }

  const workspaceId = await resolveGovernedWorkspaceId(options.workspaceId, env);
  const timeoutMs = options.timeoutMs;
  const leaseTtlMs = options.leaseTtlMs ?? api.governedExecutionLeaseTtlForTimeout?.(timeoutMs);
  const operation = {
    workspaceId,
    namespace: options.namespace ?? 'test-process',
    owner: options.owner,
    admissionClass: options.admissionClass ?? 'process',
    demand: options.demand ?? { cpuWeight: 1 },
    idempotencyKey: options.idempotencyKey ?? governedProcessIdempotencyKey(options.owner),
    ...(options.payloadRef ? { payloadRef: options.payloadRef } : {}),
    ...(options.parent ? { parent: options.parent } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(leaseTtlMs != null ? { leaseTtlMs } : {}),
    ...(options.settle ? { settle: options.settle } : {}),
    ...(options.measureActualDemand ? { measureActualDemand: options.measureActualDemand } : {}),
  };
  return api.runGovernedOperation(
    operation,
    (context) => run(context, withGovernedAdmissionContext(env, context), { inherited: false }),
  );
}
