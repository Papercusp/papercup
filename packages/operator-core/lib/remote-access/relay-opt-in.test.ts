/**
 * external-app-access P-008 (D-031) — the opt-in Papercusp relay on the machine side: R-20 consent
 * before linking, the hosted-machine refusal, and the reconciler's device-grant → connector
 * lifecycle, against an in-memory store and portal. The store fake keeps the migration-1268 CHECK
 * that a `linking` row must carry consent, so a code path that skipped the consent check would
 * fail here the way it would fail against Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PORTAL_RELAY_NOTICE,
  PORTAL_RELAY_NOTICE_VERSION,
  PORTAL_RELAY_RESTART_BACKOFF_MS,
  PortalRelayError,
  acceptPortalRelayNotice,
  assertPortalRelayConsent,
  beginPortalRelayLink,
  cancelPortalRelayLink,
  disconnectPortalRelay,
  isPapercuspHostedMachine,
  normalizePortalOrigin,
  portalRelayMcpUrl,
  portalRelayStatus,
  reconcilePortalRelay,
  resetPortalRelayStateForTests,
  type PortalRelayDeps,
  type PortalRelayPortalClient,
} from './relay-opt-in';
import { PORTAL_RELAY_NOTICE as PORTAL_ROUTE_NOTICE } from '../endpoint-route/routes/hosted-cli';
import type { PortalRelayRow, PortalRelaySecrets } from './portal-relay-store';

const PORTAL = 'https://portal.example.com';
const APP_BASE = `${PORTAL}/api/workspaces/cw-1`;

type MutableRow = { -readonly [K in keyof PortalRelayRow]: PortalRelayRow[K] };

function emptyRow(installId: string, portalOrigin: string): MutableRow {
  return {
    installId, portalOrigin, state: 'off', consentNoticeVersion: null, consentedAt: null, consentedBy: null,
    userCode: null, verificationUri: null, grantExpiresAt: null, pollIntervalSec: null, organizationId: null,
    customerWorkspaceId: null, appBaseUrl: null, connectorUrl: null, operatorPort: null, linkedAt: null,
    lastError: null, lastErrorAt: null, updatedAt: new Date(0),
  };
}

function fakeWorld(opts: { env?: NodeJS.ProcessEnv; owner?: boolean; otherOperatorAnswers?: boolean } = {}) {
  let row: MutableRow | null = null;
  let secrets: { -readonly [K in keyof PortalRelaySecrets]: PortalRelaySecrets[K] } = { deviceCode: null, connectorBearer: null };
  let now = 1_000_000;
  let running = false;
  let bound = false;
  let terminal: { reason: string; detail: string } | null = null;
  const connectorStarts: Array<{ url: string; bearer: string }> = [];
  let connectorStops = 0;
  const pollResults: Array<Awaited<ReturnType<PortalRelayPortalClient['pollToken']>>> = [];
  const portal = {
    requestCode: vi.fn(async (_origin: string, _input: { installId: string; installLabel: string }) => ({
      deviceCode: 'pdc_device', userCode: 'BCDF-GHJK', verificationUriComplete: `${PORTAL}/relay/device?code=BCDF-GHJK`,
      expiresIn: 600, interval: 5,
    })),
    pollToken: vi.fn(async () => pollResults.shift() ?? { status: 'pending' as const }),
    register: vi.fn(async () => ({ bearer: 'connector-bearer' })),
    unlink: vi.fn(async () => undefined),
  } satisfies PortalRelayPortalClient;

  const requireRow = (): MutableRow => {
    if (!row) throw new Error('no row');
    return row;
  };
  const deps: PortalRelayDeps = {
    store: {
      read: async () => (row ? { ...row } : null),
      readSecrets: async () => ({ ...secrets }),
      ensureRow: async ({ installId, portalOrigin }) => {
        if (!row) row = emptyRow(installId, portalOrigin);
        else if (row.state === 'off') row.portalOrigin = portalOrigin;
      },
      recordConsent: async ({ noticeVersion, by }) => {
        if (!row) return false;
        row.consentNoticeVersion = noticeVersion;
        row.consentedAt = new Date(now);
        row.consentedBy = by;
        return true;
      },
      saveLinking: async (t) => {
        const r = requireRow();
        // Migration 1268 CHECK remote_access_portal_relay_linking_complete.
        if (r.consentedAt === null) throw new Error('violates check constraint remote_access_portal_relay_linking_complete');
        Object.assign(r, {
          state: 'linking', userCode: t.userCode, verificationUri: t.verificationUri, grantExpiresAt: t.grantExpiresAt,
          pollIntervalSec: t.pollIntervalSec, lastError: null, lastErrorAt: null,
        });
        secrets = { deviceCode: t.deviceCode, connectorBearer: null };
      },
      saveLinked: async (t) => {
        const r = requireRow();
        Object.assign(r, {
          state: 'linked', userCode: null, verificationUri: null, grantExpiresAt: null, pollIntervalSec: null,
          organizationId: t.organizationId, customerWorkspaceId: t.customerWorkspaceId, appBaseUrl: t.appBaseUrl,
          connectorUrl: t.connectorUrl, operatorPort: t.operatorPort, linkedAt: new Date(now), lastError: null,
        });
        secrets = { deviceCode: null, connectorBearer: t.connectorBearer };
      },
      setOff: async (error) => {
        const r = requireRow();
        Object.assign(r, {
          state: 'off', userCode: null, verificationUri: null, grantExpiresAt: null, pollIntervalSec: null,
          organizationId: null, customerWorkspaceId: null, appBaseUrl: null, connectorUrl: null, linkedAt: null,
          lastError: error, lastErrorAt: error ? new Date(now) : null,
        });
        secrets = { deviceCode: null, connectorBearer: null };
      },
      recordError: async (message) => {
        const r = requireRow();
        r.lastError = message;
        r.lastErrorAt = message ? new Date(now) : null;
      },
      setOperatorPort: async (port) => {
        requireRow().operatorPort = port;
      },
    },
    portal,
    connector: {
      running: () => running,
      status: () => ({ running, bound, startedAt: running ? new Date(now).toISOString() : null, terminal: null }),
      start: async (input) => {
        connectorStarts.push(input);
        running = true;
      },
      stop: () => {
        connectorStops += 1;
        running = false;
        bound = false;
      },
      takeTerminal: () => {
        const t = terminal;
        terminal = null;
        return t;
      },
    },
    env: { PAPERCUSP_HONO_PORT: '3070', ...(opts.env ?? {}) },
    isConnectorOwner: () => opts.owner ?? true,
    operatorAnswers: async () => opts.otherOperatorAnswers ?? false,
    installLabel: () => 'my-laptop',
    newInstallId: () => 'inst-0123456789abcdef01234567',
    now: () => now,
    notifyChanged: vi.fn(),
  };
  return {
    deps,
    portal,
    notifyChanged: deps.notifyChanged as ReturnType<typeof vi.fn>,
    pollResults,
    get row() { return row; },
    get secrets() { return secrets; },
    get connectorStarts() { return connectorStarts; },
    get connectorStops() { return connectorStops; },
    advance(ms: number) { now += ms; },
    connectorBinds() { bound = true; },
    connectorEnds(reason: string) { running = false; bound = false; terminal = { reason, detail: reason }; },
  };
}

const APPROVED = {
  status: 'approved' as const,
  organizationId: 'org-1',
  customerWorkspaceId: 'cw-1',
  enrollmentTicket: 'ticket-1',
  registerUrl: `${PORTAL}/api/hosted/connector/register`,
  connectorUrl: 'wss://portal.example.com/api/hosted/connector',
  appBaseUrl: APP_BASE,
};

beforeEach(() => resetPortalRelayStateForTests());
afterEach(() => resetPortalRelayStateForTests());

describe('the relay notice (D-009) has one source', () => {
  it('the portal approval page and the machine show the same words', () => {
    expect(PORTAL_ROUTE_NOTICE).toBe(PORTAL_RELAY_NOTICE);
    expect(PORTAL_RELAY_NOTICE).toContain('Papercusp can read those calls');
  });
});

describe('R-20: the relay cannot start linking before the user agrees to the current notice', () => {
  it('assertPortalRelayConsent refuses no row, no consent, and an older notice version', () => {
    const at = new Date();
    expect(() => assertPortalRelayConsent(null)).toThrow(PortalRelayError);
    expect(() => assertPortalRelayConsent({ consentedAt: null, consentNoticeVersion: null })).toThrow(/relay notice/);
    expect(() => assertPortalRelayConsent({ consentedAt: at, consentNoticeVersion: PORTAL_RELAY_NOTICE_VERSION - 1 })).toThrow(
      expect.objectContaining({ code: 'consent_required' }),
    );
    expect(() => assertPortalRelayConsent({ consentedAt: at, consentNoticeVersion: PORTAL_RELAY_NOTICE_VERSION })).not.toThrow();
  });

  it('beginPortalRelayLink refuses consent_required and never calls the portal', async () => {
    const w = fakeWorld();
    await expect(beginPortalRelayLink({}, w.deps)).rejects.toMatchObject({ code: 'consent_required' });
    expect(w.portal.requestCode).not.toHaveBeenCalled();
    expect(w.row?.state ?? 'off').toBe('off');
  });

  it('refuses when the stored consent is for an older notice', async () => {
    const w = fakeWorld();
    await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
    if (!w.row) throw new Error('row expected');
    w.row.consentNoticeVersion = PORTAL_RELAY_NOTICE_VERSION - 1;
    await expect(beginPortalRelayLink({}, w.deps)).rejects.toMatchObject({ code: 'consent_required' });
    expect(w.portal.requestCode).not.toHaveBeenCalled();
  });

  it('acceptPortalRelayNotice refuses an outdated version with notice_outdated and records nothing', async () => {
    const w = fakeWorld();
    await expect(acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION + 1 }, w.deps)).rejects.toMatchObject({
      code: 'notice_outdated',
    });
    expect(w.row).toBeNull();
  });

  it('after agreeing to the current notice, linking starts and shows the code and address', async () => {
    const w = fakeWorld();
    const accepted = await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION, by: 'avi' }, w.deps);
    expect(accepted.consent).toMatchObject({ agreed: true, version: PORTAL_RELAY_NOTICE_VERSION });
    const status = await beginPortalRelayLink({}, w.deps);
    expect(w.portal.requestCode).toHaveBeenCalledWith('https://app.papercusp.com', {
      installId: 'inst-0123456789abcdef01234567',
      installLabel: 'my-laptop',
    });
    expect(status.state).toBe('linking');
    expect(status.pending).toMatchObject({ userCode: 'BCDF-GHJK', verificationUri: `${PORTAL}/relay/device?code=BCDF-GHJK` });
    expect(w.secrets.deviceCode).toBe('pdc_device');
  });
});

describe('D-031 #8: a Papercusp-hosted machine never uses the local relay', () => {
  const env = { PAPERCUSP_HOSTED_WORKSPACE_ID: 'cw-9' };

  it('detects a hosted machine from any non-empty PAPERCUSP_HOSTED_* variable', () => {
    expect(isPapercuspHostedMachine(env)).toBe(true);
    expect(isPapercuspHostedMachine({ PAPERCUSP_HOSTED_X: '  ' })).toBe(false);
    expect(isPapercuspHostedMachine({})).toBe(false);
  });

  it('refuses consent and linking, reports unavailable, and the reconciler stops any connector', async () => {
    const w = fakeWorld({ env });
    await expect(acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps)).rejects.toMatchObject({
      code: 'hosted_machine',
    });
    await expect(beginPortalRelayLink({}, w.deps)).rejects.toMatchObject({ code: 'hosted_machine' });
    expect(await portalRelayStatus(w.deps)).toMatchObject({ available: false, unavailableReason: 'hosted_machine' });
    await w.deps.connector.start({ url: 'wss://x', bearer: 'b' });
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'hosted-machine' });
    expect(w.deps.connector.running()).toBe(false);
  });
});

describe('the portal address', () => {
  it('accepts https and loopback http only', () => {
    expect(normalizePortalOrigin('https://portal.example.com/some/path')).toBe(PORTAL);
    expect(normalizePortalOrigin('http://127.0.0.1:3081')).toBe('http://127.0.0.1:3081');
    expect(() => normalizePortalOrigin('http://portal.example.com')).toThrow(expect.objectContaining({ code: 'invalid_portal_origin' }));
    expect(() => normalizePortalOrigin('not a url')).toThrow(expect.objectContaining({ code: 'invalid_portal_origin' }));
  });

  it('the MCP URL is the portal workspace route /api/workspaces/:id/mcp', () => {
    expect(portalRelayMcpUrl(APP_BASE)).toBe(`${PORTAL}/api/workspaces/cw-1/mcp`);
    expect(portalRelayMcpUrl(`${APP_BASE}/`)).toBe(`${PORTAL}/api/workspaces/cw-1/mcp`);
  });
});

async function linkedWorld(opts: Parameters<typeof fakeWorld>[0] = {}) {
  const w = fakeWorld(opts);
  await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
  await beginPortalRelayLink({ portalOrigin: PORTAL }, w.deps);
  w.pollResults.push(APPROVED);
  expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'linked' });
  return w;
}

describe('the reconciler finishes the link and runs the connector', () => {
  it('pending polls keep linking; approval registers the connector and stores the link', async () => {
    const w = fakeWorld();
    await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
    await beginPortalRelayLink({ portalOrigin: PORTAL }, w.deps);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'polled' });
    // The poll interval (5s) is respected.
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'waiting' });
    w.advance(5_000);
    w.pollResults.push(APPROVED);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'linked' });
    expect(w.portal.register).toHaveBeenCalledWith(APPROVED.registerUrl, 'ticket-1');
    expect(w.row).toMatchObject({ state: 'linked', customerWorkspaceId: 'cw-1', appBaseUrl: APP_BASE, operatorPort: 3070 });
    expect(w.secrets).toEqual({ deviceCode: null, connectorBearer: 'connector-bearer' });

    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'started' });
    expect(w.connectorStarts).toEqual([{ url: APPROVED.connectorUrl, bearer: 'connector-bearer' }]);
    const starting = await portalRelayStatus(w.deps);
    expect(starting.health).toBe('starting');
    w.connectorBinds();
    const status = await portalRelayStatus(w.deps);
    expect(status).toMatchObject({ state: 'linked', health: 'up' });
    expect(status.linked).toMatchObject({ appBaseUrl: APP_BASE, mcpUrl: `${APP_BASE}/mcp` });
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'running' });
  });

  it('slow_down waits one extra interval', async () => {
    const w = fakeWorld();
    await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
    await beginPortalRelayLink({ portalOrigin: PORTAL }, w.deps);
    w.pollResults.push({ status: 'slow_down' });
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'polled' });
    w.advance(5_000);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'waiting' });
    w.advance(5_000);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'polled' });
  });

  it.each([
    ['denied', /denied/],
    ['expired', /expired/],
    ['invalid', /expired or was already used/],
  ] as const)('a %s grant turns the relay off with an explanation', async (status, message) => {
    const w = fakeWorld();
    await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
    await beginPortalRelayLink({ portalOrigin: PORTAL }, w.deps);
    w.pollResults.push({ status });
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'link-ended' });
    expect(w.row?.state).toBe('off');
    expect(w.row?.lastError).toMatch(message);
    // Consent survives: connecting again needs no new agreement.
    expect(w.row?.consentNoticeVersion).toBe(PORTAL_RELAY_NOTICE_VERSION);
  });

  it('a code that expires locally ends linking without polling', async () => {
    const w = fakeWorld();
    await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
    await beginPortalRelayLink({ portalOrigin: PORTAL }, w.deps);
    w.advance(601_000);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'link-ended' });
    expect(w.portal.pollToken).not.toHaveBeenCalled();
  });

  it('a portal error while polling is recorded, and linking continues', async () => {
    const w = fakeWorld();
    await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
    await beginPortalRelayLink({ portalOrigin: PORTAL }, w.deps);
    w.portal.pollToken.mockRejectedValueOnce(new PortalRelayError('portal_unavailable', 'The Papercusp portal did not answer'));
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'failed', error: 'The Papercusp portal did not answer' });
    expect(w.row).toMatchObject({ state: 'linking', lastError: 'The Papercusp portal did not answer' });
  });

  it('when the portal ends the link (revoked), the relay turns off and does not redial', async () => {
    const w = await linkedWorld();
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'started' });
    w.connectorEnds('revoked');
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'link-ended' });
    expect(w.row).toMatchObject({ state: 'off' });
    expect(w.row?.lastError).toMatch(/ended this computer's link/);
    expect(w.secrets.connectorBearer).toBeNull();
    w.advance(PORTAL_RELAY_RESTART_BACKOFF_MS * 2);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'idle' });
    expect(w.connectorStarts).toHaveLength(1);
  });

  it('a connector that stops for another reason restarts after the backoff', async () => {
    const w = await linkedWorld();
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'started' });
    w.connectorEnds('connector_closed');
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'backoff' });
    w.advance(PORTAL_RELAY_RESTART_BACKOFF_MS);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'started' });
    expect(w.connectorStarts).toHaveLength(2);
  });

  it('only the connector owner acts', async () => {
    const w = fakeWorld({ owner: false });
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'not-owner' });
  });

  it('another live operator that turned the relay on keeps it; a gone one is adopted', async () => {
    const live = await linkedWorld({ otherOperatorAnswers: true });
    await live.deps.store.setOperatorPort(3170);
    expect(await reconcilePortalRelay(live.deps)).toMatchObject({ action: 'other-operator' });
    expect(live.connectorStarts).toHaveLength(0);

    resetPortalRelayStateForTests();
    const gone = await linkedWorld({ otherOperatorAnswers: false });
    await gone.deps.store.setOperatorPort(3170);
    expect(await reconcilePortalRelay(gone.deps)).toMatchObject({ action: 'started' });
    expect(gone.row?.operatorPort).toBe(3070);
  });
});

describe('an open Remote access screen is told when the relay changes', () => {
  it('each user action notifies once', async () => {
    const w = fakeWorld();
    await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
    expect(w.notifyChanged).toHaveBeenCalledTimes(1);
    await beginPortalRelayLink({ portalOrigin: PORTAL }, w.deps);
    expect(w.notifyChanged).toHaveBeenCalledTimes(2);
    await cancelPortalRelayLink(w.deps);
    expect(w.notifyChanged).toHaveBeenCalledTimes(3);
    // Cancelling with nothing pending changes nothing, so nothing is pushed.
    await cancelPortalRelayLink(w.deps);
    expect(w.notifyChanged).toHaveBeenCalledTimes(3);
  });

  it('the reconciler pushes when the row or the connector changes, and stays quiet otherwise', async () => {
    const w = fakeWorld();
    await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
    await beginPortalRelayLink({ portalOrigin: PORTAL }, w.deps);
    w.notifyChanged.mockClear();
    // First pass records the baseline.
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'polled' });
    expect(w.notifyChanged).not.toHaveBeenCalled();
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'waiting' });
    expect(w.notifyChanged).not.toHaveBeenCalled();
    w.advance(5_000);
    w.pollResults.push(APPROVED);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'linked' });
    expect(w.notifyChanged).toHaveBeenCalledTimes(1);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'started' });
    expect(w.notifyChanged).toHaveBeenCalledTimes(2);
    // The portal's binding arrives: only this process knows, so the reconciler must say so.
    w.connectorBinds();
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'running' });
    expect(w.notifyChanged).toHaveBeenCalledTimes(3);
    expect(await reconcilePortalRelay(w.deps)).toMatchObject({ action: 'running' });
    expect(w.notifyChanged).toHaveBeenCalledTimes(3);
  });

  it('a process that does not run the connector never pushes from the reconciler', async () => {
    const w = fakeWorld({ owner: false });
    await reconcilePortalRelay(w.deps);
    await reconcilePortalRelay(w.deps);
    expect(w.notifyChanged).not.toHaveBeenCalled();
  });
});

describe('user actions after linking', () => {
  it('disconnect unlinks at the portal, stops the connector, and turns the relay off', async () => {
    const w = await linkedWorld();
    await reconcilePortalRelay(w.deps);
    const out = await disconnectPortalRelay(w.deps);
    expect(w.portal.unlink).toHaveBeenCalledWith(PORTAL, 'connector-bearer');
    expect(out).toMatchObject({ portalUnlinked: true, state: 'off' });
    expect(w.deps.connector.running()).toBe(false);
    expect(w.secrets.connectorBearer).toBeNull();
  });

  it('disconnect still turns the relay off here when the portal is unreachable', async () => {
    const w = await linkedWorld();
    w.portal.unlink.mockRejectedValueOnce(new Error('offline'));
    const out = await disconnectPortalRelay(w.deps);
    expect(out).toMatchObject({ portalUnlinked: false, state: 'off' });
  });

  it('connecting again while linked is refused', async () => {
    const w = await linkedWorld();
    await expect(beginPortalRelayLink({}, w.deps)).rejects.toMatchObject({ code: 'already_linked' });
  });

  it('cancel stops a pending link', async () => {
    const w = fakeWorld();
    await acceptPortalRelayNotice({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION }, w.deps);
    await beginPortalRelayLink({ portalOrigin: PORTAL }, w.deps);
    const out = await cancelPortalRelayLink(w.deps);
    expect(out.state).toBe('off');
    expect(w.secrets.deviceCode).toBeNull();
  });
});
