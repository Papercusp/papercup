/**
 * launch-agent.test.ts — capability:launch-agent's MODE MATRIX
 * (agent-launch-resume-primitives-2026-07-12 P-009).
 *
 * The composition is the whole point of the tool, so the matrix is what's pinned:
 * (ad-hoc | resumed | forked) × (fleet | no-fleet) × (visible | headless) × 1..N —
 * plus the two rules that make a launch actually WORK: the brief becomes the first
 * turn (via the spawn-safe env, never a --kickoff= value), and a LIVE source is
 * FORKED rather than resumed in place (D-007).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/capability/launch-agent.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../papercusp-root', () => ({ papercuspPathForWorkspace: () => '/tmp/papercusp-ws' }));

vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({
    cwd: '/repo',
    env: { PAPERCUSP_SID: 'su-caller' },
    greetingCmd: '',
    mcpJsonContents: '',
  })),
}));

const spawnConsoleMock = vi.fn(async () => ({
  status: 'ok' as const,
  pid: 4242,
  terminal: 'xterm',
  child: {} as never,
  display: ':1',
  desktopEnvResolvedVia: 'active-seat' as const,
}));
const spawnHeadlessMock = vi.fn(async () => ({
  status: 'ok' as const,
  pid: 777,
  terminal: 'headless',
  child: {} as never,
  display: null,
  desktopEnvResolvedVia: null,
}));
vi.mock('../../console-spawn', () => ({
  spawnConsole: (o: unknown) => spawnConsoleMock(o as never),
  spawnHeadless: (o: unknown) => spawnHeadlessMock(o as never),
}));

vi.mock('../../agent-fleets-store', () => ({
  fleetSlugFromName: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
  getFleetScheme: async (_ws: string, slug: string) =>
    slug === 'alpha-fleet' ? { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' } : null,
}));

const fetchPresenceFleetMock = vi.fn(
  async (_ids: string[]) => new Map<string, { fleetSlug: string | null; fleetRole: string | null }>(),
);
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (ids: string[]) => fetchPresenceFleetMock(ids),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({
    ownerId: 'su-caller',
    ownerLabel: 'su',
    source: 'psu',
    workspaceId: 'ws-test',
    userId: null,
  }),
}));

// The shared core: the resolver + idempotency ledger hit PG, so they are stubbed;
// the pure command builders/injectors run FOR REAL (they are what we're pinning).
const resolveResumeTargetMock = vi.fn();
const claimAgentLaunchMock = vi.fn(async () => ({
  won: true,
  priorSummary: null,
  priorLaunchedAt: null,
  priorLaunchedBy: null,
}));
const recordAgentLaunchResultMock = vi.fn(async () => {});
vi.mock('../../agent-launch-core', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveResumeTarget: (ref: unknown) => resolveResumeTargetMock(ref as never),
  claimAgentLaunch: (o: unknown) => claimAgentLaunchMock(o as never),
  recordAgentLaunchResult: (o: unknown) => recordAgentLaunchResultMock(o as never),
}));

const launchAgent = (await import('./launch-agent')).default;

const ctx = { workspaceId: 'ws-test', harnessSlug: 'papercusp', role: 'su' } as never;
const textOf = (res: unknown): string => (res as { content: Array<{ text: string }> }).content[0].text;
const isError = (res: unknown): boolean => !!(res as { isError?: boolean }).isError;
/** The command the tool actually handed to the spawner. */
const spawnedCommand = (mock = spawnConsoleMock): string =>
  (mock.mock.calls[0][0] as unknown as { envelope: { greetingCmd: string } }).envelope.greetingCmd;
const spawnedEnv = (mock = spawnConsoleMock): Record<string, string> =>
  (mock.mock.calls[0][0] as unknown as { envelope: { env: Record<string, string> } }).envelope.env;

beforeEach(() => {
  vi.clearAllMocks();
  claimAgentLaunchMock.mockResolvedValue({
    won: true,
    priorSummary: null,
    priorLaunchedAt: null,
    priorLaunchedBy: null,
  });
  fetchPresenceFleetMock.mockResolvedValue(new Map());
});

