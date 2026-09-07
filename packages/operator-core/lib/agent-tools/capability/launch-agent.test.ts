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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { KickoffProofResult, SpawnChildExit, SpawnConsoleResult } from '../../console-spawn';
import { PSU_LAUNCH_LOG_TAIL_CHARS } from '../../psu-launch-log.mjs';

const assembleRolePromptMock = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/orchestrator/role-prompt', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  assembleRolePrompt: (...args: unknown[]) => assembleRolePromptMock(...args),
}));

const goalContextSqlMock = vi.hoisted(() => vi.fn(async () => []));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // resolveGoalLaunch now reads the holder-authority fence before resolving
  // inherited context. This suite has no goal rows, so return an empty result
  // rather than allowing the PG-backed default to leak into the test.
  getOrgPg: () => ({ sql: goalContextSqlMock }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../papercusp-root', () => ({ papercuspPathForWorkspace: () => '/tmp/papercusp-ws' }));

const readPsuLaunchLogTailMock = vi.hoisted(() => vi.fn());
vi.mock('../../psu-launch-log.mjs', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readPsuLaunchLogTail: (...args: unknown[]) => readPsuLaunchLogTailMock(...args),
}));

const shutdownViaPtyMock = vi.hoisted(() => vi.fn(async (_ownerId: string, _opts?: unknown) => 'sent'));
const findLiveHostMock = vi.hoisted(() => vi.fn((_ownerId: string): unknown => null));
const markAdvSessionEndedMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock('../../adv-sessions', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  markAdvSessionEnded: (...args: unknown[]) => markAdvSessionEndedMock(...args),
}));
const resolveSessionStatesMock = vi.hoisted(() => vi.fn());
vi.mock('../coordination/liveness-oracle', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveSessionStates: (...args: unknown[]) => resolveSessionStatesMock(...args),
}));
vi.mock('../../events/await/psu-pty-discovery', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findLiveHost: (ownerId: string) => findLiveHostMock(ownerId),
  shutdownViaPty: (ownerId: string, opts?: unknown) => shutdownViaPtyMock(ownerId, opts),
}));

const windowScopeVerdictMock = vi.hoisted(() => vi.fn((_pid: number, _fs: unknown) => 'dead'));
vi.mock('../../task-manager/terminal-residue-census', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isPidInLiveWindowScope: (pid: number, fs: unknown) => windowScopeVerdictMock(pid, fs),
}));

const getModesMock = vi.hoisted(() => vi.fn());
vi.mock('../../modes/store', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getModes: (...args: unknown[]) => getModesMock(...args),
}));

const listFactsMock = vi.hoisted(() => vi.fn());
vi.mock('../../agent-facts/store', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listFacts: (...args: unknown[]) => listFactsMock(...args),
}));

const getLoopStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../../harness/routines/loop', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLoopStatus: (ownerId: string) => getLoopStatusMock(ownerId),
}));

vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({
    cwd: '/repo',
    env: { PAPERCUSP_SID: 'su-caller' },
    greetingCmd: '',
    mcpJsonContents: '',
  })),
}));

// launch-agent's mode matrix is about command composition and spawn routing. The
// backend PATH preflight and startup probes have their own focused suites
// (backend-bin-resolve.test.ts and agent-launch-verification.test.ts); keep those
// infrastructure probes deterministic here so this test does not depend on the
// host's installed backend or spend 30s polling a real PG-backed session ledger.
vi.mock('../../backend-bin-resolve.mjs', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  preflightBackendLaunch: vi.fn(() => ({ ok: true })),
}));

const codexPreflightHomeMock = vi.hoisted(() =>
  vi.fn(async (_account: string | undefined, _workspaceId: string) => null as string | null),
);
const codexPreflightModelMock = vi.hoisted(() => vi.fn());
vi.mock('../../inference-gateway/codex-oauth-proxy', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveCodexPreflightHome: (account: string | undefined, workspaceId: string) =>
    codexPreflightHomeMock(account, workspaceId),
  preflightCodexModel: (...args: unknown[]) => codexPreflightModelMock(...args),
}));

// Typed against the REAL SpawnConsoleResult (type-only import — not mocked away)
// so the mocks cannot silently drift from the spawn contract again (WI-4488: the
// EI-8289 display/desktopEnvResolvedVia refactor left inferred-shape mocks stale).
const spawnConsoleMock = vi.fn(
  async (_opts: unknown): Promise<SpawnConsoleResult> => ({
    status: 'ok',
    pid: 4242,
    terminalPid: 4343,
    terminal: 'xterm',
    child: {} as never,
    display: ':1',
    desktopEnvResolvedVia: 'active-seat',
  }),
);
const headlessSpawnResult = (
  childExit?: Promise<SpawnChildExit>,
  kickoffProof: KickoffProofResult | null = {
    persisted: true,
    nativeRef: '/native/launch.jsonl',
    reason: null,
  },
): SpawnConsoleResult => ({
    status: 'ok',
    pid: 777,
    terminal: 'headless',
    taskId: 'task777',
    logPath: '/tmp/papercusp-ws/fleet-logs/judge.log',
    normalizedLogPath: '/tmp/papercusp-ws/fleet-logs/judge.normalized.log',
    child: {} as never,
    display: null,
    desktopEnvResolvedVia: null,
    ...(childExit ? { childExit } : {}),
    ...(kickoffProof ? { kickoffProof } : {}),
});
const HEADLESS_RESUME_LOG_PATH = '/tmp/papercusp-ws/fleet-logs/judge.log';
const spawnHeadlessMock = vi.fn(
  async (_opts: unknown): Promise<SpawnConsoleResult> => headlessSpawnResult(),
);
const spawnGovernedAgentProcessMock = vi.fn(
  (_input: unknown, spawnProcess: (context: Record<string, unknown>) => Promise<SpawnConsoleResult>) =>
    spawnProcess({ receiptId: 'WI-governed-test', leaseId: 'lease-governed-test' }),
);
const getFleetHeadcountTargetMock = vi.hoisted(() => vi.fn());
const createFleetIfAbsentMock = vi.hoisted(() => vi.fn());
const getFleetSchemeMock = vi.hoisted(() => vi.fn());
vi.mock('../../console-spawn', () => ({
  spawnConsole: (o: unknown) => spawnConsoleMock(o),
  spawnHeadless: (o: unknown) => spawnHeadlessMock(o),
}));
vi.mock('../../resource-governor/spawn-execution', () => ({
  spawnGovernedAgentProcess: (input: unknown, spawnProcess: (context: Record<string, unknown>) => Promise<SpawnConsoleResult>) =>
    spawnGovernedAgentProcessMock(input, spawnProcess),
}));

const latestFleetMembershipMock = vi.hoisted(() => vi.fn());
vi.mock('../../fleet-membership-store', () => ({
  latestFleetMembership: (workspaceId: string, ownerId: string) => latestFleetMembershipMock(workspaceId, ownerId),
}));

vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  fleetSlugFromName: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
  createFleetIfAbsent: (...args: unknown[]) => createFleetIfAbsentMock(...args),
  getFleetHeadcountTarget: (...args: unknown[]) => getFleetHeadcountTargetMock(...args),
  getFleetScheme: (...args: unknown[]) => getFleetSchemeMock(...args),
}));

const fetchPresenceFleetMock = vi.fn(
  async (_ids: string[]) => new Map<string, { fleetSlug: string | null; fleetRole: string | null }>(),
);
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (ids: string[]) => fetchPresenceFleetMock(ids),
}));

const fetchContextPressureMock = vi.fn(async (_ids: string[]) => new Map<string, 'ok' | 'high' | 'critical'>());
vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressure: (ids: string[]) => fetchContextPressureMock(ids),
}));

const buildCarryBriefMock = vi.hoisted(() => vi.fn());
const renderCarryBriefTextMock = vi.hoisted(() => vi.fn());
vi.mock('../../carry-brief', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildCarryBrief: (...args: unknown[]) => buildCarryBriefMock(...args),
  renderCarryBriefText: (...args: unknown[]) => renderCarryBriefTextMock(...args),
}));

// Mutable so a test can model an UNATTRIBUTED caller (no owner id), which is what
// gates the fresh/fork launch verifier — see the EI-21725123573114023 case below.
const callerIdentity = vi.hoisted(() => ({
  current: {
    ownerId: 'su-caller' as string | null,
    ownerLabel: 'su',
    source: 'psu',
    workspaceId: 'ws-test',
    userId: null,
  },
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => callerIdentity.current,
}));

