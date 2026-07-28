import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_DEFAULTS,
  _resetLiveEndpointIpcServer,
  assessEngagement,
  endpointIpcEngagementCollector,
  engagementSignals,
  isEngagementDefect,
  readEndpointIpcEngagement,
  setLiveEndpointIpcServer,
  type EngagementObservation,
} from './engagement';

const GRACE = ENGAGEMENT_DEFAULTS.graceMs;

/** A healthy, engaged bridge — each test perturbs exactly one field off this. */
function obs(over: Partial<EngagementObservation> = {}): EngagementObservation {
  return {
    installed: true,
    uptimeMs: GRACE * 2,
    acceptedTotal: 12,
    currentlyOpen: 3,
    bypassClients: 0,
    ...over,
  };
}

describe('assessEngagement — installed vs actually carrying traffic', () => {
  it('says nothing about a mechanism that is switched off', () => {
    // Not a defect and not health: there is simply nothing to judge. Firing here
    // would flag every box that deliberately runs without the bridge.
    const a = assessEngagement(obs({ installed: false, acceptedTotal: 0, bypassClients: 99 }));
    expect(a.verdict).toBe('not-installed');
    expect(isEngagementDefect(a.verdict)).toBe(false);
  });

  it('reports a bridge that has carried traffic as engaged', () => {
    expect(assessEngagement(obs()).verdict).toBe('engaged');
  });

  it('fires on the WI-6512 signature: listening, never dialled, clients served over the bypassed transport', () => {
    const a = assessEngagement(obs({ acceptedTotal: 0, currentlyOpen: 0, bypassClients: 5 }));
    expect(a.verdict).toBe('bypassed');
    expect(isEngagementDefect(a.verdict)).toBe(true);
  });
});

describe('the three misreadings a naive `connectionCount() === 0` detector makes', () => {
  it('(1) does NOT fire on an instantaneous zero when the bridge has carried traffic before', () => {
    // The exact false positive a live-gauge detector produces: a bridge between
    // reconnects reads 0 open connections and is perfectly healthy.
    const a = assessEngagement(obs({ currentlyOpen: 0, acceptedTotal: 40, bypassClients: 5 }));
    expect(a.verdict).toBe('engaged');
    expect(isEngagementDefect(a.verdict)).toBe(false);
  });

  it('(2) does NOT fire when nothing has dialled it AND no client exists to carry', () => {
    // A dev box with no desktop app. Firing here is what turns a detector into
    // permanent red noise that readers learn to ignore.
    const a = assessEngagement(obs({ acceptedTotal: 0, currentlyOpen: 0, bypassClients: 0 }));
    expect(a.verdict).toBe('idle-no-client');
    expect(isEngagementDefect(a.verdict)).toBe(false);
  });

  it('(3) does NOT fire inside the startup grace window', () => {
    const a = assessEngagement(obs({ uptimeMs: GRACE - 1, acceptedTotal: 0, bypassClients: 5 }));
    expect(a.verdict).toBe('within-grace');
    expect(isEngagementDefect(a.verdict)).toBe(false);
  });

  it('distinguishes idle-no-client from bypassed purely on the bypass evidence', () => {
    // Same bridge, same zero engagement — only the presence of a client that IS
    // reaching the host another way separates "fine" from "the defect".
    const shared = { acceptedTotal: 0, currentlyOpen: 0 };
    expect(assessEngagement(obs({ ...shared, bypassClients: 0 })).verdict).toBe('idle-no-client');
    expect(assessEngagement(obs({ ...shared, bypassClients: 1 })).verdict).toBe('bypassed');
  });
});

