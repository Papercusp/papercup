/**
 * Unit tests for fleet:launch-on-plan (EI-5504). The handler spawns desktop
 * terminals (no pure unit surface), so we cover the pure command builder — the
 * load-bearing bit: every member command must carry `--no-picker` + `--plan`, the
 * exact pair that triggers the EI-5503 auto-kickoff so the member starts on boot.
 * Importing the module also validates its whole import chain compiles + loads (the
 * tool self-registers via defineTool on import).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnConsoleMock = vi.fn();
const fetchGatewayHeadroomMock = vi.fn();

vi.mock('../../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({ cwd: '/tmp/fleet', env: {} })),
}));

vi.mock('../../../console-spawn', () => ({
  spawnConsole: (...args: unknown[]) => spawnConsoleMock(...args),
}));

vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-1',
}));

vi.mock('../../../agent-fleets-store', () => ({
  createFleetIfAbsent: vi.fn(async () => ({
    record: { leaderOwnerId: 'owner-1', colorScheme: { name: 'Ocean' } },
  })),
  fleetSlugFromName: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
  getFleetScheme: vi.fn(async () => ({ name: 'Ocean' })),
}));

vi.mock('../../coordination/presence', () => ({
  heartbeatPresence: vi.fn(async () => undefined),
  setPresenceFleet: vi.fn(async () => undefined),
}));

vi.mock('../../plans/source', () => ({
  resolveHarnessPlansDir: vi.fn(async (slug: string) => ({ harnessSlug: slug, workspaceId: 'ws-1' })),
  readPlanBySlug: vi.fn(async () => ({ slug: 'my-plan' })),
}));

vi.mock('../_shared', () => ({
  fleetRoleFor: () => 'leader',
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
  recolorCallerTerminal: async () => {},
  resolveFleetCaller: () => ({
    identity: { ownerId: 'owner-1' },
    ownerId: 'owner-1',
    workspaceId: 'ws-1',
  }),
}));

vi.mock('../../../inference-gateway/observability', () => ({
  fetchGatewayHeadroom: (...args: unknown[]) => fetchGatewayHeadroomMock(...args),
}));

import tool, { memberLaunchCommand } from '../launch-on-plan';

describe('memberLaunchCommand', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
  });

  it('builds the scripted psu launch that triggers the auto-kickoff', () => {
    expect(
      memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan' }),
    ).toBe('psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan');
  });

  it('always carries --no-picker + --plan (the kickoff gate) for every backend', () => {
    for (const agent of ['claude', 'omp', 'codex']) {
      const cmd = memberLaunchCommand({ fleetSlug: 'f', agent, harness: 'h', plan: 'p' });
      expect(cmd).toContain('--no-picker');
      expect(cmd).toContain('--plan=p');
      expect(cmd).toContain(`--agent=${agent}`);
      expect(cmd).toContain('--fleet=f');
    }
  });

  it('threads the account pin + scalar psu flags as --flag=value (EI-5765)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan',
      account: 'aviynw6', workspace: 'ws1', role: 'su', model: 'opus:high', feature: 'F-3', profile: 'p',
    });
    expect(cmd).toContain('--account=aviynw6');
    expect(cmd).toContain('--workspace=ws1');
    expect(cmd).toContain('--role=su');
    expect(cmd).toContain('--model=opus:high'); // ':' is shell-safe → bare
    expect(cmd).toContain('--feature=F-3');
    expect(cmd).toContain('--profile=p');
    // the base tokens stay first + unchanged
    expect(
      cmd.startsWith('psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan'),
    ).toBe(true);
  });

  it('emits --brain as a bare flag and --add-dir repeated', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', brain: true, addDir: ['/a', '/b'],
    });
    expect(cmd).toContain(' --brain');
    expect(cmd).toContain('--add-dir=/a');
    expect(cmd).toContain('--add-dir=/b');
  });

  it('emits --no-subagents as a bare flag when requested (owner request 2026-07-01); omitted by default', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', noSubagents: true,
    });
    expect(cmd).toContain(' --no-subagents');
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p' }),
    ).not.toContain('--no-subagents');
  });

  it('threads --context-size=<variant> (full|trimmed) for every backend', () => {
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', contextSize: 'trimmed' }),
    ).toContain('--context-size=trimmed');
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'omp', harness: 'h', plan: 'p', contextSize: 'full' }),
    ).toContain('--context-size=full');
  });

  it('shell-quotes a launch-context path with spaces (injection-safe)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', launchContext: '/home/x/brief one.md',
    });
    expect(cmd).toContain(`--launch-context='/home/x/brief one.md'`);
  });

  it('appends extraArgs verbatim, quoting only what needs it', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', extraArgs: ['--yes', '--add-dir=/x y'],
    });
    expect(cmd).toContain(' --yes');
    expect(cmd).toContain(`'--add-dir=/x y'`);
  });

  it('omits every optional flag when none are passed (base command unchanged)', () => {
    expect(
      memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan' }),
    ).toBe('psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan');
  });

  it('loads + self-registers the tool module without error', () => {
    expect(tool).toBeTruthy();
  });

  it('surfaces a sizing advisory only when requested members exceed healthy account headroom', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockResolvedValue({
      reachable: true,
      utilization: 0.1,
      utilizationPct: 10,
      paused: false,
      rejected: false,
      inFlight: 0,
      queueDepth: 0,
      priorityTiers: {
        healthyAccounts: 1,
        tier1Reserve: 0,
        tiers: [{ tier: 3, cap: 4, inFlight: 0, queued: 0 }],
      },
    });

    const warned = await tool.handler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const warnedPayload = JSON.parse((warned as any).content[0].text);
    expect(warnedPayload.ok).toBe(true);
    expect(warnedPayload.sizingAdvisory).toMatchObject({
      requestedMembers: 2,
      healthyHeadroom: 1,
      extraMembers: 1,
    });
    expect(warnedPayload.message).toMatch(/Sizing advisory:/);

    fetchGatewayHeadroomMock.mockResolvedValue({
      reachable: true,
      utilization: 0.1,
      utilizationPct: 10,
      paused: false,
      rejected: false,
      inFlight: 0,
      queueDepth: 0,
      priorityTiers: {
        healthyAccounts: 2,
        tier1Reserve: 0,
        tiers: [{ tier: 3, cap: 4, inFlight: 0, queued: 0 }],
      },
    });

    const notWarned = await tool.handler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const notWarnedPayload = JSON.parse((notWarned as any).content[0].text);
    expect(notWarnedPayload.ok).toBe(true);
    expect(notWarnedPayload.sizingAdvisory).toBeNull();
    expect(notWarnedPayload.message).not.toMatch(/Sizing advisory:/);
  });
});
