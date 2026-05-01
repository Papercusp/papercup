/**
 * Provision-runner — orchestrates setup/teardown/verify for one
 * `(harness, plugin)` pair.
 *
 * Responsibilities:
 *   - acquire PG operator-claims lock + heartbeat
 *   - hash check + idempotency decision (configHash, scriptHash, pluginVersion)
 *   - sandbox the script (bwrap on Linux, sandbox-exec on macOS)
 *   - bridge `papercusp_record_resource` shell calls into WAL appends
 *   - capture stdout/stderr to audit log
 *   - update state.json on completion
 *
 * Spec: /docs/snapshots/build-scripts.
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve as pathResolve } from 'node:path';
import { computeConfigHash, computeScriptHash, decideReprovision } from './hashes';
import {
  acquireClaim,
  heartbeatClaim,
  releaseClaim,
  startHeartbeatLoop,
} from './operator-claims';
import { appendAudit, AuditStream } from './audit-log';
import {
  appendWalEntry,
  provisionDir,
  readState,
  writeState,
  type ProvisionState,
  type RecordedResource,
} from './state-store';
import { buildSandbox, type SandboxBuildResult } from './sandbox';
import { buildNetworkPolicy } from './network-policy';

const RUNTIME_LIB_PATH = pathResolve(__dirname, 'runtime/lib.sh');

export interface ProvisionRunInputs {
  harness: string;
  plugin: string;
  /** Plugin's publisher (for audit + trust). */
  publisher: string;
  /** Plugin's version (for idempotency). */
  pluginVersion: string;
  /** Absolute path to the plugin's directory. */
  pluginDir: string;
  /** Plugin's per-harness config (raw object). */
  config: Record<string, unknown>;
  /** Manifest provision section. */
  provision: {
    setup?: { path: string; timeoutSec?: number };
    teardown?: { path: string; timeoutSec?: number };
    verify?: { path: string; timeoutSec?: number };
    cloudProvider?: { id: string; region?: string; regions?: string[] };
    allowedHosts?: string[];
    skipReprovisionOnPatch?: boolean;
    auditLogCapMb?: number;
  };
  /**
   * Confirm consent for this run. The caller (consent UI) is responsible
   * for verifying scriptHash matches an approved entry in the trust store.
   */
  consentConfirmed: boolean;
}

export type ProvisionPhase = 'setup' | 'teardown' | 'verify';

export interface ProvisionRunResult {
  ok: boolean;
  phase: ProvisionPhase;
  decision: ReturnType<typeof decideReprovision>;
  runId?: string;
  exitCode?: number;
  durationMs: number;
  error?: string;
  /** State after the run completed (or null on consent-rejection). */
  state?: ProvisionState;
}

function scratchDir(harness: string, plugin: string): string {
  return join(provisionDir(harness, plugin), 'scratch');
}

async function ensureScratch(harness: string, plugin: string): Promise<string> {
  const d = scratchDir(harness, plugin);
  await fs.mkdir(d, { recursive: true });
  return d;
}

/**
 * Resolve the script path against the plugin dir + check it exists.
 */
async function resolveScript(
  pluginDir: string,
  rel: string,
): Promise<{ path: string; exists: boolean }> {
  const path = pathResolve(pluginDir, rel);
  // Guard: the resolved path must remain inside pluginDir (no `../../`).
  if (!path.startsWith(pluginDir)) {
    return { path, exists: false };
  }
  try {
    await fs.access(path);
    return { path, exists: true };
  } catch {
    return { path, exists: false };
  }
}

/**
 * Run one phase. Returns a structured result; never throws on script
 * failure (the result captures it).
 */
