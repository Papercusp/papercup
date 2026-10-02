import { describe, expect, it } from 'vitest';
import {
  buildEgressDenyRule,
  classifyConnections,
  evaluateOutageDrill,
  normalizeAddress,
  parseEstablishedConnections,
  runOutageDrill,
  sha256Hex,
  type HostCommandResult,
  type OutageDrillConfig,
  type OutageDrillDeps,
} from './outage-drill';

const PAPERCUSP = ['104.21.73.140', '172.67.145.145'];
const MODEL = ['160.79.104.10'];

const config: OutageDrillConfig = {
  project: 'pc-canary',
  network: 'pc-host-net',
  ruleName: 'pc-j5-outage-drill-n1',
  papercuspOrigin: 'https://app.papercusp.com',
  modelProviderOrigin: 'https://api.anthropic.com',
  serviceUnit: 'papercusp-workspace.service',
  agentCommand: '/usr/local/lib/papercusp-agent-toolchain/bin/claude',
  workspaceDir: '/srv/papercusp/workspaces/ws',
  nonce: 'n1',
  secret: 's3cret-value',
  pollMs: 1_000,
  agentTimeoutMs: 60_000,
  reconnectTimeoutMs: 60_000,
};

interface FakeOptions {
  /** The connector reconnects this many ms after the block lifts; null = never. */
  readonly reconnectAfterMs?: number | null;
  /** The agent finishes this many ms after it reads its gate (or after launch, with agentSkipsGate). */
  readonly agentRunsMs?: number;
  /** The agent ignores its gate pipe and exits on its own (the 2026-10-02 live failure shape). */
  readonly agentSkipsGate?: boolean;
  /** The agent never opens its gate pipe, so the drill's write times out. */
  readonly agentNeverReadsGate?: boolean;
  /** What the agent writes; defaults to the correct digest. */
  readonly agentOutput?: string;
  readonly agentExitCode?: number;
  /** The firewall rule never takes effect. */
  readonly blockIneffective?: boolean;
  readonly deleteFails?: boolean;
}

/** A host whose behaviour depends on whether the egress rule exists, driven by a fake clock. */
function fakeHost(options: FakeOptions = {}) {
  let clock = Date.parse('2026-10-02T10:00:00Z');
  let blocked = false;
  let connectorUp = true;
  let connectorConnectedAt: number | null = clock - 60_000;
  let liftedAt: number | null = null;
  let agentStartedAt: number | null = null;
  let gateReadAt: number | null = null;
  let gateReadWhileBlocked: boolean | null = null;
  const commands: string[] = [];
  const cloud: string[][] = [];
  const tick = () => {
    if (blocked) connectorUp = false;
    if (!blocked && !connectorUp && liftedAt !== null && options.reconnectAfterMs !== null) {
      if (clock - liftedAt >= (options.reconnectAfterMs ?? 3_000)) {
        connectorUp = true;
        connectorConnectedAt = clock;
      }
    }
  };
  const agentDone = () => {
    if (options.agentSkipsGate) return agentStartedAt !== null && clock - agentStartedAt >= (options.agentRunsMs ?? 1_000);
    return gateReadAt !== null && clock - gateReadAt >= (options.agentRunsMs ?? 8_000);
  };
  const ok = (stdout = ''): HostCommandResult => ({ code: 0, stdout, stderr: '' });
  const deps: OutageDrillDeps = {
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
      tick();
    },
    resolveAddresses: async (hostname) => (hostname === 'app.papercusp.com' ? PAPERCUSP : MODEL),
    readConnectorLastSeenAt: async () => (connectorConnectedAt === null ? null : new Date(connectorConnectedAt)),
    cloudExec: async (args) => {
      cloud.push([...args]);
      clock += 2_000;
      if (args[2] === 'create') blocked = !options.blockIneffective;
      if (args[2] === 'delete') {
        if (options.deleteFails) return { code: 1, stdout: '', stderr: 'permission denied' };
        blocked = false;
        liftedAt = clock;
      }
      tick();
      return ok();
    },
    hostExec: async (command) => {
      commands.push(command);
      clock += 500;
      tick();
      if (command.startsWith('ss ')) {
        const rows = ['0 0 10.0.0.2:22 35.235.241.7:51234'];
        if (connectorUp) rows.push('0 0 10.0.0.2:40000 104.21.73.140:443');
        if (agentStartedAt !== null && !agentDone()) rows.push('0 0 10.0.0.2:40100 160.79.104.10:443');
        return ok(rows.join('\n'));
      }
      if (command.startsWith('systemctl is-active')) return ok('active\n');
      if (command.startsWith('curl')) {
        const toPapercusp = command.includes('papercusp.com');
        return toPapercusp && blocked ? { code: 28, stdout: '', stderr: 'timed out' } : ok();
      }
      if (command.includes('nohup')) {
        agentStartedAt = clock;
        return ok();
      }
      if (command.startsWith('test -e')) return { code: agentDone() ? 0 : 1, stdout: '', stderr: '' };
      if (command.startsWith('timeout') && command.includes('.gate')) {
        // The write blocks until the agent's `cat` opens the pipe; a finished or absent reader times out.
        if (options.agentNeverReadsGate || agentDone()) return { code: 124, stdout: '', stderr: '' };
        gateReadAt = clock;
        gateReadWhileBlocked = blocked;
        return ok();
      }
      if (command.startsWith('rm -f')) return ok();
      if (command.startsWith('cat') && command.includes('.exit')) return ok(agentDone() ? `${options.agentExitCode ?? 0}\n` : '');
      if (command.startsWith('cat')) return ok(`${options.agentOutput ?? sha256Hex(config.secret)}\n`);
      return { code: 127, stdout: '', stderr: `unexpected ${command}` };
    },
  };
  return { deps, commands, cloud, gateReadWhileBlocked: () => gateReadWhileBlocked };
}

