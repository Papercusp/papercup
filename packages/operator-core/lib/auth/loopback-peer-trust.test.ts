/**
 * WI-10003619 recurrence guard: on a hosted workspace host, loopback trust is bound
 * to the connecting socket's uid. A loopback peer owned by any other account (the
 * customer) must get no loopback principal, and loopback-tier routes must refuse it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import {
  VM_RELEASE_PROFILE_MIRROR,
  currentLoopbackPeerIsForeign,
  decodeProcNetAddress,
  findClientSocketUid,
  loopbackPeerUidPolicyActive,
  resolveLoopbackPeerVerdict,
  runWithLoopbackPeerVerdict,
} from './loopback-peer-trust';
import { VM_RELEASE_DISTRIBUTION_PROFILE } from '../vm-release-runtime-policy';
import { isLoopbackRequest } from '../superuser-token';
import { requireLoopbackOr403 } from '../endpoint-route/loopback-guard';
import { principalFromLoopback } from './principal/from-loopback';

const ACTIVE = { PAPERCUSP_LOOPBACK_PEER_UID_POLICY: 'service-only' } as NodeJS.ProcessEnv;
const SERVICE_UID = 999;
const CUSTOMER_UID = 1001;

// A real-format /proc/net/tcp body for ONE connection 127.0.0.1:41234 -> 127.0.0.1:3070.
// Row 0 is the operator's listener, row 1 the SERVER end (owned by the service), row 2
// the CLIENT end (owned by the customer). Only row 2 answers "who connected".
function procNetTcp(clientUid: number): string {
  return [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    `   0: 0100007F:0BFE 00000000:0000 0A 00000000:00000000 00:00000000 00000000   ${SERVICE_UID}        0 11111 1 0000000000000000 100 0 0 10 0`,
    `   1: 0100007F:0BFE 0100007F:A112 01 00000000:00000000 00:00000000 00000000   ${SERVICE_UID}        0 22222 1 0000000000000000 20 4 30 10 -1`,
    `   2: 0100007F:A112 0100007F:0BFE 01 00000000:00000000 00:00000000 00000000  ${clientUid}        0 33333 1 0000000000000000 20 4 30 10 -1`,
  ].join('\n');
}

const SOCKET = { remoteAddress: '127.0.0.1', remotePort: 41234, localAddress: '127.0.0.1', localPort: 3070 };
const readerFor = (clientUid: number) => (path: string) => {
  if (path === '/proc/net/tcp') return procNetTcp(clientUid);
  throw new Error('ENOENT');
};
const loopbackHeaders = () => new Headers({ host: '127.0.0.1:3070' });

describe('decodeProcNetAddress', () => {
  it('decodes little-endian IPv4 and the hex port', () => {
    expect(decodeProcNetAddress('0100007F:0BFE')).toEqual({ ip: '127.0.0.1', port: 3070 });
  });
  it('decodes ::1 and IPv4-mapped IPv6 from tcp6', () => {
    expect(decodeProcNetAddress('00000000000000000000000001000000:0BFE')).toEqual({ ip: '::1', port: 3070 });
    expect(decodeProcNetAddress('0000000000000000FFFF00000100007F:A112')).toEqual({ ip: '127.0.0.1', port: 41234 });
  });
  it('rejects malformed columns instead of guessing', () => {
    expect(decodeProcNetAddress('zz:0BFE')).toBeNull();
    expect(decodeProcNetAddress('0100007F')).toBeNull();
  });
});

describe('findClientSocketUid', () => {
  it('returns the CLIENT end owner, never the service-owned server end of the same connection', () => {
    const uid = findClientSocketUid(procNetTcp(CUSTOMER_UID), {
      clientIp: '127.0.0.1', clientPort: 41234, serverIp: '127.0.0.1', serverPort: 3070,
    });
    expect(uid).toBe(CUSTOMER_UID);
  });
  it('returns null when no row matches', () => {
    expect(findClientSocketUid(procNetTcp(CUSTOMER_UID), {
      clientIp: '127.0.0.1', clientPort: 1, serverIp: '127.0.0.1', serverPort: 3070,
    })).toBeNull();
  });
});

describe('resolveLoopbackPeerVerdict', () => {
  it('service uid → service; any other uid → foreign', () => {
    expect(resolveLoopbackPeerVerdict(SOCKET, { serviceUid: SERVICE_UID, readProcFile: readerFor(SERVICE_UID) }))
      .toEqual({ kind: 'service', uid: SERVICE_UID });
    expect(resolveLoopbackPeerVerdict(SOCKET, { serviceUid: SERVICE_UID, readProcFile: readerFor(CUSTOMER_UID) }))
      .toEqual({ kind: 'foreign', uid: CUSTOMER_UID, reason: 'uid-mismatch' });
  });
  it('fails CLOSED when the owner cannot be resolved', () => {
    const unreadable = () => { throw new Error('EACCES'); };
    expect(resolveLoopbackPeerVerdict(SOCKET, { serviceUid: SERVICE_UID, readProcFile: unreadable }))
      .toEqual({ kind: 'foreign', uid: null, reason: 'unresolved' });
  });
  it('leaves non-loopback and socketless (in-process) requests to the existing gates', () => {
    expect(resolveLoopbackPeerVerdict({ ...SOCKET, remoteAddress: '10.1.2.3' })).toEqual({ kind: 'non-loopback' });
    expect(resolveLoopbackPeerVerdict(null)).toEqual({ kind: 'non-loopback' });
  });
});

describe('loopbackPeerUidPolicyActive', () => {
  it('is off on a plain desktop/dev env and on for every workspace-host signal', () => {
    expect(loopbackPeerUidPolicyActive({} as NodeJS.ProcessEnv)).toBe(false);
    expect(loopbackPeerUidPolicyActive({ PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release' } as NodeJS.ProcessEnv)).toBe(true);
    expect(loopbackPeerUidPolicyActive({ PAPERCUSP_HOSTED_WORKSPACE_ROOT: '/srv/w' } as NodeJS.ProcessEnv)).toBe(true);
    expect(loopbackPeerUidPolicyActive({ PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'b' } as NodeJS.ProcessEnv)).toBe(true);
    expect(loopbackPeerUidPolicyActive(ACTIVE)).toBe(true);
    expect(loopbackPeerUidPolicyActive({ ...ACTIVE, PAPERCUSP_LOOPBACK_PEER_UID_POLICY: 'off', PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release' } as NodeJS.ProcessEnv)).toBe(false);
  });
  it('the inlined vm-release profile mirror equals the canonical constant', () => {
    expect(VM_RELEASE_PROFILE_MIRROR).toBe(VM_RELEASE_DISTRIBUTION_PROFILE);
  });
});

describe('loopback trust gates under a foreign peer (the WI-10003619 hole)', () => {
  const prevAllow = process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  afterEach(() => {
    if (prevAllow === undefined) delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
    else process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = prevAllow;
  });

  const asPeer = <T>(clientUid: number, fn: () => T): T =>
    runWithLoopbackPeerVerdict(SOCKET, fn, { env: ACTIVE, serviceUid: SERVICE_UID, readProcFile: readerFor(clientUid) });

  it('customer uid: no loopback principal, isLoopbackRequest false, loopback tier 403 even with the remote-admin opt-out', async () => {
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = '1';
    await asPeer(CUSTOMER_UID, async () => {
      expect(currentLoopbackPeerIsForeign()).toBe(true);
      expect(isLoopbackRequest(loopbackHeaders())).toBe(false);
      expect(principalFromLoopback(loopbackHeaders())).toBeNull();
      const denied = requireLoopbackOr403(new Request('http://127.0.0.1:3070/api/internal/managed-timers'));
      expect(denied?.status).toBe(403);
      expect(await denied?.json()).toMatchObject({ error: 'loopback_peer_uid_denied', reason: 'uid-mismatch' });
    });
  });

  it('service uid: loopback trust is unchanged (positive control)', () => {
    asPeer(SERVICE_UID, () => {
      expect(currentLoopbackPeerIsForeign()).toBe(false);
      expect(isLoopbackRequest(loopbackHeaders())).toBe(true);
      expect(principalFromLoopback(loopbackHeaders())?.kind).toBe('loopback');
      expect(requireLoopbackOr403(new Request('http://127.0.0.1:3070/api/x'))).toBeNull();
    });
  });

  it('policy inactive (desktop): the wrapper is a no-op even for a foreign uid', () => {
    runWithLoopbackPeerVerdict(SOCKET, () => {
      expect(currentLoopbackPeerIsForeign()).toBe(false);
      expect(isLoopbackRequest(loopbackHeaders())).toBe(true);
    }, { env: {} as NodeJS.ProcessEnv, serviceUid: SERVICE_UID, readProcFile: readerFor(CUSTOMER_UID) });
  });
});

describe.runIf(process.platform === 'linux' && typeof process.getuid === 'function')('against the real kernel /proc', () => {
  it('resolves a real loopback connection to this process uid, and treats any other service uid as foreign', async () => {
    const accepted = new Promise<net.Socket>((resolveAccepted) => {
      const server = net.createServer((sock) => resolveAccepted(sock));
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        const client = net.connect(port, '127.0.0.1');
        client.on('error', () => undefined);
        accepted.then((s) => { s.destroy(); client.destroy(); server.close(); });
      });
    });
    const sock = await accepted;
    const peer = {
      remoteAddress: sock.remoteAddress, remotePort: sock.remotePort,
      localAddress: sock.localAddress, localPort: sock.localPort,
    };
    const me = process.getuid!();
    expect(resolveLoopbackPeerVerdict(peer)).toEqual({ kind: 'service', uid: me });
    expect(resolveLoopbackPeerVerdict(peer, { serviceUid: me + 1 })).toEqual({ kind: 'foreign', uid: me, reason: 'uid-mismatch' });
  });
});