// The shared core: the resolver + idempotency ledger hit PG, so they are stubbed;
// the pure command builders/injectors run FOR REAL (they are what we're pinning).
const resolveResumeTargetMock = vi.fn();
// Both mocks are CALLED with one argument below, so they must DECLARE one —
// a zero-arg vi.fn() is a TS2554 the vitest run cannot see (esbuild strips types,
// so the suite stays green while the file is type-broken). Same shape as the
// claimAgentLaunchMock/recordAgentLaunchResultMock pair further down.
const verifyFreshLaunchStartedMock = vi.fn(async (_args: unknown) => ({
  // agentStarted is deliberately THREE-state (true | false | null) per D-004 —
  // null means "not yet determinable", which is the stub's honest answer.
  agentStarted: null as boolean | null,
  waitedMs: 0,
  sessions: [] as Array<{ ownerId: string; sessionId?: string | null; successfulCalls: number }>,
  note: 'test launch verification stub',
}));
const verifyResumeStartedMock = vi.fn(async (_ownerId: unknown, opts?: { expectedSessionId?: string | null }) => ({
  started: true as boolean | null,
  waitedMs: 0,
  expectedSessionId: opts?.expectedSessionId ?? null,
  actualSessionId: opts?.expectedSessionId ?? null,
  mismatch: false,
}));
const claimAgentLaunchMock = vi.fn(
  async (
    _opts: unknown,
  ): Promise<{
    won: boolean;
    priorSummary: Record<string, unknown> | null;
    priorLaunchedAt: number | null;
    priorLaunchedBy: string | null;
  }> => ({ won: true, priorSummary: null, priorLaunchedAt: null, priorLaunchedBy: null }),
);
const recordAgentLaunchResultMock = vi.fn(async (_opts: unknown) => {});
const releaseAgentLaunchClaimMock = vi.fn(async (_opts: unknown) => true);
const waitForPtyHostGoneMock = vi.fn(async (_ownerId: unknown) => true);
vi.mock('../../agent-launch-core', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveResumeTarget: (ref: unknown) => resolveResumeTargetMock(ref as never),
  verifyFreshLaunchStarted: (args: unknown) => verifyFreshLaunchStartedMock(args as never),
  verifyResumeStarted: (ownerId: unknown, opts: unknown) => verifyResumeStartedMock(ownerId as never, opts as never),
  waitForPtyHostGone: (ownerId: unknown) => waitForPtyHostGoneMock(ownerId),
  claimAgentLaunch: (o: unknown) => claimAgentLaunchMock(o),
  recordAgentLaunchResult: (o: unknown) => recordAgentLaunchResultMock(o),
  releaseAgentLaunchClaim: (o: unknown) => releaseAgentLaunchClaimMock(o),
}));

const launchAgentModule = await import('./launch-agent');
const launchAgent = launchAgentModule.default;
const { goalHolderPlanFleetBypass } = launchAgentModule;

const ctx = { workspaceId: 'ws-test', harnessSlug: 'papercusp', role: 'su' } as never;
const textOf = (res: unknown): string => (res as { content: Array<{ text: string }> }).content[0].text;
const dataOf = (res: unknown) => (res as { data?: { deduped?: boolean; launch?: Record<string, unknown> } }).data;
const isError = (res: unknown): boolean => !!(res as { isError?: boolean }).isError;
/** The command the tool actually handed to the spawner. */
const spawnedCommand = (mock = spawnConsoleMock): string =>
  (mock.mock.calls[0][0] as unknown as { envelope: { greetingCmd: string } }).envelope.greetingCmd;
const spawnedEnv = (mock = spawnConsoleMock): Record<string, string> =>
  (mock.mock.calls[0][0] as unknown as { envelope: { env: Record<string, string> } }).envelope.env;

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(HEADLESS_RESUME_LOG_PATH, { force: true });
  assembleRolePromptMock.mockReturnValue({ text: 'role prompt', meta: { projectDir: '/repo' } });
  readPsuLaunchLogTailMock.mockReturnValue(null);
  codexPreflightHomeMock.mockResolvedValue(null);
  codexPreflightModelMock.mockReset();
  claimAgentLaunchMock.mockResolvedValue({
    won: true,
    priorSummary: null,
    priorLaunchedAt: null,
    priorLaunchedBy: null,
  });
  callerIdentity.current.ownerId = 'su-caller';
  releaseAgentLaunchClaimMock.mockResolvedValue(true);
  markAdvSessionEndedMock.mockReset();
  markAdvSessionEndedMock.mockResolvedValue(true);
  resolveSessionStatesMock.mockReset();
  resolveSessionStatesMock.mockResolvedValue(new Map([['su-a1a71', { sessionState: 'ended' }]]));
  fetchPresenceFleetMock.mockResolvedValue(new Map());
  latestFleetMembershipMock.mockResolvedValue(null);
  fetchContextPressureMock.mockResolvedValue(new Map());
  buildCarryBriefMock.mockResolvedValue({ ownerId: 'su-a1a71' });
  renderCarryBriefTextMock.mockReturnValue('');
  verifyFreshLaunchStartedMock.mockResolvedValue({
    agentStarted: null,
    waitedMs: 0,
    sessions: [] as Array<{ ownerId: string; sessionId?: string | null; successfulCalls: number }>,
    note: 'test launch verification stub',
  });
  verifyResumeStartedMock.mockResolvedValue({
    started: true,
    waitedMs: 0,
    expectedSessionId: 'sid-dead',
    actualSessionId: 'sid-dead',
    mismatch: false,
  });
  shutdownViaPtyMock.mockResolvedValue('sent');
  findLiveHostMock.mockReturnValue({ ownerId: 'su-a1a71', pid: 42, sock: '/run/host.sock' });
  windowScopeVerdictMock.mockReturnValue('dead');
  waitForPtyHostGoneMock.mockResolvedValue(true);
  getModesMock.mockResolvedValue([]);
  listFactsMock.mockResolvedValue([]);
  getLoopStatusMock.mockResolvedValue(null);
  getFleetHeadcountTargetMock.mockResolvedValue(null);
  createFleetIfAbsentMock.mockResolvedValue({ record: null, created: false });
  getFleetSchemeMock.mockImplementation(async (_ws: string, slug: string) =>
    slug === 'alpha-fleet' ? { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' } : null,
  );
});

describe('launch-tool routing guidance', () => {
  it('identifies capability:launch-agent as the general agent-launch door', () => {
    expect(launchAgent.guidance?.when).toContain('GENERAL AGENT-LAUNCH DOOR');
    expect(launchAgent.guidance?.when).toContain('visible or headless');
    expect(launchAgent.guidance?.when).toContain('fleet or unfleeted');
    expect(launchAgent.guidance?.when).toContain('fleet:launch-on-plan');
    expect(launchAgent.guidance?.notWhen).toContain('capability:terminal');
  });

  // WI-4753: the canonical routing doc must stay linked from every door's
  // guidance, not just fleet:launch-on-plan's — a recurrence guard so the
  // cross-link can't silently drop on a future guidance edit.
  it('cross-links the canonical four-door routing table', () => {
    expect(launchAgent.guidance?.notWhen).toContain('launching-agents-which-tool-for-which-door');
  });

  it('routes returned process task handles to the process tools', () => {
    const seeAlso = launchAgent.guidance?.seeAlso;
    expect(Array.isArray(seeAlso) ? seeAlso.join('\n') : '').toContain(
      'processes:list / processes:kill (returned tasks[].taskId handles; not tasks:get)',
    );
  });
});

