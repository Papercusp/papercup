/**
 * WI-10003621 recurrence guard (surface 1: auth:'public' routes on a hosted host).
 *
 * MEASURED on avi-test r57 (2026-09-28, uid 1001 = the customer workspace account, with
 * the WI-10003619 loopback-tier fix already live): GET /api/auth/me answered 200 with a
 * Set-Cookie for the passwordless `default` user whose session carried capabilities
 * ['*']; that cookie turned /api/admin/tables and /api/credentials from 401 into 200.
 * The route tier was 'public', so the WI-10003619 route-stack gate never ran, and
 * login() itself treated any non-remote caller as the local desktop.
 *
 * Every trust grant that keyed on "the request looks local" must refuse a FOREIGN
 * loopback peer (socket not owned by the service uid): login(), the /auth/me
 * auto-establish, the session-or-local default-user fallback, and the device
 * pair/list/revoke gate. Each case has a service-uid positive control, so a gate that
 * refused everyone would fail here too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const calls: string[] = [];
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?');
    calls.push(text);
    const rows = /FROM harness_shared\.users/.test(text)
      ? [{ id: 'u-default', username: 'default', display_name: 'User', password_hash: null, is_active: true }]
      : [];
    return Promise.resolve(rows);
  };
  return { calls, sql };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: db.sql }),
}));

import { runWithLoopbackPeerVerdict, currentLoopbackPeerIsForeign } from './loopback-peer-trust';
import { login } from '../auth';
import { getSessionUserOrLocalDefault } from '../endpoint-route/session-or-local';
import { isLoopbackHost as deviceLoopbackGate } from '../endpoint-route/routes/device/_shared';
import meRoutes from '../endpoint-route/routes/auth/me';

const ACTIVE = { PAPERCUSP_LOOPBACK_PEER_UID_POLICY: 'service-only' } as NodeJS.ProcessEnv;
const SERVICE_UID = 999;
const CUSTOMER_UID = 1001;
const SOCKET = { remoteAddress: '127.0.0.1', remotePort: 41234, localAddress: '127.0.0.1', localPort: 3070 };

// Real /proc/net/tcp format for ONE connection 127.0.0.1:41234 -> 127.0.0.1:3070; row 2
// is the client end, whose uid is the one the verdict reads.
function procNetTcp(clientUid: number): string {
  return [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    `   0: 0100007F:0BFE 00000000:0000 0A 00000000:00000000 00:00000000 00000000   ${SERVICE_UID}        0 11111 1 0000000000000000 100 0 0 10 0`,
    `   1: 0100007F:0BFE 0100007F:A112 01 00000000:00000000 00:00000000 00000000   ${SERVICE_UID}        0 22222 1 0000000000000000 20 4 30 10 -1`,
    `   2: 0100007F:A112 0100007F:0BFE 01 00000000:00000000 00:00000000 00000000  ${clientUid}        0 33333 1 0000000000000000 20 4 30 10 -1`,
  ].join('\n');
}
const readerFor = (clientUid: number) => (path: string) => {
  if (path === '/proc/net/tcp') return procNetTcp(clientUid);
  throw new Error('ENOENT');
};
// A FRESH socket object per call: the verdict cache is keyed by socket identity (a real
// connection's owner never changes), so sharing one object across tests would let a
// service-uid positive control's cached verdict answer a later customer-uid case.
const asPeer = <T>(clientUid: number, fn: () => T): T =>
  runWithLoopbackPeerVerdict({ ...SOCKET }, fn, { env: ACTIVE, serviceUid: SERVICE_UID, readProcFile: readerFor(clientUid) });

const loopbackReq = (path: string) =>
  new Request(`http://127.0.0.1:3070${path}`, { headers: { host: '127.0.0.1:3070' } });

type RouteDef = { method: string; handler: (req: Request, ctx?: unknown) => Promise<Response> };
const getMe = (meRoutes as unknown as RouteDef[]).find((r) => r.method === 'GET')!;

beforeEach(() => {
  db.calls.length = 0;
});

describe('login() under a foreign loopback peer (WI-10003621)', () => {
  it('customer uid: refused with foreign_loopback_peer BEFORE any database read (no account enumeration)', async () => {
    await asPeer(CUSTOMER_UID, async () => {
      expect(currentLoopbackPeerIsForeign()).toBe(true);
      await expect(login('default', null)).rejects.toMatchObject({ code: 'foreign_loopback_peer' });
      await expect(login('no-such-user', 'guess')).rejects.toMatchObject({ code: 'foreign_loopback_peer' });
    });
    expect(db.calls).toEqual([]);
  });

  it('service uid (positive control): login reaches the user lookup and is not refused as foreign', async () => {
    await asPeer(SERVICE_UID, async () => {
      const outcome = await login('default', null).then(
        () => ({ code: 'ok' }),
        (e: { code?: string }) => ({ code: e.code ?? 'error' }),
      );
      expect(outcome.code).not.toBe('foreign_loopback_peer');
    });
    expect(db.calls.some((q) => /FROM harness_shared\.users/.test(q))).toBe(true);
  });
});

describe('GET /api/auth/me under a foreign loopback peer (the measured r57 door)', () => {
  it('customer uid: no user, no auto-login, no account list, and no Set-Cookie', async () => {
    const res = await asPeer(CUSTOMER_UID, () => getMe.handler(loopbackReq('/api/auth/me')));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toEqual({ user: null, autoLogin: false, available: [] });
  });

  it('service uid (positive control): the local desktop still gets the default user', async () => {
    const res = await asPeer(SERVICE_UID, () => getMe.handler(loopbackReq('/api/auth/me')));
    const body = (await res.json()) as { user: { username?: string } | null; autoLogin: boolean };
    expect(body.user?.username).toBe('default');
    expect(body.autoLogin).toBe(true);
  });
});

describe('session-or-local default-user fallback under a foreign loopback peer', () => {
  it('customer uid: null (like an off-loopback caller)', async () => {
    const got = await asPeer(CUSTOMER_UID, () => getSessionUserOrLocalDefault(loopbackReq('/api/operator/state-snapshot')));
    expect(got).toBeNull();
  });

  it('service uid (positive control): the seeded default user', async () => {
    const got = await asPeer(SERVICE_UID, () => getSessionUserOrLocalDefault(loopbackReq('/api/operator/state-snapshot')));
    expect(got?.username).toBe('default');
  });
});

describe('device pair/list/revoke loopback gate under a foreign loopback peer', () => {
  it('customer uid: refused even with a loopback Host header', () => {
    expect(asPeer(CUSTOMER_UID, () => deviceLoopbackGate(loopbackReq('/api/device/desktop/mint-pair-token')))).toBe(false);
  });

  it('service uid (positive control): admitted; a non-loopback Host is still refused', () => {
    expect(asPeer(SERVICE_UID, () => deviceLoopbackGate(loopbackReq('/api/device/desktop/mint-pair-token')))).toBe(true);
    const offBox = new Request('http://127.0.0.1:3070/x', { headers: { host: 'example.com' } });
    expect(asPeer(SERVICE_UID, () => deviceLoopbackGate(offBox))).toBe(false);
  });
});
