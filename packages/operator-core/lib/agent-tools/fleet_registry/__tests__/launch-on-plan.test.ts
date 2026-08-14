/**
 * Unit tests for fleet:launch-on-plan (EI-5504). The handler spawns desktop
 * terminals (no pure unit surface), so we cover the pure command builder — the
 * load-bearing bit: every member command must carry `--no-picker` + `--plan`, the
 * exact pair that triggers the EI-5503 auto-kickoff so the member starts on boot.
 * Importing the module also validates its whole import chain compiles + loads (the
 * tool self-registers via defineTool on import).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpecPoolEffect, CollapseGuardVerdict } from '../../../scheduler/spec-pool-preview';

const spawnConsoleMock = vi.fn();
const fetchGatewayHeadroomMock = vi.fn();
const launchTransaction = vi.hoisted(() => ({
  verify: vi.fn(async (..._args: unknown[]) => ({
    agentStarted: true as boolean | null,
    waitedMs: 1,
    sessions: [],
    note: 'verified',
  })),
  persist: vi.fn(async (..._args: unknown[]) => null),
}));

vi.mock('../../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({ cwd: '/tmp/fleet', env: {} })),
}));

vi.mock('../../../console-spawn', () => ({
  spawnConsole: (...args: unknown[]) => spawnConsoleMock(...args),
}));

vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-1',
}));

// Keep the handler's launch-context compose-write out of the real ~/.papercusp
// during tests — point the workspace home at a throwaway tmp dir.
vi.mock('../../../papercusp-root', () => ({
  papercuspPathForWorkspace: () => '/tmp/fleet-launch-ctx-test',
}));

vi.mock('../../../agent-fleets-store', () => ({
  createFleetIfAbsent: vi.fn(async () => ({
    record: { leaderOwnerId: 'owner-1', colorScheme: { name: 'Ocean' } },
  })),
  fleetSlugFromName: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
  getFleetScheme: vi.fn(async () => ({ name: 'Ocean' })),
  // The P-005 idempotency guard (PG-backed, migration 484): default every handler test
  // to a WON slot; suppression semantics live in agent-fleets-store.integration.test.ts.
  claimFleetLaunchSlot: vi.fn(async () => ({ won: true, at: 1 })),
  releaseFleetLaunchSlot: vi.fn(async () => {}),
  setFleetLaunchTransaction: (...args: unknown[]) => launchTransaction.persist(...args),
}));

vi.mock('../../../agent-launch-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-launch-core')>()),
  verifyFreshLaunchStarted: (...args: unknown[]) => launchTransaction.verify(...args),
}));

vi.mock('../../../fleet/fleet-roster', () => ({
  // Live-member deficit guard seam: default to an empty fleet (every legacy handler test
  // launches into a fresh fleet); the deficit tests below override per-case.
  liveFleetMemberIds: vi.fn(async () => [] as string[]),
}));

vi.mock('../../coordination/presence', async (importOriginal) => ({
  // Spread the real module so PRESENCE_STALE_MS (consumed transitively via
  // presence-wakeability.ts) survives; override only the fns we stub.
  ...(await importOriginal<typeof import('../../coordination/presence')>()),
  heartbeatPresence: vi.fn(async () => undefined),
  setPresenceFleet: vi.fn(async () => undefined),
}));

// Contract-shaped on purpose. The real readPlanBySlug resolves
// `{ parsed, archived, row: PlanRow } | null` — `row` is NOT optional. The P-006
// start gate reads row.templateData / row.template / row.inputSchema, so a stub
// without `row` throws a TypeError; this stub predated the gate and did exactly
// that, failing 40 tests at once (EI-19310192267009629).
// template/inputSchema null => planSchemaSource 'none' => the start gate passes.
// Individual tests override with mockResolvedValueOnce.
const readPlanBySlugMock = vi.fn(async (..._args: unknown[]): Promise<any> => ({
  slug: 'my-plan',
  parsed: { items: [] },
  archived: false,
  row: { planSlug: 'my-plan', template: null, inputSchema: null, templateData: null },
}));

vi.mock('../../plans/source', () => ({
  resolveHarnessPlansDir: vi.fn(async (slug: string) => ({ harnessSlug: slug, workspaceId: 'ws-1' })),
  readPlanBySlug: (...args: unknown[]) => readPlanBySlugMock(...args),
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

const setClaimSpecMock = vi.fn();
vi.mock('../../../scheduler/claim-spec-store', () => ({
  setClaimSpec: (...args: unknown[]) => setClaimSpecMock(...args),
  fleetSpecBeeKey: (slug: string) => `fleet:${slug}`,
  resolveClaimSpecWorkspace: (ws: string | null | undefined) => (ws && ws !== '*' ? ws : undefined),
}));

// P-010: the WI-5212 pool-collapse guard the claimKinds launch path routes through. The
// COUNT (previewSpecPoolEffect) hits PG, so it is stubbed; the WIRING is what we test here
// (the real evaluateCollapseGuard thresholds have their own unit suite). Default: a healthy
// lane (matches part of a nonempty pool) that does NOT refuse.
const previewSpecPoolEffectMock = vi.fn(
  async (..._args: unknown[]): Promise<SpecPoolEffect> => ({
    matched: 5,
    pool: 10,
    states: ['open'],
    harness: 'papercusp',
  }),
);
const evaluateCollapseGuardMock = vi.fn(
  (..._args: unknown[]): CollapseGuardVerdict => ({ refuse: false, errors: [] }),
);
vi.mock('../../../scheduler/spec-pool-preview', () => ({
  previewSpecPoolEffect: (...args: unknown[]) => previewSpecPoolEffectMock(...args),
  evaluateCollapseGuard: (...args: unknown[]) => evaluateCollapseGuardMock(...args),
}));

// WI-6673: the DUAL of the collapse guard above — the lane's admitted COMPOSITION, which
// decides the degenerate-lane warning. Only this one export is overridden (the rest of
// get-next is spread through) because several live modules in this import graph pull other
// symbols from it. Default: a healthy lane, so the warning is silent unless a test opts in.
const HEALTHY_COMPOSITION = {
  total: 5,
  byKind: { bug: 5 },
  bySeverity: { major: 4, critical: 1 },
  lowSeverityShare: 0,
  degenerate: false,
  peakDay: null,
};
const aggregateAdmittedCompositionMock = vi.fn(async (..._args: unknown[]) => HEALTHY_COMPOSITION as unknown);
vi.mock('../../../scheduler/get-next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aggregateAdmittedComposition: (...args: unknown[]) => aggregateAdmittedCompositionMock(...args),
}));

// #3 promotion FAILSAFE seam (fleet-launch-promote-workitems-failsafe): the handler idempotently
// promotes the plan's items → claimable work-items before opening any terminal. Default: the healthy
// case (items already promoted upstream by plans:start → skipped>0, promoted:0 → no warning line).
// Individual tests override with mockResolvedValueOnce.
type PromotionMockResult = {
  promoted: number;
  skipped: number;
  specTriadBlocked?: true;
  specTriadMissing?: string[];
  specTriadWorkItem?: string | null;
};
const promotePlanItemsMock = vi.fn(
  async (..._args: unknown[]): Promise<PromotionMockResult> => ({ promoted: 0, skipped: 3 }),
);
vi.mock('../../../plan-workitem-promotion-run', () => ({
  promotePlanItems: (...args: unknown[]) => promotePlanItemsMock(...args),
}));

import tool, {
  memberLaunchCommand,
  defaultMemberAccountRouting,
  composeMemberLaunchContext,
  renderMemberBaseline,
  clampFleetTopUpToCapacity,
  buildFleetPlanClaimSpec,
  buildFleetKindClaimSpec,
  mergeKindIntoClaimSpec,
  claimableStatesForKinds,
  remotePlacementUnsupportedArgs,
  MEMBER_BASELINE_RULES,
  LEADER_STANDING_JOB,
  LEADER_AUTO_MODE_DIRECTIVE,
} from '../launch-on-plan';
// The REAL claim-spec validator (NOT the mocked claim-spec-STORE) — #4 specs must pass it.
import { validateClaimSpec } from '../../../scheduler/claim-spec';

beforeEach(() => {
  launchTransaction.verify.mockReset();
  launchTransaction.verify.mockResolvedValue({ agentStarted: true, waitedMs: 1, sessions: [], note: 'verified' });
  launchTransaction.persist.mockClear();
});

describe('launch-tool routing guidance', () => {
  it('identifies fleet:launch-on-plan as the ergonomic N-agents-on-a-plan door', () => {
    expect(tool.guidance?.when).toContain('ERGONOMIC N-AGENTS-ON-A-PLAN DOOR');
    expect(tool.guidance?.when).toContain('capability:terminal');
    expect(tool.guidance?.notWhen).toContain('capability:launch-agent');
    expect(tool.guidance?.notWhen).toContain('launching-agents-which-tool-for-which-door');
  });
});

describe('memberLaunchCommand', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
  });

  it('builds the scripted psu launch that triggers the auto-kickoff', () => {
    expect(memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan' })).toBe(
      'psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan',
    );
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
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'papercusp',
      plan: 'my-plan',
      account: 'aviynw6',
      workspace: 'ws1',
      role: 'su',
      model: 'opus:high',
      feature: 'F-3',
      profile: 'p',
    });
    expect(cmd).toContain('--account=aviynw6');
    expect(cmd).toContain('--workspace=ws1');
    expect(cmd).toContain('--role=su');
    expect(cmd).toContain('--model=opus:high'); // ':' is shell-safe → bare
    expect(cmd).toContain('--feature=F-3');
    expect(cmd).toContain('--profile=p');
    // the base tokens stay first + unchanged
    expect(cmd.startsWith('psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan')).toBe(true);
  });

  it('emits --brain as a bare flag and --add-dir repeated', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      brain: true,
      addDir: ['/a', '/b'],
    });
    expect(cmd).toContain(' --brain');
    expect(cmd).toContain('--add-dir=/a');
    expect(cmd).toContain('--add-dir=/b');
  });

  it('emits --allow-subagents as a bare flag when opted in (owner mandate 2026-07-02); omitted by default (deny)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      allowSubagents: true,
    });
    expect(cmd).toContain(' --allow-subagents');
    expect(memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p' })).not.toContain(
      '--allow-subagents',
    );
  });

  it('threads --context-size=<variant> (full|trimmed) for every backend', () => {
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', contextSize: 'trimmed' }),
    ).toContain('--context-size=trimmed');
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'omp', harness: 'h', plan: 'p', contextSize: 'full' }),
    ).toContain('--context-size=full');
  });

  it('threads --seat=<ref> for a launch-from-seats member (P-005); omitted otherwise', () => {
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', seat: 'opus:xhigh:AUTO' }),
    ).toContain('--seat=opus:xhigh:AUTO'); // ':' is shell-safe → bare
    expect(memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p' })).not.toContain('--seat');
  });

  it('shell-quotes a launch-context path with spaces (injection-safe)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      launchContext: '/home/x/brief one.md',
    });
    expect(cmd).toContain(`--launch-context='/home/x/brief one.md'`);
  });

  it('appends extraArgs verbatim, quoting only what needs it', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      extraArgs: ['--yes', '--add-dir=/x y'],
    });
    expect(cmd).toContain(' --yes');
    expect(cmd).toContain(`'--add-dir=/x y'`);
  });

  it('omits every optional flag when none are passed (base command unchanged)', () => {
    expect(memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan' })).toBe(
      'psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan',
    );
  });

  it('loads + self-registers the tool module without error', () => {
    expect(tool).toBeTruthy();
  });

  describe('defaultMemberAccountRouting — omission is the system account everywhere', () => {
    it('defaults an un-pinned member to "default" on macOS', () => {
      expect(defaultMemberAccountRouting(undefined, 'darwin')).toBe('default');
      expect(defaultMemberAccountRouting('', 'darwin')).toBe('default');
    });

    it('uses the same explicit system-account value on Linux/Windows', () => {
      expect(defaultMemberAccountRouting(undefined, 'linux')).toBe('default');
      expect(defaultMemberAccountRouting(undefined, 'win32')).toBe('default');
    });

    it('never overrides an explicit account pin — incl. the "default" escape hatch — on any platform', () => {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        expect(defaultMemberAccountRouting('aviynw6', platform)).toBe('aviynw6');
        expect(defaultMemberAccountRouting('auto', platform)).toBe('auto');
        // A Mac operator that explicitly wants direct egress passes 'default' — it must survive.
        expect(defaultMemberAccountRouting('default', platform)).toBe('default');
      }
    });

    it('the resolved routing flows into --account: a Mac member launch carries --account=default', () => {
      const account = defaultMemberAccountRouting(undefined, 'darwin');
      const cmd = memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'p', account });
      expect(cmd).toContain('--account=default');
    });
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

describe('clampFleetTopUpToCapacity', () => {
  it('clamps to dispatchBudget (concurrency) — NOT account count, NOT weekly-budget utilization', () => {
    // healthyAccounts=2 must NOT be the binding cap, and neither must recommendedHeadroom
    // (weekly-token-budget utilization). dispatchBudget=3 (spare admission slots) is the ONLY hard
    // cap: min(4, 3) = 3. recommendedHeadroom=4 ≥ openCount → not even a utilization advisory.
    expect(
      clampFleetTopUpToCapacity(4, {
        reachable: true,
        healthyAccounts: 2,
        dispatchBudget: 3,
        recommendedHeadroom: 4,
      }),
    ).toMatchObject({
      requestedOpenCount: 4,
      openCount: 3,
      clamped: true,
      healthyAccounts: 2,
      dispatchBudget: 3,
      recommendedHeadroom: 4,
      utilizationTight: false,
    });
  });

  it('does NOT clamp an explicit fleet on weekly-budget utilization when concurrency slots are free (the 5→2 incident)', () => {
    // THE reported bug (research-desk, 2026-07-08): an owner asked for 5 members; the pool had ~24
    // free admission slots but ONE bound account at ~0.94 of its 7-DAY token window drove
    // recommendedHeadroom down to the minHeadroom floor (2). recommendedHeadroom is budget-WINDOW
    // utilization, NOT concurrency — a near-weekly-cap account still runs many simultaneous sessions
    // right now — so it must NOT clamp. All 5 open; the tightness is surfaced as an ADVISORY only.
    const clamp = clampFleetTopUpToCapacity(5, {
      reachable: true,
      healthyAccounts: 1,
      dispatchBudget: 24,
      recommendedHeadroom: 2,
    });
    expect(clamp).toMatchObject({
      requestedOpenCount: 5,
      openCount: 5,
      clamped: false,
      utilizationTight: true,
    });
    expect(clamp?.reason).toMatch(/weekly-token-budget is tight/);
  });

  it('does NOT clamp a multi-member launch to a single healthy account (the 1-account=1-session bug)', () => {
    // The reported incident: 3 members requested, pool had ONE healthy account, launch
    // collapsed to 1. One account paces many concurrent sessions (gateway concurrency=24),
    // so with ample dispatchBudget the full request opens — account count is not a cap.
    const clamp = clampFleetTopUpToCapacity(3, {
      reachable: true,
      healthyAccounts: 1,
      dispatchBudget: 24,
      recommendedHeadroom: 3,
    });
    expect(clamp).toMatchObject({ requestedOpenCount: 3, openCount: 3, clamped: false, healthyAccounts: 1 });
    expect(clamp?.reason).toMatch(/accounts do NOT cap sessions/);
  });

  it('still clamps when the bee-tier dispatchBudget is the genuine limit', () => {
    // A REAL capacity limit (only 1 free admission slot) still clamps — this is legitimate,
    // unlike the account-count clamp above.
    expect(
      clampFleetTopUpToCapacity(3, {
        reachable: true,
        healthyAccounts: 5,
        dispatchBudget: 1,
        recommendedHeadroom: 3,
      }),
    ).toMatchObject({ requestedOpenCount: 3, openCount: 1, clamped: true });
  });

  it('suppresses a GATEWAY-routed top-up entirely when ZERO pool accounts are routable (no credential to authenticate)', () => {
    // healthyAccounts=0 is the one account signal that IS a gate — but only for gateway-routed
    // members (the conservative default when opts are omitted): no routable pool account means
    // no valid gateway credential, so nothing could authenticate — open 0 even if slots look free.
    expect(
      clampFleetTopUpToCapacity(3, {
        reachable: true,
        healthyAccounts: 0,
        dispatchBudget: 24,
        recommendedHeadroom: 3,
      }),
    ).toMatchObject({ requestedOpenCount: 3, openCount: 0, clamped: true });
    expect(
      clampFleetTopUpToCapacity(
        3,
        { reachable: true, healthyAccounts: 0, dispatchBudget: 24, recommendedHeadroom: 3 },
        { gatewayRouted: true },
      ),
    ).toMatchObject({ openCount: 0, clamped: true });
  });

  it('does NOT zero-gate a DIRECT-credential launch on an exhausted pool (the walled-pool canary incident, 2026-07-09)', () => {
    // The live incident: a 1-member canary on the DEFAULT system account (gateway skipped) was
    // clamped 1→0 because every POOL account was usage-walled — but a default-routed member
    // never asks the gateway to authenticate, so pool health must not gate it; dispatchBudget
    // remains the only hard cap.
    const clamp = clampFleetTopUpToCapacity(
      1,
      { reachable: true, healthyAccounts: 0, dispatchBudget: 13, recommendedHeadroom: 1 },
      { gatewayRouted: false },
    );
    expect(clamp).toMatchObject({ requestedOpenCount: 1, openCount: 1, clamped: false, healthyAccounts: 0 });
    expect(clamp?.reason).toMatch(/direct system credential/);
  });

  // ── ADVISORY CLAMP + OVERRIDE (owner directive 2026-07-09) ───────────────────────────────────
  // "when the inference gateway clamps it should just be a recommendation, agents should be able to
  // override". `override` is OPT-IN, so every default-path test above is byte-identical (that is the
  // point: the EI-8797 gatewayRouted semantics survive untouched).

  it('override launches ALL requested members through a zero-healthyAccounts gate, and SAYS it overrode', () => {
    // The exact live 2026-07-09 condition: healthyAccounts:0 from a STALE in-memory exhaustion while
    // dispatchBudget shows free slots. Without override this suppresses to 0 (test above).
    const clamp = clampFleetTopUpToCapacity(
      3,
      { reachable: true, healthyAccounts: 0, dispatchBudget: 24, recommendedHeadroom: 3 },
      { gatewayRouted: true, override: true },
    );
    expect(clamp).toMatchObject({
      requestedOpenCount: 3,
      openCount: 3,
      clamped: false,
      overridden: true,
      recommendedOpenCount: 0,
    });
    // The recommendation must remain legible — an override is never silent.
    expect(clamp?.reason).toMatch(/OVERRIDDEN/);
    expect(clamp?.reason).toMatch(/accounts:probe-capacity/);
  });

  it('override lifts a dispatchBudget concurrency clamp too', () => {
    const clamp = clampFleetTopUpToCapacity(
      6,
      { reachable: true, healthyAccounts: 4, dispatchBudget: 2, recommendedHeadroom: 6 },
      { override: true },
    );
    expect(clamp).toMatchObject({ openCount: 6, clamped: false, overridden: true, recommendedOpenCount: 2 });
  });

  it('override on an UNCONSTRAINED pool reports overridden:false — nothing was actually overridden', () => {
    const clamp = clampFleetTopUpToCapacity(
      2,
      { reachable: true, healthyAccounts: 4, dispatchBudget: 24, recommendedHeadroom: 2 },
      { override: true },
    );
    expect(clamp).toMatchObject({ openCount: 2, clamped: false, overridden: false, recommendedOpenCount: 2 });
    expect(clamp?.reason).not.toMatch(/OVERRIDDEN/);
  });

  it('WITHOUT override the clamp still binds, and the reason advertises the escape hatch', () => {
    const clamp = clampFleetTopUpToCapacity(3, {
      reachable: true,
      healthyAccounts: 0,
      dispatchBudget: 24,
      recommendedHeadroom: 3,
    });
    expect(clamp).toMatchObject({ openCount: 0, clamped: true, overridden: false, recommendedOpenCount: 0 });
    expect(clamp?.reason).toMatch(/pass override/);
  });

  it('recommendedOpenCount is reported on the happy path too (always legible)', () => {
    const clamp = clampFleetTopUpToCapacity(2, {
      reachable: true,
      healthyAccounts: 4,
      dispatchBudget: 24,
      recommendedHeadroom: 2,
    });
    expect(clamp).toMatchObject({ openCount: 2, recommendedOpenCount: 2, overridden: false });
  });

  it('fails open when the gateway headroom report is unreachable', () => {
    expect(
      clampFleetTopUpToCapacity(4, {
        reachable: false,
        healthyAccounts: null,
        dispatchBudget: null,
        recommendedHeadroom: null,
      }),
    ).toBeNull();
  });
});

// #4 (fleet-launch-plan-scoped-claim-spec, 2026-07-08): the pure builder that keeps every member's
// get_next self-pull on THIS plan (`plan = <slug>`, optionally AND kind ∈ kinds). The shape must
// satisfy the REAL validateClaimSpec, so it's exercised through it below.
describe('buildFleetPlanClaimSpec (#4 — plan-scoped fleet claim spec)', () => {
  it('bare plan leaf when no kinds are given', () => {
    const spec = buildFleetPlanClaimSpec('atlas-fleet', 'build-x');
    expect(spec).toMatchObject({
      specVersion: '1.0',
      revision: 1,
      view: { filter: { field: 'plan', op: '=', value: 'build-x' } },
    });
    expect(spec.specId).toBe('fleet-launch-atlas-fleet-plan');
  });

  it('combines plan AND kind into an `all` node when kinds are given', () => {
    const spec = buildFleetPlanClaimSpec('atlas-fleet', 'build-x', ['bug', 'change']);
    expect((spec.view as { filter: unknown }).filter).toEqual({
      all: [
        { field: 'plan', op: '=', value: 'build-x' },
        { field: 'kind', op: 'in', value: ['bug', 'change'] },
      ],
    });
  });

  it('names the fleet in specId so specs for different fleets never collide', () => {
    expect(buildFleetPlanClaimSpec('a', 'p').specId).not.toBe(buildFleetPlanClaimSpec('b', 'p').specId);
  });

  it('produces a spec that PASSES the real validateClaimSpec (both bare + combined)', () => {
    // Load-bearing: a malformed filter shape would validate here but silently filter out ALL
    // items at runtime (members get nothing) — so exercise the actual validator, not just the shape.
    expect(validateClaimSpec(buildFleetPlanClaimSpec('f', 'my-plan')).ok).toBe(true);
    expect(validateClaimSpec(buildFleetPlanClaimSpec('f', 'my-plan', ['bug', 'task'])).ok).toBe(true);
  });
});

// P-010: the states-for-kinds derivation that stops an issue-family drain starving on the
// default ['todo'] floor (the bug-drain-200k trap, EI-11300).
describe('claimableStatesForKinds + builder states threading (P-010)', () => {
  it('issue-family kinds → open; feature-family → undefined (unified open floor fits); mixed → [open]', () => {
    expect(claimableStatesForKinds(['bug'])).toEqual(['open']);
    expect(claimableStatesForKinds(['change', 'task'])).toEqual(['open']);
    expect(claimableStatesForKinds(['feature'])).toBeUndefined();
    expect(claimableStatesForKinds(['feature', 'chunk'])).toBeUndefined();
    // work-item-status-full-unify P-004/P-005: 'open' is the single claimable token for BOTH
    // families now, so a mixed lane pins ['open'] (was the transitional ['todo','open']).
    expect(claimableStatesForKinds(['feature', 'bug'])).toEqual(['open']);
  });

  it('buildFleetKindClaimSpec pins states:["open"] for a bugs-only drain (the trap), omits it for features', () => {
    expect((buildFleetKindClaimSpec('f', ['bug', 'change']) as { states?: string[] }).states).toEqual(['open']);
    expect((buildFleetKindClaimSpec('f', ['feature']) as { states?: string[] }).states).toBeUndefined();
    // Still a valid spec with states present.
    expect(validateClaimSpec(buildFleetKindClaimSpec('f', ['bug'])).ok).toBe(true);
  });

  it('buildFleetPlanClaimSpec pins states only for a kind-scoped plan lane, never for a bare plan lane', () => {
    expect((buildFleetPlanClaimSpec('f', 'p') as { states?: string[] }).states).toBeUndefined();
    expect((buildFleetPlanClaimSpec('f', 'p', ['bug']) as { states?: string[] }).states).toEqual(['open']);
  });

  it('mergeKindIntoClaimSpec derives states when the leader spec had none, and PRESERVES a leader-set states', () => {
    const noStates = { specVersion: '1.0', specId: 'leader-x', revision: 3, view: { filter: { field: 'priority', op: '<=', value: 2 } }, rank: { mode: 'lexicographic' as const, terms: [{ expr: 'priority', dir: 'asc' as const }] } };
    expect((mergeKindIntoClaimSpec(noStates as never, ['bug']) as { states?: string[] }).states).toEqual(['open']);
    const withStates = { ...noStates, states: ['failing'] };
    expect((mergeKindIntoClaimSpec(withStates as never, ['bug']) as { states?: string[] }).states).toEqual(['failing']);
  });
});

describe('composeMemberLaunchContext / renderMemberBaseline', () => {
  it('renders the universal baseline with every rule headline + the fleet/plan context', () => {
    const md = renderMemberBaseline({ fleetSlug: 'ops', plan: 'my-plan', count: 4 });
    expect(md).toContain('one of 4 parallel worker agents in fleet `ops`');
    expect(md).toContain('working plan `my-plan`');
    for (const r of MEMBER_BASELINE_RULES) expect(md).toContain(r.head);
    // the load-bearing rules the whole feature exists for
    expect(md).toContain('Already-fixed check FIRST');
    expect(md).toContain('Flag to your LEADER');
    expect(md).toContain('Do not re-claim a ping-ponging item');
    // queen-fleet-authority-boundary P-006: a hive pause ≠ a self-drain order
    expect(md).toContain('A hive pause is a Mug-loop signal, not a self-drain order');
    expect(md).toContain('fleet-leader(<other>)→fleet-members');
    // su-loop-capability-parity P-011: turn-end reflection + reporting integrity
    expect(md).toContain('Turn-end reflection + reporting integrity');
    expect(md).toContain('a routine turn records NOTHING');
    expect(md).toContain('a truthful `blocked` beats a fabricated all-clear');
    // su-loop-capability-parity P-012: member carry-note checkpoint
    expect(md).toContain('Carry-note checkpoint at every boundary');
    expect(md).toContain('work_items:checkpoint');
  });

  it('P-001: members PULL via scheduler:get_next (spec-driven), not claim_next, and do not self-prioritize', () => {
    const md = renderMemberBaseline({ fleetSlug: 'ops', plan: 'my-plan', count: 4 });
    // The pull tool is scheduler:get_next (the bee spec-driven self-select), and the member is
    // explicitly told NOT to use work_items:claim_next as its pull loop.
    expect(md).toContain('scheduler:get_next');
    expect(md).toContain('NOT `work_items:claim_next`');
    expect(md).toContain("scheduler:get_next { harness: '<your-harness>' }");
    expect(md).toContain('omit `specId`/`revision`');
    expect(md).toContain('`claimedUnder`');
    // The bee pull-discipline: leader steers WHICH item via the claim-spec; pickup is the member's;
    // no self-prioritizing by scanning the raw frontier.
    expect(md).toContain('scheduler:set_claim_spec');
    expect(md).toMatch(/PICKUP is yours|blackboard/);
    expect(md).toMatch(/Do NOT self-prioritize by scanning `work_items:list`/);
    // The member's pull LOOP line must not still tell it to claim via claim_next (the swap is real,
    // not additive) — the only claim_next mention left is the "do NOT use it" contrast.
    expect(md).not.toMatch(/\*\*claim\*\* the highest-priority[^\n]*work_items:claim_next/);
  });

  it('singularizes the worker count for a 1-member fleet', () => {
    const md = renderMemberBaseline({ fleetSlug: 'f', plan: 'p', count: 1 });
    expect(md).toContain('one of 1 parallel worker agent in fleet');
    expect(md).not.toContain('worker agents');
  });

  it('returns the baseline alone when no custom brief is given', () => {
    const md = composeMemberLaunchContext({ fleetSlug: 'f', plan: 'p', count: 2 });
    expect(md).toContain('# Fleet member — operating baseline');
    expect(md).not.toContain('Fleet-specific brief');
  });

  it('layers the leader brief BELOW the baseline (brief wins on specifics)', () => {
    const md = composeMemberLaunchContext({
      fleetSlug: 'f',
      plan: 'p',
      count: 2,
      customBriefText: 'CUSTOM DRAIN RULES for this fleet',
    });
    const baselineIdx = md.indexOf('# Fleet member — operating baseline');
    const sepIdx = md.indexOf('Fleet-specific brief');
    const briefIdx = md.indexOf('CUSTOM DRAIN RULES for this fleet');
    expect(baselineIdx).toBeGreaterThanOrEqual(0);
    expect(sepIdx).toBeGreaterThan(baselineIdx); // the brief section comes after the baseline
    expect(briefIdx).toBeGreaterThan(sepIdx);
  });

  it('ignores an empty / whitespace custom brief (baseline only)', () => {
    const md = composeMemberLaunchContext({ fleetSlug: 'f', plan: 'p', count: 1, customBriefText: '   \n' });
    expect(md).not.toContain('Fleet-specific brief');
  });
});

// su-loop-capability-parity-2026-07-03 P-002: the leader STEERS members by claim-spec
// (property filters, not id-pins) and OWNS driving the plan to done through the fleet.
describe("LEADER_STANDING_JOB — steer-don't-dispatch + completion mandate (P-002)", () => {
  const steer = LEADER_STANDING_JOB.find((p) => p.includes('scheduler:set_claim_spec'));

  it('has a steer-via-claim-spec point that names set_claim_spec + a PROPERTY filter, not id-pins', () => {
    expect(steer, 'a LEADER_STANDING_JOB point must steer via scheduler:set_claim_spec').toBeTruthy();
    expect(steer).toContain('scheduler:set_claim_spec');
    expect(steer).toMatch(/PROPERTY FILTER/i);
    // Explicitly warns off id-pins for standing lanes (the observed micro-dispatch anti-pattern).
    expect(steer).toMatch(/NEVER id-pins|id-pins for a standing lane/);
    // Re-steer by bumping the spec, not by hand-assigning each item.
    expect(steer).toMatch(/bumping its spec|next pull/);
  });

  it('carries the completion mandate — the leader owns driving the plan to done THROUGH the fleet', () => {
    const mandate = LEADER_STANDING_JOB.find((p) => /drive|driving the plan to done|OWN/i.test(p));
    expect(mandate, 'a LEADER_STANDING_JOB point must assert the leader owns completion').toBeTruthy();
    expect(steer).toMatch(/OWN driving the plan to done THROUGH the fleet/);
    // Guards the observed failure: silently falling back to solo work when members die/close.
    expect(steer).toMatch(/do NOT quietly fall back to doing the work solo/i);
  });

  it('members pull the item the leader steered — the two halves reference the SAME scheduler pair', () => {
    // P-001 member side pulls via scheduler:get_next; P-002 leader side steers via
    // scheduler:set_claim_spec. The pair must be internally consistent (the plan's control boundary).
    const memberMd = renderMemberBaseline({ fleetSlug: 'ops', plan: 'my-plan', count: 4 });
    expect(memberMd).toContain('scheduler:get_next');
    expect(memberMd).toContain('scheduler:set_claim_spec');
    expect(LEADER_STANDING_JOB.some((p) => p.includes('scheduler:set_claim_spec'))).toBe(true);
  });
});

// Leadership auto-enters AUTO mode (owner directive 2026-07-03): the launch RESULT is the
// moment the caller becomes a leader, so the directive rides the result — an AUTO-off leader
// parks at its ask-first posture while its fleet runs unsupervised (the ornith 9980 run).
describe('LEADER_AUTO_MODE_DIRECTIVE — leading a fleet auto-enters AUTO mode', () => {
  it("declares AUTO mode ON now, for the rest of the session — act-don't-ask", () => {
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/AUTO MODE/);
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/effective NOW/i);
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/rest of your session/i);
    // The concrete behavioural bind: never park waiting while the fleet is live.
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/NEVER end a turn waiting/i);
    // Disclosure, not a permission ask.
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/notice, not a question/i);
  });

  it("leads INTO the standing-job list (it renders as that list's header line)", () => {
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/standing job each cycle:$/);
  });
});

// su-loop-capability-parity-2026-07-03 P-013: prompt-bloat budget. The Ph1/2/4 ports stacked
// onto the member baseline + leader standing-job, and context-blow is the plan's own named #1
// leader failure. D-002 guards DRIFT; these guard BLOAT — a char ceiling so neither block can
// silently balloon in future. Budgets are current size + modest headroom (~1 more rule/point);
// exceeding one is the signal to prune or move detail behind a referenced doc, not to bump it.
describe('prompt-bloat budget (P-013)', () => {
  it('MEMBER_BASELINE_RULES stays within the char budget', () => {
    const chars = MEMBER_BASELINE_RULES.reduce((a, r) => a + r.head.length + r.body.length, 0);
    expect(chars, `member baseline rule chars = ${chars}`).toBeLessThan(3800);
  });

  it('the rendered member baseline stays within the char budget', () => {
    const md = renderMemberBaseline({ fleetSlug: 'ops', plan: 'my-plan', count: 4 });
    expect(md.length, `renderMemberBaseline chars = ${md.length}`).toBeLessThan(4400);
  });

  it('LEADER_STANDING_JOB stays within the char budget', () => {
    const chars = LEADER_STANDING_JOB.reduce((a, p) => a + p.length, 0);
    expect(chars, `leader standing-job chars = ${chars}`).toBeLessThan(3800);
  });

  it('each leader standing-job entry carries NO leading number (numbering is render-applied)', () => {
    for (const p of LEADER_STANDING_JOB) expect(p).not.toMatch(/^\s*\d+\./);
  });
});

// P-006 start gate (EI-19310192267009629). The gate shipped with NO test exercising
// its refusal path, which is exactly why a defect in it went unnoticed until it red
// the release gate. These two pin the behaviour that was missing:
//   1. an under-specified plan is REFUSED before any terminal opens, and
//   2. that refusal is reported AS a start-gate refusal — not relabelled
//      "Could not resolve plan", which is what happened while the gate ran inside
//      the resolution try/catch and is what sent readers after the database.
describe('fleet:launch-on-plan handler — P-006 start gate', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
  });

  it('refuses an under-specified plan, names the missing input, and opens NO member terminal', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    readPlanBySlugMock.mockResolvedValueOnce({
      slug: 'my-plan',
      parsed: { items: [] },
      archived: false,
      row: {
        planSlug: 'my-plan',
        template: null,
        inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } },
        templateData: null,
      },
    });

    const res = await tool.handler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    // Refusals from this handler are plain text via err(), not JSON via json().
    expect((res as any).isError).toBe(true);
    const text = (res as any).content[0].text as string;
    expect(text).toMatch(/cannot start/);
    expect(text).toMatch(/target/);
    // The whole point of gating HERE is that no member is launched onto a plan
    // that has no target — N dead sessions for one missing argument.
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('blames the START GATE when the gate itself throws — never "Could not resolve plan"', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    // A row shape the gate cannot process: template must be a string, so
    // planSchemaSource's `template?.trim()` throws a TypeError. This is the
    // exact shape of the original defect — a row field the gate assumed.
    readPlanBySlugMock.mockResolvedValueOnce({
      slug: 'my-plan',
      parsed: { items: [] },
      archived: false,
      row: { planSlug: 'my-plan', template: 42, inputSchema: null, templateData: null },
    });

    const res = await tool.handler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const text = (res as any).content[0].text as string;
    expect((res as any).isError).toBe(true);
    // The regression: while the gate ran inside the resolution try/catch, this
    // TypeError was relabelled "Could not resolve plan ..." — a false claim
    // about the plan store that sends every reader after the database.
    expect(text).not.toMatch(/Could not resolve/);
    expect(text).toMatch(/start gate/i);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
});

describe('fleet:launch-on-plan handler — member baseline wiring', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
  });

  it('composes the member baseline and threads its path into every member command', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await tool.handler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    // The leader always learns, structurally, what members were told.
    expect(payload.memberBaselineHeadlines).toHaveLength(MEMBER_BASELINE_RULES.length);
    expect(payload.memberBaselineHeadlines).toContain('Already-fixed check FIRST');
    expect(typeof payload.memberBaselineApplied).toBe('boolean');
    // su-loop-capability-parity P-010: leader reads the curated fleet feed + nudge hygiene.
    expect(payload.message).toContain('curation:feed');
    expect(payload.message).toMatch(/nudge that fails to land twice is an ESCALATION/);
    // su-loop-capability-parity P-012 (leader side): park with carry-notes, not prose.
    expect(payload.message).toContain('work_items:checkpoint');
    expect(payload.message).toMatch(/plans:set-now/);
    // su-loop-capability-parity P-006: wave-close fleet-execution-health scorecard.
    expect(payload.message).toContain('fleet-execution-health');
    expect(payload.message).toContain('observation:{ rubricRef:"fleet-execution-health", ratings }');
    expect(payload.message).toMatch(/per-WAVE, never per-turn/);
    // On a writable tmp the compose lands and its path threads into psu's --launch-context.
    if (payload.memberBaselineApplied) {
      expect(payload.memberLaunchContextPath).toContain('fleet-alpha-fleet-launch-context.md');
      const fs = require('node:fs');
      const composed = fs.readFileSync(payload.memberLaunchContextPath, 'utf8');
      // Fleet carry defaults warm independently of headless; make it explicit so
      // loop:arm's headless omitted-carry default cannot silently override it.
      expect(composed).toContain("`loop:arm { intervalSec, goal, carry: 'warm' }`");
      const firstGreeting = spawnConsoleMock.mock.calls[0][0].envelope.greetingCmd as string;
      expect(firstGreeting).toContain('--launch-context=');
      expect(firstGreeting).toContain('fleet-alpha-fleet-launch-context.md');
      // EI-20222088167233986: no explicit `workspace` arg was supplied above,
      // but the handler resolved ws-1 from its caller scope. The command must
      // carry that resolved value rather than inheriting the operator's
      // process-level workspace (often `default`) across warm wakes.
      expect(firstGreeting).toContain('--workspace=ws-1');
    }
  });

  // EI-19276371920501216: passing actual brief TEXT (not a path) as `launchContext`
  // used to die inside readFileSync with ENAMETOOLONG, silently dropping the brief
  // for every member while the launch still reported ok:true. It must now compose
  // straight into the generated baseline file instead.
  it('EI-19276371920501216: composes MULTI-LINE launchContext TEXT into the baseline file — no ENAMETOOLONG, no briefReadError', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const briefText = 'MISSION: full drain of the non-P2P backlog.\nDo NOT touch WI-1234 — a peer owns it.';
    const res = await tool.handler(
      { name: 'Text Brief Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, launchContext: briefText } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.briefReadError).toBeNull();
    expect(payload.opened).toHaveLength(1);
    expect(payload.memberBaselineApplied).toBe(true);
    expect(payload.memberLaunchContextPath).toContain('fleet-text-brief-fleet-launch-context.md');
    const fs = require('node:fs');
    const composed = fs.readFileSync(payload.memberLaunchContextPath, 'utf8');
    expect(composed).toContain('MISSION: full drain of the non-P2P backlog.');
    expect(composed).toContain('Do NOT touch WI-1234 — a peer owns it.');
    // The path actually handed to psu is the WRITTEN file, never the raw brief text.
    const firstGreeting = spawnConsoleMock.mock.calls[0][0].envelope.greetingCmd as string;
    expect(firstGreeting).toContain('--launch-context=');
    expect(firstGreeting).not.toContain('MISSION:');
  });

  // Regression safety: a genuine (short, single-line) path that just happens not to
  // exist must still be treated as a path and must refuse before any irreversible
  // terminal spawn — the fix must not swallow real path-read failures.
  it('a short single-line nonexistent PATH refuses before opening any terminal', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await tool.handler(
      {
        name: 'Missing Brief Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        launchContext: '/tmp/fleet-launch-ctx-test/does-not-exist-brief.md',
      } as never,
      {} as never,
    );
    expect((res as any).isError).toBe(true);
    expect((res as any).content[0].text).toMatch(/Could not read launchContext/);
    expect((res as any).content[0].text).toMatch(/No members were opened/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
});

describe('fleet:launch-on-plan handler — EI-8985 per-member launch-context briefs', () => {
  const tmpDir = '/tmp/fleet-launch-ctx-test-per-member';

  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    const fs = require('node:fs');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(`${tmpDir}/member-1.md`, 'You specifically own the auth migration.');
    fs.writeFileSync(`${tmpDir}/member-2.md`, 'You specifically own the UI polish pass.');
  });

  it('gives each listed member its OWN composed context, index-aligned', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await tool.handler(
      {
        name: 'Per-Member Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        perMemberLaunchContext: [`${tmpDir}/member-1.md`, `${tmpDir}/member-2.md`],
      } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.perMemberLaunchContextPaths).toHaveLength(2);
    expect(payload.perMemberLaunchContextPaths[0]).toContain('launch-context-member-1.md');
    expect(payload.perMemberLaunchContextPaths[1]).toContain('launch-context-member-2.md');
    // Two DISTINCT --launch-context flags were threaded, one per member.
    const cmd1 = spawnConsoleMock.mock.calls[0][0].envelope.greetingCmd as string;
    const cmd2 = spawnConsoleMock.mock.calls[1][0].envelope.greetingCmd as string;
    expect(cmd1).not.toEqual(cmd2);
    expect(cmd1).toContain('launch-context-member-1.md');
    expect(cmd2).toContain('launch-context-member-2.md');
    // Each composed file actually carries ITS OWN member's brief text.
    const fs = require('node:fs');
    const composed1 = fs.readFileSync(payload.perMemberLaunchContextPaths[0], 'utf8');
    const composed2 = fs.readFileSync(payload.perMemberLaunchContextPaths[1], 'utf8');
    expect(composed1).toContain('You specifically own the auth migration.');
    expect(composed1).not.toContain('UI polish pass');
    expect(composed2).toContain('You specifically own the UI polish pass.');
    expect(composed2).not.toContain('auth migration');
  });

  // per-member-declarative-launch-specs P-002: `members[]` generalizes the
  // brief-only per-member path above to EVERY setting.
  it('gives each members[i] its own model/account, falling back to the fleet arg when unset', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await tool.handler(
      {
        name: 'Per-Member Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 3,
        model: 'sonnet',
        members: [
          { model: 'opus[1m]', effort: 'high' },
          { account: 'auto' },
          // member 3 omitted entirely -> pure fleet-wide fallthrough
        ],
      } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    const cmd = (i: number) => spawnConsoleMock.mock.calls[i][0].envelope.greetingCmd as string;
    // Member 1: its own model, with effort folded ONTO the spec (psu has no --effort).
    expect(cmd(0)).toContain("--model='opus[1m]:high'");
    expect(cmd(0)).not.toContain('--effort');
    // Member 2: inherits the fleet model, overrides only the account.
    expect(cmd(1)).toContain('--model=sonnet');
    expect(cmd(1)).toContain('--account=auto');
    // Member 3: no spec at all -> the flat fleet-wide args, unchanged.
    expect(cmd(2)).toContain('--model=sonnet');
  });

  it('composes members[i].brief inline text into that member OWN context file', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await tool.handler(
      {
        name: 'Per-Member Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        members: [{ brief: 'You own the flaky-test triage lane.' }, {}],
      } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    const fs = require('node:fs');
    const composed = fs.readFileSync(payload.perMemberLaunchContextPaths[0], 'utf8');
    expect(composed).toContain('You own the flaky-test triage lane.');
  });

  it('falls back to the shared baseline for members BEYOND the perMemberLaunchContext array — never errors', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await tool.handler(
      {
        name: 'Partial Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 3,
        perMemberLaunchContext: [`${tmpDir}/member-1.md`],
      } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.perMemberLaunchContextPaths).toHaveLength(3);
    expect(payload.perMemberLaunchContextPaths[0]).toContain('launch-context-member-1.md');
    // members 2 and 3 wrote their OWN composed file too (baseline-only, no custom brief).
    expect(payload.perMemberLaunchContextPaths[1]).toContain('launch-context-member-2.md');
    expect(payload.perMemberLaunchContextPaths[2]).toContain('launch-context-member-3.md');
    const fs = require('node:fs');
    const composed2 = fs.readFileSync(payload.perMemberLaunchContextPaths[1], 'utf8');
    expect(composed2).not.toContain('auth migration');
    expect(composed2).not.toContain('UI polish pass');
  });

  it('a per-member unreadable file refuses before opening any terminal', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await tool.handler(
      {
        name: 'Resilient Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        perMemberLaunchContext: [`${tmpDir}/does-not-exist.md`, `${tmpDir}/member-2.md`],
      } as never,
      {} as never,
    );
    expect((res as any).isError).toBe(true);
    expect((res as any).content[0].text).toMatch(/member 1:.*could not read/);
    expect((res as any).content[0].text).toMatch(/No members were opened/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('a members[i].launchContext path is preflighted and refuses before opening any terminal', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 101 });
    const res = await tool.handler(
      {
        name: 'Declarative Brief Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        members: [{ launchContext: `${tmpDir}/does-not-exist.md` }],
      } as never,
      {} as never,
    );
    expect((res as any).isError).toBe(true);
    expect((res as any).content[0].text).toMatch(/members\[0\]\.launchContext/);
    expect((res as any).content[0].text).toMatch(/No members were opened/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
});

// per-member-declarative-launch-specs P-004: reject an incoherent MemberSpec, and
// echo the resolved per-member config so the leader confirms what each member got.
describe('fleet:launch-on-plan handler — P-004 validation + per-member disclosure', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
  });

  it('rejects launch-from-seats + a per-member model/effort/account (contradicts the delegated slot)', async () => {
    for (const bad of [{ model: 'opus' }, { effort: 'high' }, { account: 'auto' }]) {
      const res = await tool.handler(
        {
          name: 'Seat Fleet',
          plan: 'my-plan',
          harness: 'papercusp',
          count: 1,
          fromSeats: true,
          members: [bad],
        } as never,
        {} as never,
      );
      // A rejection is the plain-text `err()` shape (isError:true), not a JSON payload.
      expect((res as any).isError).toBe(true);
      const text = (res as any).content[0].text as string;
      expect(text).toMatch(/launch-from-seats derives model\+effort\+account/);
      expect(text).toContain('members[0]');
      // No terminals were opened — the launch failed clean, before any spawn.
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    }
  });

  it("REMOTE_PLACEMENT_UNSUPPORTED_ARGS refuses `members` (the host owns each member's model/account/window)", () => {
    expect(remotePlacementUnsupportedArgs({ members: [{}] })).toContain('members');
    // A launch with no per-member spec is unaffected.
    expect(remotePlacementUnsupportedArgs({ plan: 'p', count: 2 })).not.toContain('members');
  });

  it('HONORS a per-member carry override — member 1 gets a COLD baseline, member 2 the fleet-wide WARM', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await tool.handler(
      {
        name: 'Carry Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        carry: 'warm',
        members: [{ carry: 'cold' }, {}],
      } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    // Each member wrote its OWN composed context (the carry override forces the per-member path).
    expect(payload.perMemberLaunchContextPaths).toHaveLength(2);
    const fs = require('node:fs');
    const composed1 = fs.readFileSync(payload.perMemberLaunchContextPaths[0], 'utf8');
    const composed2 = fs.readFileSync(payload.perMemberLaunchContextPaths[1], 'utf8');
    // Member 1's baseline arms a COLD loop; member 2 falls through to the fleet-wide WARM.
    expect(composed1).toContain("carry: 'cold'");
    expect(composed2).not.toContain("carry: 'cold'");
  });

  it('echoes resolvedMembers (model/account/carry/compactionLimit/claimKinds) so the leader confirms each member', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await tool.handler(
      {
        name: 'Echo Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        model: 'sonnet',
        carry: 'warm',
        members: [{ model: 'opus[1m]', effort: 'high', carry: 'cold', compactionLimit: 300000 }, {}],
      } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.resolvedMembers).toHaveLength(2);
    // Member 1: its own model (effort folded), carry, and limit.
    expect(payload.resolvedMembers[0]).toMatchObject({
      member: 1,
      model: 'opus[1m]:high',
      carry: 'cold',
      compactionLimit: 300000,
    });
    // Member 2: pure fleet-wide fallthrough.
    expect(payload.resolvedMembers[1]).toMatchObject({ member: 2, model: 'sonnet', carry: 'warm' });
    // The human-facing message carries the per-member table too.
    expect(payload.message).toContain('per-member resolved config');
    expect(payload.message).toMatch(/carry=cold/);
  });

  it('resolvedMembers is null for a homogeneous (no-`members`) launch — no needless breakdown', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await tool.handler(
      { name: 'Plain Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.resolvedMembers).toBeNull();
  });

  it('WARNS that a per-member claimKinds is not applied at launch (only the fleet claim spec is)', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await tool.handler(
      {
        name: 'Lane Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        members: [{ claimKinds: ['bug'] }, {}],
      } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.message).toMatch(/per-member `claimKinds` is NOT applied at launch/);
    expect(payload.message).toContain('scheduler:set_claim_spec');
  });
});

describe('fleet:launch-on-plan handler — EI-8289 display disclosure', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
  });

  it('reports the resolved DISPLAY inline per opened member terminal', async () => {
    spawnConsoleMock.mockReturnValue({
      status: 'ok',
      terminal: 'term-1',
      pid: 123,
      display: ':1',
      desktopEnvResolvedVia: 'active-seat',
    });
    const res = await tool.handler(
      { name: 'Display Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.message).toContain('[DISPLAY=:1]');
    expect(payload.message).not.toMatch(/⚠.*socket scan/);
  });

  it('warns loudly when a member landed via a raw socket scan (possible virtual/sandbox placement, EI-8289)', async () => {
    spawnConsoleMock.mockReturnValue({
      status: 'ok',
      terminal: 'term-1',
      pid: 123,
      display: ':93',
      desktopEnvResolvedVia: 'socket-scan',
    });
    const res = await tool.handler(
      { name: 'Xvfb Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.message).toContain('[DISPLAY=:93]');
    expect(payload.message).toMatch(/⚠ no active login seat was detected.*socket scan.*EI-8289/);
  });
});

// WI-4752: repro'd live 2026-07-13 — a canary-first visible fleet launch reported
// opened:[{terminal:'gnome-terminal', pid:...}] + ok:true while BOTH launch PIDs had
// already exited (a stale DBUS_SESSION_BUS_ADDRESS ⇒ ServiceUnknown ⇒ StartServiceByName
// timeout). The underlying primitive fix (session-bus resolution + the early-exit probe,
// console-spawn.ts/console-spawn-desktop-env.test.ts) already covers spawnConsole itself;
// this pins the FLEET-TOOL-LEVEL contract the bug report actually named — every
// non-'ok' spawnConsole result must land in `failed[]`, never be counted as `opened`.
describe('fleet:launch-on-plan handler — spawn failures surface failed[], never a false opened receipt (WI-4752)', () => {
  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    const { releaseFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (releaseFleetLaunchSlot as ReturnType<typeof vi.fn>).mockReset();
    (releaseFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('a canary spawn failure opens no cohort and reports the one attempted failure', async () => {
    spawnConsoleMock.mockReturnValue({
      status: 'error',
      error:
        'gnome-terminal died killed by SIGSEGV within 1200ms — no window opened: stale specified server ' +
        'org.freedesktop.DBus ServiceUnknown (:1.113), fallback StartServiceByName org.gnome.Terminal timed out',
      code: 502,
    });
    const res = await tool.handler(
      { name: 'DBus Fail Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    // NOT true: `ok` mirrors `opened.length > 0` on this actual-spawn-attempted path
    // (launch-on-plan.ts's final `return json({ ok: opened.length > 0, ... })`) — that's
    // distinct from the early-return "suppressed" paths (relaunchSuppressed/capacitySuppressed)
    // which hardcode ok:true because THOSE are benign no-ops (nothing was attempted). Here every
    // spawn WAS attempted and genuinely failed, so ok:false is the correct, honest signal — the
    // WI-4752 contract is about opened[]/failed[] never lying, not about `ok` staying true.
    expect(payload.ok).toBe(false);
    expect(payload.opened).toEqual([]);
    expect(payload.failed).toHaveLength(1);
    expect(payload.failed[0].error).toMatch(/ServiceUnknown/);
    expect(payload.failed[0].code).toBe(502);
  });

  it('releases the fleet-launch idempotency slot when EVERY spawn failed, so an immediate legitimate retry is not suppressed', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'error', error: 'no window opened', code: 502 });
    const { releaseFleetLaunchSlot } = await import('../../../agent-fleets-store');
    await tool.handler(
      { name: 'DBus Fail Fleet 2', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    expect(releaseFleetLaunchSlot as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('a later wave partial failure preserves verified/opened identities and exposes recovery state', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => {
      call += 1;
      if (call < 3) return { status: 'ok', terminal: `term-${call}`, pid: 220 + call };
      return { status: 'error', error: 'spawn 3 failed: no window opened', code: 502 };
    });
    const res = await tool.handler(
      { name: 'Partial DBus Fleet', plan: 'my-plan', harness: 'papercusp', count: 3 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.opened).toHaveLength(2);
    expect(payload.failed).toHaveLength(1);
    expect(payload.launchTransaction.state).toBe('partial');
    expect(payload.launchTransaction.recovery.retryOwnerIds).toHaveLength(1);
  });
});

describe('fleet:launch-on-plan handler — verified canary-first transaction (P-003 / D-001)', () => {
  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockImplementation((_opts) => ({
      status: 'ok', terminal: `term-${spawnConsoleMock.mock.calls.length}`, pid: 100 + spawnConsoleMock.mock.calls.length,
    }));
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('does not open the cohort when the canary never reaches a successful tool invocation', async () => {
    launchTransaction.verify.mockResolvedValueOnce({
      agentStarted: null, waitedMs: 10_000, sessions: [], note: 'UNVERIFIED',
    });
    const res = await tool.handler(
      { name: 'Canary Stop Fleet', plan: 'my-plan', harness: 'papercusp', count: 5 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.ok).toBe(false);
    expect(payload.launchTransaction.state).toBe('partial');
    expect(payload.launchTransaction.verifiedMemberIds).toEqual([]);
  });

  it('rolls out one canary then bounded waves, with exact pre-pinned identities', async () => {
    const res = await tool.handler(
      { name: 'Bounded Wave Fleet', plan: 'my-plan', harness: 'papercusp', count: 8 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    const waveSizes = launchTransaction.verify.mock.calls.map(
      (call) => (call[0] as { expectedOwnerIds: string[] }).expectedOwnerIds.length,
    );
    expect(waveSizes).toEqual([1, 3, 3, 1]);
    expect(payload.launchTransaction.state).toBe('verified');
    expect(payload.launchTransaction.requestedMemberIds).toHaveLength(8);
    expect(new Set(payload.launchTransaction.requestedMemberIds).size).toBe(8);
    expect(launchTransaction.verify.mock.calls[0][0].expectedAttestations[0]).toMatchObject({
      effort: null,
      account: 'default',
      carry: 'warm',
      visibility: 'visible',
    });
    for (const call of spawnConsoleMock.mock.calls) {
      expect(call[0].envelope.greetingCmd).toMatch(/--owner-id=su-[0-9a-f-]+/);
      expect(call[0].envelope.greetingCmd).toContain('--carry=warm');
    }
  });

  it('P-008: a partial 50-member campaign preserves the exact verified/retry boundary', async () => {
    // This is an intentional handler-level adversarial scale case. The public
    // `fleet:launch-on-plan` schema keeps its 12-member operator safety ceiling;
    // the transaction seam still needs to stay correct if a larger campaign is
    // admitted by a future policy or another trusted caller.
    let spawn = 0;
    spawnConsoleMock.mockImplementation(() => {
      spawn += 1;
      if (spawn === 9) {
        return { status: 'error', error: 'member 9 failed: no window opened', code: 502 };
      }
      return { status: 'ok', terminal: `term-${spawn}`, pid: 500 + spawn };
    });

    const res = await tool.handler(
      { name: 'Partial Fifty Fleet', plan: 'my-plan', harness: 'papercusp', count: 50 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    const tx = payload.launchTransaction;
    const requestedIds = tx.requestedMemberIds as string[];
    const verifiedIds = tx.verifiedMemberIds as string[];
    const retryIds = tx.recovery.retryOwnerIds as string[];

    expect(requestedIds).toHaveLength(50);
    expect(new Set(requestedIds).size).toBe(50);
    // Canary + two verified 3-member waves + one partial 3-member wave.
    expect(spawnConsoleMock).toHaveBeenCalledTimes(10);
    expect(tx.waves.map((wave: { ownerIds: string[] }) => wave.ownerIds.length)).toEqual([1, 3, 3, 3]);
    // The failed member is excluded from the verification probe for its wave.
    expect(
      launchTransaction.verify.mock.calls.map(
        (call) => (call[0] as { expectedOwnerIds: string[] }).expectedOwnerIds.length,
      ),
    ).toEqual([1, 3, 3, 2]);

    expect(payload.ok).toBe(true);
    expect(payload.opened).toHaveLength(9);
    expect(payload.failed).toHaveLength(1);
    expect(tx.state).toBe('partial');
    expect(tx.waves.at(-1)?.state).toBe('partial');
    expect(verifiedIds).toHaveLength(9);
    expect(retryIds).toHaveLength(41);
    expect(new Set([...verifiedIds, ...retryIds])).toEqual(new Set(requestedIds));
    expect(retryIds).toContain(payload.failed[0].ownerId);
    expect(payload.fleetComplete).toBe(false);
    expect(payload.shortfall).toBe(41);
  });

  it('stops before a later wave after attestation failure and returns the exact retry set', async () => {
    launchTransaction.verify
      .mockResolvedValueOnce({ agentStarted: true, waitedMs: 1, sessions: [], note: 'verified' })
      .mockResolvedValueOnce({ agentStarted: false, waitedMs: 1, sessions: [], note: 'ATTESTATION MISMATCH' });
    const res = await tool.handler(
      { name: 'Mismatch Fleet', plan: 'my-plan', harness: 'papercusp', count: 5 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(4);
    expect(payload.launchTransaction.state).toBe('partial');
    expect(payload.launchTransaction.recovery.retryOwnerIds).toHaveLength(4);
  });
});

describe('fleet:launch-on-plan handler — live-member deficit guard (2026-07-03 leader doom-loop)', () => {
  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockReset();
  });

  it('refuses a relaunch when the fleet already has >= count LIVE members — no spawn at all', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue(['m-1', 'm-2']);
    const res = await tool.handler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.relaunchSuppressed).toBe(true);
    expect(payload.liveMembers).toBe(2);
    expect(payload.opened).toEqual([]);
    expect(payload.message).toMatch(/already has 2 LIVE members/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('opens only the DEFICIT when some members are live (2 requested, 1 alive → 1 opened)', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue(['m-1']);
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await tool.handler(
      { name: 'Beta Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.message).toContain('deficit top-up: 1 already live of the 2 requested');
  });

  it('capacity-clamps the DEFICIT before opening terminals (3 requested, 0 alive, 1 safe slot → 1 opened)', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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
        tiers: [{ tier: 3, cap: 1, inFlight: 0, queued: 0 }],
      },
    });
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await tool.handler(
      { name: 'Capacity Fleet', plan: 'my-plan', harness: 'papercusp', count: 3 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.requestedOpenCount).toBe(3);
    expect(payload.capacityClamp).toMatchObject({ requestedOpenCount: 3, openCount: 1, clamped: true });
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.message).toContain('capacity-clamped top-up 3→1');
  });

  it('suppresses a top-up without burning a launch wave when reachable capacity is zero', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockClear();
    fetchGatewayHeadroomMock.mockResolvedValue({
      reachable: true,
      utilization: 1,
      utilizationPct: 100,
      paused: true,
      rejected: true,
      inFlight: 1,
      queueDepth: 4,
      priorityTiers: {
        healthyAccounts: 0,
        tier1Reserve: 0,
        tiers: [{ tier: 3, cap: 0, inFlight: 0, queued: 0 }],
      },
    });
    const res = await tool.handler(
      { name: 'Full Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.capacitySuppressed).toBe(true);
    expect(payload.opened).toEqual([]);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(claimFleetLaunchSlot).not.toHaveBeenCalled();
  });

  it('does not count the CALLER (the leader) as a live member', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    // resolveFleetCaller's mocked ownerId below must be excluded from the live count.
    const { resolveFleetCaller } = await import('../_shared');
    const ownerId = vi.mocked(resolveFleetCaller)({} as never).ownerId as string;
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([ownerId]);
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await tool.handler(
      { name: 'Gamma Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });
});

// WI-1811 (fleet-launch-agent-inheritance-2026-07-03#P-007): the P-005 idempotency guard's
// TOOL-LEVEL behavior — a second in-window fleet:launch-on-plan call must open ZERO members
// (no-op, not a second wave) and hand the leader the exact standing-job notice, not a bare
// error. Store-level claim semantics (won/lost, window, concurrency) are covered in
// agent-fleets-store.integration.test.ts; this pins what the HANDLER does with a lost claim.
describe('fleet:launch-on-plan handler — P-005 idempotency guard (a re-fire inside the window opens 0 members)', () => {
  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockReset();
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(async () => {
    // Restore the module-level default (won:true) so later describe blocks that don't touch
    // this mock themselves aren't left seeing this block's last (won:false) resolution.
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockReset();
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({ won: true, at: 1 });
  });

  it('a lost claim opens 0 members — spawnConsole is never called', async () => {
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({
      won: false,
      priorAt: Date.now() - 5_000,
      priorCount: 2,
    });
    const res = await tool.handler(
      { name: 'Refire Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.opened).toEqual([]);
    expect(payload.failed).toEqual([]);
    expect(payload.relaunchSuppressed).toBe(true);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('the notice names the fleet, the prior member count/age, and tells the leader not to re-call', async () => {
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({
      won: false,
      priorAt: Date.now() - 12_000,
      priorCount: 3,
    });
    const res = await tool.handler(
      { name: 'Refire Fleet', plan: 'drain-me', harness: 'papercusp', count: 3 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.message).toMatch(
      /Fleet `refire-fleet` was already launched — 3 members opened \d+s ago \(possibly by this very session\)\./,
    );
    expect(payload.message).toContain(
      'You ARE the leader; do NOT call fleet:launch-on-plan again or fleet:take-leadership for this fleet — re-call only to add another wave once the current members have drained.',
    );
    expect(payload.message).toContain('Until the plan `drain-me` is drained, your standing job each cycle:');
    expect(payload.message).toContain(
      'Those members were launched with this MEMBER OPERATING BASELINE (do NOT re-issue or contradict it; a later custom brief still layers below it):',
    );
    // Every LEADER_STANDING_JOB point + MEMBER_BASELINE_RULES headline is enumerated, not just referenced.
    for (const point of LEADER_STANDING_JOB) expect(payload.message).toContain(point);
    for (const rule of MEMBER_BASELINE_RULES) expect(payload.message).toContain(rule.head);
  });

  it('singularizes "member" (not "members") when exactly one prior member was opened', async () => {
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({
      won: false,
      priorAt: Date.now() - 1_000,
      priorCount: 1,
    });
    const res = await tool.handler(
      { name: 'Solo Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.message).toMatch(/1 member opened \d+s ago/);
    expect(payload.message).not.toMatch(/1 members opened/);
  });
});

// EI-7671: the handler must apply the fleet-level kind-filter claim spec BEFORE opening
// any member terminal (closing the boot-race where members self-pull under the
// unrestricted DEFAULT_CLAIM_SPEC before the leader manually steers them).
describe('fleet:launch-on-plan handler — claim-spec wiring (plan-scoped #4 + claimKinds EI-7671)', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 1 });
    // P-010: restore the healthy-lane guard default (order-independent).
    previewSpecPoolEffectMock.mockReset();
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 5, pool: 10, states: ['open'], harness: 'papercusp' });
    evaluateCollapseGuardMock.mockReset();
    evaluateCollapseGuardMock.mockReturnValue({ refuse: false, errors: [] });
  });

  it('applies a kind-only claim spec when claimKinds is passed (EI-10409), BEFORE any member terminal opens', async () => {
    const callOrder: string[] = [];
    setClaimSpecMock.mockImplementation(async () => {
      callOrder.push('setClaimSpec');
      return { ok: true, revision: 1 };
    });
    spawnConsoleMock.mockImplementation(() => {
      callOrder.push('spawnConsole');
      return { status: 'ok', terminal: 'term-1', pid: 123 };
    });
    const res = await tool.handler(
      { name: 'Drain Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, claimKinds: ['bug', 'change'] } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
    const call = setClaimSpecMock.mock.calls[0][0] as {
      cupId: string;
      spec: { view: { filter: unknown } };
    };
    expect(call.cupId).toBe('fleet:drain-fleet');
    // EI-10409: claimKinds prefers a KIND-ONLY filter (buildFleetKindClaimSpec) over the old
    // plan+kind `all` combo — ordinary backlog work-items don't carry `plan=` (only items
    // PROMOTED from the plan do), so plan-ANDed-with-kind starved the exact backlog-drain
    // flow claimKinds advertises. get_next's harness floor still scopes members to this pot.
    expect(call.spec.view.filter).toEqual({ field: 'kind', op: 'in', value: ['bug', 'change'] });
    // P-010: an issue-family drain auto-pins states:['open'] so it doesn't starve on ['todo'].
    expect((call.spec as { states?: string[] }).states).toEqual(['open']);
    // claimSpecApplied now also carries the pool-effect (matched of pool) on the claimKinds path.
    expect(payload.claimSpecApplied).toMatchObject({ ok: true, revision: 1, poolEffect: { matched: 5, pool: 10 } });
    // Order matters: the spec must land before members can race a get_next pull.
    expect(callOrder.indexOf('setClaimSpec')).toBeLessThan(callOrder.indexOf('spawnConsole'));
  });

  it('#4: ALWAYS sets a PLAN-scoped claim spec even when claimKinds is omitted', async () => {
    const res = await tool.handler(
      { name: 'No Kinds Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
    const call = setClaimSpecMock.mock.calls[0][0] as { spec: { view: { filter: unknown } } };
    // Bare plan leaf (no kind narrowing) — keeps members on THIS plan's work-items.
    expect(call.spec.view.filter).toEqual({ field: 'plan', op: '=', value: 'my-plan' });
    // EI-19276371141300541: a fresh plan-only lane now ALSO gets the write-time pool-effect
    // preview (it used to be skipped entirely for this path — the exact gap that let a
    // 10-member fleet launch onto a plan-scoped lane matching a single row with no signal
    // anywhere in the response).
    expect(payload.claimSpecApplied).toMatchObject({ ok: true, revision: 1, poolEffect: { matched: 5, pool: 10 } });
  });

  it('best-effort: a claim-spec write failure never blocks the launch', async () => {
    setClaimSpecMock.mockRejectedValue(new Error('db unavailable'));
    const res = await tool.handler(
      { name: 'Resilient Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, claimKinds: ['task'] } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.claimSpecApplied).toMatchObject({ ok: false, errors: ['db unavailable'] });
  });
});

// P-010: the claimKinds launch path is routed through scheduler:set_claim_spec's WI-5212
// pool-collapse guard — a starving kind scope is REFUSED before any terminal opens (the
// bug-drain-200k trap). The guard's own thresholds are unit-tested in spec-pool-preview; here
// we test the WIRING: refuse aborts the launch, confirm overrides, and matched is surfaced.
describe('fleet:launch-on-plan handler — P-010 claimKinds pool-collapse guard', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 1 });
    previewSpecPoolEffectMock.mockReset();
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 5, pool: 10, states: ['open'], harness: 'papercusp' });
    evaluateCollapseGuardMock.mockReset();
    evaluateCollapseGuardMock.mockReturnValue({ refuse: false, errors: [] });
  });

  it('REFUSES a starving claimKinds fleet BEFORE any terminal opens — no members, no spec write', async () => {
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 0, pool: 12, states: ['open'], harness: 'papercusp' });
    evaluateCollapseGuardMock.mockReturnValue({
      refuse: true,
      errors: ['spec matches 0 of 12 claimable row(s) — the starved-fleet shape'],
    });
    const res = await tool.handler(
      { name: 'Starved Fleet', plan: 'my-plan', harness: 'papercusp', count: 3, claimKinds: ['bug'] } as never,
      {} as never,
    );
    // A refusal is the plain-text err() shape, not a JSON payload.
    expect((res as any).isError).toBe(true);
    const text = (res as any).content[0].text as string;
    expect(text).toMatch(/matches 0 of 12 claimable row/);
    expect(text).toContain('NO members were opened');
    expect(text).toContain('confirmClaimCollapse:true');
    // The guard fired BEFORE terminals AND before the spec write — nothing was opened or stored.
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(setClaimSpecMock).not.toHaveBeenCalled();
  });

  it('confirmClaimCollapse:true forwards confirm to the guard and launches the pre-staged lane anyway', async () => {
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 0, pool: 12, states: ['open'], harness: 'papercusp' });
    // With confirm the guard does not refuse (verified by its own suite); assert the handler forwards it.
    evaluateCollapseGuardMock.mockReturnValue({ refuse: false, errors: [], warning: 'pool-collapse confirmed by caller' });
    const res = await tool.handler(
      { name: 'Prestaged Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, claimKinds: ['bug'], confirmClaimCollapse: true } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(evaluateCollapseGuardMock.mock.calls[0][0]).toMatchObject({ confirm: true });
  });

  it('a fed lane launches and SURFACES poolEffect.matched (the counter-signal to starvation)', async () => {
    const res = await tool.handler(
      { name: 'Fed Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, claimKinds: ['bug'] } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.claimSpecApplied.poolEffect).toMatchObject({ matched: 5, pool: 10 });
    expect(payload.message).toContain('claim-lane pool-effect');
    expect(payload.message).toMatch(/matches 5 of 10 claimable row/);
    // No confirm passed → the guard was consulted with confirm:false.
    expect(evaluateCollapseGuardMock.mock.calls[0][0]).toMatchObject({ confirm: false });
  });

  // EI-19276371141300541: the guard used to run ONLY on the claimKinds path — a fresh
  // plan-only lane (buildFleetPlanClaimSpec, no claimKinds) got neither the zero-match
  // refuse nor a surfaced poolEffect. Live incident: `fleet:launch-on-plan { name, plan:
  // '<drain-tracking-plan>', count: 10 }` (no claimKinds) reported `claimSpecApplied:
  // {ok:true}` while the plan-scoped lane matched exactly ONE claimable row for a
  // 10-member fleet.
  it('REFUSES a starving PLAN-ONLY fleet (no claimKinds) BEFORE any terminal opens — same guard as claimKinds', async () => {
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 0, pool: 12, states: ['open'], harness: 'papercusp' });
    evaluateCollapseGuardMock.mockReturnValue({
      refuse: true,
      errors: ['spec matches 0 of 12 claimable row(s) — the starved-fleet shape'],
    });
    const res = await tool.handler(
      { name: 'Starved Plan Fleet', plan: 'my-plan', harness: 'papercusp', count: 10 } as never,
      {} as never,
    );
    expect((res as any).isError).toBe(true);
    const text = (res as any).content[0].text as string;
    expect(text).toMatch(/matches 0 of 12 claimable row/);
    expect(text).toContain('plan=`my-plan`');
    expect(text).toContain('NO members were opened');
    expect(text).toContain('confirmClaimCollapse:true');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(setClaimSpecMock).not.toHaveBeenCalled();
  });

  it('WARNS (never refuses) a PLAN-ONLY fleet whose lane matches fewer rows than requested members — the exact live-incident shape (matched:1, count:10)', async () => {
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 1, pool: 1719, states: ['open'], harness: 'papercusp' });
    const res = await tool.handler(
      { name: 'Nonp2p Bug Drain', plan: 'bug-drain-tracking-plan', harness: 'papercusp', count: 10 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalled();
    const warning = payload.claimSpecApplied.warning as string;
    expect(warning).toContain('matches only 1 of 1719');
    expect(warning).toContain('10-member fleet');
    expect(payload.message).toMatch(/may NOT cover all 10 member/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WI-6673 degenerate-lane guard — the DUAL of the collapse guard above.
//
// The collapse guard catches a lane matching TOO FEW rows (starvation). This catches the
// opposite and equally real failure: a lane matching PLENTY of rows that are not work. On
// 2026-08-01 a bug-drain fleet was launched at 1,252 "claimable" items that were 98.7%
// nit-severity auto-filed observations; the real bug backlog was ~285. Nothing objected,
// because every count was correct — a big number simply looks like a healthy backlog.
//
// The guard shipped with no tests at all, which is how its thresholds and its wording could
// rot silently. These pin the three properties that make it worth having: it fires on the
// degenerate shape, it stays SILENT on a healthy lane (a warning that cries wolf gets
// ignored precisely when it matters), and it never blocks a launch.
// ────────────────────────────────────────────────────────────────────────────
describe('fleet:launch-on-plan handler — WI-6673 degenerate-lane (observation-firehose) guard', () => {
  const DEGENERATE = {
    total: 1_252,
    byKind: { change: 1_200, bug: 52 },
    bySeverity: { nit: 1_180, minor: 56, major: 16 },
    lowSeverityShare: 0.987,
    degenerate: true,
    peakDay: { day: '2026-07-31', count: 940 },
  };

  beforeEach(() => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 1 });
    previewSpecPoolEffectMock.mockReset();
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 1_252, pool: 1_400, states: ['open'], harness: 'papercusp' });
    evaluateCollapseGuardMock.mockReset();
    evaluateCollapseGuardMock.mockReturnValue({ refuse: false, errors: [] });
    aggregateAdmittedCompositionMock.mockReset();
    aggregateAdmittedCompositionMock.mockResolvedValue(HEALTHY_COMPOSITION);
  });

  const launch = async (args: Record<string, unknown> = {}) =>
    tool.handler(
      { name: 'Drain Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, claimKinds: ['bug', 'change'], ...args } as never,
      {} as never,
    );

  it('WARNS on a degenerate lane — naming the share, the burst day, and the composition', async () => {
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    const res = await launch();
    const payload = JSON.parse((res as any).content[0].text);
    const warning = payload.claimSpecApplied.warning as string;

    expect(warning).toContain('⚠ DEGENERATE LANE');
    expect(warning).toContain('99%'); // 0.987 rounded
    expect(warning).toContain('OBSERVATION FIREHOSE');
    expect(warning).toContain('a large count is not a workload');
    expect(warning).toContain('2026-07-31'); // the burst day
    expect(warning).toContain('940');
    expect(warning).toContain('WI-6673');
    // The composition is quoted, so the reader can act without a second call.
    expect(warning).toContain('"nit":1180');
  });

  it('quotes the share against the ADMITTED total, not the pre-floor matched count', async () => {
    // The share is computed over rows passing ALL claim floors; `matched` is the filter
    // match before them (strictly larger). Reporting one against the other is a true
    // percentage on the wrong base — the very defect class this guard exists to catch,
    // and it shipped inside the guard's own message once.
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 3_000, pool: 4_000, states: ['open'], harness: 'papercusp' });
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    const res = await launch();
    const warning = JSON.parse((res as any).content[0].text).claimSpecApplied.warning as string;

    expect(warning).toContain('99% of the 1252 claimable row(s)');
    // The pre-floor number is still shown, but explicitly labelled as the other population.
    expect(warning).toContain('of 3000 matched before claim floors');
    expect(warning).not.toContain('99% of the 3000');
  });

  it('omits the pre-floor aside when nothing was filtered out — no confusing "(of N matched)" when N is the same number', async () => {
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 1_252, pool: 1_400, states: ['open'], harness: 'papercusp' });
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    const res = await launch();
    const warning = JSON.parse((res as any).content[0].text).claimSpecApplied.warning as string;
    expect(warning).toContain('99% of the 1252 claimable row(s)');
    expect(warning).not.toContain('matched before claim floors');
  });

  it('is SILENT on a healthy lane — a warning that fires on normal backlogs would be tuned out', async () => {
    const res = await launch();
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.claimSpecApplied.warning ?? '').not.toContain('DEGENERATE LANE');
  });

  it('WARNS but never REFUSES — a nit-sweep fleet is a legitimate thing to want', async () => {
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    const res = await launch({ count: 2 });
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    // Members really opened — the launch proceeded despite the warning.
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
  });

  it('FAILS OPEN — a composition read that throws never blocks the launch', async () => {
    aggregateAdmittedCompositionMock.mockRejectedValue(new Error('pg exploded'));
    const res = await launch();
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    // A diagnostic that becomes a new single point of failure is worse than no diagnostic.
    expect(payload.claimSpecApplied.warning ?? '').not.toContain('DEGENERATE LANE');
  });

  it('reads the composition through the SAME spec filter + states the members will pull with', async () => {
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    await launch();
    // Composition describing a different population than the one the fleet drains would be
    // a confidently-wrong reassurance — the failure mode, not a milder version of it.
    expect(aggregateAdmittedCompositionMock).toHaveBeenCalledTimes(1);
    const [, opts] = aggregateAdmittedCompositionMock.mock.calls[0] as [unknown, { harness: string; states?: readonly string[] }];
    expect(opts.harness).toBe('papercusp');
    expect(opts.states).toEqual(expect.arrayContaining(['open']));
  });

  // EI-19276371141300541: this used to assert the OPPOSITE — that a pure plan fleet (no
  // claimKinds) got NO composition read at all, on the theory that only a claimKinds lane is
  // "a claim-spec lane to characterize". That was the same blind spot the pool-collapse guard
  // had: a fresh plan-only lane is a freshly-generated spec just like a kind-only one, and
  // skipping both its zero-match refuse AND this degenerate-lane check is exactly how a
  // starved/degenerate plan lane shipped with zero signal anywhere in the response. Both
  // checks now run uniformly for every freshly-built spec (plan-only included).
  it('DOES run the composition read for a pure plan fleet too (no claimKinds) — a fresh plan-only lane is just as characterizable', async () => {
    aggregateAdmittedCompositionMock.mockResolvedValue(HEALTHY_COMPOSITION);
    const res = await tool.handler(
      { name: 'Plan Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(aggregateAdmittedCompositionMock).toHaveBeenCalledTimes(1);
    // A healthy composition stays silent — no false alarm on the common case.
    expect(payload.claimSpecApplied.warning ?? '').not.toContain('DEGENERATE LANE');
  });
});

// #3 promotion FAILSAFE (fleet-launch-promote-workitems-failsafe, 2026-07-08): the handler must
// idempotently promote the plan's items → claimable work-items BEFORE opening any terminal, so a
// forgotten plans:start can't strand the fleet on an empty backlog (the research-desk 2026-07-08 miss).
describe('fleet:launch-on-plan handler — plan→work-item promotion failsafe (#3)', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 1 });
    promotePlanItemsMock.mockReset();
    promotePlanItemsMock.mockResolvedValue({ promoted: 0, skipped: 3 });
  });

  it('promotes the plan BEFORE opening any member terminal', async () => {
    const callOrder: string[] = [];
    promotePlanItemsMock.mockImplementation(async () => {
      callOrder.push('promote');
      return { promoted: 4, skipped: 0 };
    });
    spawnConsoleMock.mockImplementation(() => {
      callOrder.push('spawnConsole');
      return { status: 'ok', terminal: 'term-1', pid: 123 };
    });
    const res = await tool.handler(
      { name: 'Fresh Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(promotePlanItemsMock).toHaveBeenCalledTimes(1);
    expect(promotePlanItemsMock.mock.calls[0][0]).toMatchObject({ planSlug: 'my-plan', harnessSlug: 'papercusp' });
    expect(callOrder.indexOf('promote')).toBeLessThan(callOrder.indexOf('spawnConsole'));
    expect(payload.promotionFailsafe).toMatchObject({ ran: true, promoted: 4 });
  });

  it('warns in the message when it had to backstop a missing plans:start (promoted > 0)', async () => {
    promotePlanItemsMock.mockResolvedValue({ promoted: 2, skipped: 0 });
    const res = await tool.handler(
      { name: 'Forgot Start', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.message).toMatch(/FAILSAFE auto-promoted 2 plan items/);
  });

  it('stays silent (no warning) when the plan was already promoted upstream (idempotent no-op)', async () => {
    promotePlanItemsMock.mockResolvedValue({ promoted: 0, skipped: 5 });
    const res = await tool.handler(
      { name: 'Already Started', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.message).not.toMatch(/FAILSAFE auto-promoted/);
    expect(payload.promotionFailsafe).toMatchObject({ ran: true, promoted: 0, skipped: 5 });
  });

  it('explains a zero-promotion spec-triad refusal instead of implying the lane is fed', async () => {
    promotePlanItemsMock.mockResolvedValue({
      promoted: 0,
      skipped: 5,
      specTriadBlocked: true,
      specTriadMissing: ['requirements', 'design'],
      specTriadWorkItem: 'EI-TRIAD-1',
    });
    const res = await tool.handler(
      { name: 'Missing Triad', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.message).toMatch(/0 of 5 open plan items.*spec triad.*Nothing is claimable yet/i);
    expect(payload.message).toContain('requirements, design');
    expect(payload.message).toContain('EI-TRIAD-1');
    expect(payload.promotionFailsafe).toMatchObject({
      ran: true,
      promoted: 0,
      skipped: 5,
      specTriadBlocked: true,
    });
  });

  it('never blocks the launch when promotion throws (best-effort)', async () => {
    promotePlanItemsMock.mockRejectedValue(new Error('promotion boom'));
    const res = await tool.handler(
      { name: 'Resilient Promote', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.promotionFailsafe).toBeNull();
  });
});

// EI-8807: the overrideCapacityClamp ARG must thread through the HANDLER to
// clampFleetTopUpToCapacity({ override }) so an owner-ordered launch is NOT zeroed by a
// stale/wrong gateway health read (the live incident: count:4, healthyAccounts:0 while
// accounts:status showed an available account, dispatchBudget:13 free slots → opened:[] with
// no override arg, forcing a hand-rolled capability:terminal fallback). This pins the
// end-to-end arg-threading the pure-function tests above (clampFleetTopUpToCapacity/override)
// do not cover.
describe('fleet:launch-on-plan handler — overrideCapacityClamp arg threads through (EI-8807)', () => {
  // The exact repro headroom: gateway reachable, ZERO healthy accounts, but a full bee-tier
  // dispatchBudget of free slots (beeTier=3). With account:'auto' the members are gateway-routed,
  // so healthyAccounts:0 zero-gates the top-up — the clamp the owner needed to override.
  const zeroHealthyFullSlots = {
    reachable: true,
    utilization: 0.61,
    utilizationPct: 61,
    paused: false,
    rejected: false,
    inFlight: 0,
    queueDepth: 0,
    priorityTiers: {
      healthyAccounts: 0,
      tier1Reserve: 0,
      tiers: [{ tier: 3, cap: 13, inFlight: 0, queued: 0 }],
    },
  };

  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue(zeroHealthyFullSlots);
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockReset();
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('WITHOUT override: a gateway-routed launch is zeroed by healthyAccounts:0 (the repro — opened:[])', async () => {
    const res = await tool.handler(
      { name: 'Override Fleet', plan: 'my-plan', harness: 'papercusp', count: 4, account: 'auto' } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.opened).toEqual([]);
    expect(payload.capacitySuppressed).toBe(true);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    // The clamp recommended 0 and was NOT overridden.
    expect(payload.capacityClamp).toMatchObject({
      openCount: 0,
      clamped: true,
      overridden: false,
      recommendedOpenCount: 0,
    });
  });

  it('WITH overrideCapacityClamp:true: all 4 members launch despite healthyAccounts:0, and the override is legible', async () => {
    const res = await tool.handler(
      {
        name: 'Override Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 4,
        account: 'auto',
        overrideCapacityClamp: true,
      } as never,
      {} as never,
    );
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    // The owner-ordered launch actually opens — the exact consequence the bug reported (a
    // 4→0 clamp with no override arg) no longer strands it.
    expect(spawnConsoleMock).toHaveBeenCalledTimes(4);
    expect(payload.opened).toHaveLength(4);
    expect(payload.capacitySuppressed).toBeUndefined();
    // The recommendation stays REPORTED — an override is never invisible (audit trail).
    expect(payload.capacityClamp).toMatchObject({
      openCount: 4,
      overridden: true,
      recommendedOpenCount: 0,
      healthyAccounts: 0,
    });
    expect(payload.capacityClamp.reason).toMatch(/OVERRIDDEN/);
  });
});
