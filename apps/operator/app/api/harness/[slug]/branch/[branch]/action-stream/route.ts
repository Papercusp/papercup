/**
 * GET /api/harness/<slug>/branch/<branch>/action-stream?runId=&name=
 *
 * Server-Sent Events stream of a single action run. `name` is a query
 * param (not a path segment) so plugin-contributed names with `:` or
 * `/` work.
 *
 * Emits one event per stdout/stderr chunk ('output' or 'stderr'),
 * terminal markers (`action-started`, `action-completed`,
 * `action-failed`), a `done` event on terminal, and a periodic
 * `: heartbeat`.
 *
 * Backed by the in-process branch-action-bus: lib/branch-actions.ts
 * runAction()'s writeLine() publishes each chunk via publish(); this
 * handler subscribes via subscribe(). Sub-millisecond live channel,
 * no 250ms polling, no fs.watch.
 *
 * Backfill on connect: read the log file once + emit any historical
 * markers (so reconnects after a server restart still replay the
 * recent run state). After backfill, live updates come from the bus.
 *
 * Spec: per-branch action registry (substrate piece 3 of 3).
 */
import { promises as fs } from 'node:fs';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { isBranch, runLogPath } from '@/lib/branch-actions';
import { subscribe as subscribeAction } from '@/lib/branch-action-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 1800;

interface Params { params: Promise<{ slug: string; branch: string }> }

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      let pending = '';

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(sse(event, data))); }
        catch { closed = true; }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already */ }
      };

      // Classify a single log-file line into the right SSE event.
      // Used only for backfill; live events arrive pre-classified
      // through the bus envelope's `kind` field.
      const emitLineFromLog = (line: string): boolean => {
        if (line.startsWith('::papercusp::action-started\t')) {
          send('action-started', JSON.parse(line.slice('::papercusp::action-started\t'.length)));
        } else if (line.startsWith('::papercusp::action-completed\t')) {
          send('action-completed', JSON.parse(line.slice('::papercusp::action-completed\t'.length)));
          send('done', { reason: 'terminal-during-backfill', kind: 'completed' });
          close();
          return true;
        } else if (line.startsWith('::papercusp::action-failed\t')) {
          send('action-failed', JSON.parse(line.slice('::papercusp::action-failed\t'.length)));
          send('done', { reason: 'terminal-during-backfill', kind: 'failed' });
          close();
          return true;
        } else if (line.startsWith('::papercusp::stderr\t')) {
          send('stderr', { line: line.slice('::papercusp::stderr\t'.length) });
        } else {
          send('output', { line });
        }
        return false;
      };

      send('attached', { runId, slug, branch, name });

      // 1. Backfill from disk once. The log file is authoritative for
      //    history; the bus only carries recent events.
      try {
        const raw = await fs.readFile(logPath, 'utf8');
        pending = raw;
        let idx;
        while ((idx = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          if (emitLineFromLog(line)) return;
        }
      } catch { /* file not present yet — first event will arrive via bus */ }

      // 2. Subscribe to the in-process bus for live updates.
      const channelKey = `${slug}:${runId}`;
      const sub = subscribeAction(channelKey, (env) => {
        if (closed) return;
        if (env.kind === 'started') {
          send('action-started', env.meta ?? {});
        } else if (env.kind === 'completed') {
          send('action-completed', env.meta ?? {});
          send('done', { reason: 'terminal', kind: 'completed' });
          close();
        } else if (env.kind === 'failed') {
          send('action-failed', env.meta ?? {});
          send('done', { reason: 'terminal', kind: 'failed' });
          close();
        } else if (env.kind === 'stderr') {
          // Bus payload is the raw text chunk; emit lines individually
          // so the client mirrors the legacy line-oriented surface.
          for (const line of env.text.split('\n')) {
            if (line.length > 0) send('stderr', { line });
          }
        } else if (env.kind === 'output') {
          for (const line of env.text.split('\n')) {
            if (line.length > 0) send('output', { line });
          }
        }
      });

      // If the run already terminated (we joined late), the bus's
      // recent ring buffer may carry the terminal event — sub.done
      // tells us up front.
      if (sub.done && !closed) {
        send('done', { reason: 'late-join-terminal', kind: 'unknown' });
        close();
      }

      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(enc.encode(': heartbeat\n\n')); }
        catch { closed = true; }
      }, 15_000);

      req.signal.addEventListener('abort', () => {
        sub.unsubscribe();
        clearInterval(heartbeat);
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