describe('threshold boundaries', () => {
  it('treats uptime exactly at the grace window as judgeable', () => {
    expect(assessEngagement(obs({ uptimeMs: GRACE, acceptedTotal: 0, bypassClients: 3 })).verdict).toBe(
      'bypassed',
    );
  });

  it('honors a custom minBypassClients before calling it a defect', () => {
    const thresholds = { graceMs: GRACE, minBypassClients: 4 };
    const at3 = assessEngagement(obs({ acceptedTotal: 0, bypassClients: 3 }), thresholds);
    const at4 = assessEngagement(obs({ acceptedTotal: 0, bypassClients: 4 }), thresholds);
    expect(at3.verdict).toBe('idle-no-client');
    expect(at4.verdict).toBe('bypassed');
  });

  it('carries the observation and thresholds it judged on, so a signal body can cite them', () => {
    const a = assessEngagement(obs({ acceptedTotal: 0, bypassClients: 5 }));
    expect(a.observation.bypassClients).toBe(5);
    expect(a.thresholds.graceMs).toBe(GRACE);
  });
});

describe('the live handle registry — the probe must stay reachable', () => {
  beforeEach(() => _resetLiveEndpointIpcServer());

  it('returns null when no server is registered, rather than an all-zero observation', () => {
    // Load-bearing: "no server in this process" must not be readable as "server
    // carrying nothing", or the detector invents a defect on every host that
    // does not run the bridge.
    expect(readEndpointIpcEngagement(5)).toBeNull();
  });

  it('reads live counters off the registered handle', () => {
    setLiveEndpointIpcServer(
      { connectionCount: () => 2, acceptedTotal: () => 7, socketPath: '/tmp/x.sock' },
      1_000,
    );
    const o = readEndpointIpcEngagement(4, 1_000 + GRACE * 2);
    expect(o).not.toBeNull();
    expect(o!.installed).toBe(true);
    expect(o!.acceptedTotal).toBe(7);
    expect(o!.currentlyOpen).toBe(2);
    expect(o!.bypassClients).toBe(4);
    expect(o!.uptimeMs).toBe(GRACE * 2);
  });

  it('end-to-end: a registered but never-dialled bridge with live bypass traffic assesses as the defect', () => {
    setLiveEndpointIpcServer(
      { connectionCount: () => 0, acceptedTotal: () => 0, socketPath: '/tmp/x.sock' },
      0,
    );
    const o = readEndpointIpcEngagement(5, GRACE * 2)!;
    expect(assessEngagement(o).verdict).toBe('bypassed');
  });

  it('unregisters on shutdown', () => {
    setLiveEndpointIpcServer(
      { connectionCount: () => 0, acceptedTotal: () => 0, socketPath: '/tmp/x.sock' },
      0,
    );
    setLiveEndpointIpcServer(null);
    expect(readEndpointIpcEngagement(5)).toBeNull();
  });

  it('never reports a negative uptime if the clock moves backwards', () => {
    setLiveEndpointIpcServer(
      { connectionCount: () => 0, acceptedTotal: () => 0, socketPath: '/tmp/x.sock' },
      10_000,
    );
    expect(readEndpointIpcEngagement(0, 5_000)!.uptimeMs).toBe(0);
  });
});

describe('engagementSignals', () => {
  it('emits nothing for every healthy or unjudgeable verdict', () => {
    for (const o of [
      obs(),
      obs({ installed: false }),
      obs({ uptimeMs: 0, acceptedTotal: 0, bypassClients: 5 }),
      obs({ acceptedTotal: 0, bypassClients: 0 }),
    ]) {
      expect(engagementSignals(assessEngagement(o))).toEqual([]);
    }
  });

  it('emits one signal citing both sides of the comparison', () => {
    const [sig] = engagementSignals(
      assessEngagement(obs({ acceptedTotal: 0, currentlyOpen: 0, bypassClients: 5 })),
    );
    expect(sig.source).toBe('endpoint-ipc-engagement');
    expect(sig.severity).toBe('major');
    // The body must carry BOTH measurements — a reader has to be able to see the
    // comparison, not just the conclusion.
    expect(sig.body).toContain('ZERO connections');
    expect(sig.body).toContain('5 live HTTP SSE');
    expect(sig.title).not.toMatch(/\d+min|\d{4}-\d{2}-\d{2}/); // stable across ticks for dedup
  });
});

