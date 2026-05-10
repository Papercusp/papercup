/**
 * GET /api/provision/stream?harness=&plugin=&runId=
 *
 * Server-Sent Events stream of audit-log entries for one
 * (harness, plugin) pair. Backed by:
 *   - On-connect backfill from PG (`harness_shared.provision_audit_log`)
 *   - Live updates via the in-process provision-audit-bus (publish from
 *     `appendAudit()` after each PG INSERT)
 *
 * No file polling, no fs.watch.
 *
 * Backfill: replays the most recent entries (default 200) so a late-
 * attaching client sees what already happened. Pass `?since=<iso-ts>`
 * to start strictly after a known timestamp instead.
 *
 * If `runId` is provided, only entries with a matching runId are
 * emitted (others silently dropped).
 *
 * The connection holds open until the client disconnects OR until a
 * terminal kind (`setup-completed`, `setup-failed`, `teardown-completed`,
 * `teardown-failed`, `verify-completed`, `verify-failed`) is observed
 * for the matching runId — the server emits one final `done` event and
 * closes.
 *
 * Spec: /docs/snapshots/build-scripts (live-stream UI requirement).
 */
import { readAudit, type AuditEntry } from '@/lib/provision/audit-log';
import { subscribe as subscribeAudit } from '@/lib/provision-audit-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 1800;

const DEFAULT_BACKFILL = 200;

const TERMINAL_KINDS = new Set([
  'setup-completed', 'setup-failed',
  'teardown-completed', 'teardown-failed',
  'verify-completed', 'verify-failed',
]);

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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
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

      // Backfill from PG — readAudit() respects the workspace scope
      // and the optional `since` filter. Cap to DEFAULT_BACKFILL when
      // the caller didn't pass `since`.
      let entries: AuditEntry[] = [];
      try {
        entries = await readAudit(harness, plugin, {
          limit: since ? 5_000 : DEFAULT_BACKFILL * 4,
          sinceTs: since,
        });
        if (!since && entries.length > DEFAULT_BACKFILL) {
          entries = entries.slice(-DEFAULT_BACKFILL);
        }
      } catch { /* table missing or transient — continue with empty backfill */ }

      for (const entry of entries) {
        if (runId && entry.runId && entry.runId !== runId) continue;
        send(entry.kind, entry);
        if (entry.runId === runId && TERMINAL_KINDS.has(entry.kind)) {
          send('done', { reason: 'terminal-during-backfill', kind: entry.kind });
          close();
          return;
        }
      }

      send('attached', { harness, plugin, runId });

      // Live: subscribe to the in-process bus. appendAudit() publishes
      // after each PG INSERT.
      const sub = subscribeAudit(`${harness}:${plugin}`, (env) => {
        const entry = env.entry as AuditEntry;
        if (runId && entry.runId && entry.runId !== runId) return;
        send(entry.kind, entry);
        if (entry.runId === runId && TERMINAL_KINDS.has(entry.kind)) {
          send('done', { reason: 'terminal', kind: entry.kind });
          close();
          sub.unsubscribe();
          clearInterval(heartbeat);
        }
      });

      // Heartbeat every 15s so proxies don't drop the connection.
      const heartbeat = setInterval(() => {
        if (closed) { clearInterval(heartbeat); return; }
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
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
