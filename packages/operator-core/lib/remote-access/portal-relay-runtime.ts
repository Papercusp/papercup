/**
 * The relay connector of a relay-linked local install (external-app-access P-008, D-031 #7).
 *
 * It is the SAME outbound connector a Papercusp-hosted machine runs (HostedWorkspaceConnectorClient
 * + HostedWorkspaceHostSessionAdapter, built by createHostedWorkspaceHostRuntime), in a local mode:
 *   - app channels remain available independently. Desktop discovery and media require a
 *     separate current local approval and the approved browser's proven Noise key;
 *   - no D-421 agent spawn transform is installed (that is ensureHostedWorkspaceHostRuntime's,
 *     for a hosted VM's customer account) and the bound workspace is NOT made current: this
 *     install's own workspace choice stays the user's;
 *   - desktop access is confined to the approved local workspace's existing desktops.
 * App calls reach the operator with the deny-only ingress marker (D-015), so keys and scopes are
 * checked exactly as on the own-tunnel path.
 *
 * One connector per process, pinned (pinModuleState). Only the host singleton runs it; the
 * reconciler in relay-opt-in.ts decides that.
 */
import { createHash } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import type { HostedWorkspaceHostRuntime } from '../workspace-host/hosted-workspace-host-runtime';
import { currentPortalRelayDesktopGrant, readPortalRelay, type PortalRelayDesktopGrant } from './portal-relay-store';

export interface PortalRelayConnectorStatus {
  readonly running: boolean;
  /** The portal's binding arrived: the link is live end to end. */
  readonly bound: boolean;
  readonly startedAt: string | null;
  /** Why the connector ended on its own, if it did ('revoked' = the portal ended the link). */
  readonly terminal: { reason: string; detail: string; at: string } | null;
}

interface RunningConnector {
  readonly runtime: HostedWorkspaceHostRuntime;
  readonly url: string;
  readonly bearerDigest: string;
  readonly desktopGrantDigest: string;
  readonly startedAt: Date;
}

const state = pinModuleState('@papercusp/operator-core.remote-access.portal-relay-runtime', () => ({
  current: null as RunningConnector | null,
  terminal: null as { reason: string; detail: string; at: Date } | null,
}));

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
// PostgreSQL JSONB does not preserve object property order.
const grantDigest = (grant: PortalRelayDesktopGrant | null) => digest(JSON.stringify(grant ? [
  grant.version, grant.id, grant.installId, grant.portalOrigin, grant.userId, grant.organizationId,
  grant.customerWorkspaceId, grant.localWorkspaceId, grant.browserPublicKey, grant.view, grant.control, grant.grantedAt,
] : null));

export type CreatePortalRelayRuntime = (input: {
  url: string;
  bearer: string;
  workspaceRoot: string;
  desktopGrant?: PortalRelayDesktopGrant | null;
  onTerminal: (reason: string, detail: string) => void;
}) => Promise<HostedWorkspaceHostRuntime>;