describe('GOAL alternate plan-placement entry guard (P-006 / A-04)', () => {
  it('classifies only a fresh plan+fleet launch by the current GOAL holder', () => {
    const modes = [{ mode: 'goal', subject: 'goal-1' }];
    expect(
      goalHolderPlanFleetBypass({ sourceAction: false, plan: 'plan-a', fleet: 'fleet-a', modeRows: modes }),
    ).toEqual({ goalId: 'goal-1' });
    expect(
      goalHolderPlanFleetBypass({ sourceAction: true, plan: 'plan-a', fleet: 'fleet-a', modeRows: modes }),
    ).toBeNull();
    expect(goalHolderPlanFleetBypass({ sourceAction: false, plan: 'plan-a', fleet: null, modeRows: modes })).toBeNull();
    expect(
      goalHolderPlanFleetBypass({ sourceAction: false, plan: null, fleet: 'fleet-a', modeRows: modes }),
    ).toBeNull();
    expect(
      goalHolderPlanFleetBypass({ sourceAction: false, plan: 'plan-a', fleet: 'fleet-a', modeRows: [] }),
    ).toBeNull();
  });

  it('refuses the alternate fresh plan+fleet path before fleet creation or spawn', async () => {
    getModesMock.mockResolvedValue([{ mode: 'goal', subject: 'goal-1', ownerDirected: true }]);
    const res = await launchAgent.handler(
      { brief: 'work plan-a', plan: 'plan-a', fleet: 'plan-a-fleet', harness: 'papercusp' },
      ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('goal_plan_placement_bypass_refused');
    expect(textOf(res)).toContain('fleet:launch-on-plan');
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable authority only for the bypass-capable shape', async () => {
    getModesMock.mockRejectedValue(new Error('mode store unavailable'));
    const res = await launchAgent.handler(
      { brief: 'work plan-a', plan: 'plan-a', fleet: 'plan-a-fleet', harness: 'papercusp' },
      ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('goal_plan_placement_authority_unreadable');
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
  });

  it('keeps a plan-bound independent grader outside a fleet available', async () => {
    getModesMock.mockResolvedValue([{ mode: 'goal', subject: 'goal-1', ownerDirected: true }]);
    const res = await launchAgent.handler(
      {
        brief: 'independently grade plan-a',
        plan: 'plan-a',
        independent: true,
        harness: 'papercusp',
        headless: false,
      },
      ctx,
    );
    expect(isError(res)).toBe(false);
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(dataOf(res)?.launch).toMatchObject({ fleet: null, independent: true, mode: 'fresh' });
  });
});

describe('published launch args schema', () => {
  it('rejects plan with resume or successor before handler dispatch', () => {
    expect(launchAgent.args.safeParse({ plan: 'p', resume: { agentId: 'su-a1a71' } }).success).toBe(false);
    expect(launchAgent.args.safeParse({ plan: 'p', successor: { agentId: 'su-a1a71' } }).success).toBe(false);
  });

  it('requires an actionable brief for source launches', () => {
    expect(launchAgent.args.safeParse({ plan: 'p' }).success).toBe(true);
    expect(launchAgent.args.safeParse({ resume: { agentId: 'su-a1a71' } }).success).toBe(false);
    expect(
      launchAgent.args.safeParse({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }).success,
    ).toBe(true);
    expect(launchAgent.args.safeParse({ successor: { agentId: 'su-a1a71' } }).success).toBe(true);
  });

  it('accepts the explicit independent fresh-launch mode', () => {
    expect(launchAgent.args.safeParse({ brief: 'independent work', independent: true }).success).toBe(true);
  });

  it('accepts a flat top-level persona role for fresh launches', () => {
    const parsed = launchAgent.args.safeParse({ brief: 'persona-specific work', role: 'reviewer' });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.role).toBe('reviewer');
    }
  });

  it('accepts top-level carry for an existing-fleet plan launch only', () => {
    const fresh = launchAgent.args.safeParse({
      fleet: 'existing-fleet',
      plan: 'existing-plan',
      carry: 'cold',
    });
    expect(fresh.success).toBe(true);
    if (fresh.success) {
      expect(fresh.data).toMatchObject({
        fleet: 'existing-fleet',
        plan: 'existing-plan',
        carry: 'cold',
      });
    }

    expect(
      launchAgent.args.safeParse({
        resume: { agentId: 'su-a1a71' },
        brief: 'continue the recovery',
        carry: 'cold',
      }).success,
    ).toBe(false);
  });

  it('does not impose a local agent-count ceiling before governed admission', () => {
    expect(launchAgent.args.safeParse({ brief: 'wide governed fan-out', count: 64 }).success).toBe(true);
    expect(
      launchAgent.args.safeParse({
        brief: 'member-specific governed fan-out',
        members: Array.from({ length: 64 }, (_, i) => ({ brief: `member-${i}` })),
      }).success,
    ).toBe(true);
  });

  it('documents members.role as a dynamic harness persona id, not a lane label', () => {
    // The published args preserve two source-launch variants in a ZodUnion;
    // inspect the first object variant's shared member schema.
    const argsOut = (launchAgent.args as unknown as {
      options: Array<{
        shape: {
          members: { unwrap: () => { element: { shape: Record<string, { description?: string }> } } };
        };
      }>;
    }).options[0]!;
    const members = argsOut.shape.members.unwrap();
    const role = members.element.shape.role;

    expect(role.description).toMatch(/registered persona id/i);
    expect(role.description).toMatch(/target harness/i);
    expect(role.description).toMatch(/not a lane\/job label/i);
    // The valid persona set is resolved against the selected harness at launch
    // time, so the shared wire schema must remain string-shaped rather than
    // freezing one harness's registry into a static enum.
    expect(
      launchAgent.args.safeParse({
        brief: 'member-specific launch',
        members: [{ role: 'independent-rubric-grader' }],
      }).success,
    ).toBe(true);
  });
});

