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
 * Per-run lifecycle:
 *   - First publisher creates the EventEmitter implicitly via
 *     ensureChannel(runId)
 *   - Subscribers can join before or after the first chunk; new
 *     subscribers see live chunks from that point on (catch-up of
 *     missed chunks comes from the on-disk JSONL fallback during
 *     the transition period)
 *   - When the run completes, callers should call closeChannel(runId)
 *     to release the EventEmitter + emit a 'done' event
 *
 * Buffering: a small recent-chunks ring buffer (last 64 entries) is
 * kept per run so a subscriber that joins ~100ms after the first
 * publish doesn't miss the head of the stream. Beyond 64 chunks, the
 * fs.watch fallback in the SSE handler reads from disk for full
 * catch-up.
 */
import { EventEmitter } from 'node:events';

export interface ChunkEnvelope {
  runId: string;
  seq: number;
  data: string;
  ts: number;
}

interface Channel {
  emitter: EventEmitter;
  recent: ChunkEnvelope[];
  closed: boolean;
  closedAt?: number;
}

const RECENT_RING_SIZE = 64;
const CLOSED_CHANNEL_GC_MS = 5 * 60_000; // keep closed channels 5 min for late subscribers

const channels = new Map<string, Channel>();
let lastGcAt = Date.now();

function maybeGc(): void {
  const now = Date.now();
  if (now - lastGcAt < 60_000) return;
  lastGcAt = now;
  for (const [runId, ch] of channels) {
    if (ch.closed && ch.closedAt && now - ch.closedAt > CLOSED_CHANNEL_GC_MS) {
      ch.emitter.removeAllListeners();
      channels.delete(runId);
    }
  }
}

function ensureChannel(runId: string): Channel {
  let ch = channels.get(runId);
  if (!ch) {
    ch = {
      emitter: new EventEmitter(),
      recent: [],
      closed: false,
    };
    // EventEmitter complains at 10 listeners by default — bump for
    // the case where a user has multiple tabs open subscribing to the
    // same run.
    ch.emitter.setMaxListeners(50);
    channels.set(runId, ch);
  }
  return ch;
}

/** Publish one chunk to the run's channel. Subscribers receive it
 *  synchronously via the EventEmitter's listener invocation. */
export function publish(runId: string, seq: number, data: string): void {
  maybeGc();
  const ch = ensureChannel(runId);
  if (ch.closed) {
    // Late publish after close — silently drop. Could log if it ever
    // happens in practice; today it's a logic error worth knowing about.
    return;
  }
  const env: ChunkEnvelope = { runId, seq, data, ts: Date.now() };
  ch.recent.push(env);
  if (ch.recent.length > RECENT_RING_SIZE) {
    ch.recent.shift();
  }
  ch.emitter.emit('chunk', env);
}

/** Mark the run as complete. Emits a final 'done' event and starts the
 *  GC clock — channel survives 5min for any late subscriber. */
export function closeChannel(runId: string): void {
  const ch = channels.get(runId);
  if (!ch || ch.closed) return;
  ch.closed = true;
  ch.closedAt = Date.now();
  ch.emitter.emit('done');
}

/** Subscribe to a run's chunk stream. Returns:
 *   - `recent`: chunks already in the ring buffer (immediate catch-up)
 *   - `unsubscribe`: function to call when the SSE connection closes
 *   - `whenDone`: promise resolving when the run completes
 *
 *  The handler is invoked for every chunk emitted while subscribed.
 *  Subscribers that joined before the first publish see every chunk
 *  via `handler` (recent will be empty until the first publish lands).
 */
export function subscribe(
  runId: string,
  handler: (env: ChunkEnvelope) => void,
): {
  recent: ChunkEnvelope[];
  unsubscribe: () => void;
  whenDone: Promise<void>;
  isClosed: () => boolean;
} {
  const ch = ensureChannel(runId);
  const recent = [...ch.recent];
  const onChunk = (env: ChunkEnvelope) => {
    try { handler(env); } catch { /* never crash producer */ }
  };
  ch.emitter.on('chunk', onChunk);

  const whenDone = new Promise<void>((resolve) => {
    if (ch.closed) {
      resolve();
      return;
    }
    ch.emitter.once('done', () => resolve());
  });

  return {
    recent,
    unsubscribe: () => {
      ch.emitter.off('chunk', onChunk);
    },
    whenDone,
    isClosed: () => ch.closed,
  };
}

/** Test-only: drop all channels. */
export function _resetRunChunkBus(): void {
  for (const ch of channels.values()) ch.emitter.removeAllListeners();
  channels.clear();
}

/** Diagnostic: how many active channels + total subscribers. */
export function busStats(): { activeChannels: number; closedChannels: number; totalSubscribers: number } {
  let active = 0;
  let closed = 0;
  let subs = 0;
  for (const ch of channels.values()) {
    if (ch.closed) closed++;
    else active++;
    subs += ch.emitter.listenerCount('chunk');
  }
  return { activeChannels: active, closedChannels: closed, totalSubscribers: subs };
}
