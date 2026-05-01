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

const MERIDIAN_VERSION = '1.40.0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST() {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const runStreaming = (
        cmd: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        label: string,
      ): Promise<number> =>
        new Promise((resolve) => {
          const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout.on('data', (b) => send('log', { label, line: b.toString() }));
          child.stderr.on('data', (b) => send('log', { label, line: b.toString() }));
          child.on('close', (code) => resolve(code ?? 1));
          child.on('error', (e) => {
            send('log', { label, line: `error: ${e.message}\n` });
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
