/**
 * GET /api/harness/<slug>/branch/<branch>/action-stream?runId=&name=
 *
 * Server-Sent Events tail of a single action run's log file. `name` is
 * a query param (not a path segment) so plugin-contributed names with
 * `:` or `/` work.
 *
 * Emits one event per stdout/stderr line ('output' or 'stderr'),
 * terminal markers (`action-started`, `action-completed`, `action-failed`),
 * a `done` event on terminal, and a periodic `: heartbeat`.
 *
 * Spec: per-branch action registry (substrate piece 3 of 3).
 */

import { promises as fs } from 'node:fs';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { isBranch, runLogPath, runMetaPath } from '@/lib/branch-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 1800;

const POLL_INTERVAL_MS = 250;

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

  const reg = loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return new Response('unknown project', { status: 404 });

  const logPath = runLogPath(project.path, branch, name, runId);
  const metaPath = runMetaPath(project.path, branch, name, runId);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      let offset = 0;
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

      // Emit a single line, classifying markers.
      const emitLine = (line: string) => {
        if (line.startsWith('::papercusp::action-started\t')) {
          send('action-started', JSON.parse(line.slice('::papercusp::action-started\t'.length)));
        } else if (line.startsWith('::papercusp::action-completed\t')) {
          send('action-completed', JSON.parse(line.slice('::papercusp::action-completed\t'.length)));
          send('done', { reason: 'terminal', kind: 'completed' });
          close();
        } else if (line.startsWith('::papercusp::action-failed\t')) {
          send('action-failed', JSON.parse(line.slice('::papercusp::action-failed\t'.length)));
          send('done', { reason: 'terminal', kind: 'failed' });
          close();
        } else if (line.startsWith('::papercusp::stderr\t')) {
          send('stderr', { line: line.slice('::papercusp::stderr\t'.length) });
        } else {
          send('output', { line });
        }
      };

      const consume = (text: string) => {
        pending += text;
        let idx;
        while ((idx = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          emitLine(line);
          if (closed) return;
        }
      };

      send('attached', { runId, slug, branch, name });

      const poll = async () => {
        if (closed) return;
        try {
          const stat = await fs.stat(logPath);
          if (stat.size > offset) {
            const fh = await fs.open(logPath, 'r');
            try {
              const buf = Buffer.alloc(stat.size - offset);
              await fh.read(buf, 0, buf.length, offset);
              offset = stat.size;
              consume(buf.toString('utf8'));
            } finally { await fh.close(); }
          } else if (stat.size < offset) {
            offset = 0;
            pending = '';
          }
        } catch { /* file may not exist yet */ }

        // If no terminal marker has fired but the meta says terminal,
        // emit done to unstick clients (e.g. crashed child).
        if (!closed) {
          try {
            const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
            if (meta.status === 'completed' || meta.status === 'failed') {
              // Drain remainder before closing.
              try {
                const stat2 = await fs.stat(logPath);
                if (stat2.size > offset) {
                  const fh = await fs.open(logPath, 'r');
                  try {
                    const buf = Buffer.alloc(stat2.size - offset);
                    await fh.read(buf, 0, buf.length, offset);
                    offset = stat2.size;
                    consume(buf.toString('utf8'));
                  } finally { await fh.close(); }
                }
              } catch { /* ignore */ }
              if (!closed) {
                send('done', { reason: 'meta-terminal', kind: meta.status });
                close();
              }
            }
          } catch { /* meta not flushed yet */ }
        }
      };

      const interval = setInterval(poll, POLL_INTERVAL_MS);
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(enc.encode(': heartbeat\n\n')); }
        catch { closed = true; }
      }, 15_000);

      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
        clearInterval(heartbeat);
        close();
      });

      await poll();
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
