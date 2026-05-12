/**
 * GET /api/provision/stream?harness=&plugin=&runId=
 *
 * Server-Sent Events stream of audit-log entries for one
 * (harness, plugin) pair. Backed by:
 *   - On-connect backfill from PG (`harness_shared.provision_audit_log`)
 *   - Live updates via the in-process provision-audit-bus (publish from
 *     `appendAudit()` after each PG INSERT)
 *
 * If `runId` is provided, only entries with a matching runId are emitted.
 * The connection closes when a terminal kind for the matching runId is
 * observed (the server emits a final `done` event and closes).
 */
import { sseResponse } from '@restart/sse';
import { readAudit, type AuditEntry } from '@/lib/provision/audit-log';
import { subscribe as subscribeAudit } from '@/lib/provision-audit-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// maxDuration must be a literal — Next's segment-config parser can't
// resolve imported constants (ACTION_MAX_DURATION_SEC = 1_800 in @restart/sse).
export const maxDuration = 1_800;

const DEFAULT_BACKFILL = 200;

const TERMINAL_KINDS = new Set([
  'setup-completed', 'setup-failed',
  'teardown-completed', 'teardown-failed',
  'verify-completed', 'verify-failed',
]);

interface Events {
  // Concrete event names are per-AuditEntry.kind — too dynamic for an exact
  // generic. We use Record-shaped to keep the API flexible while still
  // typing the sink as JSON-payloads-only.
  [eventName: string]: AuditEntry | { reason: string; kind?: string; harness?: string; plugin?: string; runId?: string };
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

  return sseResponse<Events>({
    signal: req.signal,
    heartbeatMs: 15_000,
    initialHeartbeat: false,
    setup: async (sink) => {
      // Backfill from PG. readAudit respects workspace scope + optional `since`.
      let entries: AuditEntry[] = [];
      try {
        entries = await readAudit(harness, plugin, {
          limit: since ? 5_000 : DEFAULT_BACKFILL * 4,
          sinceTs: since,
        });
        if (!since && entries.length > DEFAULT_BACKFILL) {
          entries = entries.slice(-DEFAULT_BACKFILL);
        }
      } catch { /* table missing or transient — empty backfill */ }

      for (const entry of entries) {
        if (runId && entry.runId && entry.runId !== runId) continue;
        sink.event(entry.kind, entry);
        if (entry.runId === runId && TERMINAL_KINDS.has(entry.kind)) {
          sink.event('done', { reason: 'terminal-during-backfill', kind: entry.kind });
          sink.close();
          return;
        }
      }

      sink.event('attached', { harness, plugin, runId });

      const sub = subscribeAudit(`${harness}:${plugin}`, (env) => {
        if (sink.closed) return;
        const entry = env.entry as AuditEntry;
        if (runId && entry.runId && entry.runId !== runId) return;
        sink.event(entry.kind, entry);
        if (entry.runId === runId && TERMINAL_KINDS.has(entry.kind)) {
          sink.event('done', { reason: 'terminal', kind: entry.kind });
          sink.close();
        }
      });
      sink.onClose(sub.unsubscribe);
    },
  });
}