describe('ad-hoc launch (a brief, no plan, no fleet — D-002/D-003)', () => {
  it('launches a visible agent whose FIRST TURN is the brief', async () => {
    const res = await launchAgent.handler({ brief: 'audit the release script' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({
      captureTerminalPid: true,
      writeMcpJson: true,
    });
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    // Scripted launch: no picker, account pinned (P-012), launcher provenance.
    expect(spawnedCommand()).toContain('psu --launched-by=su-caller --no-picker --account=default');
    // The brief rides the SPAWN-SAFE env, never a --kickoff= value in the command
    // (a free-form text there gets double-quoted by the greeting one-liner and
    // breaks the shell).
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toBe('audit the release script');
    expect(spawnedCommand()).not.toContain('--kickoff');
    expect(textOf(res)).toContain('(no fleet)');
    expect(textOf(res)).toContain('first turn');
    expect(textOf(res)).toContain('launcher pid 4242; terminal pid 4343');
    expect(dataOf(res)?.launch).toMatchObject({
      tasks: [{ pid: 4242, terminalPid: 4343, headless: false }],
    });
  });

  it('reports a plan-bound launch as self-pulling rather than idle', async () => {
    const res = await launchAgent.handler({ plan: 'plan-a' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(textOf(res)).toContain('bound to plan "plan-a"');
    expect(textOf(res)).toContain('pulls its own work; no brief needed');
    expect(textOf(res)).not.toContain('opens IDLE');
    expect(spawnedEnv()).not.toHaveProperty('PAPERCUSP_KICKOFF_PROMPT');
  });

  it('reports an unavailable terminal PID without falling back to the launcher PID', async () => {
    spawnConsoleMock.mockResolvedValueOnce({
      status: 'ok',
      pid: 4242,
      terminalPid: null,
      terminal: 'xterm',
      child: {} as never,
      display: ':1',
      desktopEnvResolvedVia: 'active-seat',
    });

    const res = await launchAgent.handler({ brief: 'audit the release script' }, ctx);

    expect(textOf(res)).toContain('launcher pid 4242; terminal pid unavailable');
    expect(textOf(res)).not.toContain('terminal pid 4242');
    expect(dataOf(res)?.launch).toMatchObject({
      tasks: [{ pid: 4242, terminalPid: null, headless: false }],
    });
  });

  it('honors the internal fresh owner pin used to correlate concurrent respawns', async () => {
    await launchAgent.handler(
      {
        brief: 'replace one fleet member',
        __respawnOwnerId: 'su-respawn-test-owner',
      } as never,
      ctx,
    );

    expect(spawnedCommand()).toContain('--owner-id=su-respawn-test-owner');
  });

  it('refuses a launch with nothing to do (it would just sit idle)', async () => {
    const res = await launchAgent.handler({}, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/a `brief`.*or a `plan`/s);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('refuses a no-brief resume before resolving the target or opening a terminal', async () => {
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' } }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('requires a non-empty `brief`');
    expect(textOf(res)).toContain('actionable next turn');
    expect(resolveResumeTargetMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('launches N agents on one brief', async () => {
    await launchAgent.handler({ brief: 'triage the backlog', count: 3 }, ctx);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(3);
  });

  it('wires the flat persona role into a fresh launch command', async () => {
    await launchAgent.handler({ brief: 'run as reviewer', role: 'reviewer' }, ctx);

    expect(spawnedCommand()).toContain('--role=reviewer');
  });

  it('propagates flat carry to an existing-fleet plan launch with per-member precedence', async () => {
    const res = await launchAgent.handler(
      {
        fleet: 'existing-fleet',
        plan: 'existing-plan',
        carry: 'cold',
        count: 2,
        members: [{ carry: 'warm' }],
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    const commands = spawnConsoleMock.mock.calls.map(
      ([opts]) => (opts as { envelope: { greetingCmd: string } }).envelope.greetingCmd,
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('--fleet=existing-fleet');
    expect(commands[0]).toContain('--plan=existing-plan');
    expect(commands[0]).toContain('--carry=warm');
    expect(commands[1]).toContain('--fleet=existing-fleet');
    expect(commands[1]).toContain('--plan=existing-plan');
    expect(commands[1]).toContain('--carry=cold');
  });

  it('lets a per-member role override the flat persona role', async () => {
    await launchAgent.handler(
      {
        brief: 'run the role-specific work',
        role: 'reviewer',
        count: 2,
        members: [{ role: 'architect' }],
      },
      ctx,
    );

    const commands = spawnConsoleMock.mock.calls.map(
      ([opts]) => (opts as { envelope: { greetingCmd: string } }).envelope.greetingCmd,
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('--role=architect');
    expect(commands[1]).toContain('--role=reviewer');
  });

  it('rejects an unknown per-member persona before claiming or opening any terminal', async () => {
    assembleRolePromptMock.mockImplementationOnce(() => {
      throw new Error(
        'assembleRolePrompt: no prompt file found for role "closure-auditor" (phase=staging, dept=none, blueprintId=none)',
      );
    });

    const res = await launchAgent.handler(
      {
        brief: 'finish the certification lane',
        count: 2,
        members: [{ role: 'closure-auditor' }, { role: 'su' }],
        idempotencyKey: 'invalid-role-batch',
      },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Invalid persona role `closure-auditor`');
    expect(textOf(res)).toContain('Put lane/job names in `brief` or `label`');
    expect(textOf(res)).toContain('NO agents were spawned and NO terminals were opened');
    expect(claimAgentLaunchMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('binds a plan (and its harness) when asked', async () => {
    await launchAgent.handler({ plan: 'my-plan' }, ctx);
    expect(spawnedCommand()).toContain('--harness=papercusp --plan=my-plan');
  });

  it('propagates the caller DRAIN overlay to a fresh launch', async () => {
    getModesMock.mockResolvedValue([{ mode: 'drain', subject: 'bug-drain', ownerDirected: true }]);
    listFactsMock.mockResolvedValue([{ key: 'mode-instructions:drain', body: 'Do not file incidental defects.' }]);

    await launchAgent.handler({ brief: 'drain the admitted bugs' }, ctx);

    expect(spawnedCommand()).toContain('--mode=drain');
    expect(spawnedCommand()).toContain('--mode-subject=bug-drain');
    expect(spawnedCommand()).toContain("--mode-instructions='Do not file incidental defects.'");
    expect(spawnedCommand()).toContain('--mode-owner-directed');
  });

  it('allows an operator-scope caller to bind an explicit harness (WI-3329)', async () => {
    const operatorCtx = { workspaceId: 'ws-test', harnessSlug: '*', role: 'su' } as never;
    await launchAgent.handler({ brief: 'run the disposable harness check', harness: 'papercusp' }, operatorCtx);
    expect(spawnedCommand()).toContain('--harness=papercusp');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toBe('run the disposable harness check');
  });

  it('refuses a fresh Codex launch before opening terminals when the backend rejects its model', async () => {
    codexPreflightHomeMock.mockResolvedValue('/tmp/codex');
    codexPreflightModelMock.mockResolvedValue({
      verdict: 'refused',
      status: 400,
      detail: `{"detail":"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."}`,
    });

    const res = await launchAgent.handler({ agent: 'codex', model: 'gpt-5.6:xhigh', brief: 'run the check' }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('NO terminals were opened');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(codexPreflightModelMock).toHaveBeenCalledWith('/tmp/codex', 'gpt-5.6');
  });

  it('does not consume an idempotency key on model refusal, so a corrected retry can launch', async () => {
    codexPreflightHomeMock.mockResolvedValue('/tmp/codex');
    codexPreflightModelMock
      .mockResolvedValueOnce({
        verdict: 'refused',
        status: 400,
        detail: `{"detail":"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."}`,
      })
      .mockResolvedValueOnce({ verdict: 'ok', status: 200, detail: 'supported' });

    const first = await launchAgent.handler(
      {
        agent: 'codex',
        model: 'gpt-5.6:xhigh',
        brief: 'run the check',
        idempotencyKey: 'wi-42381-independent-grade-v1',
      },
      ctx,
    );

    expect(isError(first)).toBe(true);
    expect(claimAgentLaunchMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();

    const corrected = await launchAgent.handler(
      {
        agent: 'codex',
        model: 'gpt-5.6-sol:high',
        brief: 'run the check',
        idempotencyKey: 'wi-42381-independent-grade-v1',
      },
      ctx,
    );

    expect(isError(corrected)).toBe(false);
    expect(claimAgentLaunchMock).toHaveBeenCalledTimes(1);
    expect(claimAgentLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'wi-42381-independent-grade-v1' }),
    );
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds with a warning when Codex model preflight is inconclusive', async () => {
    codexPreflightHomeMock.mockResolvedValue('/tmp/codex');
    codexPreflightModelMock.mockResolvedValue({ verdict: 'unknown', status: 429, detail: 'rate limited' });

    const res = await launchAgent.handler({ agent: 'codex', model: 'gpt-5.6:xhigh', brief: 'run the check' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(textOf(res)).toContain('proceeding fail-open');
  });

  it('uses a ChatGPT-compatible family-suffixed model when a fresh Codex launch omits one', async () => {
    codexPreflightHomeMock.mockResolvedValue('/tmp/codex');
    codexPreflightModelMock.mockResolvedValue({ verdict: 'ok', status: 200, detail: 'supported' });

    const res = await launchAgent.handler({ agent: 'codex', brief: 'run the check' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).toContain('--agent=codex');
    expect(spawnedCommand()).toContain('--model=gpt-5.6-sol');
    expect(codexPreflightModelMock).toHaveBeenCalledWith('/tmp/codex', 'gpt-5.6-sol');
  });
});

describe('fleet composition (D-003: fleet is an ARG, not a separate tool)', () => {
  it('creates a fresh explicit fleet before reading its scheme or launch profile', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { fleetSlug: 'fresh-fleet', leaderOwnerId: 'su-caller' },
      created: true,
    });

    await launchAgent.handler({ brief: 'start the fresh fleet', fleet: 'fresh fleet' }, ctx);

    expect(createFleetIfAbsentMock).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'fresh-fleet',
      title: 'fresh fleet',
      owner: 'su-caller',
      leaderOwnerId: 'su-caller',
    });
    const createOrder = createFleetIfAbsentMock.mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(getFleetSchemeMock.mock.invocationCallOrder[0]!);
    expect(createOrder).toBeLessThan(getFleetHeadcountTargetMock.mock.invocationCallOrder[0]!);
    expect(spawnedCommand()).toContain('--fleet=fresh-fleet');
  });

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

  it('keeps an independent fresh launch out of the caller presence fleet', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['su-caller', { fleetSlug: 'alpha-fleet', fleetRole: 'leader' }]]),
    );

    const res = await launchAgent.handler({ brief: 'grade independently', independent: true }, ctx);

    expect(fetchPresenceFleetMock).not.toHaveBeenCalled();
    expect(spawnedCommand()).not.toContain('--fleet=alpha-fleet');
    expect(dataOf(res)?.launch).toMatchObject({ fleet: null, independent: true });
    expect(textOf(res)).toContain('(no fleet)');
  });

  it('lets an explicit fleet win over independent fresh-launch mode', async () => {
    const res = await launchAgent.handler(
      { brief: 'independent work in the named fleet', independent: true, fleet: 'alpha fleet' },
      ctx,
    );

    expect(spawnedCommand()).toContain('--fleet=alpha-fleet');
    expect(dataOf(res)?.launch).toMatchObject({ fleet: 'alpha-fleet', independent: true });
  });

  it('launches unfleeted when the caller has no fleet (a non-leader can still launch)', async () => {
    await launchAgent.handler({ brief: 'solo task' }, ctx);
    expect(spawnedCommand()).not.toContain('--fleet=');
  });

  it('respawns with the fleet headcount profile instead of reconstructing launch knobs (D-008)', async () => {
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'alpha-fleet',
      target: 30,
      config: {
        plan: 'drain',
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'max',
        account: 'default',
        headless: true,
        carry: 'warm',
        contextSize: 'trimmed',
        compactionLimit: 825_000,
        role: 'su',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler({ brief: 'replace the dead lane', fleet: 'alpha fleet' }, ctx);

    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--fleet=alpha-fleet');
    expect(command).toContain('--agent=codex');
    expect(command).toContain('--model=gpt-5.6-luna:max');
    expect(command).toContain('--account=default');
    expect(command).toContain('--context-size=trimmed');
    expect(command).toContain('--compaction-limit=825000');
    expect(command).toContain('--headless');
    expect(dataOf(res)?.launch).toMatchObject({
      fleet: 'alpha-fleet',
      headcountProfile: { applied: true, target: 30 },
    });
  });
});

describe('headless composition (D-003: an ARG, not a separate tool)', () => {
  it('routes to the headless spawner with --headless (so the pty — and wakes — survive)', async () => {
    const res = await launchAgent.handler({ brief: 'long soak', headless: true }, ctx);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--headless');
    expect(spawnHeadlessMock.mock.calls[0][0]).toMatchObject({
      writeMcpJson: true,
      logDir: '/tmp/papercusp-ws/fleet-logs',
      launchedBy: 'su-caller',
      fleetSlug: null,
      kickoffProof: true,
    });
    expect(dataOf(res)?.launch).toMatchObject({
      deduped: false,
      opened: 1,
      failed: 0,
      tasks: [{
        taskId: 'task777',
        logPath: '/tmp/papercusp-ws/fleet-logs/judge.log',
        normalizedLogPath: '/tmp/papercusp-ws/fleet-logs/judge.normalized.log',
        pid: 777,
        headless: true,
      }],
    });
    expect(textOf(res)).toContain('grep-safe log: /tmp/papercusp-ws/fleet-logs/judge.normalized.log');
    expect(textOf(res)).toContain('EI-9748');
  });

  it.each([
    ['missing', null, 'kickoff-proof-missing'],
    [
      'negative',
      { persisted: false, nativeRef: null, reason: 'native-turn-marker-timeout' },
      'native-turn-marker-timeout',
    ],
  ])('fails closed on a %s native kickoff proof before reporting a headless launch', async (_label, proof, reason) => {
    spawnHeadlessMock.mockResolvedValueOnce(headlessSpawnResult(undefined, proof));

    const res = await launchAgent.handler({ brief: 'grade the item independently', headless: true }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain(reason);
    expect(textOf(res)).toContain('Refusing launch success before the first turn');
    expect(verifyFreshLaunchStartedMock).not.toHaveBeenCalled();
    expect(dataOf(res)?.launch).toMatchObject({ opened: 0, failed: 1 });
  });
});

describe('headless in-place resume verification', () => {
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

  const resumeHeadless = (childExit: Promise<SpawnChildExit>) => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    spawnHeadlessMock.mockResolvedValueOnce(headlessSpawnResult(childExit));
    return launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, headless: true, brief: 'continue the recovery' },
      ctx,
    );
  };

  it('classifies a nonzero persistent child exit as an observed resume failure', async () => {
    const res = await resumeHeadless(Promise.resolve({ code: 1, signal: null }));

    expect(verifyResumeStartedMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ expectedSessionId: 'sid-dead' }),
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('HEADLESS RESUME TURN FAILED');
    expect(textOf(res)).toContain('agent_crash');
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerified: false,
      resumeVerification: {
        expectedSessionId: 'sid-dead',
        actualSessionId: null,
        mismatch: false,
        bootLogTail: null,
      },
    });
  });

  it('classifies an HTTP 400 in the bounded headless log and preserves its evidence', async () => {
    mkdirSync('/tmp/papercusp-ws/fleet-logs', { recursive: true });
    writeFileSync(HEADLESS_RESUME_LOG_PATH, 'resume failed: HTTP 400 Bad Request from provider\n');

    const res = await resumeHeadless(Promise.resolve({ code: 1, signal: null }));

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('HEADLESS RESUME TURN FAILED');
    expect(textOf(res)).toContain('HTTP 400 Bad Request');
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerified: false,
      resumeVerification: {
        bootLogTail: 'resume failed: HTTP 400 Bad Request from provider\n',
      },
    });
  });

  it('keeps a clean child exit unconfirmed instead of reporting a false failure', async () => {
    const res = await resumeHeadless(Promise.resolve({ code: 0, signal: null }));

    expect(isError(res)).toBe(false);
    expect(textOf(res)).toContain('HEADLESS RESUME UNCONFIRMED');
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerified: null,
      resumeVerification: { expectedSessionId: 'sid-dead', bootLogTail: null },
    });
  });

  it('keeps a verifier deadline unconfirmed when the headless child has not exited', async () => {
    verifyResumeStartedMock.mockResolvedValueOnce({
      started: null,
      waitedMs: 30_000,
      expectedSessionId: 'sid-dead',
      actualSessionId: null,
      mismatch: false,
    });

    const res = await resumeHeadless(new Promise<SpawnChildExit>(() => {}));

    expect(isError(res)).toBe(false);
    expect(textOf(res)).toContain('RESUME UNCONFIRMED');
    expect(dataOf(res)?.launch).toMatchObject({ resumeVerified: null });
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
    endedBy: 'self' as const,
    live: false,
    advSessionId: 11,
    binding: {
      coordOwnerId: 'su-a1a71',
      sessionId: 'sid-dead',
      startedAt: '2026-07-11 09:00:00.123456+00',
    },
  };

  it('starts an identity-preserving fresh successor for an ended critical source', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    fetchContextPressureMock.mockResolvedValue(new Map([['su-a1a71', 'critical']]));
    buildCarryBriefMock.mockResolvedValue({ ownerId: 'su-a1a71' });
    renderCarryBriefTextMock.mockReturnValue('checkpoint: finish the successor wiring');
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-successor-1', successfulCalls: 1 }],
      note: 'successor verified',
    });

    const res = await launchAgent.handler(
      {
        successor: { agentId: 'su-a1a71' },
        brief: 'continue the recovery',
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(spawnedCommand()).toContain('--agent=claude --owner-id=su-a1a71 --harness=papercusp');
    expect(spawnedCommand()).not.toContain('--resume=');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('continue the recovery');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('checkpoint: finish the successor wiring');
    expect(buildCarryBriefMock).toHaveBeenCalledWith('su-a1a71', { workspaceId: 'ws-test' });
    expect(verifyFreshLaunchStartedMock).toHaveBeenCalledWith(
      expect.objectContaining({ expected: 1, expectedOwnerIds: ['su-a1a71'] }),
    );
    expect(dataOf(res)?.launch).toMatchObject({
      mode: 'successor',
      resumedOwnerId: 'su-a1a71',
      agentStarted: true,
      freshVerdict: {
        agentStarted: true,
        sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-successor-1' }],
      },
    });
    expect(textOf(res)).toContain("agent's first turn");
  });

  it('promotes a dormant critical resume to an identity-preserving fresh successor', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    fetchContextPressureMock.mockResolvedValue(new Map([['su-a1a71', 'critical']]));
    renderCarryBriefTextMock.mockReturnValue('checkpoint: recover the held claim');
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-auto-successor-1', successfulCalls: 1 }],
      note: 'automatic successor verified',
    });

    const res = await launchAgent.handler(
      {
        resume: { agentId: 'su-a1a71' },
        brief: 'continue the recovery',
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(spawnedCommand()).toContain('--agent=claude --owner-id=su-a1a71 --harness=papercusp');
    expect(spawnedCommand()).not.toContain('--resume=');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('continue the recovery');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('checkpoint: recover the held claim');
    expect(buildCarryBriefMock).toHaveBeenCalledWith('su-a1a71', { workspaceId: 'ws-test' });
    expect(verifyFreshLaunchStartedMock).toHaveBeenCalledWith(
      expect.objectContaining({ expected: 1, expectedOwnerIds: ['su-a1a71'] }),
    );
    expect(dataOf(res)?.launch).toMatchObject({
      mode: 'successor',
      resumedOwnerId: 'su-a1a71',
      agentStarted: true,
      freshVerdict: {
        agentStarted: true,
        sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-auto-successor-1' }],
      },
    });
    expect(textOf(res)).toContain('DORMANT at CRITICAL context pressure');
  });

  describe('successor predecessor reconciliation (EI-22446987530949437)', () => {
    const stale = { ...dead, endedAt: null, endedBy: null };
    const request = { successor: { agentId: dead.ownerId }, idempotencyKey: 'successor-cas' };

    beforeEach(() => {
      resolveResumeTargetMock.mockReset();
      resolveResumeTargetMock.mockResolvedValue(stale);
      findLiveHostMock.mockReset();
      findLiveHostMock.mockReturnValue(null);
    });

    it.each(['ended', 'suspect'])('reconciles a stale open binding with %s evidence before spawn', async (sessionState) => {
      resolveSessionStatesMock.mockResolvedValue(new Map([[dead.ownerId, { sessionState }]]));
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(false);
      expect(resolveSessionStatesMock).toHaveBeenCalledWith([{ ownerId: dead.ownerId }], { hydratePerId: true });
      expect(markAdvSessionEndedMock).toHaveBeenCalledWith(11, null, 'reconciler', {
        expectedBinding: dead.binding,
        throwOnError: true,
      });
      expect(claimAgentLaunchMock.mock.invocationCallOrder[0]).toBeLessThan(markAdvSessionEndedMock.mock.invocationCallOrder[0]);
      expect(markAdvSessionEndedMock.mock.invocationCallOrder[0]).toBeLessThan(spawnConsoleMock.mock.invocationCallOrder[0]);
      expect(spawnedCommand()).toContain('--owner-id=su-a1a71');
      expect(textOf(res)).toContain('actual exit time remains unknown');
    });

    it.each(['live', 'parked', 'recorded', 'draining', 'unknown', undefined])('refuses %s evidence without ending or spawning', async (sessionState) => {
      resolveSessionStatesMock.mockResolvedValue(new Map([[dead.ownerId, { sessionState }]]));
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('positive terminal evidence is required');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({ workspaceId: 'ws-test', idempotencyKey: 'successor-cas' });
    });

    it.each([
      { advSessionId: 12 },
      { binding: { ...dead.binding, coordOwnerId: 'su-other' } },
      { binding: { ...dead.binding, sessionId: 'sid-successor' } },
      { binding: { ...dead.binding, startedAt: '2026-07-11 09:00:00.123457+00' } },
    ])('refuses a changed persisted incarnation (%j)', async (change) => {
      resolveResumeTargetMock.mockResolvedValueOnce(stale).mockResolvedValueOnce({ ...stale, ...change });
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('predecessor binding changed');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('refuses a live host appearing after the terminal verdict', async () => {
      findLiveHostMock.mockReturnValueOnce(null).mockReturnValue({ pid: 42 });
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('LIVE source host appeared');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('refuses a concurrent binding update that wins the lifecycle CAS', async () => {
      markAdvSessionEndedMock.mockResolvedValue(false);
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('lost its compare-and-swap');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('refuses missing incarnation evidence without changing any row', async () => {
      resolveResumeTargetMock.mockResolvedValue({ ...stale, binding: null });
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('exact predecessor binding is unavailable');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('finishes a half-written terminal marker before bootstrap can see an open binding', async () => {
      resolveResumeTargetMock.mockResolvedValue({ ...stale, endedBy: 'reconciler' });
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(false);
      expect(resolveSessionStatesMock).not.toHaveBeenCalled();
      expect(markAdvSessionEndedMock).toHaveBeenCalledWith(11, null, 'reconciler', {
        expectedBinding: dead.binding,
        throwOnError: true,
      });
      expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    });

    it.each(['oracle', 'writer'])('keeps a failed %s read/write fail-closed', async (seam) => {
      (seam === 'oracle' ? resolveSessionStatesMock : markAdvSessionEndedMock).mockRejectedValueOnce(new Error('database unavailable'));
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('reconciliation failed');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(releaseAgentLaunchClaimMock).toHaveBeenCalled();
    });

    it('does not reconcile an idempotency replay', async () => {
      claimAgentLaunchMock.mockResolvedValueOnce({ won: false, priorSummary: { opened: 1 }, priorLaunchedAt: 1, priorLaunchedBy: 'su-caller' });
      const res = await launchAgent.handler(request, ctx);
      expect(dataOf(res)?.deduped).toBe(true);
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(resolveSessionStatesMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });
  });

  it('refuses an identity-preserving successor when the source is still live', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });

    const res = await launchAgent.handler({ successor: { agentId: 'su-a1a71' } }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('source session is still LIVE');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(buildCarryBriefMock).not.toHaveBeenCalled();
  });

  it("EI-11578: a RESUME forces a process-per-window emulator (preferProcessPerWindow) — a resumed dormant session dies under gnome-terminal's VTE pty", async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({ preferProcessPerWindow: true });
  });

  it('EI-21010422711013687: a FRESH launch also forces process-per-window so gnome-terminal cannot drop the psu command', async () => {
    await launchAgent.handler({ brief: 'fresh work' }, ctx);
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({
      preferProcessPerWindow: true,
      verifyBootReceipt: true,
    });
  });

  it('resumes a dead agent BY AGENT ID — no uuid hunting', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(resolveResumeTargetMock).toHaveBeenCalledWith({ agentId: 'su-a1a71', sessionId: null });
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(textOf(res)).toContain('re-attaches its ORIGINAL identity su-a1a71');
  });

  it('resumes a tracked Codex row without native session_id by adv-session selector', async () => {
    const trackedCodex = {
      ...dead,
      agent: 'codex',
      sessionId: null,
      resumeId: '22661',
      advSessionId: 22661,
    };
    resolveResumeTargetMock.mockResolvedValue(trackedCodex);
    verifyResumeStartedMock.mockResolvedValue({
      started: true,
      waitedMs: 5,
      expectedSessionId: null,
      actualSessionId: null,
      mismatch: false,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'continue the Codex recovery' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).toContain('--resume=22661');
    expect(verifyResumeStartedMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ expectedSessionId: null }),
    );
    expect(textOf(res)).toContain('re-attaches its ORIGINAL identity su-a1a71');
  });

  it('EI-21725123573114023: refuses an in-place resume whose target records no coord owner id, instead of reporting an unverifiable "Launched"', async () => {
    // Both downstream rails are keyed on the owner id, so without it the verifier
    // is skipped AND `live` is forced false — the tool used to spawn and report
    // success having checked nothing.
    resolveResumeTargetMock.mockResolvedValue({ ...dead, ownerId: null });

    const res = await launchAgent.handler({ resume: { sessionId: 'sid-dead' }, brief: 'continue the recovery' }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('records no coord owner id');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(verifyResumeStartedMock).not.toHaveBeenCalled();
  });

  it('EI-21725123573114023: a FRESH launch whose verifier could not run for want of a caller id says so, instead of reporting a bare "Launched"', async () => {
    callerIdentity.current.ownerId = null;

    const res = await launchAgent.handler({ brief: 'fresh work' }, ctx);

    expect(spawnConsoleMock).toHaveBeenCalled();
    expect(verifyFreshLaunchStartedMock).not.toHaveBeenCalled();
    expect(textOf(res)).toContain('launch verification DID NOT RUN');
  });

  it('EI-21725123573114023: an attributed fresh launch still runs the verifier and reports its verdict — the skip note is not blanket', async () => {
    const res = await launchAgent.handler({ brief: 'fresh work' }, ctx);

    expect(verifyFreshLaunchStartedMock).toHaveBeenCalled();
    expect(textOf(res)).toContain('test launch verification stub');
    expect(textOf(res)).not.toContain('launch verification DID NOT RUN');
  });

  it('EI-21725123573114023: the owner-id guard is scoped to in-place resumes — an EXPLICIT fork of the same target still launches', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, ownerId: null });

    const res = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, fork: true, brief: 'branch off the recovery' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalled();
    expect(spawnedCommand()).toContain('--fork');
  });

  it("preserves the resumed target's durable fleet instead of inheriting the caller's fleet", async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['su-caller', { fleetSlug: 'caller-fleet', fleetRole: 'leader' }]]),
    );

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(latestFleetMembershipMock).toHaveBeenCalledWith('ws-test', 'su-a1a71');
    expect(fetchPresenceFleetMock).not.toHaveBeenCalled();
    expect(spawnedCommand()).toContain('--fleet=target-fleet');
    expect(spawnedCommand()).not.toContain('--fleet=caller-fleet');
    expect(dataOf(res)?.launch).toMatchObject({ fleet: 'target-fleet', resumedOwnerId: 'su-a1a71' });
  });

  it('preserves resumed target membership when independent is supplied', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['su-caller', { fleetSlug: 'caller-fleet', fleetRole: 'leader' }]]),
    );

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, independent: true, brief: 'continue independently' },
      ctx,
    );

    expect(latestFleetMembershipMock).toHaveBeenCalledWith('ws-test', 'su-a1a71');
    expect(fetchPresenceFleetMock).not.toHaveBeenCalled();
    expect(spawnedCommand()).toContain('--fleet=target-fleet');
    expect(spawnedCommand()).not.toContain('--fleet=caller-fleet');
    expect(dataOf(res)?.launch).toMatchObject({ fleet: 'target-fleet', independent: true, mode: 'resume' });
  });

  it('reuses the canonical fleet profile on resume and corrects an ended visible member back to saved headless placement', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'target-fleet',
      target: 12,
      config: {
        plan: 'recovery-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        effort: 'high',
        account: 'default',
        headless: true,
        carry: 'warm',
        extraArgs: ['--context-size=trimmed'],
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--resume=sid-dead');
    expect(command).toContain('--fleet=target-fleet');
    expect(command).toContain('--model=sonnet:high');
    expect(command).toContain('--account=default');
    expect(command).toContain('--context-size=trimmed');
    expect(command).toContain('--carry=warm');
    expect(command).toContain('--headless');
    expect(dataOf(res)?.launch).toMatchObject({
      mode: 'resume',
      fleet: 'target-fleet',
      headcountProfile: {
        applied: true,
        target: 12,
        provenance: { source: 'fleet:headcount-target', fleetSlug: 'target-fleet' },
        reusePath: 'capability:launch-agent resume/successor -> agent-launch-core.buildAgentLaunchCommand',
      },
    });
  });

  it('treats mode-only extraArgs as launch posture while preserving the canonical profile on resume', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'target-fleet',
      target: 12,
      config: {
        plan: 'recovery-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        effort: 'high',
        account: 'default',
        headless: true,
        carry: 'warm',
        extraArgs: ['--context-size=trimmed'],
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, extraArgs: ['--auto'], brief: 'continue the recovery' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--context-size=trimmed');
    expect(command).toContain('--auto');
    expect(textOf(res)).toContain('Applied canonical saved fleet launch spec');
  });

  it("preserves a same-owner resume's target loop carry over a stale saved fleet carry", async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    getLoopStatusMock.mockResolvedValue({ ownerId: 'su-a1a71', carry: 'cold' });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'target-fleet',
      target: 12,
      config: {
        plan: 'recovery-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        effort: 'high',
        account: 'default',
        headless: true,
        carry: 'warm',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(isError(res)).toBe(false);
    expect(getLoopStatusMock).toHaveBeenCalledWith('su-a1a71');
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--carry=cold');
    expect(spawnedCommand(spawnHeadlessMock)).not.toContain('--carry=warm');
    expect(textOf(res)).toContain("Applied target loop carry 'cold'");
  });

  it('fails closed before resume when a caller conflicts with the canonical saved placement', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'target-fleet',
      target: 12,
      config: {
        plan: 'recovery-plan',
        harness: 'papercusp',
        agent: 'claude',
        account: 'default',
        headless: true,
        carry: 'warm',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, headless: false, brief: 'continue with the saved placement' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Saved launch spec conflict');
    expect(textOf(res)).toContain('"field":"headless"');
    expect(textOf(res)).toContain('capability:launch-agent resume/successor');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('propagates the caller DRAIN overlay to a resume/fork command', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    getModesMock.mockResolvedValue([{ mode: 'drain', subject: 'bug-drain', ownerDirected: true }]);
    listFactsMock.mockResolvedValue([{ key: 'mode-instructions:drain', body: 'Checkpoint incidental defects.' }]);

    await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, fork: true, brief: 'continue the recovery' }, ctx);

    expect(spawnedCommand()).toContain('--mode=drain');
    expect(spawnedCommand()).toContain('--mode-subject=bug-drain');
    expect(spawnedCommand()).toContain("--mode-instructions='Checkpoint incidental defects.'");
    expect(spawnedCommand()).toContain('--mode-owner-directed');
  });

  it("delivers a brief with a resume as the session's NEXT turn (via the pty inject)", async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'the plan changed' }, ctx);
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toBe('the plan changed');
    expect(textOf(res)).toContain('managed pty');
  });

  it('recovers a stale agent-launched headless host before exact-resume instead of forking it', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    findLiveHostMock.mockReturnValue({
      ownerId: 'su-a1a71',
      pid: 42,
      sock: '/run/host.sock',
      bridgeTty: false,
      launchedBy: 'su-caller',
      lastActivityAt: Date.now() - 31 * 60_000,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, headless: true, brief: 'continue the recovery' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(shutdownViaPtyMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ force: true, reason: expect.stringContaining('stale-headless') }),
    );
    expect(waitForPtyHostGoneMock).toHaveBeenCalledWith('su-a1a71');
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--resume=sid-dead');
    expect(spawnedCommand(spawnHeadlessMock)).not.toContain('--fork');
    expect(textOf(res)).toContain('Guarded stale-headless recovery');
  });

  it('FORKS a still-LIVE source instead of colliding on its transcript (D-007)', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    findLiveHostMock.mockReturnValue({
      ownerId: 'su-a1a71',
      pid: 42,
      sock: '/run/host.sock',
      bridgeTty: false,
      launchedBy: 'su-caller',
      lastActivityAt: Date.now() - 5 * 60_000,
    });
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(spawnedCommand()).toContain('--resume=sid-dead --fork');
    expect(textOf(res)).toContain('still LIVE');
    expect(textOf(res)).toContain('FRESH identity');
  });

  it('forks explicitly when asked, even from a dead source', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, fork: true, brief: 'branch the recovery' },
      ctx,
    );
    expect(spawnedCommand()).toContain('--fork');
  });

  it('falls through to an ordinary exact resume when restoreVisible is requested after the host already ended', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(waitForPtyHostGoneMock).not.toHaveBeenCalled();
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(textOf(res)).toContain('ordinary exact resume');
  });

  it('refuses guarded restoration when the exact live session still has a desktop window', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    windowScopeVerdictMock.mockReturnValue('alive');

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('verdict for su-a1a71 is alive');
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'not-a-window'] as const)('fails closed on a %s desktop-window verdict', async (verdict) => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    windowScopeVerdictMock.mockReturnValue(verdict);

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain(`is ${verdict}`);
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    if (verdict === 'not-a-window') {
      expect(textOf(res)).toContain('omit `restoreVisible`');
      expect(textOf(res)).toContain('ordinary exact resume');
    }
  });

  it('gracefully closes only a proven-windowless host, waits for it, then exact-resumes visibly', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(shutdownViaPtyMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ force: true, reason: expect.stringContaining('sid-dead') }),
    );
    expect(waitForPtyHostGoneMock).toHaveBeenCalledWith('su-a1a71');
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(textOf(res)).toContain('Guarded restore');
    expect(verifyResumeStartedMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ expectedSessionId: 'sid-dead' }),
    );
  });

  it('does not launch a replacement when the proven-windowless host refuses shutdown', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    shutdownViaPtyMock.mockResolvedValue('refused-human-attended');

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('refused-human-attended');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('refuses a resume/fork whose source is at critical context pressure', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    fetchContextPressureMock.mockResolvedValue(new Map([['su-a1a71', 'critical']]));

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'take the routed consult' }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('current context is CRITICAL');
    expect(textOf(res)).toContain('launch a FRESH agent with a context-seeded brief');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('verifies a fork by real first-turn activity and fails an observed silent fork', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: false,
      waitedMs: 25_000,
      sessions: [],
      note: '✗ AGENT DID NOT START — fork registered but never took a real turn.',
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, fork: true, brief: 'take the routed consult' },
      ctx,
    );

    expect(verifyFreshLaunchStartedMock).toHaveBeenCalledWith(
      expect.objectContaining({ launcherOwnerId: 'su-caller', expected: 1 }),
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('AGENT DID NOT START');
    expect(textOf(res)).toContain('Delivery alone is not proof the turn began');
  });

  it('surfaces an unresolvable target instead of launching something wrong', async () => {
    resolveResumeTargetMock.mockResolvedValue({
      ok: false,
      error: 'not_found',
      detail: 'no adv_sessions row for agent su-nope',
    });
    const res = await launchAgent.handler({ resume: { agentId: 'su-nope' }, brief: 'continue the missing session' }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('no adv_sessions row');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('records an unconfirmed verdict without inventing failure when the resume host is delayed', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    verifyResumeStartedMock.mockResolvedValue({
      started: null,
      waitedMs: 30_000,
      expectedSessionId: 'sid-dead',
      actualSessionId: null,
      mismatch: false,
    });

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the delayed recovery' }, ctx);

    expect(isError(res)).toBe(false);
    expect(textOf(res)).toContain('RESUME UNCONFIRMED');
    expect(textOf(res)).toContain('absence of evidence, not an observed no-op');
    expect(textOf(res)).toContain('Do NOT launch a fallback on this note alone');
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({ mode: 'resume', resumeVerified: null }),
      }),
    );
  });

  it('includes the bounded per-owner psu boot-log tail when a resume is unconfirmed', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    verifyResumeStartedMock.mockResolvedValue({
      started: null,
      waitedMs: 30_000,
      expectedSessionId: 'sid-dead',
      actualSessionId: null,
      mismatch: false,
    });
    readPsuLaunchLogTailMock.mockReturnValue('psu: resume transcript was not found');

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the logged recovery' }, ctx);

    expect(readPsuLaunchLogTailMock).toHaveBeenCalledWith('su-a1a71', { chars: PSU_LAUNCH_LOG_TAIL_CHARS });
    expect(textOf(res)).toContain('Per-owner psu boot log tail');
    expect(textOf(res)).toContain('psu: resume transcript was not found');
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerification: {
        bootLogTail: 'psu: resume transcript was not found',
      },
    });
  });

  it('rolls back a newly launched resume whose backend UUID differs from the exact request', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, sessionId: 'later-rollout-uuid' });
    verifyResumeStartedMock.mockResolvedValue({
      started: false,
      waitedMs: 10,
      expectedSessionId: 'later-rollout-uuid',
      actualSessionId: 'older-root-uuid',
      mismatch: true,
    });

    const res = await launchAgent.handler(
      { resume: { sessionId: 'later-rollout-uuid' }, brief: 'continue the exact recovery' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('RESUME UUID MISMATCH');
    expect(textOf(res)).toContain('requested later-rollout-uuid');
    expect(textOf(res)).toContain('actually resumed older-root-uuid');
    expect(shutdownViaPtyMock).toHaveBeenCalledWith('su-a1a71', expect.objectContaining({ force: true }));
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerified: false,
      resumeVerification: {
        expectedSessionId: 'later-rollout-uuid',
        actualSessionId: 'older-root-uuid',
        mismatch: true,
        rollback: 'sent',
      },
    });
  });

  it('refuses to resume one session N times (fork is the run-alongside path)', async () => {
    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery', count: 3 },
      ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/cannot be resumed more than once/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('allows fork × count (branch N agents off one context)', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, fork: true, brief: 'branch the recovery', count: 2 },
      ctx,
    );
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
  });

  it('rejects fork with no source to fork FROM', async () => {
    const res = await launchAgent.handler({ brief: 'x', fork: true }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('needs a source session');
  });

  it('rejects plan + resume (a resumed session keeps its own context)', async () => {
    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'new direction', plan: 'p' } as never,
      ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('`plan` is for a FRESH launch');
  });
});

