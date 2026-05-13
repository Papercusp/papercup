import 'server-only';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sseResponse } from '@restart/sse';
import { getCommand } from '../../../../lib/admin-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 3600;

interface AdminRunVocab extends Record<string, unknown> {
  meta: { commandId: string; label: string; command: string; cwd?: string; pid: number; startedAt: number };
  log: { stream: 'stdout' | 'stderr'; line: string };
  exit: { code: number | null; signal: NodeJS.Signals | null };
  error: { message: string };
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cmdId = url.searchParams.get('cmd');
  if (!cmdId) {
    return new Response('missing ?cmd', { status: 400 });
  }
  const entry = getCommand(cmdId);
  if (!entry) {
    return new Response(`unknown command id: ${cmdId}`, { status: 404 });
  }

  return sseResponse<AdminRunVocab>({
    signal: req.signal,
    heartbeatMs: 15_000,
    initialHeartbeat: true,
    setup: async (sink) => {
      const child = spawn('bash', ['-lc', entry.command], {
        cwd: entry.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '0' },
        detached: true, // own process group so process.kill(-pid) reaches all children
      });

      sink.event('meta', {
        commandId: entry.id,
        label: entry.label,
        command: entry.command,
        cwd: entry.cwd,
        pid: child.pid ?? -1,
        startedAt: Date.now(),
      });

      const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      outRl.on('line', (line) => {
        if (!sink.closed) sink.event('log', { stream: 'stdout', line });
      });
      const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
      errRl.on('line', (line) => {
        if (!sink.closed) sink.event('log', { stream: 'stderr', line });
      });

      child.on('error', (err) => {
        if (!sink.closed) sink.event('error', { message: String(err?.message ?? err) });
      });

      child.on('exit', (code, signal) => {
        if (sink.closed) return;
        sink.event('exit', { code, signal });
        sink.done();
      });

      sink.onClose(() => {
        if (!child.killed && child.exitCode == null) {
          try {
            process.kill(-child.pid!, 'SIGTERM');
          } catch {
            try { child.kill('SIGTERM'); } catch { /* nothing to do */ }
          }
          setTimeout(() => {
            if (!child.killed && child.exitCode == null) {
              try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* nothing to do */ } }
            }
          }, 3000);
        }
      });
    },
  });
}
