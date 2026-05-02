import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * One-click "Install Claude + Meridian" for desktop builds.
 *
 * The Claude CLI ships under Anthropic's Commercial Terms of Service
 * — "all rights reserved" — so we don't redistribute the binary
 * inside our installer. Meridian (rynfar/meridian, MIT) is also not
 * vendored because it depends on @anthropic-ai/claude-code and would
 * pull the Claude binary into our installer transitively.
 *
 * Instead, this route runs the *official* installers on demand:
 *
 *   1. Claude CLI: curl -fsSL https://claude.ai/install.sh | bash
 *      (install.ps1 on Windows). This is Anthropic's published install
 *      flow; the binary downloads from downloads.claude.ai under the
 *      user's existing personal-use license.
 *   2. Meridian: npm install -g @rynfar/meridian@<pinned> using the
 *      bundled Node + npm at sidecar/bin/.
 *
 * Streams progress as Server-Sent Events so the UI can show a live log.
 */

const MERIDIAN_VERSION = '1.41.1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST() {
  // Track the in-flight child so we can kill it if the client disconnects
  // mid-stream. Without this, an abandoned tab leaks a real installer
  // process that keeps writing to ~/.claude / ~/.papercusp/runtime even
  // though nobody is listening to the SSE log.
  let activeChild: ReturnType<typeof spawn> | null = null;
  let aborted = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        if (aborted) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // controller already closed (client disconnected); swallow.
          aborted = true;
        }
      };

      const runStreaming = (
        cmd: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        label: string,
        // Per-step deadline. A hung claude installer (network stall) or
        // npm install (lockfile contention) shouldn't keep the SSE
        // stream open forever, blocking the user's "Install" button.
        // 8 min covers the slowest realistic case (cold meridian install
        // with claude-code postinstall on slow links) with margin.
        timeoutMs: number = 8 * 60 * 1000,
      ): Promise<number> =>
        new Promise((resolve) => {
          if (aborted) return resolve(130);
          // detached + own process group so we can SIGTERM the *whole*
          // tree on cancel — without it, only `bash` dies and the curl
          // + installer it spawned keep running as PPID=1 orphans.
          const child = spawn(cmd, args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          });
          activeChild = child;

          const watchdog = setTimeout(() => {
            send('log', {
              label,
              line: `error: ${label} step timed out after ${timeoutMs / 1000}s — killing\n`,
            });
            try {
              if (child.pid) process.kill(-child.pid, 'SIGTERM');
              else child.kill('SIGTERM');
            } catch { /* dead already */ }
            // Escalate to SIGKILL after a short grace period if SIGTERM
            // doesn't take. Some installers trap SIGTERM and try to
            // unwind; we don't want to wait minutes more.
            setTimeout(() => {
              try {
                if (child.pid) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
              } catch { /* dead */ }
            }, 5000);
          }, timeoutMs);

          child.stdout.on('data', (b) => send('log', { label, line: b.toString() }));
          child.stderr.on('data', (b) => send('log', { label, line: b.toString() }));
          child.on('close', (code) => {
            clearTimeout(watchdog);
            if (activeChild === child) activeChild = null;
            resolve(code ?? 1);
          });
          child.on('error', (e) => {
            clearTimeout(watchdog);
            send('log', { label, line: `error: ${e.message}\n` });
            if (activeChild === child) activeChild = null;
            resolve(1);
          });
        });

      try {
        const isWin = platform() === 'win32';

        // Step 1: install claude via Anthropic's official installer.
        send('step', { name: 'claude', status: 'running' });
        const installScriptUrl = isWin
          ? 'https://claude.ai/install.ps1'
          : 'https://claude.ai/install.sh';
        send('log', {
          label: 'claude',
          line: `→ fetching ${installScriptUrl}\n`,
        });

        let claudeRc: number;
        if (isWin) {
          // PowerShell: iwr | iex pattern
          claudeRc = await runStreaming(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy', 'Bypass',
              '-Command',
              `Invoke-WebRequest -UseBasicParsing -Uri '${installScriptUrl}' | Select-Object -ExpandProperty Content | Invoke-Expression`,
            ],
            process.env,
            'claude',
          );
        } else {
          // Bash: curl | bash. install.sh writes to ~/.claude/bin/claude
          // and adds it to shell rc files, but our preflight resolves via
          // PATH so we ensure ~/.claude/bin is on PATH below.
          claudeRc = await runStreaming(
            'bash',
            ['-c', `curl -fsSL '${installScriptUrl}' | bash`],
            process.env,
            'claude',
          );
        }
        send('step', {
          name: 'claude',
          status: claudeRc === 0 ? 'ok' : 'failed',
          code: claudeRc,
        });
        if (claudeRc !== 0) {
          send('done', { ok: false, reason: 'claude installer exited non-zero' });
          controller.close();
          return;
        }

        // Step 2: install meridian via bundled npm.
        send('step', { name: 'meridian', status: 'running' });

        // Use a per-workspace install root so meridian + its claude-code
        // dep don't pollute the user's global node_modules. The launcher
        // we drop in sidecar/bin/meridian* points here at runtime.
        const root = process.env.HOME || homedir();
        const installRoot = join(root, '.papercusp', 'runtime');
        mkdirSync(installRoot, { recursive: true });

        // Bootstrap a local package.json so npm has somewhere to install.
        const { writeFileSync } = await import('node:fs');
        writeFileSync(
          join(installRoot, 'package.json'),
          JSON.stringify(
            {
              name: 'papercusp-runtime',
              version: '0.0.0',
              private: true,
              dependencies: { '@rynfar/meridian': MERIDIAN_VERSION },
            },
            null,
            2,
          ),
        );

        // Resolve npm: prefer bundled (sidecar/bin/npm), fall back to PATH.
        const npmCmd = isWin ? 'npm.cmd' : 'npm';
        const meridianRc = await runStreaming(
          npmCmd,
          ['install', '--prefix', installRoot, '--no-audit', '--no-fund'],
          process.env,
          'meridian',
        );
        send('step', {
          name: 'meridian',
          status: meridianRc === 0 ? 'ok' : 'failed',
          code: meridianRc,
        });
        if (meridianRc !== 0) {
          send('done', { ok: false, reason: 'meridian install failed' });
          controller.close();
          return;
        }

        // Sanity-check: claude binary exists on PATH (or in ~/.claude/bin).
        const claudePaths = [
          join(root, '.claude', 'bin', isWin ? 'claude.exe' : 'claude'),
          join(installRoot, 'node_modules', '.bin', isWin ? 'claude.cmd' : 'claude'),
        ];
        const claudeFound = claudePaths.find((p) => existsSync(p));

        send('done', {
          ok: true,
          claudePath: claudeFound ?? null,
          meridianRoot: installRoot,
          hint: claudeFound
            ? 'Claude + Meridian installed. Restart the app for the preflight check to pick up the new binary.'
            : 'Install completed but claude binary not found at expected paths. Run `claude --version` in a new terminal to verify.',
        });
        controller.close();
      } catch (e: any) {
        send('done', { ok: false, reason: String(e?.message ?? e) });
        controller.close();
      }
    },
    cancel() {
      // Client disconnected (closed tab, navigated away, lost network).
      // Kill the in-flight installer process tree so we don't keep
      // writing to ~/.claude / ~/.papercusp/runtime with no UI watching.
      // SIGTERM the negative pid to hit the whole process group (we
      // spawned with `detached: true` for exactly this reason).
      aborted = true;
      if (activeChild?.pid) {
        try {
          process.kill(-activeChild.pid, 'SIGTERM');
        } catch {
          try { activeChild.kill('SIGTERM'); } catch { /* dead already */ }
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
