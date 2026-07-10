import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countLiveConnections,
  parseDhtBootstrap,
  parseDhtHost,
  PEER_CAP_NEAR_RATIO,
  reportPeerCapPressure,
  resolveDefaultMaxPeers,
  swarmConstructorOpts,
  type HyperswarmLike,
  type PeerCapInfo,
} from './swarm';

// ─── parseDhtBootstrap ──────────────────────────────────────────────────────────

describe('parseDhtBootstrap', () => {
  it('returns undefined for unset / empty / whitespace', () => {
    expect(parseDhtBootstrap(undefined)).toBeUndefined();
    expect(parseDhtBootstrap('')).toBeUndefined();
    expect(parseDhtBootstrap('   ')).toBeUndefined();
  });

  it('parses a comma-separated host:port list', () => {
    expect(parseDhtBootstrap('127.0.0.1:49737,127.0.0.1:49738,10.0.0.5:1234')).toEqual([
      { host: '127.0.0.1', port: 49737 },
      { host: '127.0.0.1', port: 49738 },
      { host: '10.0.0.5', port: 1234 },
    ]);
  });

  it('trims whitespace around entries', () => {
    expect(parseDhtBootstrap(' 127.0.0.1:1 , 127.0.0.1:2 ')).toEqual([
      { host: '127.0.0.1', port: 1 },
      { host: '127.0.0.1', port: 2 },
    ]);
  });

  it('drops malformed entries (no port, bad port, leading colon) but keeps the valid ones', () => {
    expect(parseDhtBootstrap('127.0.0.1:49737,nope,:5,host:notaport,1.2.3.4:0')).toEqual([
      { host: '127.0.0.1', port: 49737 },
    ]);
  });

  it('returns undefined when every entry is malformed', () => {
    expect(parseDhtBootstrap('nope,:5,host:abc')).toBeUndefined();
  });
});

// ─── swarmConstructorOpts ────────────────────────────────────────────────────────

describe('swarmConstructorOpts', () => {
  const SAVED = {
    bootstrap: process.env.PAPERCUSP_DHT_BOOTSTRAP,
    bootstrapFile: process.env.PAPERCUSP_DHT_BOOTSTRAP_FILE,
    dhtHost: process.env.PAPERCUSP_DHT_HOST,
    maxPeers: process.env.PAPERCUSP_SWARM_MAX_PEERS,
  };
  beforeEach(() => {
    // EI-8893: swarmConstructorOpts now falls back to a marker FILE
    // (default ~/.papercusp/dht-bootstrap) when PAPERCUSP_DHT_BOOTSTRAP is
    // unset. Pin the file path at a guaranteed-nonexistent location so these
    // env-only assertions stay hermetic regardless of the host's real
    // ~/.papercusp/dht-bootstrap (a packaged install or provisioned rig may
    // have one).
    process.env.PAPERCUSP_DHT_BOOTSTRAP_FILE = '/nonexistent/ei8893-swarmopts-guard';
  });
  afterEach(() => {
    // restore
    if (SAVED.bootstrap === undefined) delete process.env.PAPERCUSP_DHT_BOOTSTRAP;
    else process.env.PAPERCUSP_DHT_BOOTSTRAP = SAVED.bootstrap;
    if (SAVED.bootstrapFile === undefined) delete process.env.PAPERCUSP_DHT_BOOTSTRAP_FILE;
    else process.env.PAPERCUSP_DHT_BOOTSTRAP_FILE = SAVED.bootstrapFile;
    if (SAVED.dhtHost === undefined) delete process.env.PAPERCUSP_DHT_HOST;
    else process.env.PAPERCUSP_DHT_HOST = SAVED.dhtHost;
    if (SAVED.maxPeers === undefined) delete process.env.PAPERCUSP_SWARM_MAX_PEERS;
    else process.env.PAPERCUSP_SWARM_MAX_PEERS = SAVED.maxPeers;
  });

  it('omits bootstrap when PAPERCUSP_DHT_BOOTSTRAP is unset (uses the public DHT)', () => {
    delete process.env.PAPERCUSP_DHT_BOOTSTRAP;
    delete process.env.PAPERCUSP_SWARM_MAX_PEERS;
    const opts = swarmConstructorOpts();
    expect(opts.bootstrap).toBeUndefined();
    // P-004: the default now DERIVES from the host resource profile (cores/RAM)
    // rather than a hardcoded 256 — but is floored at 256 so a shared hive can
    // always reach a full 256 peers regardless of host size.
    expect(opts.maxPeers).toBeGreaterThanOrEqual(256);
  });

  it('P-004: derives the default maxPeers from the resource profile, env-free', () => {
    delete process.env.PAPERCUSP_SWARM_MAX_PEERS;
    // With no env override + no injected default, swarmConstructorOpts falls back
    // to the host-derived budget (resolveDefaultMaxPeers).
    expect(swarmConstructorOpts().maxPeers).toBe(resolveDefaultMaxPeers());
    // The host-derived budget honors the 256 floor (so a single hive fills) and
    // the 2048 ceiling (so a connection-flood can't exhaust fds/RAM).
    expect(resolveDefaultMaxPeers()).toBeGreaterThanOrEqual(256);
    expect(resolveDefaultMaxPeers()).toBeLessThanOrEqual(2048);
  });

  it('P-004: an injected defaultMaxPeers wins over the profile but loses to the env override', () => {
    delete process.env.PAPERCUSP_SWARM_MAX_PEERS;
    // Injected default is used when there is no env override (keeps the fn pure
    // for tests + lets a caller force a budget).
    expect(swarmConstructorOpts({ defaultMaxPeers: 512 }).maxPeers).toBe(512);
    // …but the env override still wins over the injected default.
    process.env.PAPERCUSP_SWARM_MAX_PEERS = '64';
    expect(swarmConstructorOpts({ defaultMaxPeers: 512 }).maxPeers).toBe(64);
  });

  it('includes bootstrap nodes when PAPERCUSP_DHT_BOOTSTRAP is set', () => {
    process.env.PAPERCUSP_DHT_BOOTSTRAP = '127.0.0.1:49737,127.0.0.1:49738';
    expect(swarmConstructorOpts().bootstrap).toEqual([
      { host: '127.0.0.1', port: 49737 },
      { host: '127.0.0.1', port: 49738 },
    ]);
  });

  it('honors PAPERCUSP_SWARM_MAX_PEERS override', () => {
    process.env.PAPERCUSP_SWARM_MAX_PEERS = '8';
    expect(swarmConstructorOpts().maxPeers).toBe(8);
  });

  it('trims and omits empty PAPERCUSP_DHT_HOST values', () => {
    expect(parseDhtHost(undefined)).toBeUndefined();
    expect(parseDhtHost('   ')).toBeUndefined();
    expect(parseDhtHost(' 10.99.0.1 ')).toBe('10.99.0.1');
  });

  it('includes an explicit DHT host when PAPERCUSP_DHT_HOST is set', () => {
    process.env.PAPERCUSP_DHT_HOST = '10.99.0.2';
    expect(swarmConstructorOpts().dhtHost).toBe('10.99.0.2');
  });
});

