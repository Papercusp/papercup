/**
 * POST /api/agent-mcp/console/launch
 *   body: { slug?: string | null }
 *   returns: { status: 'ok' | 'error', error?: string }
 *
 * Server-side native-console launcher. Originally the launch went
 * through a Tauri command (console_launch), but webkit2gtk's IPC
 * custom-protocol is broken in some Linux dev builds — the user's
 * click silently no-op'd. Bypassing Tauri entirely by having the
 * operator process spawn the terminal is more resilient: the
 * operator is already running as the user with their DISPLAY,
 * PATH, and shell context.
 *
 * Loopback-only, same trust model as the other admin endpoints.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Debug log file so we can diagnose 'click does nothing' without
 * needing access to the Next.js stdout. Remove after the Tauri bug
 * is solved.
 */
const DEBUG_LOG = '/tmp/console-launch.log';
function dlog(line: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort */ }
}

import { NextRequest } from 'next/server';

import { activeWorkspaceId } from '@/lib/workspace-registry';
import { buildConsoleEnvelope } from '@/lib/console-launcher';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isLoopback(req: NextRequest): boolean {
  const host = req.headers.get('host') ?? '';
  if (
    host.startsWith('127.0.0.1:') ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host === 'localhost'
  ) {
    return true;
  }
  return host.endsWith(':3055') || host.endsWith(':3070');
}

/**
 * The Tauri webview can present an origin like `tauri://localhost` even
 * when the page itself was loaded from http://localhost:3055 — that's
 * what breaks vanilla fetch with WebKit's "access control checks".
 * Adding permissive CORS headers is safe here because the endpoint
 * itself is loopback-gated by isLoopback() above. The operator binds
 * to 127.0.0.1 only by default (PAPERCUSP_BIND_HOST).
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
};

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * GET with ?action=spawn — actually spawn a terminal.
 *
 * This is a workaround for Tauri webkit2gtk's broken CORS preflight: a
 * GET via Image().src is a "no-CORS" request that always reaches the
 * server, no preflight, no header dance. The renderer hits this URL
 * via `new Image().src = '...?action=spawn&slug=...'` and the server
 * just spawns. We return a 1x1 transparent PNG so the browser is
 * happy (it expected an image).
 *
 * GET without ?action= is a passive probe (still logged for debugging).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const slug = url.searchParams.get('slug');
  const origin = req.headers.get('origin') ?? '(no-origin)';
  const ua = req.headers.get('user-agent') ?? '(no-ua)';

  if (action !== 'spawn') {
    dlog(`GET probe origin=${origin} host=${req.headers.get('host')} ua=${ua.slice(0, 60)}`);
    return Response.json(
      { status: 'probe-ok', note: 'use ?action=spawn or POST to actually spawn a terminal' },
      { headers: CORS_HEADERS },
    );
  }

  dlog(`GET spawn origin=${origin} host=${req.headers.get('host')} slug=${slug ?? '(null)'} ua=${ua.slice(0, 60)}`);

  if (!isLoopback(req)) {
    return jsonRes({ status: 'error', error: 'loopback only' }, 403);
  }
  try {
    await doSpawn({ slug: slug || null, operatorBaseUrl: new URL(req.url).origin });
  } catch (e: any) {
    dlog(`GET spawn failed: ${e?.message}`);
  }
  // Return a 1x1 transparent PNG so callers using <img src=...> are
  // satisfied. Status 200 with image content-type, no CORS protection
  // needed since this is a "no-CORS" request type.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
  return new Response(png, {
    status: 200,
    headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
  });
}

/** Shared spawn implementation called by both POST and GET. */
async function doSpawn(opts: { slug: string | null; operatorBaseUrl: string }): Promise<void> {
  const envelope = await buildConsoleEnvelope({
    workspaceId: activeWorkspaceId(),
    slug: opts.slug,
    operatorBaseUrl: opts.operatorBaseUrl,
  });
  const mcpPath = join(envelope.cwd, '.mcp.json');
  if (existsSync(mcpPath)) {
    const bak = join(envelope.cwd, '.mcp.json.papercusp.bak');
    if (!existsSync(bak)) renameSync(mcpPath, bak);
  }
  writeFileSync(mcpPath, envelope.mcpJsonContents);
  if (process.platform !== 'linux') throw new Error('linux-only spawn for now');
  const term = findLinuxTerminal();
  if (!term) throw new Error('no terminal emulator found');
  const oneliner = buildOneliner(envelope.cwd, envelope.env, envelope.greetingCmd);
  const childArgs = [...term.args, 'bash', '-lc', oneliner];
  const child = spawn(term.bin, childArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: envelope.cwd,
    env: { ...process.env, ...envelope.env },
  });
  child.unref();
  dlog(`doSpawn launched ${term.bin} pid=${child.pid}`);
}