describe('idempotency (P-014: a replay must not open a second set of windows)', () => {
  it('spawns nothing and reports the ORIGINAL launch when the key was already claimed', async () => {
    claimAgentLaunchMock.mockResolvedValue({
      won: false,
      priorSummary: { opened: 2, mode: 'fresh', tasks: [{ taskId: 'task-original', logPath: '/tmp/original.log' }] },
      priorLaunchedAt: 1_760_000_000_000,
      priorLaunchedBy: 'su-caller',
    });
    const res = await launchAgent.handler({ brief: 'do it', count: 2, idempotencyKey: 'retry-1' }, ctx);

    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(textOf(res)).toContain('Already launched (deduped)');
    expect(textOf(res)).toContain('"opened":2');
    expect(dataOf(res)).toMatchObject({
      deduped: true,
      launch: { deduped: true, opened: 2, tasks: [{ taskId: 'task-original', logPath: '/tmp/original.log' }] },
    });
  });

  it('records what the winning launch did, so a later replay can report it', async () => {
    await launchAgent.handler({ brief: 'do it', idempotencyKey: 'retry-1' }, ctx);
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'retry-1',
        summary: expect.objectContaining({
          deduped: false,
          opened: 1,
          failed: 0,
          mode: 'fresh',
          tasks: [expect.objectContaining({ pid: 4242, headless: false })],
        }),
      }),
    );
  });
});

