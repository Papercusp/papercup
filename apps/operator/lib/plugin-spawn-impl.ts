/**
 * Shared plugin-tool runtime helpers used by both transports
 * (apps/operator/app/api/[transport]/route.ts for MCP and
 * apps/operator/app/api/plugins/[...path]/route.ts for HTTP).
 *
 * Lifted out of the MCP route so the HTTP catch-all can use the same
 * subprocess + secret resolution. Without this, plugin tools that shell
 * out (repomix, code2prompt) only worked over MCP and silently failed
 * over HTTP.
 */
import { spawn as childSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import type { PluginSpawn } from '@papercusp/plugin-sdk';

/**
 * The operator sidecar is launched by the Tauri shell / a systemd dev unit
 * with a minimal PATH that frequently omits the directory where `node`/`npx`
 * actually live (Homebrew, nvm). Plugin tools shell out by basename (e.g.
 * repomix → `npx`), so a bare spawn fails with `spawn npx ENOENT`. Augment
 * PATH with the running node's own bin dir + well-known locations, and
 * absolutize the basename so resolution never depends on the supervisor's
 * PATH. (Same absolute-path discipline as setup-pty-commands.ts.)
 */
export function augmentedSpawnPath(): string {
  const extra = [
    dirname(process.execPath), // the running node → its sibling npx/npm
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    process.env.HOME ? join(process.env.HOME, '.local/bin') : '',
  ];
  const seen = new Set<string>();
  return [...(process.env.PATH ?? '').split(delimiter), ...extra]
    .filter((d) => d && !seen.has(d) && (seen.add(d), true))
    .join(delimiter);
}

/** Resolve a basename to an absolute path against `path`; returns the bare
 * name if not found so libuv still surfaces a clear ENOENT. */
export function resolveBin(bin: string, path: string): string {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, bin);
    if (existsSync(cand)) return cand;
  }
  return bin;
}

export const pluginSpawnImpl: PluginSpawn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    if (bin.startsWith('/') || bin.startsWith('.')) {
      reject(new Error(`spawn rejected absolute/relative path "${bin}"; use binary basename`));
      return;
    }
    const spawnPath = augmentedSpawnPath();
    const child = childSpawn(resolveBin(bin, spawnPath), [...args], {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env ?? {}), PATH: spawnPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const limit = opts?.maxBufferBytes ?? 1024 * 1024;
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); if (stdout.length > limit) child.kill(); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); if (stderr.length > limit) child.kill(); });
    if (opts?.stdin !== undefined) child.stdin?.end(opts.stdin as never);
    else child.stdin?.end();
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, killed }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

export async function secretImpl(name: string): Promise<string | null> {
  return process.env[name] ?? null;
}