const LINUX_TERMINALS: Array<[string, string[]]> = [
  ['gnome-terminal', ['--window', '--']],
  ['konsole', ['--new-window', '-e']],
  ['xfce4-terminal', ['--window', '-e']],
  ['alacritty', ['-e']],
  ['kitty', ['--']],
  ['wezterm', ['start', '--always-new-process', '--']],
  ['xterm', ['-e']],
];

function isOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(':');
  // Also check well-known system bins not in the operator's PATH —
  // gnome-terminal etc. live in /usr/bin which the Next.js dev
  // server's path doesn't include.
  paths.push('/usr/bin', '/usr/local/bin');
  return paths.some((p) => existsSync(join(p, bin)));
}

function findLinuxTerminal(): { bin: string; args: string[] } | null {
  const fromEnv = process.env.TERMINAL;
  if (fromEnv && isOnPath(fromEnv)) {
    return { bin: fromEnv, args: ['-e'] };
  }
  for (const [bin, args] of LINUX_TERMINALS) {
    if (isOnPath(bin)) return { bin, args: [...args] };
  }
  return null;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Oneliner for `omp` mode — `cd`, inline-export the NON-secret env,
 * then `exec` the launch command. Secret env (the power-user tokens)
 * is deliberately absent here: it reaches the terminal via the spawn
 * `env` option instead, so it never lands in the oneliner (which is
 * the spawned shell's argv — visible in `ps`). See D-006.
 *
 * `launchCommand` is a fixed trusted literal (`papercusp-omp connect`),
 * not user input, so it is interpolated without escaping.
 */
function buildOmpOneliner(
  cwd: string,
  env: Record<string, string>,
  launchCommand: string,
): string {
  const envExports: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envExports.push(`export ${k}=${shellEscape(v)}`);
  }
  return [`cd ${shellEscape(cwd)}`, ...envExports, `exec ${launchCommand}`].join(' && ');
}

function buildOneliner(cwd: string, env: Record<string, string>, greeting: string): string {
  const envExports: string[] = [];
  if (env.PAPERCUSP_SCRIPTS_DIR) {
    envExports.push(`export PATH=${shellEscape(env.PAPERCUSP_SCRIPTS_DIR)}:\${PATH}`);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envExports.push(`export ${k}=${shellEscape(v)}`);
  }
  const escapedCwd = shellEscape(cwd);
  return [
    `cd ${escapedCwd}`,
    ...envExports,
    `touch .papercup-console-active.$$`,
    `trap 'rm -f .papercup-console-active.$$' EXIT`,
    `(${greeting.replace(/'/g, "'\\''")})`,
    `exec "\${SHELL:-/bin/bash}" -l`,
  ].join(' && ').replace(' && (', ' ; (');
}

function jsonRes(body: unknown, init?: number | ResponseInit): Response {
  const r = Response.json(body, typeof init === 'number' ? { status: init } : init);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

export async function POST(req: NextRequest): Promise<Response> {
  const origin = req.headers.get('origin') ?? '(no-origin)';
  const ua = req.headers.get('user-agent') ?? '(no-ua)';
  dlog(`POST hit origin=${origin} host=${req.headers.get('host')} ua=${ua.slice(0, 60)}`);
  console.log(`[console-launch] POST hit from origin=${origin} host=${req.headers.get('host')}`);

  if (!isLoopback(req)) {
    return jsonRes({ status: 'error', error: 'loopback only' }, 403);
  }
  // Accept either application/json or text/plain (the renderer uses
  // text/plain to avoid a CORS preflight). Parse JSON from the text.
  let body: { slug?: string | null; mode?: 'shell' | 'omp' } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch { /* ignore — empty body is fine */ }

  const mode = body.mode === 'omp' ? 'omp' : 'shell';

  let envelope;
  try {
    envelope = await buildConsoleEnvelope({
      workspaceId: activeWorkspaceId(),
      slug: body.slug ?? null,
      operatorBaseUrl: new URL(req.url).origin,
      mode,
    });
  } catch (e: any) {
    console.warn(`[console-launch] envelope build failed: ${e?.message}`);
    return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
  }

  // ── omp mode — launch papercusp-omp connect ──────────────────────
  if (envelope.mode === 'omp') {
    if (process.platform !== 'linux') {
      return jsonRes(
        { status: 'error', error: 'server-side spawn only implemented for Linux' },
        501,
      );
    }
    if (!isOnPath('papercusp-omp') || !isOnPath('omp')) {
      return jsonRes(
        {
          status: 'error',
          code: 'omp_not_installed',
          error: 'OMP / @papercusp/omp not found on PATH.',
          installCmd: 'npm i -g @oh-my-pi/cli @papercusp/omp',
        },
        200,
      );
    }
    const term = findLinuxTerminal();
    if (!term) {
      return jsonRes(
        { status: 'error', error: 'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm' },
        500,
      );
    }
    const ompOneliner = buildOmpOneliner(
      envelope.cwd,
      envelope.env,
      envelope.launchCommand ?? 'papercusp-omp connect',
    );
    try {
      const child = spawn(term.bin, [...term.args, 'bash', '-lc', ompOneliner], {
        detached: true,
        stdio: 'ignore',
        cwd: envelope.cwd,
        // Tokens ride the env option only — never the oneliner (D-006).
        env: { ...process.env, ...envelope.env, ...(envelope.secretEnv ?? {}) },
      });
      child.unref();
      console.log(`[console-launch] spawned omp agent ${term.bin} pid=${child.pid}`);
      return jsonRes({ status: 'ok', pid: child.pid, terminal: term.bin, mode: 'omp' });
    } catch (e: any) {
      console.warn(`[console-launch] omp spawn ${term.bin} failed: ${e?.message}`);
      return jsonRes(
        { status: 'error', error: `spawn ${term.bin} failed: ${e?.message}` },
        500,
      );
    }
  }

  // ── shell mode (engineer path, unchanged) ────────────────────────
  try {
    const mcpPath = join(envelope.cwd, '.mcp.json');
    if (existsSync(mcpPath)) {
      const bak = join(envelope.cwd, '.mcp.json.papercusp.bak');
      if (!existsSync(bak)) renameSync(mcpPath, bak);
    }
    writeFileSync(mcpPath, envelope.mcpJsonContents);
  } catch (e: any) {
    console.warn(`[console-launch] write .mcp.json failed: ${e?.message}`);
    return jsonRes({ status: 'error', error: `write .mcp.json: ${e?.message}` }, 500);
  }

  if (process.platform !== 'linux') {
    return jsonRes(
      { status: 'error', error: 'server-side spawn only implemented for Linux; use the Tauri path on macOS/Windows' },
      501,
    );
  }
  const term = findLinuxTerminal();
  if (!term) {
    return jsonRes(
      { status: 'error', error: 'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm' },
      500,
    );
  }

  const oneliner = buildOneliner(envelope.cwd, envelope.env, envelope.greetingCmd);
  const childArgs = [...term.args, 'bash', '-lc', oneliner];
  try {
    const child = spawn(term.bin, childArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: envelope.cwd,
      env: { ...process.env, ...envelope.env },
    });
    child.unref();
    console.log(`[console-launch] spawned ${term.bin} pid=${child.pid} cwd=${envelope.cwd}`);
    return jsonRes({
      status: 'ok',
      pid: child.pid,
      terminal: term.bin,
    });
  } catch (e: any) {
    console.warn(`[console-launch] spawn ${term.bin} failed: ${e?.message}`);
    return jsonRes(
      { status: 'error', error: `spawn ${term.bin} failed: ${e?.message}` },
      500,
    );
  }
}
