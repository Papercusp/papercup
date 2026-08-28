/** Generation-bound relay between one outbound workspace connector and browser sessions. */
import { randomUUID } from 'node:crypto';
import type {
  HostedConnectorBinding,
  HostedConnectorTicketBinding,
} from './hosted-workspace-connector';

export const HOSTED_WORKSPACE_SESSION_PROTOCOL = 'papercusp-hosted-workspace.v1';
export const HOSTED_WORKSPACE_MAX_MESSAGE_BYTES = 1024 * 1024;
export const HOSTED_WORKSPACE_SESSION_IDLE_MS = 15 * 60_000;

export type HostedWorkspaceTabRole = 'controller' | 'observer';

/** The narrow WebSocket surface used by the broker; `ws.WebSocket` satisfies it. */
export interface HostedWorkspaceRelaySocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string | Buffer, options?: { binary?: boolean }): unknown;
  close(code?: number, reason?: string): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
}

export interface HostedWorkspaceSessionAuditEvent {
  action: string;
  organizationId: string;
  customerWorkspaceId: string;
  hostId: string;
  generation: number;
  userId?: string;
  hostedSessionId?: string;
  channelId?: string;
  detail?: string;
}

export interface HostedWorkspaceSessionBrokerOptions {
  idleMs?: number;
  maxMessageBytes?: number;
  randomId?: () => string;
  onAudit?: (event: HostedWorkspaceSessionAuditEvent) => void;
}

type BrowserSession = {
  channelId: string;
  binding: HostedConnectorTicketBinding;
  socket: HostedWorkspaceRelaySocket;
  role: HostedWorkspaceTabRole;
  connectorKey: string;
  controllerKey: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
};

function connectorKey(binding: Pick<HostedConnectorBinding,
  'controlPlaneWorkspaceId' | 'organizationId' | 'customerWorkspaceId' | 'hostId' | 'generation'>): string {
  return JSON.stringify([
    binding.controlPlaneWorkspaceId,
    binding.organizationId,
    binding.customerWorkspaceId,
    binding.hostId,
    binding.generation,
  ]);
}

function controllerKey(binding: HostedConnectorTicketBinding): string {
  return `${connectorKey(binding)}\u0000${binding.hostedSessionId ?? ''}`;
}

function byteLength(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return Number.POSITIVE_INFINITY;
}

