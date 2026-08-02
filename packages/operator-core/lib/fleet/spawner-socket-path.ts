/**
 * Absolute, collision-safe IPC socket path for the SPAWNER sidecar (WI-344 ③,
 * plan spawner-sidecar-offload-2026-06-30).
 *
 * Mirror of `sync/hyperbee/substrate-socket-path.ts`. The spawner sidecar — which
 * owns the agent-spawn fork/exec + `buildInvokeOnce`, offloaded off the bg-host
 * main event loop so it stops saturating routinesTick — talks to the main
 * operator over a Unix-domain socket. The path MUST be absolute: a CWD-relative
 * default does `mkdir '.papercusp'` against `process.cwd()`, which in a PACKAGED
 * deploy is a root-owned install dir → the spawn fails `EACCES` and silently
 * falls back to in-process (the P-006 substrate finding, 2026-06-25).
 *
 * Honour `PAPERCUSP_SPAWNER_IPC_SOCKET` when set — the spawner sets it ONCE before
 * forking so the parent IPC client and the spawned child agree on a single path —
 * otherwise an `os.tmpdir()` path keyed by the MAIN operator pid, so two operators
 * on one box never collide on one socket. Unix socket paths have a ~108-char
 * limit, so the base must stay short (tmpdir), never a deep workspace path.
 */
import * as os from 'node:os';
import * as path from 'node:path';

export const SPAWNER_SOCKET_ENV = 'PAPERCUSP_SPAWNER_IPC_SOCKET';

/** The pid-keyed default name. One definition, used to BUILD and to READ the path. */
const PID_KEYED_SOCKET_RE = /^papercusp-spawner-(\d+)\.sock$/;

export function resolveSpawnerSocketPath(): string {
  const fromEnv = process.env[SPAWNER_SOCKET_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.tmpdir(), `papercusp-spawner-${process.pid}.sock`);
}

/**
 * The pid of the host this socket belongs to, or null when the path is not the
 * pid-keyed default (an explicitly-configured `PAPERCUSP_SPAWNER_IPC_SOCKET`).
 *
 * The pid in the name is not decoration — it is the ONLY record of which host a
 * given sidecar serves, and it is what makes an orphan detectable. When the owner
 * dies the socket keeps its name, so the sidecar can read its own path and ask
 * whether the process it exists to serve is still there (D-011: 49 of 50 live
 * sidecars on this box were answering a socket whose owner was long gone, and
 * nothing could ever reach them again).
 *
 * Null means "not derivable" and must be treated as UNKNOWN — never as orphaned.
 */
export function ownerPidFromSocketPath(socketPath: string): number | null {
  const m = PID_KEYED_SOCKET_RE.exec(path.basename(socketPath));
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