// ─── P-004 near-cap signal ───────────────────────────────────────────────────

/** A minimal swarm fake whose live connection count + maxPeers we control, with
 *  a STABLE object identity so the hysteresis WeakMap keys correctly across calls. */
function fakeSwarm(maxPeers: number | undefined): {
  swarm: HyperswarmLike;
  setLive: (n: number) => void;
} {
  const conns = new Set<object>();
  let seq = 0;
  const setLive = (n: number): void => {
    while (conns.size < n) conns.add({ id: seq++ });
    if (conns.size > n) {
      const kept = [...conns].slice(0, n);
      conns.clear();
      for (const c of kept) conns.add(c);
    }
  };
  return { swarm: { connections: conns, maxPeers } as unknown as HyperswarmLike, setLive };
}

describe('countLiveConnections', () => {
  it('reads a Set via .size, falls back to iteration, and is undefined when absent', () => {
    expect(countLiveConnections({ connections: new Set([1, 2, 3]) } as unknown as HyperswarmLike)).toBe(3);
    // No .size → counted by iteration.
    expect(countLiveConnections({ connections: [1, 2] } as unknown as HyperswarmLike)).toBe(2);
    expect(countLiveConnections({} as unknown as HyperswarmLike)).toBeUndefined();
  });
});

describe('reportPeerCapPressure — P-004 near-cap signal', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it('is silent below the near-cap threshold', () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, setLive } = fakeSwarm(10); // threshold = ceil(10 * 0.9) = 9
    const seen: PeerCapInfo[] = [];
    setLive(8);
    expect(reportPeerCapPressure(swarm, (i) => seen.push(i))).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('warns + fires the event ONCE on crossing into the near-cap zone (not at cap)', () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, setLive } = fakeSwarm(10);
    const seen: PeerCapInfo[] = [];
    setLive(9);
    const info = reportPeerCapPressure(swarm, (i) => seen.push(i));
    expect(info).toEqual({ liveConnections: 9, maxPeers: 10, atCap: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ liveConnections: 9, maxPeers: 10, atCap: false }]);
    // Hysteresis: a second call while STILL near must not re-warn / re-fire.
    expect(reportPeerCapPressure(swarm, (i) => seen.push(i))).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('flags atCap once the live count reaches maxPeers (the silent-drop point)', () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, setLive } = fakeSwarm(10);
    const seen: PeerCapInfo[] = [];
    setLive(10);
    const info = reportPeerCapPressure(swarm, (i) => seen.push(i));
    expect(info?.atCap).toBe(true);
    expect(seen[0]).toEqual({ liveConnections: 10, maxPeers: 10, atCap: true });
    // The log line must be present + name the cap so the drop is VISIBLE.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/peer cap pressure: 10\/10/);
  });

  it('re-arms: warns again on a fresh approach after the count recedes', () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, setLive } = fakeSwarm(10);
    const seen: PeerCapInfo[] = [];
    setLive(9);
    reportPeerCapPressure(swarm, (i) => seen.push(i)); // fires
    setLive(5);
    reportPeerCapPressure(swarm, (i) => seen.push(i)); // recedes → re-arm (no fire)
    setLive(9);
    reportPeerCapPressure(swarm, (i) => seen.push(i)); // fires again
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
  });

  it('no-ops when maxPeers is unknown (a minimal fake / older build)', () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, setLive } = fakeSwarm(undefined);
    setLive(1000);
    expect(reportPeerCapPressure(swarm)).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps PEER_CAP_NEAR_RATIO leaving headroom to act before the cap', () => {
    expect(PEER_CAP_NEAR_RATIO).toBeGreaterThan(0);
    expect(PEER_CAP_NEAR_RATIO).toBeLessThan(1);
  });
});
