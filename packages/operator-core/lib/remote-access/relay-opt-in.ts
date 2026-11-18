/**
 * The opt-in Papercusp relay for local and bring-your-own-cloud installs (external-app-access
 * P-008; plan decisions D-001, D-009, D-031). It is the alternative to the user's own tunnel
 * (own-tunnel/, P-009): the install signs in to the portal once with a device grant and then keeps
 * an outbound connector, so an outside app reaches it through the portal with no router changes.
 *
 * R-20: the relay cannot be turned on until the user has agreed to the CURRENT relay notice (the
 * portal can read relayed calls while they pass through). `beginPortalRelayLink` refuses with
 * `consent_required` otherwise, and the stored CHECK makes a `linking` row without consent
 * impossible.
 *
 * Who acts (the own-tunnel rule): the connector runs in exactly one process per database, the host
 * singleton of the operator that turned the relay on (`operator_port`). A Papercusp-hosted machine
 * (PAPERCUSP_HOSTED_* set) never runs the local relay, so a process has at most one connector (#8).
 *
 *   portal-relay-store.ts    — the install's single remote_access_portal_relay row
 *   portal-relay-runtime.ts  — the connector in local mode (app channels only)
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { pinModuleState } from '@papercusp/module-singleton';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { isHostSingleton } from '../background-workers';
import {
  portalRelayConnectorRunning,
  portalRelayConnectorStatus,
  startPortalRelayConnector,
  portalRelayConnectorMatchesDesktopGrant,
  stopPortalRelayConnector,
  takePortalRelayTerminal,
  type PortalRelayConnectorStatus,
} from './portal-relay-runtime';
import { PORTAL_RELAY_NOTICE, PORTAL_RELAY_NOTICE_VERSION } from './relay-notice';
import {
  ensurePortalRelayRow,
  readPortalRelay,
  readPortalRelaySecrets,
  recordPortalRelayConsent,
  recordPortalRelayError,
  savePortalRelayDesktopGrant,
  clearPortalRelayDesktopGrant,
  currentPortalRelayDesktopGrant,
  PORTAL_RELAY_DESKTOP_NOTICE_VERSION,
  savePortalRelayLinked,
  savePortalRelayLinking,
  setPortalRelayOff,
  setPortalRelayOperatorPort,
  withPortalRelayLinkLock,
  type PortalRelayRow,
  type PortalRelaySecrets,
  type PortalRelayState,
  type PortalRelayStoreOptions,
  type SavePortalRelayLinked,
  type SavePortalRelayLinking,
  type PortalRelayDesktopGrant,
} from './portal-relay-store';
import { canonicalNoisePublicKey, loadOrCreateHostedMachineNoiseKeyPair, noisePublicKeyBase64 } from '../workspace-host/hosted-machine-noise-key';

export { PORTAL_RELAY_NOTICE, PORTAL_RELAY_NOTICE_VERSION };

export const DEFAULT_PORTAL_ORIGIN = 'https://app.papercusp.com';
export const PORTAL_RELAY_RECONCILE_INTERVAL_MS = 5_000;
/** Minimum spacing between connector restarts after it stops on its own. */
export const PORTAL_RELAY_RESTART_BACKOFF_MS = 30_000;
export const PORTAL_RELAY_DESKTOP_NOTICE = 'Allow this approved browser and portal account to view agent sandbox desktops in the selected local workspace. Control is a separate choice and permits keyboard and pointer input. This grants no terminal, files or general operator access. Desktop content is encrypted between this computer and the approved browser. You can revoke desktop access here at any time.';

export class PortalRelayError extends Error {
  constructor(
    readonly code:
      | 'consent_required'
      | 'notice_outdated'
      | 'hosted_machine'
      | 'already_linked'
      | 'portal_origin_conflict'
      | 'desktop_grant_invalid'
      | 'desktop_binding_changed'
      | 'invalid_portal_origin'
      | 'portal_unavailable'
      | 'portal_refused',
    message: string,
  ) {
    super(message);
    this.name = 'PortalRelayError';
  }
}

/** R-20: the relay may start linking only after agreement to the CURRENT notice version. */
export function assertPortalRelayConsent(row: Pick<PortalRelayRow, 'consentNoticeVersion' | 'consentedAt'> | null): void {
  if (!row || row.consentedAt === null || row.consentNoticeVersion !== PORTAL_RELAY_NOTICE_VERSION) {
    throw new PortalRelayError(
      'consent_required',
      'Read and accept the relay notice before connecting this computer to the Papercusp relay',
    );
  }
}

/** D-031 #8: a Papercusp-hosted machine already runs the hosted connector; it never links. */
export function isPapercuspHostedMachine(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([key, value]) => key.startsWith('PAPERCUSP_HOSTED_') && Boolean(value?.trim()));
}