describe('parseEstablishedConnections', () => {
  it('reads ss rows, normalises v4-mapped IPv6 peers, and drops unparseable lines', () => {
    const rows = parseEstablishedConnections(
      ['0 0 10.0.0.2:40000 104.21.73.140:443', '0 0 [::ffff:10.0.0.2]:22 [::ffff:35.235.241.7]:5', 'garbage', ''].join('\n'),
    );
    expect(rows).toEqual([
      { localAddress: '10.0.0.2', localPort: 40000, remoteAddress: '104.21.73.140', remotePort: 443 },
      { localAddress: '10.0.0.2', localPort: 22, remoteAddress: '35.235.241.7', remotePort: 5 },
    ]);
    expect(normalizeAddress('[2606:4700::1]')).toBe('2606:4700::1');
  });

  it('classifies peers by the addresses resolved at drill time', () => {
    const classes = classifyConnections(parseEstablishedConnections('0 0 a:1 104.21.73.140:443\n0 0 a:2 160.79.104.10:443\n0 0 a:3 8.8.8.8:53'), {
      papercusp: PAPERCUSP,
      modelProvider: MODEL,
    }).map((connection) => connection.class);
    expect(classes).toEqual(['papercusp', 'model-provider', 'other']);
  });
});

describe('buildEgressDenyRule', () => {
  it('denies exactly the resolved addresses on the host network, and deletes the same rule', () => {
    const rule = buildEgressDenyRule({ project: 'p', network: 'n', ruleName: 'pc-j5-x', addresses: ['172.67.145.145', '104.21.73.140', '104.21.73.140'] });
    expect(rule.createArgs).toEqual(expect.arrayContaining(['--network', 'n', '--direction', 'EGRESS', '--action', 'DENY']));
    expect(rule.createArgs[rule.createArgs.indexOf('--destination-ranges') + 1]).toBe('104.21.73.140/32,172.67.145.145/32');
    expect(rule.deleteArgs).toEqual(['compute', 'firewall-rules', 'delete', 'pc-j5-x', '--project', 'p', '--quiet']);
  });

  it('refuses an empty block, a non-IPv4 address, and an invalid rule name', () => {
    expect(() => buildEgressDenyRule({ project: 'p', network: 'n', ruleName: 'pc-j5-x', addresses: [] })).toThrow(/no Papercusp addresses/);
    expect(() => buildEgressDenyRule({ project: 'p', network: 'n', ruleName: 'pc-j5-x', addresses: ['2606:4700::1'] })).toThrow(/IPv4/);
    expect(() => buildEgressDenyRule({ project: 'p', network: 'n', ruleName: 'Bad_Name', addresses: PAPERCUSP })).toThrow(/rule name/);
  });
});

