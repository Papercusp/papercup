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
import type { PluginSpawn } from '@papercusp/plugin-sdk';

export const pluginSpawnImpl: PluginSpawn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    if (bin.startsWith('/') || bin.startsWith('.')) {
      reject(new Error(`spawn rejected absolute/relative path "${bin}"; use binary basename`));
      return;
    }
    const child = childSpawn(bin, [...args], {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
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