export function normalizePortalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PortalRelayError('invalid_portal_origin', 'The portal address is not a URL');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  // A bearer travels to this origin, so cleartext is allowed only to this computer (a dev portal).
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new PortalRelayError('invalid_portal_origin', 'The portal address must use https');
  }
  return url.origin;
}

/** What this install calls the portal: a device grant, its poll, the connector registration, the unlink. */
export interface PortalRelayPortalClient {
  requestCode(portalOrigin: string, input: { installId: string; installLabel: string }): Promise<{
    deviceCode: string; userCode: string; verificationUriComplete: string; expiresIn: number; interval: number;
  }>;
  pollToken(portalOrigin: string, deviceCode: string): Promise<
    | { status: 'pending' | 'slow_down' | 'denied' | 'expired' | 'invalid' }
    | {
        status: 'approved';
        userId: string;
        organizationId: string;
        customerWorkspaceId: string;
        enrollmentTicket: string;
        registerUrl: string;
        connectorUrl: string;
        appBaseUrl: string;
      }
  >;
  register(registerUrl: string, ticket: string): Promise<{ bearer: string }>;
  unlink(portalOrigin: string, bearer: string): Promise<void>;
}

export interface PortalRelayDeps {
  readonly store: {
    withLinkLock<T>(run: (store: PortalRelayDeps['store']) => Promise<T>): Promise<T>;
    read(): Promise<PortalRelayRow | null>;
    readSecrets(): Promise<PortalRelaySecrets>;
    ensureRow(input: { installId: string; portalOrigin: string }): Promise<void>;
    recordConsent(input: { noticeVersion: number; by: string | null }): Promise<boolean>;
    saveLinking(t: SavePortalRelayLinking): Promise<void>;
    saveLinked(t: SavePortalRelayLinked): Promise<void>;
    setOff(error: string | null): Promise<void>;
    recordError(message: string | null): Promise<void>;
    setOperatorPort(port: number): Promise<void>;
    saveDesktopGrant(grant: PortalRelayDesktopGrant): Promise<boolean>;
    clearDesktopGrant(): Promise<void>;
  };
  readonly portal: PortalRelayPortalClient;
  readonly connector: {
    readonly running: () => boolean;
    readonly status: () => PortalRelayConnectorStatus;
    readonly start: (input: { url: string; bearer: string; desktopGrant?: PortalRelayDesktopGrant | null }) => Promise<void>;
    readonly matchesDesktopGrant?: (grant: PortalRelayDesktopGrant | null) => boolean;
    readonly stop: () => void;
    /** The reason the connector ended on its own since the last call, if any. */
    readonly takeTerminal: () => { reason: string; detail: string } | null;
  };
  readonly env: NodeJS.ProcessEnv;
  readonly isConnectorOwner: () => boolean;
  /** Does an operator answer on this loopback port? Used before adopting a stale operator_port. */
  readonly operatorAnswers: (port: number) => Promise<boolean>;
  readonly installLabel: () => string;
  readonly newInstallId: () => string;
  readonly now: () => number;
  readonly localWorkspaceExists: (workspaceId: string) => Promise<boolean>;
  readonly machineNoisePublicKey: () => Promise<string>;
  /** Tell an open Remote access screen to re-read (every workspace's view; the relay is install-wide). Never throws. */
  readonly notifyChanged: () => void;
}

/** The sync query the Remote access screen reads (sync-resolver `remoteAccess.overview`). */
export const PORTAL_RELAY_SCREEN_QUERY = 'remoteAccess.overview';

function defaultNotifyChanged(): void {
  void import('../sync-sse')
    // No args: every workspace's copy of the screen. A short dedupe window, because linking moves
    // through several states within seconds and the bus's 90s default would swallow all but one.
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate(PORTAL_RELAY_SCREEN_QUERY, undefined, undefined, { dedupeWindowMs: 1_000 }))
    .catch(() => undefined);
}

// ── portal client (fetch) ──────────────────────────────────────────────────────────────────────

/**
 * The message of a failed fetch, with its cause chain. undici rejects with a bare
 * `TypeError('fetch failed')` and puts the real reason (EAI_AGAIN, ECONNRESET,
 * UND_ERR_CONNECT_TIMEOUT, a certificate error) on `err.cause`; reporting only `err.message`
 * made a failed relay connect undiagnosable (WI-10004520).
 */
