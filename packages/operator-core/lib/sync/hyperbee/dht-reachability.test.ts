import { describe, expect, it } from 'vitest';

import {
  classifyDhtReachability,
  sampleDhtReachability,
  type DhtReachabilitySample,
} from './swarm';

/**
 * P-302 (EI-20584279536840151). On the two-machine rig the Mac app's DHT was
 * PERFECTLY configured — the live node held the right bootstrap node and had
 * sent 918 requests to it — while macOS Local Network privacy dropped every
 * single datagram (EHOSTUNREACH). Nothing above the socket noticed, because
 * dht-rpc sends via udx's fire-and-forget `trySend`, so the app printed
 * "joined topic" for hours with a transport that could not reach anyone.
 *
 * The property under test is therefore NOT "is the bootstrap configured" — that
 * was true throughout the outage. It is "did packets actually come back".
 */
const healthy: DhtReachabilitySample = {
  bootstrapNodeCount: 1,
  routingTableSize: 4,
  requestsTotal: 12,
  responses: 11,
  timeouts: 1,
};

/** The exact live shape measured on the Mac at 2026-08-16T11:4xZ. */
const p302: DhtReachabilitySample = {
  bootstrapNodeCount: 1,
  routingTableSize: 0,
  requestsTotal: 918,
  responses: 0,
  timeouts: 917,
};

/**
 * PERMANENT WRONG-IMPLEMENTATION CONTROL — do not delete.
 *
 * This is the belief the old code encoded: the `[swarm] DHT bootstrap =
 * ISOLATED …` line reports that a bootstrap was RESOLVED, and everyone read
 * that as "the DHT works". It is a configuration echo, not an observation. Kept
 * here so the suite proves it can tell a real reachability check from one, and
 * fails loudly if the real classifier ever degrades into this.
 */
function configEchoClassifier(s: DhtReachabilitySample): 'ok' | 'warn' {
  return s.bootstrapNodeCount > 0 ? 'ok' : 'warn';
}

describe('classifyDhtReachability', () => {
  it('reports ok when peers actually answered (calibration — the real subject must pass this)', () => {
    const v = classifyDhtReachability(healthy);
    expect(v.level).toBe('ok');
    expect(v.code).toBe('reachable');
  });

  it('flags the P-302 signature: requests climbing, zero responses, empty table', () => {
    const v = classifyDhtReachability(p302);
    expect(v.level).toBe('warn');
    expect(v.code).toBe('bootstrap-unreachable');
    // The message must carry the diagnosis forward, since the whole failure mode
    // is that no other layer reports anything.
    expect(v.message).toMatch(/UNREACHABLE FROM THIS PROCESS/);
    expect(v.message).toMatch(/trySend/);
    expect(v.message).toMatch(/Local Network/);
  });

  it('the config-echo control CANNOT detect P-302 — which is why it was invisible', () => {
    // The control calls the outage healthy...
    expect(configEchoClassifier(p302)).toBe('ok');
    // ...while the real classifier does not. If this ever stops holding, the
    // real implementation has regressed into a configuration echo.
    expect(classifyDhtReachability(p302).level).toBe('warn');
  });

  it('distinguishes "never queried" from "queried and got nothing"', () => {
    const neverQueried = { ...p302, requestsTotal: 0, timeouts: 0 };
    expect(classifyDhtReachability(neverQueried).code).toBe('never-queried');
    expect(classifyDhtReachability(p302).code).toBe('bootstrap-unreachable');
  });

  it('flags an empty bootstrap list before anything else', () => {
    const v = classifyDhtReachability({ ...p302, bootstrapNodeCount: 0 });
    expect(v.code).toBe('no-bootstrap-nodes');
  });

  it('flags answers-but-empty-table as degraded rather than healthy', () => {
    const v = classifyDhtReachability({ ...healthy, routingTableSize: 0 });
    expect(v.level).toBe('warn');
    expect(v.code).toBe('degraded');
  });

  it('a populated routing table is proof of two-way flow, whatever the counters say', () => {
    expect(classifyDhtReachability({ ...p302, routingTableSize: 2 }).level).toBe('ok');
  });
});

describe('sampleDhtReachability', () => {
  it('reads the live dht-rpc shape', () => {
    const swarm = {
      dht: {
        bootstrapNodes: [{ host: '172.31.44.1', port: 49838 }],
        table: { size: 0 },
        io: { stats: { requests: { total: 918, responses: 0, timeouts: 917 } } },
      },
    };
    expect(sampleDhtReachability(swarm)).toEqual(p302);
  });

  it('abstains (null) rather than inventing health when the shape is unrecognisable', () => {
    // A hyperdht/dht-rpc version bump may move these internals. Reporting
    // "unknown" is correct; reporting a zeroed sample would manufacture a
    // false `bootstrap-unreachable` alarm on every boot.
    expect(sampleDhtReachability({ dht: { bootstrapNodes: [{ host: 'h', port: 1 }] } })).toBeNull();
    expect(sampleDhtReachability({})).toBeNull();
    expect(sampleDhtReachability(null)).toBeNull();
  });

  it('does not throw on a hostile/exotic swarm object', () => {
    const hostile = {
      get dht() {
        throw new Error('boom');
      },
    };
    expect(() => sampleDhtReachability(hostile)).not.toThrow();
    expect(sampleDhtReachability(hostile)).toBeNull();
  });
});
