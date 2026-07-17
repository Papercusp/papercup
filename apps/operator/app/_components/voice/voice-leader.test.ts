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

describe('EI-14611: attention-follows-visibility + instant leader-leaving reclaim', () => {
  // The hidden-leader starvation shape (WI-5174 suspect): a HIDDEN same-origin
  // window holds the election while the user's conversation runs in the visible
  // one, whose speak() silently no-ops as a follower — text reply, zero audio.
  type Listener = (...a: unknown[]) => void;
  let docListeners: Map<string, Listener[]>;
  let winListeners: Map<string, Listener[]>;
  let fakeDoc: { visibilityState: string; addEventListener: (e: string, f: Listener) => void };
  const origWinAdd = (globalThis as any).addEventListener;

  const fireDoc = (evt: string) => { for (const f of docListeners.get(evt) ?? []) f(); };
  const fireWin = (evt: string) => { for (const f of winListeners.get(evt) ?? []) f(); };
  const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    docListeners = new Map();
    winListeners = new Map();
    fakeDoc = {
      visibilityState: 'hidden',
      addEventListener: (e, f) => { docListeners.set(e, [...(docListeners.get(e) ?? []), f]); },
    };
    (globalThis as any).document = fakeDoc;
    (globalThis as any).addEventListener = (e: string, f: Listener) => {
      winListeners.set(e, [...(winListeners.get(e) ?? []), f]);
    };
  });

  afterEach(() => {
    delete (globalThis as any).document;
    (globalThis as any).addEventListener = origWinAdd;
  });

  /** A fake peer tab that already leads: heartbeats back at any announcer
   *  (the two-leader regression reply), optionally yields on request-lead. */
  const PEER_TAB_ID = '0-existing-leader-aaaaaa';
  function leaderPeer(opts: { yields: boolean }) {
    const peer = new FakeBroadcastChannel('operator-voice');
    const msgs: any[] = [];
    peer.addEventListener('message', (ev: any) => {
      msgs.push(ev.data);
      if (ev.data?.kind === 'announce' && ev.data.tabId !== PEER_TAB_ID) {
        peer.postMessage({ kind: 'heartbeat', tabId: PEER_TAB_ID, ts: Date.now() });
      }
      if (opts.yields && ev.data?.kind === 'request-lead') {
        peer.postMessage({ kind: 'yield', toTabId: ev.data.tabId });
      }
    });
    return { peer, msgs };
  }

  it('a follower whose document becomes VISIBLE requests and takes the lead (hidden-leader starvation fix)', async () => {
    const { peer, msgs } = leaderPeer({ yields: true });
    const s = await bootVoiceLeader();
    expect(s.isLeader).toBe(false); // follower behind the (hidden) peer leader

    fakeDoc.visibilityState = 'visible';
    fireDoc('visibilitychange');
    await tick(); // request-lead → yield round-trip over the async channel

    expect(msgs.some((m) => m?.kind === 'request-lead')).toBe(true);
    expect(getVoiceLeaderState().isLeader).toBe(true);
    peer.close();
  });

  it('a visibilitychange to HIDDEN never requests the lead', async () => {
    const { peer, msgs } = leaderPeer({ yields: true });
    await bootVoiceLeader();

    fakeDoc.visibilityState = 'hidden';
    fireDoc('visibilitychange');
    await tick();

    expect(msgs.some((m) => m?.kind === 'request-lead')).toBe(false);
    expect(getVoiceLeaderState().isLeader).toBe(false);
    peer.close();
  });

  it('the leader broadcasts leaving on pagehide, and a stray leaving from a non-leader is ignored', async () => {
    const peer = new FakeBroadcastChannel('operator-voice');
    const msgs: any[] = [];
    peer.addEventListener('message', (ev: any) => msgs.push(ev.data));

    const s = await bootVoiceLeader(); // single tab → leader
    expect(s.isLeader).toBe(true);

    fireWin('pagehide');
    await tick(10);
    expect(msgs.some((m) => m?.kind === 'leaving' && m.tabId === s.myTabId)).toBe(true);

    // A 'leaving' from some tab that is NOT our leader must not dethrone us.
    peer.postMessage({ kind: 'leaving', tabId: 'not-the-leader' });
    await tick(10);
    expect(getVoiceLeaderState().isLeader).toBe(true);
    peer.close();
  });

  it("a follower re-elects immediately on the leader's 'leaving' — no 12s timeout wait", async () => {
    const { peer } = leaderPeer({ yields: false });
    const s = await bootVoiceLeader();
    expect(s.isLeader).toBe(false);

    peer.postMessage({ kind: 'leaving', tabId: PEER_TAB_ID });
    await tick(10); // let the leaving dispatch land
    peer.close(); // the old leader is gone for the re-election

    // One announce window (250ms) + slack — far below LEADER_LOSS_TIMEOUT_MS (12s).
    await tick(400);
    expect(getVoiceLeaderState().isLeader).toBe(true);
  });
});
