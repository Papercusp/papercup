/**
 * In-process per-run chunk bus.
 *
 * Replaces the fs.watch + JSONL upstream for the agent-streaming SSE
 * pattern (HarnessDashboard's AgentThinkingPopover, PiPanel,
 * BranchActionRunner). The orchestrator subprocess POSTs each stdout
 * chunk to /api/internal/run-chunk; that handler calls publish() here;
 * the operator's existing SSE handler at /agents/<runId>/stream
 * subscribes via subscribe(). Pure in-memory fan-out — no DB, no
 * filesystem, sub-ms latency.
 *
 * Internals migrated to @restart/sse's getChannel (2026-05-11). Public
 * surface preserved verbatim:
 *   - publish(runId, seq, data) — caller-supplied seq (NOT bus-assigned)
 *   - closeChannel(runId) — fires done() + starts 5min GC
 *   - subscribe(runId, handler) — { recent, unsubscribe, whenDone, isClosed }
 *   - busStats(), _resetRunChunkBus() — diagnostics + tests
 *
 * Why caller-supplied seq: orchestrators that retry chunk delivery
 * across HTTP errors need a stable seq identifier independent of
 * arrival order at the bus. The previous bus passed seq through; this
 * one does the same. The channel's auto-id (id) is discarded.
 */
import { getChannel, _resetChannelsForTest, listChannels } from '@restart/sse';

export interface ChunkEnvelope {
  runId: string;
  seq: number;
  data: string;
  ts: number;
}

const CHANNEL_PREFIX = 'run-chunk:';
const CLOSED_CHANNEL_GC_MS = 5 * 60_000;

function getRunChannel(runId: string) {
  return getChannel<ChunkEnvelope>(`${CHANNEL_PREFIX}${runId}`, {
    ringSize: 64,
    gcDelayMs: CLOSED_CHANNEL_GC_MS,
  });
}

/** Publish one chunk to the run's channel. Caller's seq is preserved. */
export function publish(runId: string, seq: number, data: string): void {
  const ch = getRunChannel(runId);
  if (ch.isDone) {
    // Late publish after close — silently drop, matches prior behavior.
    return;
  }
  const env: ChunkEnvelope = { runId, seq, data, ts: Date.now() };
  ch.publish(env);
}

/** Mark the run as complete. Subscribers' whenDone resolves; 5min GC clock starts. */
export function closeChannel(runId: string): void {
  const ch = getRunChannel(runId);
  if (ch.isDone) return;
  ch.done();
}

/** Subscribe to a run's chunk stream. */
export function subscribe(
  runId: string,
  handler: (env: ChunkEnvelope) => void,
): {
  recent: ChunkEnvelope[];
  unsubscribe: () => void;
  whenDone: Promise<void>;
  isClosed: () => boolean;
} {
  const ch = getRunChannel(runId);
  const recent = ch.recent.map((e) => e.event);
  const iter = ch.subscribe()[Symbol.asyncIterator]();
  let unsubscribed = false;
  let resolveDone!: () => void;
  const whenDone = new Promise<void>((r) => { resolveDone = r; });

  if (ch.isDone) {
    resolveDone();
  }

  (async () => {
    while (!unsubscribed) {
      const { value, done } = await iter.next();
      if (done) break;
      if (unsubscribed) break;
      try { handler(value.event); } catch { /* never crash producer */ }
    }
    resolveDone();
  })();

  return {
    recent,
    unsubscribe: () => {
      if (unsubscribed) return;
      unsubscribed = true;
      void iter.return?.(undefined);
    },
    whenDone,
    isClosed: () => ch.isDone,
  };
}

/** Test-only: drop all channels. */
export function _resetRunChunkBus(): void {
  _resetChannelsForTest();
}

/** Diagnostic: how many active channels + total subscribers. */
export function busStats(): { activeChannels: number; closedChannels: number; totalSubscribers: number } {
  let active = 0;
  let closed = 0;
  let subs = 0;
  for (const c of listChannels()) {
    if (!c.key.startsWith(CHANNEL_PREFIX)) continue;
    if (c.isDone) closed++;
    else active++;
    subs += c.subscribers;
  }
  return { activeChannels: active, closedChannels: closed, totalSubscribers: subs };
}