function text(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

function open(socket: HostedWorkspaceRelaySocket): boolean {
  return socket.readyState === socket.OPEN;
}

function sendJson(socket: HostedWorkspaceRelaySocket, value: unknown): boolean {
  if (!open(socket)) return false;
  try {
    socket.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function payloadType(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

const CONTROLLER_ONLY = new Set([
  'pty.input',
  'pty.resize',
  'pty.signal',
  'pty.kill',
  'file.write',
  'file.upload',
]);

/**
 * In-process relay state belongs beside the hosted HTTP upgrade listener. The
 * workspace host remains outbound-only: browsers never dial a VM address and
 * connector credentials never enter the browser principal chain.
 */
export class HostedWorkspaceSessionBroker {
  private readonly connectors = new Map<string, HostedWorkspaceRelaySocket>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly controllers = new Map<string, string>();
  private readonly idleMs: number;
  private readonly maxMessageBytes: number;
  private readonly randomId: () => string;
  private readonly onAudit: (event: HostedWorkspaceSessionAuditEvent) => void;

  constructor(options: HostedWorkspaceSessionBrokerOptions = {}) {
    this.idleMs = options.idleMs ?? HOSTED_WORKSPACE_SESSION_IDLE_MS;
    this.maxMessageBytes = options.maxMessageBytes ?? HOSTED_WORKSPACE_MAX_MESSAGE_BYTES;
    this.randomId = options.randomId ?? randomUUID;
    this.onAudit = options.onAudit ?? (() => {});
  }

  attachConnector(binding: HostedConnectorBinding, socket: HostedWorkspaceRelaySocket): () => void {
    const key = connectorKey(binding);
    const previous = this.connectors.get(key);
    if (previous && previous !== socket) previous.close(4002, 'connector_replaced');
    this.connectors.set(key, socket);
    sendJson(socket, { type: 'bound', role: 'connector', protocol: HOSTED_WORKSPACE_SESSION_PROTOCOL, binding });
    this.audit(binding, 'connector_attached');

    const onMessage = (data: unknown, isBinary: boolean) => {
      if (isBinary || byteLength(data) > this.maxMessageBytes) {
        socket.close(4400, 'invalid_connector_message');
        return;
      }
      const raw = text(data);
      if (!raw) return;
      let message: { type?: string; channelId?: string; payload?: unknown; reason?: string };
      try { message = JSON.parse(raw) as typeof message; } catch { return; }
      if (message.type !== 'relay' && message.type !== 'relay.close') return;
      if (typeof message.channelId !== 'string') return;
      const session = this.sessions.get(message.channelId);
      if (!session || session.connectorKey !== key) return;
      this.touch(session);
      if (message.type === 'relay.close') {
        this.closeSession(session, 4000, message.reason ?? 'host_closed', false);
        return;
      }
      sendJson(session.socket, message.payload);
    };
    const onClose = () => {
      if (this.connectors.get(key) !== socket) return;
      this.connectors.delete(key);
      for (const session of [...this.sessions.values()]) {
        if (session.connectorKey === key) this.closeSession(session, 4412, 'connector_disconnected', false);
      }
      this.audit(binding, 'connector_detached');
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onClose);
    return onClose;
  }

  attachBrowser(binding: HostedConnectorTicketBinding, socket: HostedWorkspaceRelaySocket): () => void {
    const key = connectorKey(binding);
    const connector = this.connectors.get(key);
    if (!connector || !open(connector)) {
      socket.close(4411, 'connector_unavailable');
      return () => {};
    }
    if (binding.kind !== 'session' || binding.transport !== 'websocket' || binding.state !== 'active' ||
        binding.audience !== 'workspace-operator' || !binding.userId || !binding.hostedSessionId) {
      socket.close(4403, 'session_binding_invalid');
      return () => {};
    }

    const channelId = this.randomId();
    const controlKey = controllerKey(binding);
    const role: HostedWorkspaceTabRole = this.controllers.has(controlKey) ? 'observer' : 'controller';
    const session: BrowserSession = {
      channelId,
      binding,
      socket,
      role,
      connectorKey: key,
      controllerKey: controlKey,
      idleTimer: null,
      closed: false,
    };
    this.sessions.set(channelId, session);
    if (role === 'controller') this.controllers.set(controlKey, channelId);
    this.touch(session);
    sendJson(socket, {
      type: 'session.bound',
      protocol: HOSTED_WORKSPACE_SESSION_PROTOCOL,
      channelId,
      role,
      binding: {
        organizationId: binding.organizationId,
        customerWorkspaceId: binding.customerWorkspaceId,
        hostId: binding.hostId,
        generation: binding.generation,
        hostedSessionId: binding.hostedSessionId,
      },
    });
    sendJson(connector, {
      type: 'relay.open',
      channelId,
      userId: binding.userId,
      hostedSessionId: binding.hostedSessionId,
      audience: binding.audience,
      role,
    });
    this.audit(binding, 'browser_attached', channelId, role);

    const onMessage = (data: unknown, isBinary: boolean) => {
      if (isBinary || byteLength(data) > this.maxMessageBytes) {
        socket.close(4400, 'invalid_browser_message');
        return;
      }
      const raw = text(data);
      if (!raw) return;
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { return; }
      const type = payloadType(payload);
      if (!type) return;
      this.touch(session);
      if (type === 'session.claim-control') {
        this.claimControl(session);
        return;
      }
      if (type === 'session.detach') {
        this.closeSession(session, 1000, 'browser_detached', true);
        return;
      }
      if (CONTROLLER_ONLY.has(type) && session.role !== 'controller') {
        sendJson(socket, { type: 'session.denied', reason: 'observer_read_only', requestType: type });
        return;
      }
      sendJson(connector, { type: 'relay', channelId, payload });
      this.audit(binding, type, channelId);
    };
    const onClose = () => this.closeSession(session, 1000, 'browser_disconnected', true);
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onClose);
    return onClose;
  }

  closeGeneration(binding: HostedConnectorBinding, code = 4001, reason = 'connector_generation_closed'): void {
    const key = connectorKey(binding);
    // Close browsers first so the authoritative rotate/revoke reason wins over
    // the connector socket's generic `close` callback.
    for (const session of [...this.sessions.values()]) {
      if (session.connectorKey === key) this.closeSession(session, code, reason, false);
    }
    this.connectors.get(key)?.close(code, reason);
  }

  private claimControl(session: BrowserSession): void {
    const previousId = this.controllers.get(session.controllerKey);
    if (previousId === session.channelId) return;
    const previous = previousId ? this.sessions.get(previousId) : undefined;
    if (previous) {
      previous.role = 'observer';
      sendJson(previous.socket, { type: 'session.role', role: 'observer', reason: 'control_claimed_elsewhere' });
      const connector = this.connectors.get(previous.connectorKey);
      if (connector) sendJson(connector, { type: 'relay.role', channelId: previous.channelId, role: 'observer' });
    }
    session.role = 'controller';
    this.controllers.set(session.controllerKey, session.channelId);
    sendJson(session.socket, { type: 'session.role', role: 'controller' });
    const connector = this.connectors.get(session.connectorKey);
    if (connector) sendJson(connector, { type: 'relay.role', channelId: session.channelId, role: 'controller' });
    this.audit(session.binding, 'control_claimed', session.channelId);
  }

  private touch(session: BrowserSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.closeSession(session, 4000, 'session_idle_expired', true);
    }, this.idleMs);
    session.idleTimer.unref?.();
  }

  private closeSession(session: BrowserSession, code: number, reason: string, notifyConnector: boolean): void {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(session.channelId);
    if (this.controllers.get(session.controllerKey) === session.channelId) {
      this.controllers.delete(session.controllerKey);
      const successor = [...this.sessions.values()].find((candidate) => candidate.controllerKey === session.controllerKey);
      if (successor) this.claimControl(successor);
    }
    if (notifyConnector) {
      const connector = this.connectors.get(session.connectorKey);
      if (connector) sendJson(connector, { type: 'relay.close', channelId: session.channelId, reason });
    }
    if (open(session.socket)) session.socket.close(code, reason);
    this.audit(session.binding, 'browser_detached', session.channelId, reason);
  }

  private audit(
    binding: HostedConnectorBinding | HostedConnectorTicketBinding,
    action: string,
    channelId?: string,
    detail?: string,
  ): void {
    this.onAudit({
      action,
      organizationId: binding.organizationId,
      customerWorkspaceId: binding.customerWorkspaceId,
      hostId: binding.hostId,
      generation: binding.generation,
      ...('userId' in binding && binding.userId ? { userId: binding.userId } : {}),
      ...('hostedSessionId' in binding && binding.hostedSessionId ? { hostedSessionId: binding.hostedSessionId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(detail ? { detail } : {}),
    });
  }
}