describe('ad-hoc launch (a brief, no plan, no fleet — D-002/D-003)', () => {
  it('launches a visible agent whose FIRST TURN is the brief', async () => {
    const res = await launchAgent.handler({ brief: 'audit the release script' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    // Scripted launch: no picker, account pinned (P-012), launcher provenance.
    expect(spawnedCommand()).toContain('psu --launched-by=su-caller --no-picker --account=default');
    // The brief rides the SPAWN-SAFE env, never a --kickoff= value in the command
    // (a free-form text there gets double-quoted by the greeting one-liner and
    // breaks the shell).
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toBe('audit the release script');
    expect(spawnedCommand()).not.toContain('--kickoff');
    expect(textOf(res)).toContain('(no fleet)');
    expect(textOf(res)).toContain("first turn");
  });

  it('refuses a launch with nothing to do (it would just sit idle)', async () => {
    const res = await launchAgent.handler({}, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/a `brief`.*or a `plan`/s);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('launches N agents on one brief', async () => {
    await launchAgent.handler({ brief: 'triage the backlog', count: 3 }, ctx);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(3);
  });

  it('binds a plan (and its harness) when asked', async () => {
    await launchAgent.handler({ plan: 'my-plan' }, ctx);
    expect(spawnedCommand()).toContain('--harness=papercusp --plan=my-plan');
  });
});

describe('fleet composition (D-003: fleet is an ARG, not a separate tool)', () => {
  it('joins an explicit fleet — membership AND colour, from one slug', async () => {
    const res = await launchAgent.handler({ brief: 'work the release', fleet: 'alpha fleet' }, ctx);
    expect(spawnedCommand()).toContain('--fleet=alpha-fleet');
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({ scheme: { name: 'royal-purple' } });
    expect(textOf(res)).toContain('in fleet alpha-fleet');
  });

  it("falls back to the CALLER's presence fleet when none is named (WI-4234)", async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['su-caller', { fleetSlug: 'alpha-fleet', fleetRole: 'leader' }]]),
    );
    await launchAgent.handler({ brief: 'help out' }, ctx);
    expect(spawnedCommand()).toContain('--fleet=alpha-fleet');
  });

  it('launches unfleeted when the caller has no fleet (a non-leader can still launch)', async () => {
    await launchAgent.handler({ brief: 'solo task' }, ctx);
    expect(spawnedCommand()).not.toContain('--fleet=');
  });
});

describe('headless composition (D-003: an ARG, not a separate tool)', () => {
  it('routes to the headless spawner with --headless (so the pty — and wakes — survive)', async () => {
    const res = await launchAgent.handler({ brief: 'long soak', headless: true }, ctx);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--headless');
    expect(spawnHeadlessMock.mock.calls[0][0]).toMatchObject({ logDir: '/tmp/papercusp-ws/fleet-logs' });
    expect(textOf(res)).toContain('EI-9748');
  });
});

describe('resume + fork (D-004/D-007)', () => {
  const dead = {
    ok: true as const,
    sessionId: 'sid-dead',
    ownerId: 'su-a1a71',
    agent: 'claude',
    cwd: '/repo',
    endedAt: '2026-07-11T10:00:00.000Z',
    live: false,
    advSessionId: 11,
  };

  it('resumes a dead agent BY AGENT ID — no uuid hunting', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' } }, ctx);

    expect(resolveResumeTargetMock).toHaveBeenCalledWith({ agentId: 'su-a1a71', sessionId: null });
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(textOf(res)).toContain('re-attaches its ORIGINAL identity su-a1a71');
  });

  it('delivers a brief with a resume as the session\'s NEXT turn (via the pty inject)', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'the plan changed' }, ctx);
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toBe('the plan changed');
    expect(textOf(res)).toContain('managed pty');
  });

  it('FORKS a still-LIVE source instead of colliding on its transcript (D-007)', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' } }, ctx);

    expect(spawnedCommand()).toContain('--resume=sid-dead --fork');
    expect(textOf(res)).toContain('still LIVE');
    expect(textOf(res)).toContain('FRESH identity');
  });

  it('forks explicitly when asked, even from a dead source', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler({ resume: { sessionId: 'sid-dead' }, fork: true }, ctx);
    expect(spawnedCommand()).toContain('--fork');
  });

  it('surfaces an unresolvable target instead of launching something wrong', async () => {
    resolveResumeTargetMock.mockResolvedValue({
      ok: false,
      error: 'not_found',
      detail: 'no adv_sessions row for agent su-nope',
    });
    const res = await launchAgent.handler({ resume: { agentId: 'su-nope' } }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('no adv_sessions row');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('refuses to resume one session N times (fork is the run-alongside path)', async () => {
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, count: 3 }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/cannot be resumed more than once/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('allows fork × count (branch N agents off one context)', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, fork: true, count: 2 }, ctx);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
  });

  it('rejects fork with no source to fork FROM', async () => {
    const res = await launchAgent.handler({ brief: 'x', fork: true }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('needs a source session');
  });

  it('rejects plan + resume (a resumed session keeps its own context)', async () => {
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, plan: 'p' }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('`plan` is for a FRESH launch');
  });
});

describe('idempotency (P-014: a replay must not open a second set of windows)', () => {
  it('spawns nothing and reports the ORIGINAL launch when the key was already claimed', async () => {
    claimAgentLaunchMock.mockResolvedValue({
      won: false,
      priorSummary: { opened: 2, mode: 'fresh' },
      priorLaunchedAt: 1_760_000_000_000,
      priorLaunchedBy: 'su-caller',
    });
    const res = await launchAgent.handler({ brief: 'do it', count: 2, idempotencyKey: 'retry-1' }, ctx);

    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(textOf(res)).toContain('Already launched (deduped)');
    expect(textOf(res)).toContain('"opened":2');
  });

  it('records what the winning launch did, so a later replay can report it', async () => {
    await launchAgent.handler({ brief: 'do it', idempotencyKey: 'retry-1' }, ctx);
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'retry-1',
        summary: expect.objectContaining({ opened: 1, failed: 0, mode: 'fresh' }),
      }),
    );
  });
});

describe('failure reporting', () => {
  it('reports a failed spawn as an error rather than a silent success', async () => {
    spawnConsoleMock.mockResolvedValue({
      status: 'error',
      code: 501,
      error: 'no desktop session',
    } as never);
    const res = await launchAgent.handler({ brief: 'x' }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('launch failed (501): no desktop session');
  });
});
