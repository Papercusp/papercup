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

import tool, {
  memberLaunchCommand,
  composeMemberLaunchContext,
  renderMemberBaseline,
  MEMBER_BASELINE_RULES,
  LEADER_STANDING_JOB,
  LEADER_AUTO_MODE_DIRECTIVE,
} from '../launch-on-plan';

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
