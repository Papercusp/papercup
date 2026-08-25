import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  child.stdout?.on('data', (chunk) => emit(chunk.toString('utf8'), mirrorOut));
  child.stderr?.on('data', (chunk) => emit(chunk.toString('utf8'), mirrorErr));
  child.once('error', (error) => {
    finish(1, `[systemd-scope-env-runner] payload spawn failed: ${error.message}\n`);
  });
  // `close`, not `exit`: all stdout/stderr bytes have drained before the final
  // redactor suffix and JOB END marker are committed.
  child.once('close', (code, signal) => {
    finish(signal ? 1 : (code ?? 1));
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
      child.once('error', (error) => {
        process.stderr.write(`[systemd-scope-env-runner] payload spawn failed: ${error.message}\n`);
        process.exitCode = 1;
      });
      child.once('exit', (code, signal) => {
        process.exitCode = signal ? 1 : (code ?? 1);
      });
    }
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
