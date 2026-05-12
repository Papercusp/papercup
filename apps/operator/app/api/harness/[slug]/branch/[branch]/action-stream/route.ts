/**
 * GET /api/harness/<slug>/branch/<branch>/action-stream?runId=&name=
 *
 * Server-Sent Events stream of a single action run. `name` is a query
 * param (not a path segment) so plugin-contributed names with `:` or
 * `/` work.
 *
 * Emits one event per stdout/stderr chunk ('output' or 'stderr'),
 * terminal markers (action-started, action-completed, action-failed),
 * a `done` event on terminal, and 15s heartbeats.
 *
 * Backed by the in-process branch-action-bus (which itself sits on
 * @restart/sse's getChannel). Backfill on connect reads the log file
 * for history; live updates come from the bus.
 */
import { promises as fs } from 'node:fs';
import { sseResponse } from '@restart/sse';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { isBranch, runLogPath } from '@/lib/branch-actions';
import { subscribe as subscribeAction } from '@/lib/branch-action-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// maxDuration must be a literal — Next's segment-config parser can't
// resolve imported constants (ACTION_MAX_DURATION_SEC = 1_800 in @restart/sse).
export const maxDuration = 1_800;

interface Params { params: Promise<{ slug: string; branch: string }> }

interface Events {
  attached: { runId: string; slug: string; branch: string; name: string };
  'action-started': Record<string, unknown>;
  'action-completed': Record<string, unknown>;
  'action-failed': Record<string, unknown>;
  output: { line: string };
  stderr: { line: string };
  done: { reason: string; kind: string };
}

export async function GET(req: Request, { params }: Params) {
  const { slug, branch } = await params;
  if (!isBranch(branch)) return new Response('invalid branch', { status: 400 });
  const url = new URL(req.url);
  const name = url.searchParams.get('name') ?? '';
  const runId = url.searchParams.get('runId');
  if (!name) return new Response('name required', { status: 400 });
  if (!runId) return new Response('runId required', { status: 400 });
  if (!/^run-[A-Za-z0-9_-]+$/.test(runId)) {
    return new Response('invalid runId', { status: 400 });
  }

  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return new Response('unknown project', { status: 404 });

  const logPath = runLogPath(project.path, branch, name, runId);

  return sseResponse<Events>({
    signal: req.signal,
    heartbeatMs: 15_000,
    initialHeartbeat: false,
    setup: async (sink) => {
      sink.event('attached', { runId, slug, branch, name });

      // 1. Backfill from disk. The log file is authoritative for history;
      //    the bus only carries recent events.
      let terminalFromBackfill = false;
      const emitLineFromLog = (line: string): void => {
        if (line.startsWith('::papercusp::action-started\t')) {
          sink.event('action-started', JSON.parse(line.slice('::papercusp::action-started\t'.length)));
        } else if (line.startsWith('::papercusp::action-completed\t')) {
          sink.event('action-completed', JSON.parse(line.slice('::papercusp::action-completed\t'.length)));
          sink.event('done', { reason: 'terminal-during-backfill', kind: 'completed' });
          terminalFromBackfill = true;
        } else if (line.startsWith('::papercusp::action-failed\t')) {
          sink.event('action-failed', JSON.parse(line.slice('::papercusp::action-failed\t'.length)));
          sink.event('done', { reason: 'terminal-during-backfill', kind: 'failed' });
          terminalFromBackfill = true;
        } else if (line.startsWith('::papercusp::stderr\t')) {
          sink.event('stderr', { line: line.slice('::papercusp::stderr\t'.length) });
        } else {
          sink.event('output', { line });
        }
      };

      try {
        const raw = await fs.readFile(logPath, 'utf8');
        for (const line of raw.split('\n')) {
          if (line.length === 0) continue;
          emitLineFromLog(line);
          if (terminalFromBackfill) {
            sink.close();
            return;
          }
        }
      } catch { /* file not present yet — first event arrives via bus */ }

      // 2. Subscribe to the bus for live updates.
      const channelKey = `${slug}:${runId}`;
      const sub = subscribeAction(channelKey, (env) => {
        if (sink.closed) return;
        if (env.kind === 'started') {
          sink.event('action-started', env.meta ?? {});
        } else if (env.kind === 'completed') {
          sink.event('action-completed', env.meta ?? {});
          sink.event('done', { reason: 'terminal', kind: 'completed' });
          sink.close();
        } else if (env.kind === 'failed') {
          sink.event('action-failed', env.meta ?? {});
          sink.event('done', { reason: 'terminal', kind: 'failed' });
          sink.close();
        } else if (env.kind === 'stderr') {
          for (const line of env.text.split('\n')) {
            if (line.length > 0) sink.event('stderr', { line });
          }
        } else if (env.kind === 'output') {
          for (const line of env.text.split('\n')) {
            if (line.length > 0) sink.event('output', { line });
          }
        }
      });
      sink.onClose(sub.unsubscribe);
    },
  });
}
