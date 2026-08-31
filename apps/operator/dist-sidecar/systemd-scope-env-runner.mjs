import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/**
 * Reserved fields carried inside the existing systemd credential payload. They
 * are consumed by this runner and removed before the workload is spawned, so a
 * caller cannot forge a sink path and neither the path nor redaction values
 * leak into the workload environment.
 */
export const SYSTEMD_RUNNER_OUTPUT_PATH_ENV = 'PAPERCUSP_SYSTEMD_RUNNER_OUTPUT_PATH';
export const SYSTEMD_RUNNER_REDACTIONS_ENV = 'PAPERCUSP_SYSTEMD_RUNNER_REDACTIONS';
export const SYSTEMD_RUNNER_JOB_END_PREFIX = '[capability:bash] JOB END';

function usage(message) {
  process.stderr.write(`[systemd-scope-env-runner] ${message}\n`);
  process.exitCode = 2;
}

/**
 * WI-1064487 — this runner is the transient unit's MAIN process, so systemd delivers the
 * deadline's SIGTERM to IT, and its death closes the payload's stdout/stderr pipes.
 *
 * With no handler installed, node dies immediately. A payload whose TERM trap is deferred
 * behind a foreground child (`sleep 30`, overwhelmingly the common shape) then dies on the
 * broken pipe before its trap ever dispatches — so WI-6677's SIGTERM-before-SIGKILL
 * guarantee silently did not hold for the most common payload there is.
 *
 * Measured on the REAL startBackground path (/tmp/wi1064487-probe/real-path.mts), and the
 * third arm is the control that implicates the PIPE specifically rather than the signal:
 *   `sleep 30`                (foreground child)          14/55 then 2/13 failures
 *   `sleep 30 & wait $!`      (interruptible)             0/54, 0/14
 *   `exec 2>>file; sleep 30`  (stderr off the pipe)       0/20, 0/13
 *
 * Forwarding the signal and STAYING ALIVE until the child closes keeps those pipes open for
 * exactly as long as the payload owes cleanup.
 *
 * ⚠ BEHAVIOUR CHANGE, fleet-wide: a payload that IGNORES SIGTERM now keeps its unit alive
 * until systemd's SIGKILL at TimeoutStopSec=10s, where previously the runner died at once and
 * the cgroup was torn down immediately. That grace is what WI-6677 promises; it is not a
 * regression, but it is a real change for every confined job.
 */
function forwardTerminationSignalsTo(child) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // The child is already gone; its close handler owns the exit code.
      }
    });
  }
}

/**
 * WI-1064487 — a signal death used to collapse to exit 1, which made "the payload was
 * terminated" indistinguishable from "the payload failed". Report the shell convention
 * (128 + signal number) so 143 (SIGTERM) and 137 (SIGKILL) stay distinguishable — that
 * distinction is what bash-jobs.test.ts's legend is meant to read.
 */
function exitCodeFor(code, signal) {
  if (!signal) return code ?? 1;
  return 128 + (constants.signals[signal] ?? constants.signals.SIGTERM);
}

function readEnvironment(sourcePath) {
  const records = readFileSync(sourcePath);
  const environment = {};
  for (const record of records.toString('utf8').split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('=');
    if (separator <= 0) throw new Error('invalid environment payload');
    environment[record.slice(0, separator)] = record.slice(separator + 1);
  }
  return environment;
}

/**
 * Chunk-boundary-safe exact-value redaction shared with capability:bash. The
 * runner needs the SAME implementation because it owns the durable log after a
 * transient service is admitted; keeping a second near-copy here would let the
 * live stream and restart-surviving log silently diverge on boundary cases.
 */
