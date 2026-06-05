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

/**
 * Env-only secret resolver — the fallback used when there is no calling
 * plugin to scope the lookup to (first-party tools, in-process callers).
 */
export async function secretImpl(name: string): Promise<string | null> {
  return process.env[name] ?? null;
}

/**
 * Plugin-scoped secret resolver (revive-plugin-system-2026-06-04 D-004).
 *
 * `secretImpl` read ONLY `process.env`, so the encrypted per-(harness,plugin)
 * keys written via `PUT /api/plugins/config` (the "set it via settings" path
 * firecrawl's README promises) were invisible to `ctx.secret`. This resolver
 * reads the calling plugin's `plugin_configs` row FIRST (keyed by manifest
 * name = the projected tool's pluginName = the config-route's canonicalSlug —
 * the same convention the WASM secrets host already uses), then falls back to
 * `process.env`.
 *
 * Precedence: plugin_configs (encrypted, per-plugin, the UI path) > env
 * (process-global, the dev/CI path). The config is loaded at most once per
 * resolver (memoized) so a handler reading several secrets pays one decrypt.
 */
export function makeSecretResolver(scope: {
  harnessSlug: string;
  pluginName: string;
}): (name: string) => Promise<string | null> {
  let cfgPromise: Promise<Record<string, unknown> | null> | undefined;
  const loadCfg = (): Promise<Record<string, unknown> | null> => {
    if (!cfgPromise) {
      // Lazy import so test/CLI contexts without a PG layer don't pay for it
      // unless a secret is actually read. Any failure → null (→ env fallback).
      cfgPromise = (async () => {
        try {
          const { loadPluginConfig } = await import('./plugin-configs-pg');
          return await loadPluginConfig(scope.harnessSlug, scope.pluginName);
        } catch {
          return null;
        }
      })();
    }
    return cfgPromise;
  };
  return async (name: string): Promise<string | null> => {
    const cfg = await loadCfg();
    const v = cfg?.[name];
    if (typeof v === 'string' && v.length > 0) return v;
    return process.env[name] ?? null;
  };
}
