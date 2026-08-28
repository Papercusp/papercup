import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  HostedWorkspaceSessionBroker,
  type HostedWorkspaceRelaySocket,
} from './hosted-workspace-session';
import type { HostedConnectorBinding, HostedConnectorTicketBinding } from './hosted-workspace-connector';

class FakeSocket extends EventEmitter implements HostedWorkspaceRelaySocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  sent: unknown[] = [];
  closed: [number | undefined, string | undefined][] = [];
  send(data: string | Buffer) { this.sent.push(JSON.parse(data.toString())); }
  close(code?: number, reason?: string) {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.closed.push([code, reason]);
    this.emit('close');
  }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}

const connector: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'control', organizationId: 'org-1', customerWorkspaceId: 'workspace-1',
  hostId: 'host-1', routeLabel: 'alpha', generation: 7, transport: 'websocket', state: 'active',
};
const ticket = (session = 'hosted-session-1'): HostedConnectorTicketBinding => ({
  ...connector, kind: 'session', userId: 'user-1', hostedSessionId: session,
  audience: 'workspace-operator', expiresAt: new Date('2026-08-28T03:00:00Z'),
});

describe('HostedWorkspaceSessionBroker', () => {
  it('relays only through the exact generation-bound outbound connector', () => {
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => 'channel-1' });
    const host = new FakeSocket();
    const browser = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser);

    expect(host.sent).toContainEqual(expect.objectContaining({ type: 'relay.open', channelId: 'channel-1' }));
    expect(browser.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', role: 'controller' }));
    browser.message({ type: 'pty.input', data: 'aGVsbG8=' });
    expect(host.sent).toContainEqual({ type: 'relay', channelId: 'channel-1', payload: { type: 'pty.input', data: 'aGVsbG8=' } });
    host.message({ type: 'relay', channelId: 'channel-1', payload: { type: 'pty.output', data: 'd29ybGQ=' } });
    expect(browser.sent).toContainEqual({ type: 'pty.output', data: 'd29ybGQ=' });

    broker.closeGeneration(connector, 4001, 'connector_rotated');
    expect(host.closed).toContainEqual([4001, 'connector_rotated']);
    expect(browser.closed).toContainEqual([4001, 'connector_rotated']);
  });

  it('makes later tabs observers until they explicitly claim control', () => {
    let id = 0;
    const audit = vi.fn();
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => `channel-${++id}`, onAudit: audit });
    const host = new FakeSocket();
    const first = new FakeSocket();
    const second = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), first);
    broker.attachBrowser(ticket(), second);

    expect(second.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', role: 'observer' }));
    second.message({ type: 'pty.input', data: 'blocked' });
    expect(second.sent).toContainEqual({ type: 'session.denied', reason: 'observer_read_only', requestType: 'pty.input' });
    second.message({ type: 'session.claim-control' });
    expect(first.sent).toContainEqual({ type: 'session.role', role: 'observer', reason: 'control_claimed_elsewhere' });
    expect(second.sent).toContainEqual({ type: 'session.role', role: 'controller' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'control_claimed', channelId: 'channel-2' }));
  });

  it('expires idle browser sessions and notifies the host without logging content', () => {
    vi.useFakeTimers();
    const audit = vi.fn();
    const broker = new HostedWorkspaceSessionBroker({ idleMs: 100, randomId: () => 'idle', onAudit: audit });
    const host = new FakeSocket();
    const browser = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser);
    vi.advanceTimersByTime(101);
    expect(browser.closed).toContainEqual([4000, 'session_idle_expired']);
    expect(host.sent).toContainEqual({ type: 'relay.close', channelId: 'idle', reason: 'session_idle_expired' });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('terminal secret');
    vi.useRealTimers();
  });
});
