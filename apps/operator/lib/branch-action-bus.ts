/**
 * In-process per-(slug, runId) branch-action bus.
 *
 * Producer: lib/branch-actions.ts `runAction()` writeLine() publishes
 * each captured stdout/stderr chunk. Consumer:
 * /api/harness/<slug>/branch/<branch>/action-stream subscribes via
 * subscribe() — sub-millisecond fan-out, no 250ms polling.
 *
 * Same shape as harness-log-bus.ts and provision-audit-bus.ts, with a
 * 'done' signal for the terminal action-completed/action-failed event
 * so subscribers can close cleanly.
 */
import { EventEmitter } from 'node:events';

export type ActionEventKind = 'output' | 'stderr' | 'started' | 'completed' | 'failed';

export interface ActionEnvelope {
  channelKey: string;
  seq: number;
  kind: ActionEventKind;
  text: string;
  meta?: Record<string, unknown>;
  ts: number;
}

interface Channel {
  emitter: EventEmitter;
  recent: ActionEnvelope[];
  seq: number;
  done: boolean;
  whenDone: Promise<void>;
  resolveDone: () => void;
}

const RECENT_RING_SIZE = 256;
const channels = new Map<string, Channel>();

function ensureChannel(channelKey: string): Channel {
  let ch = channels.get(channelKey);
  if (!ch) {
    let resolveDone!: () => void;
    const whenDone = new Promise<void>((r) => { resolveDone = r; });
    ch = {
      emitter: new EventEmitter(),
      recent: [],
      seq: 0,
      done: false,
      whenDone,
      resolveDone,
    };
    ch.emitter.setMaxListeners(50);
    channels.set(channelKey, ch);
  }
  return ch;
}

export function publish(
  channelKey: string,
  kind: ActionEventKind,
  text: string,
  meta?: Record<string, unknown>,
): ActionEnvelope {
  const ch = ensureChannel(channelKey);
  const env: ActionEnvelope = {
    channelKey,
    seq: ++ch.seq,
    kind,
    text,
    meta,
    ts: Date.now(),
  };
  ch.recent.push(env);
  if (ch.recent.length > RECENT_RING_SIZE) ch.recent.shift();
  ch.emitter.emit('event', env);
  if (kind === 'completed' || kind === 'failed') {
    ch.done = true;
    ch.resolveDone();
    // GC the channel after a grace window so late subscribers can
    // still read the recent ring (terminal-during-backfill case).
    setTimeout(() => {
      const cur = channels.get(channelKey);
      if (cur && cur.done) {
        cur.emitter.removeAllListeners();
        channels.delete(channelKey);
      }
    }, 5 * 60_000).unref?.();
  }
  return env;
}

export interface Subscription {
  recent: ActionEnvelope[];
  done: boolean;
  whenDone: Promise<void>;
  unsubscribe(): void;
}

export function subscribe(
  channelKey: string,
  onEvent: (env: ActionEnvelope) => void,
): Subscription {
  const ch = ensureChannel(channelKey);
  const handler = (env: ActionEnvelope) => onEvent(env);
  ch.emitter.on('event', handler);
  return {
    recent: [...ch.recent],
    done: ch.done,
    whenDone: ch.whenDone,
    unsubscribe: () => ch.emitter.off('event', handler),
  };
}