export function createStreamingSecretRedactor(values) {
  const secrets = [...new Set((values ?? []).filter((value) => typeof value === 'string' && value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (secrets.length === 0) return null;

  const longest = secrets[0].length;
  const marker =
    ['[REDACTED integration credential]', '[REDACTED]', '<removed>'].find((candidate) =>
      secrets.every((secret) => !candidate.includes(secret)),
    ) ??
    (() => {
      for (let codePoint = 0xe000; codePoint <= 0x10ffff; codePoint += 1) {
        const candidate = String.fromCodePoint(codePoint);
        if (secrets.every((secret) => !secret.includes(candidate))) return candidate.repeat(8);
      }
      throw new Error('unable to construct a non-secret redaction marker');
    })();
  let pending = '';

  const scan = (input, startLimit) => {
    let output = '';
    let index = 0;
    while (index < startLimit) {
      const match = secrets.find((secret) => input.startsWith(secret, index));
      if (match) {
        output += marker;
        index += match.length;
      } else {
        output += input[index];
        index += 1;
      }
    }
    return { output, consumed: index };
  };

  return {
    push(chunk) {
      const input = pending + chunk;
      pending = '';
      const safeStartLimit = Math.max(0, input.length - (longest - 1));
      const { output, consumed } = scan(input, safeStartLimit);
      pending = input.slice(consumed);
      return output;
    },
    flush() {
      const input = pending;
      pending = '';
      return scan(input, input.length).output;
    },
  };
}

function decodeRedactions(encoded) {
  if (!encoded) return [];
  const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('invalid durable-output redaction payload');
  }
  return parsed;
}

function bestEffortMirror(stream) {
  let writable = true;
  stream.on('error', () => {
    // `systemd-run --pipe --wait` belongs to the operator host. A host restart
    // closes its read end, but that is not a workload failure: the file-backed
    // sink below remains authoritative and must keep the service alive.
    writable = false;
  });
  return (chunk) => {
    if (!chunk || !writable) return;
    try {
      stream.write(chunk);
    } catch {
      writable = false;
    }
  };
}

function formatJobEnd(exitCode) {
  const status = exitCode === 0 ? 'completed' : 'failed';
  return (
    `\n${SYSTEMD_RUNNER_JOB_END_PREFIX}: status=${status} exit=${exitCode} at ${new Date().toISOString()}` +
    ' — this line was recorded by the transient-service runner; its file-backed sink survives loss of the ' +
    'operator host and is authoritative for durable output.\n'
  );
}

function runDurablePayload(command, args, environment, logPath, redactions) {
  // Truncate once, synchronously, then keep every writer on O_APPEND. The live
  // operator may append a bounded attribution snapshot while this service is
  // running; O_APPEND prevents the runner's next write from overwriting it.
  writeFileSync(logPath, '', { mode: 0o600 });
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  let logHealthy = true;
  log.on('error', () => {
    logHealthy = false;
  });
  const mirrorOut = bestEffortMirror(process.stdout);
  const mirrorErr = bestEffortMirror(process.stderr);
  const redactor = createStreamingSecretRedactor(redactions);
  // WI-972553: keep ONE decoder per stream across `data` events. Decoding each
  // chunk in isolation (`chunk.toString('utf8')`) turns any multi-byte code
  // point that straddles a chunk boundary into U+FFFD — the same defect
  // WI-910499 fixed on the operator's own pipe reader, which never reached this
  // second decode boundary. Corruption committed here reaches BOTH sinks (the
  // authoritative file-backed log and the mirrored pipe), so the operator's
  // downstream decoder cannot recover it. Every `run_in_background` job on a
  // systemd host takes this path.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let settled = false;

  const emit = (raw, mirror) => {
    const safe = redactor?.push(raw) ?? raw;
    if (!safe) return;
    if (logHealthy) log.write(safe);
    mirror(safe);
  };
  const finish = (exitCode, diagnostic = '') => {
    if (settled) return;
    settled = true;
    // Flush each stream's decoder BEFORE the redactor's tail: a code point left
    // incomplete when the child closed must be reported exactly once here
    // rather than dropped, and its replacement still has to pass redaction.
    const stdoutTail = stdoutDecoder.end();
    if (stdoutTail) emit(stdoutTail, mirrorOut);
    const stderrTail = stderrDecoder.end();
    if (stderrTail) emit(stderrTail, mirrorErr);
    if (diagnostic) emit(diagnostic, mirrorErr);
    const tail = redactor?.flush() ?? '';
    if (tail) {
      if (logHealthy) log.write(tail);
      mirrorOut(tail);
    }
    if (logHealthy) log.write(formatJobEnd(exitCode));
    log.end(() => {
      process.exitCode = logHealthy ? exitCode : 1;
    });
  };

  const child = spawn(command, args, { env: environment, stdio: ['inherit', 'pipe', 'pipe'] });
  // WI-1064487: this process owns the payload's stdout/stderr pipes, so it must outlive the
  // deadline signal — otherwise the payload's own TERM trap dies on a broken pipe.
  forwardTerminationSignalsTo(child);
  child.stdout?.on('data', (chunk) => emit(stdoutDecoder.write(chunk), mirrorOut));
  child.stderr?.on('data', (chunk) => emit(stderrDecoder.write(chunk), mirrorErr));
  child.once('error', (error) => {
    finish(1, `[systemd-scope-env-runner] payload spawn failed: ${error.message}\n`);
  });
  // `close`, not `exit`: all stdout/stderr bytes have drained before the final
  // redactor suffix and JOB END marker are committed.
  child.once('close', (code, signal) => {
    finish(exitCodeFor(code, signal));
  });
}

export function main(argv = process.argv) {
  const mode = argv[2];
  const source = argv[3];
  const separator = argv.indexOf('--', 4);
  if ((mode !== '--env-fd-path' && mode !== '--credential') || !source || separator < 0) {
    usage('expected --env-fd-path PATH -- COMMAND or --credential NAME -- COMMAND');
    return;
  }

  try {
    const sourcePath = mode === '--credential' ? join(process.env.CREDENTIALS_DIRECTORY ?? '', source) : source;
    if (mode === '--credential' && !process.env.CREDENTIALS_DIRECTORY) {
      throw new Error('credential directory is unavailable');
    }
    const environment = readEnvironment(sourcePath);
    const logPath = environment[SYSTEMD_RUNNER_OUTPUT_PATH_ENV] ?? '';
    const redactions = decodeRedactions(environment[SYSTEMD_RUNNER_REDACTIONS_ENV] ?? '');
    delete environment[SYSTEMD_RUNNER_OUTPUT_PATH_ENV];
    delete environment[SYSTEMD_RUNNER_REDACTIONS_ENV];
    const command = argv[separator + 1];
    const args = argv.slice(separator + 2);
    if (!command) {
      usage('payload command is missing');
    } else if (logPath) {
      runDurablePayload(command, args, environment, logPath, redactions);
    } else {
      const child = spawn(command, args, { env: environment, stdio: 'inherit' });
      // WI-1064487: same grace as the durable branch. stdio is inherited here so there are no
      // pipes of ours to break, but a runner that dies instantly still tears the cgroup down
      // before the payload's trap can run, and the exit code must not collapse to 1.
      forwardTerminationSignalsTo(child);
      child.once('error', (error) => {
        process.stderr.write(`[systemd-scope-env-runner] payload spawn failed: ${error.message}\n`);
        process.exitCode = 1;
      });
      child.once('exit', (code, signal) => {
        process.exitCode = exitCodeFor(code, signal);
      });
    }
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
}

/**
 * This runner is copied verbatim beside host bundles, so it cannot import the TypeScript
 * `isCliEntry` helper. It is also imported by operator-core for its wire constants, which means a
 * raw import.meta.url comparison is unsafe once esbuild inlines it. Pin the only executable copy
 * by its fixed basename instead; an inlined host entry is named hono-host.mjs/serve.mjs and stays
 * inert, while the copied runner still executes under bare node.
 */
export function isDirectSystemdScopeEnvRunnerInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])systemd-scope-env-runner\.mjs$/.test(entryPath);
}

if (isDirectSystemdScopeEnvRunnerInvocation()) {
  main();
}
