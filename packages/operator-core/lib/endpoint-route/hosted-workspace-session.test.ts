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

describe('HostedWorkspaceSessionBroker — desktop channels (P-013 / D-023, D-024)', () => {
  const ids = () => {
    let n = 0;
    return () => `channel-${++n}`;
  };

  function attached(attach: Parameters<HostedWorkspaceSessionBroker['attachBrowser']>[2] = {}) {
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => 'channel-1' });
    const host = new FakeSocket();
    const browser = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser, attach);
    return { broker, host, browser };
  }

  const opens = (host: FakeSocket) =>
    host.sent.filter((m) => (m as { type: string }).type === 'relay.open') as Array<Record<string, unknown>>;

  it('forwards the kind + desktopSessionId the host needs to open a desktop', () => {
    // Gap A: before this, relay.open carried six fields and NONE could express a
    // desktop, so P-013's host-side discriminator was unreachable from the browser.
    const { host } = attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
    expect(host.sent).toContainEqual(
      expect.objectContaining({ type: 'relay.open', kind: 'desktop', desktopSessionId: 'ds_1' }),
    );
  });

  it('omits the discriminator entirely for a pty, so a host predating it still opens terminals', () => {
    const { host } = attached();
    expect(opens(host)[0]).not.toHaveProperty('kind');
    expect(opens(host)[0]).not.toHaveProperty('desktopSessionId');
  });

  it('refuses a desktop attach with no session id rather than opening a blank viewer', () => {
    const { browser, host } = attached({ kind: 'desktop' });
    expect(browser.closed).toContainEqual([4403, 'desktop_session_required']);
    expect(opens(host)).toHaveLength(0);
  });

  it('takes watch/takeover from the REQUEST, never from arrival order', () => {
    // Role IS the credential (D-024 ruling 1): electing the first arrival controller
    // would hand INPUT to a user who asked only to watch, silently.
    expect(opens(attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' }).host)[0]!.role).toBe('observer');
    expect(opens(attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' }).host)[0]!.role).toBe('controller');
  });

  it('lets two takeover viewers coexist — the pairing IS the feature (-AlwaysShared 1)', () => {
    const broker = new HostedWorkspaceSessionBroker({ randomId: ids() });
    const host = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), new FakeSocket(), { kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
    broker.attachBrowser(ticket(), new FakeSocket(), { kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
    // A desktop channel never enters the controller map, so the second viewer is NOT
    // demoted to observer just because someone else is already attached.
    expect(opens(host).map((m) => m.role)).toEqual(['controller', 'controller']);
  });

  it('a desktop attach does not steal the pty controller slot', () => {
    const broker = new HostedWorkspaceSessionBroker({ randomId: ids() });
    const host = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), new FakeSocket(), { kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
    broker.attachBrowser(ticket(), new FakeSocket());
    const pty = opens(host).filter((m) => m.kind === undefined);
    expect(pty).toHaveLength(1);
    expect(pty[0]!.role).toBe('controller');
  });

  it('REFUSES in-place promotion on a desktop channel instead of lying about it', () => {
    // D-024 ruling 2: the privilege IS the credential, consumed by the dial. Flipping
    // the broker role would tell the browser it has control while KasmVNC went on
    // dropping its input — a viewer that believes it has the keyboard and does not.
    const { browser, host } = attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
    browser.message({ type: 'session.claim-control' });
    expect(browser.sent).toContainEqual(
      expect.objectContaining({ type: 'session.denied', reason: 'desktop_role_fixed_at_open' }),
    );
    expect(browser.sent).not.toContainEqual(expect.objectContaining({ type: 'session.role', role: 'controller' }));
    expect(host.sent).not.toContainEqual(expect.objectContaining({ type: 'relay.role' }));
  });

  it('still allows a PTY channel to claim control', () => {
    const { browser } = attached();
    browser.message({ type: 'session.claim-control' });
    expect(browser.sent).not.toContainEqual(expect.objectContaining({ type: 'session.denied' }));
  });

  describe('the control plane records the viewer start itself (WI-10004167)', () => {
    // The host audits into ITS database, which the control plane cannot read, so the
    // P-318 customer-acceptance receipt could never find a hosted takeover. The broker
    // records its own row once the host confirms the dial.
    function audited(attach: Parameters<HostedWorkspaceSessionBroker['attachBrowser']>[2]) {
      const audit = vi.fn();
      const broker = new HostedWorkspaceSessionBroker({ randomId: () => 'channel-1', onAudit: audit });
      const host = new FakeSocket();
      const browser = new FakeSocket();
      broker.attachConnector(connector, host);
      broker.attachBrowser(ticket(), browser, attach);
      const starts = () =>
        audit.mock.calls.map(([event]) => event).filter((event) => String(event.action).startsWith('desktop_'));
      return { host, browser, starts };
    }
    const ready = (action: string) => ({ type: 'relay', channelId: 'channel-1', payload: { type: 'desktop.ready', action, inputAllowed: action === 'takeover' } });

    it('records a takeover start with the broker\'s own identity once the host confirms the dial', () => {
      const { host, browser, starts } = audited({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
      expect(starts()).toEqual([]);
      host.message(ready('takeover'));
      expect(starts()).toEqual([{
        action: 'desktop_takeover_started',
        controlPlaneWorkspaceId: 'control',
        organizationId: 'org-1',
        customerWorkspaceId: 'workspace-1',
        hostId: 'host-1',
        generation: 7,
        userId: 'user-1',
        hostedSessionId: 'hosted-session-1',
        channelId: 'channel-1',
        detail: 'desktop=ds_1',
      }]);
      // Still relayed: the viewer needs the frame to start drawing.
      expect(browser.sent).toContainEqual({ type: 'desktop.ready', action: 'takeover', inputAllowed: true });
    });

    it('records a watch start for an observer channel', () => {
      const { host, starts } = audited({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
      host.message(ready('watch'));
      expect(starts().map((event) => event.action)).toEqual(['desktop_watch_started']);
    });

    it('records one start per channel, however many ready frames the host sends', () => {
      const { host, starts } = audited({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
      host.message(ready('takeover'));
      host.message(ready('takeover'));
      expect(starts()).toHaveLength(1);
    });

    it('never records a takeover the broker did not open, whatever the host reports', () => {
      const { host, starts } = audited({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
      host.message(ready('takeover'));
      expect(starts().map((event) => event.action)).toEqual(['desktop_ready_mode_mismatch']);
    });

    it('ignores a desktop.ready frame on a terminal channel', () => {
      const { host, starts } = audited({});
      host.message(ready('takeover'));
      expect(starts()).toEqual([]);
    });
  });

  it('does NOT gate desktop.data on the controller role — the credential is the enforcement', () => {
    // D-024 explicitly forbids a byte filter here: an observer legitimately SENDS
    // FramebufferUpdateRequest/SetEncodings, which is how a VNC client gets pixels at
    // all. KasmVNC drops the input messages server-side against the view-only user.
    const { browser, host } = attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
    browser.message({ type: 'desktop.data', data: 'AQID' });
    expect(host.sent).toContainEqual(
      expect.objectContaining({ type: 'relay', payload: { type: 'desktop.data', data: 'AQID' } }),
    );
  });
});

describe('HostedWorkspaceSessionBroker — operator-http channels (D-418 / WI-10002873)', () => {
  function attached(attach: Parameters<HostedWorkspaceSessionBroker['attachBrowser']>[2]) {
    let n = 0;
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => `channel-${++n}` });
    const host = new FakeSocket();
    const client = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), client, attach);
    return { broker, host, client };
  }
  const request = { type: 'http.request', requestId: 'r1', method: 'GET', path: '/api/harness/portal/agent-chats' };

  it('opens with kind operator-http, echoes the kind, and is always controller', () => {
    const { host, client } = attached({ kind: 'operator-http' });
    expect(host.sent).toContainEqual(expect.objectContaining({ type: 'relay.open', kind: 'operator-http', role: 'controller' }));
    expect(client.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', kind: 'operator-http', role: 'controller' }));
  });

  it('does not take the PTY controller slot', () => {
    let n = 0;
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => `channel-${++n}` });
    broker.attachConnector(connector, new FakeSocket());
    broker.attachBrowser(ticket(), new FakeSocket(), { kind: 'operator-http' });
    const tab = new FakeSocket();
    broker.attachBrowser(ticket(), tab);
    expect(tab.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', kind: 'pty', role: 'controller' }));
  });

  it('forwards request frames and relays host response frames back', () => {
    const { host, client } = attached({ kind: 'operator-http' });
    client.message(request);
    expect(host.sent).toContainEqual({ type: 'relay', channelId: 'channel-1', payload: request });
    host.message({ type: 'relay', channelId: 'channel-1', payload: { type: 'http.response', requestId: 'r1', status: 200, headers: {} } });
    expect(client.sent).toContainEqual({ type: 'http.response', requestId: 'r1', status: 200, headers: {} });
  });

  it('refuses non-http frames on an operator-http channel', () => {
    const { host, client } = attached({ kind: 'operator-http' });
    client.message({ type: 'pty.input', data: 'aGk=' });
    client.message({ type: 'desktop.start' });
    expect(client.sent).toContainEqual({ type: 'session.denied', reason: 'channel_kind_mismatch', requestType: 'pty.input' });
    expect(client.sent).toContainEqual({ type: 'session.denied', reason: 'channel_kind_mismatch', requestType: 'desktop.start' });
    expect(host.sent.filter((m) => (m as { type: string }).type === 'relay')).toEqual([]);
  });

  it('refuses http frames on a PTY channel, so a terminal ticket cannot call the operator API', () => {
    const { host, client } = attached({});
    client.message(request);
    expect(client.sent).toContainEqual({ type: 'session.denied', reason: 'channel_kind_mismatch', requestType: 'http.request' });
    expect(host.sent.filter((m) => (m as { type: string }).type === 'relay')).toEqual([]);
  });

  it('refuses in-place control claims on an operator-http channel', () => {
    const { client } = attached({ kind: 'operator-http' });
    client.message({ type: 'session.claim-control' });
    expect(client.sent).toContainEqual(expect.objectContaining({ type: 'session.denied', reason: 'operator_http_role_fixed' }));
  });
});

/** A socket that answers pings the way `ws` does, unless told the link is dead. */
class PingableSocket extends FakeSocket {
  pings = 0;
  terminated = false;
  answersPings = true;
  ping() {
    this.pings += 1;
    if (this.answersPings) queueMicrotask(() => this.emit('pong'));
  }
  terminate() {
    if (this.readyState !== this.OPEN) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
}

// P-001 (psu-cloud-connector-liveness-multi-signin-2026-09-29). avi-test, 2026-09-29: the VM kept a
// silent, half-open connector for ~2h; this broker had no socket for it and nothing on either side
// noticed, so every attach closed 4411 connector_unavailable while the cloud said "reachable".
describe('HostedWorkspaceSessionBroker — relay liveness (P-001)', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function liveBroker() {
    const liveness: [number, boolean][] = [];
    const audit = vi.fn();
    const broker = new HostedWorkspaceSessionBroker({
      pingIntervalMs: 0,
      randomId: () => 'channel-1',
      onAudit: audit,
      onConnectorLiveness: (binding, alive) => liveness.push([binding.generation, alive]),
    });
    return { broker, liveness, audit };
  }

  it('keeps a connector that answers pings and reports each pong as liveness', async () => {
    const { broker, liveness } = liveBroker();
    const host = new PingableSocket();
    broker.attachConnector(connector, host);
    expect(liveness).toEqual([[7, true]]);

    for (let sweep = 0; sweep < 3; sweep += 1) {
      broker.sweepLiveness();
      await flush();
    }
    expect(host.pings).toBe(3);
    expect(host.terminated).toBe(false);
    expect(liveness).toEqual([[7, true], [7, true], [7, true], [7, true]]);
  });

  it('terminates a connector that missed a pong, detaches its browsers with 4412, and reports it gone', async () => {
    const { broker, liveness, audit } = liveBroker();
    const host = new PingableSocket();
    const browser = new PingableSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser);

    host.answersPings = false;
    broker.sweepLiveness();
    await flush();
    expect(host.terminated).toBe(false); // one missed pong is only suspicion
    broker.sweepLiveness();

    expect(host.terminated).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'connector_heartbeat_missed', generation: 7 }));
    expect(browser.closed).toContainEqual([4412, 'connector_disconnected']);
    expect(liveness.at(-1)).toEqual([7, false]);

    // The next attach is refused truthfully instead of relaying into a dead socket.
    const late = new PingableSocket();
    broker.attachBrowser(ticket('hosted-session-2'), late);
    expect(late.closed).toContainEqual([4411, 'connector_unavailable']);
  });

  it('treats any inbound frame as proof of life', async () => {
    const { broker } = liveBroker();
    const host = new PingableSocket();
    host.answersPings = false;
    broker.attachConnector(connector, host);
    broker.sweepLiveness();
    host.message({ type: 'relay', channelId: 'none', payload: {} });
    broker.sweepLiveness();
    expect(host.terminated).toBe(false);
  });

  it('pings browsers too and drops one that stopped answering, without touching connector liveness', async () => {
    const { broker, liveness } = liveBroker();
    const host = new PingableSocket();
    const browser = new PingableSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser);
    browser.answersPings = false;
    broker.sweepLiveness();
    await flush();
    broker.sweepLiveness();
    expect(browser.terminated).toBe(true);
    expect(host.terminated).toBe(false);
    expect(host.sent).toContainEqual({ type: 'relay.close', channelId: 'channel-1', reason: 'browser_disconnected' });
    expect(liveness.every(([, alive]) => alive)).toBe(true);
  });

  it('does not report a replaced connector socket as gone', () => {
    const { broker, liveness } = liveBroker();
    const first = new PingableSocket();
    const second = new PingableSocket();
    broker.attachConnector(connector, first);
    // Real `ws` delivers the replaced socket's close asynchronously, after the new one is bound.
    first.close = function (this: PingableSocket, code?: number, reason?: string) {
      this.closed.push([code, reason]);
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    };
    broker.attachConnector(connector, second);
    return flush().then(() => {
      expect(first.closed).toContainEqual([4002, 'connector_replaced']);
      expect(liveness).toEqual([[7, true], [7, true]]);
    });
  });
});
