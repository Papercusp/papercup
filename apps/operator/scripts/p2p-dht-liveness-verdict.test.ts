import { describe, expect, it } from 'vitest';

import {
  EXIT,
  PROVED,
  judgeLivenessProbe,
  looksTransmitBlocked,
  // @ts-expect-error -- plain .mjs probe module, no type declarations.
} from './p2p-dht-liveness-verdict.mjs';

/**
 * P-302 (EI-20584279536840151). `p2p-dht-liveness-probe.mjs` built swarmA and
 * swarmB in ONE process on ONE host and asserted a 'connection' event fired.
 * It was green at 07:34:30Z while the isolated-DHT pin had silently stopped
 * taking effect, and it stayed green for DAYS while the Mac side of the rig
 * could not send a single datagram to anyone.
 *
 * The property under test is therefore NOT "did a connection event fire" —
 * that was true throughout the outage. It is "did a packet demonstrably cross
 * the machine boundary, to a peer whose identity we verified".
 */

const SERVER_KEY = 'a'.repeat(64);
const CLIENT_KEY = 'b'.repeat(64);

/** A fully-demonstrated cross-host run. */
const crossHostOk = {
  scope: 'cross-host' as const,
  remoteConfigured: true,
  remoteLegLaunched: true,
  expectedRemoteKey: SERVER_KEY,
  connectedPeerKeys: [SERVER_KEY],
  clientLocalKey: CLIENT_KEY,
  serverHostIsRemote: true,
  clientCounters: { routingTableSize: 4, requestsTotal: 12, responses: 11, timeouts: 1 },
  inboundAnswered: true,
};

/** The exact live shape measured on the Mac at 2026-08-16T11:4xZ. */
const p302Counters = { routingTableSize: 0, requestsTotal: 918, responses: 0, timeouts: 917 };

/**
 * PERMANENT WRONG-IMPLEMENTATION CONTROL — do not delete.
 *
 * This is the assertion the old probe actually made: "swarmB emitted a
 * 'connection' event, therefore the DHT is healthy." It cannot distinguish a
 * cross-host packet from two swarms talking to themselves inside one process,
 * which is why a total transport outage read green. Kept here so the suite
 * proves the real judge is strictly stronger, and fails loudly if it ever
 * degrades back into this.
 */
function connectionEventFiredJudge(obs: { connectedPeerKeys?: string[] }): 'ok' | 'fail' {
  return (obs.connectedPeerKeys?.length ?? 0) > 0 ? 'ok' : 'fail';
}

describe('judgeLivenessProbe — calibration (the real subject must pass these)', () => {
  it('reports ok when a verified peer on another host connected', () => {
    const v = judgeLivenessProbe(crossHostOk);
    expect(v.level).toBe('ok');
    expect(v.code).toBe('cross-host-verified');
    expect(v.exitCode).toBe(EXIT.HEALTHY);
    expect(v.proved).toBe(PROVED.CROSS_HOST);
  });

  it('reports ok for an explicitly local-only run, but never claims more than it proved', () => {
    const v = judgeLivenessProbe({ ...crossHostOk, scope: 'local-only', serverHostIsRemote: false });
    expect(v.level).toBe('ok');
    expect(v.exitCode).toBe(EXIT.HEALTHY);
    // The narrow claim must be labelled narrow. This is the whole defect: a
    // local-only result rendered as "bootstrap healthy" reads as federation health.
    expect(v.proved).toBe(PROVED.LOCAL_ONLY);
    expect(v.message).toMatch(/LOCAL-ONLY/);
    expect(v.message).toMatch(/does NOT prove any other machine/i);
  });
});

