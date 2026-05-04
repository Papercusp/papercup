/**
 * GET /api/provision/stream?harness=&plugin=&runId=
 *
 * Server-Sent Events stream of audit-log entries for one (harness, plugin)
 * pair. Tails the JSONL audit log file; emits each new entry as an SSE
 * event named after the entry's `kind` (script-output, resource-recorded,
 * setup-started, setup-completed, ...).
 *
 * Backfill behavior: on connect, replays the most recent entries (default
 * 200) so a late-attaching client sees what already happened. Pass
 * `?since=<iso-ts>` to start strictly after a known timestamp instead.
 *
 * If `runId` is provided, only entries with a matching runId are emitted
 * (other entries are silently dropped). Useful when a plugin has multiple
 * runs in its history.
 *
 * The connection holds open until the client disconnects OR until a
 * terminal kind (`setup-completed`, `setup-failed`, `teardown-completed`,
 * `teardown-failed`, `verify-completed`, `verify-failed`) is observed for
 * the matching runId — at which point the server emits one final `done`
 * event and closes.
 *
 * Spec: /docs/snapshots/build-scripts (live-stream UI requirement).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { provisionDir } from '@/lib/provision/state-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 1800; // 30 min — provisioning can take a while

const POLL_INTERVAL_MS = 250;
const DEFAULT_BACKFILL = 200;

const TERMINAL_KINDS = new Set([
  'setup-completed', 'setup-failed',
  'teardown-completed', 'teardown-failed',
  'verify-completed', 'verify-failed',
]);

interface AuditLine {
  ts: string;
  kind: string;
  runId?: string;
  data?: unknown;
}

function auditLogPath(harness: string, plugin: string): string {
  return join(provisionDir(harness, plugin), 'audit.log');
}

function parseLines(text: string): AuditLine[] {
  const out: AuditLine[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as AuditLine);
    } catch { /* skip malformed */ }
  }
  return out;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const harness = url.searchParams.get('harness') ?? '';
  const plugin = url.searchParams.get('plugin') ?? '';
  const runId = url.searchParams.get('runId') ?? undefined;
  const since = url.searchParams.get('since') ?? undefined;
  if (!harness || !plugin) {
    return new Response('harness + plugin required', { status: 400 });
  }
  const path = auditLogPath(harness, plugin);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let lastSize = 0;
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(sseEvent(event, data)));
        } catch { closed = true; }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      // Initial: backfill or since-filtered replay
      try {
        const stat = await fs.stat(path);
        lastSize = stat.size;
        const raw = await fs.readFile(path, 'utf8');
        const all = parseLines(raw);
        let initial = all;
        if (since) {
          initial = all.filter(e => e.ts > since);
        } else if (initial.length > DEFAULT_BACKFILL) {
          initial = initial.slice(-DEFAULT_BACKFILL);
        }
        for (const entry of initial) {
          if (runId && entry.runId && entry.runId !== runId) continue;
          send(entry.kind, entry);
          if (entry.runId === runId && TERMINAL_KINDS.has(entry.kind)) {
            send('done', { reason: 'terminal-during-backfill', kind: entry.kind });
            close();
            return;
          }
        }
      } catch {
        // No audit log yet — that's fine; we'll wait for first writes.
      }

      // Tail loop
      send('attached', { harness, plugin, runId, lastSize });
      const interval = setInterval(async () => {
        if (closed) { clearInterval(interval); return; }
        try {
          const stat = await fs.stat(path);
          if (stat.size === lastSize) return;
          if (stat.size < lastSize) {
            // File shrank (truncate event) — re-read from start
            lastSize = 0;
          }
          const fh = await fs.open(path, 'r');
          try {
            const buf = Buffer.alloc(stat.size - lastSize);
            await fh.read(buf, 0, buf.length, lastSize);
            lastSize = stat.size;
            const newLines = parseLines(buf.toString('utf8'));
            for (const entry of newLines) {
              if (runId && entry.runId && entry.runId !== runId) continue;
              send(entry.kind, entry);
              if (entry.runId === runId && TERMINAL_KINDS.has(entry.kind)) {
                send('done', { reason: 'terminal', kind: entry.kind });
                close();
                clearInterval(interval);
                return;
              }
            }
          } finally {
            await fh.close();
          }
        } catch {
          // File may not exist yet; keep polling.
        }
      }, POLL_INTERVAL_MS);

      // Heartbeat every 15s so proxies don't drop the connection
      const heartbeat = setInterval(() => {
        if (closed) { clearInterval(heartbeat); return; }
        try { controller.enqueue(enc.encode(': heartbeat\n\n')); }
        catch { closed = true; }
      }, 15_000);

      // Close on client abort
      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
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