export async function runPhase(
  phase: ProvisionPhase,
  inputs: ProvisionRunInputs,
): Promise<ProvisionRunResult> {
  const t0 = Date.now();
  const scriptDecl =
    phase === 'setup' ? inputs.provision.setup
    : phase === 'teardown' ? inputs.provision.teardown
    : inputs.provision.verify;

  if (!scriptDecl) {
    return {
      ok: false,
      phase,
      decision: 'fresh',
      durationMs: 0,
      error: `no ${phase} script declared`,
    };
  }

  const { path: scriptPath, exists } = await resolveScript(inputs.pluginDir, scriptDecl.path);
  if (!exists) {
    return {
      ok: false,
      phase,
      decision: 'fresh',
      durationMs: 0,
      error: `script not found: ${scriptDecl.path}`,
    };
  }

  // Compute hashes for idempotency decisioning. Setup checks; teardown +
  // verify always run regardless.
  const scriptHash = await computeScriptHash(scriptPath);
  const configHash = computeConfigHash(inputs.config);
  const prior = await readState(inputs.harness, inputs.plugin);

  let decision: ReturnType<typeof decideReprovision> = 'fresh';
  if (phase === 'setup') {
    decision = decideReprovision(prior.hashes, {
      configHash,
      scriptHash,
      pluginVersion: inputs.pluginVersion,
    });
    if (decision === 'unchanged') {
      return { ok: true, phase, decision, durationMs: Date.now() - t0, state: prior };
    }
    if (decision === 'version-patch' && inputs.provision.skipReprovisionOnPatch) {
      // Spec: skipReprovisionOnPatch governs version-patch when scriptHash matches.
      // scriptHash already matched (otherwise we'd be in script-changed).
      return { ok: true, phase, decision, durationMs: Date.now() - t0, state: prior };
    }
  }

  if (!inputs.consentConfirmed) {
    await appendAudit(inputs.harness, inputs.plugin, {
      kind: 'consent-rejected',
      data: { phase, scriptHash },
    }, inputs.provision.auditLogCapMb);
    return {
      ok: false,
      phase,
      decision,
      durationMs: Date.now() - t0,
      error: 'consent not confirmed',
    };
  }

  // Acquire the operator claim (PG-backed cross-machine lock).
  let runId: string;
  let stopHeartbeat: (() => void) | null = null;
  try {
    const claim = await acquireClaim(inputs.harness, inputs.plugin, scriptHash);
    if (!claim.ok) {
      return {
        ok: false,
        phase,
        decision,
        durationMs: Date.now() - t0,
        error: `claim conflict: another operator on machine ${claim.conflict?.machineId} (last heartbeat ${claim.conflict?.secondsSinceHeartbeat}s ago)`,
      };
    }
    runId = claim.runId!;
    if (claim.conflict?.expired) {
      await appendAudit(inputs.harness, inputs.plugin, {
        kind: 'consent-granted',
        runId,
        data: { phase, scriptHash, expiredPriorClaim: claim.conflict },
      }, inputs.provision.auditLogCapMb);
    }
    stopHeartbeat = startHeartbeatLoop(inputs.harness, inputs.plugin, runId);
  } catch (e: unknown) {
    // PG unavailable — fall back to a process-only run. Audit it.
    runId = `local-${Date.now().toString(36)}`;
    await appendAudit(inputs.harness, inputs.plugin, {
      kind: 'consent-granted',
      runId,
      data: { phase, scriptHash, claimError: e instanceof Error ? e.message : String(e), claimMode: 'process-only' },
    }, inputs.provision.auditLogCapMb);
  }

  await appendAudit(inputs.harness, inputs.plugin, {
    kind: phase === 'setup' ? 'setup-started' : phase === 'teardown' ? 'teardown-started' : 'verify-started',
    runId,
    data: { scriptHash, configHash, pluginVersion: inputs.pluginVersion, decision },
  }, inputs.provision.auditLogCapMb);

  const scratch = await ensureScratch(inputs.harness, inputs.plugin);
  const networkPolicy = buildNetworkPolicy({
    cloudProvider: inputs.provision.cloudProvider,
    allowedHosts: inputs.provision.allowedHosts,
  });
  const sandbox = buildSandbox({
    pluginDir: inputs.pluginDir,
    scratchDir: scratch,
    allowedHosts: networkPolicy.allowedHosts,
    env: {
      PAPERCUSP_PLUGIN_DIR: inputs.pluginDir,
      PAPERCUSP_SCRATCH_DIR: scratch,
      PAPERCUSP_RUNTIME_LIB: RUNTIME_LIB_PATH,
      PAPERCUSP_PLUGIN_NAME: inputs.plugin,
      PAPERCUSP_HARNESS_SLUG: inputs.harness,
      PAPERCUSP_PHASE: phase,
      PAPERCUSP_RECORD_FIFO: join(scratch, '.papercusp-record-fifo'),
      // Pass through plugin config as JSON env var.
      PAPERCUSP_CONFIG: JSON.stringify(inputs.config),
      PATH: process.env.PATH ?? '',
      HOME: scratch,
    },
  });

  // Open a FIFO bridge: the substrate watches for record_resource writes
  // and folds them into the WAL in real time. Implementation detail: we
  // create a regular file and tail it; full FIFO support adds complexity
  // not warranted in V1.
  const fifoPath = join(scratch, '.papercusp-record-fifo');
  await fs.writeFile(fifoPath, '');

  const audit = new AuditStream(inputs.harness, inputs.plugin, runId);
  await audit.open();

  const result = await runScript({
    sandbox,
    scriptPath,
    timeoutMs: (scriptDecl.timeoutSec ?? 600) * 1000,
    onStdout: async (line) => {
      // Surface ::papercusp:: markers as their own audit events.
      await audit.write(line);
    },
    onStderr: async (line) => {
      await audit.write('STDERR: ' + line);
    },
    fifoPath,
    walAppender: async (entry) => {
      await appendWalEntry(inputs.harness, inputs.plugin, entry);
      await appendAudit(inputs.harness, inputs.plugin, {
        kind: 'resource-recorded',
        runId,
        data: { kind: entry.kind, externalId: entry.externalId },
      }, inputs.provision.auditLogCapMb);
    },
  });

  await audit.close();
  if (stopHeartbeat) stopHeartbeat();
  if (runId && !runId.startsWith('local-')) {
    try { await releaseClaim(inputs.harness, inputs.plugin, runId); } catch { /* ignore */ }
  }

  // Update state.json with new hashes + outcome.
  const folded = await readState(inputs.harness, inputs.plugin);
  const newState: ProvisionState = {
    ...folded,
    schemaVersion: 1,
    setupFailed: phase === 'setup' ? !result.ok : folded.setupFailed,
    setupError: phase === 'setup' && !result.ok ? result.error ?? `exit ${result.exitCode}` : undefined,
    lastSetupAt: phase === 'setup' && result.ok ? new Date().toISOString() : folded.lastSetupAt,
    lastVerifyAt: phase === 'verify' && result.ok ? new Date().toISOString() : folded.lastVerifyAt,
    hashes: phase === 'setup' && result.ok
      ? { configHash, scriptHash, pluginVersion: inputs.pluginVersion }
      : folded.hashes,
  };
  await writeState(inputs.harness, inputs.plugin, newState);

  await appendAudit(inputs.harness, inputs.plugin, {
    kind: result.ok
      ? (phase === 'setup' ? 'setup-succeeded' : phase === 'teardown' ? 'teardown-succeeded' : 'verify-succeeded')
      : (phase === 'setup' ? 'setup-failed' : phase === 'teardown' ? 'teardown-failed' : 'verify-failed'),
    runId,
    data: { exitCode: result.exitCode, durationMs: Date.now() - t0 },
  }, inputs.provision.auditLogCapMb);

  return {
    ok: result.ok,
    phase,
    decision,
    runId,
    exitCode: result.exitCode ?? undefined,
    durationMs: Date.now() - t0,
    error: result.error,
    state: newState,
  };
}

