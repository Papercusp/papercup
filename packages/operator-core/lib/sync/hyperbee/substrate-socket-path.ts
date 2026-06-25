/**
 * Absolute, collision-safe IPC socket path for the substrate sidecar (P-006).
 *
 * The relocation's sidecar talks to the main operator over a Unix-domain socket.
 * The path MUST be absolute. The previous CWD-relative `.papercusp/substrate.sock`
 * default did `mkdir '.papercusp'` against `process.cwd()`, which in a PACKAGED
 * deploy is the root-owned install dir (e.g. /usr/lib/Papercusp/sidecar) → the
 * spawn failed `EACCES: permission denied, mkdir '.papercusp'` and silently fell
 * back to in-process, so the relocation never engaged off a dev tree. (Caught by
 * the P-006 live 2-machine rig verify, 2026-06-25.)
 *
 * Resolution: honour PAPERCUSP_SUBSTRATE_IPC_SOCKET when set — the spawner sets it
 * ONCE so the parent IPC client and the spawned child agree on a single path —
 * otherwise an os.tmpdir() path keyed by the MAIN operator pid, so two operators
 * on one box (the packaged two-instance federation smoke) never collide on one
 * socket. Unix socket paths have a ~108-char limit, so the base must stay short
 * (tmpdir), never a deep workspace path.
 */
import * as os from 'node:os';
import * as path from 'node:path';

export const SUBSTRATE_SOCKET_ENV = 'PAPERCUSP_SUBSTRATE_IPC_SOCKET';

export function resolveSubstrateSocketPath(): string {
  const fromEnv = process.env[SUBSTRATE_SOCKET_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.tmpdir(), `papercusp-substrate-${process.pid}.sock`);
}
