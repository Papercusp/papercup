/**
 * In-process per-harness log-line bus.
 *
 * Producer: bash run.sh's log() function (and any other bash-side
 * logger) POSTs each line to /api/internal/log-event. The endpoint
 * calls publish() here. The operator's /:slug/log/stream and
 * /:slug/stream SSE handlers subscribe via subscribe(). Same shape as
 * lib/run-chunk-bus.ts but keyed by harness slug + log channel name
 * instead of runId.
 *
 * Channels:
 *   - "<slug>:log"  — structured JSONL events (run.log.jsonl)
 *   - "<slug>:raw"  — raw human-readable lines (run.log)
 *
 * Both surfaces are typically written together by the same log() call,
 * so both publish from a single POST.
 *
 * Buffering: a recent-lines ring buffer (last 256 entries) is kept per
 * channel so a subscriber that joins ~100ms after the first publish
 * doesn't miss the head of the stream. Beyond that, the SSE handler
 * falls back to the on-disk file for full backfill on connect (read
 * once, no fs.watch).
 */
import { EventEmitter } from 'node:events';

export interface LogEnvelope {
  channelKey: string;
  seq: number;
  line: string;
  ts: number;
}

interface Channel {
  emitter: EventEmitter;
  recent: LogEnvelope[];
  seq: number;
}

const RECENT_RING_SIZE = 256;
const channels = new Map<string, Channel>();

function ensureChannel(channelKey: string): Channel {
  let ch = channels.get(channelKey);
  if (!ch) {
    ch = { emitter: new EventEmitter(), recent: [], seq: 0 };
    ch.emitter.setMaxListeners(50);
    channels.set(channelKey, ch);
  }
  return ch;
}

/** Publish one log line to the channel. */
export function publish(channelKey: string, line: string): LogEnvelope {
  const ch = ensureChannel(channelKey);
  const env: LogEnvelope = { channelKey, seq: ++ch.seq, line, ts: Date.now() };
  ch.recent.push(env);
  if (ch.recent.length > RECENT_RING_SIZE) ch.recent.shift();
  ch.emitter.emit('line', env);
  return env;
}

export interface Subscription {
  recent: LogEnvelope[];
  unsubscribe(): void;
}

/** Subscribe to a channel. Receives the recent ring buffer up front
 *  and live `line` events thereafter until unsubscribe. */
export function subscribe(
  channelKey: string,
  onLine: (env: LogEnvelope) => void,
): Subscription {
  const ch = ensureChannel(channelKey);
  const handler = (env: LogEnvelope) => onLine(env);
  ch.emitter.on('line', handler);
  return {
    recent: [...ch.recent],
    unsubscribe: () => ch.emitter.off('line', handler),
  };
}

/** Test-only: drop all channels. */
export function _resetForTest(): void {
  for (const ch of channels.values()) ch.emitter.removeAllListeners();
  channels.clear();
}
