/**
 * hosted-desktop-kasmvnc-contract.test.ts — pins the three things a real KasmVNC
 * demands, each of which this repo got wrong until WI-1250866 measured them against
 * an actual install on the A-bar C6 GCP VM.
 *
 * WHY THIS FILE EXISTS SEPARATELY from `hosted-desktop-backend.test.ts`: everything
 * here is a claim about a THIRD-PARTY SERVER's behaviour, not about our own logic.
 * The existing suite injects `createSocket` and therefore never exercises the real
 * upgrade shape — which is precisely how a dial that could never connect to KasmVNC
 * stayed green for the whole life of P-012 and P-013. These tests deliberately open
 * a real socket against a local `ws` server that records what actually went over the
 * wire, because a mock cannot fail the way the thing being pinned failed.
 *
 * None of this needs KasmVNC installed. The server-side requirement was measured
 * once, against the real thing; what is pinned here is that WE STILL SEND what it
 * requires. If KasmVNC's own requirements change, that is a new measurement, not a
 * test failure.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { buildXServerCommand } from '../desktop/x-server-backend';
import {
  KASMVNC_WEBSOCKET_SUBPROTOCOL,
  dialDesktopSocket,
  kasmvncUpgradeHeaders,
} from './hosted-desktop-backend';

/** Every upgrade the recording server saw, in arrival order. */
interface RecordedUpgrade {
  headers: Record<string, string | string[] | undefined>;
  url: string | undefined;
}

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/**
 * A websocket server that accepts anything and records the upgrade request.
 *
 * It accepts the offered subprotocol rather than requiring one: the point is to
 * observe what WE SEND. A server that rejected a bad shape would make the assertion
 * pass for the wrong reason — the connection would simply fail, and "it failed" is
 * exactly the signature the pre-fix code already produced.
 */
