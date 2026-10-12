/** Native executable custody stays outside a browser's unprivileged user namespace. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { isCliEntry } from './util/cli-entry';
import { readProcessIdentity, linuxProcStateFromStat } from './process-identity.ts';
import type { RecordedRuntimeEnvironment } from '@papercusp/test-config/execution-details';

type RuntimeReader = () => RecordedRuntimeEnvironment | null;

function nativeIdentity(root: string, commit: string | null) {
  // Database isolation authorizes fixture writes; it does not establish native
  // ownership. Shared read-only journeys use the same frozen source and kernel
  // custody checks without claiming an isolated database.
  if (!process.env.VERIFY_TAURI_PID || !process.env.VERIFY_TAURI_SOURCE_RECEIPT
    || !process.env.VERIFY_TAURI_SOURCE_REF || !process.env.OPERATOR_SOURCE_ROOT)
    throw new Error('native runtime requires owned verifier source custody');
  const pid = Number(process.env.VERIFY_TAURI_PID);
  const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0 || !commit || !/^[a-f0-9]{40,64}$/.test(commit)
    || receipt.schemaVersion !== 'verifier-source-v1' || receipt.sourceCommit !== commit
    || receipt.sourceCommit !== process.env.VERIFY_TAURI_SOURCE_REF
    || !process.env.OPERATOR_SOURCE_ROOT
    || realpathSync(root) !== realpathSync(process.env.OPERATOR_SOURCE_ROOT)) throw new Error('native runtime source receipt mismatch');
  return { pid, root: realpathSync(root), commit };
}

/** Synchronous kernel observation; Playwright does not await its onBegin hook. */
export function prepareLocalNativeRuntimeReader(root: string, commit: string | null): RuntimeReader {
  const { pid } = nativeIdentity(root, commit);
  const units = [`verify-tauri-headless:${pid}`];
  const processIdentity = readProcessIdentity(pid);
  if (!processIdentity || process.platform !== 'linux') throw new Error('native kernel identity unavailable');
  const executable = `/proc/${pid}/exe`;
  const executableStat = () => {
    const stat = statSync(executable, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  };
  const originalStat = executableStat();
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify([
    units[0], pid, processIdentity, originalStat, digest, commit,
  ])).digest('hex');
  const read = (): RecordedRuntimeEnvironment | null => {
    try {
      const state = linuxProcStateFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      if (!state || ['Z', 'X', 'x'].includes(state) || readProcessIdentity(pid) !== processIdentity
        || executableStat() !== originalStat || readProcessIdentity(pid) !== processIdentity) return null;
      return { schemaVersion: 1, units, fingerprint, observedAt: new Date().toISOString() };
    } catch { return null; }
  };
  if (!read()) throw new Error('native process changed while measuring executable');
  return read;
}

// A Unix socket crosses the network/user namespace without weakening proc/exe checks.
// Each request observes the original process NOW; no saved witness is replayed.
const observerClient = `
const net = require('node:net');
const socket = net.createConnection(process.argv[1]);
let body = '';
socket.setTimeout(5000, () => socket.destroy(new Error('native observer timeout')));
socket.on('connect', () => socket.end(process.argv[2]));
socket.on('data', chunk => { body += chunk; if (body.length > 8192) socket.destroy(new Error('native observer response too large')); });
socket.on('end', () => process.stdout.write(body));
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
`;

export function prepareNativeRuntimeReader(root: string, commit: string | null): RuntimeReader | undefined {
  if (!process.env.VERIFY_TAURI_PID) return undefined;
  const identity = nativeIdentity(root, commit);
  const socket = process.env.PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET;
  if (!socket) return prepareLocalNativeRuntimeReader(root, commit);
  const read = (): RecordedRuntimeEnvironment | null => {
    const response = JSON.parse(execFileSync(process.execPath, ['-e', observerClient, socket, JSON.stringify(identity)],
      { encoding: 'utf8', timeout: 7000, maxBuffer: 8192 }));
    if (response.ok !== true) throw new Error(response.error ?? 'native observer refused identity');
    return response.witness;
  };
  if (!read()) throw new Error('native observer cannot verify the original process');
  return read;
}

export function serveNativeRuntimeObserver(socket: string) {
  const root = process.env.OPERATOR_SOURCE_ROOT!;
  const commit = process.env.VERIFY_TAURI_SOURCE_REF!;
  const identity = nativeIdentity(root, commit);
  const read = prepareLocalNativeRuntimeReader(root, commit);
  const server = createServer({ allowHalfOpen: true }, connection => {
    let body = '';
    connection.setTimeout(5000, () => connection.destroy());
    connection.on('error', () => {});
    connection.on('data', chunk => { body += chunk; if (body.length > 4096) connection.destroy(); });
    connection.on('end', () => {
      try {
        const requested = JSON.parse(body);
        if (requested.pid !== identity.pid || requested.root !== identity.root || requested.commit !== identity.commit)
          throw new Error('native observer source/process identity mismatch');
        connection.end(JSON.stringify({ ok: true, witness: read() }));
      } catch (error) { connection.end(JSON.stringify({ ok: false, error: String(error) })); }
    });
  });
  server.on('error', error => { console.error(error); process.exitCode = 1; });
  server.listen(socket, () => chmodSync(socket, 0o600));
  return server;
}

if (isCliEntry(import.meta.url) && process.argv[2] === '--observe-native') {
  try { serveNativeRuntimeObserver(process.argv[3]!); }
  catch (error) { console.error(`Native runtime observer preparation failed: ${String(error)}`); process.exitCode = 1; }
}
