import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Polyfill BroadcastChannel using MessageChannel for the test environment.
class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  name: string;
  listeners = new Set<(ev: { data: any }) => void>();
  closed = false;

  constructor(name: string) {
    this.name = name;
    let set = FakeBroadcastChannel.channels.get(name);
    if (!set) { set = new Set(); FakeBroadcastChannel.channels.set(name, set); }
    set.add(this);
  }
  postMessage(data: any) {
    if (this.closed) return;
    const peers = FakeBroadcastChannel.channels.get(this.name);
    if (!peers) return;
    for (const p of peers) {
      if (p === this || p.closed) continue;
      // Async dispatch like a real BroadcastChannel.
      setTimeout(() => {
        for (const l of p.listeners) l({ data });
      }, 0);
    }
  }
  addEventListener(_evt: string, fn: (ev: { data: any }) => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_evt: string, fn: (ev: { data: any }) => void) {
    this.listeners.delete(fn);
  }
  close() {
    this.closed = true;
    const set = FakeBroadcastChannel.channels.get(this.name);
    set?.delete(this);
  }
  static reset() { this.channels.clear(); }
}

(globalThis as any).BroadcastChannel = FakeBroadcastChannel as any;
(globalThis as any).window = globalThis;

import { bootVoiceLeader, _resetVoiceLeaderForTests, getVoiceLeaderState, requestVoiceLead } from './voice-leader';

beforeEach(() => {
  FakeBroadcastChannel.reset();
  _resetVoiceLeaderForTests();
  vi.useRealTimers();
});

afterEach(() => {
  _resetVoiceLeaderForTests();
});

describe('voice-leader election', () => {
  it('single tab becomes leader', async () => {
    const s = await bootVoiceLeader();
    expect(s.isLeader).toBe(true);
    expect(s.leaderTabId).toBe(s.myTabId);
    expect(s.available).toBe(true);
  });

  it('falls back to single-tab mode when BroadcastChannel is undefined', async () => {
    const orig = (globalThis as any).BroadcastChannel;
    (globalThis as any).BroadcastChannel = undefined;
    try {
      _resetVoiceLeaderForTests();
      const s = await bootVoiceLeader();
      expect(s.available).toBe(false);
      expect(s.isLeader).toBe(true);
    } finally {
      (globalThis as any).BroadcastChannel = orig;
    }
  });

  it('boot is idempotent — second call returns same promise', async () => {
    const p1 = bootVoiceLeader();
    const p2 = bootVoiceLeader();
    expect(p1).toBe(p2);
    await p1;
  });

  it('getVoiceLeaderState reflects the resolved election', async () => {
    await bootVoiceLeader();
    const s = getVoiceLeaderState();
    expect(s.leaderTabId).toBeTruthy();
    expect(s.isLeader).toBe(true);
  });

  it('requestVoiceLead is a no-op when already leader', async () => {
    await bootVoiceLeader();
    expect(getVoiceLeaderState().isLeader).toBe(true);
    requestVoiceLead('test'); // should not throw, should not change state
    expect(getVoiceLeaderState().isLeader).toBe(true);
  });

  it('late-joining tab defers to existing heartbeating leader (regression: two-leader bug)', async () => {
    // Simulate an already-elected leader in another tab by opening a
    // second FakeBroadcastChannel and replying with a heartbeat as soon
    // as our boot announces itself. Before the fix, the booting tab
    // would see only its own announce within the election window and
    // falsely "win" — producing two leaders. With the fix, the heartbeat
    // received mid-election aborts our election and makes us a follower.
    const PEER_TAB_ID = '0-existing-leader-aaaaaa'; // lex-low so it would lose nothing-to
    const peer = new FakeBroadcastChannel('operator-voice');
    peer.addEventListener('message', (ev: any) => {
      if (ev.data?.kind === 'announce' && ev.data.tabId !== PEER_TAB_ID) {
        peer.postMessage({ kind: 'heartbeat', tabId: PEER_TAB_ID, ts: Date.now() });
      }
    });

    const s = await bootVoiceLeader();
    expect(s.isLeader).toBe(false);
    expect(s.leaderTabId).toBe(PEER_TAB_ID);
    peer.close();
  });

  it('requestVoiceLead is a no-op when BroadcastChannel is unavailable', async () => {
    const orig = (globalThis as any).BroadcastChannel;
    (globalThis as any).BroadcastChannel = undefined;
    try {
      _resetVoiceLeaderForTests();
      const s = await bootVoiceLeader();
      expect(s.available).toBe(false);
      requestVoiceLead('test'); // should be a clean no-op
      expect(getVoiceLeaderState().isLeader).toBe(true);
    } finally {
      (globalThis as any).BroadcastChannel = orig;
    }
  });
});
