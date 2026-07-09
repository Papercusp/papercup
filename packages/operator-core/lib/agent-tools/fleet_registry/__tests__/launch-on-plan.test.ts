/**
 * Unit tests for fleet:launch-on-plan (EI-5504). The handler spawns desktop
 * terminals (no pure unit surface), so we cover the pure command builder — the
 * load-bearing bit: every member command must carry `--no-picker` + `--plan`, the
 * exact pair that triggers the EI-5503 auto-kickoff so the member starts on boot.
 * Importing the module also validates its whole import chain compiles + loads (the
 * tool self-registers via defineTool on import).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
}));

vi.mock('../../../fleet/fleet-roster', () => ({
  // Live-member deficit guard seam: default to an empty fleet (every legacy handler test
  // launches into a fresh fleet); the deficit tests below override per-case.
  liveFleetMemberIds: vi.fn(async () => [] as string[]),
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

const setClaimSpecMock = vi.fn();
vi.mock('../../../scheduler/claim-spec-store', () => ({
  setClaimSpec: (...args: unknown[]) => setClaimSpecMock(...args),
  fleetSpecBeeKey: (slug: string) => `fleet:${slug}`,
  resolveClaimSpecWorkspace: (ws: string | null | undefined) => (ws && ws !== '*' ? ws : undefined),
}));

// #3 promotion FAILSAFE seam (fleet-launch-promote-workitems-failsafe): the handler idempotently
// promotes the plan's items → claimable work-items before opening any terminal. Default: the healthy
// case (items already promoted upstream by plans:start → skipped>0, promoted:0 → no warning line).
// Individual tests override with mockResolvedValueOnce.
const promotePlanItemsMock = vi.fn(async () => ({ promoted: 0, skipped: 3 }));
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
  MEMBER_BASELINE_RULES,
  LEADER_STANDING_JOB,
  LEADER_AUTO_MODE_DIRECTIVE,
} from '../launch-on-plan';
// The REAL claim-spec validator (NOT the mocked claim-spec-STORE) — #4 specs must pass it.
import { validateClaimSpec } from '../../../scheduler/claim-spec';

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

  it('emits --allow-subagents as a bare flag when opted in (owner mandate 2026-07-02); omitted by default (deny)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', allowSubagents: true,
    });
    expect(cmd).toContain(' --allow-subagents');
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p' }),
    ).not.toContain('--allow-subagents');
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
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p' }),
    ).not.toContain('--seat');
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

  // cross-platform-member-credential-inheritance (Mac fleet-member login fix, 2026-07-06):
  // a member the leader didn't pin defaults to gateway-auto on macOS (so it inherits the
  // Keychain login via the gateway) instead of the direct system-credential that boots a
  // headless Mac member logged out. Byte-identical on Linux/Windows; explicit pins always win.
  describe('defaultMemberAccountRouting — Mac members default to gateway-auto', () => {
    it('defaults an un-pinned member to "auto" on macOS (routes via the always-on gateway)', () => {
      expect(defaultMemberAccountRouting(undefined, 'darwin')).toBe('auto');
      expect(defaultMemberAccountRouting('', 'darwin')).toBe('auto');
    });

    it('keeps the direct system-credential default (undefined) on Linux/Windows', () => {
      expect(defaultMemberAccountRouting(undefined, 'linux')).toBeUndefined();
      expect(defaultMemberAccountRouting(undefined, 'win32')).toBeUndefined();
    });

    it('never overrides an explicit account pin — incl. the "default" escape hatch — on any platform', () => {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        expect(defaultMemberAccountRouting('aviynw6', platform)).toBe('aviynw6');
        expect(defaultMemberAccountRouting('auto', platform)).toBe('auto');
        // A Mac operator that explicitly wants direct egress passes 'default' — it must survive.
        expect(defaultMemberAccountRouting('default', platform)).toBe('default');
      }
    });

    it('the resolved routing flows into --account: a Mac member launch carries --account=auto', () => {
      const account = defaultMemberAccountRouting(undefined, 'darwin');
      const cmd = memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'p', account });
      expect(cmd).toContain('--account=auto');
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
    expect(md).toContain('A hive pause is a Queen-loop signal, not a self-drain order');
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
describe('LEADER_STANDING_JOB — steer-don\'t-dispatch + completion mandate (P-002)', () => {
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
  it('declares AUTO mode ON now, for the rest of the session — act-don\'t-ask', () => {
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/AUTO MODE/);
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/effective NOW/i);
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/rest of your session/i);
    // The concrete behavioural bind: never park waiting while the fleet is live.
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/NEVER end a turn waiting/i);
    // Disclosure, not a permission ask.
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/notice, not a question/i);
  });

  it('leads INTO the standing-job list (it renders as that list\'s header line)', () => {
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
    expect(payload.message).toMatch(/per-WAVE, never per-turn/);
    // On a writable tmp the compose lands and its path threads into psu's --launch-context.
    if (payload.memberBaselineApplied) {
      expect(payload.memberLaunchContextPath).toContain('fleet-alpha-fleet-launch-context.md');
      const firstGreeting = spawnConsoleMock.mock.calls[0][0].envelope.greetingCmd as string;
      expect(firstGreeting).toContain('--launch-context=');
      expect(firstGreeting).toContain('fleet-alpha-fleet-launch-context.md');
    }
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
    const ownerId = (resolveFleetCaller as ReturnType<typeof vi.fn>)({}).ownerId as string;
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
    expect(payload.message).toMatch(/Fleet `refire-fleet` was already launched — 3 members opened \d+s ago \(possibly by this very session\)\./);
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
  });

  it('combines plan + kind filters when claimKinds is passed, BEFORE any member terminal opens', async () => {
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
      beeId: string;
      spec: { view: { filter: unknown } };
    };
    expect(call.beeId).toBe('fleet:drain-fleet');
    // Plan-scoped AND kind-filtered: an `all` node combining the plan leaf with the kind leaf.
    expect(call.spec.view.filter).toEqual({
      all: [
        { field: 'plan', op: '=', value: 'my-plan' },
        { field: 'kind', op: 'in', value: ['bug', 'change'] },
      ],
    });
    expect(payload.claimSpecApplied).toEqual({ ok: true, revision: 1 });
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
    expect(payload.claimSpecApplied).toEqual({ ok: true, revision: 1 });
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
