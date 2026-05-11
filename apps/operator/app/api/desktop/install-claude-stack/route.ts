import { NextRequest } from 'next/server';
import { spawn } from 'node:child_process';
import { sseResponse } from '@restart/sse';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * One-click "Install AI Stack" for desktop builds — claude + meridian + omp.
 *
 * The Claude CLI ships under Anthropic's Commercial Terms of Service
 * — "all rights reserved" — so we don't redistribute the binary
 * inside our installer. Meridian and omp are MIT but pulled at install
 * time so users can update via `npm update -g` independent of our
 * desktop release cadence.
 *
 * This route runs the *official* installers on demand:
 *
 *   1. Claude CLI: curl -fsSL https://claude.ai/install.sh | bash
 *      (install.ps1 on Windows). Optional — only needed if the user
 *      switches AGENT_BACKEND to claude-code.
 *   2. Meridian: npm install --prefix <root> @rynfar/meridian@<pinned>.
 *      Routes omp/pi-coding-agent through the user's Claude Max
 *      subscription (via Claude Code SDK) instead of API keys.
 *   3. omp: npm install --prefix <root> @oh-my-pi/cli (latest).
 *      Default agent backend; talks HTTP to meridian on :3456.
 *
 * Streams progress as Server-Sent Events so the UI can show a live log.
 */

const MERIDIAN_VERSION = '1.42.1';
// omp moves fast; track latest from @oh-my-pi/cli rather than pinning.
const OMP_PACKAGE = '@oh-my-pi/cli';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  let activeChild: ReturnType<typeof spawn> | null = null;
  let aborted = false;

  return sseResponse({
    signal: req.signal,
    headers: CORS_HEADERS,
    setup: async (sink) => {
      sink.onClose(() => {
        // Client disconnected (closed tab, navigated away, lost network).
        // Kill the in-flight installer process tree so we don't keep
        // writing to ~/.claude / ~/.papercusp/runtime with no UI watching.
        aborted = true;
        if (activeChild?.pid) {
          try { process.kill(-activeChild.pid, 'SIGTERM'); }
          catch {
            try { activeChild.kill('SIGTERM'); } catch { /* dead already */ }
          }
        }
      });

      const send = (event: string, data: unknown) => {
        if (aborted) return;
        sink.event(event, data as Record<string, unknown>);
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
          sink.done({ ok: false, reason: 'claude installer exited non-zero' });
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
              dependencies: {
                '@rynfar/meridian': MERIDIAN_VERSION,
                [OMP_PACKAGE]: 'latest',
              },
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
          sink.done({ ok: false, reason: 'meridian + omp install failed' });
          return;
        }

        // Step 3: omp install — already installed by the package.json
        // dependency above, but fire a separate step to surface progress
        // and emit a recognisable label in the UI log.
        send('step', { name: 'omp', status: 'running' });
        send('log', { label: 'omp', line: `→ ${OMP_PACKAGE} installed via meridian step\n` });
        const ompBin = join(installRoot, 'node_modules', '.bin', isWin ? 'omp.cmd' : 'omp');
        const ompFound = existsSync(ompBin);
        send('step', {
          name: 'omp',
          status: ompFound ? 'ok' : 'failed',
          code: ompFound ? 0 : 1,
        });
        if (!ompFound) {
          sink.done({ ok: false, reason: `omp binary missing at ${ompBin}` });
          return;
        }

        // Sanity-check: claude binary exists on PATH (or in ~/.claude/bin).
        const claudePaths = [
          join(root, '.claude', 'bin', isWin ? 'claude.exe' : 'claude'),
          join(installRoot, 'node_modules', '.bin', isWin ? 'claude.cmd' : 'claude'),
        ];
        const claudeFound = claudePaths.find((p) => existsSync(p));

        sink.done({
          ok: true,
          claudePath: claudeFound ?? null,
          meridianRoot: installRoot,
          ompPath: ompBin,
          hint: 'AI stack installed (claude + meridian + omp). Next: run `claude login` to authenticate, then start meridian (`meridian` in a terminal). Restart the app afterward.',
        });
      } catch (e: any) {
        sink.done({ ok: false, reason: String(e?.message ?? e) });
      }
    },
  });
}