describe('judgeLivenessProbe — the degeneracy the old probe could not see', () => {
  it('REJECTS a same-host run that was asked to prove cross-host', () => {
    const sameHost = { ...crossHostOk, serverHostIsRemote: false };
    const v = judgeLivenessProbe(sameHost);
    expect(v.level).toBe('fail');
    expect(v.code).toBe('same-host-degenerate');
    expect(v.exitCode).toBe(EXIT.FAIL);
    // It still records what WAS proven rather than pretending nothing happened.
    expect(v.proved).toBe(PROVED.LOCAL_ONLY);
  });

  it('the connection-event control CANNOT see that degeneracy — which is why it was invisible', () => {
    const sameHost = { ...crossHostOk, serverHostIsRemote: false };
    // The old assertion calls the blind run healthy...
    expect(connectionEventFiredJudge(sameHost)).toBe('ok');
    // ...while the real judge refuses it. If this ever stops holding, the
    // implementation has regressed into "a connection event fired".
    expect(judgeLivenessProbe(sameHost).level).toBe('fail');
  });

  it('REJECTS a self-connection outright', () => {
    const v = judgeLivenessProbe({
      ...crossHostOk,
      connectedPeerKeys: [CLIENT_KEY],
      expectedRemoteKey: CLIENT_KEY,
    });
    expect(v.level).toBe('fail');
    expect(v.code).toBe('self-connection');
  });

  it('REJECTS a connection to a peer that is not the announced server', () => {
    const v = judgeLivenessProbe({ ...crossHostOk, connectedPeerKeys: ['c'.repeat(64)] });
    expect(v.level).toBe('fail');
    expect(v.code).toBe('wrong-peer');
    // The control is satisfied by ANY connection, verified or not.
    expect(connectionEventFiredJudge({ connectedPeerKeys: ['c'.repeat(64)] })).toBe('ok');
  });
});

describe('judgeLivenessProbe — fail closed', () => {
  it('an unrunnable remote leg is INCONCLUSIVE, never a pass', () => {
    const v = judgeLivenessProbe({
      ...crossHostOk,
      remoteLegLaunched: false,
      remoteLegError: 'ssh: connect to host 172.31.44.2 port 22: No route to host',
    });
    expect(v.level).toBe('unknown');
    expect(v.code).toBe('remote-leg-unavailable');
    expect(v.exitCode).toBe(EXIT.INCONCLUSIVE);
    expect(v.exitCode).not.toBe(EXIT.HEALTHY);
    expect(v.message).toMatch(/No route to host/);
    // It must not libel a healthy DHT as wedged either.
    expect(v.message).toMatch(/NOT evidence it is wedged/i);
  });

  it('refuses to answer a cross-host question with no remote configured', () => {
    const v = judgeLivenessProbe({ ...crossHostOk, remoteConfigured: false });
    expect(v.level).toBe('unknown');
    expect(v.code).toBe('no-remote-configured');
    expect(v.exitCode).toBe(EXIT.INCONCLUSIVE);
  });

  it('a connection with no expected key to verify against is INCONCLUSIVE', () => {
    const v = judgeLivenessProbe({ ...crossHostOk, expectedRemoteKey: null });
    expect(v.level).toBe('unknown');
    expect(v.code).toBe('server-never-announced');
  });

  it('a missing/malformed observation is INCONCLUSIVE, not ok', () => {
    for (const bad of [null, undefined, 'nope', 42]) {
      const v = judgeLivenessProbe(bad);
      expect(v.level).toBe('unknown');
      expect(v.exitCode).toBe(EXIT.INCONCLUSIVE);
      expect(v.proved).toBe(PROVED.NOTHING);
    }
  });

  it('every non-ok verdict exits non-zero — there is no silent pass', () => {
    const cases = [
      { ...crossHostOk, remoteLegLaunched: false },
      { ...crossHostOk, remoteConfigured: false },
      { ...crossHostOk, expectedRemoteKey: null },
      { ...crossHostOk, connectedPeerKeys: [] },
      { ...crossHostOk, serverHostIsRemote: false },
      { ...crossHostOk, connectedPeerKeys: ['c'.repeat(64)] },
      null,
    ];
    for (const c of cases) {
      const v = judgeLivenessProbe(c);
      expect(v.level).not.toBe('ok');
      expect(v.exitCode).not.toBe(EXIT.HEALTHY);
    }
  });
});

