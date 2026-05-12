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
import { existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

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

export async function POST(req: NextRequest): Promise<Response> {
  if (!isLoopback(req)) {
    return Response.json({ status: 'error', error: 'loopback only' }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { slug?: string | null };

  // 1. Build the same envelope we'd hand to Tauri.
  let envelope;
  try {
    envelope = await buildConsoleEnvelope({
      workspaceId: activeWorkspaceId(),
      slug: body.slug ?? null,
      operatorBaseUrl: new URL(req.url).origin,
    });
  } catch (e: any) {
    return Response.json({ status: 'error', error: e?.message ?? 'envelope build failed' }, { status: 400 });
  }

  // 2. Write .mcp.json to cwd (backup-restore is intentionally NOT done
  //    server-side — the sentinel-file cleanup pattern lives in the
  //    Tauri spawner; for the server-spawn fallback we accept that the
  //    user's `.mcp.json` stays in place until manually removed).
  try {
    const mcpPath = join(envelope.cwd, '.mcp.json');
    if (existsSync(mcpPath)) {
      const bak = join(envelope.cwd, '.mcp.json.papercusp.bak');
      if (!existsSync(bak)) renameSync(mcpPath, bak);
    }
    writeFileSync(mcpPath, envelope.mcpJsonContents);
  } catch (e: any) {
    return Response.json({ status: 'error', error: `write .mcp.json: ${e?.message}` }, { status: 500 });
  }

  // 3. Find a terminal and spawn it.
  if (process.platform !== 'linux') {
    return Response.json(
      { status: 'error', error: 'server-side spawn only implemented for Linux; use the Tauri path on macOS/Windows' },
      { status: 501 },
    );
  }
  const term = findLinuxTerminal();
  if (!term) {
    return Response.json(
      { status: 'error', error: 'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm' },
      { status: 500 },
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
    return Response.json({
      status: 'ok',
      pid: child.pid,
      terminal: term.bin,
    });
  } catch (e: any) {
    return Response.json(
      { status: 'error', error: `spawn ${term.bin} failed: ${e?.message}` },
      { status: 500 },
    );
  }
}
