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

/** Sanity probe — any GET hit gets logged so we can tell whether
 *  the Tauri webview can reach the operator at all. */
export function GET(req: NextRequest): Response {
  const origin = req.headers.get('origin') ?? '(no-origin)';
  const ua = req.headers.get('user-agent') ?? '(no-ua)';
  dlog(`GET probe origin=${origin} host=${req.headers.get('host')} ua=${ua.slice(0, 60)}`);
  return Response.json(
    { status: 'probe-ok', note: 'use POST to actually spawn a terminal' },
    { headers: CORS_HEADERS },
  );
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
  const body = (await req.json().catch(() => ({}))) as { slug?: string | null };

  let envelope;
  try {
    envelope = await buildConsoleEnvelope({
      workspaceId: activeWorkspaceId(),
      slug: body.slug ?? null,
      operatorBaseUrl: new URL(req.url).origin,
    });
  } catch (e: any) {
    console.warn(`[console-launch] envelope build failed: ${e?.message}`);
    return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
  }

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
