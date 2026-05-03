'use client';

/**
 * BroadcastChannel voice-leader election (Phase 1d, v4 §2i).
 *
 * Multiple browser tabs in the same workspace would otherwise stereo-echo
 * every TTS utterance. Election picks one tab as the speaker; followers
 * silently no-op `speak()` calls.
 *
 * v4 scope reduction: election + heartbeat only. Focus-transfer
 * (user-attention-follows-speaker) is deferred to v1.5.
 *
 * Async boot per v4 §2i: chrome render is NOT blocked. `bootVoiceLeader()`
 * returns a promise; voice features wait on it before speaking.
 *
 * BroadcastChannel availability guard: Safari private windows + some
 * embedded WebViews don't expose it; we fall back to "this is the only
 * tab" mode.
 */

const CHANNEL = 'operator-voice';
const ANNOUNCE_WINDOW_MS = 250;
const HEARTBEAT_MS = 5_000;
const LEADER_LOSS_TIMEOUT_MS = 12_000;

type Message =
  | { kind: 'announce'; tabId: string; ts: number }
  | { kind: 'heartbeat'; tabId: string; ts: number };

interface LeaderState {
  isLeader: boolean;
  leaderTabId: string | null;
  myTabId: string;
  available: boolean; // BroadcastChannel actually works in this browser
}

const listeners = new Set<(s: LeaderState) => void>();
let state: LeaderState = {
  isLeader: false,
  leaderTabId: null,
  myTabId: makeTabId(),
  available: false,
};
let channel: BroadcastChannel | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastLeaderHeartbeatAt = 0;
let bootPromise: Promise<LeaderState> | null = null;

function makeTabId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function notify(): void {
  for (const l of listeners) l(state);
}

/** Subscribe to leader-state changes. */
export function subscribeVoiceLeader(fn: (s: LeaderState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => { listeners.delete(fn); };
}

/** Synchronous read of current state. */
export function getVoiceLeaderState(): LeaderState {
  return state;
}

/**
 * Async boot. Resolves with the determined leader state. Voice features
 * await this promise before speaking. Chrome render does NOT await it.
 *
 * Idempotent — second call returns the same in-flight promise.
 */
export function bootVoiceLeader(): Promise<LeaderState> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    if (typeof window === 'undefined') return state;

    // Availability guard.
    if (typeof BroadcastChannel === 'undefined') {
      state = { ...state, isLeader: true, leaderTabId: state.myTabId, available: false };
      notify();
      return state;
    }

    state = { ...state, available: true };
    channel = new BroadcastChannel(CHANNEL);

    let candidates: { tabId: string; ts: number }[] = [{ tabId: state.myTabId, ts: Date.now() }];

    channel.addEventListener('message', (ev: MessageEvent<Message>) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.kind === 'announce') {
        candidates.push({ tabId: msg.tabId, ts: msg.ts });
      } else if (msg.kind === 'heartbeat') {
        // Track the leader's heartbeats so loss-detection works.
        if (state.leaderTabId === msg.tabId) {
          lastLeaderHeartbeatAt = msg.ts;
        } else if (!state.isLeader) {
          // Late heartbeat from an unknown tab — adopt as leader if our
          // own election didn't yield one and theirs is older.
          state = { ...state, leaderTabId: msg.tabId };
          lastLeaderHeartbeatAt = msg.ts;
          notify();
        }
      }
    });

    // Announce ourselves.
    channel.postMessage({ kind: 'announce', tabId: state.myTabId, ts: Date.now() } satisfies Message);

    // Wait the announce window for other tabs to chime in.
    await new Promise<void>((res) => setTimeout(res, ANNOUNCE_WINDOW_MS));

    // Lowest tabId wins (deterministic, no clock skew).
    candidates.sort((a, b) => a.tabId.localeCompare(b.tabId));
    const winner = candidates[0];
    state = {
      ...state,
      isLeader: winner.tabId === state.myTabId,
      leaderTabId: winner.tabId,
    };

    if (state.isLeader) {
      lastLeaderHeartbeatAt = Date.now();
      heartbeatTimer = setInterval(() => {
        if (!channel) return;
        channel.postMessage({ kind: 'heartbeat', tabId: state.myTabId, ts: Date.now() } satisfies Message);
      }, HEARTBEAT_MS);
    } else {
      // Followers watch for leader loss + re-elect.
      lastLeaderHeartbeatAt = Date.now();
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastLeaderHeartbeatAt > LEADER_LOSS_TIMEOUT_MS) {
          // Leader vanished — re-elect by re-running boot.
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          bootPromise = null;
          void bootVoiceLeader();
        }
      }, HEARTBEAT_MS);
    }

    notify();
    return state;
  })();
  return bootPromise;
}

/** Test-only: tear down state for a fresh election. */
export function _resetVoiceLeaderForTests(): void {
  if (channel) try { channel.close(); } catch {}
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  channel = null;
  heartbeatTimer = null;
  bootPromise = null;
  state = {
    isLeader: false,
    leaderTabId: null,
    myTabId: makeTabId(),
    available: false,
  };
  listeners.clear();
}