describe('judgeLivenessProbe — a wedged bootstrap is a FINDING, not an inconclusive', () => {
  it('an announce that never flushed is FAIL (the EI-8892 silent-wedge class)', () => {
    const v = judgeLivenessProbe({
      scope: 'local-only',
      serverLegLaunched: true,
      serverAnnounced: false,
      serverCounters: { routingTableSize: 2, requestsTotal: 30, responses: 25, timeouts: 5 },
    });
    // Reporting a real, actionable wedge as "I could not tell" is the same
    // misdiagnosis class that made P-302 expensive — it must be FAIL.
    expect(v.level).toBe('fail');
    expect(v.code).toBe('announce-timeout');
    expect(v.exitCode).toBe(EXIT.FAIL);
    expect(v.message).toMatch(/EI-8892/);
  });

  it('diagnoses a transmit-blocked ANNOUNCING host rather than blaming the bootstrap', () => {
    const v = judgeLivenessProbe({
      scope: 'local-only',
      serverLegLaunched: true,
      serverAnnounced: false,
      serverCounters: p302Counters,
    });
    expect(v.level).toBe('fail');
    expect(v.code).toBe('tx-blocked');
    // Whichever side is broken, the diagnosis must name that side.
    expect(v.message).toMatch(/ANNOUNCING host/);
    expect(v.message).toMatch(/NOT the bootstrap/);
  });

  it('a server leg that never STARTED stays inconclusive — a harness fault is not a DHT verdict', () => {
    const v = judgeLivenessProbe({
      scope: 'local-only',
      serverLegLaunched: false,
      serverLegError: 'Cannot find module hyperswarm',
    });
    expect(v.level).toBe('unknown');
    expect(v.code).toBe('server-leg-unavailable');
    expect(v.exitCode).toBe(EXIT.INCONCLUSIVE);
    expect(v.message).toMatch(/not a DHT verdict/);
  });

  it('a bootstrap failure outranks an unrunnable remote leg — report the finding, not the gap', () => {
    const v = judgeLivenessProbe({
      scope: 'cross-host',
      remoteConfigured: true,
      remoteLegLaunched: false,
      remoteLegError: 'ssh died',
      serverLegLaunched: true,
      serverAnnounced: false,
      serverCounters: { routingTableSize: 1, requestsTotal: 9, responses: 8, timeouts: 1 },
    });
    expect(v.code).toBe('announce-timeout');
    expect(v.level).toBe('fail');
  });
});

describe('judgeLivenessProbe — TX/RX asymmetry is diagnosed, not lumped into a timeout', () => {
  it('names the transmit-blocked signature instead of blaming the bootstrap', () => {
    const v = judgeLivenessProbe({
      ...crossHostOk,
      connectedPeerKeys: [],
      clientCounters: p302Counters,
      inboundAnswered: true,
    });
    expect(v.level).toBe('fail');
    expect(v.code).toBe('tx-blocked');
    // The diagnosis must travel with the verdict — no other layer reports it.
    expect(v.message).toMatch(/ANSWERING inbound/);
    expect(v.message).toMatch(/Local Network/);
    expect(v.message).toMatch(/NOT a wedged bootstrap/);
  });

  it('a plain no-connection is reported as such, not as tx-blocked', () => {
    const v = judgeLivenessProbe({
      ...crossHostOk,
      connectedPeerKeys: [],
      clientCounters: { routingTableSize: 4, requestsTotal: 20, responses: 18, timeouts: 2 },
    });
    expect(v.code).toBe('no-connection');
  });

  it('looksTransmitBlocked needs attempted requests — "never queried" is a different state', () => {
    expect(looksTransmitBlocked(p302Counters)).toBe(true);
    expect(looksTransmitBlocked({ routingTableSize: 0, requestsTotal: 0, responses: 0, timeouts: 0 })).toBe(false);
    // A populated routing table is proof of two-way flow whatever the counters say.
    expect(looksTransmitBlocked({ ...p302Counters, routingTableSize: 2 })).toBe(false);
    // Abstain rather than invent a diagnosis from an unrecognisable shape.
    expect(looksTransmitBlocked(null)).toBe(false);
    expect(looksTransmitBlocked({})).toBe(false);
  });
});