describe('endpointIpcEngagementCollector', () => {
  beforeEach(() => _resetLiveEndpointIpcServer());

  it('reports WHY it is not judging when no server is registered, instead of a silent empty pass', () => {
    // The detector this file implements exists because a mechanism observed
    // nothing while presenting as coverage. It must not do that itself.
    return endpointIpcEngagementCollector({}, { readBypassClients: () => 5 }).then((r) => {
      expect(r.signals).toEqual([]);
      expect(r.note).toContain('no IPC server registered');
      expect(r.note).toContain('blind');
    });
  });

  it('fires on the live bypass signature and annotates both counters', async () => {
    setLiveEndpointIpcServer(
      { connectionCount: () => 0, acceptedTotal: () => 0, socketPath: '/tmp/x.sock' },
      0,
    );
    const r = await endpointIpcEngagementCollector(
      {},
      { readBypassClients: () => 5, now: () => GRACE * 3 },
    );
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0].key).toBe('endpoint-ipc-installed-but-bypassed');
    expect(r.note).toContain('bypassed');
  });

  it('stays silent — but still reports what it saw — when the bridge is carrying traffic', async () => {
    setLiveEndpointIpcServer(
      { connectionCount: () => 4, acceptedTotal: () => 91, socketPath: '/tmp/x.sock' },
      0,
    );
    const r = await endpointIpcEngagementCollector(
      {},
      { readBypassClients: () => 5, now: () => GRACE * 3 },
    );
    expect(r.signals).toEqual([]);
    expect(r.note).toContain('engaged');
    expect(r.note).toContain('lifetime accepts 91');
  });

  it('stays silent on a box with no client at all', async () => {
    setLiveEndpointIpcServer(
      { connectionCount: () => 0, acceptedTotal: () => 0, socketPath: '/tmp/x.sock' },
      0,
    );
    const r = await endpointIpcEngagementCollector(
      {},
      { readBypassClients: () => 0, now: () => GRACE * 3 },
    );
    expect(r.signals).toEqual([]);
    expect(r.note).toContain('idle-no-client');
  });

  it('never throws a tick down when the bypass probe is unavailable', async () => {
    setLiveEndpointIpcServer(
      { connectionCount: () => 0, acceptedTotal: () => 0, socketPath: '/tmp/x.sock' },
      0,
    );
    const r = await endpointIpcEngagementCollector(
      {},
      {
        readBypassClients: () => {
          throw new Error('registry unavailable');
        },
        now: () => GRACE * 3,
      },
    );
    // Degrades to "no bypass evidence" rather than failing the whole tick.
    expect(r.signals).toEqual([]);
  });

  it('DEFAULT bypass probe reads the real stream registry (no injected port)', async () => {
    // REGRESSION GUARD. Every other test here injects `readBypassClients`, so the
    // default path shipped untested — and it was wrong: it used `require()` in an
    // ESM package, throwing a ReferenceError that the collector's own catch
    // swallowed into a permanent bypassClients=0. That silently disables the only
    // clause that can make this detector fire, i.e. it turns the detector into an
    // instance of the very class it detects. This test exercises the real default.
    const { activeStreams } = await import('../harness-active-streams');
    const key = '__engagement_probe_test__';
    activeStreams.set(key, {
      abort: () => {},
      createdAt: Date.now(),
      remoteIP: '127.0.0.1',
      slug: 'test',
    });
    try {
      setLiveEndpointIpcServer(
        { connectionCount: () => 0, acceptedTotal: () => 0, socketPath: '/tmp/x.sock' },
        0,
      );
      const r = await endpointIpcEngagementCollector({}, { now: () => GRACE * 3 });
      // The default probe must have SEEN the stream we just registered.
      expect(r.note).toMatch(/bypassing HTTP stream clients [1-9]/);
      expect(r.signals).toHaveLength(1);
    } finally {
      activeStreams.delete(key);
    }
  });

  it('honors tunable thresholds', async () => {
    setLiveEndpointIpcServer(
      { connectionCount: () => 0, acceptedTotal: () => 0, socketPath: '/tmp/x.sock' },
      0,
    );
    const r = await endpointIpcEngagementCollector(
      { engagementMinBypassClients: 10 },
      { readBypassClients: () => 5, now: () => GRACE * 3 },
    );
    expect(r.signals).toEqual([]);
    expect(r.note).toContain('idle-no-client');
  });
});
