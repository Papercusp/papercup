/**
 * Endpoint-IPC socket discovery file — the DEV counterpart to the stdout
 * `PAPERCUSP_IPC_READY socket=<path>` handshake.
 *
 * In the packaged desktop, Tauri spawns the operator as a sidecar with piped
 * stdout and reads the ready line to learn the IPC socket path. In DEV
 * (`npm run dev`), the desktop points its webview at an *externally*-run
 * operator (systemd `papercup-dev-api.service` or `dev:operator`) and so can
 * NOT read that operator's stdout. Without the socket path the Rust side
 * can't open the IPC client, `ipcFetch` falls back to native HTTP, and the
 * webview's on-demand `/api/*` fetches starve behind the long-lived SSE
 * streams in libsoup's 6-socket-per-origin pool — the Plans-tab
 * "loading… forever" bug.
 *
 * Fix: the operator publishes its resolved socket path to
 * `~/.papercusp/endpoint-ipc.json` on boot; the dev desktop polls + reads it
 * (see papercusp-desktop `main.rs` dev branch). Same `~/.papercusp/*.json`
 * convention as `embedded-pg.json`. Writing it in the packaged build too is
 * harmless (that path uses the stdout handshake) and keeps one code path.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const REL_DIR = '.papercusp';
const REL_FILE = 'endpoint-ipc.json';

/** Absolute path to the discovery file under the (real) user home. */
export function endpointIpcDiscoveryPath(): string {
  return join(homedir(), REL_DIR, REL_FILE);
}

export interface EndpointIpcDiscovery {
  /** Unix-socket / named-pipe path the IPC server is listening on. */
  socketPath: string;
  /** Operator pid that owns the socket (lets a reader detect a stale file). */
  pid: number;
  /** Epoch-ms the server came up. */
  startedAt: number;
}

/** Publish the resolved socket path. Best-effort; throws only on FS failure. */
export async function writeEndpointIpcDiscovery(socketPath: string): Promise<void> {
  await mkdir(join(homedir(), REL_DIR), { recursive: true });
  const payload: EndpointIpcDiscovery = {
    socketPath,
    pid: process.pid,
    startedAt: Date.now(),
  };
  await writeFile(endpointIpcDiscoveryPath(), JSON.stringify(payload, null, 2), 'utf8');
}

/** Read the discovery file, or null when missing/corrupt. */
export async function readEndpointIpcDiscovery(): Promise<EndpointIpcDiscovery | null> {
  try {
    const txt = await readFile(endpointIpcDiscoveryPath(), 'utf8');
    const j = JSON.parse(txt) as Partial<EndpointIpcDiscovery>;
    if (typeof j?.socketPath === 'string' && j.socketPath) {
      return {
        socketPath: j.socketPath,
        pid: Number(j.pid) || 0,
        startedAt: Number(j.startedAt) || 0,
      };
    }
  } catch {
    /* missing / unreadable / corrupt → null */
  }
  return null;
}