/** Production factory: loaded lazily so a process that never links pulls none of it in. */
export const createLocalRelayRuntime: CreatePortalRelayRuntime = async (input) => {
  const [{ createHostedWorkspaceHostRuntime, createDefaultDesktopBackend }, { LOCAL_RELAY_CHANNEL_KINDS, SafeRootFileError },
    { loadOrCreateHostedMachineNoiseKeyPair }, { linkedWorkspaceIdentity }] = await Promise.all([
    import('../workspace-host/hosted-workspace-host-runtime'),
    import('../workspace-host/hosted-session-host'),
    import('../workspace-host/hosted-machine-noise-key'),
    import('../endpoint-route/routes/hosted-cli/store'),
  ]);
  const grant = input.desktopGrant ?? null;
  // A local viewer never reconciles/reaps or creates desktops. Those lifecycles belong
  // to the local desktop owner, whose registry and lease map this backend reuses.
  const backend = grant ? createDefaultDesktopBackend(grant.localWorkspaceId, { reconcile: undefined }) : null;
  const machineKey = grant ? await loadOrCreateHostedMachineNoiseKeyPair() : null;
  const roster = async () => (await backend!.roster({ userId: grant!.userId }))
    .filter((entry) => entry.scope === 'agent' || entry.scope === 'pot' || entry.scope === 'workspace');
  const requireMember = async (id: string) => {
    if (!(await roster()).some((entry) => entry.desktopSessionId === id)) throw new SafeRootFileError('desktop_session_unknown');
  };
  return createHostedWorkspaceHostRuntime({
    url: input.url,
    bearer: input.bearer,
    workspaceRoot: input.workspaceRoot,
    allowedChannelKinds: new Set([...LOCAL_RELAY_CHANNEL_KINDS, 'desktop-discovery', 'desktop']),
    localDesktopAccess: {
      browserPublicKey: grant ? Buffer.from(grant.browserPublicKey, 'base64') : null,
      authorize: async ({ binding, userId, control }) => {
        if (!grant || userId !== grant.userId || control && !grant.control) return false;
        const current = currentPortalRelayDesktopGrant(await readPortalRelay());
        const expected = linkedWorkspaceIdentity(grant.organizationId, grant.installId);
        return !!current && grantDigest(current) === grantDigest(grant) &&
          binding.organizationId === grant.organizationId && binding.customerWorkspaceId === grant.customerWorkspaceId &&
          expected.customerWorkspaceId === grant.customerWorkspaceId && binding.hostId === expected.hostId;
      },
    },
    loadMachineNoiseKeyPair: machineKey ? async () => machineKey : null,
    ...(backend ? { desktop: {
      roster,
      lookup: async (id: string) => { await requireMember(id); return backend.lookup(id); },
      thumbnail: async (id: string) => { await requireMember(id); return backend.thumbnail(id); },
      dial: async (value: Parameters<typeof backend.dial>[0]) => { await requireMember(value.desktopSessionId); return backend.dial(value); },
      heartbeat: (id: string) => backend.heartbeat(id),
      start: async () => { throw new SafeRootFileError('desktop_start_not_allowed'); },
    } } : {}),
    onTerminal: (reason, detail) => input.onTerminal(reason, detail),
    onWarning: (message) => console.warn(`[portal-relay] ${message}`),
  });
};

export function portalRelayConnectorRunning(): boolean {
  return state.current !== null;
}

export function portalRelayConnectorMatchesDesktopGrant(grant: PortalRelayDesktopGrant | null): boolean {
  return state.current?.desktopGrantDigest === grantDigest(grant);
}

/** Reconfigure on approval changes even when the app link and bearer stay the same. */
export async function startPortalRelayConnector(
  input: { url: string; bearer: string; workspaceRoot: string; desktopGrant?: PortalRelayDesktopGrant | null },
  create: CreatePortalRelayRuntime = createLocalRelayRuntime,
): Promise<void> {
  const bearerDigest = digest(input.bearer);
  const desktopGrantDigest = grantDigest(input.desktopGrant ?? null);
  const current = state.current;
  if (current && current.url === input.url && current.bearerDigest === bearerDigest && current.desktopGrantDigest === desktopGrantDigest) return;
  stopPortalRelayConnector('relay_reconfigured');
  state.terminal = null;
  let runtime: HostedWorkspaceHostRuntime | null = null;
  runtime = await create({
    url: input.url,
    bearer: input.bearer,
    workspaceRoot: input.workspaceRoot,
    desktopGrant: input.desktopGrant ?? null,
    onTerminal: (reason, detail) => {
      state.terminal = { reason, detail, at: new Date() };
      // A terminal client never dials again; forget it so the reconciler sees it stopped.
      if (state.current?.runtime === runtime) state.current = null;
    },
  });
  state.current = { runtime, url: input.url, bearerDigest, desktopGrantDigest, startedAt: new Date() };
  runtime.start();
}

export function stopPortalRelayConnector(reason = 'relay_off'): void {
  const current = state.current;
  if (!current) return;
  state.current = null;
  current.runtime.stop(reason);
}

export function portalRelayConnectorStatus(): PortalRelayConnectorStatus {
  const current = state.current;
  const terminal = state.terminal;
  return {
    running: current !== null,
    bound: current?.runtime.binding !== null && current?.runtime.binding !== undefined,
    startedAt: current ? current.startedAt.toISOString() : null,
    terminal: terminal ? { reason: terminal.reason, detail: terminal.detail, at: terminal.at.toISOString() } : null,
  };
}

/** The reason the connector last ended on its own, consumed once by the reconciler. */
export function takePortalRelayTerminal(): { reason: string; detail: string } | null {
  const terminal = state.terminal;
  if (!terminal) return null;
  state.terminal = null;
  return { reason: terminal.reason, detail: terminal.detail };
}

/** Test seam. */
export function resetPortalRelayRuntimeForTests(): void {
  state.current?.runtime.stop('test_reset');
  state.current = null;
  state.terminal = null;
}
