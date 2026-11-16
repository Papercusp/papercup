/** Native executable custody stays outside a browser's unprivileged user namespace. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCliEntry } from './util/cli-entry';
import { readProcessIdentity, linuxProcStateFromStat } from './process-identity.ts';
import type { RecordedRuntimeEnvironment } from '@papercusp/test-config/execution-details';

type RuntimeReader = () => RecordedRuntimeEnvironment | null;

/** Name the failed condition, in the original evaluation order: one shared
 * message for all of them made every recurrence undiagnosable and cost a full
 * verifier run per guess. */
function sourceMismatch(root: string, commit: string | null, pid: number,
  receipt: { schemaVersion?: unknown; sourceCommit?: unknown }): string | null {
  const ref = process.env.VERIFY_TAURI_SOURCE_REF;
  if (!Number.isSafeInteger(pid) || pid <= 0) return `VERIFY_TAURI_PID is not a positive integer: ${process.env.VERIFY_TAURI_PID}`;
  if (!commit) return 'caller source commit is unavailable';
  if (!/^[a-f0-9]{40,64}$/.test(commit)) return `caller source commit is not a hex object id: ${commit}`;
  if (receipt.schemaVersion !== 'verifier-source-v1') return `receipt schemaVersion is ${String(receipt.schemaVersion)}`;
  if (receipt.sourceCommit !== commit)
    return `receipt sourceCommit ${String(receipt.sourceCommit)} differs from caller commit ${commit}`;
  if (receipt.sourceCommit !== ref)
    return `receipt sourceCommit ${String(receipt.sourceCommit)} differs from VERIFY_TAURI_SOURCE_REF ${ref}`;
  const callerRoot = realpathSync(root);
  const sourceRoot = realpathSync(process.env.OPERATOR_SOURCE_ROOT!);
  return callerRoot === sourceRoot ? null : `caller root ${callerRoot} differs from OPERATOR_SOURCE_ROOT ${sourceRoot}`;
}

function nativeIdentity(root: string, commit: string | null) {
  // Database isolation authorizes fixture writes; it does not establish native
  // ownership. Shared read-only journeys use the same frozen source and kernel
  // custody checks without claiming an isolated database.
  if (!process.env.VERIFY_TAURI_PID || !process.env.VERIFY_TAURI_SOURCE_RECEIPT
    || !process.env.VERIFY_TAURI_SOURCE_REF || !process.env.OPERATOR_SOURCE_ROOT)
    throw new Error('native runtime requires owned verifier source custody');
  const pid = Number(process.env.VERIFY_TAURI_PID);
  const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
  const mismatch = sourceMismatch(root, commit, pid, receipt);
  if (mismatch) throw new Error(`native runtime source receipt mismatch: ${mismatch}`);
  return { pid, root: realpathSync(root), commit: commit! };
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

function requestNativeRuntimeObserver(socket: string, request: object) {
  const response = JSON.parse(execFileSync(process.execPath, ['-e', observerClient, socket, JSON.stringify(request)],
    { encoding: 'utf8', timeout: 7000, maxBuffer: 8192 }));
  if (response.ok !== true) throw new Error(response.error ?? 'native observer refused identity');
  return response;
}

export function prepareNativeRuntimeReader(root: string, commit: string | null): RuntimeReader | undefined {
  if (!process.env.VERIFY_TAURI_PID) return undefined;
  const identity = nativeIdentity(root, commit);
  const socket = process.env.PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET;
  if (!socket) return prepareLocalNativeRuntimeReader(root, commit);
  const read = (): RecordedRuntimeEnvironment | null => {
    return requestNativeRuntimeObserver(socket, identity).witness;
  };
  if (!read()) throw new Error('native observer cannot verify the original process');
  return read;
}

/** Run the owned launch guard where host proc access is available. */
export function assertNativeRuntimeLiveness(root: string, commit: string | null): RecordedRuntimeEnvironment {
  const identity = nativeIdentity(root, commit);
  const socket = process.env.PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET;
  if (socket) {
    const response = requestNativeRuntimeObserver(socket, { ...identity, action: 'liveness' });
    if (response.alive !== true || !response.witness)
      throw new Error('native liveness observer did not verify custody');
    return response.witness;
  }
  const check = process.env.VERIFY_TAURI_LIVENESS_CHECK;
  if (!check) throw new Error('native liveness check is unavailable');
  const read = prepareLocalNativeRuntimeReader(root, commit);
  execFileSync('bash', [check], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
  const witness = read();
  if (!witness) throw new Error('native process changed during liveness check');
  return witness;
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
        if (requested.action === 'liveness') {
          if (!read()) throw new Error('native observer original process is no longer live');
          const check = process.env.VERIFY_TAURI_LIVENESS_CHECK;
          if (!check) throw new Error('native observer liveness check is unavailable');
          const env = { ...process.env };
          // Execute the original generated guard in this host namespace;
          // removing the socket prevents recursively calling the observer.
          delete env.PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET;
          execFileSync('bash', [check], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
          const witness = read();
          if (!witness) throw new Error('native observer process changed during liveness check');
          connection.end(JSON.stringify({ ok: true, alive: true, witness }));
          return;
        }
        if (requested.action !== undefined) throw new Error('native observer action is unsupported');
        connection.end(JSON.stringify({ ok: true, witness: read() }));
      } catch (error) { connection.end(JSON.stringify({ ok: false, error: String(error) })); }
    });
  });
  server.on('error', error => { console.error(error); process.exitCode = 1; });
  server.listen(socket, () => chmodSync(socket, 0o600));
  return server;
}

/** Keep kernel custody in the caller's namespace for the entire guard command. */
async function withNativeRuntimeObserver(command: string[]): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), 'native-runtime-observer-'));
  const socket = join(work, 'runtime.sock');
  let server: ReturnType<typeof serveNativeRuntimeObserver> | undefined;
  try {
    server = serveNativeRuntimeObserver(socket);
    await once(server, 'listening');
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command[0]!, command.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET: socket },
      });
      const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
      const handlers = signals.map(signal => () => { child.kill(signal); });
      signals.forEach((signal, i) => process.on(signal, handlers[i]!));
      const detach = () => signals.forEach((signal, i) => process.off(signal, handlers[i]!));
      child.once('error', error => { detach(); reject(error); });
      child.once('close', (code, signal) => {
        detach();
        resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
      });
    });
  } finally {
    if (server?.listening) await new Promise<void>(done => server!.close(() => done()));
    rmSync(work, { recursive: true, force: true });
  }
}

if (isCliEntry(import.meta.url)) {
  try {
    if (process.argv[2] === '--with-native-observer') {
      if (process.argv[3] !== '--' || !process.argv[4]) throw new Error('native observer requires -- and a command');
      void withNativeRuntimeObserver(process.argv.slice(4)).then(code => { process.exitCode = code; })
        .catch(error => { console.error(`Native runtime observer failed: ${String(error)}`); process.exitCode = 1; });
    } else if (process.argv[2] === '--observe-native') serveNativeRuntimeObserver(process.argv[3]!);
    else if (process.argv[2] === '--check-native-liveness') {
      const socket = process.env.PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET;
      if (!socket) throw new Error('native liveness observer is unavailable');
      const identity = nativeIdentity(process.env.OPERATOR_SOURCE_ROOT!, process.env.VERIFY_TAURI_SOURCE_REF!);
      assertNativeRuntimeLiveness(identity.root, identity.commit);
      console.log(`verifier bridge alive: pid=${identity.pid} (host provenance verified)`);
    }
  } catch (error) { console.error(`Native runtime observer failed: ${String(error)}`); process.exitCode = 1; }
}
