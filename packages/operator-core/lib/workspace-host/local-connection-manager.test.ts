import { createServer } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceHostTransportProfile } from '@papercusp/deployment-driver';

import {
  IncompatibleWorkspaceHostProtocolError,
  LocalWorkspaceHostConnectionManager,
  buildOpenSshControlMasterCommand,
  buildOpenSshPtySessionCommand,
  negotiateWorkspaceHostProtocol,
  quotePosixShellArg,
  reserveLoopbackPort,
  type LocalWorkspaceHostConnectionInput,
  type LoopbackPortLease,
  type OpenSshTunnelHandle,
  type OpenSshTunnelRunner,
  type PersistedLocalWorkspaceHostConnection,
  type WorkspaceHostProtocolRange,
  type WorkspaceHostUiTarget,
} from './local-connection-manager';

const profile: WorkspaceHostTransportProfile = {
  kind: 'gcp-iap-ssh',
  endpoint: 'gcp-iap-ssh://host-1?project=p&zone=z&instance=host-1',
  supportedClientPlatforms: ['linux', 'macos', 'windows'],
  features: { command: true, pty: true, tcpForward: true, fileTransfer: true },
  prerequisites: ['IAP TCP forwarding permission', 'Verified SSH host key'],
  constraints: ['No public IP'],
  reconnect: 'recreate',
  audited: true,
  compatibility: {
    requirements: [],
    traffic: { interactive: 'recommended', 'bulk-transfer': 'supported' },
    limits: { unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'], notes: [] },
    proxy: { mode: 'supported', notes: [] },
    cost: { model: 'included', meters: [], notes: [] },
    audit: {
      controlPlaneEvents: true,
      sessionMetadata: true,
      sessionContent: false,
      fileTransferEvents: false,
      notes: [],
    },
    hostKey: {
      initialEnrollment: 'verify-before-connect',
      replacement: 'block-and-reverify',
      notes: [],
    },
    fallbacks: [],
  },
};

function input(overrides: Partial<LocalWorkspaceHostConnectionInput> = {}): LocalWorkspaceHostConnectionInput {
  return {
    connectionId: 'connection-1',
    hostId: 'host-1',
    profile,
    clientProtocol: { minVersion: 1, maxVersion: 3 },
    tunnel: {
      target: 'alice@host-1',
      controlPath: '/tmp/papercusp-host-1.sock',
      extraArgs: ['-o', 'ProxyCommand=gcloud compute start-iap-tunnel host-1 22 --listen-on-stdin'],
      remoteOperatorPort: 3070,
    },
    ...overrides,
  };
}

function lease(port: number, released: number[]): LoopbackPortLease {
  return {
    port,
    async release() {
      released.push(port);
    },
  };
}

function handle(): OpenSshTunnelHandle & { running: boolean; stopped: boolean } {
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const result = {
    running: true,
    stopped: false,
    exited: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      resolveExit = resolve;
    }),
    isRunning() {
      return result.running;
    },
    async stop() {
      result.running = false;
      result.stopped = true;
      resolveExit({ code: 0, signal: 'SIGTERM' });
    },
  };
  return result;
}