describe('failure reporting', () => {
  it('releases a claimed key after governed admission fails before any process opens, allowing the same-key retry', async () => {
    claimAgentLaunchMock
      .mockResolvedValueOnce({
        won: true,
        priorSummary: null,
        priorLaunchedAt: null,
        priorLaunchedBy: null,
      })
      .mockResolvedValueOnce({
        won: true,
        priorSummary: null,
        priorLaunchedAt: null,
        priorLaunchedBy: null,
      });
    spawnConsoleMock
      .mockResolvedValueOnce({
        status: 'error',
        code: 503,
        error: 'durable admission record could not be persisted',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        pid: 4242,
        terminal: 'xterm',
        child: {} as never,
        display: ':1',
        desktopEnvResolvedVia: 'active-seat',
      });

    const first = await launchAgent.handler(
      { brief: 'retryable launch', idempotencyKey: 'retry-after-admission-failure' },
      ctx,
    );
    expect(isError(first)).toBe(true);
    expect(textOf(first)).toContain('released idempotencyKey');
    expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      idempotencyKey: 'retry-after-admission-failure',
    });
    expect(recordAgentLaunchResultMock).not.toHaveBeenCalled();

    const retry = await launchAgent.handler(
      { brief: 'retryable launch', idempotencyKey: 'retry-after-admission-failure' },
      ctx,
    );
    expect(isError(retry)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
    expect(recordAgentLaunchResultMock).toHaveBeenCalledTimes(1);
  });

  it('releases a claimed key when governed admission rejects before the spawner is invoked', async () => {
    spawnGovernedAgentProcessMock.mockRejectedValueOnce(
      new Error('durable admission record could not be persisted'),
    );

    const res = await launchAgent.handler(
      { brief: 'retry after governed rejection', idempotencyKey: 'retry-after-governed-rejection' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      idempotencyKey: 'retry-after-governed-rejection',
    });
    expect(textOf(res)).toContain('governed spawn failed: durable admission record could not be persisted');
  });

  it('keeps the idempotency claim when a batch opens at least one process despite another failure', async () => {
    spawnConsoleMock
      .mockResolvedValueOnce({ status: 'error', code: 503, error: 'admission unavailable' })
      .mockResolvedValueOnce({
        status: 'ok',
        pid: 4242,
        terminal: 'xterm',
        child: {} as never,
        display: ':1',
        desktopEnvResolvedVia: 'active-seat',
      });

    const res = await launchAgent.handler(
      { brief: 'partial governed batch', count: 2, idempotencyKey: 'partial-governed-batch' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(releaseAgentLaunchClaimMock).not.toHaveBeenCalled();
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'partial-governed-batch',
        summary: expect.objectContaining({ opened: 1, failed: 1 }),
      }),
    );
  });

  it('reports a failed spawn as an error rather than a silent success', async () => {
    spawnConsoleMock.mockResolvedValue({
      status: 'error',
      code: 501,
      error: 'no desktop session',
    });
    const res = await launchAgent.handler({ brief: 'x' }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('launch failed (501): no desktop session');
  });
});