export function describeFetchFailure(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 4; depth++) {
    if (cur instanceof Error || (typeof cur === 'object' && cur !== null)) {
      const e = cur as { message?: unknown; code?: unknown; cause?: unknown };
      const message = typeof e.message === 'string' ? e.message : '';
      const code = typeof e.code === 'string' ? e.code : '';
      const part = message && code && !message.includes(code) ? `${message} (${code})` : message || code;
      if (part && !parts.includes(part)) parts.push(part);
      cur = e.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(': ') || String(err);
}

async function portalJson(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new PortalRelayError('portal_unavailable', `The Papercusp portal did not answer: ${describeFetchFailure(err)}`);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const errorCode = (body: Record<string, unknown>): string => {
  const e = body.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') return (e as { code: string }).code;
  return 'unknown_error';
};

export const fetchPortalRelayClient: PortalRelayPortalClient = {
  async requestCode(portalOrigin, input) {
    const { status, body } = await portalJson(`${portalOrigin}/api/hosted/relay/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const deviceCode = text(body.deviceCode);
    const userCode = text(body.userCode);
    const verificationUriComplete = text(body.verificationUriComplete);
    if (status !== 200 || !deviceCode || !userCode || !verificationUriComplete) {
      throw new PortalRelayError('portal_refused', `The portal refused to start linking (${status} ${errorCode(body)})`);
    }
    return {
      deviceCode, userCode, verificationUriComplete,
      expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : 600,
      interval: typeof body.interval === 'number' ? body.interval : 5,
    };
  },
  async pollToken(portalOrigin, deviceCode) {
    const { status, body } = await portalJson(`${portalOrigin}/api/hosted/relay/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
    });
    if (status === 200 && body.ok === true) {
      const fields = {
        userId: text(body.userId),
        organizationId: text(body.organizationId),
        customerWorkspaceId: text(body.customerWorkspaceId),
        enrollmentTicket: text(body.enrollmentTicket),
        registerUrl: text(body.registerUrl),
        connectorUrl: text(body.connectorUrl),
        appBaseUrl: text(body.appBaseUrl),
      };
      if (Object.values(fields).some((v) => v === null)) {
        throw new PortalRelayError('portal_refused', 'The portal approved the link but its answer was incomplete');
      }
      return { status: 'approved', ...(fields as { [K in keyof typeof fields]: string }) };
    }
    switch (errorCode(body)) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow_down' };
      case 'access_denied':
        return { status: 'denied' };
      case 'expired_token':
        return { status: 'expired' };
      case 'invalid_grant':
        return { status: 'invalid' };
      default:
        throw new PortalRelayError('portal_refused', `The portal could not finish linking (${status} ${errorCode(body)})`);
    }
  },
  async register(registerUrl, ticket) {
    const { status, body } = await portalJson(registerUrl, {
      method: 'POST',
      headers: { 'x-papercusp-connector-ticket': ticket },
    });
    const bearer = text(body.bearer);
    if (status !== 200 || !bearer) {
      throw new PortalRelayError('portal_refused', `The portal refused this computer's connector (${status} ${errorCode(body)})`);
    }
    return { bearer };
  },
  async unlink(portalOrigin, bearer) {
    const { status, body } = await portalJson(`${portalOrigin}/api/hosted/relay/unlink`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (status !== 200) throw new PortalRelayError('portal_refused', `The portal did not unlink (${status} ${errorCode(body)})`);
  },
};

// ── defaults ───────────────────────────────────────────────────────────────────────────────────

/** The port this operator serves on — the same resolution hono-host uses (own-tunnel/service.ts). */
export function currentRelayOperatorPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = Number(env.PAPERCUSP_HONO_PORT ?? env.PORT ?? 3070);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

async function defaultOperatorAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function dataDir(env: NodeJS.ProcessEnv): string {
  return env.PAPERCUSP_HOME?.trim() || `${env.HOME ?? '.'}/.papercusp`;
}

export function defaultPortalRelayDeps(overrides: Partial<PortalRelayDeps> = {}, storeOpts?: PortalRelayStoreOptions): PortalRelayDeps {
  const env = overrides.env ?? process.env;
  return {
    store: createPortalRelayStore(storeOpts),
    portal: fetchPortalRelayClient,
    connector: {
      running: portalRelayConnectorRunning,
      status: portalRelayConnectorStatus,
      // The relay serves no files; the root only satisfies the adapter, which refuses pty channels.
      start: (input) => startPortalRelayConnector({ ...input, workspaceRoot: dataDir(env) }),
      matchesDesktopGrant: portalRelayConnectorMatchesDesktopGrant,
      stop: () => stopPortalRelayConnector(),
      takeTerminal: takePortalRelayTerminal,
    },
    env,
    isConnectorOwner: () => isHostSingleton(),
    operatorAnswers: defaultOperatorAnswers,
    installLabel: () => osHostname(),
    newInstallId: () => `inst-${randomBytes(12).toString('hex')}`,
    now: () => Date.now(),
    localWorkspaceExists: async (id) => !!(await import('../workspace-registry')).workspaceById(id),
    machineNoisePublicKey: async () => noisePublicKeyBase64((await loadOrCreateHostedMachineNoiseKeyPair()).publicKey),
    notifyChanged: defaultNotifyChanged,
    ...overrides,
  };
}

function createPortalRelayStore(opts?: PortalRelayStoreOptions): PortalRelayDeps['store'] {
  return {
    withLinkLock: (run) => withPortalRelayLinkLock((txOpts) => run(createPortalRelayStore(txOpts)), opts),
    read: () => readPortalRelay(opts),
    readSecrets: () => readPortalRelaySecrets(opts),
    ensureRow: (input) => ensurePortalRelayRow(input, opts),
    recordConsent: (input) => recordPortalRelayConsent(input, opts),
    saveLinking: (t) => savePortalRelayLinking(t, opts),
    saveLinked: (t) => savePortalRelayLinked(t, opts),
    setOff: (error) => setPortalRelayOff(error, opts),
    recordError: (message) => recordPortalRelayError(message, opts),
    setOperatorPort: (port) => setPortalRelayOperatorPort(port, opts),
    saveDesktopGrant: (grant) => savePortalRelayDesktopGrant(grant, opts),
    clearDesktopGrant: () => clearPortalRelayDesktopGrant(opts),
  };
}

function withRelayLinkLock<T>(deps: PortalRelayDeps, run: (locked: PortalRelayDeps) => Promise<T>): Promise<T> {
  return deps.store.withLinkLock((store) => run({ ...deps, store }));
}

// ── status ─────────────────────────────────────────────────────────────────────────────────────

export interface PortalRelayStatus {
  readonly state: PortalRelayState;
  readonly available: boolean;
  /** Why the relay cannot be used here, when it cannot ('hosted_machine'). */
  readonly unavailableReason: 'hosted_machine' | null;
  readonly portalOrigin: string;
  readonly installId: string | null;
  readonly notice: { readonly version: number; readonly text: string };
  readonly consent: { readonly agreed: boolean; readonly version: number | null; readonly at: string | null };
  readonly pending: { readonly userCode: string; readonly verificationUri: string; readonly expiresAt: string | null } | null;
  readonly linked: {
    readonly userId: string | null;
    readonly organizationId: string | null;
    readonly customerWorkspaceId: string | null;
    readonly appBaseUrl: string | null;
    /** The MCP URL an outside app (Claude.ai, ChatGPT) uses through the relay. */
    readonly mcpUrl: string | null;
    readonly linkedAt: string | null;
  } | null;
  readonly desktop: {
    readonly notice: { readonly version: number; readonly text: string };
    readonly grant: PortalRelayDesktopGrant | null;
  };
  /** Connector state when this process runs it; null when another process does. */
  readonly connector: PortalRelayConnectorStatus | null;
  readonly health: 'off' | 'linking' | 'starting' | 'up' | 'down';
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
}

/**
 * The portal serves a workspace's MCP at `/api/workspaces/:id/mcp` (apps/operator/bin/hosted-handler.ts),
 * and `appBaseUrl` is `<portal>/api/workspaces/<id>`, so the MCP URL is the base plus `/mcp`.
 */
export function portalRelayMcpUrl(appBaseUrl: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/mcp`;
}

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export async function portalRelayStatus(deps: PortalRelayDeps = defaultPortalRelayDeps()): Promise<PortalRelayStatus> {
  const row = await deps.store.read();
  const hosted = isPapercuspHostedMachine(deps.env);
  const connector = deps.isConnectorOwner() ? deps.connector.status() : null;
  const state: PortalRelayState = row?.state ?? 'off';
  let health: PortalRelayStatus['health'];
  if (state === 'off') health = 'off';
  else if (state === 'linking') health = 'linking';
  else if (connector) health = connector.bound ? 'up' : connector.running ? 'starting' : 'down';
  else health = row?.lastError ? 'down' : 'starting';
  const agreed = !!row && row.consentedAt !== null && row.consentNoticeVersion === PORTAL_RELAY_NOTICE_VERSION;
  return {
    state,
    available: !hosted,
    unavailableReason: hosted ? 'hosted_machine' : null,
    portalOrigin: row?.portalOrigin ?? configuredPortalOrigin(deps.env),
    installId: row?.installId ?? null,
    notice: { version: PORTAL_RELAY_NOTICE_VERSION, text: PORTAL_RELAY_NOTICE },
    consent: { agreed, version: row?.consentNoticeVersion ?? null, at: iso(row?.consentedAt ?? null) },
    pending:
      state === 'linking' && row?.userCode && row.verificationUri
        ? { userCode: row.userCode, verificationUri: row.verificationUri, expiresAt: iso(row.grantExpiresAt) }
        : null,
    linked:
      state === 'linked' && row
        ? {
            userId: row.linkedUserId,
            organizationId: row.organizationId,
            customerWorkspaceId: row.customerWorkspaceId,
            appBaseUrl: row.appBaseUrl,
            mcpUrl: row.appBaseUrl ? portalRelayMcpUrl(row.appBaseUrl) : null,
            linkedAt: iso(row.linkedAt),
          }
        : null,
    desktop: {
      notice: { version: PORTAL_RELAY_DESKTOP_NOTICE_VERSION, text: PORTAL_RELAY_DESKTOP_NOTICE },
      grant: currentPortalRelayDesktopGrant(row),
    },
    connector,
    health,
    lastError: row?.lastError ?? null,
    lastErrorAt: iso(row?.lastErrorAt ?? null),
  };
}

export function configuredPortalOrigin(env: NodeJS.ProcessEnv): string {
  const configured = env.PAPERCUSP_PORTAL_ORIGIN?.trim();
  if (!configured) return DEFAULT_PORTAL_ORIGIN;
  try {
    return normalizePortalOrigin(configured);
  } catch {
    return DEFAULT_PORTAL_ORIGIN;
  }
}

// ── user actions ───────────────────────────────────────────────────────────────────────────────

async function ensureRow(deps: PortalRelayDeps, portalOrigin?: string): Promise<PortalRelayRow> {
  const existing = await deps.store.read();
  const origin = portalOrigin ? normalizePortalOrigin(portalOrigin) : existing?.portalOrigin ?? configuredPortalOrigin(deps.env);
  await deps.store.ensureRow({ installId: existing?.installId ?? deps.newInstallId(), portalOrigin: origin });
  const row = await deps.store.read();
  if (!row) throw new Error('the relay settings could not be saved');
  return row;
}

function refuseOnHostedMachine(deps: PortalRelayDeps): void {
  if (isPapercuspHostedMachine(deps.env)) {
    throw new PortalRelayError('hosted_machine', 'A Papercusp-hosted workspace is already reachable through Papercusp; it does not use the relay');
  }
}

/** Record agreement to the relay notice the user was shown. Only the current version counts. */
export async function acceptPortalRelayNotice(
  input: { noticeVersion: number; by?: string | null },
  deps: PortalRelayDeps = defaultPortalRelayDeps(),
): Promise<PortalRelayStatus> {
  refuseOnHostedMachine(deps);
  if (input.noticeVersion !== PORTAL_RELAY_NOTICE_VERSION) {
    throw new PortalRelayError('notice_outdated', 'The relay notice has changed; read the current one and agree again');
  }
  const status = await withRelayLinkLock(deps, async (locked) => {
    await ensureRow(locked);
    await locked.store.recordConsent({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION, by: input.by ?? null });
    return portalRelayStatus(locked);
  });
  deps.notifyChanged();
  return status;
}

/**
 * Start linking: ask the portal for a device code and remember it. The user opens the returned
 * address, signs in and approves; the reconciler then finishes the link on its own.
 */
export async function beginPortalRelayLink(
  input: { portalOrigin?: string } = {},
  deps: PortalRelayDeps = defaultPortalRelayDeps(),
): Promise<PortalRelayStatus> {
  refuseOnHostedMachine(deps);
  let changed = false;
  const status = await withRelayLinkLock(deps, async (locked) => {
    const current = await locked.store.read();
    // Re-read consent after taking the cross-process lock, including on a reused link.
    assertPortalRelayConsent(current);
    if (current && current.state !== 'off' && input.portalOrigin && normalizePortalOrigin(input.portalOrigin) !== current.portalOrigin) {
      throw new PortalRelayError('portal_origin_conflict', 'Disconnect this computer before connecting it to a different portal');
    }
    if (current?.state === 'linked') return portalRelayStatus(locked);
    if (current?.state === 'linking' && current.userCode && current.verificationUri &&
        current.grantExpiresAt && new Date(current.grantExpiresAt).getTime() > locked.now() &&
        (await locked.store.readSecrets()).deviceCode) {
      return portalRelayStatus(locked);
    }
    const row = await ensureRow(locked, input.portalOrigin);
    const code = await locked.portal.requestCode(row.portalOrigin, { installId: row.installId, installLabel: locked.installLabel().slice(0, 120) });
    await locked.store.saveLinking({
      userCode: code.userCode,
      verificationUri: code.verificationUriComplete,
      deviceCode: code.deviceCode,
      grantExpiresAt: new Date(locked.now() + code.expiresIn * 1000),
      pollIntervalSec: Math.max(1, Math.round(code.interval)),
    });
    state.lastPollAt = 0;
    changed = true;
    return portalRelayStatus(locked);
  });
  if (changed) deps.notifyChanged();
  return status;
}

/** Stop linking before it finishes. */
export async function cancelPortalRelayLink(deps: PortalRelayDeps = defaultPortalRelayDeps()): Promise<PortalRelayStatus> {
  let changed = false;
  const status = await withRelayLinkLock(deps, async (locked) => {
    const row = await locked.store.read();
    if (row?.state === 'linking') {
      await locked.store.setOff(null);
      changed = true;
    }
    return portalRelayStatus(locked);
  });
  if (changed) deps.notifyChanged();
  return status;
}

/**
 * Disconnect: tell the portal (best effort, so an offline portal cannot keep a computer linked
 * from this side), stop the connector here at once, and turn the relay off.
 */
export async function disconnectPortalRelay(deps: PortalRelayDeps = defaultPortalRelayDeps()): Promise<PortalRelayStatus & { portalUnlinked: boolean }> {
  const result = await withRelayLinkLock(deps, disconnectLockedPortalRelay);
  if (result.changed) deps.notifyChanged();
  return result.status;
}

async function disconnectLockedPortalRelay(deps: PortalRelayDeps): Promise<{ status: PortalRelayStatus & { portalUnlinked: boolean }; changed: boolean }> {
  const row = await deps.store.read();
  let portalUnlinked = false;
  if (row?.state === 'linked') {
    const { connectorBearer } = await deps.store.readSecrets();
    if (connectorBearer) {
      try {
        await deps.portal.unlink(row.portalOrigin, connectorBearer);
        portalUnlinked = true;
      } catch {
        portalUnlinked = false;
      }
    }
  }
  deps.connector.stop();
  if (row && row.state !== 'off') {
    await deps.store.setOff(null);
  }
  return { status: { ...(await portalRelayStatus(deps)), portalUnlinked }, changed: !!row && row.state !== 'off' };
}

export interface PortalRelayDesktopApproval {
  readonly noticeVersion: number;
  readonly installId: string;
  readonly portalOrigin: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly customerWorkspaceId: string;
  readonly localWorkspaceId: string;
  readonly browserPublicKey: string;
  readonly view: true;
  readonly control: boolean;
}

/** Only the local same-origin control calls this, after displaying the actual linked account. */
export async function approvePortalRelayDesktop(
  input: PortalRelayDesktopApproval,
  deps: PortalRelayDeps = defaultPortalRelayDeps(),
): Promise<PortalRelayStatus & { machinePublicKey: string }> {
  refuseOnHostedMachine(deps);
  if (input.noticeVersion !== PORTAL_RELAY_DESKTOP_NOTICE_VERSION || input.view !== true ||
      typeof input.control !== 'boolean' || !canonicalNoisePublicKey(input.browserPublicKey) ||
      typeof input.localWorkspaceId !== 'string' || !input.localWorkspaceId.trim() ||
      !await deps.localWorkspaceExists(input.localWorkspaceId)) {
    throw new PortalRelayError('desktop_grant_invalid', 'Choose a local workspace, a valid browser key and the current desktop permissions');
  }
  let changed = false;
  const result = await withRelayLinkLock(deps, async (locked) => {
    const row = await locked.store.read();
    assertPortalRelayConsent(row);
    if (!row || row.state !== 'linked' || !row.linkedUserId ||
        input.userId !== row.linkedUserId || input.installId !== row.installId ||
        input.portalOrigin !== row.portalOrigin || input.organizationId !== row.organizationId ||
        input.customerWorkspaceId !== row.customerWorkspaceId) {
      throw new PortalRelayError('desktop_binding_changed', 'The linked account or computer changed. Confirm its current identity before granting desktop access');
    }
    const machinePublicKey = await locked.machineNoisePublicKey();
    if (!canonicalNoisePublicKey(machinePublicKey)) throw new Error('invalid_machine_noise_key');
    const existing = currentPortalRelayDesktopGrant(row);
    if (existing && existing.browserPublicKey === input.browserPublicKey &&
        existing.localWorkspaceId === input.localWorkspaceId && existing.control === input.control) {
      return { ...await portalRelayStatus(locked), machinePublicKey };
    }
    const grant: PortalRelayDesktopGrant = {
      version: 1, id: randomUUID(), installId: row.installId, portalOrigin: row.portalOrigin,
      userId: row.linkedUserId, organizationId: row.organizationId!, customerWorkspaceId: row.customerWorkspaceId!,
      localWorkspaceId: input.localWorkspaceId, browserPublicKey: input.browserPublicKey,
      view: true, control: input.control, grantedAt: new Date(locked.now()).toISOString(),
    };
    if (!await locked.store.saveDesktopGrant(grant)) {
      throw new PortalRelayError('desktop_binding_changed', 'The link changed while recording desktop consent');
    }
    // Close old channels before the new key/scope can be used.
    locked.connector.stop();
    state.lastConnectorStartAt = 0;
    changed = true;
    return { ...await portalRelayStatus(locked), machinePublicKey };
  });
  if (changed) {
    await refreshDesktopConnector(deps);
    deps.notifyChanged();
  }
  return { ...await portalRelayStatus(deps), machinePublicKey: result.machinePublicKey };
}

/** Drop only desktop authority. The existing app relay remains approved. */
export async function revokePortalRelayDesktop(deps: PortalRelayDeps = defaultPortalRelayDeps()): Promise<PortalRelayStatus> {
  await withRelayLinkLock(deps, async (locked) => {
    await locked.store.clearDesktopGrant();
    locked.connector.stop();
    state.lastConnectorStartAt = 0;
  });
  await refreshDesktopConnector(deps);
  deps.notifyChanged();
  return portalRelayStatus(deps);
}

// ── reconciler ─────────────────────────────────────────────────────────────────────────────────

const state = pinModuleState('@papercusp/operator-core.remote-access.relay-opt-in', () => ({
  reconcilerArmed: false,
  reconcilerDeps: undefined as PortalRelayDeps | undefined,
  reconcileInFlight: null as Promise<PortalRelayReconcileResult> | null,
  lastPollAt: 0,
  lastConnectorStartAt: 0,
  lastLoggedError: null as string | null,
  lastFingerprint: null as string | null,
}));

/** A local authority change must not leave the connector down until the next
 * sampling tick. Reuse the boot-elected composition, including isolated hosts'
 * explicit owner election. Wait outside the link lock for any older pass before
 * requesting one against the newly persisted grant. Workers leave this to their
 * singleton rather than starting a second connector. */
async function refreshDesktopConnector(deps: PortalRelayDeps): Promise<void> {
  const owner = state.reconcilerDeps ?? deps;
  if (!owner.isConnectorOwner()) return;
  if (state.reconcileInFlight) await state.reconcileInFlight;
  await reconcilePortalRelay(owner);
}

export interface PortalRelayReconcileResult {
  readonly action:
    | 'hosted-machine'
    | 'not-owner'
    | 'idle'
    | 'stopped'
    | 'waiting'
    | 'polled'
    | 'linked'
    | 'link-ended'
    | 'other-operator'
    | 'running'
    | 'started'
    | 'backoff'
    | 'failed';
  readonly error: string | null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pollLink(row: PortalRelayRow, deps: PortalRelayDeps): Promise<PortalRelayReconcileResult> {
  if (row.grantExpiresAt && new Date(row.grantExpiresAt).getTime() <= deps.now()) {
    await deps.store.setOff('The code expired before it was approved. Connect again to get a new one.');
    return { action: 'link-ended', error: null };
  }
  const intervalMs = Math.max(1, row.pollIntervalSec ?? 5) * 1000;
  if (deps.now() - state.lastPollAt < intervalMs) return { action: 'waiting', error: null };
  state.lastPollAt = deps.now();
  const { deviceCode } = await deps.store.readSecrets();
  if (!deviceCode) {
    await deps.store.setOff('The pending link lost its code. Connect again.');
    return { action: 'link-ended', error: null };
  }
  const result = await deps.portal.pollToken(row.portalOrigin, deviceCode);
  switch (result.status) {
    case 'pending':
      return { action: 'polled', error: null };
    case 'slow_down':
      state.lastPollAt = deps.now() + intervalMs; // one extra interval, as RFC 8628 asks
      return { action: 'polled', error: null };
    case 'denied':
      await deps.store.setOff('The link was denied on the Papercusp portal.');
      return { action: 'link-ended', error: null };
    case 'expired':
    case 'invalid':
      await deps.store.setOff('The code expired or was already used. Connect again to get a new one.');
      return { action: 'link-ended', error: null };
    case 'approved': {
      const { bearer } = await deps.portal.register(result.registerUrl, result.enrollmentTicket);
      await deps.store.saveLinked({
        userId: result.userId,
        organizationId: result.organizationId,
        customerWorkspaceId: result.customerWorkspaceId,
        appBaseUrl: result.appBaseUrl,
        connectorUrl: result.connectorUrl,
        connectorBearer: bearer,
        operatorPort: currentRelayOperatorPort(deps.env),
      });
      state.lastConnectorStartAt = 0;
      return { action: 'linked', error: null };
    }
  }
}

async function runLinked(row: PortalRelayRow, deps: PortalRelayDeps): Promise<PortalRelayReconcileResult> {
  const terminal = deps.connector.takeTerminal();
  if (terminal?.reason === 'revoked') {
    // The portal ended the link (unlinked there, or the connector was revoked): stop trying.
    await deps.store.setOff('The Papercusp portal ended this computer\'s link. Connect again to relink it.');
    return { action: 'link-ended', error: null };
  }
  const opPort = currentRelayOperatorPort(deps.env);
  if (row.operatorPort !== null && opPort !== null && row.operatorPort !== opPort) {
    // Another operator on this database turned the relay on. Adopt it only when that one is gone.
    if (await deps.operatorAnswers(row.operatorPort)) {
      if (deps.connector.running()) deps.connector.stop();
      return { action: 'other-operator', error: null };
    }
    await deps.store.setOperatorPort(opPort);
  }
  const desktopGrant = currentPortalRelayDesktopGrant(row);
  if (deps.connector.running() && deps.connector.matchesDesktopGrant && !deps.connector.matchesDesktopGrant(desktopGrant)) {
    deps.connector.stop();
    state.lastConnectorStartAt = 0;
  }
  if (deps.connector.running()) {
    if (row.lastError && deps.connector.status().bound) await deps.store.recordError(null);
    return { action: 'running', error: null };
  }
  if (deps.now() - state.lastConnectorStartAt < PORTAL_RELAY_RESTART_BACKOFF_MS) return { action: 'backoff', error: null };
  const { connectorBearer } = await deps.store.readSecrets();
  if (!connectorBearer || !row.connectorUrl) {
    await deps.store.setOff('The saved link has no connector credential. Connect again.');
    return { action: 'link-ended', error: null };
  }
  state.lastConnectorStartAt = deps.now();
  await deps.connector.start({ url: row.connectorUrl, bearer: connectorBearer, desktopGrant });
  return { action: 'started', error: null };
}

/**
 * What the Remote access screen shows, reduced to the parts that change: the row's state and
 * last write, and the connector's running/bound flags. `bound` lives only in this process, so the
 * reconciler (the process that runs the connector) is what tells the screen it changed.
 */
async function screenFingerprint(deps: PortalRelayDeps): Promise<string> {
  const row = await deps.store.read();
  const c = deps.connector.status();
  return [row?.state ?? 'none', row?.updatedAt ? new Date(row.updatedAt).getTime() : 0, c.running, c.bound].join('|');
}

async function reconcileOnce(deps: PortalRelayDeps): Promise<PortalRelayReconcileResult> {
  const result = await reconcileStep(deps);
  if (result.action === 'hosted-machine' || result.action === 'not-owner') return result;
  const fingerprint = await screenFingerprint(deps);
  if (fingerprint !== state.lastFingerprint) {
    // The first pass after boot records the baseline without a push: nothing on screen changed.
    const first = state.lastFingerprint === null;
    state.lastFingerprint = fingerprint;
    if (!first) deps.notifyChanged();
  }
  return result;
}

async function reconcileStep(deps: PortalRelayDeps): Promise<PortalRelayReconcileResult> {
  if (isPapercuspHostedMachine(deps.env)) {
    if (deps.connector.running()) deps.connector.stop();
    return { action: 'hosted-machine', error: null };
  }
  if (!deps.isConnectorOwner()) return { action: 'not-owner', error: null };
  return withRelayLinkLock(deps, reconcileLockedStep);
}

async function reconcileLockedStep(deps: PortalRelayDeps): Promise<PortalRelayReconcileResult> {
  const row = await deps.store.read();
  if (!row || row.state === 'off') {
    if (deps.connector.running()) {
      deps.connector.stop();
      return { action: 'stopped', error: null };
    }
    // A deliberate stop is not a crash: connecting again starts without backoff.
    state.lastConnectorStartAt = 0;
    return { action: 'idle', error: null };
  }
  try {
    if (row.state === 'linking') {
      if (deps.connector.running()) deps.connector.stop();
      return await pollLink(row, deps);
    }
    return await runLinked(row, deps);
  } catch (err) {
    const message = errMessage(err);
    if (message !== row.lastError) await deps.store.recordError(message);
    return { action: 'failed', error: message };
  }
}

/** Make this process match the row. Concurrent calls share one pass. Never throws. */
export async function reconcilePortalRelay(deps: PortalRelayDeps = defaultPortalRelayDeps()): Promise<PortalRelayReconcileResult> {
  if (state.reconcileInFlight) return state.reconcileInFlight;
  const run = reconcileOnce(deps)
    .catch((err): PortalRelayReconcileResult => {
      const message = errMessage(err);
      if (message !== state.lastLoggedError) {
        state.lastLoggedError = message;
        console.warn('[portal-relay] reconcile failed:', message);
      }
      return { action: 'failed', error: message };
    })
    .finally(() => {
      state.reconcileInFlight = null;
    });
  state.reconcileInFlight = run;
  return run;
}

/** Arm the periodic reconciler (idempotent per process) and run one pass now. hono-host calls it on the primary. */
export function startPortalRelayReconciler(deps?: PortalRelayDeps): void {
  // Boot may arm the timer before an isolated host elects its connector owner.
  // Keep one timer, but let an explicit composition update its dependencies.
  // A later default boot call must not discard that explicit composition.
  if (deps) state.reconcilerDeps = deps;
  void reconcilePortalRelay(state.reconcilerDeps);
  if (state.reconcilerArmed) return;
  state.reconcilerArmed = true;
  managedSetInterval(
    'portal-relay-reconciler',
    PORTAL_RELAY_RECONCILE_INTERVAL_MS,
    async () => {
      await reconcilePortalRelay(state.reconcilerDeps);
    },
    // must-sample: the portal grant poll, operator health and connector exits push nothing here.
    { category: 'watchdog', classification: 'must-sample' },
  );
}

/** Test seam: forget module state between cases. */
export function resetPortalRelayStateForTests(): void {
  state.reconcilerArmed = false;
  state.reconcilerDeps = undefined;
  state.reconcileInFlight = null;
  state.lastPollAt = 0;
  state.lastConnectorStartAt = 0;
  state.lastLoggedError = null;
  state.lastFingerprint = null;
}