function harness(
  options: {
    ports?: number[];
    protocols?: Array<WorkspaceHostProtocolRange | Error>;
  } = {},
) {
  const ports = [...(options.ports ?? [45123])];
  const protocols = [...(options.protocols ?? [{ minVersion: 2, maxVersion: 4 }])];
  const released: number[] = [];
  const records: PersistedLocalWorkspaceHostConnection[] = [];
  const targets: WorkspaceHostUiTarget[] = [];
  const tunnels: ReturnType<typeof handle>[] = [];
  const starts: Array<{ localPort: number; remoteOperatorPort?: number }> = [];
  const scheduled: Array<{ delay: number; task: () => void; cancelled: boolean }> = [];
  const runner: OpenSshTunnelRunner = {
    async start(spec) {
      starts.push({ localPort: spec.localPort, remoteOperatorPort: spec.remoteOperatorPort });
      const tunnel = handle();
      tunnels.push(tunnel);
      return tunnel;
    },
  };
  const manager = new LocalWorkspaceHostConnectionManager({
    store: {
      async save(record) {
        records.push(structuredClone(record));
      },
    },
    async probeProtocol() {
      const next = protocols.length > 1 ? protocols.shift()! : protocols[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    async retargetUi(target) {
      targets.push(target);
    },
    tunnelRunner: runner,
    async reservePort() {
      const port = ports.shift();
      if (!port) throw new Error('test port queue exhausted');
      return lease(port, released);
    },
    now: () => '2026-08-22T00:00:00.000Z',
    delay: async () => {},
    schedule(delay, task) {
      const scheduledTask = { delay, task, cancelled: false };
      scheduled.push(scheduledTask);
      return () => {
        scheduledTask.cancelled = true;
      };
    },
    startupProbeAttempts: 1,
    portAttempts: 2,
  });
  return { manager, released, records, targets, tunnels, starts, scheduled };
}

describe('workspace-host protocol negotiation', () => {
  it('selects the newest mutually supported integer version', () => {
    expect(negotiateWorkspaceHostProtocol({ minVersion: 1, maxVersion: 3 }, { minVersion: 2, maxVersion: 4 })).toBe(3);
    expect(negotiateWorkspaceHostProtocol({ minVersion: 4, maxVersion: 7 }, { minVersion: 2, maxVersion: 4 })).toBe(4);
  });

  it('fails closed for disjoint or malformed ranges', () => {
    expect(() =>
      negotiateWorkspaceHostProtocol({ minVersion: 1, maxVersion: 2 }, { minVersion: 3, maxVersion: 4 }),
    ).toThrow(IncompatibleWorkspaceHostProtocolError);
    expect(() =>
      negotiateWorkspaceHostProtocol({ minVersion: 0, maxVersion: 2 }, { minVersion: 1, maxVersion: 2 }),
    ).toThrow('positive safe integer');
  });
});

describe('OpenSSH ControlMaster planning', () => {
  it('binds only loopback, holds a reusable master, and leaves host-key policy to OpenSSH', () => {
    const command = buildOpenSshControlMasterCommand({
      target: 'alice@host-1',
      controlPath: '/tmp/papercusp-host-1.sock',
      localPort: 45123,
      remoteOperatorPort: 3070,
      extraArgs: ['-o', 'ProxyCommand=gcloud compute start-iap-tunnel host-1 22 --listen-on-stdin'],
    });
    expect(command.command).toBe('ssh');
    expect(command.args).toContain('ControlMaster=yes');
    // ControlPersist backgrounds a separate master: the process adapter would then
    // observe a successful parent exit and lose both liveness and stop ownership.
    expect(command.args).toContain('ControlPersist=no');
    expect(command.args).toContain('ForkAfterAuthentication=no');
    expect(command.args).toContain('ControlPath=/tmp/papercusp-host-1.sock');
    expect(command.args).toContain('ExitOnForwardFailure=yes');
    expect(command.args).toContain('127.0.0.1:45123:127.0.0.1:3070');
    expect(command.args.at(-1)).toBe('alice@host-1');
    expect(command.args.join(' ')).not.toMatch(/StrictHostKeyChecking|UserKnownHostsFile|IdentityFile/);
  });

  it('accepts typed provider-tunnel port, stable host identity, and certificate authentication', () => {
    const command = buildOpenSshControlMasterCommand({
      target: 'alice@127.0.0.1',
      port: 45222,
      hostKeyAlias: 'azure-0123456789abcdef',
      identityFile: '/home/alice/.ssh/azure-id_rsa',
      certificateFile: '/home/alice/.ssh/azure-id_rsa-aadcert.pub',
      controlPath: '/tmp/papercusp-azure.sock',
      localPort: 45123,
    });
    expect(command.args).toEqual(
      expect.arrayContaining([
        '-p',
        '45222',
        'HostKeyAlias=azure-0123456789abcdef',
        'IdentitiesOnly=yes',
        '-i',
        '/home/alice/.ssh/azure-id_rsa',
        'CertificateFile=/home/alice/.ssh/azure-id_rsa-aadcert.pub',
      ]),
    );
    expect(command.args.join(' ')).not.toMatch(/StrictHostKeyChecking=no|UserKnownHostsFile=/);
  });

  it('rejects option-shaped targets, non-port values, and overlong control sockets', () => {
    expect(() =>
      buildOpenSshControlMasterCommand({
        target: '-Fbad',
        controlPath: '/tmp/control.sock',
        localPort: 45123,
      }),
    ).toThrow('may not begin with a dash');
    expect(() =>
      buildOpenSshControlMasterCommand({
        target: 'host',
        controlPath: '/tmp/control.sock',
        localPort: 0,
      }),
    ).toThrow('local tunnel port');
    expect(() =>
      buildOpenSshControlMasterCommand({
        target: 'host',
        controlPath: `/tmp/${'x'.repeat(110)}`,
        localPort: 45123,
      }),
    ).toThrow('at most 100 bytes');
  });

  it('uses the controller trust store with strict host-key verification', () => {
    const command = buildOpenSshControlMasterCommand({
      target: 'papercusp-workspace@host-1',
      controlPath: '/tmp/control.sock',
      localPort: 45123,
      knownHostsFile: '/home/alice/controller state/known_hosts',
      hostKeyAlias: 'gcp-project-zone-host-1',
      identityFile: '/home/alice/controller/id_ed25519',
    });
    expect(command.args).toContain('StrictHostKeyChecking=yes');
    expect(command.args).toContain('UserKnownHostsFile="/home/alice/controller state/known_hosts"');
    expect(command.args).toContain('GlobalKnownHostsFile=none');
    expect(command.args).toContain('UpdateHostKeys=no');
    expect(command.args).toContain('HostKeyAlias=gcp-project-zone-host-1');
    expect(() => buildOpenSshControlMasterCommand({
      target: 'host', controlPath: '/tmp/control.sock', localPort: 45123,
      knownHostsFile: '/verified/known_hosts', extraArgs: ['-o', 'UserKnownHostsFile=/dev/null'],
    })).toThrow("manager-owned OpenSSH option 'userknownhostsfile'");
  });

  it.each(['relative/known_hosts', '/tmp/known\nhosts', '/tmp/%h', '/tmp/${HOME}'])
    ('refuses a controller trust-store path that is relative or contains expansion: %s', (knownHostsFile) => {
      expect(() => buildOpenSshControlMasterCommand({
        target: 'host', controlPath: '/tmp/control.sock', localPort: 45123, knownHostsFile,
      })).toThrow(/known_hosts/);
    });

  it('rejects provider arguments that can override forwarding, host identity, or the destination', () => {
    const base = { target: 'host', controlPath: '/tmp/control.sock', localPort: 45123 };
    expect(() => buildOpenSshControlMasterCommand({ ...base, extraArgs: ['-L0.0.0.0:8080:host:80'] })).toThrow(
      "manager-owned OpenSSH flag '-L'",
    );
    expect(() => buildOpenSshControlMasterCommand({ ...base, extraArgs: ['-o', 'StrictHostKeyChecking=no'] })).toThrow(
      "manager-owned OpenSSH option 'stricthostkeychecking'",
    );
    expect(() => buildOpenSshControlMasterCommand({ ...base, extraArgs: ['attacker.example'] })).toThrow(
      'bare OpenSSH destination',
    );
    expect(() => buildOpenSshControlMasterCommand({ ...base, extraArgs: ['-p2222'] })).toThrow(
      "manager-owned OpenSSH flag '-p'",
    );
    expect(() => buildOpenSshControlMasterCommand({ ...base, extraArgs: ['-f'] })).toThrow(
      "manager-owned OpenSSH flag '-f'",
    );
    expect(() => buildOpenSshControlMasterCommand({ ...base, extraArgs: ['-oForkAfterAuthentication=yes'] })).toThrow(
      "manager-owned OpenSSH option 'forkafterauthentication'",
    );
    expect(() => buildOpenSshControlMasterCommand({ ...base, certificateFile: '/tmp/aadcert.pub' })).toThrow(
      'requires an explicit identity file',
    );
  });

  it('reuses the established ControlPath for a forced-PTY command and encodes exact remote argv', () => {
    const command = buildOpenSshPtySessionCommand({
      target: 'alice@host-1',
      controlPath: '/tmp/papercusp-host-1.sock',
      remoteArgv: ['tmux', 'new-session', '-A', '-s', 'psu-a1', '--', 'psu', '--resume=session 1', "it's", ''],
    });

    expect(command).toEqual({
      command: 'ssh',
      args: [
        '-tt',
        '-o',
        'BatchMode=yes',
        '-o',
        'ControlMaster=no',
        '-S',
        '/tmp/papercusp-host-1.sock',
        '--',
        'alice@host-1',
        `'tmux' 'new-session' '-A' '-s' 'psu-a1' '--' 'psu' '--resume=session 1' 'it'"'"'s' ''`,
      ],
    });
    expect(quotePosixShellArg('a b')).toBe("'a b'");
    expect(() => quotePosixShellArg('bad\0arg')).toThrow('without NUL');
  });
});

describe('LocalWorkspaceHostConnectionManager', () => {
  it('persists selection before spawn, negotiates, and retargets only to loopback', async () => {
    const h = harness();
    const connected = await h.manager.connect(input());

    expect(h.released).toEqual([45123]);
    expect(h.starts).toEqual([{ localPort: 45123, remoteOperatorPort: 3070 }]);
    expect(h.records.map((record) => record.status)).toEqual(['connecting', 'connected']);
    expect(h.records[0]).toMatchObject({
      connectionId: 'connection-1',
      hostId: 'host-1',
      profile: { kind: 'gcp-iap-ssh' },
      localOrigin: 'http://127.0.0.1:45123',
    });
    expect(connected.negotiatedProtocolVersion).toBe(3);
    expect(h.targets).toEqual([
      {
        connectionId: 'connection-1',
        hostId: 'host-1',
        origin: 'http://127.0.0.1:45123',
        protocolVersion: 3,
      },
    ]);
    expect(h.scheduled.at(-1)?.delay).toBe(15_000);
  });

  it('fails closed before retargeting when the remote protocol is incompatible', async () => {
    const h = harness({ protocols: [{ minVersion: 5, maxVersion: 6 }] });
    await expect(h.manager.connect(input())).rejects.toThrow(IncompatibleWorkspaceHostProtocolError);
    expect(h.targets).toEqual([]);
    expect(h.tunnels[0]?.stopped).toBe(true);
    expect(h.records.at(-1)).toMatchObject({ status: 'failed', lastError: expect.stringContaining('No compatible') });
  });

  it('recreates the tunnel on a failed health probe and persists reconnect state', async () => {
    const h = harness({
      ports: [45123, 45124],
      protocols: [{ minVersion: 1, maxVersion: 3 }, new Error('remote restarted'), { minVersion: 2, maxVersion: 3 }],
    });
    await h.manager.connect(input());
    const reconnected = await h.manager.reconcile();

    expect(h.tunnels[0]?.stopped).toBe(true);
    expect(h.starts.map((start) => start.localPort)).toEqual([45123, 45124]);
    expect(h.records.map((record) => record.status)).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'reconnecting',
      'connected',
    ]);
    expect(reconnected).toMatchObject({
      status: 'connected',
      localOrigin: 'http://127.0.0.1:45124',
      negotiatedProtocolVersion: 3,
    });
    expect(h.targets.map((target) => target.origin)).toEqual(['http://127.0.0.1:45123', 'http://127.0.0.1:45124']);
  });

  it('rejects a profile that cannot forward TCP before allocating a port', async () => {
    const h = harness();
    await expect(
      h.manager.connect(input({ profile: { ...profile, features: { ...profile.features, tcpForward: false } } })),
    ).rejects.toThrow('does not support TCP forwarding');
    expect(h.released).toEqual([]);
    expect(h.records).toEqual([]);
  });

  it('disconnects the master, persists terminal local state, and cancels monitoring', async () => {
    const h = harness();
    await h.manager.connect(input());
    const record = await h.manager.disconnect();
    expect(h.tunnels[0]?.stopped).toBe(true);
    expect(record?.status).toBe('disconnected');
    expect(h.records.at(-1)?.status).toBe('disconnected');
    expect(h.scheduled.some((entry) => entry.cancelled)).toBe(true);
  });

  it('releases the reserved port and never spawns when persistence fails', async () => {
    const released: number[] = [];
    const start = vi.fn<OpenSshTunnelRunner['start']>();
    const manager = new LocalWorkspaceHostConnectionManager({
      store: { save: vi.fn().mockRejectedValue(new Error('store unavailable')) },
      probeProtocol: vi.fn(),
      retargetUi: vi.fn(),
      tunnelRunner: { start },
      reservePort: async () => lease(45123, released),
      startupProbeAttempts: 1,
      portAttempts: 1,
    });

    await expect(manager.connect(input())).rejects.toThrow('store unavailable');
    expect(released).toEqual([45123]);
    expect(start).not.toHaveBeenCalled();
    expect(manager.snapshot()).toBeNull();
  });

  it('does not retain a live snapshot when UI retargeting rejects the connection', async () => {
    const released: number[] = [];
    const records: PersistedLocalWorkspaceHostConnection[] = [];
    const tunnel = handle();
    const manager = new LocalWorkspaceHostConnectionManager({
      store: {
        async save(record) {
          records.push(structuredClone(record));
        },
      },
      async probeProtocol() {
        return { minVersion: 1, maxVersion: 3 };
      },
      async retargetUi() {
        throw new Error('desktop target rejected');
      },
      tunnelRunner: {
        async start() {
          return tunnel;
        },
      },
      reservePort: async () => lease(45123, released),
      startupProbeAttempts: 1,
      portAttempts: 1,
    });

    await expect(manager.connect(input())).rejects.toThrow('desktop target rejected');
    expect(tunnel.stopped).toBe(true);
    expect(manager.snapshot()).toBeNull();
    expect(records.map((record) => record.status)).toEqual(['connecting', 'connected', 'failed']);
  });
});

describe('reserveLoopbackPort', () => {
  it('holds the OS-assigned port until release', async () => {
    const reserved = await reserveLoopbackPort();
    const contender = createServer();
    const collision = await new Promise<NodeJS.ErrnoException>((resolve) => {
      contender.once('error', resolve);
      contender.listen(reserved.port, '127.0.0.1');
    });
    expect(collision.code).toBe('EADDRINUSE');

    await reserved.release();
    await new Promise<void>((resolve, reject) => {
      contender.removeAllListeners('error');
      contender.once('error', reject);
      contender.listen(reserved.port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve, reject) => contender.close((error) => (error ? reject(error) : resolve())));
  });
});
