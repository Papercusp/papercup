import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createHostedWorkspaceHostRuntime,
  ensureHostedWorkspaceHostRuntime,
  hostedAuditRow,
  readHostedWorkspaceHostConfig,
  __resetHostedWorkspaceHostRuntime,
} from './hosted-workspace-host-runtime';
import { HostedWorkspaceConnectorClient, type HostedConnectorClientSocket } from './hosted-connector-client';
import type { HostedHostAuditEvent } from './hosted-session-host';

class FakeSocket implements HostedConnectorClientSocket {
  readonly OPEN = 1;
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Array<(...args: never[]) => void>> = {};
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  on(event: string, listener: (...args: never[]) => void): unknown {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners[event] ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
  emitOpen(): void {
    this.readyState = this.OPEN;
    this.emit('open');
  }
  emitMessage(value: unknown): void {
    this.emit('message', JSON.stringify(value), false);
  }
  emitClose(code = 1006): void {
    this.readyState = 3;
    this.emit('close', code, '');
  }
}

const BINDING = {
  controlPlaneWorkspaceId: 'cp',
  organizationId: 'org_1',
  customerWorkspaceId: 'cust_1',
  hostId: 'host_1',
  routeLabel: 'acme',
  generation: 3,
  transport: 'websocket',
  state: 'active',
};

function runtime(overrides: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const audits: HostedHostAuditEvent[] = [];
  const terminal: Array<{ reason: string; detail: string }> = [];
  const value = createHostedWorkspaceHostRuntime({
    url: 'wss://cp/api/hosted/connectors/socket',
    bearer: 'b',
    workspaceRoot: '/srv/workspace',
    onAudit: (event) => audits.push(event),
    onTerminal: (reason, detail) => terminal.push({ reason, detail }),
    onWarning: () => {},
    createClient: (options) =>
      new HostedWorkspaceConnectorClient({
        ...options,
        minBackoffMs: 10,
        random: () => 1,
        createSocket: (url, headers) => {
          const socket = new FakeSocket(url, headers);
          sockets.push(socket);
          return socket;
        },
      }),
    ...overrides,
  });
  return { value, sockets, audits, terminal };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('readHostedWorkspaceHostConfig', () => {
  const full = {
    PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'b',
    PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://app.papercusp.com',
    PAPERCUSP_HOSTED_WORKSPACE_ROOT: '/srv/workspace',
  };

  it('derives the socket url from a bare origin and forces a secure transport', () => {
    expect(readHostedWorkspaceHostConfig(full as NodeJS.ProcessEnv)).toEqual({
      url: 'wss://app.papercusp.com/api/hosted/connectors/socket',
      bearer: 'b',
      workspaceRoot: '/srv/workspace',
    });
  });

  it('keeps an explicitly configured path', () => {
    const config = readHostedWorkspaceHostConfig({
      ...full,
      PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://app.papercusp.com/api/hosted/connectors/socket',
    } as NodeJS.ProcessEnv);
    expect(config?.url).toBe('wss://app.papercusp.com/api/hosted/connectors/socket');
  });

  it('is null — not an error — when this host is simply not enrolled', () => {
    // The normal answer on a dev box and on the control plane itself. Absence of an
    // enrollment is not a misconfiguration, so it must not throw or warn.
    expect(readHostedWorkspaceHostConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(readHostedWorkspaceHostConfig({ ...full, PAPERCUSP_HOSTED_CONNECTOR_BEARER: '  ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('is null for an unparseable url rather than dialling something wrong', () => {
    expect(
      readHostedWorkspaceHostConfig({ ...full, PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'not a url' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe('hostedAuditRow', () => {
  const base: HostedHostAuditEvent = {
    action: 'desktop_takeover_started',
    organizationId: 'org_1',
    customerWorkspaceId: 'cust_1',
    hostId: 'host_1',
    generation: 3,
    userId: 'user_7',
    hostedSessionId: 's1',
    channelId: 'c1',
    detail: 'desktop=ds_1',
  };

  it('files a hosted takeover in the SHARED desktop namespace', () => {
    // The whole point: one `frame-vnc.takeover-started` filter must find frame,
    // local AND hosted takeovers. A hosted-only namespace would silently answer for
    // part of the population, which looks identical to a quiet week.
    const row = hostedAuditRow(base);
    expect(row.action).toBe('frame-vnc.takeover-started');
    expect(row.subject).toBe('hosted:host_1:c1');
    expect(row.details).toMatchObject({ target: 'hosted', generation: 3, userId: 'user_7' });
  });

  it('files a hosted watch in the same namespace', () => {
    expect(hostedAuditRow({ ...base, action: 'desktop_watch_started' }).action).toBe('frame-vnc.watch-started');
  });

  it('attributes the row to the browser principal, keeping the host in details', () => {
    expect(hostedAuditRow(base).actor).toBe('user_7');
    const { userId: _drop, ...withoutUser } = base;
    expect(hostedAuditRow(withoutUser).actor).toBe('host:host_1');
  });

  it('keeps NON-desktop relay events out of the desktop namespace', () => {
    // A PTY attach is a different population; folding it in would pollute the very
    // filter the shared namespace protects.
    expect(hostedAuditRow({ ...base, action: 'pty_attached' }).action).toBe('hosted-relay.pty_attached');
    expect(hostedAuditRow({ ...base, action: 'desktop_denied' }).action).toBe('hosted-relay.desktop_denied');
  });
});

describe('createHostedWorkspaceHostRuntime', () => {
  it('has no adapter until the control plane says who we are', () => {
    const { value, sockets } = runtime();
    expect(value.adapter).toBeNull();
    value.start();
    sockets[0]!.emitOpen();
    // An envelope arriving before `bound` has no binding to be audited against and
    // must be dropped, not served by an adapter with a guessed identity.
    sockets[0]!.emitMessage({ type: 'relay.open', channelId: 'c1', userId: 'u', hostedSessionId: 's', audience: 'workspace-operator', role: 'controller' });
    expect(value.adapter).toBeNull();
    expect(value.binding).toBeNull();
  });

  it('builds the adapter on bound and adopts the control plane binding', () => {
    const { value, sockets } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    expect(value.adapter).not.toBeNull();
    expect(value.binding).toMatchObject({ generation: 3, hostId: 'host_1' });
  });

  it('REBUILDS the adapter on a reconnect that carries a new generation', () => {
    // An adapter outliving its binding would keep stamping channels with a
    // superseded generation — exactly what the generation exists to prevent.
    const { value, sockets } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    const first = value.adapter;
    sockets[0]!.emitClose(1006);
    expect(value.adapter).toBeNull();
    vi.advanceTimersByTime(10);
    sockets[1]!.emitOpen();
    sockets[1]!.emitMessage({ type: 'bound', role: 'connector', binding: { ...BINDING, generation: 4 } });
    expect(value.adapter).not.toBe(first);
    expect(value.binding).toMatchObject({ generation: 4 });
  });

  it('drops the adapter and reports terminal when the binding is revoked', () => {
    const { value, sockets, terminal } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    sockets[0]!.emitClose(4001);
    vi.advanceTimersByTime(60_000);
    expect(value.adapter).toBeNull();
    expect(value.binding).toBeNull();
    expect(terminal).toEqual([{ reason: 'revoked', detail: '4001' }]);
    expect(sockets).toHaveLength(1);
  });

  it('sends the adapter output back over the connector socket', async () => {
    const { value, sockets } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    // No desktop backend was supplied, so a desktop open is REFUSED rather than
    // opening a channel that could never carry pixels.
    await value.adapter!.accept({
      type: 'relay.open',
      channelId: 'c1',
      userId: 'u',
      hostedSessionId: 's',
      audience: 'workspace-operator',
      role: 'controller',
      kind: 'desktop',
      desktopSessionId: 'ds_1',
    });
    const frames = sockets[0]!.sent.map((raw) => JSON.parse(raw));
    expect(frames).toContainEqual({ type: 'relay.close', channelId: 'c1', reason: 'desktop_unsupported' });
  });

  it('is wired into boot: ensure() dials once, is idempotent, and no-ops when unenrolled', () => {
    // The point of this test is the WIRING, not the config parse. WI-1064431 was
    // exactly this defect one layer down — a correct adapter that nothing ever
    // constructed — so a runtime with no live caller would just move the gap up.
    __resetHostedWorkspaceHostRuntime();
    const sockets: FakeSocket[] = [];
    const env = {
      PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'b',
      PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://app.papercusp.com',
      PAPERCUSP_HOSTED_WORKSPACE_ROOT: '/srv/workspace',
    } as NodeJS.ProcessEnv;
    const overrides = {
      // Supplied so the composition root does not reach for the live registry.
      desktop: {
        lookup: async () => null,
        dial: async () => {
          throw new Error('unused');
        },
        heartbeat: () => {},
        roster: async () => [],
        thumbnail: async () => null,
      },
      createClient: (options: ConstructorParameters<typeof HostedWorkspaceConnectorClient>[0]) =>
        new HostedWorkspaceConnectorClient({
          ...options,
          minBackoffMs: 10,
          random: () => 1,
          createSocket: (url, headers) => {
            const socket = new FakeSocket(url, headers);
            sockets.push(socket);
            return socket;
          },
        }),
    };

    // Unenrolled is the normal state on a dev box and the control plane: silent null.
    expect(ensureHostedWorkspaceHostRuntime({} as NodeJS.ProcessEnv, overrides)).toBeNull();
    expect(sockets).toHaveLength(0);

    const first = ensureHostedWorkspaceHostRuntime(env, overrides);
    expect(first).not.toBeNull();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.headers.Authorization).toBe('Bearer b');

    // Idempotent: a second boot-path call (or a module re-evaluation) must not open a
    // SECOND connector under one enrollment — the broker keys connectors by binding,
    // so two would silently evict each other rather than erroring.
    expect(ensureHostedWorkspaceHostRuntime(env, overrides)).toBe(first);
    expect(sockets).toHaveLength(1);
    __resetHostedWorkspaceHostRuntime();
  });

  it('stop() closes the adapter and never reconnects', () => {
    const { value, sockets, terminal } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    value.stop('host_stopped');
    expect(value.adapter).toBeNull();
    expect(terminal).toEqual([{ reason: 'stopped', detail: 'host_stopped' }]);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