async function recordingServer(): Promise<{ port: number; upgrades: RecordedUpgrade[] }> {
  const upgrades: RecordedUpgrade[] = [];
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: (protocols) => (protocols.size > 0 ? [...protocols][0] : false),
  });
  servers.push(wss);
  wss.on('connection', (_socket, req) => {
    upgrades.push({ headers: req.headers, url: req.url });
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  return { port: (wss.address() as AddressInfo).port, upgrades };
}

describe('the KasmVNC server argv', () => {
  const command = (): string[] =>
    buildXServerCommand({
      xServer: 'kasmvnc',
      display: ':110',
      width: 1024,
      height: 768,
      websocketPort: 7010,
      passwordFile: '/var/lib/papercusp-desktop/session.passwd',
    }).argv;

  it('passes -SecurityTypes None, without which no viewer can ever authenticate', () => {
    const argv = command();
    const i = argv.indexOf('-SecurityTypes');
    expect(i, '-SecurityTypes is absent — KasmVNC then defaults to VncAuth').toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('None');
  });

  it('still passes the per-session credential — `None` replaces neither the gate nor D-020', () => {
    // The failure this guards is a plausible "tidy-up": reading property 5 as
    // "authentication is off" and dropping property 4 with it. They are opposite
    // claims. `None` describes the INNER hop only; the credential is what makes the
    // OUTER hop refuse a stranger, and it is also what gives the RFB session the
    // identity that carries the view-only restriction.
    const argv = command();
    expect(argv).toContain('-KasmPasswordFile');
    expect(argv).toContain('/var/lib/papercusp-desktop/session.passwd');
    expect(argv).not.toContain('-DisableBasicAuth');
  });

  it('keeps the two flags together, so a desktop is never started half-configured', () => {
    // Either alone is a broken desktop: credential without `None` cannot complete
    // RFB; `None` without a credential is an open door. Pinning the PAIR is what
    // makes a partial edit fail here rather than in production.
    const argv = command();
    const hasCredential = argv.includes('-KasmPasswordFile');
    const hasSecurityTypes = argv.indexOf('-SecurityTypes') > -1;
    expect(hasCredential).toBe(hasSecurityTypes);
  });
});

/**
 * The permanent PRE-FIX CONTROL.
 *
 * The argv below is the exact one that ran in production for the whole life of P-012
 * and P-013 — copied from the live process table on the C6 VM before the fix — and
 * it is the argv under which NO viewer could ever connect. It stays here forever,
 * deliberately wrong, because the assertions above passed for months against code
 * that could not work: they were never shown to FAIL.
 *
 * A mutation probe cannot do this job here. The subject is a module we import, and
 * mutating it in the shared tree risks git-sync committing the mutant (repo rule);
 * the control gives the same falsifiability with no window and no lock.
 *
 * If a future edit makes these assertions pass against the pre-fix argv, the
 * assertions have stopped discriminating and the guard above is decorative.
 */
const PRE_FIX_ARGV_THAT_COULD_NEVER_AUTHENTICATE = [
  ':110',
  '-geometry',
  '1024x768',
  '-depth',
  '24',
  '-interface',
  '127.0.0.1',
  '-UseIPv6',
  '0',
  '-websocketPort',
  '7010',
  '-rfbport',
  '0',
  '-KasmPasswordFile',
  '/var/lib/papercusp-desktop/session.passwd',
  '-AcceptSetDesktopSize',
  '1',
  '-AlwaysShared',
  '1',
];

describe('control: the pre-fix argv must FAIL the checks above', () => {
  it('is rejected by the -SecurityTypes check', () => {
    expect(PRE_FIX_ARGV_THAT_COULD_NEVER_AUTHENTICATE.indexOf('-SecurityTypes')).toBe(-1);
  });

  it('is rejected by the both-flags-together check, proving that check discriminates', () => {
    const hasCredential = PRE_FIX_ARGV_THAT_COULD_NEVER_AUTHENTICATE.includes('-KasmPasswordFile');
    const hasSecurityTypes =
      PRE_FIX_ARGV_THAT_COULD_NEVER_AUTHENTICATE.indexOf('-SecurityTypes') > -1;
    expect(hasCredential).toBe(true);
    expect(hasSecurityTypes).toBe(false);
    // The production assertion is `expect(hasCredential).toBe(hasSecurityTypes)`.
    // Here those two differ, so that assertion would fail — which is the whole point.
    expect(hasCredential).not.toBe(hasSecurityTypes);
  });

  it('differs from the current argv ONLY by the security-types pair (calibration)', () => {
    // Calibration: if this ever fails, the control has drifted from the real pre-fix
    // state and the two tests above are comparing against a fiction.
    const current = buildXServerCommand({
      xServer: 'kasmvnc',
      display: ':110',
      width: 1024,
      height: 768,
      websocketPort: 7010,
      passwordFile: '/var/lib/papercusp-desktop/session.passwd',
    }).argv;
    const withoutSecurityTypes = current.filter(
      (arg, i) => arg !== '-SecurityTypes' && current[i - 1] !== '-SecurityTypes',
    );
    expect(withoutSecurityTypes).toEqual(PRE_FIX_ARGV_THAT_COULD_NEVER_AUTHENTICATE);
  });
});

describe('the KasmVNC websocket upgrade shape', () => {
  const grant = { user: 'papercusp-view', secret: 's3cret' } as const;

  it('sends the `binary` subprotocol — KasmVNC closes the connection without it', async () => {
    const { port, upgrades } = await recordingServer();
    const socket = await dialDesktopSocket({
      desktopSessionId: 'ds-1',
      endpoint: { host: '127.0.0.1', port },
      grant: { ...grant, action: 'watch', inputAllowed: false, auditAction: 'desktop_watch_started' },
    } as never);
    socket.close();

    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].headers['sec-websocket-protocol']).toBe(KASMVNC_WEBSOCKET_SUBPROTOCOL);
  });

  it('sends an Origin header — also mandatory, and also silently fatal when absent', async () => {
    const { port, upgrades } = await recordingServer();
    const socket = await dialDesktopSocket({
      desktopSessionId: 'ds-1',
      endpoint: { host: '127.0.0.1', port },
      grant: { ...grant, action: 'watch', inputAllowed: false, auditAction: 'desktop_watch_started' },
    } as never);
    socket.close();

    expect(upgrades[0].headers.origin).toBeTruthy();
  });

  it('still sends the credential — the two new headers are additions, not a replacement', async () => {
    const { port, upgrades } = await recordingServer();
    const socket = await dialDesktopSocket({
      desktopSessionId: 'ds-1',
      endpoint: { host: '127.0.0.1', port },
      grant: { ...grant, action: 'watch', inputAllowed: false, auditAction: 'desktop_watch_started' },
    } as never);
    socket.close();

    const auth = upgrades[0].headers.authorization;
    expect(auth).toBe(`Basic ${Buffer.from('papercusp-view:s3cret').toString('base64')}`);
  });

  it('carries exactly the grant it was given, so a watcher cannot dial as the controller', () => {
    // `kasmvncUpgradeHeaders` is the one place the secret becomes a wire value, so
    // the header must be derived from the grant it is handed and nothing else.
    const headers = kasmvncUpgradeHeaders({
      endpoint: { host: '127.0.0.1', port: 7010 },
      grant: { user: 'papercusp-view', secret: 'view-only-secret' },
    });
    expect(headers.Authorization).toContain(
      Buffer.from('papercusp-view:view-only-secret').toString('base64'),
    );
    expect(JSON.stringify(headers)).not.toContain('papercusp-control');
  });
});