describe('runOutageDrill + evaluateOutageDrill', () => {
  it('passes when the agent finishes during the block and the connector reconnects after the lift', async () => {
    const host = fakeHost();
    const evidence = await runOutageDrill(config, host.deps);
    const verdict = evaluateOutageDrill(evidence);
    expect(verdict).toEqual({ passed: true, failures: [] });
    expect(evidence.during).toMatchObject({ papercuspReachable: false, modelProviderReachable: true, agentRunningWhenBlocked: true, papercuspConnectionsWhileBlocked: 0 });
    expect(host.cloud.map((args) => args[2])).toEqual(['create', 'delete']);
    // The agent is launched detached BEFORE the block, so the outage lands mid-task.
    const launchIndex = host.commands.findIndex((command) => command.includes('nohup'));
    expect(launchIndex).toBeGreaterThan(-1);
  });

  it('fails, naming the cause, when the host never reconnects after the lift', async () => {
    const verdict = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ reconnectAfterMs: null }).deps));
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toEqual(expect.arrayContaining([
      "the control plane did not hear from the host's connector after the block was lifted",
      'after the lift the host held no connection to Papercusp',
    ]));
  });

  it('fails when the agent output is wrong or the agent exits non-zero', async () => {
    const wrong = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ agentOutput: 'deadbeef' }).deps));
    expect(wrong.failures).toContain('the agent output is missing or not the expected digest');
    const crashed = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ agentExitCode: 1 }).deps));
    expect(crashed.failures).toContain('the agent task exited 1');
  });

  it('fails when the block never took effect, so a vacuous outage cannot pass', async () => {
    const verdict = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ blockIneffective: true }).deps));
    expect(verdict.failures).toContain('Papercusp was still reachable from the host during the block');
  });

  it('fails when the agent ignored its gate and finished before the block landed', async () => {
    const verdict = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ agentSkipsGate: true }).deps));
    expect(verdict.failures).toEqual(expect.arrayContaining([
      'the agent task was not running when the block landed',
      'the agent was never handed its secret during the outage',
    ]));
  });

  it('hands the agent its secret only through the pipe, and only once Papercusp is unreachable', async () => {
    const host = fakeHost();
    const evidence = await runOutageDrill(config, host.deps);
    expect(host.gateReadWhileBlocked()).toBe(true);
    expect(evidence.agent.gateReleasedAt! > evidence.blockedAt!).toBe(true);
    const launch = host.commands.find((command) => command.includes('nohup'))!;
    expect(launch).toContain('mkfifo');
    expect(launch).not.toContain(config.secret);
    // A detached agent holding the SSH channel's stdin keeps the launch call from ever returning.
    expect(launch).toMatch(/ < \/dev\/null > \/dev\/null 2>&1 &$/);
    expect(evidence.agent.expected).toBe(sha256Hex(config.secret));
  });

  it('fails, naming the cause, when the agent never opens its gate pipe', async () => {
    const host = fakeHost({ agentNeverReadsGate: true });
    const evidence = await runOutageDrill(config, host.deps);
    expect(host.cloud.map((args) => args[2])).toEqual(['create', 'delete']);
    expect(evaluateOutageDrill(evidence).failures).toEqual(expect.arrayContaining([
      'drill error: the agent never read its gate pipe within 60s (exit 124)',
      'the agent was never handed its secret during the outage',
    ]));
  });

  it('never releases the secret when the block did not take effect', async () => {
    const host = fakeHost({ blockIneffective: true });
    const evidence = await runOutageDrill(config, host.deps);
    expect(host.gateReadWhileBlocked()).toBeNull();
    expect(evidence.agent.gateReleasedAt).toBeNull();
  });

  it('always tries to lift the block, and reports a block it could not remove', async () => {
    const host = fakeHost({ deleteFails: true });
    const evidence = await runOutageDrill(config, host.deps);
    expect(host.cloud.map((args) => args[2])).toEqual(['create', 'delete']);
    expect(evaluateOutageDrill(evidence).failures).toEqual(expect.arrayContaining([
      'drill error: egress block NOT removed (pc-j5-outage-drill-n1): permission denied',
      'the egress block was not removed',
    ]));
  });

  it('never blocks anything when Papercusp and the model provider share an address', async () => {
    const host = fakeHost();
    const shared: OutageDrillDeps = { ...host.deps, resolveAddresses: async () => ['104.21.73.140'] };
    const evidence = await runOutageDrill(config, shared);
    expect(host.cloud).toEqual([]);
    expect(evaluateOutageDrill(evidence).failures[0]).toMatch(/share addresses 104\.21\.73\.140/);
  });
});
