/**
 * In-process per-(harness, plugin) provision audit bus.
 *
 * Producer: lib/provision/audit-log.ts `appendAudit()` publishes here
 * after the PG INSERT succeeds. Consumer: /api/provision/stream
 * subscribes via subscribe() so the UI sees events sub-millisecond
 * after they're recorded — no file polling, no fs.watch.
 *
 * Same shape as harness-log-bus.ts and run-chunk-bus.ts: per-channel
 * EventEmitter + 256-line ring buffer for late subscribers.
 */
import { EventEmitter } from 'node:events';

export interface AuditEnvelope {
  channelKey: string;
  seq: number;
  entry: unknown;
  ts: number;
}

interface Channel {
  emitter: EventEmitter;
  recent: AuditEnvelope[];
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

export function publish(channelKey: string, entry: unknown): AuditEnvelope {
  const ch = ensureChannel(channelKey);
  const env: AuditEnvelope = { channelKey, seq: ++ch.seq, entry, ts: Date.now() };
  ch.recent.push(env);
  if (ch.recent.length > RECENT_RING_SIZE) ch.recent.shift();
  ch.emitter.emit('entry', env);
  return env;
}

export interface Subscription {
  recent: AuditEnvelope[];
  unsubscribe(): void;
}

export function subscribe(
  channelKey: string,
  onEntry: (env: AuditEnvelope) => void,
): Subscription {
  const ch = ensureChannel(channelKey);
  const handler = (env: AuditEnvelope) => onEntry(env);
  ch.emitter.on('entry', handler);
  return {
    recent: [...ch.recent],
    unsubscribe: () => ch.emitter.off('entry', handler),
  };
}