interface ScriptRunInputs {
  sandbox: SandboxBuildResult;
  scriptPath: string;
  timeoutMs: number;
  onStdout: (line: string) => Promise<void>;
  onStderr: (line: string) => Promise<void>;
  fifoPath: string;
  walAppender: (r: RecordedResource) => Promise<void>;
}

interface ScriptRunResult {
  ok: boolean;
  exitCode: number | null | undefined;
  error?: string;
}

async function runScript(input: ScriptRunInputs): Promise<ScriptRunResult> {
  const argv = input.sandbox.active
    ? [...input.sandbox.argv, '/bin/bash', input.scriptPath]
    : ['/bin/bash', input.scriptPath];
  const [bin, ...rest] = argv;

  // Tail the FIFO file in 200ms ticks; fold each new line into WAL.
  let fifoPos = 0;
  const fifoTimer = setInterval(async () => {
    try {
      const stat = await fs.stat(input.fifoPath);
      if (stat.size > fifoPos) {
        const handle = await fs.open(input.fifoPath, 'r');
        const buf = Buffer.alloc(stat.size - fifoPos);
        await handle.read(buf, 0, buf.length, fifoPos);
        await handle.close();
        fifoPos = stat.size;
        for (const line of buf.toString().split('\n')) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j && j.kind && j.externalId) {
              await input.walAppender(j as RecordedResource);
            }
          } catch {
            // skip
          }
        }
      }
    } catch {
      // fifo missing — fine
    }
  }, 200);

  return await new Promise<ScriptRunResult>((resolve) => {
    const child = spawn(bin, rest, {
      env: input.sandbox.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.stdout || !child.stderr) {
      resolve({ ok: false, exitCode: null, error: 'failed to attach stdout/stderr' });
      return;
    }
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        input.onStdout(line).catch(() => { /* ignore */ });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        input.onStderr(line).catch(() => { /* ignore */ });
      }
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }, input.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(fifoTimer);
      resolve({ ok: false, exitCode: null, error: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(fifoTimer);
      // flush remaining stdout/stderr buffers
      if (stdoutBuf) input.onStdout(stdoutBuf).catch(() => { /* ignore */ });
      if (stderrBuf) input.onStderr(stderrBuf).catch(() => { /* ignore */ });
      if (timedOut) {
        resolve({ ok: false, exitCode: code, error: `timeout` });
      } else {
        resolve({ ok: code === 0, exitCode: code });
      }
    });
  });
}

// Re-export heartbeat for runner consumers that want their own loop.
export { heartbeatClaim };
