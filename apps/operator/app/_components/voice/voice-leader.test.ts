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

import { bootVoiceLeader, _resetVoiceLeaderForTests, getVoiceLeaderState } from './voice-leader';

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
});
